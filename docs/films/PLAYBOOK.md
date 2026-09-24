# PLAYBOOK FILM PicoPop — v1 (24 septembre 2026)

Règles de fabrication des mini-films (script, décors, sons, timeline), tirées de l'observation
**mesurée** des trois films publiés du FREE SAMPLE (T-Rex, Plesiosaurus, Pteranodon) : données
Firestore `filmT`, décors et sons téléchargés, transcription des voix, et surtout **rendu réel**
de chaque film enregistré par l'app play elle-même (vidéo + mixage audio), analysé image par
image et par courbe de niveau sonore. Détail des mesures : `docs/films/analyse-2026-09-24/`.

Ce document remplace les règles éparses des scripts précédents. Il sert de cahier des charges
à l'agent qui écrit les scripts et prépare les kits, et de grille de relecture avant publication.

---

## 1. Ce que les trois films nous apprennent

### 1.1 Les chiffres

| | T-Rex | Plesiosaurus | Pteranodon |
|---|---|---|---|
| Plans | 5 | 5 | 6 |
| Durée des plans (hors intro/outro) | 54,9 s | 55,0 s | 66,4 s |
| Durée moyenne d'un plan | 11,0 s | 11,0 s | 11,1 s |
| Parole (clips « parlé ») | 32 s · 59 % | 29 s · 52 % | 48 s · 72 % |
| Clips voix | 4 | 5 | 11 |
| Bruitages posés | 8 | 1 + 7 globaux | 7 + 9 globaux |
| Trajets (héros en mouvement) | 17 s · 31 % | 40 s · 73 % | 27 s · 41 % |
| Animation figée (« once-hold » au-delà d'une passe) | ≈ 2 s | ≈ 8 s | ≈ 10 s |
| Effets caméra | zoom 2, rumble 6, shake 3 | zoom 2, rumble 2 | bob 8 |
| Musique | continue, volume 1 | continue, 0,75 | 3 morceaux enchaînés, 0,25–0,3 |
| Plancher sonore mesuré (hors intro) | −25 dB | −24 dB | **−42 dB** (trous) |
| Écart maillage ↔ son après le lot 2 | 0,7 image | — | — |

Toutes les animations « cotracker-bones » font **121 images = 5 s de vidéo**, soit une passe
de **4,75 s à vitesse ×1** (crossfade de 7 images déduit), 2,4 s à ×2, 1,6 s à ×3, 9,5 s à ×0,5.
Les marches / cycles longs font 240 images (9,7 s). Ces durées pilotent toutes les règles
d'animation ci-dessous.

### 1.2 Ce qui marche (à reproduire)

- **La même colonne vertébrale dans les trois films** : présentation → fait n° 1 illustré par une
  comparaison visuelle dans le décor (bus scolaire, troupeaux, voiture rouge) → plan d'ACTION
  avec un antagoniste dans le décor (troupeau qui fuit, mosasaure, T-Rex qui saute) → fait sur
  une CAPACITÉ jouée par une animation (cou qui s'étire, course en travelling, ailes) → gag
  final. C'est le gabarit, il est validé par le rendu.
- **Le gag synchronisé décor ↔ voix** : « as long as a school bus » → le bus entre dans le
  champ 0,5 s après le mot, avec un whoosh juste avant l'image. C'est le meilleur moment du
  T-Rex : le décor vidéo réagit au texte.
- **L'antagoniste qui rate** (Pteranodon, plan 4) : deux sauts du T-Rex dans la vidéo à 4 s et
  7 s, le héros passe juste au-dessus grâce à ses waypoints, et une réplique courte tombe après
  chaque raté (« LOSER! » 5,8 s, « Try again! » 8,9 s). Timings de la vidéo écrits dans le
  script, waypoints posés dessus : c'est exactement la méthode à généraliser.
- **La capacité jouée pendant qu'on la dit** : « My neck was SUPER long » avec l'animation
  Discours 2 (cou qui s'étire) calée sur « super long », puis « It helped me spot fish » avec le
  banc de poissons que la caméra suit vers le haut.
- **La grammaire caméra** : zoom sur la tête pendant « Hey, I'm… », rumble pendant les marches,
  shake à chaque rugissement, bob (oscillation) pendant le vol calé sur le cycle de l'animation.
- **Le riser de suspense** avant la surprise et la musique **continue** à volume franc (T-Rex à 1,
  Plesio à 0,75) : jamais de trou dans le mixage.

### 1.3 Ce qui casse (à corriger, et à interdire dans les prochains scripts)

1. **Héros figé** : `once-hold` sur une animation de boucle (Idle) au-delà d'une passe fige le
   personnage en statue. Pteranodon plan 2 : Idle once-hold ×1,5 sur 13,4 s → figé 10 s, ailes
   ouvertes, seul le bob de caméra bouge. Plesiosaurus plan 1 : Idle once-hold ×1 sur 9,5 s →
   figé pendant les 3 dernières secondes du trajet d'entrée puis au point.
2. **Réaction avant la cause** : Plesiosaurus plan 2, le cri et le sursaut (8,1 s) précèdent
   l'apparition du mosasaure dans la vidéo (10 s). Le spectateur voit la peur avant le monstre.
3. **Héros absent** : Plesiosaurus plan 3 (tunnel), le héros sort du cadre à 3 s et la vidéo
   joue seule 6 s (bulles, trou, museau du mosasaure). Le coloriage de l'enfant disparaît de
   l'écran pendant 7 s sur un plan de 9,3 s.
4. **Trous de son** : Pteranodon, 2,5 s à −32 dB entre la fin de l'intro et la première phrase
   du plan 2, −42 dB pendant le volet plan 4 → 5 (une musique finit pendant que l'autre commence
   son fade-in), −40 dB dans la pause de la phrase du plan 5. Musique à 0,25 = pas de plancher.
5. **Pas de respiration** : T-Rex plan 4, la voix finit à 11,6 s pour un plan de 11,7 s puis
   crossfade ; plusieurs plans coupent moins de 0,3 s après le dernier mot.
6. **Fin sans chute** : T-Rex et Plesiosaurus se terminent sans réplique ni gag conclusif
   (rugissement au ptérodactyle, tortue qui nage) ; le Pteranodon, lui, finit sur « Oh no! I'm a
   clumsy pteranodon! » et c'est le plus drôle des trois.
7. **Phrase sacrifiée** : Plesiosaurus plan 2, pour caser la surprise, la 3ᵉ phrase « The ocean
   was my home » est supprimée alors que c'est la mise en place ironique de l'attaque.
8. **Échelle qui saute** : Plesiosaurus 0,85 → 0,60 → 0,40 → 0,75 → 0,85 d'un plan à l'autre ;
   à 0,40 le héros est minuscule sur un plan d'action.
9. **Vidéo de décor pas taillée pour le plan** : le mosasaure apparaît à 10 s d'une vidéo de
   14 s, le plan est coupé à 11,4 s → 1,4 s de monstre. Les plans jouent la vidéo depuis 0 s,
   sans décalage possible : l'événement doit être généré à la bonne seconde.
10. **Bibliothèque sale** : T-Rex a chaque son en 2 ou 3 exemplaires et un fichier vidéo
    importé comme son ; Plesio deux fois la musique. `posterMs` = 0 sur Plesio et Ptera
    (vignette de galerie = iris noir).

---

## 2. Le gabarit narratif : « portrait en cinq plans et un gag »

Durée cible **58 à 66 s** tout compris (intro 1 s + plans + transitions + outro 1 s). Cinq plans
(six si le gag final mérite son propre décor). Chaque plan a UNE fonction, UN décor, UNE idée.

| # | Fonction | Durée | Voix | Héros | Décor | Son | Caméra | Sortie |
|---|---|---|---|---|---|---|---|---|
| 1 | **Présentation** — qui je suis, hook | 9–12 s | « Hey, I'm X, [qualité] ! » 6–7 s, démarre à 1,0–1,5 s | entre du bord (2–3 s) ou est déjà là, s'installe, idle en boucle | plan large emblématique de son milieu, zone libre au centre-gauche | ambiance du milieu + musique ; 1 bruitage d'entrée | zoom tête pendant la phrase, retour plein cadre | crossfade 400 |
| 2 | **Fait n° 1 + comparaison visuelle** | 10–13 s | fait 1 (7–9 s) découpé par phrase ; le mot-clé tombe 0,5 s AVANT l'objet | idle en boucle, ou petit trajet vers l'objet | l'objet de comparaison ENTRE dans le champ (vidéo) à la seconde écrite dans le script | whoosh 0,3 s avant l'objet ; klaxon / cri de l'objet | zoom léger sur l'objet + héros | volet (wipe) |
| 3 | **Action, surprise** | 9–11 s | MUET ou 1–2 répliques de 2 mots (« Oh no! ») | entre en courant / nageant, réagit (sursaut/rugissement), fuit hors champ | l'antagoniste dans le TIERS GAUCHE (héros à droite) ou surgit à la seconde écrite ; travelling si poursuite | riser 2 s avant, impact/rugissement, cri comique, musique de poursuite | rumble pendant la course, shake à l'impact | crossfade 800–1000 |
| 4 | **Fait n° 2 = capacité jouée** | 10–12 s | fait 2 (7–9 s) : le verbe d'action tombe sur l'animation | animation dédiée (cou, course, ailes) au mot-clé, puis idle | travelling (le décor défile, le héros bouge sur place) ou plan posé avec un élément qui réagit (banc de poissons) | ambiance + sons de cycle (pas, battements) | rumble/bob, pan qui suit | crossfade 300–400 |
| 5 | **Fait n° 3 + gag final** | 9–12 s | fait 3 (6–8 s) puis réplique-chute de 3–5 mots à 1 s de la fin | idle, un dernier geste, un raté ou une pose fière | décor final (couchant, prairie, lagon) avec un événement à la seconde écrite | bruitage du gag, ding/ricanement | zoom final doux | iris 1000 |

Courbe : **calme → sourire → peur/tension → fierté → rire**. Un seul plan muet par film, jamais
deux d'affilée. Le plan 3 est l'apogée : il porte les sons les plus forts et le seul shake violent.

Règles de rythme chiffrées :

- **1 idée par plan, 1 gag toutes les 15 s** (plan 2, plan 3, plan 5).
- Une phrase = **3,5 à 5 s** (14–18 mots) ; jamais plus de 2 phrases sans un événement visuel.
- Le premier mot d'un plan tombe **≥ 0,6 s** après le début du plan (≥ 1,0 s pour le plan 1) ;
  le dernier mot **≥ 0,8 s** avant la fin du plan (≥ 1,5 s si c'est une chute).
- Après un événement fort (rugissement, apparition, splash) : **0,4 s de silence** avant la
  réaction du héros, **1,5 s** avant la phrase suivante.
- Fin du film : la chute, puis **1 s** de tenue, puis l'iris. Jamais de plan qui finit sur du vide.

---

## 3. Écriture du script (narration)

### 3.1 Les voix

- **4 fichiers voix par film**, dans cet ordre : `Audio Intro` (« Hey, I'm X, a/the … that … ! »),
  `Audio 1`, `Audio 2`, `Audio 3` (un fait chacun, 2 phrases max, 14–18 mots par phrase, la
  2ᵉ phrase = image concrète ou chute : « That's a lot of dinosaur », « Tiny arms, big dinosaur »).
- Ton : première personne, présent de fierté ou passé simple, un enfant de 4 ans doit comprendre
  chaque mot. Un superlatif par fait maximum. Une comparaison concrète par film au moins (bus,
  voiture, maison).
- **Répliques comiques** (ElevenLabs, voix « Crazy Eddie », réglages `sp120 s60 sb54`) : 2 à 5
  mots, 1 à 4 s, 2 à 4 par film, réservées aux plans 3 et 5 : provocation, raté, fierté.
  Modèles qui ont marché : « Hey T-Rex, catch me if you can! » · « LOSER! » · « Try again! » ·
  « Come on, fishies! » · « Oh no! I'm a clumsy pteranodon! ».
- **Découpage par phrase** : chaque fichier est posé en clips **par phrase** (un clip = une
  phrase, `offsetMs` = début de la phrase dans le fichier, durée = phrase + 0,2 s). Ça permet
  de glisser une phrase après un événement sans re-générer la voix. Les instants des phrases
  se lisent avec Whisper (transcription horodatée) — fait pour les 3 films dans l'analyse.
- Si une phrase doit sauter, on coupe la **phrase du milieu**, jamais la dernière (c'est elle
  qui prépare la surprise ou porte la chute).

### 3.2 Les faits

Trois faits, trois registres : **taille/force** (comparaison), **capacité** (jouable par une
animation existante), **mode de vie / anecdote** (où, quoi, avec qui). Le fait « capacité » est
choisi EN FONCTION des animations disponibles du projet (cou, marche, ailes, mâchoire), jamais
l'inverse. Vérifier la liste des animations et leur durée avant d'écrire.

### 3.3 Les gags

Trois mécaniques éprouvées, à alterner d'un film à l'autre :
1. **Comparaison anachronique** qui entre dans le champ (bus, voiture, bateau, maison) —
   plan 2.
2. **Antagoniste qui rate** (prédateur qui saute à côté, se cogne, arrive trop tard) — plan 3.
3. **Le héros qui rate ou qui frime** (attrape le vide, se prend pour une tortue) — plan 5,
   avec une réplique-chute.

Interdits (impossibles à rigger ou illisibles) : roulade, tourbillon, saut périlleux, réaction aux
éléments (pluie, vent, vague qui éclabousse), objet tenu ou manipulé, contact physique avec
l'antagoniste. Tout le spectaculaire est dans la VIDÉO de décor et dans le SON.

---

## 4. Mise en scène du héros

### 4.1 Animations : boucle ou une passe

- **Idle / nage / vol / marche = `loop`, toujours.** `once-hold` est réservé aux animations
  d'action (rugissement, sursaut, attrape) et sa durée de clip = **une passe + 0,3 s max**
  (121 images : 4,75 s à ×1, 2,4 s à ×2, 1,6 s à ×3). Au-delà, le héros est une statue.
- Vitesse de boucle : idle **0,5–0,8×** quand il parle posé (respiration lente), **1–1,3×** en
  attente active, **2–4×** pour courir/fuir/nager vite (avec rumble).
- Une animation d'action se cale sur le SON qui la motive : l'action commence **0,2 s avant**
  l'attaque du son (le rugissement sort d'une gueule déjà ouverte).
- Un changement d'animation dans un plan = un événement ; pas plus de 3 changements par plan.

### 4.2 Trajets

- Entrée en scène : **2–3 s** depuis hors-champ (`offscreen`) pour une marche, **3–5 s** pour une
  nage ou un vol (plus lent, plus ample). Jamais 8 s comme le Plesiosaurus plan 1 : l'entrée
  n'est pas le sujet.
- Un trajet porte l'animation de déplacement (`animationId` du clip motion) ; la vitesse de
  lecture (`animSpeedMul`) suit la vitesse du trajet : marche 1×, course 2–4×.
- Courbes : `easeOut` pour arriver à un point (freinage), `easeIn` pour fuir, 1 point de
  contrôle pour un vol/une nage (arc), 0 pour une marche au sol.
- Sortie hors-champ = **`exit`**, 1,5–3 s, toujours du côté opposé à l'antagoniste.
- Le héros est **à l'écran ≥ 85 % de la durée du film**. Une absence (entre dans un trou,
  passe derrière un rocher) dure **< 2 s** et se termine par une réapparition (nouveau `appear`
  ou waypoint au bord du trou).

### 4.3 Échelle, position, regard

- Échelle du héros ≈ **35–45 % de la hauteur du cadre** sur les plans de parole, **25–35 %** sur
  les plans d'action larges. Entre deux plans consécutifs, variation **≤ 0,25** (0,85 → 0,6 OK ;
  0,85 → 0,4 non, sauf plan « vu de loin » ≤ 5 s et justifié par la profondeur du décor).
- Position de parole : le héros dans le **tiers droit ou au centre**, regard vers le centre
  du cadre ; l'antagoniste et les objets entrent par la **gauche**. Zone libre autour de la
  tête : rien de contrasté dans la vidéo derrière la tête pendant qu'il parle (lisibilité de la
  bouche).
- Origine du personnage (`originV`) : 0,8–1,0 pour un marcheur (pieds), 0,5–0,6 pour un nageur
  ou un voleur (centre du corps). `facing` = sens du dessin ; les trajets gèrent le flip.
- Waypoints « vivants » : sur un plan posé de plus de 8 s, ajouter 1–2 micro-trajets de 1,5–2 s
  (petit pas de côté, ondulation) plutôt qu'un idle immobile.

---

## 5. Décors (images de départ et vidéos)

### 5.1 Composition de l'image (GPT image, style = `style-reference/reference_unique.jpg`)

- 16:9, **1280×720** (ou 1264×720 Grok) ; `cameraX` = largeur/2. Un ENVIRONNEMENT différent par
  plan (récif / pleine eau / tunnel / forêt de kelp / herbier ; falaise / plaine / plage /
  jungle / couchant) — jamais la même vue avec une autre teinte.
- **Zone libre pour le héros** écrite dans le prompt : « the center-right of the frame stays
  empty (no character, no big object) ». Antagoniste et objets de comparaison **dans le tiers
  gauche** ou hors champ au départ.
- Ligne d'horizon / sol : cohérente avec l'origine du héros (sol visible à y ≈ 75–85 % pour un
  marcheur ; pleine eau sans sol pour un nageur en plan 2 ; ciel sur le tiers haut pour un
  voleur).
- Le héros n'est JAMAIS dans l'image de décor. Les personnages secondaires y sont intégrés.
- Style naturaliste-documentaire au crayon, formes simples, traits noirs ; pas de rendu peint,
  pas de personnages cartoon à gros yeux dans le décor (le héros colorié doit rester la star).

### 5.2 Vidéo de décor (Grok Imagine image-to-video, `gen_videos.py`)

- Durée générée = **durée du plan + 1 s** (10–14 s). Le plan lit la vidéo depuis 0 s, sans
  décalage : **chaque événement est daté dans le prompt** (« at 4.0 s the bus enters from the
  left », « at 6.5 s a fish leaps at lower center with a splash ») et **vérifié sur la
  planche-contact** (1 image/s) avant d'assembler. Si l'événement est décalé de plus de 0,5 s,
  on re-génère ou on adapte la timeline à la seconde réelle, jamais « à peu près ».
- Plans posés : « static camera, gentle loopable motion » ; l'image doit revenir près de son
  état initial pour le fondu de boucle (l'app enchaîne en fondu 0,6 s).
- Plan travelling : « the camera moves steadily to the right so the whole landscape scrolls
  from right to left at constant speed for the entire clip » ; le héros joue sa marche/nage/vol
  SUR PLACE avec rumble/bob.
- Un événement = un mouvement simple et lisible (entre dans le champ, saute, se retourne,
  plonge). Pas deux événements simultanés. Les vrais bonds rendent mal : préférer
  « se dresse / ouvre la gueule / claque des dents ».
- Nommer les fichiers `P<n>_<sujet>_v<k>.mp4` ; garder les versions rejetées dans le dossier du
  film avec le verdict dans le script.

---

## 6. Son

### 6.1 Couches et volumes (mixage cible)

| Couche | Où | Volume | Règle |
|---|---|---|---|
| Musique | globale (`music`) ou pistes globales | **0,6–1,0** | continue du début à la fin ; si plusieurs morceaux, chevauchement ≥ 2 s avec fade-out 1,5 s / fade-in 1,5 s, jamais pendant une transition de plan |
| Ambiance du milieu | piste son du plan, `loop` | 0,4–0,7 | une par plan, du 0 s à la fin, fade-in 300 ms |
| Voix (`isSpoken`) | piste 1 | 1,0 | une seule voix à la fois ; rien de fort pendant une phrase (−6 dB sur les bruitages qui la chevauchent) |
| Événements | piste 2–3 | 0,8–1,0 | ancrés ⚓ au clip motion/anim qu'ils illustrent (`edge: start`, offset −200 ms) |
| Riser / suspense | piste globale | 0,7 | commence 2,5 s avant la surprise, finit sur l'impact |
| Sons de cycle (pas, battements) | animation (`footstepFrames`) | film ×1–1,5 | validés à la main sur l'animation, jamais posés à la main sur la timeline |

- **Plancher** : le mixage ne descend jamais sous **−28 dB** plus de 1 s (mesure sur le rendu
  enregistré). Une musique à 0,25 ne suffit pas : c'est l'ambiance qui tient le plancher.
- Les 1,0 s d'intro (iris) portent déjà la musique et l'ambiance (fade-in 500 ms).

### 6.2 Grammaire des bruitages

- **Apparition** d'un objet : whoosh 0,3 s avant l'image, klaxon/cri de l'objet 0,3 s après.
- **Surprise** : riser 2,5 s → coup (impact/rugissement) à la seconde de l'apparition → 0,4 s →
  cri comique du héros → musique de poursuite.
- **Rugissement du héros** : son ancré au clip Action (offset +200 ms), shake ancré au même clip
  (+300 ms, 700 ms, amplitude 16, 14 Hz, rotation, decay expo). Rate 1,0 ; le 2× du T-Rex plan 3
  rend le rugissement aigu et court, à éviter.
- **Chute finale** : le son du raté (splash, bonk) 0,3 s avant la réplique-chute ; un « ding »
  ou un ricanement sur la pose finale.
- Un son par intention ; deux sons identiques à moins de 3 s d'écart n'apportent rien.

### 6.3 Bibliothèque

Un import par son, nommé `NN-role-description.ext` (`01-voice-intro.mp3`, `10-sfx-whoosh.mp3`,
`20-amb-jungle.wav`, `30-music-bed.mp3`). Supprimer les doublons avant publication.

---

## 7. Timeline : règles de placement

- Le film = intro + Σ (plan + **transition ajoutée après le plan**) + outro. Une transition de
  1 000 ms rallonge le film de 1 s ; les compter dans le budget.
- Intro **iris 1000** / outro **iris 1000** pour toute la collection (Plesio a 400 : à aligner).
- `posterMs` = l'instant le plus lisible du gag du plan 2 (héros + objet), jamais 0.
- Ordre de saisie d'un plan dans l'éditeur : waypoints → motion → anim → caméra → sons ancrés →
  sons libres → transition. Les sons d'événement sont **ancrés** aux clips (⚓) pour survivre aux
  retouches de durée.
- Marges : premier son d'événement ≥ 0,5 s après le début du plan ; dernier son ≥ 0,5 s avant
  la fin (sauf riser qui traverse la transition).
- Caméra : un `zoom` par film sur la présentation (entrée 0 ms, tenue, sortie 1 500–3 000 ms),
  `rumble` amplitude 1–3 ancré aux trajets de course, `shake` sur les impacts, `bob` ancré à
  l'animation de vol (fréquence = FPS × vitesse ÷ (images − crossfade) : 24 × 1,3 ÷ 114 ≈
  0,27 Hz par cycle, soit ≈ 1,1–1,3 Hz pour un battement visible), `pan` pour suivre un élément.
- Aucun plan sans son ancré : chaque motion `travel` de course porte un rumble ; chaque Action
  porte son son.

---

## 8. Pipeline « kit de film » (ce que l'agent livre, dans l'ordre)

Dossier `docs/films/<dino>/` :

1. **`script.md`** (format validé : Synopsis lecture rapide → Texte des voix → Réglages film →
   PLAN n : tableau `t | héros | voix/sons | caméra`) avec, pour chaque plan, la **seconde de
   chaque événement de la vidéo** et la **seconde de chaque phrase**.
2. **`voices.md`** : les 4 lignes + les répliques comiques, avec le nombre de mots et la durée
   estimée (2,6 mots/s), prêts pour ElevenLabs ; après génération, transcription Whisper
   horodatée (`voices-timing.json`) qui donne les `offsetMs` de chaque phrase.
3. **`backdrops/`** : prompts image par plan (composition §5.1) → `P<n>.png` (GPT, style unique),
   verdict par image dans le script.
4. **`videos/`** : prompts vidéo par plan (événements datés §5.2) → `P<n>_v<k>.mp4` +
   `P<n>-sheet.jpg` (planche-contact 1 image/s produite par ffmpeg) + seconde réelle de chaque
   événement relevée sur la planche.
5. **`sounds.md`** : liste Envato/ElevenLabs par rôle (musique, ambiance ×5, riser, impacts,
   comiques), mots-clés de recherche, durée voulue, volume cible.
6. **`timeline.md`** : pour chaque plan, la liste chiffrée des clips (motion, anim, caméra,
   sons) avec `startMs / durationMs / anchor`, dans l'ordre de saisie de l'éditeur — copiable
   tel quel. (Prochaine étape possible : un importeur `film-kit.json → Firestore filmT` via
   l'API REST avec le compte admin, qui poserait tout automatiquement, décors et sons compris.)
7. **QA avant publication** : (a) planche-contact de chaque vidéo relue ; (b) enregistrement
   du film complet par l'app (banc headless `e2e-record`) ; (c) planche-contact du rendu à
   1 image/s : héros visible, jamais figé plus d'une passe, cause avant réaction ; (d) courbe de
   niveau sonore par 0,5 s : plancher ≥ −28 dB, pics sur les événements attendus, pas de trou
   aux transitions ; (e) sonde `window.__filmDebug` : écart maillage/son ≤ 1,5 image.

Nomenclature : `docs/films/<dino>/{script.md, voices.md, sounds.md, timeline.md, backdrops/,
videos/, qa/}`.

---

## 9. Corrections recommandées sur les trois films publiés

### T-Rex
- Plan 1 : remplacer `Idle once-hold ×0,5` (9,2→14,7 s) par `Idle loop ×0,6` ; ajouter un
  micro-trajet de 1,5 s à 12 s (pas de côté) pour ne pas parler immobile 5 s.
- Plan 3 : rugissement `rate 1` au lieu de 2 ; l'Action commence 0,2 s avant le son (5,8 s).
- Plan 4 : passer le plan à 12,8 s (la voix finit à 11,6 s) ou rogner la fin de la phrase.
- Plan 5 : après le second rugissement, une réplique-chute (« Hmph. Show-off. » ou « Wait for
  me! ») à 6,6 s et allonger le plan à 9,5 s ; Action once-hold ramenée à une passe (2,4 s) puis
  Idle loop.
- Bibliothèque : supprimer les 9 doublons et le fichier `.mp4` importé comme son.

### Plesiosaurus
- Plan 1 : `Idle loop ×0,8` au lieu de once-hold ; entrée ramenée à 4 s (départ x −128 → 650
  en 4 s, easeOut) ; voix à 1,2 s au lieu de 2,7 s ; plan 8,5 s.
- Plan 2 : remettre « The ocean was my home » (clip 3, offset 9,4 s, 2,3 s) à 8,0 s ; mosasaure
  visible à 10,0 s (vidéo actuelle) → riser 7,5→10,0 s, rugissement à 10,0 s, cri à 10,4 s,
  Jump ×3 à 10,5 s, fuite `exit` gauche 11,2→13,0 s ; plan 13,4 s (au lieu de 11,4). Ou
  re-générer la vidéo avec le mosasaure à 8 s et garder 11,4 s.
- Plan 3 : garder le héros dans le champ : waypoint d'arrivée près du trou (x ≈ 120, y ≈ 560,
  scale 0,55) atteint à 5,5 s, puis `appear` hors champ 0,3 s et retour d'une tête au bord du
  trou (waypoint x ≈ 60) de 7,5 s à la fin ; scale 0,55 au lieu de 0,40.
- Plan 5 : chute à 12,5 s (« Slow and steady wins… the snack! » ou un « Whee! » ElevenLabs) et
  iris 1000 ms au lieu de 400.
- `posterMs` = 21 500 (mosasaure derrière le héros) ; musique 0,75 OK.

### Pteranodon
- Plan 2 : `Idle loop ×1,3` au lieu de once-hold ×1,5 (13 s figé) ; ajouter un trajet de
  2,5 s vers 8 s (glissade vers la droite, CP 1).
- Trous de son : ambiance vent en boucle 0,5 sur les plans 1–3, ambiance mer 0,5 sur 5–6 ;
  musique à 0,45 ; chevaucher les deux morceaux de 2 s avec fades symétriques, et décaler le
  changement de morceau hors du volet plan 4 → 5 (le faire à 41 s, pendant le rugissement).
- Plan 5 : combler la pause de 1,9 s entre les deux phrases par un cri de mouette ou avancer la
  2ᵉ phrase à 3,3 s.
- Plan 4 : parfait ; réduire la queue sans héros (11,6→12,8 s) à 0,6 s.
- `posterMs` = 27 000 (au-dessus de la voiture rouge).

---

## 10. Annexes

### 10.1 Gabarit de tableau par plan (script)

```
## PLAN n — « titre » · D s · type (posé / action / travelling) · voix ou MUET
Décor : P<n>_<sujet>.mp4 (D+1 s) — événements : 4,0 s bus entre par la gauche ; 6,5 s klaxon
| t (s)       | Héros                                   | Voix / sons                         | Caméra                  |
| 0,0 → 2,5   | travel hors-champ G → WP1 (x, y, ×0,85) | amb-forêt loop 0,5 ; pas (anim)     | rumble ⚓ trajet         |
| 2,5 → 9,0   | Idle loop ×0,7 sur WP1                  | voix phrase 1 : 3,0 → 6,8 (offset 0)| zoom tête 3,0 → 7,0     |
| 4,0         | —                                       | whoosh 3,7 ; klaxon 4,3             | —                       |
| 9,0 → 10,5  | —                                       | —                                   | —                       |
| 10,5        | transition crossfade 400                |                                     |                         |
```

### 10.2 Checklist de relecture (avant de dire « prêt »)

- [ ] 5–6 plans, 58–66 s, une seule scène muette, chute finale + 1 s + iris 1000.
- [ ] Aucun `once-hold` sur une boucle ; aucune passe figée > 0,3 s.
- [ ] Cause (vidéo) → 0,4 s → réaction (héros) → 1,5 s → phrase.
- [ ] Héros visible ≥ 85 % ; échelle 0,35–1,0 ; saut d'échelle ≤ 0,25 entre plans.
- [ ] Premier mot ≥ 0,6 s après le début du plan ; dernier mot ≥ 0,8 s avant la fin.
- [ ] Plancher sonore ≥ −28 dB ; musique et ambiance continues ; chevauchements ≥ 2 s.
- [ ] Sons d'événement ancrés ⚓ ; rumble sur les courses ; shake sur les impacts ; bob sur le vol.
- [ ] Bibliothèque sans doublon, fichiers nommés ; `posterMs` posé ; intro/outro iris 1000.
- [ ] Planche-contact des vidéos relue ; rendu enregistré relu ; courbe de son vérifiée.

### 10.3 Mesures brutes

`docs/films/analyse-2026-09-24/` : timelines complètes des trois films (`*-summary.md`),
transcriptions horodatées, planches-contact des décors (`*-backdrops.jpg`) et des rendus
(`film-*-sheet.jpg`), courbes de niveau (`*-loudness.txt`), outils (`summarize.py`,
`audio_timeline.py`) et banc d'enregistrement (`e2e-record.mjs`).
