"""Points de suivi v2 (≈ 95) : extrémités + courbes naturelles (corne, crinière, queue, pattes), coords VIDÉO 960×960.
Produit points3.json (CoTrackerPoint[]), skeleton3.json (CoTrackerSkeleton) et un aperçu. Les noms servent de clés pour les chaînes."""
import json, uuid, sys
from PIL import Image, ImageDraw
S = sys.argv[1]; zones = {z['label']: z for z in json.load(open(f'{S}/zones.json'))}
P = []  # (nom, x, y, groupe)
def add(g, *pts):
    for n, x, y in pts: P.append((n, x, y, g))
# ── TÊTE : corne (5), tête (12), crinière (16), cou (3)
add('TETE', ('corne bout', 72, 38), ('corne 2', 95, 75), ('corne 3', 120, 112), ('corne 4', 145, 150), ('corne base', 170, 180))
add('TETE', ('oreille bout', 320, 70), ('oreille base', 295, 165), ('oeil', 220, 285), ('oeil arriere', 255, 285), ('joue', 265, 350),
    ('naseau', 80, 347), ('bouche', 167, 365), ('sourire', 275, 392), ('museau', 50, 330), ('menton', 90, 420), ('machoire', 180, 435),
    ('gorge', 245, 420), ('front', 200, 230), ('haut tete', 280, 185))
add('TETE', ('criniere front', 120, 190), ('criniere sommet', 220, 95), ('criniere ext 1', 380, 195), ('criniere ext 2', 455, 280),
    ('criniere ext 3', 495, 345), ('criniere ext 4', 510, 400), ('criniere ext 5', 480, 455), ('criniere bout', 410, 515),
    ('criniere int 1', 335, 260), ('criniere int 2', 340, 330), ('criniere int 3', 350, 400), ('criniere int 4', 380, 450),
    ('criniere violet 1', 360, 290), ('criniere violet 2', 420, 370), ('criniere violet 3', 445, 430),
    ('criniere rose 1', 410, 240), ('criniere rose 2', 470, 320), ('criniere rose 3', 480, 380))
add('TETE', ('cou avant', 250, 470), ('cou centre', 300, 470), ('cou base', 330, 500))
# ── CORPS (12)
add('body', ('poitrail', 240, 520), ('poitrail bas', 245, 600), ('epaule', 320, 600), ('dos avant', 530, 470), ('dos', 580, 468),
    ('dos arriere', 630, 470), ('croupe', 665, 485), ('etoile', 630, 545), ('hanche', 640, 620), ('corps centre', 450, 580),
    ('ventre avant', 390, 690), ('ventre', 460, 680), ('ventre arriere', 500, 680))
# ── QUEUE (20) : base, centre (violet), bord externe (rose), bord interne (bleu), bout
add('body', ('epaule haute', 330, 520), ('flanc avant haut', 400, 530), ('flanc avant', 390, 615), ('flanc centre haut', 520, 525),
    ('flanc centre bas', 520, 625), ('flanc arriere', 600, 600), ('hanche haute', 665, 560), ('croupe bas', 700, 560),
    ('AVD hanche int', 295, 595), ('AVG hanche int', 375, 600), ('ARD hanche int', 545, 600), ('ARG hanche int', 655, 595))
add('body', ('queue base', 690, 480), ('queue base bas', 700, 505),
    ('queue c1', 765, 475), ('queue c2', 830, 495), ('queue c3', 860, 555), ('queue c4', 850, 615), ('queue c5', 860, 675), ('queue c6', 880, 735), ('queue c7', 880, 785), ('queue bout', 880, 845),
    ('queue ext 1', 765, 400), ('queue ext 2', 835, 415), ('queue ext 3', 880, 470), ('queue ext 4', 895, 540), ('queue ext 5', 880, 615), ('queue ext 6', 895, 680), ('queue ext 7', 930, 745), ('queue ext 8', 920, 795),
    ('queue int 1', 725, 545), ('queue int 2', 740, 610), ('queue int 3', 765, 660), ('queue int 4', 795, 710), ('queue int 5', 815, 760), ('queue int 6', 835, 810))
