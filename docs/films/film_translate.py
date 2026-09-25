#!/usr/bin/env python3
"""Traduction rapide d'un coloriage PicoPop : duplique le projet À L'IDENTIQUE (mesh, animations,
décors, timeline) et remplace UNIQUEMENT les sons parlés du FILM par des fichiers audio locaux.

Bibliothèque standard uniquement. Auth = jeton OAuth gcloud d'un compte propriétaire du projet
GCP `picopop-app` (l'API REST avec IAM ignore les règles de sécurité Firebase). ffprobe requis.

Usage :
  python3 film_translate.py list <projectId>
      Affiche les clips parlés du film (ordre chronologique), leur son et les durées → dit quels
      fichiers fournir et dans quel ordre.

  python3 film_translate.py create-book "<nom du livre>" [--cover-from=<bookId>]
      Crée un livre (dépublié, non listé = false) et affiche son id. Copie la couverture du livre
      source si demandé.

  python3 film_translate.py translate <projectId> <audio1> <audio2> ... --name="<nom>" --book=<bookId>
                            [--dry-run] [--account=compte@gmail.com]
      1. copie du doc Firestore sous un nouvel id (ids d'animations/sons conservés, published=false)
      2. copie SERVEUR de tous les fichiers Storage projects/{src}/… → projects/{new}/… (rewrite GCS)
      3. remplace film/sounds/{soundId} de chaque clip PARLÉ par le fichier audio donné, dans
         l'ordre chronologique des clips (autant de fichiers que de clips parlés, voir `list`)
      4. patch filmT : nom du son = nom du fichier, durationMs du clip = durée réelle du fichier,
         offsetMs remis à 0. Avertit si un clip déborde de son plan (le moteur laisse le son
         continuer sur le plan suivant : à ajuster dans l'éditeur FILM si gênant).

  Un même son de bibliothèque partagé par plusieurs clips parlés reçoit UN fichier (donné pour son
  premier clip) ; les clips suivants sont mis à jour à la même durée.

⚠ Le duplicata n'est pas publié. Aucun journal d'audit n'est écrit (écriture REST hors admin).
"""
import json, mimetypes, os, subprocess, sys, time, urllib.parse, urllib.request, urllib.error, uuid

PROJECT_GCP = 'picopop-app'
DB = 'coloriages'
BUCKET = 'picopop-app.firebasestorage.app'
CACHE = 'public, max-age=31536000, immutable'
BASE = f'https://firestore.googleapis.com/v1/projects/{PROJECT_GCP}/databases/{DB}/documents'
STO = f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o'

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = dict(a[2:].split('=', 1) if '=' in a else (a[2:], True) for a in sys.argv[1:] if a.startswith('--'))
if not args:
    print(__doc__); sys.exit(1)
CMD = args[0]
DRY = bool(flags.get('dry-run'))
ACCOUNT = flags.get('account', 'nicolas.rocher38@gmail.com')


def token():
    out = subprocess.run(['gcloud', 'auth', 'print-access-token', f'--account={ACCOUNT}'], capture_output=True, text=True)
    if out.returncode != 0 or not out.stdout.strip():
        sys.exit('jeton gcloud introuvable : ' + out.stderr.strip())
    return out.stdout.strip()


TOKEN = token()


def http(method, url, body=None, headers=None, timeout=300):
    h = {'Authorization': 'Bearer ' + TOKEN}
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jbody(d):
    return json.dumps(d).encode(), {'Content-Type': 'application/json'}


# ---------------------------------------------------------------- Firestore (valeurs typées)
def to_value(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [to_value(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: to_value(x) for k, x in v.items()}}}
    raise TypeError(f'type non supporté : {type(v)}')


def from_value(v):
    for k in ('stringValue', 'booleanValue', 'doubleValue', 'nullValue'):
        if k in v: return v[k]
    if 'integerValue' in v: return int(v['integerValue'])
    if 'mapValue' in v: return {k: from_value(x) for k, x in (v['mapValue'].get('fields') or {}).items()}
    if 'arrayValue' in v: return [from_value(x) for x in (v['arrayValue'].get('values') or [])]
    return v


