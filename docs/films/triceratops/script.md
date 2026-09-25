# Mini-film « Triceratops » — script v4 (à valider)

Projet admin : **`Triceratops` (`ef7201a8-3106-4698-8752-f672c5ad023b`)**, livre « DINOSAUR COLORING BOOK » (`166cf8a8-…`, non publié), créé le 24/09/2026, 5 animations calculées (Idle, Walk, Charge, Stuck horns, Jump). ⚠ Ne pas confondre avec `DINO 4 - Triceratops` (`efa2953a-…`, livre « DINOSAUR COLORING BOOK (OLD) », publié, animations Jump/Stuck non calculées) : mon import du 24/09 y a été fait par erreur puis ANNULÉ (`film_import.py --remove`, filmT et fichiers retirés).
Gabarit : PLAYBOOK v1 + **règle n° 1 (24/09) : tout doit être montable dans l'éditeur FILM**. Chaque plan ci-dessous est écrit comme la liste des actions à saisir dans l'éditeur (waypoints → mouvement → animation → caméra → sons → transition), avec pour seul « extérieur » la vidéo de décor et ses événements datés.

**Ce qu'on a en main** (et rien d'autre) :
- Animations calculées du projet : **Idle** (boucle) · **Walk** (marche, boucle, ×2–3 = course) · **Fun fact - Charge** (tête baissée, cornes en avant, piétinement, 1 passe = 4,75 s à ×1 / 2,4 s à ×2) · **Humour - Stuck horns** (tête plantée en bas 0,5 s → tête haute gueule ouverte 1,5 s → en bas 1 s → haute 1,75 s ; 1 passe = 4,75 s). *« Action - Jump » : disponible mais non utilisée (bond jugé ridicule).* ⚠ Firestore ne montre pas encore Stuck horns calculée (voir fin).
- Mouvements : `appear`, `travel` (durée, Bézier, easing, animation de déplacement), `exit` ; waypoints (x, y, échelle, regard gauche/droite = miroir du dessin).
- Caméra : `zoom` (rect), `pan`, `rumble`, `shake`, `bob`.
- Sons : clips de la bibliothèque (offset, durée, volume, boucle, « parlé » = bouche), musique globale.
- Décor : 1 vidéo par plan lue depuis 0 s (événements écrits à la seconde dans le prompt), transitions cut / fondu / crossfade / volet / iris.
- Le héros est toujours dessiné PAR-DESSUS la vidéo : un « contact » n'est qu'une superposition héros + événement daté du décor + son.

## Synopsis (lecture rapide)

Un tricératops se présente dans une prairie (P1), montre ses cornes à un petit dinosaure curieux qui déguerpit (P2), fait fuir un T-Rex en baissant la tête et en rugissant (P3), montre sa collerette pendant que deux tricératops se battent au loin (P4), charge à travers la savane en criant « Triceratops coming through! » (P5)… et se plante les cornes dans un tronc (P6). ≈ 67 s, 4 fichiers voix redécoupés en 10 répliques, 1 bruitage de pas fourni.

| Plan | Décor vidéo | Héros (clips) | Voix | Durée |
|---|---|---|---|---|
| 1 Presentation | prairie de fougères, calme | appear · Idle · travel 2 pas (Walk) · Idle | Intro | 9,0 s |
| 2 Giant horns | plateau rocheux ; **8,2 s** un petit dino entre par la gauche, s'arrête, regarde en l'air, **10,4 s** détale | appear (miroir) · Idle tout du long | Audio 1 ph. 1–2 | 12,5 s |
| 3 Nobody messes with me | marécage ; **4,5 s** T-Rex entre par la gauche, **5,0 s** rugit, **7,5 s** recule, **8,0 → 9,5 s** s'enfuit | travel entrée (Walk) · Idle · **Charge** · Idle · **Stuck horns tronqué = rugissement** · Idle | Audio 1 ph. 3 | 14,5 s |
| 4 A dinosaur shield | canyon rouge ; **5,0 → 7,5 s** deux tricératops au fond se battent | appear · Idle tout du long | Audio 2 | 12,5 s |
| 5 Charge! | savane en TRAVELLING continu | appear · **Walk sur place** · **Charge** · Walk | Audio 3 | 11,0 s |
| 6 BONK | gros tronc fixe ; **0,9 s** il tremble, feuilles ; **2,5 s** deux oiseaux se posent | appear · travel 3 pas (Walk) · **Stuck horns** · Idle | — | 4,5 s |

---

## Texte des voix (transcription Whisper, `voices.md`, `voices/voices-timing.json`)

| Clip | Fichier · offset · durée | Texte |
|---|---|---|
| V0 | Audio Intro · 0 · 5,3 s | Hey, I'm Triceratops, the three-horned giant with a powerful shield! |
| V1a | Audio 1 · 0 · 3,0 s | My giant horns help protect me. |
| V1b | Audio 1 · 3,7 · 3,3 s | The biggest horns could grow longer than a skateboard. |
| V1c | Audio 1 · 7,7 · 2,3 s | Nobody wanted to mess with me! |
| V2a | Audio 2 · 0 · 3,0 s | Look at my giant neck frill! |
| V2b | Audio 2 · 4,1 · 3,3 s | It helped protect my neck during battles. |
| V2c | Audio 2 · 8,2 · 3,3 s | It was like a dinosaur shield! |
| V3a | Audio 3 · 0 · 2,6 s | I was as heavy as a small truck. |
| V3b | Audio 3 · 4,0 · 3,7 s | My strong legs helped me charge forward fast. |
| V3c | Audio 3 · 8,8 · 2,0 s | Triceratops coming through! |
| PAS | Audio Marche · 6,3 s | 5 gros pas lourds (≈ 1 toutes les 1,2 s) — bruitage, pas une voix |

