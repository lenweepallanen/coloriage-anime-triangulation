#!/usr/bin/env python3
"""Multiplie le volume des clips PARLÉS (voix, bruitages « sfx » exclus) du film d'un ou plusieurs coloriages.
  python3 film_voices_volume.py <facteur> <projectId…> [--dry-run]     ex. 1.2 = +20 %
Sauvegarde de l'ancien filmT dans ./_voices_backup/<id>.<date>.volume.json. Plafond 3 (300 %)."""
import json, os, subprocess, sys, time, urllib.request, urllib.error, urllib.parse
HERE = os.path.dirname(os.path.abspath(__file__)); DRY = '--dry-run' in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith('--')]; factor = float(args[0]); ids = args[1:]
TOKEN = subprocess.run(['gcloud', 'auth', 'print-access-token', '--account=nicolas.rocher38@gmail.com'], capture_output=True, text=True).stdout.strip() or sys.exit('jeton gcloud introuvable')
BASE = 'https://firestore.googleapis.com/v1/projects/picopop-app/databases/coloriages/documents'
def http(method, url, body=None):
    h = {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h, method=method), timeout=120) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def to_value(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [to_value(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: to_value(x) for k, x in v.items()}}}
    raise TypeError(type(v))
def from_value(v):
    for k in ('stringValue', 'booleanValue', 'doubleValue', 'nullValue'):
        if k in v: return v[k]
    if 'integerValue' in v: return int(v['integerValue'])
    if 'mapValue' in v: return {k: from_value(x) for k, x in (v['mapValue'].get('fields') or {}).items()}
    if 'arrayValue' in v: return [from_value(x) for x in (v['arrayValue'].get('values') or [])]
    return v
for pid in ids:
    s, raw = http('GET', f'{BASE}/projects/{pid}?mask.fieldPaths=name&mask.fieldPaths=filmT')
    if s != 200: sys.exit(f'{pid} HTTP {s}')
    f = {k: from_value(v) for k, v in json.loads(raw)['fields'].items()}; film = f['filmT']
    lib = {x['id']: x['name'] for x in film.get('sounds', [])}
    os.makedirs(f'{HERE}/_voices_backup', exist_ok=True); json.dump(film, open(f"{HERE}/_voices_backup/{pid}.{time.strftime('%Y%m%d-%H%M%S')}.volume.json", 'w'))
    changes = []
    tracks = [c for p in film['plans'] for t in (p.get('soundTracks') or []) for c in t.get('clips', [])] + [c for t in (film.get('globalSoundTracks') or []) for c in t.get('clips', [])]
    for c in tracks:
        if c.get('isSpoken') and 'sfx' not in lib.get(c['soundId'], '').lower():
            old = float(c.get('volume', 1)); new = round(min(3.0, old * factor), 3); c['volume'] = new; changes.append((old, new))
    print(f"{f['name']}: {len(changes)} clip(s) parlé(s) " + ', '.join(f'{o:g}→{n:g}' for o, n in changes))
    if DRY: continue
    s, raw = http('PATCH', f'{BASE}/projects/{pid}?updateMask.fieldPaths=filmT', json.dumps({'fields': {'filmT': to_value(film)}}).encode())
    if s != 200: sys.exit(f'écriture {pid} HTTP {s} {raw[:300]!r}')
print('terminé' + (' (simulation)' if DRY else ''))
