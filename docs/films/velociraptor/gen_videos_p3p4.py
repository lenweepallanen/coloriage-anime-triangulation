#!/usr/bin/env python3
"""Vidéos des plans 3 et 4 du Vélociraptor (même T-Rex, même orage) — xAI grok-imagine-video-1.5, image-to-video.
Générées par l'API (et non à la main dans Grok Imagine) pour garantir la cohérence du T-Rex entre les deux plans :
les deux images de départ le montrent déjà (P4 généré avec P3 en référence).
Usage : python3 gen_videos_p3p4.py [plans=P3,P4]   → videos/P3.mp4, videos/P4.mp4 (+ .json)
"""
import base64, json, os, sys, time, urllib.request, urllib.error, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'videos'); os.makedirs(OUT, exist_ok=True)
opts = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
ONLY = set(opts['plans'].split(',')) if 'plans' in opts else None
keys = dict(l.strip().split('=', 1) for l in open(os.path.expanduser('~/.picopop-keys.env')) if '=' in l and not l.startswith('#'))
HDR = {'Authorization': 'Bearer ' + keys['XAI_API_KEY'], 'Content-Type': 'application/json'}
MODEL, RES = 'grok-imagine-video-1.5', '720p'

STYLE = ("Keep exactly the look of the starting image for the whole clip: children's colored-pencil and wax-crayon "
         "illustration, visible crayon strokes, bold black outlines, dark purple storm sky, rain drawn as thin slanted lines. "
         "No style drift, no photorealism, no text, no watermark. Static camera.")

PLANS = {
    'P3': ('P3_oree_orage_trex', 12,
        "The center-left of the frame stays empty for the entire clip (a small character will stand there, then flee to the "
        "left); do not add any other animal. Rain keeps falling the whole time, grass shakes in the wind. From 0 s to 2 s the "
        "green T-Rex at the right edge takes one heavy step forward facing left, staying in the right third of the frame. At "
        "3 s a lightning flash lights up the sky and the T-Rex ROARS, jaws wide open, head thrown forward. From 4 s to 6 s it "
        "stomps in place and roars again. From 7 s to 12 s it keeps roaring and snapping its jaws, always in the right third "
        "of the frame, it never runs and never leaves."),
    'P4': ('P4_course_orage', 10,
        "The path in the center and on the left stays empty from 0 s to 2 s (a small fast character will be added running "
        "through first); do not add any other animal. Rain keeps falling, the forest background does not move. From 0 s to "
        "2 s the green T-Rex at the right edge stays half out of the frame, leaning in. At 2 s it bursts in and RUNS to the "
        "LEFT along the path, heavy and a bit slow, mouth open, splashing through puddles, crossing the whole frame and "
        "leaving by the left edge at 7 s, dust and water drops behind its feet. From 7 s to 10 s the path is empty again, "
        "rain falling."),
}


def http(method, url, body=None, timeout=120):
    req = urllib.request.Request(url, data=body, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


def submit(name, image, duration, prompt):
    png = open(os.path.join(HERE, 'gpt-velociraptor', image + '.png'), 'rb').read()
    data_uri = 'data:image/png;base64,' + base64.b64encode(png).decode()
    base = {'model': MODEL, 'prompt': STYLE + "\n\nMotion: " + prompt, 'duration': duration, 'aspect_ratio': '16:9', 'resolution': RES}
    errors = []
    for image_field in ({'url': data_uri, 'type': 'image_url'}, data_uri):
        for attempt in range(3):
            status, raw = http('POST', 'https://api.x.ai/v1/videos/generations', json.dumps(dict(base, image=image_field)).encode())
            if status == 200: return json.loads(raw), None
            errors.append(f'HTTP {status} {raw[:200]!r}')
            if status in (400, 401, 403, 404, 422): break
            time.sleep(5 * (attempt + 1))
    return None, ' | '.join(errors)


def wait(rid, name, max_s=1500):
    t0 = time.time()
    while time.time() - t0 < max_s:
        status, raw = http('GET', f'https://api.x.ai/v1/videos/{rid}')
        if status == 200:
            d = json.loads(raw); st = d.get('status')
            if st == 'done': return d
            if st in ('failed', 'expired'): raise RuntimeError(f'{name}: {st} {raw[:300]!r}')
        time.sleep(10)
    raise TimeoutError(name)


def run(name):
    image, duration, prompt = PLANS[name]
    r, err = submit(name, image, duration, prompt)
    if r is None: return f'{name}: submit KO {err}'
    rid = r.get('request_id') or r.get('id')
    d = wait(rid, name)
    dest = os.path.join(OUT, name + '.mp4')
    with urllib.request.urlopen(d['video']['url'], timeout=300) as resp: open(dest, 'wb').write(resp.read())
    json.dump({'request_id': rid, 'model': MODEL, 'duration': duration, 'resolution': RES, 'image': image, 'prompt': prompt, 'response': d}, open(os.path.join(OUT, name + '.json'), 'w'), indent=1)
    cost = (d.get('usage') or {}).get('cost_in_usd_ticks')
    return f"{name}: OK {os.path.getsize(dest) // 1024} Ko, {d['video'].get('duration')} s, coût ≈ {cost / 1e10:.2f} $" if cost else f"{name}: OK {os.path.getsize(dest) // 1024} Ko"


todo = [n for n in PLANS if not ONLY or n in ONLY]
with cf.ThreadPoolExecutor(len(todo)) as ex:
    for res in ex.map(run, todo): print(res, flush=True)
