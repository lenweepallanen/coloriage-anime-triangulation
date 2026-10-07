#!/usr/bin/env python3
"""Aligne les COLORIAGES (originalImage) et VIGNETTES (thumbnail) des coloriages du livre FR sur ceux du livre US :
copie serveur Storage projects/{US}/… → projects/{FR}/… avec un NOUVEAU jeton de téléchargement (cache immuable 1 an),
après vérification que les dimensions de l'image sont identiques (la triangulation FR est en pixels de cette image).

  python3 sync_images_fr.py [--dry-run]
"""
import io, json, subprocess, sys, urllib.request, urllib.error, urllib.parse, uuid
from PIL import Image
DRY = '--dry-run' in sys.argv
PAIRS = [  # (nom, US, FR) — même ordre que les livres
    ('T-Rex', '3b989146-6473-48e1-ad0a-ba57aa7b7514', '815018c9-bf87-5254-bc38-547dab41afa7'),
    ('Ptéranodon', '298079e4-d31e-48f9-b1f5-6d6bca0aa533', 'f63cf82a-81c3-5eeb-b4f7-fc002b964478'),
    ('Plésiosaure', '9f94477c-ae6b-40b3-b5c0-1f57a09a9280', '62b3f16b-aec5-595d-80f4-ac5b8984dd83'),
    ('Tricératops', 'ef7201a8-3106-4698-8752-f672c5ad023b', '828d3e56-3a7a-511c-8527-6a69d9038572'),
    ('Brachiosaure', 'faa6845e-8db4-4acc-b42b-cc42085b3bea', '0d414bb1-4064-555e-bd31-be8009cef631'),
    ('Ankylosaure', '90236c66-0867-4de9-920f-a0b9145c0c4a', '1c8ba61a-74fe-502e-b1fa-32f4fbc523ec'),
    ('Spinosaure', '65a493b4-073f-4081-9553-52dc9c87f539', '633c1f1b-1e40-5741-b7fc-73fc0948d328'),
    ('Vélociraptor', '74870f36-4752-4d9f-933c-351d1ceeb12d', '3e049b98-07a7-54ca-a92b-4a68a78eb9e5'),
    ('Dilophosaure', '34ff7594-a94b-45c0-8e24-ddfef25ec828', '1c8bf928-bb61-5cbd-a7b9-0538b92c1a23'),
    ('Stégosaure', '35288b82-bb86-4be5-aaec-f0482a20fe04', '0e89a929-d96b-5845-8af1-03be4c2c4e21'),
]
TOKEN = subprocess.run(['gcloud', 'auth', 'print-access-token', '--account=nicolas.rocher38@gmail.com'], capture_output=True, text=True).stdout.strip() or sys.exit('jeton gcloud introuvable')
BUCKET = 'picopop-app.firebasestorage.app'
STO = f'https://storage.googleapis.com/storage/v1/b/{BUCKET}/o/'
FS = 'https://firestore.googleapis.com/v1/projects/picopop-app/databases/coloriages/documents'


def http(method, url, body=None, ctype=None):
    h = {'Authorization': 'Bearer ' + TOKEN}
    if ctype: h['Content-Type'] = ctype
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h, method=method), timeout=300) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


def meta(path):
    s, raw = http('GET', STO + urllib.parse.quote(path, safe='')); return json.loads(raw) if s == 200 else None


def size(path):
    s, raw = http('GET', STO + urllib.parse.quote(path, safe='') + '?alt=media'); return Image.open(io.BytesIO(raw)).size if s == 200 else None


def copy(src, dst):
    s, raw = http('POST', STO + urllib.parse.quote(src, safe='') + '/rewriteTo/b/' + BUCKET + '/o/' + urllib.parse.quote(dst, safe=''), b'{}', 'application/json')
    if s != 200: sys.exit(f'copie {src} HTTP {s} {raw[:300]!r}')
    s, raw = http('PATCH', STO + urllib.parse.quote(dst, safe=''), json.dumps({'metadata': {'firebaseStorageDownloadTokens': str(uuid.uuid4())}, 'cacheControl': 'public, max-age=31536000, immutable'}).encode(), 'application/json')
    if s != 200: sys.exit(f'jeton {dst} HTTP {s} {raw[:300]!r}')


def fs_get(pid, *fields):
    s, raw = http('GET', f'{FS}/projects/{pid}?' + '&'.join(f'mask.fieldPaths={f}' for f in fields)); return json.loads(raw).get('fields', {}) if s == 200 else {}


for name, us, fr in PAIRS:
    mu, mf = meta(f'projects/{us}/originalImage'), meta(f'projects/{fr}/originalImage')
    tu, tf = meta(f'projects/{us}/thumbnail'), meta(f'projects/{fr}/thumbnail')
    if not mu or not tu: sys.exit(f'{name} : image ou vignette US absente')
    su, sf = size(f'projects/{us}/originalImage'), size(f'projects/{fr}/originalImage') if mf else None
    if sf and su != sf: sys.exit(f'{name} : dimensions différentes US {su} / FR {sf} — arrêt')
    same_img = mf and mf.get('md5Hash') == mu.get('md5Hash'); same_th = tf and tf.get('md5Hash') == tu.get('md5Hash')
    print(f"{name}: image {su} {'identique' if same_img else 'à copier'} | vignette {'identique' if same_th else 'à copier'}", flush=True)
    if DRY: continue
    if not same_img: copy(f'projects/{us}/originalImage', f'projects/{fr}/originalImage')
    if not same_th: copy(f'projects/{us}/thumbnail', f'projects/{fr}/thumbnail')
    f = fs_get(fr, 'hasImage', 'hasThumbnail', 'imageWidth', 'imageHeight')
    if not f.get('hasThumbnail', {}).get('booleanValue'):
        q = 'updateMask.fieldPaths=hasThumbnail'; s, raw = http('PATCH', f'{FS}/projects/{fr}?{q}', json.dumps({'fields': {'hasThumbnail': {'booleanValue': True}}}).encode(), 'application/json')
        print('   hasThumbnail → true', s)
print('terminé')
