#!/usr/bin/env python3
"""Kit du film VÉLOCIRAPTOR — premier film monté avec docs/films/filmkit.py (PLAYBOOK §7 bis), profil AGILE.
Héros DESSINÉ VERS LA GAUCHE. Image 1254² → ≈ 500 px de large à l'échelle 1.

Vidéos de Nicolas (videos/P1..P6-web.mp4, 15 s), événements lus sur les planches (videos/P*-sheet.jpg) :
  P1 aube : rien ne bouge.                       P2 automne : dinde picore 0–4 s, s'alarme 4 s, s'envole/court à droite 5 s, partie 6 s.
  P3 orage : T-Rex à droite, GROS ÉCLAIR + rugit 2–3 s, rugit encore 4 s, 7 s, 10 s ; jamais ne bouge.
  P4 orage : T-Rex ENTRE par la droite dès 0 s (pas 2 s), traverse, sort à gauche vers 12 s ; éclair 8 s ; vide 12–15 s.
  P5 nuit : copain assis à droite 0–7 s ; NUAGE MAGIQUE sur lui 7–8 s ; il ressort AVEC DES PLUMES dès 9 s (la vidéo
            fait la transformation : on la sonorise avec « magic-appearing », c'est le COPAIN qui devient fluffy).
  P6 pluie : mouton tremble 0–3 s, bêle 3–4 s, se retourne 4–5 s, court à droite 5–8 s (flaque 7 s), parti 8 s.
Voix (voices/voices-words.json) : Intro 3,3 s « Hey I'm Velociraptor, a fast and clever hunter » 0–3,12 ·
  Audio 1 7,4 s : « I was much smaller than a T-Rex » 0–2,06 · « I was only about as tall as a grown-up turkey » 2,72–4,86
  · « But I was super fast » 5,40–7,22 · Audio 2 6,5 s : « Scientists think I had feathers on my body » 0–2,40 · « I may
  have looked more bird-like than scary » 2,98–4,94 · « Fluffyraptor » 5,82–6,36 · Audio 3 4,3 s : « Look at my sharp
  curved claws » 0–1,78 · « I use them to grab and hold prey » 2,32–4,16 (pas de « Scratch scratch » enregistré).
Sons fournis par Nicolas (sounds/) : pluie, tonnerre, 4 cris de raptor, bêlement (découpé 3,6–6,2 s), apparition magique.
Walk = 68 images (2,8 s à ×1) ; pas de course attachés à l'animation (frames 10/27/44/61).
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from filmkit import Kit, AGILE, OFF_L, OFF_R

PROJECT = 'a74870f36-4752-4d9f-933c-351d1ceeb12d'[1:]   # Dino 10 - Velociraptor (copie), livre DINOSAUR COLORING BOOK
HERE = os.path.dirname(os.path.abspath(__file__))
ANIM = {'Idle': 'cf23cb82-81f0-4b7e-9fd9-bddd4b322974', 'Walk': '32b23129-4d89-40e6-a07d-b73c0dcef7d0',
        'Action': '5d145b97-d039-4306-a3e0-1f8a60ee1fae', 'Discours3': 'd520b73d-d89b-41b9-abe5-51e6dd22677c'}
VOICES = {'01-voice-intro': 'voices/Audio Intro.mp3', '02-voice-1': 'voices/Audio 1.mp3', '03-voice-2': 'voices/Audio 2.mp3', '04-voice-3': 'voices/Audio 3.mp3'}
SOUNDS = {'10-amb-rain': 'sounds/rain.mp3', '20-sfx-thunder': 'sounds/thunder.mp3', '21-sfx-raptor-cry-1': 'sounds/raptor-roar-1.mp3',
          '22-sfx-raptor-cry-2': 'sounds/raptor-roar-2.mp3', '23-sfx-raptor-cry-3': 'sounds/raptor-roar-3.mp3', '24-sfx-raptor-cry-4': 'sounds/raptor-roar-4.mp3',
          '30-sfx-sheep-bleat': 'sounds/sheep-bleat.mp3', '31-sfx-magic-appearing': 'sounds/magic-appearing.mp3'}
k = Kit('velociraptor', PROJECT, AGILE, ANIM, VOICES, facing='left', sounds=SOUNDS, here=HERE)
S = k.scale_alone()   # 1,1 seul
RUN = AGILE.run_speed

# ---------------------------------------------------------------- P1 — Presentation · 8 s (aube, chemin vide)
# Déboule à ×4 en 1,2 s, freine, se présente (idle nerveux), repart aussi vite par la droite.
P = k.plan('P1', 'Presentation', 'videos/P1-web.mp4', 8000, kind='calme')
pose = k.wp(P, 'pose', 560, k.ground(650), S, 'right')
k.entry(P, pose, 'left', duration=1200, speed=RUN)
k.anim(P, 'idle', 1200, 4800, 'Idle', 1.2)
k.voice(P, 'v0', 1500, '01-voice-intro', 3300)
k.zoom(P, 'tete', 1500, 3300, {'x': 310, 'y': 200, 'w': 660, 'h': 370}, 500, 800)
k.travel(P, 'sortie', 6000, 1200, OFF_R, easing='easeIn', animation='Walk', speed=RUN)
k.rumble(P, 'sortie', 6000, 1200, 1.5, 4)
k.sound(P, 'cri-entree', 200, 2800, '22-sfx-raptor-cry-2', volume=0.8, track=1)
k.ambience(P, 'forêt à l’aube, oiseaux (loop)')

# ---------------------------------------------------------------- P2 — Turkey · 8,5 s (automne, dinde picore puis fuit à 5 s)
# Petit face à la dinde (échelle 0,8), entre, deux phrases, la dinde s'alarme à 4 s → il crie et la poursuit hors champ.
P = k.plan('P2', 'Turkey', 'videos/P2-web.mp4', 8500, kind='calme')
guet = k.wp(P, 'guet', 420, k.ground(655), 0.8, 'right')
k.entry(P, guet, 'left', duration=1200, speed=RUN)
k.anim(P, 'idle', 1200, 3600, 'Idle', 1.2)
k.voice(P, 'v1a', 1400, '02-voice-1', 2300)
k.voice(P, 'v1b', 3700, '02-voice-1', 2300, offset=2720)
chase = k.travel(P, 'poursuite', 4800, 1500, OFF_R, easing='easeIn', animation='Walk', speed=RUN)
k.rumble(P, 'poursuite', 4800, 1500, 1.5, 4, anchor=k.A(chase['id']))
k.voice(P, 'v1c', 6000, '02-voice-1', 2000, offset=5400)
k.sound(P, 'cri-chasse', 4600, 3000, '21-sfx-raptor-cry-1', volume=0.9, track=1)
k.slot(P, 'ÉVÉNEMENT', 4000, 2500, 'glouglou / envol de la dinde (elle s’alarme 4 s, part 5 s)', volume=0.8)
k.ambience(P, 'vent d’automne, feuilles (loop)')

# ---------------------------------------------------------------- P3 — T-Rex · 6,5 s (orage ; ÉCLAIR + rugissement 2–3 s) — MUET
# Arrive au centre-gauche, sursaute sur le tonnerre (Action ×3), fuit par la GAUCHE à 4,2 s.
P = k.plan('P3', 'T-Rex', 'videos/P3-web.mp4', 6500, kind='confrontation')
oree = k.wp(P, 'oree', 380, k.ground(665), k.scale_vs_big(), 'right')
k.entry(P, oree, 'left', duration=1200, speed=RUN)
k.anim(P, 'idle', 1200, 1100, 'Idle', 1.3)
sursaut = k.anim(P, 'sursaut', 2300, 1700, 'Action', 3.0, 'once-hold')
fuite = k.travel(P, 'fuite', 4200, 1000, OFF_L, easing='easeIn', animation='Walk', speed=RUN)
k.rumble(P, 'fuite', 4200, 1000, 1.5, 4, anchor=k.A(fuite['id']))
k.shake(P, 'tonnerre', 2000, amp=22, hz=12, dur=1500)
k.sound(P, 'pluie', 0, 6500, '10-amb-rain', volume=0.5, track=2, loop=True, fade_in=300)
k.sound(P, 'tonnerre', 2000, 5700, '20-sfx-thunder', volume=1.0, track=1)
k.sound(P, 'cri-peur', 2500, 5200, '23-sfx-raptor-cry-3', volume=0.9, track=3)
k.slot(P, 'RUGISSEMENT T-REX', 2200, 3500, 'rugissement T-Rex (bibliothèque des autres films), doublé à 4,0 s', volume=1.0)

# ---------------------------------------------------------------- P4 — Chase · 12 s (orage, le T-Rex traverse 0 → 12 s)
# Le héros traverse en 1,4 s DEVANT le T-Rex qui entre à 0 s, puis le T-Rex défile seul jusqu'à 12 s.
P = k.plan('P4', 'Chase', 'videos/P4-web.mp4', 12000, kind='confrontation')
trav = k.travel(P, 'traversee', 0, 1400, OFF_L, easing='linear', animation='Walk', speed=RUN, frm={'kind': 'free', 'x': 1400, 'y': 650})
k.rumble(P, 'raptor', 0, 1400, 1.5, 4, anchor=k.A(trav['id']))
k.rumble(P, 'trex', 1400, 10600, 4, 2)
k.shake(P, 'eclair', 8000, amp=16, hz=12, dur=1200)
k.sound(P, 'pluie', 0, 12000, '10-amb-rain', volume=0.5, track=2, loop=True)
k.sound(P, 'tonnerre', 7800, 5700, '20-sfx-thunder', volume=0.9, track=1)
k.sound(P, 'cri-fuite', 100, 2800, '22-sfx-raptor-cry-2', volume=0.8, track=3)
k.slot(P, 'PAS LOURDS T-REX', 1000, 11000, 'pas lourds réguliers pendant la traversée du T-Rex (0,6 s d’intervalle)', volume=0.9)
k.slot(P, 'MUSIQUE', 0, 12000, 'poursuite nerveuse (peut démarrer au plan 3 en piste globale)', volume=0.6)

# ---------------------------------------------------------------- P5 — Feathers · 11,5 s (nuit, le copain devient fluffy à 7–9 s)
# Arrive sans courir (×2,5), Discours 3 pendant les 2 phrases, puis nuage magique sur le copain à 7 s → « Fluffyraptor » à 9,4 s.
P = k.plan('P5', 'Feathers', 'videos/P5-web.mp4', 11500, kind='calme')
copain = k.wp(P, 'copain', 420, k.ground(650), S, 'right')
k.entry(P, copain, 'left', duration=1800, speed=2.5)
k.anim(P, 'parle', 1800, 5600, 'Discours3', 1.0, 'once-hold')
k.voice(P, 'v2ab', 2200, '03-voice-2', 5200)
k.zoom(P, 'tete', 2200, 5000, {'x': 200, 'y': 220, 'w': 660, 'h': 370}, 600, 900)
k.anim(P, 'surprise', 7400, 1600, 'Action', 3.0, 'once-hold')
k.anim(P, 'idle', 9000, 2500, 'Idle', 1.2)
k.zoom(P, 'copain', 7000, 3500, {'x': 700, 'y': 250, 'w': 580, 'h': 326}, 500, 800)
k.voice(P, 'v2c', 9400, '03-voice-2', 900, offset=5820)
k.sound(P, 'magie', 6800, 4000, '31-sfx-magic-appearing', volume=0.9, track=1)
k.ambience(P, 'nuit : grillons, chouette (loop)')

# ---------------------------------------------------------------- P6 — Claws · 7,5 s (pluie ; mouton bêle 3 s, fuit 5–8 s)
# Face au mouton : griffes (Action) sur la 1ʳᵉ phrase, bêlement, 2ᵉ phrase, le mouton détale → il crie et le poursuit.
P = k.plan('P6', 'Claws', 'videos/P6-web.mp4', 7500, kind='calme')
face = k.wp(P, 'face', 400, k.ground(640), S, 'right')
k.entry(P, face, 'left', duration=1200, speed=RUN)
k.anim(P, 'griffes', 1300, 2400, 'Action', 2.0, 'once-hold')
k.voice(P, 'v3a', 1600, '04-voice-3', 2000)
k.zoom(P, 'griffes', 1300, 2600, {'x': 200, 'y': 260, 'w': 620, 'h': 350}, 500, 800)
k.anim(P, 'idle', 3700, 1700, 'Idle', 1.2)
k.voice(P, 'v3b', 4000, '04-voice-3', 2000, offset=2320)
k.sound(P, 'belement', 3100, 2600, '30-sfx-sheep-bleat', volume=0.9, track=1)
chase6 = k.travel(P, 'poursuite', 5400, 1300, OFF_R, easing='easeIn', animation='Walk', speed=RUN)
k.rumble(P, 'poursuite', 5400, 1300, 1.5, 4, anchor=k.A(chase6['id']))
k.sound(P, 'cri-chasse', 5300, 3000, '24-sfx-raptor-cry-4', volume=0.9, track=3)
k.sound(P, 'pluie', 0, 7500, '10-amb-rain', volume=0.35, track=2, loop=True, fade_in=300)
k.slot(P, 'ÉVÉNEMENT', 6800, 800, 'splash de flaque quand le mouton la traverse (7 s)', volume=0.7)

k.slot(k.plans['P1'], 'MUSIQUE GLOBALE', 0, 60000, 'ambiance forêt continue (0,4) + musique nerveuse dès le plan 2 (0,5) : à poser en pistes globales', volume=0.5)
k.write(order=['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], intro_ms=800, outro_ms=800, poster_ms=800 + 8000 + 500 + 8500 + 500 + 2600)