## Réglages film (onglet FILM)

| Réglage | Valeur |
|---|---|
| Personnage | facing **right** (sens du dessin), scale 1, origine (0,5 · 0,82) |
| Animation de déplacement par défaut | Walk |
| Musique globale | `playful adventure kids orchestral loop` (Envato), volume 0,8, boucle, continue |
| Intro / Outro | iris 1000 ms / iris 1000 ms |
| Bruits de pas de l'animation | désactivés (on pose `Audio Marche` à la main) |
| Poster | plan 2 à 9,8 s → `posterMs ≈ 20 200` |
| Décors | vidéos 1280×720 (cameraX 640), images de départ GPT au style de référence, vidéos Grok Imagine |

Bibliothèque de sons à importer (un fichier par ligne, nommés `NN-role-…`) : 01-voice-intro, 02-voice-1, 03-voice-2, 04-voice-3, 05-sfx-pas (Audio Marche), 10-amb-prairie, 11-amb-rocaille, 12-amb-marecage, 13-amb-canyon, 14-amb-savane, 20-sfx-petits-pas, 21-sfx-couinement, 22-sfx-gulp, 23-sfx-boing, 24-sfx-riser, 25-sfx-trex-roar, 26-sfx-trice-growl, 27-sfx-trice-bellow, 28-sfx-skid, 29-sfx-whimper, 30-sfx-dino-flee, 31-sfx-whoosh, 32-sfx-thud-lointain, 33-sfx-bellow-lointain, 34-sfx-ting, 35-sfx-thud, 36-sfx-bonk, 37-sfx-crack, 38-sfx-oiseaux-moqueurs, 39-sfx-ding.

---

## PLAN 1 — « Presentation » · 9,0 s · héros à GAUCHE, regard à droite

**Vidéo de décor `P1_fern_prairie` (10 s)** : prairie de fougères au matin, forêt de conifères au fond, volcan qui fume très loin à gauche, tronc couché et rochers moussus dans le tiers droit, sol à y ≈ 78 %. Mouvement : caméra fixe, fougères qui ondulent, papillons, fumée du volcan, nuages lents. Rien n'entre dans le champ. Centre-gauche libre.

**Faisabilité** : 1 appear, 2 clips Idle, 1 travel Walk, 1 zoom, 1 rumble ancré, 3 sons. Le décor n'a aucun événement.

**Actions dans l'éditeur**
1. Waypoints : **WP1** (x 520, y 575, scale 0,9, regard →) · **WP2** (x 650, y 575, scale 0,9, regard →).
2. Mouvement : `appear` WP1 à 0 ms · `travel` WP1 → WP2 de 6 600 à 8 400 ms, easing easeOut, animation Walk ×1.
3. Animation : Idle `loop` ×0,7 de 0 à 6 600 ms · Idle `loop` ×0,7 de 8 400 à 9 000 ms.
4. Caméra : `zoom` 1 000 → 6 400 ms sur la tête, rect (x 380, y 250, w 640, h 360), zoomIn 800 / hold / zoomOut 1 500, easeInOut · `rumble` ancré ⚓ au travel (amplitude 1, 3 Hz).
5. Sons : piste 1 · **V0** à 1 100 ms (parlé) · piste 2 · `05-sfx-pas` offset 0, durée 1 800 ms, ancré ⚓ au travel start +0, vol 0,6 · piste 3 · `10-amb-prairie` 0 → 9 000 ms, loop, vol 0,5, fadeIn 300.
6. Transition : crossfade 400 ms.

---

## PLAN 2 — « Giant horns » · 12,5 s · héros à DROITE, regard à gauche (dessin en miroir)

**Vidéo de décor `P2_rocky_plateau` (13,5 s)** : plateau de roche claire, gros blocs et cycas dans le tiers GAUCHE, collines et ciel à cumulus au fond, sol plat. Événements : **8,2 s** un petit compsognathus (gros comme une poule) trottine depuis le bord gauche jusqu'au centre (x ≈ 45 %) ; **9,4 s** il s'arrête et lève la tête vers la droite ; **10,4 s** il fait demi-tour et détale vers la gauche, hors champ à 11,4 s (poussière) ; ensuite herbes et nuages seulement. Moitié droite libre.

**Faisabilité** : le petit dino est ENTIÈREMENT dans la vidéo ; le héros ne fait qu'un Idle (c'est le gag : il n'a rien à faire). 1 appear, 1 Idle, 2 zooms, 6 sons.

