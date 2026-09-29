#!/usr/bin/env python3
"""Kit d'import du film ANKYLOSAURE (plan de Nicolas du 28/09/2026, 5 plans) → kit-<projet>.json pour
docs/films/film_import.py. Vidéos Grok Imagine faites à la main (videos/P1..P5-web.mp4, 15 s chacune).
PAS d'effets sonores (Nicolas les pose à la fin). Pas = sons attachés à l'animation Walk.
Héros DESSINÉ VERS LA DROITE (facing right). Image 1254² → ≈ 450 px de large à échelle 0,9.

Voix (transcription mot à mot, voices/voices-words.json) :
  Intro 5,0 s : « Hey I'm Ankylosaurus, the armored dinosaur with a tail like a wrecking ball » 0,00–4,96
  Audio 1 8,7 s : « My body was covered in bony armor » 0,00–2,62 · « Predators had a very hard time biting me »
                  3,62–6,46 · « I was a walking tank » 6,90–8,64
  Audio 2 5,8 s : « I didn't hunt other dinosaurs. I spent my days munching low plants and bushes » 0,00–5,52
  Audio 3 8,4 s : « I live near the end of the dinosaur age. That was over 60 million years ago! Humans were nowhere
                  around yet! » 0,00–8,26
Événements vidéo (planches videos/P*-sheet.jpg) : P3 ptérodactyles loin 0–3 s, tournoient au centre-droit 4–7 s,
poussière au sol 7–8 s, fuient 9–10,5 s, ciel vide dès 11 s · P5 la file marche vers la droite tout du long.
Règle vitesses : Walk 120 images = 5 s ≈ 70 px/s → speed = px/s ÷ 70.
"""
import json, os, sys, uuid

opts = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
PROJECT = opts.get('project', '90236c66-0867-4de9-920f-a0b9145c0c4a')   # Dino 5 - Ankylosaurus (copie), livre DINOSAUR COLORING BOOK
OUT = opts.get('out', 'kit-' + PROJECT[:8] + '.json')
HERE = os.path.dirname(os.path.abspath(__file__))
NS = uuid.uuid5(uuid.NAMESPACE_URL, 'picopop-film-ankylosaurus-' + PROJECT[:8])
uid = lambda key: str(uuid.uuid5(NS, key))

ANIM = {   # 121 images (≈ 4,75 s/passe à ×1), Discours 2 = 169 (≈ 7 s), Walk 120
    'Idle': '755dfa92-8b06-4d55-bca6-32004fe88b58',
    'Walk': '6d6040b4-47b6-452b-af81-fd9584a06d6e',
    'Action': '6b6458fd-69f3-45da-9f86-691e2de2bbd1',        # coup de queue
    'Discours2': 'febf9cbb-551c-4b2f-91f6-ac44b90a03b7',
}
SOUNDS = {'01-voice-intro': 'voices/Audio Intro.mp3', '02-voice-1': 'voices/Audio 1.mp3', '03-voice-2': 'voices/Audio 2.mp3', '04-voice-3': 'voices/Audio 3.mp3'}
MUSIC = ('30-music-ambiance-terrestre-v2', '../triceratops/sounds/30-music-ambiance-terrestre-v2.wav', 0.7)
SID = {n: uid('sound:' + n) for n in SOUNDS}
OFF_L, OFF_R = {'kind': 'offscreen', 'side': 'left'}, {'kind': 'offscreen', 'side': 'right'}

