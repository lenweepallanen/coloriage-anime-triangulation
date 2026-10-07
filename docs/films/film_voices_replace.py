#!/usr/bin/env python3
"""Remplace EN PLACE les voix (sons « parlés ») du film d'un coloriage existant par des fichiers audio locaux.

Appariement = celui de l'export « Voix » du dossier Drive (docs/book/build_drive_folder.py) : clips parlés en ordre
chronologique, bruitages (nom contenant « sfx ») exclus, volume 0 et clips hors plan ignorés, UN fichier par son
distinct (dédoublonnage par contenu md5 comme l'export). Les anciens fichiers sont sauvegardés dans
projects/{id}/film/sounds-backup-<horodatage>/ et l'ancien filmT dans ./_voices_backup/<id>.json.

  python3 film_voices_replace.py list <projectId>
  python3 film_voices_replace.py replace <projectId> <dossier ou fichiers mp3…> [--dry-run]
      Dossier : les fichiers .mp3 triés par nom (« 01 - plan 1.mp3 », …).

Même auth que film_translate.py (jeton gcloud du propriétaire du projet GCP). ffprobe requis.
"""
import json, mimetypes, os, subprocess, sys, time, urllib.parse, urllib.request, urllib.error, uuid, base64

PROJECT_GCP, DB, BUCKET = 'picopop-app', 'coloriages', 'picopop-app.firebasestorage.app'
CACHE = 'public, max-age=31536000, immutable'
BASE = f'https://firestore.googleapis.com/v1/projects/{PROJECT_GCP}/databases/{DB}/documents'
STO = f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o'
HERE = os.path.dirname(os.path.abspath(__file__))

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = dict(a[2:].split('=', 1) if '=' in a else (a[2:], True) for a in sys.argv[1:] if a.startswith('--'))
if not args: print(__doc__); sys.exit(1)
DRY = bool(flags.get('dry-run'))
ACCOUNT = flags.get('account', 'nicolas.rocher38@gmail.com')
TOKEN = subprocess.run(['gcloud', 'auth', 'print-access-token', f'--account={ACCOUNT}'], capture_output=True, text=True).stdout.strip() or sys.exit('jeton gcloud introuvable')


def http(method, url, body=None, headers=None, timeout=300):
    h = {'Authorization': 'Bearer ' + TOKEN}; h.update(headers or {})
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


def to_value(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [to_value(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: to_value(x) for k, x in v.items()}}}
    raise TypeError(type(v))


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


def patch_fields(path, typed_fields):
    q = '&'.join('updateMask.fieldPaths=' + urllib.parse.quote(k) for k in typed_fields)
    body = json.dumps({'fields': typed_fields}).encode()
    s, raw = http('PATCH', f'{BASE}/{path}?{q}', body, {'Content-Type': 'application/json'})
    if s != 200: sys.exit(f'écriture {path} HTTP {s} {raw[:400]!r}')


def list_objects(prefix):
    items, page = [], None
    while True:
        q = f'?prefix={urllib.parse.quote(prefix, safe="")}&fields=items(name,size,contentType,md5Hash),nextPageToken' + (f'&pageToken={page}' if page else '')
        s, raw = http('GET', STO + q)
        if s != 200: sys.exit(f'listage Storage HTTP {s} {raw[:200]!r}')
        d = json.loads(raw); items += d.get('items', []); page = d.get('nextPageToken')
        if not page: return items


def rewrite(src, dst):
    url = f'{STO}/{urllib.parse.quote(src, safe="")}/rewriteTo/b/{BUCKET}/o/{urllib.parse.quote(dst, safe="")}'
    tok = None
    while True:
        s, raw = http('POST', url + (f'?rewriteToken={tok}' if tok else ''), b'{}', {'Content-Type': 'application/json'}, timeout=600)
        if s != 200: sys.exit(f'copie {src} → {dst} HTTP {s} {raw[:300]!r}')
        d = json.loads(raw)
        if d.get('done'): return int(d['resource'].get('size', 0))
        tok = d['rewriteToken']


def upload(path, local):
    ctype = mimetypes.guess_type(local)[0] or 'audio/mpeg'
    meta = json.dumps({'name': path, 'contentType': ctype, 'cacheControl': CACHE}).encode(); data = open(local, 'rb').read()
    b = 'picopop' + uuid.uuid4().hex
    body = (f'--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode() + meta + f'\r\n--{b}\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + f'\r\n--{b}--\r\n'.encode())
    for attempt in range(3):
        s, raw = http('POST', f'https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=multipart', body, {'Content-Type': f'multipart/related; boundary={b}'}, timeout=600)
        if s == 200: return int(json.loads(raw).get('size', 0))
        time.sleep(3 * (attempt + 1))
    sys.exit(f'upload {path} HTTP {s} {raw[:300]!r}')


def audio_ms(local):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', local], capture_output=True, text=True)
    return int(round(float(out.stdout.strip()) * 1000))


