#!/usr/bin/env python3
"""Kit d'import du film Tricératops **v5 « semi-manuel »** (plan de Nicolas du 25/09/2026, vidéos Grok
Imagine faites à la main → `videos-v2/P1..P6-web.mp4`). Consommé par docs/films/film_import.py.

Ids DÉTERMINISTES (uuid5, même espace de noms que build_kit.py) : les ids de sons sont identiques
au kit v4 → les fichiers voix/bruitages déjà en Storage sont simplement ré-uploadés au même chemin.

Événements DATÉS sur les planches-contact (videos-v2/P*-sheet.jpg, 1 image/s) :
  P3 : raptor au bord droit 0–2 s, CRIE 2,0 s, avance vers le centre-droit 3–7 s (reste à x ≥ 680),
       SURSAUTE 8,0 s, se retourne 9,0 s, FUIT 10,0 → 11,5 s, clairière vide dès 12 s.
  P5 : T-Rex à droite (x ≥ 600) 0–3 s, RUGIT 3,0 → 4,5 s, campé 5–7 s, SURSAUTE 8,0 s (x ≥ 500),
       se retourne 9,0 s, FUIT 10,0 → 11,5 s, poussière puis plaine vide dès 12 s.
  P4 : virevoltant traverse de droite à gauche 3 → 10 s, oiseaux 7–11 s.  P1/P2/P6 : pas d'événement.
Le héros (image 1254×1254 ajustée à la hauteur du décor × scale) fait ≈ 450 px de large à scale 0,85–0,9 :
ses positions sont choisies pour ne JAMAIS chevaucher l'adversaire (marge ≥ 50 px).

Usage : python3 build_kit_v5.py [project=<id>] [out=kit-v5-<projet>.json]
"""
import json, os, sys, uuid

opts = dict(a.split('=', 1) for a in sys.argv[1:] if '=' in a)
PROJECT = opts.get('project', 'ef7201a8-3106-4698-8752-f672c5ad023b')
OUT = opts.get('out', 'kit-v5-' + PROJECT[:8] + '.json')
HERE = os.path.dirname(os.path.abspath(__file__))

NS = uuid.uuid5(uuid.NAMESPACE_URL, 'picopop-film-triceratops-' + PROJECT[:8])
uid = lambda key: str(uuid.uuid5(NS, key))

ANIM = {   # projet Triceratops (livre DINOSAUR COLORING BOOK) — 121 frames (≈ 4,75 s/passe à ×1), Walk 120
    'Idle': '26fde2af-878f-4096-8e1c-b3bd49171dab',
    'Walk': '11186ed3-5fb9-4af4-a1dd-afe5694c97f4',
    'Charge': '824543df-a613-4813-a53c-5be5de7ec942',
    'Stuck': 'b372733c-9342-4880-9591-9f816f2a0c47',
    'Jump': 'bf746a64-a596-431f-b01c-2a3b3a67c731',
}
SOUNDS = {  # nom de bibliothèque → fichier local
    '01-voice-intro': 'voices/Audio Intro.mp3',
    '02-voice-1': 'voices/Audio 1.mp3',
    '03-voice-2': 'voices/Audio 2.mp3',
    '04-voice-3': 'voices/Audio 3.mp3',
    '05-sfx-pas': 'voices/Audio Marche.mp3',
    '24-sfx-riser': 'sounds/24-sfx-riser.mp3',
    '25-sfx-trex-roar': 'sounds/25-sfx-trex-roar.mp3',
    '30-sfx-dino-flee': 'sounds/30-sfx-dino-flee.mp3',
    '31-sfx-whoosh': 'sounds/31-sfx-whoosh.mp3',
}
MUSIC = ('30-music-ambiance-terrestre-v2', 'sounds/30-music-ambiance-terrestre-v2.wav', 0.8)
SID = {name: uid('sound:' + name) for name in SOUNDS}

OFF_L = {'kind': 'offscreen', 'side': 'left'}
OFF_R = {'kind': 'offscreen', 'side': 'right'}


def wp(plan, name, x, y, scale, facing):
    return {'id': uid(f'{plan}.wp.{name}'), 'x': x, 'y': y, 'scale': scale, 'facing': facing}


W = lambda w: {'kind': 'waypoint', 'id': w['id']}


