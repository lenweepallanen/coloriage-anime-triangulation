# Mini-film « Plesiosaurus » — script v1 (à valider)

Projet admin : `Dino 3 - Plesiosaurus` (`fe3550a0-d890-451c-8cbc-23c175dc4557`, livre DINOSAUR COLORING BOOK).
Gabarit de rythme : film T-REX (TEST BOOK REVIEW) — 5 plans, ~57 s + iris, un plan muet d'action au milieu, gag final.

## Synopsis (lecture rapide)

Un plésiosaure se présente dans un récif, traverse l'océan profond où un mosasaure surgit derrière lui, lui échappe dans un tunnel rocheux, montre son long cou dans une forêt de kelp, puis nage avec une tortue et la suit en travelling pour finir. Environ 72 s, 4 répliques, 2 plans muets.

**1 · Récif corallien · 10,5 s · vidéo `videos-v1/P1_coral_reef.mp4`**
Il arrive en nageant par la gauche dans un récif lumineux, s'arrête au centre, la caméra zoome sur sa tête. Il se présente :
> « Hey, I'm Plesiosaurus, a long-neck sea reptile that ruled the ancient ocean! » *(Audio Intro, 2,7 → 9,0 s)*

**2 · Pleine eau profonde · 13,5 s · vidéo `videos-v1/P2_open_deep_ocean_v2.mp4`**
Il traverse lentement l'océan bleu nuit pendant que de grandes silhouettes (ichtyosaure, raie) glissent au loin. Il raconte sa vie. Pile sur « the ocean was my home », un énorme mosasaure surgit derrière lui par la droite : silence, sursaut, CHOMP, volet.
> « I spent my life swimming through ancient oceans! Giant sea creatures lived beside me underwater. The ocean was my home! » *(Audio 1, 0,5 → 12,2 s — le mosasaure apparaît à 10 s)*

**3 · Tunnel rocheux, poursuite · 9,5 s · SANS PAROLE · TRAVELLING · vidéo `videos-v1/P3_rock_tunnel_v7a.mp4`**
Le tunnel défile vers la gauche, il nage à toute vitesse sur place à GAUCHE du cadre, le mosasaure le poursuit depuis la droite en claquant des dents (3 s, 5 s). Une petite ouverture dans la roche arrive par la gauche (6 s), le plésiosaure s'y faufile, le mosasaure s'y cogne le museau (7 s) et des bulles entrent dans le trou : raté ! Musique de poursuite, clacs, bonk.

**4 · Forêt de kelp · 10,5 s · TRAVELLING vertical · vidéo `videos-v1/P4_kelp_forest_v2a.mp4`**
Posé au milieu des grandes algues dorées, il étire son cou vers le haut sur « SUPER long ». Les petits poissons cachés dans la roche jaillissent (4,5 s) et la caméra monte en les suivant, le kelp défile vers le bas, la lumière s'éclaircit.
> « My neck was SUPER long! It helped me spot fish underwater. » *(Audio 2, 0,6 → 7,6 s)*

**5 · Herbier près de la surface · 11,5 s · vidéo `videos-v1/P5_seagrass_meadow.mp4`**
Il arrive à côté d'une tortue de mer et nage avec elle, zoom sur ses quatre nageoires. Sur « like an underwater turtle » il l'imite en nageant au ralenti, l'air fier ; la tortue se retourne, surprise (9 s). Fondu.
> « I used my four flippers to swim through the sea. I moved a little like an underwater turtle! » *(Audio 3, 0,8 → 8,9 s)*

**6 · On suit la tortue · 15 s · SANS PAROLE · TRAVELLING · vidéo `videos-v1/P6_turtle_follow_a.mp4`**
La tortue nage vers la droite et la caméra la suit, l'herbier défile ; le plésiosaure la suit tranquillement, un peu derrière, en nageant sur place. Fin douce sur les deux compères, iris de fin.

---

## Texte (version corrigée, lue par les mp3 existants)

| Fichier | Durée | Texte |
|---|---|---|
| Audio Intro.mp3 | 6,27 s | Hey, I'm Plesiosaurus, a long-neck sea reptile that ruled the ancient ocean! |
| Audio 1.mp3 | 11,65 s | I spent my life swimming through ancient oceans! Giant sea creatures lived beside me underwater. The ocean was my home! |
| Audio 2.mp3 | 7,00 s | My neck was SUPER long! It helped me spot fish underwater. |
| Audio 3.mp3 | 8,13 s | I used my four flippers to swim through the sea. I moved a little like an underwater turtle! |

Parole totale : 33 s. Le reste (≈ 24 s) = entrées de champ, action muette, gags.

## Réglages film

