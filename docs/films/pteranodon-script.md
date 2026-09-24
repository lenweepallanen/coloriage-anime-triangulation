# Mini-film « Pteranodon » — script v1 (à valider)

Projet admin : `Dino 6 - Pteranodon` (`25a4702f-0887-4890-9013-1962fb7a1d91`, livre DINOSAUR COLORING BOOK, non publié).
Gabarit de rythme : T-REX / Plesiosaurus — 5 plans, ~57 s + iris, un plan TRAVELLING, un plan muet d'action, gag final.

## Synopsis (lecture rapide)

Un ptéranodon se présente au-dessus d'une falaise, survole la plaine des dinosaures en travelling, se compare à une voiture rouge sur une plage, échappe sans un mot à un T-Rex qui saute pour l'attraper, vole vers l'océan au couchant, puis pêche un poisson. Environ 66 s, 4 fichiers voix redécoupés en 5 répliques, 1 plan muet.

**1 · Falaise maritime · 10,5 s · vidéo `videos-v1/P1_sea_cliff.mp4`**
Il arrive en volant par la gauche devant une falaise avec un nid, se met en vol stationnaire au centre, zoom sur sa tête. Il se présente :
> « Hey! I'm Pteranodon, a giant flying reptile that soared above the dinosaurs! » *(Audio Intro, 2,4 → 8,8 s)*

**2 · Plaine des dinosaures vue du ciel · 15 s · TRAVELLING · vidéo `videos-v1/P2_dino_plain_aerial_v2.mp4`**
Il vole sur place dans le ciel, la plaine défile sous lui de droite à gauche pendant 15 s : troupeaux de sauropodes et de tricératops, rivière, palmiers, volcan qui fume au loin. Des sauropodes lèvent la tête pour le regarder passer (5 → 7 s). Sur « HUGE » il grandit à l'écran (échelle 0,95 → 1,2), puis survol muet sur les dernières secondes.
> « I lived with the dinosaurs but I wasn't actually a dinosaur! I was a flying reptile! My wings were HUGE! » *(Audio 1, 0,8 → 11,6 s)*

**3 · Plage avec une voiture rouge · 13 s · vidéo `videos-v1/P3_beach_red_car.mp4`**
Il arrive et se place ailes déployées juste au-dessus d'une Coccinelle rouge garée sur le sable (zoom, coup de klaxon à 3,2 s), puis monte dans le ciel et s'éloigne vers la mer.
> « Some Pteranodons had wings wider than a car! I loved soaring through the sky! » *(Audio 2 rogné à 0 → 9,0 s de fichier, posé 0,6 → 9,6 s)*

**4 · Clairière de jungle, le T-Rex saute · 9,5 s · SANS PAROLE · vidéo `videos-v1/P4_jungle_trex.mp4`**
Il plane tranquillement au-dessus d'une clairière de jungle. Le T-Rex en dessous rugit puis se dresse gueule grande ouverte vers lui (4 s) : il pousse un cri et monte hors de portée. Le T-Rex retombe, grogne, fait un petit saut de rage (9 s) ; le ptéranodon file vers la droite. Rugissement, clac, cri, whoosh.

**5 · Vers l'océan · 8,5 s · TRAVELLING · vidéo `videos-v1/P5_flight_to_ocean.mp4`**
Il vole sur place dans le ciel du couchant, la côte défile sous lui, la mer et le soleil devant. Juste le temps de deux phrases, puis fondu sur la mer.
> « I spent lots of time near the ocean. » *(Audio 2, fin du fichier : offset 9,05 s, durée 2,5 s, posé 0,8 → 3,3 s)* · « I used my long beak to catch fish! » *(Audio 3, début du fichier : durée 2,8 s, posé 4,0 → 6,8 s)*

**6 · Océan au couchant · 10 s · vidéo `videos-v1/P5_sunset_ocean.mp4`**
Il descend en planant vers l'eau calme et dorée. Un poisson bondit hors de l'eau juste devant son bec (3,5 s) : il ouvre le bec, attrapé ! Le poisson retombe, SPLASH (5 s), « got one! ». Il remonte vers le soleil. Iris de fin.
> « SPLASH… got one! » *(Audio 3 rogné : offset 4,8 s, durée 3,6 s, posé 5,0 → 8,6 s — SPLASH à 5,0 s)*

---

