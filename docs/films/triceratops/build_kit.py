#!/usr/bin/env python3
"""Construit le kit d'import du film Tricératops (docs/films/triceratops/script.md v4) → kit-<plans>.json
consommé par docs/films/film_import.py. Ids DÉTERMINISTES (uuid5) : relancer le script ne change
aucun id, on peut donc ré-importer / compléter plan par plan sans casser les ancrages.

Usage : python3 build_kit.py [project=<id>] [plans=P1,P2] [out=kit-p1p2-<projet>.json]
"""
import json, os, sys, uuid

opts = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
ONLY = opts.get('plans', 'P1,P2').split(',')
# Projet cible (défaut : le « Triceratops » du livre DINOSAUR COLORING BOOK, créé le 24/09/2026).
PROJECT = opts.get('project', 'ef7201a8-3106-4698-8752-f672c5ad023b')
OUT = opts.get('out', 'kit-' + ''.join(p.lower() for p in ONLY) + '-' + PROJECT[:8] + '.json')
HERE = os.path.dirname(os.path.abspath(__file__))

NS = uuid.uuid5(uuid.NAMESPACE_URL, 'picopop-film-triceratops-' + PROJECT[:8])
uid = lambda key: str(uuid.uuid5(NS, key))

# Ids des animations PAR PROJET (vérifiés dans Firestore le 24/09/2026).
ANIMS_BY_PROJECT = {
    'ef7201a8-3106-4698-8752-f672c5ad023b': {   # Triceratops (livre DINOSAUR COLORING BOOK 166cf8a8…) — le bon
        'Idle': '26fde2af-878f-4096-8e1c-b3bd49171dab',
        'Walk': '11186ed3-5fb9-4af4-a1dd-afe5694c97f4',
        'Charge': '824543df-a613-4813-a53c-5be5de7ec942',
        'Stuck': 'b372733c-9342-4880-9591-9f816f2a0c47',
        'Jump': 'bf746a64-a596-431f-b01c-2a3b3a67c731',
    },
    'efa2953a-bba4-46e1-8fa3-beca00cb6747': {   # DINO 4 - Triceratops (livre OLD) — ancien, ne plus utiliser
        'Idle': '4b761b3f-c70b-4789-97ae-6faf6729df80',
        'Walk': 'f1750506-c2ee-4312-8f39-7f4129374ad4',
        'Charge': '70ffc924-9969-4f6d-b92f-7ed6d15ce4c9',
        'Stuck': '56945fba-ed37-449b-bc7d-483978f4e6ba',
    },
}
ANIM = ANIMS_BY_PROJECT[PROJECT]
SOUNDS = {  # nom de bibliothèque → fichier local
    '01-voice-intro': 'voices/Audio Intro.mp3',
    '02-voice-1': 'voices/Audio 1.mp3',
    '03-voice-2': 'voices/Audio 2.mp3',
    '04-voice-3': 'voices/Audio 3.mp3',
    '05-sfx-pas': 'voices/Audio Marche.mp3',
    # bruitages repris de la bibliothèque du film T-Rex (déjà achetés) en attendant les sons Envato dédiés
    '24-sfx-riser': 'sounds/24-sfx-riser.mp3',
    '25-sfx-trex-roar': 'sounds/25-sfx-trex-roar.mp3',
    '30-sfx-dino-flee': 'sounds/30-sfx-dino-flee.mp3',
    '31-sfx-whoosh': 'sounds/31-sfx-whoosh.mp3',
    '40-sfx-ptero-cry': 'sounds/40-sfx-ptero-cry.mp3',
}
MUSIC = ('30-music-ambiance-terrestre-v2', 'sounds/30-music-ambiance-terrestre-v2.wav', 0.8)
SID = {name: uid('sound:' + name) for name in SOUNDS}


def wp(plan, name, x, y, scale, facing):
    return {'id': uid(f'{plan}.wp.{name}'), 'x': x, 'y': y, 'scale': scale, 'facing': facing}


def appear(plan, wp_id):
    return {'id': uid(f'{plan}.motion.appear'), 'startMs': 0, 'durationMs': 0, 'kind': 'appear', 'to': {'kind': 'waypoint', 'id': wp_id}}


