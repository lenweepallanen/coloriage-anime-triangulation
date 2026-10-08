#!/usr/bin/env python3
"""Triangulation projet AUTOMATIQUE d'un coloriage quadrupède au trait (PNG fond transparent) — pilote LICORNE.

  python3 docs/triangulation/auto_triang.py <coloriage.png> --name "01_sparkle_TEST" [--dry-run] [--project <id existant>]

Étapes : silhouette (alpha) → régions blanches fermées par le trait → sabots + pattes « fermées » (seeds + inflate, comme
l'étape Zones en mode Canny) et pattes « ouvertes » (arrière-plan, sans trait de jonction : croissance depuis le sabot) →
body = silhouette − pattes, ponté → géométrie par le module TypeScript de l'admin (P0, anchors, subdivision, Delaunay, trous,
faces cachées) → projet Firestore + Storage (image, référence, masques RLE, contours). `--dry-run` : rendu de contrôle seulement.
"""
import cv2, numpy as np, json, os, sys, subprocess, uuid, time, io, base64, mimetypes, urllib.request, urllib.error, urllib.parse
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(os.path.dirname(HERE))
args = [a for a in sys.argv[1:] if not a.startswith('--')]; flags = dict(a[2:].split('=', 1) if '=' in a else (a[2:], True) for a in sys.argv[1:] if a.startswith('--'))
SRC = args[0]; NAME = flags.get('name') or os.path.splitext(os.path.basename(SRC))[0]; DRY = bool(flags.get('dry-run'))
OUT = flags.get('out') or os.path.join(os.path.expanduser('~/Downloads'), f'auto-triang-{NAME}'); os.makedirs(OUT, exist_ok=True)
SIGMA = float(flags.get('sigma', 3))
# inflate/bridge proportionnels à la taille d'image (le trait d'un coloriage 2048 px fait ~14 px ; l'UI utilise 12 sur des images 1254 px)
INFLATE = None; BRIDGE = None
COLORS = {'AVG': '#f59e0b', 'AVD': '#ef4444', 'ARD': '#3b82f6', 'ARG': '#a855f7'}