def get_doc(path, *fields):
    q = ('?' + '&'.join(f'mask.fieldPaths={f}' for f in fields)) if fields else ''
    s, raw = http('GET', f'{BASE}/{path}{q}')
    if s == 404: return None
    if s != 200: sys.exit(f'lecture {path} HTTP {s} {raw[:200]!r}')
    return json.loads(raw)


def patch_fields(path, typed_fields, create=False):
    """PATCH avec updateMask sur les champs donnés (valeurs DÉJÀ typées Firestore)."""
    q = '&'.join('updateMask.fieldPaths=' + urllib.parse.quote(k) for k in typed_fields)
    if create: q += '&currentDocument.exists=false'
    body, h = jbody({'fields': typed_fields})
    s, raw = http('PATCH', f'{BASE}/{path}?{q}', body, h)
    if s != 200: sys.exit(f'écriture {path} HTTP {s} {raw[:400]!r}')
    return json.loads(raw).get('updateTime')


# ---------------------------------------------------------------- Storage
def list_objects(prefix):
    items, page = [], None
    while True:
        q = f'?prefix={urllib.parse.quote(prefix, safe="")}&fields=items(name,size,contentType),nextPageToken'
        if page: q += '&pageToken=' + page
        s, raw = http('GET', STO + q)
        if s != 200: sys.exit(f'listage Storage HTTP {s} {raw[:200]!r}')
        d = json.loads(raw)
        items += d.get('items', [])
        page = d.get('nextPageToken')
        if not page: return items


def rewrite(src, dst):
    """Copie serveur (métadonnées conservées). Boucle sur rewriteToken pour les gros objets."""
    url = f'{STO}/{urllib.parse.quote(src, safe="")}/rewriteTo/b/{BUCKET}/o/{urllib.parse.quote(dst, safe="")}'
    tok = None
    while True:
        body, h = jbody({})
        s, raw = http('POST', url + (f'?rewriteToken={tok}' if tok else ''), body, h, timeout=600)
        if s != 200: sys.exit(f'copie {src} → {dst} HTTP {s} {raw[:300]!r}')
        d = json.loads(raw)
        if d.get('done'): return int(d['resource'].get('size', 0))
        tok = d['rewriteToken']


def upload(path, local, content_type=None):
    ctype = content_type or mimetypes.guess_type(local)[0] or 'application/octet-stream'
    meta = json.dumps({'name': path, 'contentType': ctype, 'cacheControl': CACHE}).encode()
    data = open(local, 'rb').read()
    boundary = 'picopop' + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode() + meta
            + f'\r\n--{boundary}\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
    url = f'https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=multipart'
    for attempt in range(3):
        s, raw = http('POST', url, body, {'Content-Type': f'multipart/related; boundary={boundary}'}, timeout=600)
        if s == 200:
            d = json.loads(raw); return d.get('generation'), int(d.get('size', 0))
        time.sleep(3 * (attempt + 1))
    sys.exit(f'upload {path} HTTP {s} {raw[:300]!r}')


def audio_ms(local):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', local],
                         capture_output=True, text=True)
    try: return int(round(float(out.stdout.strip()) * 1000))
    except ValueError: sys.exit(f'durée illisible (ffprobe) : {local}')


# ---------------------------------------------------------------- film : clips parlés
def spoken_clips(film):
    """Clips parlés en ordre chronologique absolu : [(absStartMs, planIdx, trackIdx, clip, plan)]."""
    names = {s['id']: s['name'] for s in film.get('sounds', [])}
    out, t0 = [], 0
    for pi, plan in enumerate(film['plans']):
        for ti, tr in enumerate(plan.get('soundTracks', [])):
            for c in tr.get('clips', []):
                if c.get('isSpoken') is True:
                    out.append((t0 + c['startMs'], pi, ti, c, plan))
        t0 += plan['durationMs']
    for ti, tr in enumerate(film.get('globalSoundTracks', []) or []):
        for c in tr.get('clips', []):
            if c.get('isSpoken') is True:
                out.append((c['startMs'], -1, ti, c, None))
    out.sort(key=lambda x: x[0])
    return out, names