def travel(plan, name, start, dur, to_ref, easing='easeOut', anim='Walk', speed=1.0, frm=None, cps=None):
    c = {'id': uid(f'{plan}.motion.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'travel', 'to': to_ref,
         'easing': easing, 'animationId': ANIM[anim], 'animSpeedMul': speed}
    if frm: c['from'] = frm
    if cps: c['controlPoints'] = cps
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


def shake(plan, name, start, anchor=None, amp=16, hz=14):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': 700, 'kind': 'shake', 'amplitude': amp, 'frequencyHz': hz, 'rotate': True, 'decay': 'expo'}
    if anchor: c['anchor'] = anchor
    return c


def snd(plan, name, start, dur, sound, offset=0, volume=1.0, spoken=False, loop=False, anchor=None, fade_in=None, fade_out=None, rate=None):
    c = {'id': uid(f'{plan}.snd.{name}'), 'startMs': start, 'durationMs': dur, 'soundId': SID[sound], 'volume': volume}
    if offset: c['offsetMs'] = offset
    if spoken: c['isSpoken'] = True
    if loop: c['loop'] = True
    if anchor: c['anchor'] = anchor
    if fade_in: c['fadeInMs'] = fade_in
    if fade_out: c['fadeOutMs'] = fade_out
    if rate: c['rate'] = rate
    return c


A = lambda clip_id, offset=0, edge='start': {'clipId': clip_id, 'edge': edge, 'offsetMs': offset}

plans = {}

# ---------------------------------------------------------------- PLAN 1 — Presentation (9,0 s)
P = 'P1'
wp1, wp2 = wp(P, '1', 520, 575, 0.9, 'right'), wp(P, '2', 650, 575, 0.9, 'right')
trav = travel(P, 'steps', 6600, 1800, {'kind': 'waypoint', 'id': wp2['id']})
plans['P1'] = {
    'id': uid('plan.P1'), 'name': 'Presentation', 'backdropFile': 'videos/P1_fern_prairie-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 400}, 'durationMs': 9000,
    'waypoints': [wp1, wp2],
    'motion': [appear(P, wp1['id']), trav],
    'anim': [anim(P, 'idle1', 0, 6600, 'Idle', 0.7), anim(P, 'idle2', 8400, 600, 'Idle', 0.7)],
    'camera': [zoom(P, 'head', 1000, 5400, {'x': 380, 'y': 250, 'w': 640, 'h': 360}, 800, 1500),
               rumble(P, 'steps', 6600, 1800, 1, 3, A(trav['id']))],
    'soundTracks': [
        {'clips': [snd(P, 'v0', 1100, 5300, '01-voice-intro', spoken=True)]},
        {'clips': [snd(P, 'pas', 6600, 1800, '05-sfx-pas', volume=0.6, anchor=A(trav['id']))]},
    ],
}

# ---------------------------------------------------------------- PLAN 2 — Giant horns (12,5 s)
# Vidéo réelle (planche 1 img/s) : petit dino entre à ≈ 4,0 s, arrive au centre ≈ 7 s, se dresse 8 → 9,5 s,
# détale ≈ 10,2 → 11,5 s. Timeline calée dessus.
P = 'P2'
wp1 = wp(P, '1', 860, 585, 0.9, 'left')
plans['P2'] = {
    'id': uid('plan.P2'), 'name': 'Giant horns', 'backdropFile': 'videos/P2_rocky_plateau-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'wipe', 'direction': 'right', 'durationMs': 400}, 'durationMs': 12500,
    'waypoints': [wp1],
    'motion': [appear(P, wp1['id'])],
    'anim': [anim(P, 'idle', 0, 12500, 'Idle', 0.7)],
    'camera': [zoom(P, 'horns', 1000, 3000, {'x': 560, 'y': 300, 'w': 560, 'h': 315}, 800, 1500),
               zoom(P, 'duo', 8000, 4500, {'x': 440, 'y': 260, 'w': 760, 'h': 428}, 600, 0)],
    'soundTracks': [
        {'clips': [snd(P, 'v1a', 900, 3000, '02-voice-1', spoken=True),
                   snd(P, 'v1b', 4700, 3300, '02-voice-1', offset=3700, spoken=True)]},
        # piste 2 (événements) : petits pas 4,0 → 7,0 s, couinement 8,5 s, gulp 9,8 s, boing 10,2 s, fuite 10,2 → 11,5 s
        # → sons Envato à importer ; laissée vide pour le test.
    ],
}

# ---------------------------------------------------------------- PLAN 3 — Nobody messes with me (14,5 s)
# Timings vidéo par défaut = script v4 (T-Rex entre 4,5 s, rugit 5,0 s, recule 7,5 s, fuit 8,0 → 9,5 s) ;
# à recaler sur la planche-contact réelle (P3_TREX_ROAR / P3_TREX_FLEE ci-dessous).
# Planche-contact réelle (24/09) : T-Rex entre 4,0 s, RUGIT 5,0 s, pas + éclaboussure 6,0 s, reste figé face au héros 7 → 10 s,
# FUIT 10,5 → 12,3 s (poussière), calme ensuite. Le héros rugit à 8,2 s (cause) → le T-Rex détale à 10,5 s (effet).
P3_TREX_ROAR = 5000     # ms : rugissement du T-Rex dans la vidéo
P3_TREX_FLEE = 10500    # ms : début de la fuite dans la vidéo
P3_HERO_ROAR = 8200     # ms : rugissement du héros (Stuck horns coupé à 2 s)
P3_DURATION = 15000     # ms : vidéo 15,04 s
P = 'P3'
wp1 = wp(P, '1', 900, 590, 0.85, 'left')
entry = travel(P, 'entry', 0, 2500, {'kind': 'waypoint', 'id': wp1['id']}, frm={'kind': 'offscreen', 'side': 'right'})
charge = anim(P, 'charge', P3_TREX_ROAR + 400, 2400, 'Charge', 2, 'once-hold')
roar = anim(P, 'roar', P3_HERO_ROAR, 2000, 'Stuck', 1, 'once-hold')
plans['P3'] = {
    'id': uid('plan.P3'), 'name': 'Nobody messes with me', 'backdropFile': 'videos/P3_swamp_clearing-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 800}, 'durationMs': P3_DURATION,
    'waypoints': [wp1],
    'motion': [entry],
    'anim': [anim(P, 'idle1', 2500, charge['startMs'] - 2500, 'Idle', 1.0), charge,
             anim(P, 'idle2', charge['startMs'] + 2400, roar['startMs'] - (charge['startMs'] + 2400), 'Idle', 0.8), roar,
             anim(P, 'idle3', roar['startMs'] + 2000, P3_DURATION - (roar['startMs'] + 2000), 'Idle', 0.8)],
    'camera': [rumble(P, 'entry', 0, 2500, 1, 3, A(entry['id'])),
               shake(P, 'trex', P3_TREX_ROAR),
               rumble(P, 'charge', charge['startMs'], 2400, 3, 8, A(charge['id'])),
               shake(P, 'roar', roar['startMs'] + 500, A(roar['id'], 500))],
    'soundTracks': [
        {'clips': [snd(P, 'growl', charge['startMs'] + 200, 1500, '25-sfx-trex-roar', volume=0.55, rate=0.6, spoken=True, anchor=A(charge['id'], 200)),
                   snd(P, 'bellow', roar['startMs'] + 500, 2000, '25-sfx-trex-roar', volume=1.0, rate=0.75, spoken=True, anchor=A(roar['id'], 500)),
                   snd(P, 'v1c', P3_TREX_FLEE + 1500, 2300, '02-voice-1', offset=7700, spoken=True)]},
        {'clips': [snd(P, 'riser', 0, P3_TREX_ROAR, '24-sfx-riser', volume=0.7, fade_out=300),
                   snd(P, 'trex-roar', P3_TREX_ROAR, 3600, '25-sfx-trex-roar', volume=1.0),
                   snd(P, 'stomp', charge['startMs'] + 400, 1450, '05-sfx-pas', offset=2250, volume=0.7, anchor=A(charge['id'], 400)),
                   snd(P, 'flee', P3_TREX_FLEE, 1800, '30-sfx-dino-flee', volume=0.8),
                   snd(P, 'whoosh', P3_TREX_FLEE + 1400, 1500, '31-sfx-whoosh', volume=0.7)]},
        {'clips': [snd(P, 'pas', 0, 2500, '05-sfx-pas', volume=0.6, anchor=A(entry['id']))]},
    ],
}

# ---------------------------------------------------------------- PLAN 4 — A dinosaur shield (12,5 s)
# Planche réelle : approche 3,5 s, cornes bloquées + poussière 4,5 → 7,5 s, oiseaux 5,5 s, séparation 8 → 10 s.
P4_BATTLE = 4500        # ms : les deux tricératops du fond s'affrontent (vidéo)
P = 'P4'
wp1 = wp(P, '1', 450, 585, 0.9, 'right')
plans['P4'] = {
    'id': uid('plan.P4'), 'name': 'A dinosaur shield', 'backdropFile': 'videos/P4_red_canyon-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 400}, 'durationMs': 12500,
    'waypoints': [wp1],
    'motion': [appear(P, wp1['id'])],
    'anim': [anim(P, 'idle', 0, 12500, 'Idle', 0.7)],
    'camera': [zoom(P, 'frill', 1000, 3000, {'x': 330, 'y': 240, 'w': 600, 'h': 338}, 800, 1200)],
    'soundTracks': [
        {'clips': [snd(P, 'v2a', 900, 3000, '03-voice-2', spoken=True),
                   snd(P, 'v2b', 4400, 3300, '03-voice-2', offset=4100, spoken=True),
                   snd(P, 'v2c', 8400, 3300, '03-voice-2', offset=8200, spoken=True)]},
        {'clips': [snd(P, 'distant-bellow', P4_BATTLE + 2200, 2000, '25-sfx-trex-roar', volume=0.25, rate=0.7)]},
    ],
}

film = {
    'version': 4,
    'plans': [plans[p] for p in ONLY],
    'character': {'scale': 1, 'facing': 'right', 'originU': 0.5, 'originV': 0.82},
    'sounds': [{'id': SID[n], 'name': n, 'file': f} for n, f in SOUNDS.items()],
    'music': {'id': uid('sound:' + MUSIC[0]), 'name': MUSIC[0], 'volume': MUSIC[2], 'loop': True, 'file': MUSIC[1]},
    'footstepsEnabled': False,
    'moveAnimationId': ANIM['Walk'],
    'moveSpeedPxPerSec': 260,
    'idleSpeedMul': 0.7,
    'intro': {'kind': 'iris', 'durationMs': 1000},
    'outro': {'kind': 'iris', 'durationMs': 1000},
    'posterMs': 1000 + 9000 + 400 + 9000,
}
out = os.path.join(HERE, OUT)
json.dump({'filmT': film}, open(out, 'w'), ensure_ascii=False, indent=1)
print('kit écrit →', out, '|', len(film['plans']), 'plan(s),', len(film['sounds']), 'sons + musique')
