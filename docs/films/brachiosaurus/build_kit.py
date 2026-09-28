#!/usr/bin/env python3
"""Kit d'import du film BRACHIOSAURE (plan de Nicolas du 28/09/2026, 5 plans) → kit-<projet>.json pour
docs/films/film_import.py. Vidéos Grok Imagine faites à la main (videos/P1..P5-web.mp4, 15 s chacune).

Choix (28/09) : PAS d'effets sonores (Nicolas les pose lui-même à la fin) ; pas de bruits de pas manuels
(sons de l'animation Walk, à attacher) ; voix = 5 clips « parlés » POSÉS aux bons instants mais qui pointent
vers des fichiers voix À FOURNIR (voir VOICES) — tant que les fichiers manquent, le kit ne les inclut pas
et le tableau ci-dessous garde les emplacements prévus.
Règle vitesses : Walk 120 images = 5 s à ×1 ≈ 70 px/s → speed = px/s ÷ 70 ; gestes vifs ×2.

Usage : python3 build_kit.py [project=<id>] [out=kit-<projet>.json]
"""
import json, os, sys, uuid

opts = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
PROJECT = opts.get('project', 'faa6845e-8db4-4acc-b42b-cc42085b3bea')   # BRACHIOSAURUS (livre DINOSAUR COLORING BOOK)
OUT = opts.get('out', 'kit-' + PROJECT[:8] + '.json')
HERE = os.path.dirname(os.path.abspath(__file__))

NS = uuid.uuid5(uuid.NAMESPACE_URL, 'picopop-film-brachiosaurus-' + PROJECT[:8])
uid = lambda key: str(uuid.uuid5(NS, key))

ANIM = {   # projet faa6845e — 121 images (≈ 4,75 s/passe à ×1) sauf Action/Discours 3 (151 ≈ 6 s), Walk 120
    'Idle': '3e863eab-c845-4d45-98e1-06d4585f5bc4',
    'Walk': 'bb17b26a-dccf-4955-9957-c98f39855015',
    'LongNeck': '1d402fc6-ac14-41a6-a02f-06afe6f8a174',     # Fun fact - Long neck
    'BodyCheck': 'ab272c20-6e32-49bc-9c36-23b131e8eece',    # Action - Giant body check
    'Action': '2a2737c1-df8b-4d86-aac1-a2f7b5a7e90f',
    'Discours3': 'c626e9df-1a3f-4c44-b912-8e6692937dcc',
}
# Voix à fournir : (nom bibliothèque, fichier local). Absentes → clips non posés (voir VOICE_SLOTS).
VOICES = {
    '01-voice-intro': 'voices/Audio Intro.mp3',   # Hey! I'm Brachiosaurus, one of the tallest dinosaurs to ever walk the Earth!
    '02-voice-1': 'voices/Audio 1.mp3',           # My neck was super long! / Reaching tall trees was easy for me!
    '03-voice-2': 'voices/Audio 2.mp3',           # I was taller than a two-story house!
    '04-voice-3': 'voices/Audio 3.mp3',           # My head could reach high into the sky. / I was a true giant!
    '05-voice-4': 'voices/Audio 4.mp3',           # I spent my days eating plants and leaves. / I needed LOTS of food… / Munch munch munch!
}
SOUNDS = {n: f for n, f in VOICES.items() if os.path.exists(os.path.join(HERE, f))}
MUSIC = ('30-music-ambiance-terrestre-v2', '../triceratops/sounds/30-music-ambiance-terrestre-v2.wav', 0.7)
SID = {name: uid('sound:' + name) for name in VOICES}

OFF_L = {'kind': 'offscreen', 'side': 'left'}
OFF_R = {'kind': 'offscreen', 'side': 'right'}


def wp(plan, name, x, y, scale, facing):
    return {'id': uid(f'{plan}.wp.{name}'), 'x': x, 'y': y, 'scale': scale, 'facing': facing}


W = lambda w: {'kind': 'waypoint', 'id': w['id']}


def appear(plan, to):
    return {'id': uid(f'{plan}.motion.appear'), 'startMs': 0, 'durationMs': 0, 'kind': 'appear', 'to': to}