# ── PATTES (4 × 4 : hanche, genou, cheville, sabot)
add('AVD', ('AVD hanche', 280, 660), ('AVD genou', 262, 770), ('AVD cheville', 235, 850), ('AVD sabot', 235, 900))
add('AVG', ('AVG hanche', 380, 660), ('AVG genou', 405, 770), ('AVG cheville', 400, 850), ('AVG sabot', 390, 900))
add('ARD', ('ARD hanche', 540, 680), ('ARD genou', 555, 780), ('ARD cheville', 545, 850), ('ARD sabot', 545, 895))
add('ARG', ('ARG hanche', 670, 665), ('ARG genou', 690, 780), ('ARG cheville', 705, 850), ('ARG sabot', 705, 900))
COL = {'TETE': '#ec4899', 'body': '#22c55e', 'AVD': '#ef4444', 'AVG': '#f59e0b', 'ARD': '#3b82f6', 'ARG': '#a855f7'}
pts = [{'id': str(uuid.uuid4()), 'name': n, 'color': COL[g], 'prompts': [{'frameIdx': 0, 'x': x, 'y': y}]} for n, x, y, g in P]
assert len({p['name'] for p in pts}) == len(pts), 'noms en double'
json.dump(pts, open(f'{S}/points3.json', 'w'), indent=1, ensure_ascii=False)
ID = {p['name']: p['id'] for p in pts}
def ref(*names):
    w = 1 / len(names); return {'pointIds': [ID[n] for n in names], 'weights': [w] * len(names)}
def joint(name, *names): return {'id': str(uuid.uuid4()), 'name': name, 'ref': ref(*names)}
# Chaîne corps : cou → poitrail → centre → croupe → queue (polyligne continue jusqu'au bout de la queue)
body_chain = [joint('cou', 'cou base'), joint('poitrail', 'poitrail', 'epaule'), joint('centre', 'dos', 'ventre'), joint('croupe', 'etoile', 'hanche'),
              joint('queue base', 'queue base'), joint('queue 1', 'queue c2'), joint('queue 2', 'queue c3'), joint('queue 3', 'queue c4'),
              joint('queue 4', 'queue c5'), joint('queue 5', 'queue c6'), joint('queue 6', 'queue c7'), joint('queue bout', 'queue bout')]
def leg(label, hip, joints, foot):
    z = zones[label]; return {'id': str(uuid.uuid4()), 'zoneId': z['id'], 'name': label, 'hip': ref(*hip), 'joints': [ref(*j) for j in joints], 'foot': ref(*foot)}
# hanche = point DANS le flanc (retour Nicolas 09/10 : attaché au bord, la patte « sort » et semble désossée)
legs = [leg(L, [f'{L} hanche int'], [[f'{L} genou'], [f'{L} cheville']], [f'{L} sabot']) for L in ('AVD', 'AVG', 'ARD', 'ARG')]
# Tête : une seule chaîne par zone → cou → gorge → tête → oreille → crinière (bord externe) → bout de crinière
legs.append(leg('TETE', ['cou base'], [['cou centre'], ['gorge'], ['oeil', 'joue'], ['oreille base'], ['criniere ext 2'], ['criniere ext 3'], ['criniere ext 4'], ['criniere ext 5']], ['criniere bout']))
skeleton = {'bodyChain': body_chain, 'legs': legs}
json.dump(skeleton, open(f'{S}/skeleton3.json', 'w'), indent=1, ensure_ascii=False)
im = Image.open(f'{S}/frame0.png').convert('RGB'); d = ImageDraw.Draw(im)
pos = {p['name']: (p['prompts'][0]['x'], p['prompts'][0]['y']) for p in pts}
def rpos(r): return (sum(pos[[p['name'] for p in pts if p['id'] == i][0]][0] * w for i, w in zip(r['pointIds'], r['weights'])), sum(pos[[p['name'] for p in pts if p['id'] == i][0]][1] * w for i, w in zip(r['pointIds'], r['weights'])))
chain = [rpos(j['ref']) for j in body_chain]; d.line(chain, fill='black', width=5); d.line(chain, fill='#22c55e', width=3)
for L in legs:
    c = [rpos(L['hip'])] + [rpos(j) for j in L['joints']] + [rpos(L['foot'])]; col = zones[L['name']]['color']; d.line(c, fill='black', width=5); d.line(c, fill=col, width=3)
for p in pts:
    x, y = pos[p['name']]; d.ellipse([x-5, y-5, x+5, y+5], fill=p['color'], outline='black', width=1)
im.save(f'{S}/points3-apercu.png'); print(len(pts), 'points ·', len(body_chain), 'joints corps+queue ·', len(legs), 'chaînes membres')
