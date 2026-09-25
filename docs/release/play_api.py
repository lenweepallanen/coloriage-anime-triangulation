#!/usr/bin/env python3
"""Client minimal Google Play Developer API (bibliothèque standard + openssl CLI).

Identifiants lus dans ~/.picopop-keys.env (hors dépôt) :
  PLAY_SERVICE_ACCOUNT_FILE (clé JSON du compte de service), PLAY_PACKAGE

Usage :
  python3 play_api.py status        # pistes (production/internal…) et leurs versions (lecture seule)
"""
import base64, json, os, subprocess, sys, tempfile, time, urllib.parse, urllib.request, urllib.error

ENV = os.path.expanduser('~/.picopop-keys.env')
SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'


def load_env():
    env = {}
    for line in open(ENV):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1); env[k.strip()] = v.strip()
    for k in ('PLAY_SERVICE_ACCOUNT_FILE', 'PLAY_PACKAGE'):
        if k not in env: sys.exit(f'{k} manquant dans {ENV}')
    return env


def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


_token, _exp = None, 0


def token():
    global _token, _exp
    if _token and time.time() < _exp - 60: return _token
    env = load_env()
    sa = json.load(open(os.path.expanduser(env['PLAY_SERVICE_ACCOUNT_FILE'])))
    now = int(time.time())
    header = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}).encode())
    payload = b64url(json.dumps({'iss': sa['client_email'], 'scope': SCOPE, 'aud': sa['token_uri'], 'iat': now, 'exp': now + 3600}).encode())
    signing = f'{header}.{payload}'.encode()
    with tempfile.NamedTemporaryFile(delete=False) as k, tempfile.NamedTemporaryFile(delete=False) as d:
        k.write(sa['private_key'].encode()); d.write(signing); kp, dp = k.name, d.name
    try:
        sig = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', kp, dp], capture_output=True, check=True).stdout
    finally:
        os.unlink(kp); os.unlink(dp)
    assertion = f'{header}.{payload}.{b64url(sig)}'
    body = urllib.parse.urlencode({'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'assertion': assertion}).encode()
    with urllib.request.urlopen(urllib.request.Request(sa['token_uri'], data=body, method='POST')) as r:
        t = json.loads(r.read())
    _token, _exp = t['access_token'], now + int(t.get('expires_in', 3600))
    return _token


def request(method, path, body=None, raw=None, content_type='application/json'):
    env = load_env()
    url = f"{BASE}/{env['PLAY_PACKAGE']}{path}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + token(), 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            out = r.read(); return r.status, (json.loads(out) if out else {})
    except urllib.error.HTTPError as e:
        out = e.read()
        try: return e.code, json.loads(out)
        except ValueError: return e.code, {'raw': out[:500].decode(errors='replace')}


def status():
    s, edit = request('POST', '/edits', {})
    if s != 200: sys.exit(f'création edit → HTTP {s} : {json.dumps(edit)[:600]}')
    eid = edit['id']
    try:
        s, tracks = request('GET', f'/edits/{eid}/tracks')
        if s != 200: sys.exit(f'tracks → HTTP {s} : {json.dumps(tracks)[:600]}')
        print(f"paquet {load_env()['PLAY_PACKAGE']} — pistes :")
        for t in tracks.get('tracks', []):
            for r in t.get('releases', []) or [{}]:
                vc = ','.join(r.get('versionCodes', [])) or '—'
                print(f"  {t['track']:12} {r.get('status', '(vide)'):12} versionCode {vc:6} {r.get('name', '')}")
    finally:
        request('DELETE', f'/edits/{eid}')  # edit transitoire, jamais validé


if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] != 'status': print(__doc__); sys.exit(1)
    status()