# ───────────────────────── 1. image, silhouette, régions ─────────────────────────
im = cv2.imread(SRC, cv2.IMREAD_UNCHANGED)
if im is None or im.shape[2] != 4: sys.exit('PNG RGBA attendu')
H, W = im.shape[:2]; alpha = im[..., 3]; a01 = alpha.astype(np.float32) / 255
INFLATE = int(flags.get('inflate', max(12, round(max(W, H) / 100)))); BRIDGE = float(flags.get('bridge', max(6, round(max(W, H) / 200))))
flat = (im[..., :3].astype(np.float32) * a01[..., None] + 255 * (1 - a01[..., None])).astype(np.uint8)
cv2.imwrite(f'{OUT}/image.png', flat)
gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
sil = (alpha > 128).astype(np.uint8) * 255   # > 128 : exclut la frange d'anticrénelage (sinon un anneau de 3-5 px subsiste autour des traits des pattes)
sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
ink = cv2.dilate((gray < 128).astype(np.uint8) * 255, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
white = cv2.bitwise_and(sil, cv2.bitwise_not(ink))
n, lab, stats, cent = cv2.connectedComponentsWithStats(white, connectivity=4)
ys, xs = np.where(sil > 0); sy0, sy1, sx0, sx1 = ys.min(), ys.max(), xs.min(), xs.max(); SH, SW = sy1 - sy0, sx1 - sx0; silArea = int((sil > 0).sum())
comps = []
for i in range(1, n):
    x, y, w, h, area = stats[i]
    if area < silArea * 0.001: continue
    comps.append(dict(id=i, x=int(x), y=int(y), w=int(w), h=int(h), area=int(area), bottom=(y + h - sy0) / SH, rel=area / silArea))
body_comp = max(comps, key=lambda c: c['area'])

# sabots : petites régions touchant le bas de la silhouette
hooves = [c for c in comps if c['bottom'] >= 0.95 and 0.002 <= c['rel'] <= 0.02 and c['h'] < 0.12 * SH and c['w'] < 0.2 * SW]
hooves.sort(key=lambda c: c['x'])
# pattes fermées : régions hautes, étroites, finissant vers le bas, posées sur un sabot
closed_legs = [c for c in comps if c is not body_comp and c not in hooves and 0.01 <= c['rel'] <= 0.08 and c['h'] > 0.15 * SH and c['w'] < 0.25 * SW and c['bottom'] >= 0.85]
def overlaps_x(a, b): return min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x']) > 0.4 * min(a['w'], b['w'])
def inside_point(mask):
    d = cv2.distanceTransform(mask, cv2.DIST_L2, 3); y, x = np.unravel_index(int(d.argmax()), d.shape); return {'x': int(x), 'y': int(y)}
print(f'silhouette {SW}×{SH}, {len(comps)} régions, {len(hooves)} sabots, {len(closed_legs)} pattes fermées', file=sys.stderr)

legs = []   # dict(kind, hoof, mask, seeds)
for hf in hooves:
    hoof_mask = (lab == hf['id']).astype(np.uint8) * 255
    # patte fermée posée sur ce sabot : masque de la patte dilaté (30 px) touchant largement le sabot, étroite et haute
    hoof_dil = cv2.dilate(hoof_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61)))   # franchit le trait du sabot (~15 px)
    match = [c for c in closed_legs if c['w'] < 2.0 * hf['w'] and c['h'] > 1.3 * c['w'] and int(((lab == c['id']) & (hoof_dil > 0)).sum()) > 200]
    if match:
        leg = max(match, key=lambda c: c['area']); leg_mask = (lab == leg['id']).astype(np.uint8) * 255
        seeds = [inside_point(leg_mask), inside_point(hoof_mask)]
        legs.append(dict(kind='near', hoof=hf, mask=cv2.bitwise_or(leg_mask, hoof_mask), seeds=seeds))
    else:
        # patte ouverte (arrière-plan) : croissance ligne par ligne vers le haut dans la région body, arrêt à l'élargissement du ventre
        bodymask = (lab == body_comp['id'])
        hoof_w = hf['w']; cx0, cx1 = hf['x'], hf['x'] + hf['w']; mask = hoof_mask.copy()
        y = hf['y'] - 1; prev = (cx0, cx1); started = False; rows = 0; prev_w = hoof_w; stop = ('limite de hauteur',)
        while y > hf['y'] - 0.7 * SH:
            row = bodymask[y]
            # runs blancs de la ligne
            idx = np.where(row)[0]
            if idx.size == 0: y -= 1; continue
            runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
            best = None
            for r in runs:
                r0, r1 = int(r[0]), int(r[-1]) + 1
                ov = min(r1, prev[1]) - max(r0, prev[0])
                if ov > 0 and (best is None or ov > best[2]): best = (r0, r1, ov)
            if best is None:
                if started: stop = ('aucun run chevauchant', y); break
                y -= 1; continue
            r0, r1, _ = best; width = r1 - r0
            if started and width > 1.7 * hoof_w: stop = ('largeur > 1.7 sabot', y, r0, r1); break
            # fin d'un trait latéral : une des bornes saute d'un coup (la patte débouche dans le corps) — l'occultation
            # progressive par la patte de devant, elle, ne déplace la borne que de quelques px par ligne
            if started and rows > 10 and (abs(r0 - prev[0]) > 30 or abs(r1 - prev[1]) > 30): stop = ('saut de borne', y, prev, (r0, r1)); break
            started = True; mask[y, r0:r1] = 255; prev = (r0, r1); prev_w = width; y -= 1; rows += 1
            if flags.get('debug-growth') and rows % 25 == 1: print(f'   y={y+1} run=({r0},{r1}) w={width}', file=sys.stderr)
        if flags.get('debug-growth'): print(f"patte ouverte (sabot x{hf['x']} w{hoof_w}) : {rows} lignes, arrêt {stop}", file=sys.stderr)
        legs.append(dict(kind='far', hoof=hf, mask=mask, seeds=[]))
if len(legs) < 2: sys.exit('moins de 2 pattes détectées — à regarder à la main')

# côté de la tête : masse haute de la silhouette (15 % du haut) à gauche ou à droite du centre
top = np.where(sil[sy0:sy0 + int(0.15 * SH)] > 0)[1]; faces_left = top.mean() < (sx0 + sx1) / 2
for L in legs: L['cx'] = L['hoof']['x'] + L['hoof']['w'] / 2
near = sorted([L for L in legs if L['kind'] == 'near'], key=lambda L: L['cx']); far = sorted([L for L in legs if L['kind'] == 'far'], key=lambda L: L['cx'])
def label_for(group, L, suffix):
    if len(group) == 1: return ('AV' if (L['cx'] < (sx0 + sx1) / 2) == faces_left else 'AR') + suffix
    front = group[0] if faces_left else group[-1]
    return ('AV' if L is front else 'AR') + suffix
