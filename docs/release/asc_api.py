#!/usr/bin/env python3
"""Client minimal App Store Connect API (bibliothèque standard + openssl CLI).

Identifiants lus dans ~/.picopop-keys.env (hors dépôt) :
  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE (chemin du .p8)

Usage :
  python3 asc_api.py status            # app, dernières versions + builds (lecture seule)
  python3 asc_api.py get <path> [k=v…] # GET brut, ex. get /v1/apps limit=5
"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.parse, urllib.request, urllib.error

ENV = os.path.expanduser('~/.picopop-keys.env')
BUNDLE_ID = 'app.picopop.mobile'
BASE = 'https://api.appstoreconnect.apple.com'


def load_env():
    env = {}
    for line in open(ENV):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    for k in ('ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_FILE'):
        if k not in env: sys.exit(f'{k} manquant dans {ENV}')
    return env


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def der_to_raw(sig):
    """Signature ECDSA DER → r||s (32 octets chacun), format JWS."""
    assert sig[0] == 0x30
    i = 2
    assert sig[i] == 0x02; l = sig[i + 1]; r = sig[i + 2:i + 2 + l]; i += 2 + l
    assert sig[i] == 0x02; l = sig[i + 1]; s = sig[i + 2:i + 2 + l]
    return r[-32:].rjust(32, b'\0') + s[-32:].rjust(32, b'\0')


_token = None
_token_exp = 0


def token():
    global _token, _token_exp
    if _token and time.time() < _token_exp - 60: return _token
    env = load_env()
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'ES256', 'kid': env['ASC_KEY_ID'], 'typ': 'JWT'}).encode())
    payload = b64url(json.dumps({'iss': env['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 15 * 60, 'aud': 'appstoreconnect-v1'}).encode())
    signing = f'{header}.{payload}'.encode()
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(signing); path = f.name
    try:
        der = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', os.path.expanduser(env['ASC_KEY_FILE']), path],
                             capture_output=True, check=True).stdout
    finally:
        os.unlink(path)
    _token = f'{header}.{payload}.{b64url(der_to_raw(der))}'
    _token_exp = now + 15 * 60
    return _token


def request(method, path, params=None, body=None):
    url = BASE + path + (('?' + urllib.parse.urlencode(params)) if params else '')
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except ValueError: return e.code, {'raw': raw[:500].decode(errors='replace')}


def get(path, **params):
    s, d = request('GET', path, params)
    if s != 200: sys.exit(f'GET {path} → HTTP {s} : {json.dumps(d)[:600]}')
    return d


def app_id():
    d = get('/v1/apps', **{'filter[bundleId]': BUNDLE_ID, 'fields[apps]': 'name,bundleId'})
    if not d['data']: sys.exit(f'app {BUNDLE_ID} introuvable')
    return d['data'][0]['id'], d['data'][0]['attributes']['name']


def status():
    aid, name = app_id()
    print(f'app « {name} » id {aid}')
    v = get(f'/v1/apps/{aid}/appStoreVersions', **{'fields[appStoreVersions]': 'versionString,appStoreState,platform,createdDate', 'limit': 5})
    print('versions App Store :')
    for x in v['data']:
        a = x['attributes']
        print(f"  {a['versionString']:8} {a['appStoreState']:28} {a['platform']}  créée {a['createdDate'][:10]}  id {x['id']}")
    b = get('/v1/builds', **{'filter[app]': aid, 'sort': '-uploadedDate', 'limit': 5,
                              'fields[builds]': 'version,uploadedDate,processingState,expired,preReleaseVersion',
                              'include': 'preReleaseVersion', 'fields[preReleaseVersions]': 'version'})
    pre = {i['id']: i['attributes']['version'] for i in b.get('included', []) if i['type'] == 'preReleaseVersions'}
    print('builds :')
    for x in b['data']:
        a = x['attributes']
        pv = x.get('relationships', {}).get('preReleaseVersion', {}).get('data') or {}
        print(f"  {pre.get(pv.get('id'), '?'):8} ({a['version']})  {a['processingState']:10}  envoyé {a['uploadedDate'][:16]}  {'EXPIRÉ' if a['expired'] else ''}")


if __name__ == '__main__':
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    if sys.argv[1] == 'status': status()
    elif sys.argv[1] == 'get':
        params = dict(a.split('=', 1) for a in sys.argv[3:])
        print(json.dumps(get(sys.argv[2], **params), indent=1, ensure_ascii=False)[:6000])
    else: print(__doc__); sys.exit(1)