def appear(plan, to, name='appear'):
    return {'id': uid(f'{plan}.motion.{name}'), 'startMs': 0, 'durationMs': 0, 'kind': 'appear', 'to': to}


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


def shake(plan, name, start, anchor=None, amp=16, hz=14, dur=700):
    c = {'id': uid(f'{plan}.cam.{name}'), 'startMs': start, 'durationMs': dur, 'kind': 'shake', 'amplitude': amp, 'frequencyHz': hz, 'rotate': True, 'decay': 'expo'}
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

# Voix (voices.md) : fichier, offset dans le fichier, durée du clip (phrase + 0,2 s)
V0 = ('01-voice-intro', 0, 5300)
V1a, V1b, V1c = ('02-voice-1', 0, 3000), ('02-voice-1', 3700, 3300), ('02-voice-1', 7700, 2300)
V2a, V2b, V2c = ('03-voice-2', 0, 3000), ('03-voice-2', 4100, 3300), ('03-voice-2', 8200, 3300)
V3a, V3b, V3c = ('04-voice-3', 0, 2600), ('04-voice-3', 4000, 3700), ('04-voice-3', 8800, 2000)


def voice(plan, name, start, v):
    return snd(plan, name, start, v[2], v[0], offset=v[1], spoken=True)


# Rugissements du héros : rugissement T-Rex ralenti (bibliothèque T-Rex), en attendant un son dédié.
def hero_roar(plan, name, start, anchor=None):       # beuglement plein (parlé → bouche)
    return snd(plan, name, start, 2000, '25-sfx-trex-roar', volume=1.0, rate=0.75, spoken=True, anchor=anchor)


def hero_growl(plan, name, start, anchor=None):      # grondement sourd pendant la menace (Charge)
    return snd(plan, name, start, 1500, '25-sfx-trex-roar', volume=0.5, rate=0.6, spoken=True, anchor=anchor)


def steps_loop(plan, name, start, dur, volume=0.7, anchor=None):   # bruits de pas (Audio Marche en boucle)
    return snd(plan, name, start, dur, '05-sfx-pas', volume=volume, loop=True, anchor=anchor)


def thud(plan, name, start, volume=0.9, anchor=None):              # un gros pas isolé = choc
    return snd(plan, name, start, 600, '05-sfx-pas', offset=2250, volume=volume, anchor=anchor)


GROUND = 590   # ligne de sol (y) commune, coords décor 1280×720 ; 575–600 selon le décor
plans = {}

# ---------------------------------------------------------------- PLAN 1 — Presentation · 10,0 s
# Prairie + rivière au MILIEU (x ≈ 560–700 au sol). Héros : entre par la gauche en marchant, s'arrête sur
# la rive gauche, SAUTE la rivière, atterrit rive droite, repart et sort à droite. V0 pendant la marche.
P = 'P1'
rive_g = wp(P, 'rive-g', 330, 575, 0.9, 'right')     # bord droit du héros ≈ 555 < rive 560
rive_d = wp(P, 'rive-d', 900, 575, 0.9, 'right')     # bord gauche du héros ≈ 675 (rive droite ≈ 700)
t_in = travel(P, 'entree', 0, 3200, W(rive_g), easing='easeOut', animation='Walk', speed=1.2, frm=OFF_L)
t_jump = travel(P, 'saut', 4600, 2400, W(rive_d), easing='linear', animation='Jump', speed=2.0)
t_out = travel(P, 'sortie', 7400, 2600, OFF_R, easing='easeIn', animation='Walk', speed=1.5)
plans['P1'] = {
    'id': uid('plan.P1'), 'name': 'Presentation', 'backdropFile': 'videos-v2/P1-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 400}, 'durationMs': 10000,
    'waypoints': [rive_g, rive_d],
    'motion': [t_in, t_jump, t_out],
    'anim': [anim(P, 'idle-rive', 3200, 1400, 'Idle', 0.7), anim(P, 'idle-atterri', 7000, 400, 'Idle', 0.7)],
    'camera': [rumble(P, 'pas-in', 0, 3200, 1, 3, A(t_in['id'])),
               shake(P, 'atterrissage', 7000, A(t_jump['id'], 0, 'end'), amp=10, hz=12, dur=500),
               rumble(P, 'pas-out', 7400, 2600, 1, 3, A(t_out['id']))],
    'soundTracks': [
        {'clips': [voice(P, 'v0', 800, V0)]},
        {'clips': [snd(P, 'whoosh-saut', 4600, 1500, '31-sfx-whoosh', volume=0.8, anchor=A(t_jump['id'])),
                   thud(P, 'atterrissage', 7000, anchor=A(t_jump['id'], 0, 'end'))]},
        {'clips': [steps_loop(P, 'pas-in', 0, 3200, anchor=A(t_in['id'])),
                   steps_loop(P, 'pas-out', 7400, 2600, anchor=A(t_out['id']))]},
    ],
}