# ---------------------------------------------------------------- voix entendues (même règle que l'export Drive)
def heard_voices(pid, film):
    """[(ordre, soundId, nom, [clips])] : sons parlés distincts (md5) dans l'ordre de première écoute."""
    lib = {s['id']: s['name'] for s in film.get('sounds', [])}
    md5 = {o['name'].rsplit('/', 1)[-1]: o['md5Hash'] for o in list_objects(f'projects/{pid}/film/sounds/')}
    clips, t0 = [], 0
    for pi, plan in enumerate(film['plans']):
        for tr in plan.get('soundTracks') or []:
            for c in tr.get('clips', []):
                if c.get('isSpoken') and 'sfx' not in lib.get(c['soundId'], '').lower() and c.get('volume', 1) > 0 and c['startMs'] < plan['durationMs']:
                    clips.append((t0 + c['startMs'], pi, c))
        t0 += plan['durationMs']
    for tr in film.get('globalSoundTracks') or []:
        for c in tr.get('clips', []):
            if c.get('isSpoken') and 'sfx' not in lib.get(c['soundId'], '').lower() and c.get('volume', 1) > 0:
                clips.append((c['startMs'], -1, c))
    clips.sort(key=lambda x: x[0])
    voices, seen_md5, by_sid = [], {}, {}
    for abs_ms, pi, c in clips:
        sid = c['soundId']; h = md5.get(sid, sid)
        if h in seen_md5:
            voices[seen_md5[h]]['clips'].append((pi, c)); voices[seen_md5[h]]['sids'].add(sid); continue
        seen_md5[h] = len(voices)
        voices.append({'sid': sid, 'sids': {sid}, 'name': lib.get(sid, '?'), 'plan': pi, 't': abs_ms, 'clips': [(pi, c)]})
    return voices


def show(voices):
    for n, v in enumerate(voices, 1):
        plans = sorted({pi for pi, _ in v['clips']})
        print(f"  {n:02d} - plan {v['plan'] + 1}  t={v['t'] / 1000:6.2f} s  « {v['name']} »  {len(v['clips'])} clip(s) plan(s) {[p + 1 for p in plans]}  durée clip {v['clips'][0][1]['durationMs']} ms")


pid = args[1]
doc = get_doc(f'projects/{pid}', 'name', 'filmT', 'bookId', 'published') or sys.exit('projet introuvable')
f = {k: from_value(v) for k, v in doc['fields'].items()}
film = f.get('filmT') or sys.exit('pas de filmT')
print(f"projet « {f['name']} » ({pid}) — livre {f.get('bookId')} — publié {f.get('published')}")
voices = heard_voices(pid, film)
print(f'{len(voices)} voix entendue(s) :'); show(voices)
if args[0] == 'list': sys.exit(0)

# fichiers
files = []
for a in args[2:]:
    if os.path.isdir(a): files += sorted(os.path.join(a, x) for x in os.listdir(a) if x.lower().endswith('.mp3'))
    else: files.append(a)
if len(files) != len(voices): sys.exit(f'{len(voices)} voix attendues, {len(files)} fichier(s) : {[os.path.basename(x) for x in files]}')
print('\nappariement :')
replace = {}
for v, a in zip(voices, files):
    ms = audio_ms(a); replace[v['sid']] = (a, ms)
    bn = os.path.basename(a); tag = bn.split(' - ')[1].split('.')[0] if ' - ' in bn else ''
    warn = '' if not tag or tag == f"plan {v['plan'] + 1}" else f"  ⚠ le fichier dit « {tag} », le son est entendu plan {v['plan'] + 1}"
    print(f"  « {v['name']} » ← {bn}  {ms} ms{warn}")
    for sid in v['sids']: replace[sid] = (a, ms)

# nouveau filmT
new_film = json.loads(json.dumps(film))
for s in new_film['sounds']:
    if s['id'] in replace: s['name'] = os.path.basename(replace[s['id']][0])
print('\nclips mis à jour :')
for pi, plan in enumerate(new_film['plans']):
    for tr in plan.get('soundTracks') or []:
        for c in tr.get('clips', []):
            if c.get('isSpoken') and c['soundId'] in replace:
                old, new = c['durationMs'], replace[c['soundId']][1]; c['durationMs'] = new; c.pop('offsetMs', None)
                end = c['startMs'] + new
                over = f"  ⚠ déborde du plan « {plan.get('name', '')} » de {end - plan['durationMs']} ms" if end > plan['durationMs'] else ''
                print(f"  plan {pi + 1} clip {c['id'][:8]} : {old} → {new} ms{over}")
for tr in new_film.get('globalSoundTracks') or []:
    for c in tr.get('clips', []):
        if c.get('isSpoken') and c['soundId'] in replace:
            old, new = c['durationMs'], replace[c['soundId']][1]; c['durationMs'] = new; c.pop('offsetMs', None)
            print(f"  GLOBAL clip {c['id'][:8]} : {old} → {new} ms")
if DRY: print('\nsimulation : rien écrit'); sys.exit(0)

# sauvegardes puis écriture
stamp = time.strftime('%Y%m%d-%H%M%S')
os.makedirs(f'{HERE}/_voices_backup', exist_ok=True)
json.dump(film, open(f'{HERE}/_voices_backup/{pid}.{stamp}.json', 'w'))
for sid in sorted({v['sid'] for v in voices} | {s for v in voices for s in v['sids']}):
    rewrite(f'projects/{pid}/film/sounds/{sid}', f'projects/{pid}/film/sounds-backup-{stamp}/{sid}')
print(f'\nanciens sons copiés dans film/sounds-backup-{stamp}/, ancien filmT dans _voices_backup/')
done = set()
for sid, (local, ms) in replace.items():
    if local in done: pass
    size = upload(f'projects/{pid}/film/sounds/{sid}', local); done.add(local)
    print(f'  {os.path.basename(local)} → film/sounds/{sid[:8]}  {size // 1024} Ko')
patch_fields(f'projects/{pid}', {'filmT': to_value(new_film)})
print('filmT mis à jour. relecture :')
chk = {k: from_value(v) for k, v in get_doc(f'projects/{pid}', 'filmT')['fields'].items()}
show(heard_voices(pid, chk['filmT']))