**Actions dans l'éditeur**
1. Waypoint : **WP1** (x 860, y 585, scale 0,9, **regard ←**).
2. Mouvement : `appear` WP1 à 0 ms.
3. Animation : Idle `loop` ×0,7 de 0 à 12 500 ms.
4. Caméra : `zoom` 1 000 → 4 000 ms sur les cornes, rect (x 560, y 300, w 560, h 315), zoomIn 800 / zoomOut 1 500 · `zoom` 8 600 → 12 500 ms sur héros + petit dino, rect (x 440, y 260, w 760, h 428), zoomIn 600 / zoomOut 0 (push-in tenu jusqu'au volet).
5. Sons : piste 1 · **V1a** à 900 ms (parlé) · **V1b** à 4 700 ms (parlé) · piste 2 · `20-sfx-petits-pas` 8 200 → 9 400 ms vol 0,6 · `21-sfx-couinement` 9 500 ms vol 0,7 · `22-sfx-gulp` 10 200 ms vol 0,8 · `23-sfx-boing` 10 400 ms vol 0,8 · `20-sfx-petits-pas` 10 400 → 11 400 ms rate 1,3 vol 0,6 · piste 3 · `11-amb-rocaille` 0 → 12 500 ms, loop, vol 0,5.
6. Transition : volet (wipe) vers la droite 400 ms.

Poster du film à 9 800 ms de ce plan.

---

## PLAN 3 — « Nobody messes with me » · 14,5 s · héros à DROITE, regard à gauche

**Vidéo de décor `P3_swamp_clearing` (15,5 s)** : clairière de marécage au crépuscule, eau et roseaux dans le tiers GAUCHE, brume au sol, lumière bleu-vert. Événements : **4,5 s** un T-Rex surgit par le bord gauche jusqu'au tiers gauche ; **5,0 s** il rugit gueule ouverte ; **6,0 s** un pas lourd vers le centre (poussière) ; **7,5 s** il s'arrête net et recule ; **8,0 → 9,5 s** demi-tour et fuite par la gauche (poussière), hors champ à 9,5 s ; ensuite brume seule. Moitié droite libre.

**Faisabilité** : le T-Rex est ENTIÈREMENT dans la vidéo ; le héros joue 3 clips d'animation existants (Charge = menace, Stuck horns coupé à 2 s = tête qui plonge puis se relève gueule ouverte, ça se lit « rugissement » avec le son parlé). Aucun contact. 1 travel, 5 anim, 2 shakes, 2 rumbles, 10 sons.

**Actions dans l'éditeur**
1. Waypoint : **WP1** (x 900, y 590, scale 0,85, **regard ←**).
2. Mouvement : `travel` hors-champ DROITE → WP1 de 0 à 2 500 ms, easeOut, animation Walk ×1.
3. Animation : Idle `loop` ×1 de 2 500 à 5 400 ms · **Fun fact - Charge** `once-hold` ×2 de 5 400 à 7 800 ms · Idle `loop` ×0,8 de 7 800 à 8 400 ms · **Humour - Stuck horns** `once-hold` ×1 de 8 400 à 10 400 ms (clip coupé à 2 s : tête qui plonge, puis se relève gueule ouverte) · Idle `loop` ×0,8 de 10 400 à 14 500 ms.
4. Caméra : `rumble` ancré ⚓ au travel (amplitude 1, 3 Hz) · `shake` à 5 000 ms (amplitude 16, 14 Hz, rotation, decay expo, 700 ms) · `rumble` ancré ⚓ à Charge (amplitude 3, 8 Hz, toute la durée du clip) · `shake` à 8 900 ms (amplitude 16, 14 Hz, rotation, expo, 700 ms).
5. Sons : piste 1 (voix / bouche) · `26-sfx-trice-growl` ancré ⚓ à Charge start +200 ms, **parlé**, vol 0,9 · `27-sfx-trice-bellow` ancré ⚓ à Stuck horns start +500 ms, **parlé**, vol 1, 1 500 ms · **V1c** à 11 400 ms (parlé) · piste 2 (événements) · `24-sfx-riser` 2 400 → 5 000 ms vol 0,7 · `25-sfx-trex-roar` 5 000 ms vol 1 · `05-sfx-pas` offset 2 250 durée 1 450 ms à 5 800 ms vol 0,7 (piétinement) · `28-sfx-skid` 7 600 ms vol 0,8 · `29-sfx-whimper` 7 900 ms vol 0,8 · `30-sfx-dino-flee` 8 000 → 9 800 ms vol 0,8 · `31-sfx-whoosh` 9 400 ms vol 0,7 · piste 3 · `05-sfx-pas` offset 0 durée 2 500 ms ancré ⚓ au travel, vol 0,6 · `12-amb-marecage` 0 → 14 500 ms loop vol 0,5.
6. Transition : crossfade 800 ms.

Chaîne cause → effet : T-Rex rugit (vidéo 5,0) → 0,4 s → Charge (5,4) ; T-Rex recule (vidéo 7,5) et fuit (8,0) → 0,4 s → rugissement du héros (8,4, son à 8,9) ; → 2,5 s → « Nobody wanted to mess with me! » (11,4 → 13,7) ; 0,8 s de tenue ; crossfade.

---

## PLAN 4 — « A dinosaur shield » · 12,5 s · héros à GAUCHE, regard à droite

**Vidéo de décor `P4_red_canyon` (13,5 s)** : fond de canyon rouge et ocre en fin d'après-midi, sable et galets, buissons secs ; au fond à DROITE, très loin et très petits, deux tricératops face à face. Événements : **5,0 → 7,5 s** ils baissent la tête, s'affrontent cornes contre cornes et soulèvent de la poussière, puis se séparent ; **5,2 s** deux oiseaux s'envolent ; chaleur qui ondule. Centre-gauche libre.

**Faisabilité** : la bataille est dans la vidéo, en arrière-plan ; le héros ne fait qu'un Idle et la caméra travaille (zoom collerette). 1 appear, 1 Idle, 2 zooms, 7 sons.

**Actions dans l'éditeur**
1. Waypoint : **WP1** (x 450, y 585, scale 0,9, regard →).
2. Mouvement : `appear` WP1 à 0 ms.
3. Animation : Idle `loop` ×0,7 de 0 à 12 500 ms.
4. Caméra : `zoom` 1 000 → 4 000 ms sur la collerette, rect (x 330, y 240, w 600, h 338), zoomIn 800 / zoomOut 1 200 · `zoom` 8 400 → 11 500 ms léger recul, rect (x 0, y 0, w 1280, h 720) = plein cadre (ou aucun clip si le plein cadre est déjà l'état par défaut).
5. Sons : piste 1 · **V2a** à 900 ms · **V2b** à 4 400 ms · **V2c** à 8 400 ms (tous parlés) · piste 2 · `32-sfx-thud-lointain` 5 200 ms vol 0,5 · `32-sfx-thud-lointain` 6 600 ms vol 0,5 · `33-sfx-bellow-lointain` 7 200 ms vol 0,4 · `34-sfx-ting` 11 800 ms vol 0,7 · piste 3 · `13-amb-canyon` 0 → 12 500 ms loop vol 0,5.
6. Transition : crossfade 400 ms.

---

## PLAN 5 — « Charge! » · 11,0 s · TRAVELLING · héros au centre, court vers la droite

**Vidéo de décor `P5_savanna_travelling` (12 s)** : savane au soir, herbes et fougères au premier plan, palmiers et araucarias espacés, rivière et collines au fond, ciel orange-rose. Mouvement : **travelling continu** — la caméra avance vers la droite à vitesse constante pendant tout le clip, tout le paysage défile de droite à gauche, le fond plus lentement (parallaxe). Aucun animal, aucun événement, bande centre-gauche libre.

**Faisabilité** : exactement le plan « Course » du T-Rex (Walk en boucle sur place + rumble + vidéo qui défile) avec une passe de Charge au milieu. 1 appear, 3 anim, 3 rumbles, 8 sons.

**Actions dans l'éditeur**
1. Waypoint : **WP1** (x 500, y 600, scale 0,9, regard →).
2. Mouvement : `appear` WP1 à 0 ms (pas de trajet : c'est le décor qui bouge).
3. Animation : **Walk** `loop` ×2,2 de 0 à 5 700 ms · **Fun fact - Charge** `once-hold` ×2 de 5 700 à 8 100 ms · **Walk** `loop` ×3 de 8 100 à 11 000 ms.
4. Caméra : `rumble` 0 → 11 000 ms (amplitude 2, 3 Hz) · `rumble` 2 000 → 3 000 ms (amplitude 4, 4 Hz : « heavy ») · `rumble` ancré ⚓ à Charge (amplitude 3, 8 Hz).
5. Sons : piste 1 · **V3a** à 800 ms · **V3b** à 4 400 ms · **V3c** à 9 600 ms (parlés ; « charge » tombe ≈ 6 000 ms, 0,3 s après le début de l'animation Charge) · piste 2 · `35-sfx-thud` 2 200 ms vol 0,8 · `31-sfx-whoosh` ancré ⚓ Charge start +0 vol 0,8 · `26-sfx-trice-growl` ancré ⚓ Charge start +200 ms vol 0,7 (pas parlé : la voix parle en même temps) · piste 3 · `05-sfx-pas` 0 → 11 000 ms **loop** vol 0,7 · `14-amb-savane` 0 → 11 000 ms loop vol 0,4.
6. Transition : crossfade 300 ms (la savane s'arrête « en douceur » sur le plan suivant).

---

## PLAN 6 — « BONK » · 4,5 s · gag final, sans parole

**Vidéo de décor `P6_big_trunk` (6 s)** : même savane au soir, caméra FIXE, un très gros tronc d'araucaria occupe le tiers droit du cadre (bord gauche du tronc à x ≈ 62 %, écorce bien visible), feuillage en haut, centre-gauche libre. Événements : **0,9 s** le tronc tremble d'un coup, des feuilles et deux petites branches tombent, deux oiseaux s'envolent de la cime ; **2,5 s** les oiseaux se posent sur une branche et regardent vers le bas ; quelques feuilles continuent de tomber jusqu'à la fin.

**Faisabilité — c'est ici que tout se joue, donc en clair** : le tronc, son tremblement, les feuilles et les oiseaux sont dans la VIDÉO, datés. Le héros est dessiné par-dessus : il arrive par un `travel` de 0,6 s (Walk ×3) jusqu'à WP2, placé pour que ses cornes se SUPERPOSENT au tronc, puis joue son animation « Humour - Stuck horns » (tête plantée en bas, il tire, la tête remonte gueule ouverte, deux fois), le tout avec un `shake` et un BONK au moment où la vidéo tremble. Il n'y a aucun contact réel : c'est une superposition + un événement daté + un son, exactement comme le bec du Ptéranodon « attrape » le poisson. Si, au montage, la superposition cornes/tronc ne se lit pas, on recule WP2 de 40 px et le gag reste « BONK + tête qui tire », toujours lisible. 1 appear, 1 travel, 2 anim, 1 shake, 6 sons.

**Actions dans l'éditeur**
1. Waypoints : **WP1** (x 500, y 600, scale 0,9, regard →) · **WP2** (x 610, y 600, scale 0,9, regard →) — WP2 tel que le bout des cornes tombe sur l'écorce (≈ x 800 en coords décor) ; à ajuster sur la vidéo réelle.
2. Mouvement : `appear` WP1 à 0 ms · `travel` WP1 → WP2 de 0 à 600 ms, easeIn, animation Walk ×3.
3. Animation : **Humour - Stuck horns** `once-hold` ×2 de 600 à 3 000 ms (une passe : plantée, tire, plantée, tire) · Idle `loop` ×0,6 de 3 000 à 4 500 ms (penaud, tête relevée).
4. Caméra : `shake` ancré ⚓ à Stuck horns start +300 ms (amplitude 16, 14 Hz, rotation, expo, 700 ms).
5. Sons : piste 2 · `36-sfx-bonk` ancré ⚓ à Stuck horns start +0 vol 1 · `37-sfx-crack` ancré ⚓ Stuck horns start +100 ms vol 0,8 · `23-sfx-boing` ancré ⚓ Stuck horns start +1 300 ms vol 0,7 (il tire) · `38-sfx-oiseaux-moqueurs` 2 500 ms vol 0,6 · `39-sfx-ding` 3 600 ms vol 0,8 · piste 3 · `05-sfx-pas` offset 2 250 durée 600 ms ancré ⚓ au travel vol 0,8 · `14-amb-savane` 0 → 4 500 ms loop vol 0,4.
6. Fin du film : outro iris 1 000 ms.

Enchaînement avec le plan 5 : « coming through! » finit à 11,6 s du plan 5, crossfade 300, BONK à 0,6 s du plan 6 → 0,9 s entre le dernier mot et le choc.

---

## Chronologie globale

| Plan | Durée | Cumul | Côté du héros |
|---|---|---|---|
| iris in | 1,0 s | 1,0 | — |
| 1 Presentation | 9,0 + 0,4 | 10,4 | gauche → |
| 2 Giant horns | 12,5 + 0,4 | 23,3 | droite ← |
| 3 Nobody messes with me | 14,5 + 0,8 | 38,6 | droite ← |
| 4 A dinosaur shield | 12,5 + 0,4 | 51,5 | gauche → |
| 5 Charge! | 11,0 + 0,3 | 62,8 | centre → |
| 6 BONK | 4,5 | 67,3 | centre → |
| iris out | 1,0 | 68,3 | — |

Contrôles : 6 plans · 68 s · un seul plan d'action (3) et un seul plan muet (6, 4,5 s) · aucun `once-hold` sur une boucle · chaque action une passe puis Idle · héros visible 100 % · échelles 0,85–0,9 · premier mot ≥ 0,8 s, dernier mot ≥ 0,8 s avant la coupe · musique continue + une ambiance par plan.

---

## Assets à produire

### Images de départ (GPT, 16:9, style = `docs/films/style-reference/reference_unique.jpg`)

Base commune : *Children's colored-pencil illustration in the exact style of the reference image: bold black outlines, simple naturalistic shapes, visible pencil hatching, flat bright colors, no painterly rendering, no fine detail, no text. Side view, horizontal 16:9 landscape, ground line visible in the lower quarter of the frame. No triceratops in the scene (except where stated).*

- **P1_fern_prairie** — a sunny prehistoric prairie of tall ferns and grass seen from the side, a forest of tall conifers in the background, a smoking volcano very far away on the left, a fallen mossy log and big mossy boulders in the right third, warm golden morning light, blue sky with a few soft clouds. The center-left of the frame stays empty.
- **P2_rocky_plateau** — a dry rocky plateau of pale rock and sandy ground seen from the side; big boulders and cycad plants in the LEFT third; rolling hills far away; blue sky with cumulus clouds; flat ground. The center-right of the frame stays empty. No animals.
- **P3_swamp_clearing** — a dark prehistoric swamp clearing at dusk seen from the side: tall cycads and mossy tree trunks, still water and reeds in the LEFT third, low mist on the ground, blue-green evening light, bare earth in the lower quarter. The center-right of the frame stays empty. No dinosaur.
- **P4_red_canyon** — the floor of a canyon with red and ochre rock walls at late afternoon, sandy ground with pebbles in the lower quarter, a few dry bushes, golden sky; far away in the right background, two very small triceratops (naturalistic, documentary look) stand facing each other. The center-left of the frame stays empty.
- **P5_savanna** — a wide prehistoric savanna at sunset seen from the side: tall grass and ferns in the foreground, scattered palm trees and araucaria trees, a river and low hills in the far background, orange-pink sky, long shadows. The center-left of the frame stays empty. No animals.
- **P6_big_trunk** — the same prehistoric savanna at sunset, seen from the side: a very big, thick araucaria trunk with clearly visible bark standing in the right third of the frame, its foliage at the top, tall grass at its foot, savanna and pink sky behind. The center-left of the frame stays empty. No animals.

### Vidéos (Grok Imagine, image-to-video, 720p)

- **P1 (10 s)** — Static camera. The ferns and grass sway gently in the breeze, a few butterflies drift across the middle, the distant volcano puffs a little smoke, clouds move slowly. Calm, loopable, nothing enters the frame.
- **P2 (13,5 s)** — Static camera, gentle loopable motion (grass, clouds) for the first 8 seconds. At 8.2 s a small chicken-sized compsognathus (green-brown, naturalistic) trots into the frame from the LEFT edge and stops at the center of the frame at 9.4 s, lifting its head to look up toward the right; at 10.4 s it turns around and runs away to the left, out of the frame at 11.4 s, leaving a small puff of dust; then only the grass and clouds move. The right half of the frame stays free.
- **P3 (15,5 s)** — Static camera. Mist drifts slowly over the ground, reeds sway. At 4.5 s a fierce realistic T-Rex bursts into the frame from the LEFT edge, head first, stopping in the left third; at 5.0 s it roars with its jaws wide open; at 6.0 s it takes one heavy step toward the center raising dust; at 7.5 s it suddenly stops, eyes wide with fear, and steps back; from 8.0 s to 9.5 s it turns around and runs away out of the left edge in a cloud of dust; after that only the mist moves. The right half of the frame stays free the whole time.
- **P4 (13,5 s)** — Static camera. Heat haze shimmers, dry bushes tremble. At 5.0 s the two small triceratops in the far right background lower their heads and lock horns, pushing each other and raising dust until 7.5 s, then they separate and slowly walk apart; two birds fly up at 5.2 s. The center-left of the frame stays free.
- **P5 (12 s)** — TRAVELLING shot: the camera moves steadily to the right so that the whole savanna scrolls continuously from right to left at a constant speed for the entire clip, the far hills and sky moving slower (parallax). No animals, nothing enters the frame, the camera never slows down. The center-left band of the frame stays free.
- **P6 (6 s)** — Static camera. The grass sways gently. At 0.9 s the big trunk shakes violently as if something hit it: leaves and two small branches fall from the foliage and two birds fly up from the top. At 2.5 s the two birds land on a branch and look down. A few leaves keep falling until the end. The center-left of the frame stays free.

### Sons (Envato — mots-clés)

| Fichier | Recherche Envato | Durée | Volume |
|---|---|---|---|
| musique | `playful adventure kids orchestral loop` | boucle | 0,8 |
| 10-amb-prairie | `meadow birds insects ambience loop` | 10 s | 0,5 |
| 11-amb-rocaille | `desert wind light ambience loop` | 14 s | 0,5 |
| 12-amb-marecage | `swamp frogs crickets dusk ambience` | 16 s | 0,5 |
| 13-amb-canyon | `canyon wind distant birds ambience` | 14 s | 0,5 |
| 14-amb-savane | `savanna evening ambience loop` | 12 s | 0,4 |
| 05-sfx-pas | **fourni : `Audio Marche.mp3`** | 6,3 s | 0,6–0,8 |
| 20-sfx-petits-pas · 21-sfx-couinement · 22-sfx-gulp | `small creature scurry footsteps` · `cute creature squeak` · `cartoon gulp` | 1–2 s | 0,6–0,8 |
| 23-sfx-boing | `cartoon boing` | 1 s | 0,7–0,8 |
| 24-sfx-riser | `suspense riser short` | 3 s | 0,7 |
| 25-sfx-trex-roar | `t-rex roar` | 2 s | 1,0 |
| 26-sfx-trice-growl · 27-sfx-trice-bellow | `bull snort growl` · `triceratops bellow roar` | 1–2 s | 0,7–1,0 |
| 28-sfx-skid · 29-sfx-whimper | `cartoon skid stop` · `dinosaur whimper` | 1 s | 0,8 |
| 30-sfx-dino-flee | `dinosaur running away footsteps` | 2 s | 0,8 |
| 31-sfx-whoosh | `soft whoosh air` | 1 s | 0,7–0,8 |
| 32-sfx-thud-lointain · 33-sfx-bellow-lointain | `distant impact thud` · `dinosaur bellow distant` | 1 s | 0,4–0,5 |
| 34-sfx-ting | `metal shield ting` | 1 s | 0,7 |
| 35-sfx-thud | `heavy ground thud` | 1 s | 0,8 |
| 36-sfx-bonk · 37-sfx-crack | `wood bonk impact` · `tree branch crack leaves` | 1 s | 1,0 / 0,8 |
| 38-sfx-oiseaux-moqueurs | `birds chirping cartoon laugh` | 2 s | 0,6 |
| 39-sfx-ding | `cartoon success ding` | 1 s | 0,8 |

---

## Images de décor générées (24/09, étape 2)

Dossier `gpt-trice/` (GPT `gpt-image-2.5-sunburst`, 1792×1008, style = référence unique, `gen_backdrops.py set=trice`). Aperçus dans `qa/preview-P*.jpg`, planche `qa/backdrops-sheet.jpg`.

| Image | Verdict |
|---|---|
| `P1_fern_prairie.png` | prairie de fougères, forêt de conifères, volcan qui fume à gauche, tronc couché + rochers moussus à droite, soleil du matin : conforme. Centre-gauche libre (le héros se pose sur la prairie, quelques fougères au premier plan passeront derrière ses pattes). **OK** |
| `P2_rocky_plateau.png` | blocs + cycas dans le tiers gauche, sol de sable plat, collines, cumulus : conforme. Centre-droit libre pour le héros en miroir ; le petit dino entrera par la gauche, devant les rochers. **OK** |
| `P3_swamp_clearing.png` | marécage au crépuscule : eau et roseaux à gauche, brume, troncs moussus, chemin de terre au centre-droit : conforme. Le T-Rex entrera par la gauche en pataugeant dans l'eau (à écrire dans le prompt vidéo). **OK** |
| `P4_red_canyon.png` | canyon rouge et ocre, sable et galets, ciel doré, deux petits tricératops face à face au fond à droite : conforme, centre-gauche libre. **OK** |
| `P5_savanna.png` | savane au soir, palmiers à gauche, araucarias à droite, rivière et collines, ciel orange-rose : conforme, centre libre, image de départ du travelling. **OK** |
| `P6_big_trunk.png` | gros tronc d'araucaria à droite (bord gauche du tronc à x ≈ 72 % du cadre, un peu plus à droite que prévu), feuillage en haut, herbes et rochers au pied : conforme. Conséquence : **WP2 du plan 6 à x ≈ 740** (au lieu de 610) pour que les cornes tombent sur l'écorce ; à caler sur la vidéo. **OK** |

---

## Vidéos générées (24/09, étape 3 — plans 1 et 2 d'abord)

Dossier `videos/` (Grok Imagine `grok-imagine-video-1.5`, image-to-video, 1280×720, 24 i/s, `gen_videos.py film=trice`). Originaux ≈ 20–25 Mo, versions `*-web.mp4` ré-encodées H.264 CRF 21 (12–15 Mo) utilisées dans le film. Planches-contact 1 img/s : `videos/P*-sheet.jpg`.

| Vidéo | Verdict |
|---|---|
| `P1_fern_prairie-web.mp4` (10,0 s) | caméra fixe, fougères qui ondulent, papillons, fumée du volcan, rien n'entre : **conforme**. |
| `P2_rocky_plateau-web.mp4` (14,0 s) | le petit dino entre par la gauche **dès 4,0 s** (demandé 8,2 s), arrive au centre ≈ 7 s, se dresse et regarde vers la droite 8 → 9,5 s, fait demi-tour et détale 10,2 → 11,5 s, plateau vide ensuite. Moitié droite libre tout du long. **Retenue** : la timeline est calée sur ces secondes réelles (il s'approche pendant les deux phrases, se dresse juste après « skateboard », fuit à 10,2 s). Sons d'événements à poser : petits pas 4,0 → 7,0 s, couinement 8,5 s, gulp 9,8 s, boing 10,2 s, fuite 10,2 → 11,5 s. Si on préfère une entrée tardive, régénérer avec « nothing moves before 8 s ». |
| `P3_swamp_clearing-web.mp4` (15,0 s) | T-Rex entre par la gauche à **4,0 s** en pataugeant, **rugit à 5,0 s** (conforme), pas + éclaboussure 6,0 s, puis reste **figé face au héros de 7 à 10 s** (au lieu de reculer à 7,5 s) et **détale à 10,5 → 12,3 s** dans la poussière (au lieu de 8,0 → 9,5). Moitié droite libre. **Retenue** : le héros rugit à 8,2 s (cause), le T-Rex fuit à 10,5 s (effet) ; réplique à 12,0 s ; plan porté à 15,0 s. |
| `P4_red_canyon-web.mp4` (14,0 s) | les deux tricératops du fond s'approchent à 3,5 s, **cornes bloquées + poussière 4,5 → 7,5 s**, oiseaux à 5,5 s, séparation 8 → 10 s, calme ensuite. Très petits et lointains, centre-gauche libre : **conforme** (« during battles » 4,4 → 7,7 s tombe pile sur la bataille). |

## Assemblage (étape 4) — kit + importeur

- `build_kit.py` construit `kit-p1p2.json` (FilmTDoc + fichiers à envoyer) avec des **ids déterministes** (uuid5) : relancer le script ne change aucun id, on complète plan par plan.
- `build_kit.py project=ef7201a8-3106-4698-8752-f672c5ad023b plans=P1,P2` → `kit-p1p2-ef7201a8.json` (ids d'animations du bon projet).
- `../film_import.py <projectId> <kit.json> [--dry-run] [--remove]` : sauvegarde l'ancien `filmT`, envoie décors/sons dans Storage (`film/plans/{planId}/backdrop`, `film/sounds/{soundId}`), écrit `filmT` (updateMask `filmT` uniquement) via l'API REST avec le jeton gcloud du compte propriétaire `nicolas.rocher38@gmail.com` (IAM : les règles Firebase ne s'appliquent pas). Simulation validée le 24/09 (8 fichiers, 2 plans). L'écriture réelle est lancée par Nicolas (bloquée en auto-mode côté agent).
- Contenu du test P1–P2 : voix V0, V1a, V1b (parlées), pas `Audio Marche` sur le trajet du plan 1, musique = « Ambiance terrestre V2 » du film T-Rex (0,8) en attendant la vraie ; **pas encore** d'ambiances ni de bruitages Envato (pistes prévues, vides).
- Plans 3–4 (25/09, `--merge`) : bruitages repris de la bibliothèque du film T-Rex (riser « suspense sound », rugissement T-Rex, « dinosaur flee », whoosh, cri de ptéro) ; le rugissement du héros = le rugissement T-Rex ralenti (rate 0,75, parlé) et son grondement (rate 0,6) ; beuglement lointain du plan 4 = rugissement à 0,25 / rate 0,7. À remplacer par des sons dédiés (bull snort, triceratops bellow, ambiances).
- ⚠ Après l'import : **recharger l'admin (F5) avant toute sauvegarde depuis l'onglet FILM**, sinon l'onglet réécrirait son `filmT` en mémoire (il contenait un « Plan 1 » vide) par-dessus l'import.

---

## Points à valider (v4)

1. Plan 2 : petit dino curieux dans la vidéo, héros immobile. OK ?
2. Plan 3 : Charge (menace) puis Stuck horns coupé à 2 s comme rugissement, T-Rex qui fuit dans la vidéo, réplique. OK ?
3. Côtés : P1/P4 à gauche, P2/P3 à droite (miroir), P5/P6 vers la droite. OK ?
4. Plans 5 + 6 : travelling pur, puis plan fixe « BONK » = superposition cornes/tronc + tremblement daté dans la vidéo + Stuck horns + son. OK, ou tu préfères une fin sans BONK (il s'arrête, souffle, dernier « ding ») ?
5. Firestore : le projet `efa2953a…` n'a toujours pas les frames de « Stuck horns » (document inchangé depuis le 15/09). Sauvegarde à refaire, ou autre projet ?

---

## v5 « semi-manuel » (25/09/2026) — IMPORTÉ dans `ef7201a8` (remplace la v4, sauvegarde `kit-v5-ef7201a8.backup-*.json`)

Plan de Nicolas : images de départ GPT (`gpt-trice-v2/`, `gen_start_images.py`, style = `style-reference/reference_trex_bus.png`),
vidéos faites à la main dans Grok Imagine (`videos-v2/P1..P6.mp4`, 1280×720, 24 i/s, 10 s + 5×15 s), ré-encodées
`*-web.mp4` (CRF 21, P2 CRF 24, P6 CRF 27). Kit : `build_kit_v5.py` → `kit-v5-ef7201a8.json`. Durée totale ≈ 81,5 s.
Le héros fait ≈ 450 px de large (image 1254² ajustée à la hauteur 720 × scale) : positions choisies sans aucun chevauchement.

| Plan | Vidéo (événements datés, planche `videos-v2/P*-sheet.jpg`) | Héros | Voix / sons | Durée |
|---|---|---|---|---|
| 1 Presentation | prairie + rivière au milieu, rien ne bouge | entre G (Walk ×1,2) → rive gauche x 330 à 3,2 s · idle · **Jump ×2** 4,6 → 7,0 s jusqu'à x 900 · repart et sort D 7,4 → 10 s | V0 0,8 s · whoosh saut · gros pas à l'atterrissage · pas en boucle sur les trajets | 10,0 s |
| 2 Giant horns | lisière quasi fixe | traverse tout le cadre G → D en marchant (Walk ×1,1, 0 → 12,5 s) | V1a 0,6 · V1b 4,3 · V1c 8,4 s | 12,5 s |
| 3 Velociraptor | raptor bord droit, **crie 2,0 s**, avance 3–7 s (x ≥ 680), **sursaute 8,0 s**, se retourne 9 s, **fuit 10–11,5 s** | entre G → x 320 (2 s) · idle · **Charge** (menace) 3,8 → 6,2 s · **Stuck** (rugit) 6,2 → 8,2 s · idle | cri raptor 2,0 s (roar T-Rex ×1,5) · riser 2,5 → 6,2 · grondement 4,0 · **rugissement 6,5 s** · fuite 10,0 · whoosh 11,0 | 14,5 s |
| 4 Neck frill | canyon, virevoltant D → G 3–10 s (derrière le héros), oiseaux | centre x 640, idle, zoom collerette 1 → 4,2 s, **Stuck** (rugit) 11,8 → 13,8 s | V2a 0,8 · V2b 4,3 · V2c 8,3 · rugissement 12,1 s | 14,0 s |
| 5 Face au T-Rex | T-Rex à droite (x ≥ 600), **rugit 3,0–4,5 s**, campé 5–7, **sursaute 8,0 s** (x ≥ 500), se retourne 9, **fuit 10–11,5 s**, vide dès 12 | x 230 scale 0,85 · idle · Charge (menace) 5,0 → 6,4 · **Stuck** (rugit) 6,4 → 8,4 · idle · **travel Charge ×2 → sort D 12,0 → 14,5 s** | riser 0 → 3 (musique qui s'emballe) · roar T-Rex 3,0 · grondement 5,2 · **rugissement 6,7 s** · fuite 10,0 · whoosh 11,2 · whoosh + grondement + pas à la charge 12,0 | 14,5 s |
| 6 Poursuite | travelling, T-Rex court à droite tout du long | x 300, **Walk ×2,5** sur place + rumble 0 → 12 s | V3b 1,5 · V3c 7,0 · pas en boucle | 12,0 s |

Non utilisé : V3a « I was as heavy as a small truck » (absent du plan de Nicolas ; à poser dans le plan 6 à 0,8 s si voulu, en décalant V3b/V3c).
Sons provisoires : rugissements du héros = roar T-Rex ralenti (×0,75 / ×0,6), cri du raptor = roar T-Rex accéléré (×1,5),
« musique qui s'emballe » = riser seul (la musique reste « Ambiance terrestre V2 »). Poster = plan 5 à 3,2 s.