# ---------------------------------------------------------------- PLAN 2 — Giant horns · 12,5 s
# Lisière (décor quasi fixe). Héros : traverse tout le cadre de gauche à droite en marchant, 3 répliques.
P = 'P2'
t_walk = travel(P, 'traversee', 0, 12500, OFF_R, easing='linear', animation='Walk', speed=1.1, frm=OFF_L)
plans['P2'] = {
    'id': uid('plan.P2'), 'name': 'Giant horns', 'backdropFile': 'videos-v2/P2-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 400}, 'durationMs': 12500,
    'waypoints': [],
    'motion': [t_walk],
    'anim': [],
    'camera': [rumble(P, 'pas', 0, 12500, 1, 3, A(t_walk['id']))],
    'soundTracks': [
        {'clips': [voice(P, 'v1a', 600, V1a), voice(P, 'v1b', 4300, V1b), voice(P, 'v1c', 8400, V1c)]},
        {'clips': [steps_loop(P, 'pas', 0, 12500, volume=0.6, anchor=A(t_walk['id']))]},
    ],
}

# ---------------------------------------------------------------- PLAN 3 — Vélociraptor · 14,5 s
# Vidéo : raptor crie 2,0 s · avance 3–7 s (x ≥ 680) · sursaute 8,0 s · se retourne 9,0 s · fuit 10,0–11,5 s.
# Héros : entre par la gauche, s'arrête à x 320 (bord droit ≈ 545) → jamais de contact.
# Cause → effet : menace (Charge) 3,8–6,2 s → RUGIT 6,2–8,2 s (son 6,5 s) → raptor sursaute 8,0 s → fuit 10,0 s.
P3_RAPTOR_CRY, P3_RAPTOR_FLINCH, P3_RAPTOR_FLEE = 2000, 8000, 10000
P = 'P3'
poste = wp(P, 'poste', 320, GROUND, 0.85, 'right')
t_in = travel(P, 'entree', 0, 2000, W(poste), easing='easeOut', animation='Walk', speed=1.3, frm=OFF_L)
menace = anim(P, 'menace', 3800, 2400, 'Charge', 2.0, 'once-hold')
roar = anim(P, 'rugit', 6200, 2000, 'Stuck', 1.0, 'once-hold')
plans['P3'] = {
    'id': uid('plan.P3'), 'name': 'Velociraptor', 'backdropFile': 'videos-v2/P3-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 500}, 'durationMs': 14500,
    'waypoints': [poste],
    'motion': [t_in],
    'anim': [anim(P, 'idle1', 2000, 1800, 'Idle', 0.8), menace, roar, anim(P, 'idle2', 8200, 6300, 'Idle', 0.8)],
    'camera': [rumble(P, 'pas', 0, 2000, 1, 3, A(t_in['id'])),
               shake(P, 'cri-raptor', P3_RAPTOR_CRY, amp=8, hz=14, dur=500),
               rumble(P, 'menace', 3800, 2400, 3, 8, A(menace['id'])),
               shake(P, 'rugit', 6500, A(roar['id'], 300))],
    'soundTracks': [
        {'clips': [hero_growl(P, 'grondement', 4000, A(menace['id'], 200)),
                   hero_roar(P, 'rugissement', 6500, A(roar['id'], 300))]},
        {'clips': [snd(P, 'cri-raptor', P3_RAPTOR_CRY, 2000, '25-sfx-trex-roar', volume=0.75, rate=1.5),
                   snd(P, 'riser', 2500, 3700, '24-sfx-riser', volume=0.6, fade_out=400),
                   thud(P, 'sursaut', P3_RAPTOR_FLINCH, volume=0.6),
                   snd(P, 'fuite', P3_RAPTOR_FLEE, 1800, '30-sfx-dino-flee', volume=0.8),
                   snd(P, 'whoosh-fuite', P3_RAPTOR_FLEE + 1000, 1500, '31-sfx-whoosh', volume=0.7)]},
        {'clips': [steps_loop(P, 'pas', 0, 2000, anchor=A(t_in['id'])),
                   snd(P, 'pietinement', 4200, 1450, '05-sfx-pas', offset=2250, volume=0.7, anchor=A(menace['id'], 400))]},
    ],
}

