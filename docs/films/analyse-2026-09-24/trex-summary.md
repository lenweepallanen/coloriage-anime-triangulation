# T-REX — film (5 plans)

Personnage : facing left, scale 1, origine (0.51, 0.81) · moveSpeed 260 · intro {'durationMs': '1000', 'kind': 'iris'} · outro {'kind': 'iris', 'durationMs': '1000'} · poster 24.6s · footsteps défaut ×1
Animations : Idle [cotracker-bones, 0 pas], Action [cotracker-bones, 0 pas], Walk [marche, 12 pas], Walk - Discours 3 [marche, 0 pas]
Musique : Ambiance terrestre V2.wav (65.4s, volume 1)

Bibliothèque sons : Audio Intro.mp3 (7.5s), Audio 1.mp3 (13.6s), Audio 3.mp3 (10.9s), Audio 3.mp3 (10.9s), 53439420-t-rex-victory-roar-469053.mp3 (3.6s), Audio Intro.mp3 (7.5s), Audio 2.mp3 (13.6s), hf_20260806_163632_ad13d5e5-36bf-4dfc-b690-01b8d9c7337b.mp4 (13.1s), 53439420-t-rex-victory-roar-469053.mp3 (3.6s), 53439420-t-rex-victory-roar-469053.mp3 (3.6s), dinosaur flee.mp3 (4.2s), suspense sound.mp3 (12.3s), suspense sound.mp3 (12.3s), pterodactyle cry.mp3 (1.1s), pterodactyle cry.mp3 (1.1s), Audio 1.mp3 (13.6s), dino audio 1-2.MP3 (8.1s), dino audio 1-1.MP3 (5.6s), soundreality-whoosh-apparition-386140.mp3 (12.0s)

## Plan 1 « Presentation » — 14.7s · décor vidéo 1280×720 · fichier 8.1s 1280×720 · cameraX 640 · overlay non · transition → crossfade 400ms 
Waypoints : 6c68(584,562 ×1.00 right), 0f4d(876,572 ×1.00)
    0.0s ANIM    Idle loop ×0.5 0.0s→5.6s
    0.0s CAMÉRA  zoom 0.0s→3.0s rect(466,23,593×334) in 0 hold None out None
    0.0s MOTION  appear ∅ → WP(584,562) 0.0s→0.0s anim=défaut ×1 easing= CP=0
    1.1s SON1    Audio Intro.mp3 1.1s→8.7s vol 1 rate 1 PARLÉ
    5.6s CAMÉRA  rumble 5.6s→9.2s amp 1 3Hz   ⚓
    5.6s MOTION  travel ∅ → WP(876,572) 5.6s→9.2s anim=Walk ×1 easing= CP=0
    9.1s SON1    dino audio 1-1.MP3 9.1s→14.7s vol 1 rate 1 PARLÉ
    9.2s ANIM    Idle once-hold ×0.5 9.2s→14.7s

## Plan 2 « apparition bus » — 9.4s · décor vidéo 1280×720 · fichier 12.1s 1280×720 · cameraX 640 · overlay non · transition → wipe ms 
Waypoints : d42c(1020,509 ×0.75 left)
    0.0s CAMÉRA  zoom 0.0s→4.3s rect(478,111,804×452) in 0 hold None out None
    0.0s MOTION  travel libre(1200,508) → WP(1020,509) 0.0s→2.0s anim=Walk ×1 easing= CP=0
    1.3s SON1    dino audio 1-2.MP3 1.3s→9.4s vol 1 rate 1 PARLÉ
    2.0s ANIM    Idle loop ×0.5 2.0s→9.4s
    4.2s SON2    soundreality-whoosh-apparition-386140.mp3 4.2s→9.4s vol 1 rate 1

## Plan 3 « Fuite » — 10.8s · décor vidéo 1280×720 · fichier 13.1s 1280×720 · cameraX 640 · overlay non · transition → crossfade 1000ms 
Waypoints : 317c(163,564 ×0.85)
    0.0s CAMÉRA  rumble 0.0s→5.5s amp 1 2.1Hz   ⚓
    0.0s CAMÉRA  rumble 0.0s→5.5s amp 1 2Hz   ⚓
    0.0s MOTION  travel libre(-135,561) → WP(163,564) 0.0s→5.5s anim=Walk ×2 easing= CP=0
    0.0s SON3    suspense sound.mp3 0.0s→10.8s vol 1 rate 1
    5.5s ANIM    Action once-hold ×2 5.5s→7.5s
    6.0s SON1    53439420-t-rex-victory-roar-469053.mp3 6.0s→9.6s vol 1 rate 2
    6.1s CAMÉRA  shake 6.1s→7.1s amp 16 14Hz expo rot ⚓
    6.3s SON2    dinosaur flee.mp3 6.3s→10.6s vol 1 rate 1
    7.4s MOTION  travel ∅ → libre(1538,563) 7.4s→10.8s anim=Walk ×4 easing= CP=0
    7.5s CAMÉRA  rumble 7.5s→10.8s amp 3 8Hz   ⚓

## Plan 4 « Course » — 11.7s · décor vidéo 1920×1080 · fichier 8.1s 1920×1080 · cameraX 960 · overlay non · transition → crossfade 300ms 
Waypoints : a0e3(807,934 ×1.10 right)
    0.0s ANIM    Walk loop ×3 0.0s→11.7s
    0.0s CAMÉRA  rumble 0.0s→11.7s amp 1 3Hz   ⚓
    0.0s MOTION  appear ∅ → WP(807,934) 0.0s→0.0s anim=défaut ×1 easing= CP=0
    0.8s SON1    Audio 3.mp3 0.8s→11.7s vol 1 rate 1 PARLÉ

## Plan 5 « Rugissement Pterodactyle » — 8.2s · décor vidéo 1280×720 · fichier 9.1s 1280×720 · cameraX 640 · overlay non · transition → cut ms 
Waypoints : 7c4a(496,608 ×0.85)
    0.0s CAMÉRA  rumble 0.0s→2.6s amp 1 3Hz   ⚓
    0.0s MOTION  travel libre(-190,682) → WP(496,608) 0.0s→2.6s anim=Walk ×3 easing= CP=0
    2.7s ANIM    Action once-hold ×2 2.7s→7.4s
    3.2s SON1    53439420-t-rex-victory-roar-469053.mp3 3.2s→6.8s vol 1 rate 1
    3.5s CAMÉRA  shake 3.5s→4.2s amp 16 14Hz expo rot ⚓
    4.0s SON3    pterodactyle cry.mp3 4.0s→5.1s vol 1 rate 1
    5.4s SON2    53439420-t-rex-victory-roar-469053.mp3 5.4s→8.2s vol 1 rate 1
    5.8s CAMÉRA  shake 5.8s→6.5s amp 16 14Hz expo rot ⚓
    5.9s SON3    pterodactyle cry.mp3 5.9s→7.0s vol 1 rate 1

Durée totale des plans : 54.9s (+ intro/outro)