#!/usr/bin/env python3
"""Kit d'import du film SPINOSAURE (plan de Nicolas, 6 plans) → kit-<projet>.json pour docs/films/film_import.py.
Vidéos Grok faites à la main (videos/P1..P6-web.mp4, 15 s). PAS d'effets sonores (Nicolas). Pas = sons de l'animation Walk.
Voix (mot à mot, voices/voices-words.json) :
  Intro 5,6 s : « Hey I'm Spinosaurus, the largest meat-eating dinosaur ever discovered » 0,00–5,12
  Audio 1 7,7 s : « Look at the giant sail on my back » 0,00–2,08 · « Scientists still debate what it was used for » 3,30–5,16
                  · « but it sure made me look awesome » 5,68–7,58
  Audio 2 7,4 s : « I loved catching fish in rivers and swamps » 0,00–2,52 · « My long snout helped me snap slippery fish »
                  3,18–6,10 · « Got one » 6,74–7,30   (⚠ enregistré « Got one », pas « Oh no! Missed it »)
  Audio 3 8,7 s : « I was even longer than a T-Rex » 0,00–1,92 · « Some Spinosaurus dinosaurs grew longer than a bus » 2,72–6,24
                  · « I was huge » 6,88–8,48
Événements vidéo (planches videos/P*-sheet.jpg) : P1 troupeau broute 0–5 s, fuit 5–8 s, parti à 9 s · P3 oiseaux 0–6 s,
s'envolent 7 s, partis 8 s · P4 poisson sous l'eau 0–5 s, SAUTE 6–8 s, SPLASH 9 s · P5 le bus est déjà là dès 0 s, se gare
centre-droit à 4 s, phares 6–9 s · P6 T-Rex à gauche rugit 1–7 s, recule 8–11 s, battu au bord gauche 12–14 s.
Walk = 96 images (4 s à ×1). Héros DESSINÉ VERS LA DROITE.
"""
import json, os, sys, uuid
opts = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
PROJECT = opts.get('project', '65a493b4-073f-4081-9553-52dc9c87f539')   # Dino 9 - Spinosaurus (copie), livre DINOSAUR COLORING BOOK
OUT = opts.get('out', 'kit-' + PROJECT[:8] + '.json'); HERE = os.path.dirname(os.path.abspath(__file__))
NS = uuid.uuid5(uuid.NAMESPACE_URL, 'picopop-film-spinosaurus-' + PROJECT[:8]); uid = lambda key: str(uuid.uuid5(NS, key))
ANIM = {'Idle': 'd90bb659-3beb-4d1e-9381-63322e329309', 'Walk': '201fa70d-1ead-4a87-b01c-3710ba73245b',
        'Action': '453f27af-7928-4b16-8f3f-661b2fea0f34', 'Discours2': '6d104468-a2fc-4800-9028-ac4c0ee0c54c'}
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
def zoom(plan, name, start, dur, rect, zin, zout): return {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'zoom', 'rect': rect, 'zoomInMs': zin, 'zoomOutMs': zout, 'easing': 'easeInOut', 'maxZoom': 2.5}
def rumble(plan, name, start, dur, amp, hz, anchor=None):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'rumble', 'amplitude': amp, 'frequencyHz': hz, 'axis': 'both'}
    if anchor: c['anchor'] = anchor
    return c
def shake(plan, name, start, anchor=None, amp=16, hz=14, dur=700):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'shake', 'amplitude': amp, 'frequencyHz': hz, 'rotate': True, 'decay': 'expo'}
    if anchor: c['anchor'] = anchor
    return c
def voice(plan, name, start, sound, dur, offset=0):
    c = {'id': uid(f'{plan}.snd.{name}'), 'startMs': start, 'durationMs': dur, 'soundId': SID[sound], 'volume': 1.0, 'isSpoken': True}
    if offset: c['offsetMs'] = offset
    return c
A = lambda clip_id, offset=0, edge='start': {'clipId': clip_id, 'edge': edge, 'offsetMs': offset}
plans = {}

