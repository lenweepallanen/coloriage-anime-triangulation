"""Jeton admin de test : custom token (compte de service Play, uid admin) → ID token Firebase. Régénéré si > 50 min."""
import json, os, re, time, base64, subprocess, tempfile, urllib.request
S = os.path.expanduser('~/.picopop-keys/admin-test')
ADMIN = '/Users/nicolasrocher/Documents/claude code projects/PicoPop/apps/admin'
_src = open(f'{ADMIN}/src/db/firebase.ts').read()
API_KEY = re.search(r'apiKey:\s*"([^"]+)"', _src).group(1)
BUCKET = re.search(r'storageBucket:\s*"([^"]+)"', _src).group(1)
PROJECT = 'picopop-app'; DB = 'coloriages'
def _env():
    for line in open(os.path.expanduser('~/.picopop-keys.env')):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1); os.environ.setdefault(k.replace('export ', '').strip(), v.strip().strip('"'))
def custom_token():
    p = f'{S}/custom-token.txt'
    if os.path.exists(p) and time.time() - os.path.getmtime(p) < 50 * 60: return open(p).read().strip()
    _env(); sa = json.load(open(os.path.expanduser(os.environ['PLAY_SERVICE_ACCOUNT_FILE'])))
    old = open(p).read().strip().split('.')[1]; old += '=' * (-len(old) % 4); uid = json.loads(base64.urlsafe_b64decode(old))['uid']
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode(); now = int(time.time())
    hdr = b64(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    pl = b64(json.dumps({'iss': sa['client_email'], 'sub': sa['client_email'], 'aud': 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit', 'iat': now, 'exp': now + 3600, 'uid': uid}).encode())
    with tempfile.NamedTemporaryFile('w', suffix='.pem', delete=False) as f: f.write(sa['private_key']); kp = f.name
    sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', kp], input=f'{hdr}.{pl}'.encode(), capture_output=True, check=True).stdout; os.unlink(kp)
    tok = f'{hdr}.{pl}.{b64(sig)}'; open(p, 'w').write(tok); return tok
def id_token():
    r = urllib.request.Request(f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={API_KEY}', data=json.dumps({'token': custom_token(), 'returnSecureToken': True}).encode(), headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(r))['idToken']
def fs_get(path, mask=None):
    """Lecture d'un document Firestore (REST). path ex. 'projects/<id>'."""
    q = ('?' + '&'.join(f'mask.fieldPaths={m}' for m in mask)) if mask else ''
    req = urllib.request.Request(f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/{DB}/documents/{path}{q}', headers={'Authorization': 'Bearer ' + id_token()})
    return json.load(urllib.request.urlopen(req))
def storage_download(path, dest):
    import urllib.parse
    req = urllib.request.Request(f'https://firebasestorage.googleapis.com/v0/b/{BUCKET}/o/{urllib.parse.quote(path, safe="")}?alt=media', headers={'Authorization': 'Bearer ' + id_token()})
    data = urllib.request.urlopen(req).read(); open(dest, 'wb').write(data); return len(data)
if __name__ == '__main__':
    print('custom token OK, id token', id_token()[:12] + '…')

# ── Conversion Firestore REST ⇄ Python ───────────────────────────────────────
def to_fs(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [to_fs(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: to_fs(x) for k, x in v.items()}}}
    raise TypeError(type(v))
def from_fs(v):
    if 'nullValue' in v: return None
    if 'booleanValue' in v: return v['booleanValue']
    if 'integerValue' in v: return int(v['integerValue'])
    if 'doubleValue' in v: return v['doubleValue']
    if 'stringValue' in v: return v['stringValue']
    if 'timestampValue' in v: return v['timestampValue']
    if 'arrayValue' in v: return [from_fs(x) for x in v['arrayValue'].get('values', [])]
    if 'mapValue' in v: return {k: from_fs(x) for k, x in v['mapValue'].get('fields', {}).items()}
    raise TypeError(list(v.keys()))
def fs_patch(path, fields: dict):
    """Écrit les champs donnés (updateMask = leurs noms) ; fields = dict Python."""
    masks = '&'.join(f'updateMask.fieldPaths={k}' for k in fields)
    body = {'fields': {k: to_fs(v) for k, v in fields.items()}}
    req = urllib.request.Request(f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/{DB}/documents/{path}?{masks}', data=json.dumps(body).encode(), method='PATCH', headers={'Authorization': 'Bearer ' + id_token(), 'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))
def set_animation_mesh(pid, anim_name, patch: dict, anim_patch: dict = None):
    """Fusionne `patch` dans mesh de l'animation nommée (+ champs animation), réécrit le tableau animations."""
    d = fs_get(f'projects/{pid}', mask=['animations'])
    anims = from_fs(d['fields']['animations'])
    hit = [a for a in anims if a.get('name') == anim_name]
    assert len(hit) == 1, f'animation {anim_name!r} : {len(hit)} trouvée(s)'
    a = hit[0]; a['mesh'] = {**(a.get('mesh') or {}), **patch}
    if anim_patch: a.update(anim_patch)
    fs_patch(f'projects/{pid}', {'animations': anims}); return a