def print_spoken(film):
    clips, names = spoken_clips(film)
    print(f"{len(film['plans'])} plan(s), {len(film.get('sounds', []))} son(s) en bibliothèque, {len(clips)} clip(s) parlé(s) :")
    for n, (abs_ms, pi, ti, c, plan) in enumerate(clips, 1):
        where = f"plan {pi} « {plan.get('name', '')} » piste {ti} à {c['startMs']} ms" if plan else f'piste GLOBALE {ti}'
        end = c['startMs'] + c['durationMs']
        over = f"  ⚠ déborde du plan de {end - plan['durationMs']} ms" if plan and end > plan['durationMs'] else ''
        print(f"  {n}. t={abs_ms / 1000:6.2f} s  {where}  son {c['soundId'][:8]} « {names.get(c['soundId'], '?')} »  clip {c['durationMs']} ms{over}")
    return clips, names


# ---------------------------------------------------------------- commandes
if CMD == 'list':
    pid = args[1]
    d = get_doc(f'projects/{pid}', 'name', 'filmT', 'bookId', 'published') or sys.exit('projet introuvable')
    f = {k: from_value(v) for k, v in d.get('fields', {}).items()}
    print(f"projet « {f.get('name')} » — livre {f.get('bookId')} — publié : {f.get('published')}")
    if not f.get('filmT'): sys.exit('pas de filmT (film v4) sur ce projet')
    print_spoken(f['filmT'])
    sys.exit(0)

if CMD == 'create-book':
    name = args[1]
    bid = str(uuid.uuid4())
    cover_from = flags.get('cover-from')
    has_cover = False
    if cover_from:
        src_cover = list_objects(f'books/{cover_from}/cover')
        has_cover = any(o['name'] == f'books/{cover_from}/cover' for o in src_cover)
    doc = {'id': bid, 'name': name, 'createdAt': int(time.time() * 1000), 'hasCover': has_cover,
           'published': False, 'publishedAt': None, 'unlisted': False,
           'amazonUrl': 'amazon.com', 'bonusUrl': 'amazon.com', 'hasBonusImage': False}
    print(f"livre « {name} » → books/{bid}" + (f" (couverture copiée de {cover_from})" if has_cover else ''))
    if DRY: print('simulation : rien écrit'); sys.exit(0)
    if has_cover: rewrite(f'books/{cover_from}/cover', f'books/{bid}/cover')
    patch_fields(f'books/{bid}', {k: to_value(v) for k, v in doc.items()}, create=True)
    print('créé. id :', bid)
    sys.exit(0)

