#!/usr/bin/env python3
"""Images de départ de plusieurs films (Ankylosaure, Spinosaure, Vélociraptor — plans de Nicolas du 28/09/2026).

Même méthode que triceratops/gen_start_images.py : UNE image de référence (dessin d'enfant, crayon de couleur),
prompt « Dans le même style (dessin d'enfant, crayon de couleur) dessine moi … ». Le HÉROS n'est jamais dessiné
(composité par l'app) ; les autres animaux (adversaires, troupeaux, proies) sont dans l'image, la vidéo les animera.
Une AMBIANCE par dinosaure : Ankylosaure = terre / grandes plaines ocre ; Spinosaure = forêt dense humide,
brumeuse, façon Jurassic Park ; Vélociraptor = forêt verte classique et ensoleillée.

Usage : python3 gen_start_images_multi.py <reference.png> <film> [plans=P1,P3]   (film = ankylosaurus | spinosaurus | velociraptor | dilophosaurus | stegosaurus)
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
        'mood': (" Dessiné COMME UN ENFANT, aussi SIMPLE que l'image de référence : peu d'éléments, arbres aux formes rondes "
                 "et simples, gros traits noirs, coloriage au crayon avec des hachures bien visibles. PAS de détails fins, PAS "
                 "de textures fouillées, de grandes zones simples. Chaque image a SA PROPRE météo et SA PROPRE palette de "
                 "couleurs (décrites ci-dessous), pas de ciel bleu uniforme. Vue de côté, format paysage 16:9, sol dans le "
                 "quart inférieur, pas de texte."),
        'plans': {
            'P1_chemin_aube': (
                "un chemin de terre qui traverse toute l'image dans une forêt à l'AUBE : ciel rose et orange pâle, brume "
                "blanche entre les troncs, herbe bleutée encore dans l'ombre, soleil qui pointe à peine à l'horizon à droite, "
                "arbres feuillus sombres de chaque côté. Le chemin et tout le centre restent vides pour un petit dinosaure "
                "qui court très vite de gauche à droite."),
            'P2_clairiere_automne_dinde': (
                "une clairière en AUTOMNE : arbres aux feuilles orange, rouges et jaunes, quelques feuilles mortes au sol, "
                "herbe jaunie, ciel gris-bleu couvert, lumière dorée. Dans le tiers DROIT, une dinde sauvage PETITE (pas plus "
                "haute qu'un cinquième de l'image), dessinée de façon RÉALISTE et sobre comme dans un livre d'animaux pour "
                "enfants : plumes brunes, petite tête rouge, queue baissée, DEBOUT et immobile, tournée vers la DROITE, en "
                "train de picorer. Pas d'expression comique, pas de bras écartés, pas de gouttes de sueur. La moitié gauche "
                "et le centre restent vides pour un petit dinosaure qui arrive."),
            'P3_oree_orage_trex': (
                "l'orée d'une forêt sous un ORAGE : ciel gris foncé et violet chargé de gros nuages, un éclair jaune au fond, "
                "pluie fine en traits obliques, herbe vert sombre. Les arbres sont au FOND et à DROITE seulement : le BORD "
                "GAUCHE de l'image est une prairie sombre complètement DÉGAGÉE, sans aucun arbre ni buisson ni rocher (un "
                "personnage doit pouvoir sortir par la gauche). Sur le BORD DROIT, un grand T-Rex vert à rayures orange (le "
                "même que sur l'image de référence), vu de côté, tourné vers la GAUCHE, gueule grande ouverte qui rugit, "
                "féroce. Le centre-gauche reste vide."),
            'P4_course_orage': (
                "la SUITE de la scène de la deuxième image (le même orage, la même heure, la même lumière violette et la même "
                "pluie en traits obliques) mais vue de côté pour une course : une rangée continue d'arbres sombres au fond sur "
                "TOUTE la largeur, herbe vert sombre et un chemin de terre en bas sur toute la largeur, le décor continue "
                "hors cadre à gauche et à droite (même hauteur de sol et d'arbres aux deux bords). Sur le BORD DROIT, le MÊME "
                "T-Rex vert à rayures orange que sur la deuxième image, vu de côté, tourné vers la GAUCHE, en train d'entrer "
                "dans l'image en courant (la moitié de son corps encore hors cadre à droite). Tout le reste du chemin est vide."),
            'P5_nuit_second_raptor': (
                "un coin de forêt la NUIT : ciel bleu nuit avec une grande lune ronde et des étoiles, herbe bleu-vert, "
                "arbres sombres, quelques lucioles jaunes, une souche, une lumière douce et bleutée. IMPORTANT, il DOIT y "
                "avoir un animal : dans le tiers DROIT, assis sur l'herbe à côté de la souche, un vélociraptor dessiné de façon "
                "RÉALISTE et sobre comme dans un livre d'animaux pour enfants (petit dinosaure carnivore brun et beige, museau "
                "allongé, longue queue, griffes, petits yeux — PAS de gros yeux ronds, pas de sourire, pas d'expression comique), "
                "bien visible, tourné vers la GAUCHE, la tête légèrement penchée, attentif. Ce n'est PAS le héros, c'est son "
                "copain : dessine-le. La moitié gauche et le centre restent vides."),
            'P6_matin_pluie_mouton': (
                "une prairie à la lisière d'une forêt sous une PLUIE de matin : ciel gris clair avec des nuages gris, "
                "gouttes de pluie en petits traits bleus, flaques d'eau qui brillent sur l'herbe vert vif, un arc-en-ciel "
                "pâle au fond, arbres verts. Dans le tiers DROIT, un petit mouton blanc et rond (laine bouclée, pattes "
                "noires), tourné vers la GAUCHE, les yeux écarquillés, effrayé. La moitié gauche et le centre restent vides "
                "pour un petit dinosaure qui le fixe avant de le poursuivre."),
        },
    },
    # ------------------------------------------------------------------ DILOPHOSAURE — forêt sombre, marécageuse
    'dilophosaurus': {
        'hero': "dilophosaure",
        'mood': (" Ambiance FORÊT SOMBRE et MARÉCAGEUSE, un peu mystérieuse, mais dessinée COMME UN ENFANT, aussi SIMPLE "
                 "que l'image de référence : peu d'éléments, grands arbres aux formes rondes, eau sombre, roseaux, brume en "
                 "traînées blanches, gros traits noirs, coloriage au crayon avec hachures visibles, verts profonds et bleus "
                 "sombres. PAS de détails fins, PAS de textures fouillées. Vue de côté, format paysage 16:9, sol dans le quart "
                 "inférieur, pas de texte."),
        'plans': {
            'P1_marais_arrivee': (
                "une forêt marécageuse : un chemin de terre sombre au premier plan qui traverse toute l'image, une mare d'eau "
                "verte avec des roseaux et des nénuphars à droite, de grands arbres sombres au fond avec de la mousse qui "
                "pend, brume au sol, quelques lucioles vertes, un rayon de lune pâle. Aucun animal. Tout le centre reste vide "
                "pour un dinosaure qui arrive en marchant."),
            'P2_marais_cretes': (
                "un autre coin de la même forêt marécageuse, plus resserré : grands troncs sombres de chaque côté, fougères, "
                "une souche, un peu d'eau au fond à gauche, brume, lumière verte tamisée qui tombe au centre. Aucun animal. "
                "Tout le centre reste vide, du sol jusqu'en haut, pour un gros plan sur un dinosaure."),
            'P3_combat_raptor': (
                "une clairière sombre de la forêt marécageuse. Dans la moitié DROITE, un COMBAT entre deux dinosaures dessinés "
                "de façon sobre : un dilophosaure (dinosaure bipède vert-bleu avec deux crêtes rouges sur la tête, et une "
                "grande collerette colorée déployée autour du cou comme au cinéma, gueule ouverte qui crache) face à un "
                "vélociraptor brun (plus petit, griffes, gueule ouverte), les deux dressés l'un contre l'autre. Toute la "
                "moitié GAUCHE reste vide pour le héros qui regarde de loin."),
            'P4_marais_zoom': (
                "le même coin resserré de la forêt marécageuse que l'image précédente : grands troncs sombres, fougères, "
                "brume, lumière verte tamisée au centre, mais vu d'un peu plus près. Aucun animal. Tout le centre reste vide "
                "pour un gros plan sur un dinosaure."),
            'P5_matin_oeuf': (
                "la forêt au MATIN, plus claire et douce : des rayons de soleil jaunes qui filtrent entre les grands arbres, "
                "brume lumineuse, mousse, fougères. Au CENTRE-DROIT, au sol, un grand œuf de dinosaure blanc tacheté, à moitié "
                "éclos : la coquille est fendue et une petite tête de bébé dinosaure herbivore (long cou, yeux doux, dessiné "
                "sobrement) en sort. La moitié gauche reste vide pour le héros."),
        },
    },
    # ------------------------------------------------------------------ STÉGOSAURE — grands espaces, saisons
    'stegosaurus': {
        'hero': "stégosaure",
        'mood': (" Dessiné COMME UN ENFANT, aussi SIMPLE que l'image de référence : peu d'éléments, formes rondes, gros traits "
                 "noirs, coloriage au crayon avec hachures visibles. PAS de détails fins. Grands espaces ouverts. Vue de côté, "
                 "format paysage 16:9, sol dans le quart inférieur, pas de texte."),
        'plans': {
            'P1_plaine_herbivores': (
                "une grande plaine d'herbe verte avec des collines douces au fond, ciel bleu, quelques arbres ronds. À GAUCHE "
                "et au FOND, petits et lointains, trois dinosaures herbivores sobres (un diplodocus, un tricératops, un "
                "ankylosaure) qui broutent tranquillement. Tout le centre et la droite restent vides pour le héros."),
            'P2_rocaille_trex': (
                "un sol ROCAILLEUX de canyon ocre et gris : gros rochers, cailloux, terre sèche, quelques buissons secs, "
                "falaises rouges au fond, ciel orangé. Sur le BORD DROIT, un grand T-Rex vert à rayures orange (le même que "
                "sur l'image de référence), vu de côté, tourné vers la GAUCHE, gueule ouverte qui rugit, en train d'arriver "
                "(une partie du corps encore hors cadre). Toute la moitié GAUCHE reste vide pour le héros."),
            'P3_migration_ete': (
                "une scène de MIGRATION en ÉTÉ vue de côté pour un travelling : une plaine d'herbe verte et de terre qui "
                "continue hors cadre à gauche et à droite (même hauteur de sol aux deux bords), des collines vertes et un "
                "ciel bleu au fond. Une file de dinosaures herbivores sobres (diplodocus, tricératops, petits bipèdes) qui "
                "marchent tous vers la DROITE, au FOND et sur les côtés, petits. Laisse un GRAND TROU au centre du premier "
                "plan pour le héros qui marche avec eux."),
            'P4_migration_automne': (
                "la SUITE de la scène de la deuxième image : la MÊME file de dinosaures herbivores en migration vers la "
                "DROITE, le même cadrage de côté, le décor continue hors cadre à gauche et à droite, mais en AUTOMNE : herbe "
                "jaune et rousse, arbres orange et rouges, feuilles mortes qui volent, ciel gris-doré. Grand trou au centre du "
                "premier plan pour le héros."),
            'P5_migration_hiver': (
                "la SUITE de la scène de la deuxième image : la MÊME file de dinosaures herbivores en migration vers la "
                "DROITE, le même cadrage de côté, le décor continue hors cadre à gauche et à droite, mais en HIVER : sol "
                "couvert de neige blanche, arbres nus ou sapins enneigés, flocons qui tombent, ciel gris-bleu pâle, buée "
                "devant les museaux. Grand trou au centre du premier plan pour le héros."),
            'P6_printemps_buisson': (
                "le PRINTEMPS : une prairie verdoyante pleine de fleurs colorées, une grande plaine au fond avec des "
                "montagnes bleues aux sommets blancs et un ciel bleu clair. Au CENTRE-DROIT, un gros buisson bas et rond bien "
                "vert avec des feuilles tendres, à hauteur de tête d'un dinosaure qui broute. Aucun animal. La moitié gauche "
                "et le centre restent vides pour le héros qui mange le buisson."),
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
COMMON = film['mood'] + (" Rappel : style enfant, simple, sans surcharge." if FILM in ('spinosaurus', 'velociraptor', 'dilophosaurus', 'stegosaurus') else '') + f" Ne dessine AUCUN {film['hero']} : le héros sera ajouté par-dessus plus tard, laisse-lui la place indiquée."
EXTRA_REFS = {'P4_course_orage': ['velociraptor/gpt-velociraptor/P3_oree_orage_trex.png'],
              'P4_marais_zoom': ['dilophosaurus/gpt-dilophosaurus/P2_marais_cretes.png'],
              'P4_migration_automne': ['stegosaurus/gpt-stegosaurus/P3_migration_ete.png'],
              'P5_migration_hiver': ['stegosaurus/gpt-stegosaurus/P3_migration_ete.png']}   # même T-Rex, même orage que P3
NO_HERO_EXCEPTION = {'P5_nuit_second_raptor': " Exception pour cette image : le vélociraptor assis à droite (le copain) DOIT être dessiné ; seul le héros, à gauche, est absent."}


def gen(name, scene):
    refs = [REF] + [os.path.join(HERE, r) for r in EXTRA_REFS.get(name, []) if os.path.exists(os.path.join(HERE, r))]
    files = [('image[]', (os.path.basename(r), open(r, 'rb').read(), 'image/png')) for r in refs]
    prompt = PREFIX + scene + COMMON + NO_HERO_EXCEPTION.get(name, '')
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