def wp(plan, name, x, y, scale, facing): return {'id': uid(f'{plan}.wp.{name}'), 'x': x, 'y': y, 'scale': scale, 'facing': facing}
W = lambda w: {'kind': 'waypoint', 'id': w['id']}
def appear(plan, to): return {'id': uid(f'{plan}.motion.appear'), 'startMs': 0, 'durationMs': 0, 'kind': 'appear', 'to': to}
def travel(plan, name, start, dur, to, easing='linear', animation='Walk', speed=1.0, frm=None):
    c = {'id': uid(f'{plan}.motion.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'travel', 'to': to, 'easing': easing, 'animationId': ANIM[animation], 'animSpeedMul': speed}
    if frm: c['from'] = frm
    return c
def anim(plan, name, start, dur, which, speed, fill='loop'): return {'id': uid(f'{plan}.anim.{name}'), 'startMs': start, 'durationMs': dur, 'animationId': ANIM[which], 'speedMul': speed, 'fillMode': fill}
def rumble(plan, name, start, dur, amp, hz, anchor=None):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'rumble', 'amplitude': amp, 'frequencyHz': hz, 'axis': 'both'}
    if anchor: c['anchor'] = anchor
    return c
def shake(plan, name, start, anchor=None, amp=18, hz=14, dur=800):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'shake', 'amplitude': amp, 'frequencyHz': hz, 'rotate': True, 'decay': 'expo'}
    if anchor: c['anchor'] = anchor
    return c
def voice(plan, name, start, sound, dur, offset=0):
    c = {'id': uid(f'{plan}.snd.{name}'), 'startMs': start, 'durationMs': dur, 'soundId': SID[sound], 'volume': 1.0, 'isSpoken': True}
    if offset: c['offsetMs'] = offset
    return c
A = lambda clip_id, offset=0, edge='start': {'clipId': clip_id, 'edge': edge, 'offsetMs': offset}
plans = {}

# PLAN 1 — Presentation · 10 s : entre par la gauche jusqu'au centre, intro pendant l'Idle.
P = 'P1'; centre = wp(P, 'centre', 560, 600, 0.9, 'right')
t_in = travel(P, 'entree', 0, 3500, W(centre), easing='easeOut', animation='Walk', speed=3.3, frm=OFF_L)   # ≈ 800 px/3,5 s = 230 px/s
plans[P] = {'id': uid('plan.P1'), 'name': 'Presentation', 'backdropFile': 'videos/P1-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 10000, 'waypoints': [centre], 'motion': [t_in],
    'anim': [anim(P, 'idle', 3500, 6500, 'Idle', 0.8)], 'camera': [rumble(P, 'pas', 0, 3500, 1, 3, A(t_in['id']))],
    'soundTracks': [{'clips': [voice(P, 'v0', 3800, '01-voice-intro', 5000)]}]}

# PLAN 2 — Bony armor · 8 s : cascade à droite, héros centre-gauche, « My body was covered in bony armor ».
P = 'P2'; pose = wp(P, 'pose', 430, 600, 0.9, 'right')
plans[P] = {'id': uid('plan.P2'), 'name': 'Bony armor', 'backdropFile': 'videos/P2-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 8000, 'waypoints': [pose], 'motion': [appear(P, W(pose))],
    'anim': [anim(P, 'idle1', 0, 1200, 'Idle', 0.8), anim(P, 'parle', 1200, 3200, 'Discours2', 1.0, 'once-hold'), anim(P, 'idle2', 4400, 3600, 'Idle', 0.8)],
    'camera': [], 'soundTracks': [{'clips': [voice(P, 'v1a', 1400, '02-voice-1', 2900)]}]}

