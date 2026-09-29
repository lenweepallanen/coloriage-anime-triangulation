#!/usr/bin/env python3
"""Images de départ de plusieurs films (Ankylosaure, Spinosaure, Vélociraptor — plans de Nicolas du 28/09/2026).

Même méthode que triceratops/gen_start_images.py : UNE image de référence (dessin d'enfant, crayon de couleur),
prompt « Dans le même style (dessin d'enfant, crayon de couleur) dessine moi … ». Le HÉROS n'est jamais dessiné
(composité par l'app) ; les autres animaux (adversaires, troupeaux, proies) sont dans l'image, la vidéo les animera.
Une AMBIANCE par dinosaure : Ankylosaure = terre / grandes plaines ocre ; Spinosaure = forêt dense humide,
brumeuse, façon Jurassic Park ; Vélociraptor = forêt verte classique et ensoleillée.

Usage : python3 gen_start_images_multi.py <reference.png> <film> [plans=P1,P3]   (film = ankylosaurus | spinosaurus | velociraptor)
Sortie : docs/films/<film>/gpt-<film>/P*.png + .prompt.txt. Clé : OPENAI_API_KEY dans ~/.picopop-keys.env.
"""
import base64, json, os, sys, uuid, urllib.request, urllib.error, concurrent.futures as cf

REF, FILM = sys.argv[1], sys.argv[2]
opts = dict(a.split('=', 1) for a in sys.argv[3:] if '=' in a)
ONLY = set(opts['plans'].split(',')) if 'plans' in opts else None
MODEL = opts.get('model', 'gpt-image-2.5-sunburst')
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, FILM, 'gpt-' + FILM)

keys = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.picopop-keys.env')) if '=' in l and not l.startswith('#'))

PREFIX = "Dans le même style (dessin d'enfant, crayon de couleur) dessine moi "