# P1 — Presentation · 12 s : entre par la gauche (0–3,5 s) jusqu'à x 400, intro à 1,0 s ; le troupeau fuit à 5 s.
P = 'P1'; pose = wp(P, 'pose', 400, 610, 0.9, 'right')
t_in = travel(P, 'entree', 0, 3500, W(pose), easing='easeOut', animation='Walk', speed=2.8, frm=OFF_L)   # ≈ 640 px/3,5 s
plans[P] = {'id': uid('plan.P1'), 'name': 'Presentation', 'backdropFile': 'videos/P1-web.mp4', 'cameraX': 640, 'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 12000,
    'waypoints': [pose], 'motion': [t_in], 'anim': [anim(P, 'idle', 3500, 8500, 'Idle', 0.8)], 'camera': [rumble(P, 'pas', 0, 3500, 1, 3, A(t_in['id']))],
    'soundTracks': [{'clips': [voice(P, 'v0', 1000, '01-voice-intro', 5400)]}]}

# P2 — Giant sail · 10 s : centre, Discours 2, zoom sur le dos (voile) pendant les 2 phrases.
P = 'P2'; centre = wp(P, 'centre', 640, 610, 0.95, 'right')
plans[P] = {'id': uid('plan.P2'), 'name': 'Giant sail', 'backdropFile': 'videos/P2-web.mp4', 'cameraX': 640, 'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 10000,
    'waypoints': [centre], 'motion': [appear(P, W(centre))],
    'anim': [anim(P, 'idle1', 0, 800, 'Idle', 0.8), anim(P, 'parle', 800, 5600, 'Discours2', 1.0, 'once-hold'), anim(P, 'idle2', 6400, 3600, 'Idle', 0.8)],
    'camera': [zoom(P, 'voile', 1500, 4500, {'x': 340, 'y': 160, 'w': 600, 'h': 338}, 800, 1200)],
    'soundTracks': [{'clips': [voice(P, 'v1ab', 1000, '02-voice-1', 5400)]}]}

# P3 — Look awesome · 12 s : arrive (0–3 s) à x 450, « but it sure made me look awesome » 3,4 s, RUGIT (Action) 5,6 s →
# oiseaux s'envolent 7 s.
P = 'P3'; mare = wp(P, 'mare', 450, 610, 0.9, 'right')
t_in = travel(P, 'entree', 0, 3000, W(mare), easing='easeOut', animation='Walk', speed=2.8, frm=OFF_L)
rugit = anim(P, 'rugit', 5600, 2400, 'Action', 2.0, 'once-hold')
plans[P] = {'id': uid('plan.P3'), 'name': 'Look awesome', 'backdropFile': 'videos/P3-web.mp4', 'cameraX': 640, 'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 12000,
    'waypoints': [mare], 'motion': [t_in], 'anim': [anim(P, 'idle1', 3000, 2600, 'Idle', 0.8), rugit, anim(P, 'idle2', 8000, 4000, 'Idle', 0.8)],
    'camera': [rumble(P, 'pas', 0, 3000, 1, 3, A(t_in['id'])), shake(P, 'rugit', 6000, A(rugit['id'], 400))],
    'soundTracks': [{'clips': [voice(P, 'v1c', 3400, '02-voice-1', 2100, offset=5680)]}]}

# P4 — Fishing · 14 s : berge gauche x 380, 2 phrases 0,8 s, poisson saute 6–8 s → coup de gueule (Action ×2) 6,8 s,
# splash 9 s, « Got one » 9,4 s (⚠ Nicolas voulait « Oh no! Missed it »).
P = 'P4'; berge = wp(P, 'berge', 380, 620, 0.9, 'right')
snap = anim(P, 'snap', 6800, 2400, 'Action', 2.0, 'once-hold')
plans[P] = {'id': uid('plan.P4'), 'name': 'Fishing', 'backdropFile': 'videos/P4-web.mp4', 'cameraX': 640, 'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 14000,
    'waypoints': [berge], 'motion': [appear(P, W(berge))],
    'anim': [anim(P, 'parle', 0, 6800, 'Discours2', 1.0, 'once-hold'), snap, anim(P, 'idle', 9200, 4800, 'Idle', 0.8)],
    'camera': [], 'soundTracks': [{'clips': [voice(P, 'v2ab', 800, '03-voice-2', 6300), voice(P, 'v2c', 9400, '03-voice-2', 900, offset=6740)]}]}