# ---------------------------------------------------------------- PLAN 4 — Neck frill · 14,0 s
# Canyon terreux, héros au centre. 3 répliques puis RUGISSEMENT. Le virevoltant passe derrière lui (3–10 s).
P = 'P4'
centre = wp(P, 'centre', 640, GROUND, 0.9, 'right')
roar4 = anim(P, 'rugit', 11800, 2000, 'Stuck', 1.0, 'once-hold')
plans['P4'] = {
    'id': uid('plan.P4'), 'name': 'Neck frill', 'backdropFile': 'videos-v2/P4-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 400}, 'durationMs': 14000,
    'waypoints': [centre],
    'motion': [appear(P, W(centre))],
    'anim': [anim(P, 'idle1', 0, 11800, 'Idle', 0.7), roar4, anim(P, 'idle2', 13800, 200, 'Idle', 0.7)],
    'camera': [zoom(P, 'collerette', 1000, 3200, {'x': 340, 'y': 230, 'w': 600, 'h': 338}, 800, 1200),
               shake(P, 'rugit', 12100, A(roar4['id'], 300))],
    'soundTracks': [
        {'clips': [voice(P, 'v2a', 800, V2a), voice(P, 'v2b', 4300, V2b), voice(P, 'v2c', 8300, V2c),
                   hero_roar(P, 'rugissement', 12100, A(roar4['id'], 300))]},
    ],
}

# ---------------------------------------------------------------- PLAN 5 — Face au T-Rex · 14,5 s
# Vidéo : T-Rex à droite (x ≥ 600) · RUGIT 3,0–4,5 s · campé 5–7 s · SURSAUTE 8,0 s (x ≥ 500) · se retourne 9 s ·
# FUIT 10,0–11,5 s · plaine vide dès 12 s. Héros à x 230 scale 0,85 (bord droit ≈ 445) : jamais de contact.
# Musique qui s'emballe = riser dès l'ouverture. Cause → effet : RUGIT 6,4–8,4 s (son 6,7 s) → T-Rex sursaute
# 8,0 s → fuit 10,0 s → le héros CHARGE et sort à droite 12,0–14,5 s (le T-Rex est déjà hors champ).
P5_TREX_ROAR, P5_TREX_FLINCH, P5_TREX_FLEE = 3000, 8000, 10000
P = 'P5'
face = wp(P, 'face', 230, GROUND, 0.85, 'right')
menace5 = anim(P, 'menace', 5000, 1400, 'Charge', 2.0, 'once-hold')
roar5 = anim(P, 'rugit', 6400, 2000, 'Stuck', 1.0, 'once-hold')
t_charge = travel(P, 'charge', 12000, 2500, OFF_R, easing='easeIn', animation='Charge', speed=2.0)
plans['P5'] = {
    'id': uid('plan.P5'), 'name': 'Face au T-Rex', 'backdropFile': 'videos-v2/P5-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 300}, 'durationMs': 14500,
    'waypoints': [face],
    'motion': [appear(P, W(face)), t_charge],
    'anim': [anim(P, 'idle1', 0, 5000, 'Idle', 0.8), menace5, roar5, anim(P, 'idle2', 8400, 3600, 'Idle', 0.8)],
    'camera': [shake(P, 'rugit-trex', P5_TREX_ROAR, amp=14, hz=12),
               rumble(P, 'menace', 5000, 1400, 3, 8, A(menace5['id'])),
               shake(P, 'rugit', 6700, A(roar5['id'], 300)),
               rumble(P, 'charge', 12000, 2500, 4, 8, A(t_charge['id']))],
    'soundTracks': [
        {'clips': [hero_growl(P, 'grondement', 5200, A(menace5['id'], 200)),
                   hero_roar(P, 'rugissement', 6700, A(roar5['id'], 300)),
                   hero_growl(P, 'grondement-charge', 12200, A(t_charge['id'], 200))]},
        {'clips': [snd(P, 'riser', 0, P5_TREX_ROAR, '24-sfx-riser', volume=0.8, fade_out=300),
                   snd(P, 'rugit-trex', P5_TREX_ROAR, 3600, '25-sfx-trex-roar', volume=1.0),
                   thud(P, 'sursaut', P5_TREX_FLINCH, volume=0.7),
                   snd(P, 'fuite', P5_TREX_FLEE, 1800, '30-sfx-dino-flee', volume=0.9),
                   snd(P, 'whoosh-fuite', P5_TREX_FLEE + 1200, 1500, '31-sfx-whoosh', volume=0.7),
                   snd(P, 'whoosh-charge', 12000, 1500, '31-sfx-whoosh', volume=0.8, anchor=A(t_charge['id']))]},
        {'clips': [snd(P, 'pietinement', 5400, 1000, '05-sfx-pas', offset=2250, volume=0.7, anchor=A(menace5['id'], 400)),
                   steps_loop(P, 'pas-charge', 12000, 2500, volume=0.8, anchor=A(t_charge['id']))]},
    ],
}

