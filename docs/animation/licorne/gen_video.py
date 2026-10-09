"""Vidéo idle (respiration) de la licorne colorée avec xAI grok-imagine-video-1.5 (image-to-video).
Usage : python3 gen_idle.py <dossier_sortie> [n=3] [duration=5] [res=720p] [ar=1:1]
Image source : referenceImage.png (RGBA) aplatie sur blanc. Sorties : idle-<k>.mp4 + .json, frames et planche de contrôle."""
import base64, io, json, os, sys, time, threading, urllib.request, subprocess
from PIL import Image, ImageChops, ImageDraw
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = sys.argv[1]; os.makedirs(OUT, exist_ok=True)
opts = dict(a.split('=', 1) for a in sys.argv[2:] if '=' in a)
N = int(opts.get('n', 3)); DUR = int(opts.get('duration', 5)); RES = opts.get('res', '720p'); AR = opts.get('ar', '1:1'); MODEL = 'grok-imagine-video-1.5'
for line in open(os.path.expanduser('~/.picopop-keys.env')):
    if line.startswith('XAI_API_KEY='): KEY = line.strip().split('=', 1)[1].strip('"')
HDR = {'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
src = Image.open(f'{HERE}/referenceImage.png').convert('RGBA')
flat = Image.new('RGB', src.size, 'white'); flat.paste(src, mask=src.split()[3]); flat.save(f'{OUT}/source-flat.png')
buf = io.BytesIO(); flat.save(buf, 'JPEG', quality=95); data_uri = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
PROMPT_IDLE = ("Cute cartoon unicorn illustration with thick black outlines and flat pastel colors on a plain pure white background. "
          "The unicorn keeps exactly the same pose, size and position for the whole video. "
          "Motion: a gentle idle breathing loop — the chest and belly softly expand and contract, the head bobs very slightly, "
          "the mane and tail sway softly. All four legs stay planted and perfectly still. "
          "Camera completely static: no zoom, no pan, no cut. Nothing else moves, no new elements appear. Seamless loop.")
PROMPT = open(opts["prompt_file"]).read().strip() if opts.get("prompt_file") else PROMPT_IDLE
def http(method, url, body=None, timeout=300):
    req = urllib.request.Request(url, data=body, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, e.read()
def submit():
    base = {'model': MODEL, 'prompt': PROMPT, 'duration': DUR, 'aspect_ratio': AR, 'resolution': RES}
    errors = []
    for image_field in ({'url': data_uri, 'type': 'image_url'}, data_uri):
        for attempt in range(3):
            status, raw = http('POST', 'https://api.x.ai/v1/videos/generations', json.dumps(dict(base, image=image_field)).encode())
            if status == 200: return json.loads(raw), None
            errors.append(f'HTTP {status} {raw[:300]!r}')
            if status in (400, 401, 403, 404, 422): break
            time.sleep(5 * (attempt + 1))
    return None, ' | '.join(errors)
def wait(rid, max_s=1500):
    t0 = time.time()
    while time.time() - t0 < max_s:
        status, raw = http('GET', f'https://api.x.ai/v1/videos/{rid}')
        if status == 200:
            d = json.loads(raw); st = d.get('status')
            if st == 'done': return d
            if st in ('failed', 'expired'): raise RuntimeError(f'{st} {raw[:300]!r}')
        time.sleep(10)
    raise TimeoutError('timeout')
results = {}
def run(k):
    r, err = submit()
    if r is None: results[k] = f'submit KO {err}'; print(k, results[k], flush=True); return
    rid = r.get('request_id') or r.get('id'); print(k, 'soumis', rid, flush=True)
    try: d = wait(rid)
    except Exception as e: results[k] = f'KO {e}'; print(k, results[k], flush=True); return
    dest = f'{OUT}/idle-{k}.mp4'
    with urllib.request.urlopen(d['video']['url'], timeout=300) as resp: open(dest, 'wb').write(resp.read())
    json.dump({'request_id': rid, 'model': MODEL, 'duration': DUR, 'resolution': RES, 'aspect_ratio': AR, 'prompt': PROMPT, 'response': d}, open(f'{OUT}/idle-{k}.json', 'w'), indent=1)
    results[k] = f'OK {os.path.getsize(dest) // 1024} KB'; print(k, results[k], flush=True)
ths = [threading.Thread(target=run, args=(k,)) for k in range(1, N + 1)]
for t in ths: t.start(); time.sleep(2)
for t in ths: t.join()
# contrôle : frame 0 vs source (écart moyen), planche de 6 frames par vidéo
sheet_rows = []
for k in range(1, N + 1):
    mp4 = f'{OUT}/idle-{k}.mp4'
    if not os.path.exists(mp4): continue
    info = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,nb_frames,duration', '-of', 'json', mp4], capture_output=True, text=True).stdout
    st = json.loads(info)['streams'][0]; w, h = st['width'], st['height']
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', mp4, '-vf', 'select=eq(n\\,0)', '-vframes', '1', f'{OUT}/idle-{k}-f0.png'])
    f0 = Image.open(f'{OUT}/idle-{k}-f0.png').convert('RGB'); ref = flat.resize((w, h), Image.LANCZOS)
    diff = ImageChops.difference(f0, ref).convert('L'); mean = sum(diff.getdata()) / (w * h)
    results[k] += f' · {w}x{h} {st.get("nb_frames")} frames {float(st.get("duration", 0)):.1f}s · écart frame0 = {mean:.1f}/255'
    frames = []
    for i in range(6):
        t = i * float(st.get('duration', DUR)) / 6
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', mp4, '-vframes', '1', f'{OUT}/idle-{k}-t{i}.png'])
        frames.append(Image.open(f'{OUT}/idle-{k}-t{i}.png').convert('RGB').resize((360, 360 * h // w)))
    row = Image.new('RGB', (360 * 6, frames[0].height + 24), 'white'); d = ImageDraw.Draw(row); d.text((6, 4), f'idle-{k} : {results[k]}', fill='black')
    for i, f in enumerate(frames): row.paste(f, (i * 360, 24))
    sheet_rows.append(row)
if sheet_rows:
    sheet = Image.new('RGB', (sheet_rows[0].width, sum(r.height for r in sheet_rows)), 'white'); y = 0
    for r in sheet_rows: sheet.paste(r, (0, y)); y += r.height
    sheet.save(f'{OUT}/planche.png')
print(json.dumps(results, indent=1, ensure_ascii=False))
