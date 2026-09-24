#!/usr/bin/env python3
"""Génère les images de décor d'un film PicoPop avec OpenAI gpt-image (référence de style = captures du film T-REX),
et optionnellement xAI grok-imagine-image. Bibliothèque standard uniquement (urllib).

Usage : python3 gen_backdrops.py <dossier_sortie> <dossier_refs_jpg> [set=v2] [plans=P1,P3] [providers=gpt]
Clés lues dans ~/.picopop-keys.env (OPENAI_API_KEY, XAI_API_KEY).
Sorties : <dossier_sortie>/gpt-<set>/<plan>.png (et grok-<set>/ si demandé)."""
import base64, json, os, sys, uuid, urllib.request, urllib.error, concurrent.futures as cf

OUT = sys.argv[1]
REF_DIR = sys.argv[2]
opts = dict(a.split('=', 1) for a in sys.argv[3:] if '=' in a)
SET = opts.get('set', 'v2')
ONLY = set(opts['plans'].split(',')) if 'plans' in opts else None
PROVIDERS = set(opts.get('providers', 'gpt').split(','))
GPT_MODEL = opts.get('model', 'gpt-image-2.5-sunburst')

keys = {}
for line in open(os.path.expanduser('~/.picopop-keys.env')):
    if '=' in line:
        k, v = line.strip().split('=', 1); keys[k] = v

STYLES = {
    # v1 : trop « cartoon enfantin » (jugé par Nicolas le 2026-09-14) — conservé pour mémoire
    'v1': ("Children's coloring-book illustration colored with wax crayons and colored pencils, visible pencil "
           "hatching texture, bold black outlines, bright flat cheerful colors, simple rounded shapes for kids age 3-5, "
           "underwater scene, no text, no watermark, no logo, wide 16:9 landscape background. "
           "Match EXACTLY the drawing style, line weight and crayon texture of the reference image(s), but the scene is "
           "completely new and different: do NOT copy the reference scene, and do NOT draw any T-Rex or any large "
           "dinosaur character in the middle — the center must stay free for a character that will be added later."),
    # v2 : style enfant mais formes NATURALISTES (documentaire animalier), pas cartoon
    'v2': ("Illustration for a children's nature picture book, drawn with colored pencils and wax crayons on paper: "
           "visible pencil hatching and crayon grain, fine dark outlines, rich layered colors. "
           "NATURALISTIC style like a wildlife documentary for kids: realistic proportions and anatomy for every animal, "
           "plant and rock; no cartoon faces, no smiling animals, no big googly eyes, no exaggerated or chibi shapes. "
           "Wide 16:9 landscape underwater background, no text, no watermark, no logo. "
           "Match the drawing style, line weight and crayon texture of the reference images (same illustrator), but "
           "create a completely NEW underwater scene: do not copy any element of the references, do not draw any T-Rex "
           "or land dinosaur, no trees, no sky, no clouds. Leave the center of the frame free (open water) for a character "
           "that will be composited later."),
    # v3 : crayon enfant SIMPLE, formes réalistes, référence unique (v2 jugée trop « peinture »)
    'v3': ("Children's picture-book illustration drawn with colored pencils and wax crayons on paper: clearly visible "
           "crayon strokes and hatching, bold black outlines around every shape, bright saturated colors, MEDIUM level of "
           "detail with simple readable shapes. NOT painterly, NOT photorealistic, no soft shading gradients, no fine "
           "rendering, no tiny details. Shapes and proportions are realistic (real anatomy for animals, plants and rocks, "
           "like a nature book for kids) but drawn simply with a few strokes. Copy EXACTLY the technique of the reference "
           "image: same crayon texture, same black outline weight, same simplicity, same color vibrancy. "
           "Wide 16:9 underwater background, no text, no watermark, no logo. Do not copy the reference composition; "
           "create a new scene. Leave the center of the frame free (open water) for a character composited later."),
}