## Texte (lu par les mp3 fournis — découpage DÉDUIT des pauses, à vérifier à l'oreille)

| Fichier | Durée | Texte supposé | Pauses détectées |
|---|---|---|---|
| Audio Intro.mp3 | 6,43 s | Hey! I'm Pteranodon, a giant flying reptile that soared above the dinosaurs! | — |
| Audio 1.mp3 | 10,84 s | I lived with the dinosaurs but I wasn't actually a dinosaur! ‖ I was a flying reptile! ‖ My wings were HUGE! | 3,0 → 4,0 s · 7,0 → 8,3 s |
| Audio 2.mp3 | 12,04 s | Some Pteranodons had wings wider than a car! ‖ I loved soaring through the sky! ‖ I spent lots of time near the ocean. | 2,5 → 3,7 s · 7,8 → 9,05 s |
| Audio 3.mp3 | 8,44 s | I used my long beak to catch fish. ‖ (plongée) ‖ SPLASH… got one! | 2,8 → 4,8 s → **SPLASH à 4,8 s** |

Parole totale : 37,8 s. Le reste (≈ 20 s) = entrées de champ, vol muet, gags.

## Réglages film

| Réglage | Valeur |
|---|---|
| Personnage | facing `left` (sens du dessin), scale 1, origine (0.5, 0.55) — centre du corps : il vole, il ne se pose jamais |
| Animations utilisées | **Idle** (vol battu, boucle — sert aussi de « marche ») · **Action** (grand battement d'ailes + bec ouvert : cri, attrape). Aucune animation à créer. Option si facile : **Planer** (ailes tendues immobiles, 3 s) pour les phases « soaring » ; sinon Idle 0,5×. |
| Règle mouvements | Pas de looping, vrille ni piqué acrobatique. Le héros bat des ailes, plane, monte ou descend sur des trajets doux (courbes Bézier à 1 point). Pas d'interaction physique avec les éléments (pluie, vent, vague qui l'éclabousse) : il ne peut pas y réagir. Le spectaculaire (T-Rex, éclaboussure, voiture, troupeaux) est dans le DÉCOR et les sons. |
| Musique | ambiance aérienne légère en boucle, volume 0,7 (Envato : `light adventure kids sky loop`) |
| Intro / Outro | iris 1000 ms / iris 1000 ms |
| Bruits de pas | désactivés |
| Décors | vidéos Grok Imagine 16:9 720p (1280×720), cameraX = 640, style = référence unique `docs/films/style-reference/reference_unique.jpg` |
| Travelling | plan 2 : la plaine des dinosaures vue du ciel défile sous lui, il vole sur place |
| Poster | plan 3 vers 2 s (le ptéranodon au-dessus de la voiture rouge) |

Grammaire caméra : zoom sur les moments posés, rumble léger (amplitude 1, 2 Hz) en vol, shake (16, 14 Hz, rotate, decay expo, 700 ms) sur chaque saut du T-Rex et sur le splash.

---

## PLAN 1 — « Presentation » · 10,5 s · posé

**Décor — FALAISE MARITIME (vidéo à GÉNÉRER, 12 s)** : paroi de falaise grise et brune sur le tiers gauche avec un grand nid de branches sur une corniche, la mer tout en bas à droite, ciel bleu pâle du matin, deux ou trois ptéranodons minuscules très loin dans le ciel. Grand ciel libre au centre et à droite.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 → 2,5 s | **travel** depuis hors-champ gauche (x −200, y 300) → WP1 (x 560, y 330, scale 0,9, facing right). Idle 1× | vent léger 0 → 10,5 s (vol. 0,4), battements d'ailes doux 0 → 2,5 s, cris lointains de ptéranodons 1,0 s | — |
| 2,5 → 10,5 s | Idle loop 0,8× sur WP1 (vol stationnaire) | **Audio Intro** 2,4 → 8,8 s (parlé) | zoom 2,5 → 8,5 s sur la tête, rect ≈ (x 260, y 120, w 700, h 394), easeInOut, zoomOut 1500 ms |
| 10,5 s | — | — | **crossfade 600 ms** |

Vidéo générée (`videos-v1/P1_sea_cliff.mp4`, 12,0 s) : nuages qui dérivent, vaguelettes en bas, deux ptéranodons lointains qui planent en haut à droite pendant tout le clip. Conforme, centre libre.

