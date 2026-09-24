"""Résumé lisible d'un FilmT (doc Firestore aplati) + téléchargement des assets (décors,
sons, musique) + durées ffprobe. Usage : python3 summarize.py <id> <slug>"""
import json, os, sys, subprocess, urllib.request, urllib.parse
ID, SLUG = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
p = json.load(open(os.path.join(HERE, f'{ID}.plain.json')))
ft = p['filmT']
BUCKET = 'picopop-app.firebasestorage.app'
ADIR = os.path.join(HERE, SLUG); os.makedirs(ADIR, exist_ok=True)

def dl(path, out):
    if os.path.exists(out) and os.path.getsize(out) > 0: return True
    url = f'https://firebasestorage.googleapis.com/v0/b/{BUCKET}/o/{urllib.parse.quote(path, safe="")}?alt=media'
    try:
        urllib.request.urlretrieve(url, out); return True
    except Exception as e:
        print('  DL FAIL', path, e); return False

def probe(f):
    try:
        o = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', f], capture_output=True, text=True).stdout
        j = json.loads(o); d = float(j['format']['duration'])
        v = next((s for s in j['streams'] if s['codec_type'] == 'video'), None)
        return d, (f"{v['width']}×{v['height']}" if v else '')
    except Exception: return None, ''

def n(v, d=0):
    try: return float(v)
    except Exception: return d

s = lambda ms: f'{n(ms)/1000:.1f}s'
out = []
out.append(f"# {p['name']} — film ({len(ft['plans'])} plans)\n")
ch = ft['character']
out.append(f"Personnage : facing {ch.get('facing')}, scale {ch.get('scale')}, origine ({n(ch.get('originU')):.2f}, {n(ch.get('originV')):.2f}) · moveSpeed {ft.get('moveSpeedPxPerSec')} · intro {ft.get('intro')} · outro {ft.get('outro')} · poster {s(ft.get('posterMs'))} · footsteps {ft.get('footstepsEnabled', 'défaut')} ×{ft.get('footstepsVolume', 1)}")
anims = {a['id']: a for a in p.get('animations', [])}
out.append('Animations : ' + ', '.join(f"{a.get('name')} [{a.get('type')}, {len(a.get('mesh', {}).get('footstepFrames', []) or [])} pas]" for a in anims.values()))
# sons
sounds = {x['id']: x for x in ft.get('sounds', [])}
sdur = {}
for sid, x in sounds.items():
    f = os.path.join(ADIR, f"sound-{sid[:8]}-{x.get('name', 'son')}")
    if dl(f"projects/{ID}/film/sounds/{sid}", f):
        sdur[sid] = probe(f)[0]
mus = ft.get('music')
if mus:
    f = os.path.join(ADIR, f"music-{mus.get('name', 'music')}")
    if dl(f"projects/{ID}/film/sounds/{mus['id']}", f): out.append(f"Musique : {mus.get('name')} ({probe(f)[0]:.1f}s, volume {mus.get('volume', 1)})")
out.append('\nBibliothèque sons : ' + ', '.join(f"{x.get('name')} ({(sdur.get(sid) or 0):.1f}s)" for sid, x in sounds.items()))
gst = ft.get('globalSoundTracks')
if gst: out.append('Pistes globales : ' + json.dumps(gst, ensure_ascii=False)[:600])