for L in near: L['label'] = label_for(near, L, 'G'); L['zOrder'] = 2
for L in far: L['label'] = label_for(far, L, 'D'); L['zOrder'] = 0
# dédoublonnage des libellés (ex. 3 pattes près) : suffixe numérique
seen = {}
for L in legs:
    seen[L['label']] = seen.get(L['label'], 0) + 1
    if seen[L['label']] > 1: L['label'] += str(seen[L['label']])
# inflate (comme l'UI) : dilatation du masque par INFLATE px puis clamp à la silhouette, contour externe
# dilatation : patte fermée = INFLATE (franchit le trait + marge, comme l'UI) ; patte ouverte = juste le trait (son masque est déjà
# le blanc entre ses deux traits ; une dilatation plus forte mangerait le corps au-dessus de la jonction)
INFLATE_FAR = int(flags.get('inflate-far', max(8, round(max(W, H) / 128))))
def kern(r): return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
def ext_contour(mask):
    cs, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE); c = max(cs, key=cv2.contourArea); return [{'x': int(p[0][0]), 'y': int(p[0][1])} for p in c]
for L in legs:
    L['id'] = 'member-' + uuid.uuid4().hex[:8]; L['inflate'] = INFLATE if L['kind'] == 'near' else INFLATE_FAR
    L['mask'] = cv2.bitwise_and(cv2.dilate(L['mask'], kern(L['inflate'])), sil); L['contour'] = ext_contour(L['mask'])
legs_union = np.zeros_like(sil)
for L in legs: legs_union = cv2.bitwise_or(legs_union, L['mask'])
body_minus = cv2.bitwise_and(sil, cv2.bitwise_not(legs_union))
body_minus = cv2.morphologyEx(body_minus, cv2.MORPH_OPEN, kern(3))   # filaments ≤ 6 px (franges) supprimés
# Rubans fins résiduels entre deux traits de pattes voisines (fond opaque dans le PNG) : ils feraient « descendre » le contour du
# corps entre les pattes. Tout composant fin (demi-largeur ≤ 13 px, ≥ 80 px de long) touchant une patte est rattaché à cette
# patte (patte arrière-plan en priorité : c'est la zone de son trait).
opened = cv2.morphologyEx(body_minus, cv2.MORPH_OPEN, kern(15)); thin = cv2.bitwise_and(body_minus, cv2.bitwise_not(opened))
nt, lt, st, _ = cv2.connectedComponentsWithStats(thin, connectivity=8); moved = 0
for i in range(1, nt):
    x, y, w, h, area = st[i]
    if area < 50 or max(w, h) < 80: continue
    comp = (lt[y:y + h, x:x + w] == i).astype(np.uint8) * 255
    if cv2.distanceTransform(comp, cv2.DIST_L2, 3).max() > 13: continue
    ring = cv2.dilate(comp, kern(4)); touching = []
    for L in legs:
        if (np.logical_and(ring > 0, L['mask'][y:y + h, x:x + w] > 0)).any(): touching.append(L)
    if not touching: continue
    target = next((L for L in touching if L['kind'] == 'far'), touching[0])
    target['mask'][y:y + h, x:x + w] = cv2.bitwise_or(target['mask'][y:y + h, x:x + w], comp); body_minus[y:y + h, x:x + w] &= cv2.bitwise_not(comp); moved += 1
for L in legs: L['contour'] = ext_contour(L['mask'])
print(f'{moved} ruban(s) fin(s) rattaché(s) aux pattes', file=sys.stderr)
nb, lb, sb, _ = cv2.connectedComponentsWithStats(body_minus, connectivity=4); body_minus = (lb == (1 + int(np.argmax(sb[1:, 4])))).astype(np.uint8) * 255
body_raw = ext_contour(body_minus)
if abs(cv2.contourArea(np.array([[p['x'], p['y']] for p in body_raw], np.int32)) - (body_minus > 0).sum()) > 0.02 * silArea:
    sys.exit('les pattes ne traversent pas le contour (trous au lieu d\'encoches) : augmenter --inflate')
print('pattes :', [(L['label'], L['kind'], len(L['contour'])) for L in legs], '| tête à', 'gauche' if faces_left else 'droite', file=sys.stderr)

# ───────────────────────── 2. géométrie (module TypeScript de l'admin) ─────────────────────────
zones = [{'id': 'body', 'label': 'Body', 'color': '#22c55e', 'zOrder': 1, 'kind': 'body'}] + [{'id': L['id'], 'label': L['label'], 'color': COLORS.get(L['label'][:3], '#64748b'), 'zOrder': L['zOrder'], 'kind': L['kind']} for L in legs]
maxDim = max(W, H)
geom_in = {'w': W, 'h': H, 'zones': zones, 'raw': {'body': body_raw, **{L['id']: L['contour'] for L in legs}},
           'params': {'sigma': SIGMA, 'bridge': BRIDGE, 'anchors': {'body': 12, 'leg': 9}, 'subdivSpacing': maxDim / 18, 'density': {'body': 6, 'leg': 5}}}
