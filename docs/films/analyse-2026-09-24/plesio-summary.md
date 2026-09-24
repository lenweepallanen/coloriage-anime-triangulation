# PLESIOSAURUS — film (5 plans)

Personnage : facing left, scale 1, origine (0.50, 1.00) · moveSpeed 260 · intro {'kind': 'iris', 'durationMs': '1000'} · outro {'durationMs': '400', 'kind': 'iris'} · poster 0.0s · footsteps défaut ×1
Animations : Idle [cotracker-bones, 0 pas], Jump [cotracker-bones, 0 pas], Discours 2 [cotracker-bones, 0 pas]
Musique : Underwater.wav (122.3s, volume 0.75)

Bibliothèque sons : Audio Intro.mp3 (6.3s), Audio 2.mp3 (7.0s), Audio 1.mp3 (11.7s), Whales_WAV.wav (9.2s), OhmLab_Thrill-Riser.mp3 (12.0s), Audio 1.mp3 (11.7s), Whales_WAV.wav (9.2s), OhmLab_Thrill-Riser.mp3 (12.0s), Monster Roar.wav (7.0s), Audio 2.mp3 (7.0s), Audio 3.mp3 (8.1s), Comical Fear Yell.wav (1.9s), Sharks.wav (67.2s), Monster Roar.wav (7.0s), Monster Roar.wav (7.0s), Elements Water Logo 16 (water).wav (14.0s), Boat_Crash_ODY-1374-039.wav (3.4s), Underwater.wav (237.8s), Underwater.wav (237.8s)
Pistes globales : [{"clips": [{"durationMs": "13674", "fadeInMs": "1000", "offsetMs": "17150", "fadeOutMs": "1100", "startMs": "18749", "id": "f1118ecb-a41c-4dbb-8818-e98f1a274797", "soundId": "617484f4-2ee1-4f37-9076-0933063fa518"}]}, {"clips": [{"id": "304be4f4-6573-4efe-ab8c-0c0b653874c4", "soundId": "64764a07-4e39-4738-8193-dbc441b1ea39", "startMs": "20817", "volume": 0.8, "durationMs": "5669"}, {"startMs": "28000", "soundId": "64764a07-4e39-4738-8193-dbc441b1ea39", "id": "14d9b3fe-b78e-4b69-8f2d-0c346d38da2e", "fadeOutMs": "900", "offsetMs": "406", "durationMs": "4423", "volume": 0.8}]}, {"clips": [{"durat

## Plan 1 « I'm plesiosaurus » — 9.5s · décor vidéo 1280×720 · fichier 12.0s 1280×720 · cameraX 640 · overlay non · transition → wipe ms 
Waypoints : 4ad1(650,702 ×0.85 right)
    0.0s ANIM    Idle once-hold ×1 0.0s→9.5s
    0.0s CAMÉRA  zoom 0.0s→4.9s rect(169,105,882×496) in 0 hold None out 3000
    0.0s MOTION  travel libre(-128,633) → WP(650,702) 0.0s→8.1s anim=défaut ×1 easing= CP=0
    2.7s SON1    Audio Intro.mp3 2.7s→9.0s vol 1 rate 1 PARLÉ

## Plan 2 «  » — 11.4s · décor vidéo 1280×720 · fichier 14.0s 1280×720 · cameraX 640 · overlay non · transition → crossfade 300ms 
Waypoints : 7223(345,591 ×0.60 right), c121(-392,492 ×0.50)
    0.0s MOTION  travel libre(-293,661) → WP(345,591) 0.0s→7.7s anim=défaut ×1 easing= CP=0
    0.0s SON1    Audio 1.mp3 0.0s→3.5s vol 1 rate 1 PARLÉ
    4.0s SON1    Audio 1.mp3 4.0s→7.9s vol 1 rate 1 PARLÉ offset 4.6s
    8.1s SON4    Comical Fear Yell.wav 8.1s→10.0s vol 1 rate 1
    8.2s ANIM    Jump once-hold ×3 8.2s→9.9s
    9.9s CAMÉRA  rumble 9.9s→11.4s amp 4 8Hz   ⚓
    9.9s MOTION  travel ∅ → WP(-392,492) 9.9s→11.4s anim=défaut ×3 easing= CP=0

## Plan 3 «  » — 9.3s · décor vidéo 1264×720 · fichier 10.0s 1264×720 · cameraX 632 · overlay non · transition → wipe 1000ms 
Waypoints : d938(485,513 ×0.40 left), 9894(-265,545 ×0.40)
    0.0s CAMÉRA  rumble 0.0s→7.4s amp 4 8Hz   ⚓
    0.0s MOTION  appear ∅ → WP(485,513) 0.0s→0.0s anim=défaut ×1 easing= CP=0
    0.0s MOTION  travel ∅ → WP(-265,545) 0.0s→5.5s anim=Idle ×3 easing= CP=0
    0.0s ANIM    Idle loop ×3 0.0s→7.4s

## Plan 4 «  » — 10.2s · décor vidéo 1280×720 · fichier 11.0s 1280×720 · cameraX 640 · overlay non · transition → cut ms 
Waypoints : c9fe(620,894 ×0.75 right), 1dc1(311,659 ×0.75), 4d61(635,499 ×0.75)
    0.0s MOTION  appear ∅ → WP(620,894) 0.0s→0.0s anim=Idle ×1 easing= CP=0
    0.0s SON1    Audio 2.mp3 0.0s→7.0s vol 1 rate 1 PARLÉ
    1.7s ANIM    Discours 2 loop ×1.9 1.7s→4.3s
    4.2s MOTION  travel ∅ → WP(311,659) 4.2s→6.8s anim=Idle ×2.5 easing= CP=0
    6.8s MOTION  travel ∅ → WP(635,499) 6.8s→10.2s anim=Idle ×2.4 easing= CP=0

## Plan 5 «  » — 14.6s · décor vidéo 1280×720 · fichier 15.0s 1280×720 · cameraX 640 · overlay non · transition → cut ms 
Waypoints : c93e(242,655 ×0.85), edf9(272,554 ×0.85), f8de(323,647 ×0.85), e016(354,559 ×0.85)
    0.0s MOTION  travel hors-champ left → WP(242,655) 0.0s→5.4s anim=défaut ×1 easing= CP=0
    1.9s SON1    Audio 3.mp3 1.9s→10.0s vol 1 rate 1 PARLÉ
    6.6s CAMÉRA  zoom 6.6s→9.6s rect(358,136,809×455) in None hold None out None
    6.9s MOTION  travel ∅ → WP(272,554) 6.9s→8.9s anim=défaut ×1 easing= CP=0
    9.7s MOTION  travel ∅ → WP(323,647) 9.7s→11.7s anim=défaut ×1 easing= CP=0
   12.6s MOTION  travel ∅ → WP(354,559) 12.6s→14.6s anim=défaut ×1 easing= CP=0

Durée totale des plans : 55.0s (+ intro/outro)