| Réglage | Valeur |
|---|---|
| Personnage | facing `left` (sens du dessin), scale 1, origine (0.5, 0.6) — centre du corps, pas les pieds : un nageur flotte, il ne se pose pas |
| Animations utilisées | **Idle** (nage, boucle) · **Discours 2** (cou qui s'étire + parle) · **Jump** (sursaut : tête qui se relève, corps qui bascule légèrement). Aucune animation à créer. |
| Règle mouvements | Pas de roulade, tourbillon ni acrobatie : trop dur à rigger. Le héros ne fait que des gestes simples : ondulation, sursaut, cou qui s'étire, nage plus ou moins vite. Le spectaculaire est dans le DÉCOR et les sons. |
| Musique | ambiance sous-marine douce en boucle, volume 0,75 (Envato : `underwater ambient calm kids loop`) |
| Intro | iris 1000 ms |
| Outro | iris 1000 ms (remplace le wipe actuel, pour matcher T-REX) |
| Bruits de pas | désactivés (nageur) |
| Décors | vidéos Grok Imagine 1264×720, cameraX = 632, style = référence unique `docs/films/style-reference/reference_unique.jpg` |
| Travelling | RÈGLE : au moins un plan où le DÉCOR DÉFILE et le héros joue sa nage sur place (le mouvement vient du fond). Ici : plan 3, tunnel rocheux. |
| Poster | plan 4 vers 3 s (cou tendu, drôle et lisible) |

Grammaire caméra (comme T-REX) : zoom sur les moments posés, léger rumble (amplitude 1, 2 Hz) pendant les nages rapides, shake (16, 14 Hz, rotate, decay expo, 700 ms) sur chaque impact.

---

## PLAN 1 — « Presentation » · 10,5 s · posé

**Décor — RÉCIF CORALLIEN (vidéo à GÉNÉRER, 12 s)** : massifs de corail (cerveau, corne de cerf, gorgones) orange, rose, violet, jaune sur des rochers gris, bancs de poissons de récif, une ammonite à gauche, deux ichtyosaures réalistes (silhouette dauphin, dos bleu foncé, museau pointu) qui passent loin au fond à droite. Eau turquoise claire, pas de sable visible. Beaucoup d'eau libre au centre-gauche pour le héros.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 → 3,0 s | **travel** depuis hors-champ gauche (x −150, y 430) → WP1 (x 520, y 440, scale 0,9, facing right). Anim de trajet : Idle 1× | bulles douces (0,2 s, 2 s) | zoom 2,5 → 8,5 s sur la tête, rect ≈ (x 250, y 180, w 700, h 394), easeInOut, zoomOut 1500 ms |
| 3,0 → 10,5 s | Idle loop 0,8× sur WP1 | **Audio Intro** 2,7 → 9,0 s (parlé) | — |
| 10,5 s | — | — | **crossfade 600 ms** |

Note : pendant le trajet Idle est déjà une nage, pas besoin d'animation de déplacement dédiée.

Vidéo générée (`videos-v1/P1_coral_reef.mp4`, 12,0 s) : ichtyosaures qui glissent lentement de droite à gauche au fond, poissons et ammonite qui dérivent, corail qui ondule. Calme, conforme, centre-gauche libre.

---

## PLAN 2 — « The ocean was my home » · 13,5 s · posé → tension

**Décor — PLEINE EAU PROFONDE (vidéo à GÉNÉRER, 14 s)** : pleine eau bleu nuit, SANS surface ni fond visibles, neige marine qui dérive, quelques bulles. De 0 à 9 s, de grandes silhouettes glissent au loin : un énorme ichtyosaure de droite à gauche (1 → 6 s), une raie géante plus bas (4 → 9 s), un banc de poissons argentés. À 10 s, un gros mosasaure (formes réalistes, mais pas effrayant : gueule ouverte, regard ahuri) entre par la droite et grossit jusqu'à remplir la moitié droite de l'écran à 12 s, puis reste là dents dehors.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 → 11,0 s | **travel** lent gauche → droite : (x −150, y 470) → WP1 (x 700, y 470, scale 0,85, facing right). Idle 0,7× (balade tranquille) | **Audio 1** 0,5 → 12,2 s (parlé). Baleines 1 → 6 s, volume 0,5 | — |
| 9,5 s | (continue) | riser de tension 9,5 → 12,5 s, volume 0,7 | rumble 10 → 12,5 s, amplitude 1, 2 Hz |
| 11,0 → 12,3 s | Idle figé (once-hold) — il finit sa phrase « The ocean was my home! » sans voir le mosasaure derrière lui : silence comique | — | — |
| 12,3 → 13,5 s | **Jump** 1,5× once-hold (sursaut) | gros « CHOMP » / grognement de mosasaure à 12,4 s, bulles explosives 12,6 s | shake à 12,4 s |
| 13,5 s | — | — | **wipe left 400 ms** (comme T-REX avant la fuite) |

Gag : la voix dit « The ocean was my home! » pile quand le mosasaure apparaît derrière lui.

Vidéo générée (`videos-v1/P2_open_deep_ocean.mp4`, 14,0 s) : silhouettes qui dérivent 0 → 9 s (ichtyosaure vers la gauche, raie vers le bas-droite), **mosasaure entre par la droite à 10 s**, sa tête (gros œil rond, air ahuri, pas effrayant) remplit le tiers droit de 11 à 14 s. Timings conformes. Placer WP1 à **x 620** plutôt que 700 pour que le museau arrive juste derrière le héros sans le recouvrir. Retour Nicolas : le monstre doit être le MÊME que celui du tunnel (mosasaure « crocodile préhistorique » de la v3/v4) → vidéo v2 (`videos-v1/P2_open_deep_ocean_v2.mp4`), même mise en scène, même image de départ. Vidéo v2 générée le 2026-09-15 (`videos-v1/P2_open_deep_ocean_v2.mp4`, 14 s) : silhouettes 0 → 9 s, **le mosasaure crocodile (même créature que le tunnel) entre par la droite à 10 s** et remplit la moitié droite de 12 à 14 s. RETENUE.

---

## PLAN 3 — « La poursuite » · 9,5 s · action MUET · TRAVELLING

**Décor — TUNNEL ROCHEUX EN TRAVELLING (vidéo à GÉNÉRER, 10 s)** : vue de côté dans un long tunnel de roche sous-marin : plafond rocheux avec stalactites en haut, sol de blocs en bas, large bande d'eau libre au milieu, quelques trouées de lumière. TOUT LE DÉCOR DÉFILE de droite à gauche à vitesse constante pendant tout le plan (le héros nage sur place devant). Un gros mosasaure (réaliste, pas effrayant) entre par la gauche à 1 s et suit à la même vitesse, gueule ouverte, claque des dents à 3 s et à 5 s. À 6,5 s un gros pilier de roche arrive de la droite avec le décor ; à 7 s le mosasaure s'y cogne le nez, reste étourdi (bulles) et est emporté hors champ à gauche par le défilement. Pas de sang, pas de peur réelle.

| t | Héros | Sons | Caméra |
|---|---|---|---|
| 0,0 → 1,5 s | **travel** (x −180, y 380) → WP1 (x 900, y 380, scale 0,85, facing right) : entrée rapide par la gauche, il se place à DROITE du cadre (le mosasaure de la vidéo occupe la moitié gauche et le centre de 1 à 6 s). Idle **2,2×** (nage rapide) | poursuite légère 0 → 8 s (type « chase underwater kids »), bulles rapides 0 → 6,5 s en boucle | rumble 0 → 6,5 s, amplitude 2, 3 Hz |
| 1,5 → 6,5 s | Idle loop **2,2×** SUR PLACE sur WP1 : c'est le décor qui défile derrière lui (travelling) | (continue) | (continue) |
| 3,0 s et 5,0 s | (continue) | « clac » de mâchoire ×2 | mini-shake 300 ms ×2 |
| 6,5 → 8,0 s | **Jump** 1,5× once-hold : sursaut, la tête se relève d'un coup au moment où le mosasaure charge, puis il repart | « whoosh » aquatique 6,5 s | — |
| 7,0 s | — | « BONK » cartoon + petit « boing » 7,2 s (le mosasaure se cogne) | shake 7,0 s |
| 8,0 → 9,5 s | **travel** WP1 → trou de sortie (x 1090, y 470, **scale 0,6** : il s'éloigne dans le trou) puis **exit** : il se faufile par la petite ouverture dans la roche qui arrive de la droite avec le défilement (vidéo v2). Idle 2× | whoosh 8,0 s, bulles | — |
| 9,5 s | — | — | **crossfade 1000 ms** |

Note : plan TRAVELLING — le mouvement vient du fond (décor qui défile), le héros nage sur place à 2,2×. Le pilier, le mosasaure et le « bonk » sont dans la VIDÉO de décor ; le héros n'a rien à faire d'autre que nager vite, sursauter et sortir.

Vidéo v1 (`videos-v1/P3_rock_tunnel.mp4`, 10,0 s) : mosasaure entre par la gauche 0 → 1 s, atteint le centre à 3 s, pilier à 6 s, bonk à 7 s. Retours Nicolas : (1) le monstre doit rester plus à GAUCHE pour laisser la place au héros à droite ; (2) il faut une SORTIE (petit trou dans la roche) pour que le héros se faufile à la fin ; (3) prédateur plus effrayant, type requin préhistorique gueule pleine de dents vu de 3/4 face (réf. CleanShot 15.22). → Vidéo v2 générée (`videos-v1/P3_rock_tunnel_v2.mp4`, 10,0 s) : grand requin préhistorique (dents, œil noir) entre par la gauche 0 → 1 s, gueule ouverte, reste dans la MOITIÉ gauche 1 → 6 s (il frôle le centre vers 3 s, puis recule vers x ≈ 30-45 %), pilier à 6 s, **bonk à 7 s** (bulles), emporté hors champ à gauche à 8 s. **Trou de sortie** rond dans un rocher en bas à droite, visible de 7,5 s à la fin, centre ≈ (x 1090, y 470) en coords 1264×720. Le héros reste à droite (WP1 x 900) puis se faufile dans le trou 8 → 9,5 s. Retour Nicolas : mise en scène OK mais c'est un REQUIN → v3 avec un reptile marin préhistorique (mosasaure : tête de crocodile, dents, 4 nageoires en pagaie, longue queue, réf. CleanShot 15.30), même mise en scène (`P3_rock_tunnel_v3.mp4`). Vidéo v3 générée : le prédateur est bien un mosasaure (tête de crocodile, nageoires en pagaie, dents), bonk à 7 s, trou de sortie en arche à droite de 7 à 10 s — mais il est trop grand et traverse tout le cadre (museau à droite de 3 à 6 s). → Vidéo v4 générée (`videos-v1/P3_rock_tunnel_v4.mp4`, 10,0 s) : mosasaure qui entre par la gauche à 1 s et reste dans la MOITIÉ gauche tout le clip (museau ≈ 35-50 % de la largeur), clac 3 s / 5 s, pilier à 6 s, **bonk à 7 s** (bulles 7 → 8 s), trou de sortie lumineux à droite de 7 à 10 s. Bémol : entre 5 et 9 s la perspective du tunnel se creuse en profondeur au lieu de rester une vue de côté. **MEILLEURE VERSION à ce stade** ; si la perspective gêne, v5 en imposant « strict side view, no perspective change ».

**v5 (à générer, 3 variantes)** — nouvelle image de départ de Nicolas `videos-v1/62ba9df6-….png` (→ `start-frames/P3_rock_tunnel_new.jpg`) : le mosasaure est à DROITE face à gauche, donc la poursuite va vers la GAUCHE et le héros sera composité à gauche (facing left = sens natif du dessin, pas de flip). Fin voulue : une petite ouverture dans la roche arrive par la gauche, le monstre s'y cogne le museau (trop gros pour passer), des bulles entrent dans l'ouverture = le héros vient d'y passer. Variantes : **v5a** base (travelling vers la gauche, trou à 6,5 s, cognement à 7 s) · **v5b** vue de côté stricte + monstre collé au bord droit · **v5c** 12 s, cognement à 8,5 s. Au montage : le héros nage sur place à GAUCHE (WP1 ≈ x 350, y 400) puis file dans le trou (≈ x 150, y 420, scale 0,6) entre 6,0 et 6,8 s, juste avant le cognement. Vidéos v5a et v5b générées le 2026-09-15 (v5c non lancée). **v5a** (`P3_rock_tunnel_v5a.mp4`, 10 s) : poursuite vers la gauche 0 → 6 s, le tunnel se creuse un peu en perspective 4 → 6 s, **trou rond dans la roche à gauche dès 6 s**, gros nuage de bulles entre le museau et le trou à 7 s (cognement), traînée de bulles qui entre dans le trou 8 → 10 s, mosasaure qui recule. **RECOMMANDÉE**. **v5b** (`P3_rock_tunnel_v5b.mp4`) : même déroulé, mosasaure plus près du trou à 7 → 8 s, bulles vers le trou 7 → 9 s, perspective plus marquée 3 → 6 s. Montage : héros à gauche (WP1 ≈ x 350, y 400), entrée dans le trou (≈ x 150, y 400, scale 0,6) 6,0 → 6,8 s, cognement/bonk à 7,0 s, plan 9,5 s.

**v6 (2026-09-15)** : nouvelle base image « bleu profond » de Nicolas (`videos-v1/tunnel_v6_base.png` → `start-frames/P3_rock_tunnel_v6.jpg`), même mise en scène que v5 (poursuite vers la gauche, trou à gauche à 6,5 s, cognement 7 s, bulles dans le trou). **v6a** base, **v6b** vue de côté stricte + monstre collé au bord droit. Résultats (`P3_rock_tunnel_v6a.mp4` / `_v6b.mp4`, 10 s) : v6a = poursuite 0 → 5 s (perspective en couloir 3 → 5 s), **ouverture ovale à gauche dès 5,5 s**, gros nuage de bulles au museau 6 → 7 s (cognement), bulles qui rentrent dans le trou 8 → 10 s, monstre qui recule à droite — trou très lisible, monstre bien à droite → **RECOMMANDÉE**. v6b = monstre plus près du centre, tunnel en couloir 4 → 6 s, ouverture à gauche dès 6 s, bulles au museau 7 s, trou plus étroit et sombre. Retours Nicolas sur v6 : le monstre mange un poisson (un poisson traverse le trou), et un second tunnel s'enfonce vers le fond. **v7** (même base image) : AUCUN poisson (ils sortent du cadre dès la 1re seconde, mâchoires toujours vides), paroi du fond PLATE avec un seul petit trou rond, monstre qui nage VITE (coups de queue, traînée de bulles). v7a base / v7b monstre collé au bord droit. Résultats (`P3_rock_tunnel_v7a.mp4` / `_v7b.mp4`, 10 s) : plus de couloir en profondeur (fond plat vue de côté), plus de poisson mangé (les poissons sortent à gauche dans la 1re seconde), monstre en nage rapide avec traînée de bulles. **v7a** : monstre dans la moitié droite, petit trou rond sombre à gauche dès 5,5 s, gros nuage de bulles au museau à 7 s, bulles qui rentrent dans le trou 8 → 10 s, monstre qui recule → **RETENUE**. v7b : monstre plus près du centre (museau à ≈ 45 %), trou en arche à gauche dès 6 s, bulles au museau 7 s. Montage : héros à gauche (x ≈ 300, y 400), entrée dans le trou (x ≈ 130, y 400, scale 0,6) 6,0 → 6,8 s, bonk à 7,0 s.

---

## PLAN 4 — « Le cou périscope » · 10,0 s · posé + drôle

**Décor — FORÊT DE KELP (vidéo à GÉNÉRER, 11 s)** : grandes laminaires brun-doré et vert olive qui montent jusqu'en haut du cadre, lumière vert-or qui filtre entre les tiges, un plateau rocheux avec une anfractuosité sombre sur le tiers droit où se cache un banc de petits poissons argentés et jaunes. À 4,5 s ils jaillissent tous d'un coup vers le haut du cadre, à 8 s ils reviennent se cacher en jetant un œil. Le kelp ondule lentement.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 s | **appear** sur WP1 (x 470, y 480, scale 1,0, facing right) | bulles douces | — |
| 0,0 → 0,8 s | Idle loop | — | — |
| 0,8 → 5,8 s | **Discours 2** 1× once-hold (le cou s'étire vers le haut pendant « SUPER long ») | **Audio 2** 0,6 → 7,6 s (parlé) | zoom 1,0 → 5,5 s qui SUIT la tête : rect ≈ (x 250, y 60, w 720, h 405), zoomOut 1200 ms |
| 4,5 s | (cou tendu) | « pop » ×3 ou « sproing » quand les poissons jaillissent (dans le décor) | mini-shake 300 ms |
| 5,8 → 10,0 s | Idle loop 0,8× | — | — |
| 10,0 s | — | — | **crossfade 500 ms** |

Gag : le cou monte, les poissons paniquent. Le texte dit « spot fish », l'image montre qu'ils l'ont repéré aussi.

Vidéo générée (`videos-v1/P4_kelp_forest.mp4`, 11,0 s) : poissons cachés 0 → 4 s, **jaillissent vers 5,0 s** (sortent par le haut-gauche, hors champ à 7 s), reviennent 8 → 9 s, rentrés dans l'anfractuosité à 10 s. Décaler le « pop » et le mini-shake de 4,5 s → **5,0 s** ; la fin du Discours 2 (5,8 s) tombe pile après le jaillissement.

Retour Nicolas (2026-09-15) : les poissons ne doivent PAS revenir ; la caméra les SUIT en **travelling vertical vers le haut** (le cou qui s'étire = on monte avec lui). → **v2** (`videos-v1/P4_kelp_forest_v2a.mp4` / `_v2b.mp4`, même image de départ) : caméra fixe 0 → 4,5 s, jaillissement à 4,5 s, puis la caméra monte en continu jusqu'à la fin, les poissons restent vers le milieu du cadre et ne reviennent jamais, le kelp défile vers le bas, la lumière s'éclaircit vers la surface. Au montage : le héros reste à sa place à l'écran (c'est le décor qui descend), Discours 2 lancé pour que le cou s'étire pendant la montée (0,8 → 5,8 s → décaler à **4,0 → 9,0 s** pour coller au travelling), plan allongé à **10,5 s**, Audio 2 0,6 → 7,6 s conservé.
Résultats : **v2a** = caméra fixe 0 → 4 s, poissons sortent de la cachette à 4 → 5 s, la caméra MONTE de 5 à 11 s (rochers et anfractuosité disparaissent en bas, kelp qui défile, lumière qui s'éclaircit), les poissons montent vers le haut-droit et sortent presque du cadre à 10 → 11 s, aucun retour, aucun nouveau poisson → **RECOMMANDÉE**. v2b = même montée, mais le banc grossit et reste au centre jusqu'à la fin, avec 2-3 poissons colorés supplémentaires qui apparaissent en haut à droite à 8 s (moins propre).

---

## PLAN 5 — « Underwater turtle » · 11,5 s · posé + gag final

**Décor — HERBIER PRÈS DE LA SURFACE (vidéo à GÉNÉRER, 12 s)** : prairie d'herbes marines vert vif qui ondulent, quelques roches claires, eau turquoise, surface visible en haut avec des vaguelettes et des reflets. Une tortue de mer verte réaliste nage lentement de gauche à droite de 2 s à 10 s, à mi-hauteur, en battant des nageoires au ralenti. À 9 s elle tourne la tête vers le héros.

| t | Héros | Voix / sons | Caméra |
|---|---|---|---|
| 0,0 → 2,5 s | **travel** (x −150, y 470) → WP1 (x 420, y 470, scale 0,9, facing right) — il arrive à côté de la tortue | bulles | — |
| 2,5 → 8,0 s | Idle loop 1× (on VOIT les 4 nageoires travailler) | **Audio 3** 0,8 → 8,9 s (parlé) | zoom 2,5 → 6,5 s sur les nageoires, rect ≈ (x 200, y 300, w 760, h 428), zoomOut 1000 ms |
| 8,0 → 10,5 s | **Idle 0,4×** (nage au ralenti, très appliquée) : il « imite » la tortue en battant des nageoires tout doucement, l'air fier | « boing » cartoon doux 8,3 s, bulles 8,5 s | zoom léger 8,0 → 10,5 s sur le duo héros + tortue, rect ≈ (x 150, y 250, w 900, h 506) |
| 9,0 s | — | petit « huh ? » aigu ou « squeak » de tortue (dans le décor : elle se retourne) | — |
| 10,5 → 11,5 s | Idle figé, sourire | — | — |
| 11,5 s | — | — | **crossfade 800 ms** |

Vidéo générée (`videos-v1/P5_seagrass_meadow.mp4`, 12,0 s) : la tortue nage de gauche à droite 0 → 8 s (elle est au centre vers 4 s, à droite vers 7 s), **se retourne vers la gauche à 9 s** et reste face au héros 10 → 12 s. Conforme. Le héros arrive à côté d'elle (WP1 x 420) pendant qu'elle passe au centre ; sa nage au ralenti (8 → 10,5 s) coïncide avec le demi-tour de la tortue.

---

## PLAN 6 — « On suit la tortue » · 15 s · SANS PAROLE · TRAVELLING

**Décor — HERBIER EN TRAVELLING VERS LA DROITE (vidéo à GÉNÉRER, 15 s = max API)** : même herbier que le plan 5 (même image de départ). La tortue nage vers la droite et la caméra la suit à la même vitesse : l'herbier, les roches et les coquillages défilent de droite à gauche, la surface scintille. Dans les 2 premières secondes la tortue passe du centre-gauche à la MOITIÉ DROITE du cadre et y reste, de profil, face à droite. La moitié gauche reste libre pour le héros. Aucun autre animal.

| t | Héros | Sons | Caméra |
|---|---|---|---|
| 0,0 → 2,0 s | **travel** depuis hors-champ gauche (x −150, y 470) → WP1 (x 330, y 460, scale 0,85, facing right) : il rattrape la tortue. Idle 1× | vaguelettes 0 → 15 s (vol. 0,4), bulles douces | — |
| 2,0 → 13,0 s | Idle loop 1× SUR PLACE : c'est l'herbier qui défile (travelling), il suit la tortue un peu derrière | musique seule (fin de film), petits « plic » de bulles à 5 s et 9 s | rumble très léger 2 → 13 s (amplitude 1, 1,5 Hz) |
| 13,0 → 15,0 s | Idle loop 0,7× : il ralentit, fin douce | — | — |
| 15,0 s | FIN | — | **outro iris 1000 ms** |

Vidéos générées (`videos-v1/P6_turtle_follow_a.mp4` / `_b.mp4`, 15 s) : dans les deux, la tortue nage vers la droite de profil, l'herbier, les roches et les coquillages défilent de droite à gauche en continu, la surface scintille. **a** : la tortue reste au centre-droit (x ≈ 55-65 %), quelques petits poissons discrets en haut, moitié gauche libre → **RECOMMANDÉE**. **b** : la tortue est plus grande et plus au centre, un banc de poissons colorés s'installe en haut de 6 à 15 s (plus chargé). Aucune des deux ne montre la tortue qui tourne la tête. Montage : héros à gauche (WP1 x ≈ 300, y 460), Idle sur place, il suit la tortue.

---

## Chronologie globale

| Plan | Durée | Cumul | Type |
|---|---|---|---|
| iris in | 1,0 s | 1,0 | — |
| 1 Presentation | 10,5 s | 11,5 | posé, voix |
| 2 Ocean home | 13,5 s | 25,0 | posé → tension, voix |
| 3 Poursuite | 9,5 s | 34,5 | **muet**, action |
| 4 Cou périscope | 10,0 s | 44,5 | posé + gag, voix |
| 5 Turtle | 11,5 s | 56,0 | posé + gag, voix |
| 6 On suit la tortue | 15,0 s | 71,0 | **muet**, **travelling**, fin douce |
| iris out | 1,0 s | 72,0 | — |

---

## Assets à produire

### Vidéos de décor (Grok Imagine, image-to-video, 16:9 720p)

Étape 1 : IMAGE de départ générée avec GPT (`gpt-image-2.5-sunburst`, prompt « scène » + 3 captures T-REX en référence de style, voir `gen_backdrops.py` set v3, référence unique `style-reference/reference_unique.jpg`). Étape 2 : image-to-video Grok avec le prompt « mouvement ». Le héros n'est JAMAIS dans le décor. Cinq ENVIRONNEMENTS différents, comme un documentaire animalier, dont un TRAVELLING (P3).

Préfixe de style (prompts image) :

> Children's picture-book illustration drawn with colored pencils and wax crayons: clearly visible crayon strokes and hatching, bold black outlines around every shape, bright saturated colors, medium level of detail with simple readable shapes. Not painterly, not photorealistic, no soft shading. Realistic proportions (real anatomy, like a nature book for kids) but drawn simply. Copy exactly the technique of the reference image. Wide 16:9 underwater background, no text. Leave the center free for a character composited later.

**P1 — Récif corallien (12 s)** — image `gpt-v3/P1_coral_reef.png`
- Scène : Sunlit tropical coral reef seen underwater: large coral heads (brain coral, branching staghorn coral, sea fans) in orange, pink, purple and yellow growing on grey rocks, small schools of reef fish, an ammonite drifting on the left, two ichthyosaurs (realistic dolphin-like prehistoric marine reptiles) swimming far in the background on the right. Clear turquoise water, no visible sand. Open water in the center-left.
- Mouvement : Static camera. Soft light shimmers, sea fans and small corals sway slightly, the schools of reef fish drift slowly, the ammonite drifts a little to the left, the two ichthyosaurs in the far background glide slowly from right to left across the whole clip. Calm, loopable.

**P2 — Pleine eau profonde (14 s)** — image `gpt-v3/P2_open_deep_ocean.png`
- Scène : Open deep ocean, mid-water: NO water surface and NO seafloor visible, only vast deep navy-blue water, faint drifting marine snow and a few rising bubbles. Far in the background, dark silhouettes of huge prehistoric sea creatures: a large ichthyosaur gliding on the left, a giant ray-like shape lower down, a distant school of small silver fish at the bottom-left. Center and right completely empty.
- Mouvement : Static camera. Marine snow drifts slowly downward, a few bubbles rise. From 1 s to 6 s the large ichthyosaur silhouette on the left glides slowly further left and fades into the distance; from 4 s to 9 s the giant ray-like silhouette drifts slowly to the right lower down; the school of silver fish shimmers. At 10 s a large mosasaur (realistic prehistoric marine reptile, dark grey-blue, big head, open jaws, dazed surprised expression rather than menacing) enters from the right edge and grows until its head fills the right half of the frame at 12 s, then stays there with its mouth open until the end.

**P3 — Tunnel rocheux, TRAVELLING (10 s)** — image `gpt-v3/P3_rock_tunnel.png`
- Scène : Side view inside a long underwater rock tunnel: a rugged grey-brown rock ceiling across the top of the frame with a few hanging stalactite shapes, a rock floor with boulders across the bottom, a wide band of open blue water in the middle, two or three openings in the ceiling letting light rays in, a few small dark fish silhouettes, sparse brown seaweed on the rocks. Rock shapes vary along the width (made to scroll horizontally). The middle band stays completely free.
- Mouvement : TRAVELLING shot: the camera travels steadily to the right through the tunnel, so the whole rock ceiling, floor and boulders scroll continuously from right to left at a constant speed for the entire clip. At 1 s a large mosasaur (realistic, dark grey-blue, open jaws, not menacing) enters from the left edge and swims along at the same speed, snapping its jaws shut at 3 s and at 5 s. At 6.5 s a thick rock pillar scrolls in from the right; at 7 s the mosasaur bumps its snout into it, stops dazed with a cloud of bubbles, and is carried out of the frame on the left by the scrolling. Bubbles and small fish stream past.

**P4 — Forêt de kelp (11 s)** — image `gpt-v3/P4_kelp_forest.png`
- Scène : Underwater kelp forest: tall golden-brown and olive-green kelp stalks rising from a rocky bottom to the top of the frame, greenish-golden light filtering between the stalks, a rocky shelf with a dark crevice on the right third where a small school of silver and yellow fish hides with only their heads showing, sea urchins and orange starfish on the rocks. Open water column in the upper-left and center.
- Mouvement : Static camera. The kelp stalks sway slowly, the greenish-golden light shimmers. At 4.5 s the school of silver and yellow fish hiding in the crevice on the right bursts out all at once and darts upward out of the frame in a panicked cloud; at 8 s they come back and slip into the crevice, heads peeking out. Nothing else moves.

**P5 — Herbier près de la surface (12 s)** — image `gpt-v3/P5_seagrass_meadow.png`
- Scène : Shallow sunlit seagrass meadow: dense bright green seagrass swaying over the bottom, a few pale rocks and shells, clear turquoise water, the water surface visible at the top with gentle waves and sparkling light, a realistic green sea turtle swimming slowly at the left-center, a few small fish. Open water in the middle.
- Mouvement : Static camera. Seagrass sways gently, the surface ripples and the light caustics dance. The green sea turtle swims very slowly from the left-center to the right across the middle of the frame from 2 s to 10 s, flapping its front flippers in slow motion; at 9 s it turns its head back toward the left, curious. Small fish drift.

### Sons (Envato — mots-clés)

| Usage | Plan | Recherche Envato | Durée |
|---|---|---|---|
| Bulles douces | 1, 4, 5 | `underwater bubbles gentle cartoon` | 2 s |
| Bulles rapides / nage | 3 | `bubbles swim fast underwater loop` | 8 s |
| Chomp mosasaure | 2 | `cartoon monster bite chomp big` | 1 s |
| Grognement sous-marin | 2 | `underwater monster growl cartoon` | 2 s |
| Clac de mâchoire | 3 | `cartoon jaw snap teeth` | 0,5 s |
| Whoosh aquatique | 3 | `underwater whoosh swoosh` | 1 s |
| Bonk cartoon | 3 | `cartoon bonk head hit` | 1 s |
| Boing | 3, 5 | `cartoon boing spring` | 1 s |
| Poursuite légère | 3 | `underwater chase playful kids music sting` | 8 s |
| Pop poissons | 4 | `cartoon pop bubble multiple` | 1 s |
| Squeak tortue | 5 | `cute squeak cartoon animal surprised` | 0,5 s |
| Chant de baleine lointain | 2 | `whale call distant underwater` | 5 s |
| Riser de tension | 2 | `cartoon suspense riser short` | 3 s |

## Images de décor générées (2026-09-14)

Dossier `docs/films/plesiosaurus/` :

| Dossier / fichier | Contenu | Statut |
|---|---|---|
| `gpt-v3/P1..P5_*.png` | GPT `gpt-image-2.5-sunburst`, 1792×1008, crayon enfant simple + formes réalistes, référence unique `../style-reference/reference_unique.jpg`, P3 = tunnel travelling | **retenu** |
| `gpt-v2/` | style naturaliste mais trop « peinture », trop détaillé ; P3 canyon statique | abandonné, mémoire |
| `gpt/`, `grok/` | v1 cartoon enfantin ; Grok ne respecte pas la patte graphique | abandonné, mémoire |
| `../gen_backdrops.py` | script (set v1 / v2 / v3, providers gpt / grok, clés dans `~/.picopop-keys.env`) | — |

Règles retenues pour les décors : GPT uniquement ; référence de style UNIQUE (crayon de couleur enfant, traits noirs marqués, formes réalistes mais simples, pas de rendu peint) ; un environnement différent par plan (récif, pleine eau sans surface ni fond, tunnel rocheux, forêt de kelp, herbier) ; au moins un plan travelling.

Tunnel (P3) : un décor de travelling doit se prolonger hors champ à gauche ET à droite, bandes plafond/sol d'épaisseur constante, aucune paroi qui ferme les bords. Deux candidats conformes : `gpt-v3/P3_rock_tunnel.png` (sol plus épais, plus de blocs) et `gpt-v3/P3_rock_tunnel_alt.png` (couloir plus haut, plafond plus régulier — recommandé). L'ancien tunnel resserré est gardé en `P3_rock_tunnel_old_narrow.png`.

## Vidéos de décor (image-to-video xAI)

Script : `docs/films/gen_videos.py` (modèle `grok-imagine-video-1.5`, 720p, 16:9, image de départ = `videos-v1/start-frames/*.jpg`, prompts de mouvement = ceux du script). Sorties `docs/films/plesiosaurus/videos-v1/<plan>.mp4` + `.json` (request_id, prompt, réponse). Tunnel P3 = version `_alt` (couloir plus haut).

Intégration dans l'éditeur FILM (admin → projet Dino 3 - Plesiosaurus → onglet FILM) :
1. Créer 5 plans, importer chaque mp4 comme **backdrop vidéo** (cameraX = centre).
2. Régler la durée de chaque plan ≤ durée de la vidéo (sinon elle boucle et l'événement rejoue) : P1 10,5 s / P2 13,5 s / P3 9,5 s / P4 10 s / P5 11,5 s.
3. Poser waypoints, clips motion / anim / sons / caméra selon les tableaux ci-dessus ; les instants des événements de décor (mosasaure à 10 s, poissons à 4,5 s, pilier à 6,5 s…) sont à recaler sur la vidéo réellement générée (à vérifier image par image).
4. Intro / outro iris 1 s, musique en boucle, bruits de pas désactivés.

## Points à valider

1. Ordre des plans : présentation → océan/mosasaure → poursuite muette → cou → tortue. Alternative possible : cou avant le mosasaure (le film monte en intensité plus tard), mais le gag tortue en fin est plus doux pour terminer.
2. Le mosasaure (plans 2 et 3, dans les vidéos) : réaliste mais « ahuri », pas menaçant. À vérifier sur la première vidéo générée ; si trop effrayant pour 3-5 ans, on adoucit le prompt (gueule moins ouverte, yeux ronds).
3. Origine du perso (0.5, 0.6) au lieu des pieds : à vérifier dans l'éditeur, sinon garder (0.5, 1) et remonter les y des waypoints d'environ 120 px.
4. Plan 2 à 13,5 s : le plus long du film, porté par la voix la plus longue + l'arrivée du mosasaure. Si trop long, réduire le silence comique (11,0 → 12,3 s) à 0,6 s.