if CMD == 'translate':
    if len(args) < 3: sys.exit('usage : translate <projectId> <audio…> --name= --book=')
    src_id, audios = args[1], args[2:]
    new_name, book_id = flags.get('name'), flags.get('book')
    if not new_name or not book_id: sys.exit('--name= et --book= obligatoires')
    for a in audios:
        if not os.path.exists(a): sys.exit(f'fichier manquant : {a}')
    if not DRY and not get_doc(f'books/{book_id}'): sys.exit(f'livre introuvable : {book_id}')

    # 1. doc source complet (valeurs typées conservées telles quelles)
    d = get_doc(f'projects/{src_id}') or sys.exit('projet source introuvable')
    fields = d['fields']
    src = {k: from_value(v) for k, v in fields.items() if k in ('name', 'filmT', 'published', 'bookId')}
    print(f"source « {src.get('name')} » ({src_id}) — publié : {src.get('published')} — livre {src.get('bookId')}")
    film = src.get('filmT') or sys.exit('pas de filmT sur la source')
    clips, names = print_spoken(film)

    # appariement fichiers ↔ clips parlés (un fichier par SON distinct, ordre chronologique)
    order, seen = [], set()
    for _, _, _, c, _ in clips:
        if c['soundId'] not in seen:
            seen.add(c['soundId']); order.append(c['soundId'])
    if len(audios) != len(order):
        sys.exit(f'{len(order)} son(s) parlé(s) distinct(s) attendu(s), {len(audios)} fichier(s) donné(s)')
    replace = {}  # soundId → (fichier, durée ms)
    print('\nappariement :')
    for sid, a in zip(order, audios):
        ms = audio_ms(a)
        replace[sid] = (a, ms)
        print(f"  « {names[sid]} » ({sid[:8]}) ← {os.path.basename(a)}  {ms} ms")

    # 2. nouveau filmT : noms de sons + durées de clips
    new_film = json.loads(json.dumps(film))
    for s in new_film['sounds']:
        if s['id'] in replace: s['name'] = os.path.basename(replace[s['id']][0])
    print('\nclips mis à jour :')
    t0 = 0
    all_tracks = [(pi, plan, plan.get('soundTracks', [])) for pi, plan in enumerate(new_film['plans'])]
    for pi, plan, tracks in all_tracks:
        for tr in tracks:
            for c in tr.get('clips', []):
                if c.get('isSpoken') is True and c['soundId'] in replace:
                    old, new = c['durationMs'], replace[c['soundId']][1]
                    c['durationMs'] = new
                    c.pop('offsetMs', None)
                    end = c['startMs'] + new
                    over = f"  ⚠ déborde du plan « {plan.get('name', '')} » de {end - plan['durationMs']} ms (le son continue sur le plan suivant)" if end > plan['durationMs'] else ''
                    print(f"  plan {pi} clip {c['id'][:8]} : {old} → {new} ms{over}")
    for tr in new_film.get('globalSoundTracks', []) or []:
        for c in tr.get('clips', []):
            if c.get('isSpoken') is True and c['soundId'] in replace:
                old, new = c['durationMs'], replace[c['soundId']][1]
                c['durationMs'] = new; c.pop('offsetMs', None)
                print(f"  GLOBAL clip {c['id'][:8]} : {old} → {new} ms")

    # 3. fichiers Storage à copier
    objs = list_objects(f'projects/{src_id}/')
    total = sum(int(o['size']) for o in objs)
    new_id = str(uuid.uuid4())
    print(f"\n{len(objs)} fichier(s) Storage ({total // 1048576} Mo) à copier vers projects/{new_id}/")
    if DRY:
        print('simulation : rien écrit'); sys.exit(0)

    # 4. doc Firestore du duplicata (typé, verbatim sauf champs projet)
    now = int(time.time() * 1000)
    new_fields = dict(fields)
    new_fields.pop('filmNeedsFullUpload', None)
    new_fields.pop('film', None)  # film v3 legacy : le duplicata ne porte que filmT
    new_fields.update({
        'id': to_value(new_id), 'name': to_value(new_name), 'createdAt': to_value(now),
        'published': to_value(False), 'publishedAt': to_value(None),
        'bookId': to_value(book_id), 'bookOrder': to_value(now),
        'filmT': to_value(new_film),
    })
    body, h = jbody({'fields': new_fields})
    s, raw = http('PATCH', f'{BASE}/projects/{new_id}?currentDocument.exists=false', body, h)
    if s != 200: sys.exit(f'création doc HTTP {s} {raw[:400]!r}')
    print(f"doc projects/{new_id} créé (« {new_name} », livre {book_id}, dépublié)")

    # 5. copie Storage
    for i, o in enumerate(objs, 1):
        dst = f'projects/{new_id}/' + o['name'][len(f'projects/{src_id}/'):]
        size = rewrite(o['name'], dst)
        print(f"  [{i}/{len(objs)}] {o['name'].split('/', 2)[-1]}  {size // 1024} Ko")

    # 6. remplacement des sons parlés
    print('sons parlés :')
    for sid, (local, ms) in replace.items():
        path = f'projects/{new_id}/film/sounds/{sid}'
        gen, size = upload(path, local)
        print(f"  {os.path.basename(local)} → {path}  {size // 1024} Ko")

    # 7. relecture
    chk = get_doc(f'projects/{new_id}', 'name', 'filmT', 'bookId', 'published')
    f = {k: from_value(v) for k, v in chk['fields'].items()}
    copied = list_objects(f'projects/{new_id}/')
    print(f"\nrelecture : « {f['name']} » livre {f['bookId']} publié {f['published']} — {len(copied)}/{len(objs)} fichiers Storage")
    print_spoken(f['filmT'])
    print('\nnouveau projet :', new_id)
    sys.exit(0)

print(__doc__); sys.exit(1)
