#!/usr/bin/env python3
"""Images de départ du film Brachiosaure (plan de Nicolas du 25/09/2026, 5 plans) — OpenAI images/edits.

Même méthode que docs/films/triceratops/gen_start_images.py : UNE image de référence (dessin d'enfant, crayon
de couleur), prompt « Dans le même style (dessin d'enfant, crayon de couleur) dessine moi … ». Le héros
(brachiosaure qui parle) N'EST PAS dessiné : il est composité par l'app. Les autres animaux (famille,
tricératops qui dort, ptérodactyle) sont dans l'image, la vidéo les animera.

Usage : python3 gen_start_images.py <reference.png> <dossier_sortie> [plans=P1,P3]
Clé : OPENAI_API_KEY dans ~/.picopop-keys.env.
"""
import base64, json, os, sys, uuid, urllib.request, urllib.error, concurrent.futures as cf

REF, OUT = sys.argv[1], sys.argv[2]
opts = dict(a.split('=', 1) for a in sys.argv[3:] if '=' in a)
ONLY = set(opts['plans'].split(',')) if 'plans' in opts else None
MODEL = opts.get('model', 'gpt-image-2.5-sunburst')

keys = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.picopop-keys.env')) if '=' in l and not l.startswith('#'))

PREFIX = "Dans le même style (dessin d'enfant, crayon de couleur) dessine moi "
COMMON = (" Vue de côté, format paysage 16:9, pas de texte. Ne dessine AUCUN brachiosaure au premier plan : "
          "le héros sera ajouté par-dessus plus tard, laisse-lui la place indiquée.")

PLANS = {
    'P1_prairie_famille': (
        "une prairie préhistorique paisible et ensoleillée : herbe verte, fougères et fleurs, quelques grands "
        "arbres aux feuilles rondes sur les bords, des collines douces et un ciel bleu avec des nuages. Au LOIN, "
        "petits et dans le fond, deux brachiosaures (long cou, petite tête) qui mangent des feuilles en haut des "
        "arbres à gauche, et un stégosaure et un petit dinosaure herbivore qui broutent à droite. Le sol occupe le "
        "quart inférieur. Tout le centre de l'image reste vide, du sol jusqu'au ciel."),
    'P2_cimes_des_arbres': (
        "seulement la CIME des arbres et le ciel, vu de côté : la moitié inférieure de l'image est remplie de "
        "feuillages verts et ronds (le haut de grands arbres, feuilles bien dessinées, quelques branches), la moitié "
        "supérieure est un grand ciel bleu avec un soleil, des nuages et deux petits oiseaux. Aucun sol visible, "
        "aucun tronc jusqu'en bas. Le centre de l'image reste dégagé (feuillage plus bas au centre) : la tête d'un "
        "dinosaure à long cou viendra dépasser des arbres à cet endroit."),
    'P3_foret_maison': (
        "une clairière mignonne dans la forêt : herbe et fleurs au sol dans le quart inférieur, arbres et buissons "
        "tout autour. À GAUCHE, un tricératops (trois cornes, collerette) couché en boule qui dort paisiblement, "
        "les yeux fermés, avec trois petits « z » au-dessus de lui. Au MILIEU, une petite maison de deux étages "
        "(deux rangées de fenêtres, un toit rouge, une porte, une cheminée) posée sur l'herbe, pas plus haute que "
        "le tiers de l'image. Toute la partie DROITE reste vide, du sol jusqu'au ciel, pour un très grand "
        "dinosaure qui se tiendra à côté de la maison."),
    'P4_petits_arbres_pterodactyle': (
        "un paysage préhistorique avec des arbres DIFFÉRENTS et plus PETITS : palmiers trapus, cycas et fougères "
        "arborescentes qui ne montent qu'au tiers de la hauteur de l'image, des rochers, de l'herbe dans le quart "
        "inférieur. Un immense ciel bleu au-dessus avec un soleil, des nuages et, en haut à droite, un "
        "ptérodactyle (grandes ailes, crête, long bec) qui vole. Le centre de l'image reste vide du sol jusqu'en "
        "haut : un dinosaure géant dépassera largement les arbres."),
    'P5_prairie_coucher_soleil': (
        "la même prairie préhistorique paisible qu'au début mais au COUCHER DU SOLEIL : ciel orange, rose et "
        "violet, soleil bas sur les collines, longues ombres douces. Herbe, fougères et fleurs au sol dans le quart "
        "inférieur, de grands arbres aux feuilles rondes et des buissons feuillus à gauche et à droite du cadre. Une "
        "famille de brachiosaures (deux adultes et un petit, long cou, petite tête) à GAUCHE qui mangent "
        "tranquillement les feuilles des arbres. Le centre et la droite de l'image restent vides pour le héros."),
}


def http(url, headers, body, timeout=900):
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


def multipart(fields, files):
    boundary = '----PicoPop' + uuid.uuid4().hex
    out = bytearray()
    for k, v in fields.items():
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fname, data, ctype) in files:
        out += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fname}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
        out += data + b'\r\n'
    out += f'--{boundary}--\r\n'.encode()
    return bytes(out), 'multipart/form-data; boundary=' + boundary


EXTRA_REFS = {'P5_prairie_coucher_soleil': [os.path.join(OUT, 'P1_prairie_famille.png')]}  # même prairie que P1


def gen(name, scene):
    refs = [REF] + [r for r in EXTRA_REFS.get(name, []) if os.path.exists(r)]
    files = [('image[]', (os.path.basename(r), open(r, 'rb').read(), 'image/png')) for r in refs]
    prompt = PREFIX + scene + COMMON
    if len(refs) > 1: prompt += " La deuxième image est le même lieu vu plus tôt dans la journée : garde les mêmes arbres et les mêmes collines."
    fields = {'model': MODEL, 'prompt': prompt, 'size': '1792x1008', 'quality': 'high', 'output_format': 'png', 'n': '1'}
    body, ctype = multipart(fields, files)
    status, raw = http('https://api.openai.com/v1/images/edits', {'Authorization': 'Bearer ' + keys['OPENAI_API_KEY'], 'Content-Type': ctype}, body)
    if status != 200: return f'{name}: HTTP {status} {raw[:300]!r}'
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + '.png'); open(p, 'wb').write(base64.b64decode(json.loads(raw)['data'][0]['b64_json']))
    open(os.path.join(OUT, name + '.prompt.txt'), 'w').write(prompt)
    return f'{name}: OK {os.path.getsize(p) // 1024} Ko'


todo = [(n, s) for n, s in PLANS.items() if not ONLY or n.split('_')[0] in ONLY]
# P5 dépend de P1 (référence de lieu) : P1 d'abord, puis le reste en parallèle.
first = [t for t in todo if t[0].startswith('P1')]
rest = [t for t in todo if not t[0].startswith('P1')]
for t in first: print(gen(*t), flush=True)
with cf.ThreadPoolExecutor(max(1, len(rest))) as ex:
    for r in ex.map(lambda t: gen(*t), rest): print(r, flush=True)