PLAN_SETS = {
    'v1': {
        'P1_presentation_reef': "Bright sunny coral reef, turquoise water with sun rays from the top, colorful corals and tall swaying seaweed along the bottom, a small orange ammonite on the left, two friendly cartoon ichthyosaurs (blue, smiling) far in the background on the right, a few tiny yellow and red fish. Wide open water in the center-left.",
        'P2_deep_ocean_home': "Deep dark-blue ocean, faint light rays from the top, a few bubbles rising, a school of small silver fish at the bottom-left, a huge friendly cartoon ichthyosaur gliding far in the background on the left, a giant gentle manta ray far at the bottom, wide empty water in the center and right.",
        'P3_chase_rock': "Deep blue ocean, dark blue water with lighter rays at the top, a few bubbles, a big rounded grey rock on the far right edge, small silhouettes of fish in the distance. Empty center.",
        'P4_neck_periscope_reef': "Bright shallow reef, turquoise water, sun rays, colorful corals and swaying seaweed at the bottom, one large rounded rock on the right third, lots of open water in the upper-left and center. A group of 8 tiny colorful fish (yellow, orange, red) peeking from behind the rock with big eyes.",
        'P5_lagoon_turtle': "Sunny shallow lagoon, pale sandy floor, light ripples dancing on the sand, a few small corals and a starfish, wide open water in the middle. A small cute green sea turtle with big eyes at the left-center, mid-height, swimming slowly.",
    },
    # v2 : 5 environnements distincts (documentaire animalier)
    'v2': {
        'P1_coral_reef': "Sunlit tropical coral reef seen underwater: large coral heads (brain coral, branching staghorn coral, sea fans) in orange, pink, purple and yellow growing on grey rocks, small schools of reef fish (yellow, blue, striped), an ammonite drifting on the left, two ichthyosaurs (realistic dolphin-like prehistoric marine reptiles, dark blue back, pale belly, long pointed snout) swimming far in the background on the right. Clear turquoise water, soft light from above, no visible sand. Open water in the center-left.",
        'P2_open_deep_ocean': "Open deep ocean, mid-water: NO water surface and NO seafloor visible, only vast deep navy-blue water, darker at the bottom and slightly lighter at the top, faint drifting particles (marine snow) and a few rising bubbles. Far in the background, dark silhouettes of huge prehistoric sea creatures: a large ichthyosaur gliding on the left, a giant ray-like shape lower down, a distant school of small silver fish at the bottom-left. Mysterious, calm, vast. Center and right completely empty.",
        'P3_rocky_canyon': "Underwater rocky canyon: steep grey and brown rock walls on both sides with cracks, ledges and scattered boulders on a stony floor (no sand), one very large rounded boulder on the far right edge of the frame, dim blue-green light falling from above, a few small dark fish silhouettes, sparse brown seaweed in the cracks. Narrow and dramatic, mostly empty in the center.",
        'P4_kelp_forest': "Underwater kelp forest: tall golden-brown and olive-green kelp stalks with long blades rising from a rocky bottom to the top of the frame, greenish-golden light filtering between the stalks, a rocky shelf with a dark crevice on the right third where a small school of silver and yellow fish hides with only their heads showing, sea urchins and orange starfish on the rocks. Open water column in the upper-left and center.",
        'P5_seagrass_meadow': "Shallow sunlit seagrass meadow: dense bright green seagrass swaying over the bottom, a few pale rocks and shells, clear turquoise water, the water surface visible at the top with gentle waves and sparkling light, a realistic green sea turtle (naturalistic shape, patterned shell, calm natural face) swimming slowly at the left-center, a few small fish. Calm and peaceful. Open water in the middle.",
    },
    # v3 : mêmes environnements que v2, formes plus simples, P3 devient un TUNNEL ROCHEUX pour un plan travelling
    'v3': {
        'P1_coral_reef': "Sunlit coral reef: big simple coral shapes (round brain coral, branching coral, tube sponges) in orange, pink, purple and yellow on grey rocks along the bottom and the sides, a few small schools of reef fish, one ammonite drifting at the left, two ichthyosaurs (realistic dolphin-like prehistoric marine reptiles with a long pointed snout) swimming far in the background at the right. Clear turquoise-blue water with light rays. Wide open water in the center-left.",
        'P2_open_deep_ocean': "Open deep ocean, mid-water: NO water surface and NO seafloor, just deep navy-blue water made of crayon strokes, a few bubbles and tiny drifting particles. Far in the background on the left, the dark silhouette of a large ichthyosaur and, lower, a giant ray-like silhouette; a small school of silver fish at the bottom-left. Center and right completely empty.",
        'P3_rock_tunnel': "Side view of a long straight horizontal underwater rock tunnel that runs across the ENTIRE width of the frame and continues out of frame on BOTH the left and the right edges: a rugged grey-brown rock ceiling forming a horizontal band along the top (same thickness at the far left edge and at the far right edge, with a few hanging stalactite shapes), a rock floor with boulders forming a horizontal band along the bottom (same thickness at both edges), and between them a wide straight corridor of open blue water from edge to edge. NO rock walls, NO narrowing and NO closing at the left or right sides: the corridor stays fully open at both edges, as if it were one section of an endless tunnel. Two or three openings in the ceiling let light rays in, a few small dark fish silhouettes, sparse brown seaweed on the rocks. The middle band stays completely free.",
        'P4_kelp_forest': "Kelp forest: tall simple golden-brown kelp stalks with long blades rising from a rocky bottom to the top of the frame on the left and the right, greenish-golden light between them, a rocky ledge with a dark crevice on the right third where a small school of silver and yellow fish hides with only their heads showing, a few sea urchins and one orange starfish on the rocks. Open water column in the upper-left and center.",
        'P5_seagrass_meadow': "Shallow sunlit seagrass meadow: simple bright green seagrass blades swaying over the bottom, a few pale rocks and shells, clear turquoise water, the wavy water surface at the top with sparkles, a green sea turtle (realistic simple shape, patterned shell) swimming slowly at the left-center, a few small fish. Open water in the middle.",
    },
    # Film PTERANODON — 5 environnements ciel / côte (style v3), P2 = travelling aérien
    'ptero': {
        'P1_sea_cliff': "Tall sea cliff seen from the side: a rugged grey-brown rock face filling the left third with ledges, tufts of grass and a large nest of sticks on a ledge, the sea far below at the bottom right with small waves and a few rocks, pale blue morning sky with soft clouds, two or three small pteranodon silhouettes far away in the sky at the top right. Wide open sky in the center and right.",
        'P2_dino_plain_aerial': "Seen from high in the air, looking slightly down over a prehistoric plain that runs across the ENTIRE width of the frame and continues out of frame on BOTH the left and the right sides (same landscape height at both edges, made to scroll horizontally): green grassland with clumps of ferns and a winding river in the lower half, small herds of dinosaurs seen from above and far away (a few long-neck sauropods, some triceratops), a volcano and mountains along the horizon, blue sky with a few flat clouds in the upper third. The center and the upper part of the frame stay free.",
        'P3_beach_red_car': "Sandy beach: low grassy dunes and a few tall prehistoric palm-like trees on the left, calm sea with gentle waves on the right, a small red vintage car (simple realistic shape, seen from the side) parked on the sand in the lower center, blue sky with a few clouds filling the upper two thirds. Wide open sky above the car.",
        # (ex-P4 'sea stacks storm' abandonné : le héros ne peut pas jouer la lutte contre le vent)
        'P4_jungle_trex': "Prehistoric jungle clearing seen from the side: tall trees with big leaves and ferns on the left and the right, a flat dirt clearing floor along the bottom, a volcano far away on the horizon, blue sky filling the upper half. A big Tyrannosaurus rex (realistic proportions, dark green scaly skin, sharp teeth, fierce look) stands on the clearing at the lower center-right, its head raised, looking up at the sky with its mouth slightly open. The upper third of the frame stays completely free.",
        'P5_flight_to_ocean': "Seen from high in the air, flying along a prehistoric coastline toward the sea at sunset: the coast runs across the ENTIRE width of the frame and continues out of frame on BOTH sides (made to scroll horizontally) — sandy beach and low cliffs with a few palm-like trees along the lower third, the ocean filling the middle band with gentle waves, a few small rocky islets far away, the sun low on the horizon at the right with a warm orange-pink sky and a few clouds lit from below in the upper third. No animals. The upper part of the frame stays free.",
        'P5_sunset_ocean': "Calm open ocean at golden hour seen from just above the water: gentle swell in the lower third, warm orange and pink sky, the sun low on the horizon at the right, a few distant flat islands, two small fish jumping out of the water at the lower left, a few clouds lit from below. Wide open sky in the center.",
    },
}
STYLE = STYLES.get(SET, STYLES['v3'])
PLANS = PLAN_SETS[SET]