json.dump(geom_in, open(f'{OUT}/geom-in.json', 'w'))
bundle = flags.get('bundle') or os.path.join(HERE, 'auto_triang_geom.bundle.mjs')
r = subprocess.run(['node', bundle, f'{OUT}/geom-in.json'], capture_output=True, text=True)
print(r.stderr, file=sys.stderr)
if r.returncode != 0: sys.exit('géométrie : échec')
G = json.loads(r.stdout); json.dump(G, open(f'{OUT}/geom-out.json', 'w'))

# ───────────────────────── 3. rendu de contrôle ─────────────────────────
dbg = flat.copy()
def hexc(hx): hx = hx.lstrip('#'); return (int(hx[4:6], 16), int(hx[2:4], 16), int(hx[0:2], 16))
for z in zones:
    col = hexc(z['color']); pts = G['zonePoints'][z['id']]
    for a, b, c in G['zoneTriangles'][z['id']]:
        tri = np.array([[pts[a]['x'], pts[a]['y']], [pts[b]['x'], pts[b]['y']], [pts[c]['x'], pts[c]['y']]], np.int32)
        cv2.polylines(dbg, [tri], True, col, 1, cv2.LINE_AA)
    for p in G['zoneAnchors'][z['id']]: cv2.circle(dbg, (int(p['x']), int(p['y'])), 9, col, -1)
    p0 = G['zoneOrigins'][z['id']]; cv2.circle(dbg, (int(p0['x']), int(p0['y'])), 14, (0, 0, 0), 2)
for hf in G['hiddenFaceZones']:
    for i in hf['bodyTriangleIndices']:
        a, b, c = G['bodyTriangles'][i]; pts = G['bodyPoints']
        cv2.fillPoly(dbg, [np.array([[pts[a]['x'], pts[a]['y']], [pts[b]['x'], pts[b]['y']], [pts[c]['x'], pts[c]['y']]], np.int32)], (200, 230, 255))
for hf in G['hiddenFaceLimbZones']:
    pts = G['zonePoints'][hf['limbZoneId']]
    for i in hf['zoneTriangleIndices']:
        a, b, c = G['zoneTriangles'][hf['limbZoneId']][i]
        cv2.fillPoly(dbg, [np.array([[pts[a]['x'], pts[a]['y']], [pts[b]['x'], pts[b]['y']], [pts[c]['x'], pts[c]['y']]], np.int32)], (255, 230, 200))
for L in legs:
    for s in L['seeds']: cv2.drawMarker(dbg, (s['x'], s['y']), (0, 0, 255), cv2.MARKER_CROSS, 30, 3)
    cv2.putText(dbg, L['label'], (int(L['cx']) - 30, min(H - 10, L['hoof']['y'] + L['hoof']['h'] + 40)), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 3)
cv2.imwrite(f'{OUT}/controle.png', dbg)
print('rendu de contrôle :', f'{OUT}/controle.png', file=sys.stderr)
if DRY: sys.exit(0)

# ───────────────────────── 4. Firestore + Storage ─────────────────────────
def encode_rle(mask):
    col = (mask.T > 0).astype(np.uint8).ravel()   # column-major
    d = np.diff(col); idx = np.where(d != 0)[0] + 1; bounds = np.concatenate([[0], idx, [col.size]])
    counts = np.diff(bounds).tolist()
    if col[0] != 0: counts = [0] + counts
    return {'size': [int(mask.shape[0]), int(mask.shape[1])], 'counts': [int(c) for c in counts]}
masks = {}
for z in zones:
    poly = np.array([[p['x'], p['y']] for p in G['contours'][z['id']]], np.int32); m = np.zeros((H, W), np.uint8); cv2.fillPoly(m, [poly], 255); masks[z['id']] = [encode_rle(m)]