# P5 — Longer than a bus · 10 s : le bus se gare centre-droit à 4 s ; héros à GAUCHE x 300, phrase à 4,5 s.
P = 'P5'; gauche = wp(P, 'gauche', 300, 620, 0.85, 'right')
plans[P] = {'id': uid('plan.P5'), 'name': 'Longer than a bus', 'backdropFile': 'videos/P5-web.mp4', 'cameraX': 640, 'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 10000,
    'waypoints': [gauche], 'motion': [appear(P, W(gauche))],
    'anim': [anim(P, 'idle1', 0, 4200, 'Idle', 0.8), anim(P, 'parle', 4200, 4000, 'Discours2', 1.0, 'once-hold'), anim(P, 'idle2', 8200, 1800, 'Idle', 0.8)],
    'camera': [], 'soundTracks': [{'clips': [voice(P, 'v3b', 4500, '04-voice-3', 3700, offset=2720)]}]}

# P6 — Face au T-Rex · 15 s : héros à DROITE x 940 regard à gauche ; « I was even longer than a T-Rex » 1,0 s ; les deux
# rugissent (Action) 4,5 s et 9,0 s (T-Rex recule 8–11 s) ; « I was huge » 11,8 s ; fin du film sur le face-à-face.
P = 'P6'; face = wp(P, 'face', 940, 610, 0.95, 'left')
r1 = anim(P, 'rugit1', 4500, 2400, 'Action', 2.0, 'once-hold'); r2 = anim(P, 'rugit2', 9000, 2400, 'Action', 2.0, 'once-hold')
plans[P] = {'id': uid('plan.P6'), 'name': 'Face au T-Rex', 'backdropFile': 'videos/P6-web.mp4', 'cameraX': 640, 'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 15000,
    'waypoints': [face], 'motion': [appear(P, W(face))],
    'anim': [anim(P, 'idle1', 0, 4500, 'Idle', 0.8), r1, anim(P, 'idle2', 6900, 2100, 'Idle', 0.8), r2, anim(P, 'idle3', 11400, 3600, 'Idle', 0.8)],
    'camera': [shake(P, 'rugit1', 4900, A(r1['id'], 400)), shake(P, 'rugit2', 9400, A(r2['id'], 400), amp=20)],
    'soundTracks': [{'clips': [voice(P, 'v3a', 1000, '04-voice-3', 2100), voice(P, 'v3c', 11800, '04-voice-3', 1800, offset=6880)]}]}

ORDER = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']; INTRO = 1000
poster = INTRO + 12000 + 500 + 10000 + 500 + 10000 + 500 + 10000 + 500 + 6800   # plan 5, le héros à côté du bus
film = {'version': 4, 'plans': [plans[p] for p in ORDER], 'character': {'scale': 1, 'facing': 'right', 'originU': 0.5, 'originV': 0.82},
    'sounds': [{'id': SID[n], 'name': n, 'file': f} for n, f in SOUNDS.items()],
    'music': {'id': uid('sound:' + MUSIC[0]), 'name': MUSIC[0], 'volume': MUSIC[2], 'loop': True, 'file': MUSIC[1]},
    'footstepsEnabled': True, 'moveAnimationId': ANIM['Walk'], 'moveSpeedPxPerSec': 200, 'idleSpeedMul': 0.8,
    'intro': {'kind': 'iris', 'durationMs': INTRO}, 'outro': {'kind': 'iris', 'durationMs': 1000}, 'posterMs': poster}
out = os.path.join(HERE, OUT); json.dump({'filmT': film}, open(out, 'w'), ensure_ascii=False, indent=1)
print('kit écrit →', out, '| 6 plans | durée ≈', (INTRO + sum(p['durationMs'] for p in film['plans']) + 2500 + 1000) / 1000, 's')