# ---------------------------------------------------------------- PLAN 6 — Poursuite · 12,0 s
# Travelling : le T-Rex court dans la moitié droite pendant tout le clip ; le héros court SUR PLACE à gauche
# (Walk ×2,5 + rumble), 2 répliques. Fin du film (outro iris).
P = 'P6'
course = wp(P, 'course', 300, 600, 0.9, 'right')
plans['P6'] = {
    'id': uid('plan.P6'), 'name': 'Poursuite', 'backdropFile': 'videos-v2/P6-web.mp4', 'cameraX': 640,
    'transitionToNext': {'kind': 'crossfade', 'durationMs': 300}, 'durationMs': 12000,
    'waypoints': [course],
    'motion': [appear(P, W(course))],
    'anim': [anim(P, 'course', 0, 12000, 'Walk', 2.5)],
    'camera': [rumble(P, 'course', 0, 12000, 2, 3)],
    'soundTracks': [
        {'clips': [voice(P, 'v3b', 1500, V3b), voice(P, 'v3c', 7000, V3c)]},
        {'clips': [steps_loop(P, 'pas', 0, 12000, volume=0.7)]},
    ],
}

ORDER = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']
INTRO = 1000
# Poster : plan 5 à 3,2 s (le T-Rex rugit face au héros)
poster = INTRO + sum(plans[p]['durationMs'] + plans[p]['transitionToNext']['durationMs'] for p in ORDER[:4]) + 3200
film = {
    'version': 4,
    'plans': [plans[p] for p in ORDER],
    'character': {'scale': 1, 'facing': 'right', 'originU': 0.5, 'originV': 0.82},
    'sounds': [{'id': SID[n], 'name': n, 'file': f} for n, f in SOUNDS.items()],
    'music': {'id': uid('sound:' + MUSIC[0]), 'name': MUSIC[0], 'volume': MUSIC[2], 'loop': True, 'file': MUSIC[1]},
    'footstepsEnabled': False,
    'moveAnimationId': ANIM['Walk'],
    'moveSpeedPxPerSec': 260,
    'idleSpeedMul': 0.7,
    'intro': {'kind': 'iris', 'durationMs': INTRO},
    'outro': {'kind': 'iris', 'durationMs': 1000},
    'posterMs': poster,
}
out = os.path.join(HERE, OUT)
json.dump({'filmT': film}, open(out, 'w'), ensure_ascii=False, indent=1)
total = INTRO + sum(p['durationMs'] for p in film['plans']) + sum(p['transitionToNext']['durationMs'] for p in film['plans'][:-1]) + 1000
print('kit écrit →', out, '|', len(film['plans']), 'plans,', len(film['sounds']), 'sons + musique | durée totale ≈', total / 1000, 's | poster', poster, 'ms')