refs = sorted(os.path.join(REF_DIR, f) for f in os.listdir(REF_DIR) if f.endswith('.jpg'))
GPT_DIR = os.path.join(OUT, 'gpt-' + SET); GROK_DIR = os.path.join(OUT, 'grok-' + SET)


def http(url, headers, body, timeout=900):
    req = urllib.request.Request(url, data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


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


def gen_gpt(name, scene):
    files = [('image[]', (os.path.basename(r), open(r, 'rb').read(), 'image/jpeg')) for r in refs[:4]]
    fields = {'model': GPT_MODEL, 'prompt': STYLE + "\n\nScene to draw: " + scene,
              'size': '1792x1008', 'quality': 'high', 'output_format': 'png', 'n': '1'}
    body, ctype = multipart(fields, files)
    status, raw = http('https://api.openai.com/v1/images/edits',
                       {'Authorization': 'Bearer ' + keys['OPENAI_API_KEY'], 'Content-Type': ctype}, body)
    if status != 200:
        return f"gpt {name}: HTTP {status} {raw[:300]!r}"
    b64 = json.loads(raw)['data'][0]['b64_json']
    os.makedirs(GPT_DIR, exist_ok=True)
    p = os.path.join(GPT_DIR, name + '.png'); open(p, 'wb').write(base64.b64decode(b64))
    return f"gpt {name}: OK {os.path.getsize(p)//1024} KB"


def gen_grok(name, scene):
    """Texte seul (le mode edits avec référence recopie la scène de référence)."""
    hdr = {'Authorization': 'Bearer ' + keys['XAI_API_KEY'], 'Content-Type': 'application/json'}
    body = {'model': 'grok-imagine-image-2.0', 'prompt': STYLE + "\n\nScene to draw: " + scene,
            'aspect_ratio': '16:9', 'response_format': 'b64_json'}
    status, raw = http('https://api.x.ai/v1/images/generations', hdr, json.dumps(body).encode())
    if status != 200:
        return f"grok {name}: HTTP {status} {raw[:200]!r}"
    d = json.loads(raw)['data'][0]
    os.makedirs(GROK_DIR, exist_ok=True)
    p = os.path.join(GROK_DIR, name + '.png')
    if d.get('b64_json'):
        open(p, 'wb').write(base64.b64decode(d['b64_json']))
    else:
        with urllib.request.urlopen(d['url'], timeout=120) as r:
            open(p, 'wb').write(r.read())
    return f"grok {name}: OK {os.path.getsize(p)//1024} KB"


if __name__ == '__main__':
    jobs = []
    with cf.ThreadPoolExecutor(max_workers=10) as ex:
        for name, scene in PLANS.items():
            if ONLY and name not in ONLY:
                continue
            if 'gpt' in PROVIDERS:
                jobs.append(ex.submit(gen_gpt, name, scene))
            if 'grok' in PROVIDERS:
                jobs.append(ex.submit(gen_grok, name, scene))
        for j in cf.as_completed(jobs):
            try:
                print(j.result(), flush=True)
            except Exception as e:
                print("ERR", repr(e), flush=True)
