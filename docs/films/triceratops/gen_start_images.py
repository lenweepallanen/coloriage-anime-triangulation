#!/usr/bin/env python3
"""Images de départ du film Tricératops (script « semi-manuel » du 25/09/2026) — OpenAI images/edits.

Entrée : UNE image de référence (dessin d'enfant, crayon de couleur) ; prompt en français, tel que voulu par
Nicolas : « Dans le même style (dessin d'enfant, crayon de couleur) dessine moi … ».
Le héros (tricératops) N'EST PAS dessiné : il est composité par l'app par-dessus la vidéo. Les autres
dinosaures (vélociraptor, T-Rex) sont dans l'image car ils seront animés par la vidéo.

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
COMMON = (" Vue de côté, format paysage 16:9, sol visible dans le quart inférieur de l'image, pas de texte. "
          "Ne dessine AUCUN tricératops : il sera ajouté par-dessus plus tard, laisse-lui la place indiquée.")

PLANS = {
    'P1_prairie_riviere': (
        "une prairie verte ensoleillée avec des fougères et des fleurs, une rivière bleue qui traverse l'image du fond "
        "vers le bas au MILIEU de l'image (assez étroite pour être sautée, avec des berges d'herbe et quelques cailloux), "
        "des montagnes et un volcan au loin, un grand ciel bleu avec un soleil et des nuages. La moitié gauche et la moitié "
        "droite restent dégagées (pas d'arbre devant) pour qu'un dinosaure puisse marcher de gauche à droite et sauter "
        "la rivière."),
    'P2_lisiere_foret': (
        "la lisière d'une forêt préhistorique vue de côté pour un travelling : une rangée continue de grands arbres "
        "(conifères, palmiers, fougères arborescentes) qui occupe le fond sur TOUTE la largeur, un chemin de terre et "
        "d'herbe en bas sur toute la largeur, le décor continue hors cadre à gauche et à droite (même hauteur de sol et "
        "d'arbres aux deux bords, aucun élément coupé bizarrement), ciel bleu visible au-dessus des arbres. Le milieu "
        "de l'image reste dégagé pour un dinosaure qui marche."),
    'P3_clairiere_velociraptor': (
        "une clairière au milieu de la forêt : de l'herbe et de la terre au sol, des arbres et des buissons tout autour "
        "au fond, une lumière douce. Sur le BORD DROIT de l'image, un PETIT vélociraptor (petit dinosaure carnivore, "
        "plumes brunes et beiges, longue queue, griffes) vu de côté, tourné vers la GAUCHE, en position d'attaque "
        "menaçante, gueule ouverte. Il est PETIT : sa hauteur ne dépasse pas un cinquième de la hauteur de l'image "
        "(il doit paraître deux fois plus petit qu'un tricératops adulte), les pattes posées sur le sol dans le quart "
        "inférieur. Toute la moitié gauche et le centre de la clairière restent vides."),
    'P4_terrain_terreux': (
        "un paysage préhistorique plus sec et terreux : de la terre ocre et rouge au sol avec des cailloux, quelques "
        "rochers, des buissons secs et des plantes grasses, des falaises de roche rouge au fond, un ciel orangé de fin "
        "d'après-midi. Le milieu de l'image reste vide."),
    'P5_face_au_trex': (
        "une plaine préhistorique au crépuscule avec un ciel violet et orange menaçant, des palmiers et un volcan qui "
        "fume au fond, de l'herbe et de la terre au sol. Sur la MOITIÉ DROITE de l'image, un grand T-Rex vert avec des "
        "rayures orange, vu de côté, tourné vers la GAUCHE, gueule grande ouverte qui rugit, dents pointues, l'air "
        "féroce. Toute la moitié gauche reste vide, face à lui."),
    'P6_poursuite_trex': (
        "la SUITE de la scène de la deuxième image (le T-Rex face à la plaine au crépuscule) : reprends EXACTEMENT le "
        "même ciel violet et orange avec ses nuages sombres, le même soleil couchant, le même volcan qui fume et les "
        "mêmes palmiers, mais en vue de côté pour un travelling de poursuite : herbes et terre au sol, le décor continue "
        "hors cadre à gauche et à droite (même hauteur de sol aux deux bords). Dans la moitié DROITE, le même grand T-Rex "
        "vert à rayures orange vu de côté qui COURT vers la DROITE, effrayé, pattes en pleine course, queue tendue. "
        "Toute la moitié gauche reste vide derrière lui."),
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


EXTRA_REFS = {'P6_poursuite_trex': [os.path.join(OUT, 'P5_face_au_trex.png')]}  # cohérence de ciel P5 → P6


def gen(name, scene):
    files = [('image[]', (os.path.basename(r), open(r, 'rb').read(), 'image/png')) for r in [REF] + EXTRA_REFS.get(name, [])]
    prompt = PREFIX + scene + COMMON
    fields = {'model': MODEL, 'prompt': prompt, 'size': '1792x1008', 'quality': 'high', 'output_format': 'png', 'n': '1'}
    body, ctype = multipart(fields, files)
    status, raw = http('https://api.openai.com/v1/images/edits', {'Authorization': 'Bearer ' + keys['OPENAI_API_KEY'], 'Content-Type': ctype}, body)
    if status != 200: return f'{name}: HTTP {status} {raw[:300]!r}'
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + '.png'); open(p, 'wb').write(base64.b64decode(json.loads(raw)['data'][0]['b64_json']))
    open(os.path.join(OUT, name + '.prompt.txt'), 'w').write(prompt)
    return f'{name}: OK {os.path.getsize(p) // 1024} Ko'


todo = [(n, s) for n, s in PLANS.items() if not ONLY or n.split('_')[0] in ONLY]
with cf.ThreadPoolExecutor(len(todo)) as ex:
    for r in ex.map(lambda t: gen(*t), todo): print(r, flush=True)