TOKEN = subprocess.run(['gcloud', 'auth', 'print-access-token', '--account=nicolas.rocher38@gmail.com'], capture_output=True, text=True).stdout.strip() or sys.exit('jeton gcloud introuvable')
BUCKET = 'picopop-app.firebasestorage.app'; FS = 'https://firestore.googleapis.com/v1/projects/picopop-app/databases/coloriages/documents'
def http(method, url, body=None, ctype=None):
    h = {'Authorization': 'Bearer ' + TOKEN}
    if ctype: h['Content-Type'] = ctype
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h, method=method), timeout=300) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def upload(path, data, ctype):
    b = 'picopop' + uuid.uuid4().hex
    md = {'name': path, 'contentType': ctype, 'cacheControl': 'public, max-age=31536000, immutable', 'metadata': {'firebaseStorageDownloadTokens': str(uuid.uuid4())}}
    body = (f'--{b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'.encode() + json.dumps(md).encode() + f'\r\n--{b}\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + f'\r\n--{b}--\r\n'.encode())
    s, raw = http('POST', f'https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=multipart', body, f'multipart/related; boundary={b}')
    if s != 200: sys.exit(f'upload {path} HTTP {s} {raw[:300]!r}')
def to_value(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [to_value(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: to_value(x) for k, x in v.items()}}}
    raise TypeError(type(v))
tris = lambda T: [{'a': a, 'b': b, 'c': c} for a, b, c in T]
pid = flags.get('project') or str(uuid.uuid4()); now = int(time.time() * 1000)
zones_doc = [{k: z[k] for k in ('id', 'label', 'color', 'zOrder')} for z in zones]
tri = {
    'hasReferenceImage': True, 'zones': zones_doc, 'prompts': [], 'hasMasksRLE': True, 'maskWidth': W, 'maskHeight': H, 'hasContours': True,
    'contourSmoothSigma': SIGMA, 'bridgeThreshold': BRIDGE, 'step1Validated': True, 'segmentationMode': 'canny',
    'cannyParams': {'lowThreshold': 50, 'highThreshold': 150, 'blurSize': 5},
    'zoneSeeds': {L['id']: L['seeds'] for L in legs if L['seeds']}, 'zoneInflates': {L['id']: L['inflate'] for L in legs}, 'zoneBeziers': G['zoneBeziers'],
    'zoneOrigins': G['zoneOrigins'], 'zoneOriginsValidated': G['zoneOriginsValidated'], 'zoneAnchors': G['zoneAnchors'], 'zoneAnchorsValidated': G['zoneAnchorsValidated'],
    'zoneSubdivisionPoints': G['zoneSubdivisionPoints'], 'zoneSubdivisionParams': G['zoneSubdivisionParams'], 'zoneSubdivisionValidated': G['zoneSubdivisionValidated'],
    'zoneContourLength': G['zoneContourLength'], 'zoneContourCount': {}, 'zoneContourPoints': {}, 'zoneContourValidated': {},
    'zonePoints': G['zonePoints'], 'zoneTriangles': {k: tris(v) for k, v in G['zoneTriangles'].items()}, 'zoneDensity': G['zoneDensity'],
    'bodyPoints': G['bodyPoints'], 'bodyTriangles': tris(G['bodyTriangles']),
    'bodyPointsBaseline': G['bodyPointsBaseline'], 'bodyTrianglesBaseline': tris(G['bodyTrianglesBaseline']),
    'zonePointsBaseline': G['zonePointsBaseline'], 'zoneTrianglesBaseline': {k: tris(v) for k, v in G['zoneTrianglesBaseline'].items()},
    'step2Validated': True, 'hiddenFaceZones': G['hiddenFaceZones'], 'hiddenFaceLimbZones': G['hiddenFaceLimbZones'], 'step3Validated': True,
}
doc = {'id': pid, 'name': NAME, 'createdAt': now, 'hasImage': True, 'hasBackgroundVideo': False, 'hasAmbientSound': False, 'ambientSoundEnabled': False,
       'animations': [], 'markers': None, 'scene': None, 'projectTriangulation': tri, 'published': False, 'publishedAt': None, 'bookId': None, 'bookOrder': now, 'hasThumbnail': False}
png = cv2.imencode('.png', flat)[1].tobytes()
upload(f'projects/{pid}/originalImage', png, 'image/png'); upload(f'projects/{pid}/triangulation/referenceImage', png, 'image/png')
upload(f'projects/{pid}/triangulation/masksRLE.json', json.dumps(masks).encode(), 'application/json')
upload(f'projects/{pid}/triangulation/contours.json', json.dumps(G['contours']).encode(), 'application/json')
body = json.dumps({'fields': {k: to_value(v) for k, v in doc.items()}}).encode()
s, raw = http('PATCH', f'{FS}/projects/{pid}', body, 'application/json')
if s != 200: sys.exit(f'Firestore HTTP {s} {raw[:500]!r}')
print(f'projet créé : {pid} — https://coloriage-anime-admin.vercel.app/admin/{pid}', file=sys.stderr)
