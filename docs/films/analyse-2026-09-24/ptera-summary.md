# PTERANODON — film (6 plans)

Personnage : facing left, scale 1, origine (0.50, 1.00) · moveSpeed 260 · intro {'durationMs': '1000', 'kind': 'iris'} · outro {'kind': 'iris', 'durationMs': '1000'} · poster 0.0s · footsteps défaut ×1.3
Animations : Idle [cotracker-bones, 4 pas], Action [cotracker-bones, 0 pas], Poisson [cotracker-bones, 11 pas]

Bibliothèque sons : Audio Intro.mp3 (6.4s), Audio 1.mp3 (10.8s), Audio 2.mp3 (12.0s), Audio 3.mp3 (8.4s), hf_20260916_133617_571da6a7-1303-4fa6-b5a0-89f0529f609a.mp4 (10.0s), ElevenLabs_2026-09-16T13_42_18_Crazy Eddie_pvc_s50_m2.mp3 (4.7s), Audio 3.mp3 (8.4s), 11832 angry bird mid attack-full.mp3 (1.4s), ElevenLabs_2026-09-16T14_17_36_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 (2.0s), Dinosaur T-Rex.wav (3.9s), Dinosaur T-Rex.wav (3.9s), TRexMoanCall PE980802.wav (5.1s), T Rex Dinosaur Growl 1.wav (10.5s), Fly Like A Bird.mp3 (159.8s), Track (WAV).wav (102.0s), OhmLab_Thrill-Riser.mp3 (12.0s), Fly Like A Bird.mp3 (159.8s), In the Forest.mp3 (128.4s), Seagulls Coast Seaside Ambience.wav (81.0s), Sea Waves_01.wav (19.3s), ElevenLabs_2026-09-16T14_59_00_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 (3.6s), ElevenLabs_2026-09-16T14_59_30_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 (1.2s), ElevenLabs_2026-09-16T14_59_42_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 (1.3s), ElevenLabs_2026-09-16T15_13_03_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 (4.0s)
Pistes globales : [{"clips": [{"durationMs": "36649", "fadeInMs": "1500", "fadeOutMs": "1900", "volume": 0.25, "soundId": "2d80a2e1-1f9b-47d5-a1f9-e2e0f67fe865", "id": "09717af1-7b51-4b7e-b2ad-b76d0bd07995", "startMs": "0"}, {"id": "c1c0b81f-2537-4a09-8d53-e916cf4ccb57", "startMs": "47885", "volume": 0.3, "soundId": "246e157a-34e9-43e0-87cb-96fe2fed0e2c", "fadeInMs": "2300", "durationMs": "23072"}]}, {"clips": [{"durationMs": "13139", "volume": 0.3, "id": "780b9958-b9ee-4f25-a22e-915f1a5d3f29", "fadeOutMs": "1500", "soundId": "771b5fb9-40ae-46c8-a6bf-8e16ca419401", "startMs": "36163"}, {"soundId": "400c4407-61f

## Plan 1 «  » — 9.0s · décor vidéo 1280×720 · fichier 12.0s 1280×720 · cameraX 640 · overlay non · transition → cut ms 
Waypoints : e489(653,602 ×0.80), 3a71(1451,412 ×0.35)
    0.0s ANIM    Idle loop ×1.3 0.0s→4.5s
    0.0s CAMÉRA  bob 0.0s→4.5s amp 10 1Hz   ⚓
    0.0s MOTION  appear ∅ → WP(653,602) 0.0s→0.0s anim=défaut ×1 easing= CP=0
    0.5s SON1    Audio Intro.mp3 0.5s→6.9s vol 1 rate 1 PARLÉ
    4.5s CAMÉRA  bob 4.5s→9.0s amp 10 1.3Hz  
    4.5s MOTION  travel ∅ → WP(1451,412) 4.5s→9.0s anim=Idle ×2 easing= CP=1

## Plan 2 «  » — 13.5s · décor vidéo 1280×720 · fichier 15.0s 1280×720 · cameraX 640 · overlay non · transition → wipe ms 
Waypoints : 9ff9(375,756 ×1.20 right)
    0.0s CAMÉRA  bob 0.0s→13.4s amp 10 1.3Hz   ⚓
    0.0s MOTION  appear ∅ → WP(375,756) 0.0s→0.0s anim=défaut ×1 easing= CP=0
    0.0s ANIM    Idle once-hold ×1.5 0.0s→13.4s
    0.6s SON1    Audio 1.mp3 0.6s→11.5s vol 1 rate 1 PARLÉ

## Plan 3 «  » — 12.7s · décor vidéo 1280×720 · fichier 14.0s 1280×720 · cameraX 640 · overlay non · transition → cut ms 
Waypoints : 85cb(563,561 ×0.75)
    0.0s CAMÉRA  bob 0.0s→6.0s amp 6 1.25Hz   ⚓
    0.0s MOTION  travel libre(1180,318) → WP(563,561) 0.0s→6.0s anim=Idle ×1.5 easing= CP=0
    0.3s SON1    Audio 2.mp3 0.3s→2.8s vol 1 rate 1 PARLÉ
    3.7s SON1    Audio 2.mp3 3.7s→8.0s vol 1 rate 1 PARLÉ offset 3.6s
    6.0s ANIM    Idle loop ×1.4 6.0s→12.7s
    6.0s CAMÉRA  bob 6.0s→12.7s amp 7 1.15Hz  
    8.7s SON1    Audio 2.mp3 8.7s→11.9s vol 1 rate 1 PARLÉ offset 8.8s

## Plan 4 «  » — 12.8s · décor vidéo 1280×720 · fichier 10.0s 1280×720 · cameraX 640 · overlay non · transition → wipe ms 
Waypoints : 0970(99,973 ×1.15 right), 2d2f(644,276 ×0.50), 1fb9(676,266 ×0.50), 598c(527,264 ×0.50), dffb(537,78 ×0.50), 7c84(1387,317 ×0.50)
    0.0s ANIM    Idle loop ×1.3 0.0s→3.5s
    0.0s CAMÉRA  bob 0.0s→12.8s amp 8 1.25Hz   ⚓
    0.0s MOTION  appear ∅ → WP(99,973) 0.0s→0.0s anim=défaut ×1.8 easing= CP=1
    0.0s MOTION  travel ∅ → WP(644,276) 0.0s→2.4s anim=défaut ×2.4 easing= CP=0
    0.0s SON1    Dinosaur T-Rex.wav 0.0s→3.9s vol 1 rate 1
    0.0s SON3    ElevenLabs_2026-09-16T14_59_00_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 0.0s→3.6s vol 1 rate 1 PARLÉ
    0.5s SON2    T Rex Dinosaur Growl 1.wav 0.5s→11.0s vol 0.65 rate 1
    3.5s ANIM    Idle loop ×2 3.5s→4.8s
    3.5s MOTION  travel ∅ → WP(676,266) 3.5s→4.8s anim=défaut ×1 easing= CP=1
    3.9s SON1    TRexMoanCall PE980802.wav 3.9s→7.2s vol 1 rate 1.5
    4.8s ANIM    Idle loop ×1.5 4.8s→5.8s
    5.8s SON3    ElevenLabs_2026-09-16T14_59_30_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 5.8s→7.0s vol 1 rate 1 PARLÉ
    5.8s ANIM    Idle loop ×1.8 5.8s→8.6s
    5.8s MOTION  travel ∅ → WP(527,264) 5.8s→7.0s anim=défaut ×1 easing= CP=0
    6.9s SON1    TRexMoanCall PE980802.wav 6.9s→12.0s vol 1 rate 1.5
    7.0s MOTION  travel ∅ → WP(537,78) 7.0s→8.6s anim=défaut ×1 easing= CP=0
    7.9s SON2    T Rex Dinosaur Growl 1.wav 7.9s→12.8s vol 0.55 rate 1
    8.6s ANIM    Idle loop ×1.5 8.6s→12.8s
    8.9s SON3    ElevenLabs_2026-09-16T14_59_42_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 8.9s→10.2s vol 1 rate 1 PARLÉ
    9.6s MOTION  travel ∅ → WP(1387,317) 9.6s→11.6s anim=défaut ×1 easing= CP=1

## Plan 5 «  » — 8.4s · décor vidéo 1280×720 · fichier 10.0s 1280×720 · cameraX 640 · overlay non · transition → crossfade ms 
Waypoints : e635(747,550 ×0.85), 626e(1287,354 ×0.35)
    0.0s ANIM    Idle loop ×1.3 0.0s→5.0s
    0.0s MOTION  travel libre(-216,644) → WP(747,550) 0.0s→5.0s anim=défaut ×1 easing= CP=0
    0.0s SON1    Audio 3.mp3 0.0s→8.4s vol 1 rate 1 PARLÉ
    5.0s ANIM    Idle loop ×1.6 5.0s→8.4s
    5.0s MOTION  travel ∅ → WP(1287,354) 5.0s→8.4s anim=défaut ×1 easing= CP=0

## Plan 6 «  » — 10.0s · décor vidéo 1280×720 · fichier 12.0s 1280×720 · cameraX 640 · overlay non · transition → cut ms 
Waypoints : 2c05(738,578 ×0.80 left)
    0.0s ANIM    Poisson loop ×1.8 0.0s→5.8s
    0.0s CAMÉRA  bob 0.0s→5.8s amp 5 1.55Hz   ⚓
    0.0s MOTION  appear ∅ → WP(738,578) 0.0s→0.0s anim=défaut ×1 easing= CP=0
    0.9s SON1    ElevenLabs_2026-09-16T14_17_36_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 0.9s→2.9s vol 1 rate 1 PARLÉ
    2.8s SON2    11832 angry bird mid attack-full.mp3 2.8s→4.2s vol 1 rate 1
    4.2s SON1    ElevenLabs_2026-09-16T15_13_03_Crazy Eddie_pvc_sp120_s60_sb54_v3.mp3 4.2s→8.2s vol 1 rate 1 PARLÉ
    5.8s ANIM    Poisson loop ×1.5 5.8s→10.0s
    5.8s CAMÉRA  bob 5.8s→10.0s amp 5 1.25Hz  
    8.5s SON2    11832 angry bird mid attack-full.mp3 8.5s→9.9s vol 1 rate 1

Durée totale des plans : 66.4s (+ intro/outro)