def travel(plan, name, start, dur, to, easing='linear', animation='Walk', speed=1.0, frm=None):
    c = {'id': uid(f'{plan}.motion.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'travel', 'to': to,
         'easing': easing, 'animationId': ANIM[animation], 'animSpeedMul': speed}
    if frm: c['from'] = frm
    return c


def anim(plan, name, start, dur, which, speed, fill='loop'):
    return {'id': uid(f'{plan}.anim.{name}'), 'startMs': start, 'durationMs': dur, 'animationId': ANIM[which], 'speedMul': speed, 'fillMode': fill}


def zoom(plan, name, start, dur, rect, zin, zout, easing='easeInOut'):
    return {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'zoom', 'rect': rect,
            'zoomInMs': zin, 'zoomOutMs': zout, 'easing': easing, 'maxZoom': 2.5}


def rumble(plan, name, start, dur, amp, hz, anchor=None):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'rumble', 'amplitude': amp, 'frequencyHz': hz, 'axis': 'both'}
    if anchor: c['anchor'] = anchor
    return c


def voice(plan, name, start, sound, dur, offset=0):
    """Clip parlé. Si le fichier voix n'existe pas encore, il est mémorisé dans VOICE_SLOTS et non posé."""
    slot = {'plan': plan, 'name': name, 'startMs': start, 'sound': sound, 'durationMs': dur, 'offsetMs': offset}
    VOICE_SLOTS.append(slot)
    if sound not in SOUNDS: return None
    c = {'id': uid(f'{plan}.snd.{name}'), 'startMs': start, 'durationMs': dur, 'soundId': SID[sound], 'volume': 1.0, 'isSpoken': True}
    if offset: c['offsetMs'] = offset
    return c


A = lambda clip_id, offset=0, edge='start': {'clipId': clip_id, 'edge': edge, 'offsetMs': offset}
VOICE_SLOTS = []
plans = {}

# ---------------------------------------------------------------- PLAN 1 — Presentation · 10 s
# Prairie, famille et herbivores au fond. Héros : entre par la gauche en marchant jusqu'au centre, puis Idle
# pendant la présentation. Durée voix estimée 4,5 s (à recaler sur le fichier).
P = 'P1'
centre = wp(P, 'centre', 560, 600, 0.95, 'right')
t_in = travel(P, 'entree', 0, 3500, W(centre), easing='easeOut', animation='Walk', speed=3.3, frm=OFF_L)   # ≈ 820 px/3,5 s = 234 px/s
plans['P1'] = {
    'id': uid('plan.P1'), 'name': 'Presentation', 'backdropFile': 'videos/P1-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 10000,
    'waypoints': [centre], 'motion': [t_in],
    'anim': [anim(P, 'idle', 3500, 6500, 'Idle', 0.8)],
    'camera': [rumble(P, 'pas', 0, 3500, 1, 3, A(t_in['id']))],
    'soundTracks': [{'clips': [c for c in [voice(P, 'v0', 3800, '01-voice-intro', 5000)] if c]}],
}

# ---------------------------------------------------------------- PLAN 2 — Long neck, cimes · 12 s
# Décor = cimes des arbres (moitié basse) + ciel. Héros placé BAS et GRAND pour que seuls le cou et la tête
# dépassent des feuillages au centre : origine (0,5 · 0,82) à y 1000, échelle 1,5 → haut du perso ≈ y 115.
P = 'P2'
haut = wp(P, 'tete', 640, 1000, 1.5, 'right')
plans['P2'] = {
    'id': uid('plan.P2'), 'name': 'Long neck', 'backdropFile': 'videos/P2-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 12000,
    'waypoints': [haut], 'motion': [appear(P, W(haut))],
    'anim': [anim(P, 'cou', 0, 6000, 'LongNeck', 1.0, 'once-hold'), anim(P, 'idle', 6000, 6000, 'Idle', 0.8)],
    'camera': [],
    'soundTracks': [{'clips': [c for c in [voice(P, 'v1a', 800, '02-voice-1', 3000), voice(P, 'v1b', 5200, '02-voice-1', 3500, offset=3500)] if c]}],
}

# ---------------------------------------------------------------- PLAN 3 — Two-story house · 10 s
# Tricératops endormi à gauche, maison au milieu (≈ 240 px de haut). Héros à DROITE (x 1000, échelle 1,0 →
# 720 px de haut, 3 fois la maison), regard vers la gauche (vers la maison). « Giant body check » = il se regarde.
P = 'P3'
droite = wp(P, 'droite', 1000, 600, 1.0, 'left')
plans['P3'] = {
    'id': uid('plan.P3'), 'name': 'Two-story house', 'backdropFile': 'videos/P3-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 10000,
    'waypoints': [droite], 'motion': [appear(P, W(droite))],
    'anim': [anim(P, 'idle1', 0, 1500, 'Idle', 0.8), anim(P, 'body', 1500, 4800, 'BodyCheck', 1.0, 'once-hold'), anim(P, 'idle2', 6300, 3700, 'Idle', 0.8)],
    'camera': [zoom(P, 'maison', 2000, 5000, {'x': 380, 'y': 200, 'w': 800, 'h': 450}, 800, 1200)],
    'soundTracks': [{'clips': [c for c in [voice(P, 'v2', 1800, '03-voice-2', 3200)] if c]}],
}