FILMS = {
    # ------------------------------------------------------------------ ANKYLOSAURE — terre, grandes plaines
    'ankylosaurus': {
        'hero': "ankylosaure",
        'mood': (" Ambiance TERRE et grands espaces : sol de terre ocre et brun, herbe sèche jaune-vert, larges plaines, "
                 "lumière chaude. Vue de côté, format paysage 16:9, sol dans le quart inférieur, pas de texte."),
        'plans': {
            'P1_prairie_diplodocus': (
                "une prairie ouverte à la lisière d'une forêt de conifères, de l'herbe sèche et de la terre au sol, des "
                "collines au loin, un grand ciel bleu. Au FOND, petits et lointains, deux diplodocus (très long cou, très "
                "longue queue) qui marchent tranquillement vers la droite. Tout le centre de l'image, du sol au ciel, reste "
                "vide pour un dinosaure qui marche."),
            'P2_prairie_cascade': (
                "une autre prairie de terre et d'herbe sèche avec, dans le tiers DROIT et au fond, une belle cascade qui "
                "tombe d'une falaise de roche brune dans un petit bassin bleu, des rochers moussus, quelques fougères, un "
                "arc-en-ciel léger dans l'écume, ciel bleu. La moitié gauche et le centre restent vides."),
            'P3_plaine_aride_pterodactyles': (
                "une grande plaine ARIDE : terre craquelée ocre et rouge, quelques touffes d'herbe sèche, deux arbres morts "
                "tordus sur les côtés, des rochers, des mesas rouges à l'horizon, un ciel jaune-orangé chaud avec de la "
                "brume de chaleur. En haut à DROITE, loin dans le ciel, trois ptérodactyles (grandes ailes, crête, long "
                "bec) qui tournoient, petits et menaçants. Le sol au centre reste entièrement vide."),
            'P4_herbivores_buissons': (
                "une plaine de terre avec de nombreux buissons bas et ronds, des touffes d'herbe et quelques petits arbres, "
                "un ciel bleu doux. À GAUCHE et au FOND, deux ou trois dinosaures herbivores (un stégosaure et deux petits "
                "dinosaures à bec) qui broutent tranquillement les buissons, la tête baissée. Le centre et la droite de "
                "l'image restent vides, avec un ou deux buissons bas au centre-droit pour que le héros les mange."),
            'P5_migration': (
                "une scène de MIGRATION de dinosaures façon « L'Âge de glace » : une immense plaine de terre poussiéreuse, "
                "vue de côté, avec une longue file de dinosaures de toutes sortes (diplodocus, tricératops, stégosaures, "
                "petits bipèdes) qui marchent tous vers la DROITE, les plus proches en bas, les plus lointains petits vers "
                "l'horizon, un nuage de poussière derrière eux, un ciel orangé de fin de journée. Laisse un GRAND TROU dans "
                "la file au centre du premier plan (aucun dinosaure au centre) : le héros y marchera. Le décor doit pouvoir "
                "continuer hors cadre à gauche et à droite (même hauteur de sol aux deux bords)."),
        },
    },
    # ------------------------------------------------------------------ SPINOSAURE — forêt dense, humide, Jurassic Park
    'spinosaurus': {
        'hero': "spinosaure",
        'mood': (" Ambiance forêt humide et un peu inquiétante façon Jurassic Park, mais dessinée COMME UN ENFANT : "
                 "le dessin doit rester aussi SIMPLE que l'image de référence — peu d'éléments, quelques grands arbres aux "
                 "formes rondes et simples, quelques fougères, gros traits noirs, coloriage au crayon avec des hachures "
                 "bien visibles, verts profonds et un peu de brume dessinée en simples traînées blanches. PAS de détails "
                 "fins, PAS de textures fouillées, PAS de lianes partout, PAS de dizaines de plantes : de grandes zones "
                 "simples. Vue de côté, format paysage 16:9, sol dans le quart inférieur, pas de texte."),
        'plans': {
            'P1_foret_protoceratops': (
                "un chemin de terre humide dans la forêt dense, brume au sol, grands troncs et fougères. Dans la moitié "
                "DROITE, un petit troupeau de six protocératops (petits dinosaures à collerette, sans cornes, taille d'un "
                "mouton) qui broutent, l'un d'eux relève la tête, inquiet, en regardant vers la gauche. Toute la moitié "
                "GAUCHE reste vide pour un très grand dinosaure qui arrive en marchant."),
            'P2_foret_dense': (
                "le cœur de la forêt dense : troncs énormes couverts de mousse, lianes qui pendent, fougères géantes, un "
                "rayon de lumière qui tombe au centre entre les feuillages, brume légère, quelques champignons et un tronc "
                "couché. Tout le centre reste vide, du sol jusqu'en haut, pour un très grand dinosaure."),
            'P3_mare_oiseaux': (
                "une mare sombre dans la forêt dense, dans le tiers DROIT et au fond : eau verte immobile avec des "
                "nénuphars et des roseaux, brume, grands arbres autour. Au-dessus de la mare, une dizaine de petits oiseaux "
                "blancs et gris qui tournoient dans un rayon de lumière. Le centre et la gauche restent vides."),
            'P4_ruisseau_poisson': (
                "un ruisseau clair qui traverse la forêt dans la moitié DROITE de l'image, avec des rochers moussus, de "
                "l'écume, des fougères sur les berges, brume, grands arbres simples. Sous la surface de l'eau, près de la "
                "berge gauche, une SILHOUETTE de gros poisson entièrement IMMERGÉE, à peine visible à travers l'eau bleue "
                "(dessinée en bleu plus foncé, sans aucune partie hors de l'eau, sans éclaboussure). La berge GAUCHE et le "
                "centre restent vides pour un grand dinosaure qui se penche vers l'eau."),
            'P5_foret_bus': (
                "une autre partie de la forêt, un peu plus claire : grands arbres simples, fougères, une large piste de "
                "terre qui traverse toute l'image de gauche à droite, brume légère. AUCUN véhicule, aucun animal : la piste "
                "est complètement vide (un bus arrivera plus tard par la droite). Toute la moitié gauche et le centre restent "
                "vides pour un très grand dinosaure."),
            'P6_face_trex': (
                "une clairière sombre de la forêt dense au crépuscule : ciel violet et orange entre les grands arbres, "
                "brume, fougères, un tronc couché. Sur le BORD GAUCHE, un grand T-Rex vert à rayures orange (le même que "
                "sur l'image de référence), vu de côté, tourné vers la DROITE, gueule grande ouverte qui rugit, dents "
                "pointues, féroce. Toute la moitié DROITE reste vide, face à lui."),
        },
    },
    # ------------------------------------------------------------------ VÉLOCIRAPTOR — forêt verte classique
    'velociraptor': {
        'hero': "vélociraptor",
        'mood': (" Ambiance FORÊT VERTE CLASSIQUE et ensoleillée : arbres feuillus aux feuilles rondes, herbe verte, "
                 "fleurs, ciel bleu, soleil, lumière gaie. Vue de côté, format paysage 16:9, sol dans le quart inférieur, "
                 "pas de texte."),
        'plans': {
            'P1_chemin_foret': (
                "un chemin de terre qui traverse toute l'image dans une forêt verte ensoleillée, des arbres feuillus de "
                "chaque côté, de l'herbe, des fleurs, des rochers, ciel bleu avec soleil et nuages. Le chemin et tout le "
                "centre restent vides pour un petit dinosaure qui court très vite de gauche à droite."),
            'P2_clairiere_dinde': (
                "une clairière ensoleillée dans la forêt verte : herbe, fleurs, arbres autour, ciel bleu. Dans le tiers "
                "DROIT, une grosse dinde sauvage (plumes brunes, caroncule rouge, ailes ouvertes) qui court vers la "
                "DROITE, affolée, le bec ouvert. La moitié gauche et le centre restent vides pour un petit dinosaure qui "
                "la poursuit."),
            'P3_oree_trex': (
                "l'orée de la forêt verte : les derniers grands arbres à gauche, une prairie qui s'ouvre à droite, ciel "
                "bleu. Sur le BORD DROIT, un grand T-Rex vert à rayures orange (le même que sur l'image de référence), vu "
                "de côté, tourné vers la GAUCHE, gueule grande ouverte qui rugit, féroce. Le centre-gauche reste vide."),
            'P4_course_foret': (
                "la forêt verte vue de côté pour un travelling de course : une rangée continue d'arbres feuillus et de "
                "buissons au fond sur TOUTE la largeur, de l'herbe et un chemin de terre en bas sur toute la largeur, le "
                "décor continue hors cadre à gauche et à droite (même hauteur de sol et d'arbres aux deux bords), ciel bleu "
                "au-dessus. Aucun animal : le milieu reste vide pour des dinosaures qui traversent en courant."),
            'P5_calme_second_raptor': (
                "un coin calme et ensoleillé de la forêt verte : une souche, des fleurs, de l'herbe douce, arbres autour, "
                "ciel bleu. Dans le tiers DROIT, un vélociraptor (petit dinosaure carnivore brun et beige, longue queue, "
                "griffes) assis tranquillement, tourné vers la GAUCHE, l'air curieux. La moitié gauche et le centre restent "
                "vides."),
            'P6_mouton': (
                "une prairie verte à la lisière de la forêt, herbe, fleurs, quelques arbres, ciel bleu. Dans le tiers "
                "DROIT, un petit mouton blanc et rond (laine bouclée, pattes noires), tourné vers la GAUCHE, les yeux "
                "écarquillés, effrayé. La moitié gauche et le centre restent vides pour un petit dinosaure qui le fixe "
                "avant de le poursuivre."),
        },
    },
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


film = FILMS[FILM]
COMMON = film['mood'] + (" Rappel : style enfant, simple, sans surcharge." if FILM == 'spinosaurus' else '') + f" Ne dessine AUCUN {film['hero']} : le héros sera ajouté par-dessus plus tard, laisse-lui la place indiquée."


def gen(name, scene):
    files = [('image[]', (os.path.basename(REF), open(REF, 'rb').read(), 'image/png'))]
    prompt = PREFIX + scene + COMMON
    fields = {'model': MODEL, 'prompt': prompt, 'size': '1792x1008', 'quality': 'high', 'output_format': 'png', 'n': '1'}
    body, ctype = multipart(fields, files)
    status, raw = http('https://api.openai.com/v1/images/edits', {'Authorization': 'Bearer ' + keys['OPENAI_API_KEY'], 'Content-Type': ctype}, body)
    if status != 200: return f'{FILM} {name}: HTTP {status} {raw[:300]!r}'
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name + '.png'); open(p, 'wb').write(base64.b64decode(json.loads(raw)['data'][0]['b64_json']))
    open(os.path.join(OUT, name + '.prompt.txt'), 'w').write(prompt)
    return f'{FILM} {name}: OK {os.path.getsize(p) // 1024} Ko'


todo = [(n, s) for n, s in film['plans'].items() if not ONLY or n.split('_')[0] in ONLY]
with cf.ThreadPoolExecutor(len(todo)) as ex:
    for r in ex.map(lambda t: gen(*t), todo): print(r, flush=True)