---

## PLAN 2 — « Above the dinosaurs » · 13,0 s · TRAVELLING · voix

**Décor — PLAINE DES DINOSAURES VUE DU CIEL, EN TRAVELLING (vidéo à GÉNÉRER, 14 s)** : vue plongeante depuis le ciel sur une plaine préhistorique qui traverse tout le cadre et continue hors champ des deux côtés : prairie, fougères, rivière sinueuse, petits troupeaux vus de haut (sauropodes, tricératops), volcan et montagnes à l'horizon, ciel bleu avec quelques nuages plats. TOUT LE PAYSAGE DÉFILE de droite à gauche à vitesse constante (le héros vole sur place). À 2,5 s un sauropode lève la tête vers le ciel en le regardant passer.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 s | **appear** sur WP1 (x 632, y 300, scale 0,95, facing right) | vent 0 → 13 s (vol. 0,5) | rumble léger 0 → 13 s (amplitude 1, 2 Hz) |
| 0,0 → 13,0 s | Idle loop 1× SUR PLACE : c'est la plaine qui défile (travelling) | **Audio 1** 0,8 → 11,6 s (parlé) : « I lived with the dinosaurs… » 0,8 → 3,8 · « I was a flying reptile! » 4,8 → 7,8 · « My wings were HUGE! » 9,1 → 11,6 | — |
| 2,5 s | (continue) | cri lointain de dinosaure 2,5 s (le sauropode lève la tête dans le décor) | — |
| 9,1 → 10,6 s | **travel** sur place WP1 → WP2 (mêmes x, y, **scale 1,2**) : il « grandit » sur « HUGE » | whoosh 9,1 s | zoom OUT : rect plein cadre → léger recul, ou simplement rien (le changement d'échelle suffit) |
| 13,0 s | — | — | **crossfade 500 ms** |

Vidéo générée (`videos-v1/P2_dino_plain_aerial.mp4`, 14,0 s) : travelling « en avant » avec parallaxe plutôt que défilement latéral pur : la plaine, la rivière et les troupeaux avancent vers la caméra, un sauropode arrive de la gauche et **lève la tête vers 7 → 8 s** (pas 2,5 s → décaler le cri de dinosaure à 7,5 s), puis il devient très grand au premier plan bas-droite de 11 à 14 s (tête vers y ≈ 50 %). Pour éviter tout chevauchement : **WP1 à y 240** (au lieu de 300) et **terminer le plan à 12,5 s** (la voix finit à 11,6 s). L'effet travelling est là, le héros vole dans la bande de ciel.

Retour Nicolas (2026-09-15) : étendre le survol, c'est un beau plan → **v2** (`videos-v1/P2_dino_plain_aerial_v2.mp4`, 15 s = max API, même image de départ) : travelling latéral régulier vers la droite au-dessus de la plaine, troupeaux qui restent petits et loin (sauropode qui lève la tête à 5 s, tricératops qui traversent la rivière à 11 s), aucune créature qui grossit au premier plan. **Plan porté à 15 s** : Audio 1 0,8 → 11,6 s inchangé, « HUGE » (échelle 0,95 → 1,2) 9,1 → 10,6 s, puis 3,4 s de survol muet (vent seul) avant le crossfade — si on veut plus long, enchaîner un second clip de 15 s par un fondu.
Vidéo v2 générée : travelling latéral régulier sur 15 s, la plaine défile (rivière, palmiers, fougères), troupeaux de sauropodes et de tricératops qui marchent en restant petits et au loin, sauropodes qui lèvent la tête vers 5 → 7 s, tricératops près de la rivière vers 11 → 14 s, volcan et nuages en parallaxe lente ; **aucune créature au premier plan**, bande de ciel libre sur tout le clip. **RETENUE**, WP1 y 300 possible à nouveau (plus de sauropode géant).

---

## PLAN 3 — « Wider than a car » · 13,0 s · posé + gag voiture · voix

**Décor — PLAGE AVEC UNE VOITURE ROUGE (vidéo à GÉNÉRER, 14 s)** : plage de sable, dunes herbeuses et palmiers préhistoriques à gauche, mer calme à droite, une petite voiture rouge vintage garée sur le sable en bas au centre (l'anachronisme est le gag, comme le bus du T-Rex), grand ciel bleu. Dans la vidéo : les vagues roulent, à 3,2 s les phares de la voiture clignotent deux fois (coup de klaxon), les palmiers ondulent.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 → 2,0 s | **travel** depuis hors-champ gauche (x −200, y 260) → WP1 (x 632, y 250, scale 1,0, facing right) : il se place juste AU-DESSUS de la voiture, ailes déployées | vagues 0 → 13 s (vol. 0,5) | — |
| 2,0 → 4,5 s | Idle loop 0,8× (stationnaire au-dessus de la voiture) | **Audio 2** 0,6 → 12,6 s (parlé) : « …wider than a car! » 0,6 → 3,1 · klaxon 3,2 s | zoom 1,0 → 4,5 s sur voiture + héros, rect ≈ (x 232, y 150, w 800, h 450), zoomOut 1200 ms |
| 4,5 → 8,0 s | **travel** WP1 → WP2 (x 900, y 120, scale 0,8) : il monte dans le ciel sur « I loved soaring through the sky! » (4,3 → 8,4 s). Idle 1× | whoosh doux 4,5 s | — |
| 8,0 → 9,5 s | Idle loop 0,7× sur WP2 (il plane) | — | — |
| 9,5 → 12,0 s | **exit** vers hors-champ droite (x 1450, y 200). Idle 1× | — | — |
| 12,0 s | — | — | **wipe left 400 ms** (avant le plan d'action) |

Voix : **Audio 2 rogné à la fin** (durée du clip 8,45 s → le clip s'arrête après « through the sky! », la phrase « near the ocean » part au plan 5). Plan ramené à **12 s**.

Vidéo générée (`videos-v1/P3_beach_red_car.mp4`, 14,0 s) : voiture garée immobile tout le clip, palmiers qui ondulent, vagues, petit nuage d'échappement vers 5 → 8 s. Le clignotement des phares n'est pas visible à 1 image/s : le klaxon reste un son posé à 3,2 s. Conforme, ciel libre au-dessus de la voiture (le toit est à y ≈ 470 en 1264×720 → héros à y 250 OK).

---

## PLAN 4 — « Le T-Rex saute » · 9,5 s · action MUET

**Décor — CLAIRIÈRE DE JUNGLE AVEC UN T-REX (vidéo à GÉNÉRER, 10 s)** : clairière préhistorique vue de côté, grands arbres et fougères à gauche et à droite, sol de terre au bas du cadre, volcan lointain, ciel bleu sur la moitié haute. Un T-Rex (réaliste, dents, air féroce) est debout en bas au centre-droit et regarde en l'air. Dans la vidéo : **à 4 s il bondit vers le haut, mâchoires ouvertes, jusqu'au milieu du cadre**, claque des dents et retombe à 5 s ; il secoue la tête, grogne, **saute encore à 7 s** (un peu moins haut), retombe à 8 s et reste à regarder le ciel, frustré. Le tiers supérieur du cadre reste libre.

| t | Héros | Sons | Caméra |
|---|---|---|---|
| 0,0 → 2,5 s | **travel** depuis hors-champ gauche (x −200, y 300) → WP1 (x 632, y 330, scale 0,9, facing right). Idle 0,8× (il plane, tranquille) | ambiance jungle 0 → 9,5 s (vol. 0,5), battements doux | — |
| 2,5 → 3,6 s | Idle loop 0,8× sur WP1 | rugissement de T-Rex 3,0 s (il surgit / se prépare dans le décor) | rumble 3,0 → 4,0 s (amplitude 2, 3 Hz) |
| 3,6 → 4,4 s | **travel** WP1 → WP2 (x 700, y 120, scale 0,85) : il monte d'un coup hors de portée pendant le saut du T-Rex (4 s). Idle 2× | clac de mâchoire 4,0 s, whoosh 3,6 s | shake 4,0 s |
| 4,4 → 6,4 s | **Action** 1× once-hold : cri, ailes hautes (il a eu peur) | cri de ptéranodon 4,6 s, grognement frustré du T-Rex 5,3 s | — |
| 6,4 → 7,5 s | Idle loop 1× sur WP2 | clac de mâchoire 7,0 s (2e saut, il rate), whoosh 7,0 s | shake léger 7,0 s (amplitude 8) |
| 7,5 → 9,5 s | **exit** vers hors-champ droite EN HAUT (x 1450, y 80), Idle 1,5× | — | — |
| 9,5 s | — | — | **crossfade 1000 ms** |

Gag : il est à l'abri dans le ciel, c'est tout l'intérêt d'être un reptile VOLANT. Le héros ne fait que monter, crier et partir ; le saut, la chute et la frustration sont dans la vidéo.

Vidéo générée (`videos-v1/P4_jungle_trex.mp4`, 10,0 s) : le T-Rex rugit tête levée 1 → 3 s, **se dresse gueule grande ouverte vers le ciel à 4 s** (sa tête monte à ≈ 30 % de la hauteur : ça lit comme une tentative d'attraper, sans vrai bond), retombe et regarde 5 → 6 s, se tourne et marche vers la gauche 6 → 8 s, **petit saut de frustration avec nuage de poussière à 9 s**, puis reste debout. Pas de second saut à 7 s → supprimer le clac / shake de 7,0 s, mettre le clac + shake léger à **9,0 s** (pendant la sortie du héros). Le timing de la fuite du héros (3,6 → 4,4 s) reste bon. Si on veut un vrai bond, régénérer en insistant « leaps high off the ground, all four limbs in the air ».

---

## PLAN 5 — « Vers l'océan » · 8,5 s · TRAVELLING · voix

**Décor — CÔTE AU COUCHANT EN TRAVELLING (vidéo GÉNÉRÉE `videos-v1/P5_flight_to_ocean.mp4`, 10 s)** : vue du ciel le long de la côte, plage et petites falaises avec palmiers dans le tiers bas, la mer au milieu, îlots, soleil bas à droite, ciel orange-rose. La caméra vole vers la droite : la côte défile de droite à gauche, la mer plus lentement (parallaxe), vaguelettes, reflets du soleil. Aucun animal. Le haut du cadre est libre.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 s | **appear** sur WP1 (x 632, y 260, scale 0,9, facing right) | vent léger 0 → 8,5 s (vol. 0,4), vagues lointaines (vol. 0,3) | rumble léger 0 → 8,5 s (amplitude 1, 2 Hz) + **oscillation** ↕ calée sur Idle |
| 0,0 → 8,5 s | Idle loop 1× SUR PLACE : c'est la côte qui défile (travelling) | **Audio 2** (offset 9,05 s, durée 2,5 s) 0,8 → 3,3 s : « I spent lots of time near the ocean. » · **Audio 3** (offset 0, durée 2,8 s) 4,0 → 6,8 s : « I used my long beak to catch fish! » | — |
| 8,5 s | — | — | **crossfade 800 ms** (la mer arrive) |

Les deux répliques sont des CLIPS ROGNÉS des fichiers existants (champ « Début dans le son » + durée) : pas de nouveau mp3.

Vidéo générée (`videos-v1/P5_flight_to_ocean.mp4`, 10 s) : la côte (plage, falaises, palmiers) défile de droite à gauche, la mer et les îlots glissent plus lentement, le soleil se déplace doucement vers le centre et descend un peu, ciel qui se réchauffe, vaguelettes sur la plage. Aucun animal, ciel libre. Le défilement est assez lent : passer le héros en Idle 1× (pas plus) pour un vol paisible. Conforme.

---

## PLAN 6 — « SPLASH » · 10 s · posé + gag final · voix

**Décor — OCÉAN CALME AU COUCHANT (vidéo GÉNÉRÉE `videos-v1/P5_sunset_ocean.mp4`, 12 s)** : mer calme vue juste au-dessus de l'eau, ciel orange et rose, soleil bas à droite, îlots au loin. Dans la vidéo réelle : petit poisson qui saute à gauche 0 → 1 s ; **grand bond d'un poisson au centre-gauche de 2,5 à 5 s** (sortie de l'eau à 2,5 s, apogée vers 3,5 → 4 s à ≈ (x 560, y 290), retombée avec éclaboussure à 5 s) ; ronds dans l'eau ; second bond au bord gauche 7 → 8 s avec grosse gerbe ; ronds jusqu'à la fin ; le soleil scintille.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 → 3,4 s | **travel** depuis hors-champ gauche EN HAUT (x −200, y 150) → WP1 (x 560, y 330, scale 0,9, facing right), courbe douce vers le bas (1 point de contrôle ≈ (200, 380)) : il descend en planant vers l'eau. Idle 0,7× | **Audio 3 rogné** (offset 4,8 s, durée 3,6 s) posé **5,0 → 8,6 s** : « SPLASH » à 5,0 s pile sur la retombée du poisson · « got one! » ≈ 6,0 → 8,0. La phrase « I used my long beak… » est déjà dite au plan 5. | — |
| 2,5 s | (continue) | whoosh + petite gerbe 2,5 s (le poisson sort de l'eau, dans le décor) | — |
| 3,6 → 5,6 s | **Action** 1× once-hold : bec ouvert pile quand le poisson est à l'apogée devant lui (3,5 → 4 s) = attrapé | clac de bec 3,8 s | shake léger 3,8 s (amplitude 8) |
| 5,0 s | (figé, bec fermé) | SPLASH 5,0 s (le poisson retombe dans le décor), « ding » joyeux 6,0 s sur « got one! » | shake 5,0 s |
| 5,6 → 8,0 s | Idle loop 0,8× sur WP1 (il savoure) | — | — |
| 8,0 → 10,0 s | **travel** WP1 → WP2 (x 800, y 200, scale 0,85) : il remonte doucement vers le soleil. Idle 0,8× | vaguelettes 0 → 11,5 s (vol. 0,4), battements doux ; second bond de poisson à 7 → 8 s dans le décor = petit whoosh 7,0 s | — |
| 10,0 s | FIN | — | **outro iris 1000 ms** |

Note : le montage utilise le PREMIER bond (centre-gauche, apogée à ≈ 3,5 s) ; la voix est décalée pour que son « SPLASH » tombe sur la retombée du poisson à 5,0 s. Le second bond (7 → 8 s, bord gauche) reste un bonus visuel pendant qu'il remonte.

---

## Chronologie globale

| Plan | Durée | Cumul | Type |
|---|---|---|---|
| iris in | 1,0 s | 1,0 | — |
| 1 Presentation | 10,5 s | 11,5 | posé, voix |
| 2 Above the dinosaurs | 13,0 s | 24,5 | **travelling**, voix |
| 3 Wider than a car | 12,0 s | 38,5 | posé + gag, voix |
| 4 Le T-Rex saute | 9,5 s | 48,0 | **muet**, action |
| 5 Vers l'océan | 8,5 s | 56,5 | **travelling**, voix |
| 6 SPLASH | 10,0 s | 66,5 | posé + gag final, voix |
| iris out | 1,0 s | 67,5 | — |

---

## Assets à produire

### Vidéos de décor (Grok Imagine, image-to-video, 16:9 720p)

Images de départ : `docs/films/pteranodon/gpt-ptero/*.png` (GPT `gpt-image-2.5-sunburst`, style v3 = référence unique, `gen_backdrops.py set=ptero`). Vidéos : `gen_videos.py` (à dupliquer avec ces prompts). Le héros n'est JAMAIS dans le décor.

**P1 — Falaise (12 s)** — image `P1_sea_cliff.png`
- Mouvement : Static camera. Soft clouds drift slowly to the right, small waves roll far below, grass tufts on the ledges sway in the wind, the two or three tiny pteranodon silhouettes far away glide slowly across the sky. Calm, loopable.

**P2 — Plaine des dinosaures, TRAVELLING (14 s)** — image `P2_dino_plain_aerial.png`
- Mouvement : TRAVELLING shot from the air: the camera flies steadily to the right, so the whole landscape below (grassland, river, herds, hills) scrolls continuously from right to left at a constant speed for the entire clip, the plain going on endlessly; the sky and the distant volcano move much slower (parallax). At 2.5 s one long-neck sauropod below lifts its head and looks up at the sky. The herds walk slowly. The upper-center of the frame stays free.

**P3 — Plage et voiture (14 s)** — image `P3_beach_red_car.png`
- Mouvement : Static camera. Gentle waves roll onto the beach, the palm-like trees sway, a few clouds drift. The red car stays parked; at 3.2 s its headlights flash twice (a honk) and a tiny puff of exhaust appears. Nothing else moves. The sky above the car stays free.

**P4 — Clairière de jungle, T-Rex (10 s)** — image `P4_jungle_trex.png`
- Mouvement : Static camera. Leaves and ferns sway gently. The T-Rex standing at the lower center-right looks up at the sky. At 4 s it suddenly leaps straight up with its jaws wide open, reaching the middle of the frame, snaps its jaws shut on nothing and lands back at 5 s with a small dust cloud; it shakes its head, growls, then jumps again at 7 s (a little lower), snaps, lands at 8 s and stays standing, looking up, frustrated, until the end. The upper third of the frame stays completely free.

**P5 — Océan au couchant (12 s)** — image `P5_sunset_ocean.png`
- Mouvement : Static camera. Gentle swell, the low sun sparkles on the water, clouds drift slowly. At 2 s a small fish jumps out of the water at the lower left. At 6.5 s a fish leaps out of the water at the lower center with a big splash of white droplets, then ripples spread. The sky stays free.

### Sons (Envato — mots-clés)

| Usage | Plan | Recherche Envato | Durée |
|---|---|---|---|
| Vent léger | 1, 2, 3 | `light wind ambience loop` | 10 s |
| Ambiance jungle | 4 | `jungle ambience birds insects loop` | 10 s |
| Battements d'ailes (grand oiseau) | 1, 4, 5 | `large bird wing flap` | 1 s |
| Cri de ptéranodon | 1 (lointain), 4 | `pterodactyl screech` | 1 s |
| Cri de dinosaure lointain | 2 | `dinosaur call distant` | 2 s |
| Rugissement T-Rex + grognement | 4 | `t-rex roar growl` | 2 s |
| Clac de mâchoire | 4 | `cartoon jaw snap teeth` | 0,5 s |
| Klaxon | 3 | `car horn honk vintage` | 1 s |
| Vagues calmes | 3, 5 | `gentle ocean waves beach loop` | 12 s |
| Splash | 5 | `water splash big` | 1 s |
| Whoosh | 2, 3, 4 | `soft whoosh air` | 1 s |
| Ding joyeux | 5 | `cartoon success ding` | 1 s |
| Musique | tous | `light adventure kids sky loop` | boucle |

## Images de décor générées (2026-09-14)

Dossier `docs/films/pteranodon/gpt-ptero/` — GPT `gpt-image-2.5-sunburst`, 1792×1008, style v3 (référence unique), `gen_backdrops.py set=ptero`.

| Image | Verdict |
|---|---|
| `P1_sea_cliff.png` | falaise + nid à gauche, mer en bas, ptéranodons lointains en haut à droite, ciel libre : OK |
| `P2_dino_plain_aerial.png` | plaine continue d'un bord à l'autre (sauropodes, tricératops, rivière, volcan), ciel sur le tiers haut. Le point de vue est plus « à hauteur de colline » que « vu du ciel » : ça marche pour un travelling (le héros vole dans la bande de ciel), sinon régénérer en insistant sur la vue plongeante |
| `P3_beach_red_car.png` | Coccinelle rouge sur le sable, palmiers, mer : le gag est lisible, ciel libre au-dessus : OK |
| `P4_sea_stacks_storm.png` | ABANDONNÉ (plan « vent et vagues » retiré : le héros ne peut pas jouer la lutte contre les éléments) |
| `P4_jungle_trex.png` | clairière de jungle, volcan au loin, T-Rex debout au centre-droit tête levée vers le ciel (sa tête monte jusqu'à ≈ 35 % de la hauteur), tiers haut libre : OK. Le héros vole à y 330 puis monte à y 120 au saut |
| `P5_sunset_ocean.png` | soleil bas, ciel orange-rose, poissons qui sautent en bas à gauche : OK |

## Points à valider

1. Découpage des voix : je n'ai pas transcrit les mp3, le contenu de chaque fichier est déduit du texte et des pauses. À confirmer, surtout Audio 1 / Audio 2 (où tombe « wider than a car »).
2. Gag voiture (plan 3) : anachronisme assumé comme le bus scolaire du T-Rex. OK ?
3. Plan 4 muet « le T-Rex saute » remplace « vent et vagues » (impossible à jouer par le héros). Alternative plus douce si le T-Rex fait trop peur : un volcan qui entre en éruption au loin, il crie et s'éloigne.
4. « HUGE » (plan 2) : agrandissement du héros de 0,95 à 1,2 sur place. Si l'échelle animée n'est pas lisible, remplacer par un zoom caméra arrière.
5. Animation « Planer » optionnelle : utile pour « soaring » (plans 3 et 5) ; sinon Idle ralenti.