# ---------------------------------------------------------------- PLAN 4 — True giant · 12 s
# Petits arbres (≈ tiers bas), ptérodactyle qui traverse le ciel en haut. Héros au centre, échelle 1,15 →
# dépasse largement les arbres. Long neck = la tête monte vers le ciel.
P = 'P4'
geant = wp(P, 'geant', 640, 610, 1.15, 'right')
plans['P4'] = {
    'id': uid('plan.P4'), 'name': 'True giant', 'backdropFile': 'videos/P4-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 12000,
    'waypoints': [geant], 'motion': [appear(P, W(geant))],
    'anim': [anim(P, 'idle1', 0, 1000, 'Idle', 0.8), anim(P, 'cou', 1000, 4800, 'LongNeck', 1.0, 'once-hold'), anim(P, 'idle2', 5800, 6200, 'Idle', 0.8)],
    'camera': [],
    'soundTracks': [{'clips': [c for c in [voice(P, 'v3a', 1200, '04-voice-3', 3000), voice(P, 'v3b', 5500, '04-voice-3', 2500, offset=3300)] if c]}],
}

# ---------------------------------------------------------------- PLAN 5 — Munch munch · 14 s
# Prairie au coucher du soleil, famille qui mange à gauche. Héros au centre-droit, regard vers la gauche
# (vers sa famille), Discours 3 pendant les répliques puis « Action » sur « Munch munch munch ».
P = 'P5'
repas = wp(P, 'repas', 820, 600, 0.95, 'left')
plans['P5'] = {
    'id': uid('plan.P5'), 'name': 'Munch munch', 'backdropFile': 'videos/P5-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 14000,
    'waypoints': [repas], 'motion': [appear(P, W(repas))],
    'anim': [anim(P, 'parle', 0, 8500, 'Discours3', 1.0), anim(P, 'munch', 8500, 5500, 'Action', 1.2, 'loop')],
    'camera': [],
    'soundTracks': [{'clips': [c for c in [voice(P, 'v4a', 800, '05-voice-4', 3000), voice(P, 'v4b', 4300, '05-voice-4', 3500, offset=3200), voice(P, 'v4c', 9000, '05-voice-4', 2500, offset=7000)] if c]}],
}

for pl in plans.values():
    pl['soundTracks'] = [tr for tr in pl['soundTracks'] if tr['clips']]

ORDER = ['P1', 'P2', 'P3', 'P4', 'P5']
INTRO = 1000
poster = INTRO + plans['P1']['durationMs'] + 500 + plans['P2']['durationMs'] + 500 + 3000   # plan 3, le géant à côté de la maison
film = {
    'version': 4,
    'plans': [plans[p] for p in ORDER],
    'character': {'scale': 1, 'facing': 'right', 'originU': 0.5, 'originV': 0.82},
    'sounds': [{'id': SID[n], 'name': n, 'file': f} for n, f in SOUNDS.items()],
    'music': {'id': uid('sound:' + MUSIC[0]), 'name': MUSIC[0], 'volume': MUSIC[2], 'loop': True, 'file': MUSIC[1]},
    'footstepsEnabled': True,
    'moveAnimationId': ANIM['Walk'],
    'moveSpeedPxPerSec': 230,
    'idleSpeedMul': 0.8,
    'intro': {'kind': 'iris', 'durationMs': INTRO},
    'outro': {'kind': 'iris', 'durationMs': 1000},
    'posterMs': poster,
}
out = os.path.join(HERE, OUT)
json.dump({'filmT': film}, open(out, 'w'), ensure_ascii=False, indent=1)
missing = [s for s in VOICE_SLOTS if s['sound'] not in SOUNDS]
total = INTRO + sum(p['durationMs'] for p in film['plans']) + 500 * (len(ORDER) - 1) + 1000
print('kit écrit →', out, '|', len(film['plans']), 'plans |', len(SOUNDS), 'voix présentes,', len(missing), 'emplacements de voix en attente | durée ≈', total / 1000, 's')
for s in missing: print(f"   voix manquante : {s['plan']} {s['name']} à {s['startMs']} ms ← {s['sound']} (offset {s['offsetMs']} ms, {s['durationMs']} ms)")