total = 0
for i, pl in enumerate(ft['plans']):
    dur = n(pl.get('durationMs')); total += dur
    bd = pl.get('backdrop') or {}
    bfile = ''
    if bd:
        ext = 'mp4' if bd.get('hasVideo') else 'jpg'
        f = os.path.join(ADIR, f"plan{i+1}-backdrop.{ext}")
        if dl(f"projects/{ID}/film/plans/{pl['id']}/backdrop", f):
            d, wh = probe(f); bfile = f" · fichier {d:.1f}s {wh}" if d else ''
    tr = pl.get('transitionToNext') or {}
    out.append(f"\n## Plan {i+1} « {pl.get('name', '')} » — {s(dur)} · décor {'vidéo' if bd.get('hasVideo') else 'image'} {bd.get('width')}×{bd.get('height')}{bfile} · cameraX {pl.get('cameraX')} · overlay {'oui' if pl.get('overlay') else 'non'} · transition → {tr.get('kind', 'cut')} {tr.get('durationMs', '')}ms {tr.get('color', '')}")
    wps = {w['id']: w for w in pl.get('waypoints', [])}
    out.append('Waypoints : ' + ', '.join(f"{k[:4]}({n(w['x']):.0f},{n(w['y']):.0f} ×{n(w.get('scale'),1):.2f}{' '+w['facing'] if w.get('facing') else ''})" for k, w in wps.items()))
    def ref(r):
        if not r: return '∅'
        if r.get('kind') == 'waypoint': w = wps.get(r['id']); return f"WP({n(w['x']):.0f},{n(w['y']):.0f})" if w else 'WP?'
        if r.get('kind') == 'offscreen': return f"hors-champ {r['side']}"
        return f"libre({n(r.get('x')):.0f},{n(r.get('y')):.0f})"
    rows = []
    for m in pl.get('motion', []):
        rows.append((n(m['startMs']), 'MOTION', f"{m['kind']} {ref(m.get('from'))} → {ref(m.get('to'))} {s(m['startMs'])}→{s(n(m['startMs'])+n(m['durationMs']))} anim={anims.get(m.get('animationId'), {}).get('name', m.get('animationId', 'défaut'))} ×{m.get('animSpeedMul', 1)} easing={m.get('easing', '')} CP={len(m.get('controlPoints') or [])}"))
    for a in pl.get('anim', []):
        rows.append((n(a['startMs']), 'ANIM', f"{anims.get(a['animationId'], {}).get('name', '?')} {a['fillMode']} ×{a.get('speedMul', 1)} {s(a['startMs'])}→{s(n(a['startMs'])+n(a['durationMs']))}"))
    for c in pl.get('camera', []) or []:
        extra = ''
        if c['kind'] == 'zoom': r = c.get('rect') or {}; extra = f"rect({n(r.get('x')):.0f},{n(r.get('y')):.0f},{n(r.get('w')):.0f}×{n(r.get('h')):.0f}) in {c.get('zoomInMs')} hold {c.get('holdMs')} out {c.get('zoomOutMs')}"
        elif c['kind'] in ('shake', 'rumble', 'bob'): extra = f"amp {c.get('amplitude')} {c.get('frequencyHz')}Hz {c.get('decay', '')} {'rot' if c.get('rotate') else ''}"
        rows.append((n(c['startMs']), 'CAMÉRA', f"{c['kind']} {s(c['startMs'])}→{s(n(c['startMs'])+n(c['durationMs']))} {extra}{' ⚓' if c.get('anchor') else ''}"))
    for ti, track in enumerate(pl.get('soundTracks', []) or []):
        for cl in track.get('clips', []) if isinstance(track, dict) else track:
            sd = sounds.get(cl['soundId'], {})
            rows.append((n(cl['startMs']), f'SON{ti+1}', f"{sd.get('name', '?')} {s(cl['startMs'])}→{s(n(cl['startMs'])+n(cl['durationMs']))} vol {cl.get('volume', 1)} rate {cl.get('rate', 1)}{' PARLÉ' if cl.get('isSpoken') else ''}{' loop' if cl.get('loop') else ''}{' offset '+s(cl['offsetMs']) if cl.get('offsetMs') else ''}{' fade '+str(cl.get('fadeInMs'))+'/'+str(cl.get('fadeOutMs')) if cl.get('fadeInMs') or cl.get('fadeOutMs') else ''}{' ⚓' if cl.get('anchor') else ''}"))
    for t, kind, txt in sorted(rows, key=lambda r: (r[0], r[1])):
        out.append(f"  {s(t):>6} {kind:7} {txt}")
out.append(f"\nDurée totale des plans : {total/1000:.1f}s (+ intro/outro)")
txt = '\n'.join(out)
open(os.path.join(HERE, f'{SLUG}-summary.md'), 'w').write(txt)
print(txt)