# PLAN 3 — Wrecking ball · 15 s : arrive (0–3 s), « Predators had a very hard time biting me » 3,3 s, ptérodactyles
# tournoient 4–7 s, COUP DE QUEUE (Action ×2) 6,2 s → impact ≈ 7,4 s = poussière vidéo 7–8 s, fuite 9–10,5 s,
# « I was a walking tank » 10,8 s.
P = 'P3'; poste = wp(P, 'poste', 600, 610, 0.9, 'right')
t_in = travel(P, 'entree', 0, 3000, W(poste), easing='easeOut', animation='Walk', speed=3.8, frm=OFF_L)   # ≈ 840 px/3 s = 280 px/s
queue = anim(P, 'queue', 6200, 2400, 'Action', 2.0, 'once-hold')
plans[P] = {'id': uid('plan.P3'), 'name': 'Wrecking ball', 'backdropFile': 'videos/P3-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 15000, 'waypoints': [poste], 'motion': [t_in],
    'anim': [anim(P, 'idle1', 3000, 3200, 'Idle', 0.8), queue, anim(P, 'idle2', 8600, 6400, 'Idle', 0.8)],
    'camera': [rumble(P, 'pas', 0, 3000, 1, 3, A(t_in['id'])), shake(P, 'impact', 7400, A(queue['id'], 1200), amp=22, hz=12, dur=1000)],
    'soundTracks': [{'clips': [voice(P, 'v1b', 3300, '02-voice-1', 3100, offset=3620), voice(P, 'v1c', 10800, '02-voice-1', 2000, offset=6900)]}]}

# PLAN 4 — Munching · 10 s : herbivores à gauche, héros centre-droit près des buissons, Audio 2 entier.
P = 'P4'; buissons = wp(P, 'buissons', 800, 600, 0.9, 'right')
plans[P] = {'id': uid('plan.P4'), 'name': 'Munching', 'backdropFile': 'videos/P4-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 10000, 'waypoints': [buissons], 'motion': [appear(P, W(buissons))],
    'anim': [anim(P, 'idle1', 0, 800, 'Idle', 0.8), anim(P, 'parle', 800, 6000, 'Discours2', 1.0, 'once-hold'), anim(P, 'idle2', 6800, 3200, 'Idle', 0.8)],
    'camera': [], 'soundTracks': [{'clips': [voice(P, 'v2', 1000, '03-voice-2', 5800)]}]}

# PLAN 5 — Migration · 14 s : la file marche vers la droite, le héros marche SUR PLACE dans le trou (Walk ×1,6,
# rythme de la file), Audio 3 entier. Fin du film.
P = 'P5'; trou = wp(P, 'trou', 640, 640, 0.9, 'right')
plans[P] = {'id': uid('plan.P5'), 'name': 'Migration', 'backdropFile': 'videos/P5-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 14000, 'waypoints': [trou], 'motion': [appear(P, W(trou))],
    'anim': [anim(P, 'marche', 0, 14000, 'Walk', 1.6)], 'camera': [rumble(P, 'marche', 0, 14000, 1, 3)],
    'soundTracks': [{'clips': [voice(P, 'v3', 1500, '04-voice-3', 8500)]}]}

ORDER = ['P1', 'P2', 'P3', 'P4', 'P5']; INTRO = 1000
poster = INTRO + 10000 + 500 + 8000 + 500 + 6500   # plan 3, ptérodactyles au-dessus du héros
film = {'version': 4, 'plans': [plans[p] for p in ORDER],
    'character': {'scale': 1, 'facing': 'right', 'originU': 0.5, 'originV': 0.82},
    'sounds': [{'id': SID[n], 'name': n, 'file': f} for n, f in SOUNDS.items()],
    'music': {'id': uid('sound:' + MUSIC[0]), 'name': MUSIC[0], 'volume': MUSIC[2], 'loop': True, 'file': MUSIC[1]},
    'footstepsEnabled': True, 'moveAnimationId': ANIM['Walk'], 'moveSpeedPxPerSec': 230, 'idleSpeedMul': 0.8,
    'intro': {'kind': 'iris', 'durationMs': INTRO}, 'outro': {'kind': 'iris', 'durationMs': 1000}, 'posterMs': poster}
out = os.path.join(HERE, OUT); json.dump({'filmT': film}, open(out, 'w'), ensure_ascii=False, indent=1)
total = INTRO + sum(p['durationMs'] for p in film['plans']) + 500 * 4 + 1000
print('kit écrit →', out, '| 5 plans | durée ≈', total / 1000, 's')
