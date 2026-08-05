# Coloriage Animé - Triangulation Custom

Application web de livres de coloriage animés avec triangulation de maillage et suivi vidéo.

**⚠️ DA / UX de l'app PLAY (PicoPop)** : toute UI visible côté play (pages `apps/play/src`
ET composants partagés `apps/admin/src/components/scan/*`) doit respecter la charte
graphique **`apps/play/CLAUDE.md`** — couleurs pastel tokens, Fredoka/Andika, titres ✦,
boutons pilule par fonction, cartes soft, safe areas. Ne jamais improviser de style custom.

## Monorepo (npm workspaces)

Le projet est splitté en **deux applications** déployées sur deux domaines distincts, partageant un **seul backend Firebase** (`coloriage-anime-prod`).

```
.
├── apps/
│   ├── admin/        @coloriage/admin  → coloriage-anime-admin.vercel.app (édition, auth requise)
│   └── play/         @coloriage/play   → coloriage-anime-play.vercel.app (scan + animation, public)
├── packages/
│   └── shared/       (réservé pour une extraction future ; vide pour l'instant)
├── functions/        Cloud Functions (LaMa, inchangé)
├── sam2/, sam2-local/, cotracker/, cotracker-local/   inchangés
├── firestore.rules, storage.rules, firebase.json, .firebaserc
└── package.json      (workspaces : apps/*, packages/*)
```

**Partage de code** : `apps/play` n'a **pas** de code dupliqué — il importe ce dont il a besoin depuis `apps/admin/src/...` via l'alias TypeScript/Vite `@shared/*`. Concrètement :
- `apps/play/src/pages/PlayPage.tsx` charge le projet, vérifie `project.published === true`, puis monte `ScanPage` importé via `@shared/pages/ScanPage`.
- Vite ne bundle dans `play` que les modules réellement importés (≈ 367 KB gzippé vs 707 KB pour admin).
- Si plus tard la limite devient gênante, on extraira un vrai `packages/shared/` (types + db + utils playback).

Note : `apps/play` tire actuellement Firebase Auth dans son bundle parce que `projectsStore` importe `audit.ts` (qui dépend du singleton `auth`). C'est < 60 KB, acceptable. Optimisation future possible : séparer un `projectsStore.read.ts` sans dépendance audit.

## Authentification (admin uniquement)

Firebase Auth **email + mot de passe** + allowlist Firestore `admins/{uid}`. Les comptes sont créés à la main dans la console Firebase, puis un doc `admins/{uid}` autorise l'accès.

- `apps/admin/src/auth/AuthProvider.tsx` — contexte React (`signInWithEmailAndPassword`), vérifie l'appartenance à `admins/` à chaque changement d'état auth.
- `apps/admin/src/auth/LoginPage.tsx` — formulaire email + mot de passe, monté sur `/login`.
- `apps/admin/src/auth/ProtectedRoute.tsx` — wrap toutes les autres routes admin, redirige vers `/login` si pas admin.

**Bootstrap** : Firebase Console → Authentication → Sign-in method → activer **Email/Password**. Puis Authentication → Users → **Add user**. Copier l'UID généré → Firestore `admins/{uid}` = `{ email, addedAt, addedBy }`.

## Audit log

- Collection `auditLog/{autoId}` : `{ uid, email, action, projectId, timestamp, details? }`.
- Actions tracées : `project.create`, `project.delete`, `project.duplicate`, `project.publish`, `project.unpublish`.
- Helper : `apps/admin/src/db/audit.ts` (`logAudit(action, projectId, details?)`).
- Login history : collection `loginHistory/{autoId}` écrite par `AuthProvider` au sign-in.

## Publication d'un projet

- Champ `Project.published: boolean` (+ `publishedAt: number | null`) sauvé dans Firestore.
- `apps/admin/src/components/admin/PublishPanel.tsx` (intégré dans la `GeneralSection`) — bascule publish/dépublish + copie de l'URL play.
- L'URL play est `${VITE_PLAY_BASE_URL}/p/{projectId}` (défaut `https://coloriage-anime-play.vercel.app`, à configurer en var d'env Vercel).
- Côté play : `apps/play/src/pages/PlayPage.tsx` refuse l'accès si `project.published !== true`.

## Règles Firebase

Voir `firestore.rules` et `storage.rules` à la racine. Helper `isAdmin()` = `exists(/databases/$(database)/documents/admins/$(request.auth.uid))`.

- `projects/{id}` : lecture publique si `published == true`, sinon admin. Écriture : admin only.
- `admins/{uid}` : édition console uniquement (`write: false`).
- `auditLog`, `loginHistory` : append-only, immuables.
- `scans/{id}` : create public (coloriage-anime-play.vercel.app crée des scans sans auth), reste admin only.

Déploiement des rules : `firebase deploy --only firestore:rules,storage:rules` (depuis la racine).

## Commandes (racine du monorepo)

```bash
npm install               # installe toutes les workspaces
npm run dev:admin         # démarre apps/admin (HTTPS, port Vite par défaut)
npm run dev:play          # démarre apps/play  (HTTPS, port 5175)
npm run build:admin       # build apps/admin
npm run build:play        # build apps/play
npm run build             # build les deux
```

## Déploiement Vercel

Deux projets Vercel pointant vers le même repo, avec **Root Directory** différent :

| Projet Vercel  | Root Directory | Domaine        |
|----------------|----------------|----------------|
| coloriage-admin | `apps/admin`   | `coloriage-anime-admin.vercel.app`    |
| coloriage-play  | `apps/play`    | `coloriage-anime-play.vercel.app`     |

Le `vercel.json` de chaque app exécute `cd ../.. && npm run build:<app>` puis sert `dist/`. Variables d'env nécessaires :
- Admin & Play : config Firebase (les valeurs sont déjà inlinées dans `firebase.ts`, mais à terme on peut les passer en `VITE_*`).
- Admin : `VITE_PLAY_BASE_URL=https://coloriage-anime-play.vercel.app` (utilisé par `buildPlayUrl`).


## Concept

L'utilisateur crée un projet avec une image de coloriage et **plusieurs animations** (une "rest" en boucle infinie + des "oneshot" déclenchées à la demande). L'admin définit des **anchor points** (points structurels trackés) sur l'image, puis un maillage triangulé avec des points internes. Le suivi optique est pré-calculé sur les anchors seuls, avec validation par keyframes. Les points internes suivent via coordonnées barycentriques. Toutes les animations partagent la même géométrie (topologie mesh) mais ont chacune leur propre vidéo et tracking. L'utilisateur final scanne son coloriage colorié, et l'app injecte ses couleurs dans le maillage animé via PIXI.js avec transitions fluides entre animations.

## FILM (niveau projet — produit cible) : TIMELINE (v4)

Chaque coloriage a un **FILM** joué automatiquement après le scan. **Le mode scène interactif est DÉPRÉCIÉ** ; l'app PLAY n'affiche un coloriage QUE s'il a un film jouable. Depuis la v4, le film est une **TIMELINE de clips** (comme un logiciel de montage) : le OÙ reste spatial (waypoints sur le décor), le QUAND est la donnée maîtresse.

- **Modèle** (`types/project.ts`) : `FilmT { version: 4, plans: FilmTimelinePlan[], character, sounds (bibliothèque), music?, défauts éditeur }`. Chaque plan : décor (`backdrop`/`overlay` chroma), `cameraX`, `transitionToNext`, et SA `timeline { durationMs, waypoints[] (spatial : x/y/échelle/regard), motion[] (1 piste exclusive : appear/travel/exit, durée maîtresse → vitesse dérivée, courbes Bézier + easing, 🔒 lockedSpeedPxPerSec), anim[] (1 piste : animationId + fillMode loop/once-hold), soundTracks[][] (N pistes libres : volume/rate/loop/parlé/fades + ancrage ⚓ {clipId, edge, offsetMs} sur un clip motion/anim) }`. Les types v3 (`Film`/`FilmPlan` = alias `FilmV3`/`FilmPlanV3`) ne servent qu'à la lecture legacy.
- **Moteur** : `FilmTimelineSampler` (`utils/filmTimelineSampler.ts`) — PUR : `evaluate(tMs) → { position, échelle, flip (tangente), animId + frame fractionnaire, plan, fade, phase }` ; tables arc-length précalculées (`filmPath.ts` réutilisé). `ScenePlayer` : couche impérative fine (`filmRuntime` dans le ticker) → `scenePlayback.setFilmPose()`, transitions de plans (`filmTransitions.ts` inchangé) et fin déclenchées aux franchissements de bornes. `FilmDirector` (machine à états v3) n'est conservé que comme fallback si la conversion échoue.
- **Audio** : `FilmAudioScheduler` (`utils/filmAudioScheduler.ts`) — WebAudio schedulé (`AudioBufferSourceNode.start(when, offset)`) sur le ctx partagé de `mouthAudioAnalyser` ; l'horloge du ctx est l'horloge MAÎTRESSE du film (pause/gel décor = `suspend()`). Musique bouclée globale, fades par rampes de gain, RMS des clips « parlé » → bouche, master → bus d'enregistrement (`recordingAudioBus`) en direct (plus de MediaElementSource côté film). Unlock iOS dans le clic « Lancer l'animation » (ScanPage).
- **Admin** : onglet FILM → `FilmEditorT` (`components/admin/film/`) : canvas spatial (`FilmCanvasT` : waypoints clic/drag/clic-droit, marge hors-décor 35 %, échelle libre 30×, caméra, chemins + CPs draggables, silhouette au playhead) + bandeau plans (▶ par plan, transitions, décors) + `timeline/TimelineEditor` (clips draggables + poignées, snap magnétique — Alt désactive, Ctrl+molette zoom, double-clic piste son = poser un son, Espace = lecture éditeur AVEC sons, playhead scrubbable) + `timeline/ClipInspector` (durée/easing/courbe 0-1-2 CP/🔒 vitesse/fillMode/volume/parlé/fades/⚓).
- **Persistance** : Firestore `ProjectDoc.filmT` (soundTracks wrappées `{clips}` — pas d'array imbriqué) ; quand `filmT` est écrit, `film` (v3) ne l'est PLUS. Storage inchangé : `projects/{id}/film/plans/{planId}/backdrop|overlay` + `film/sounds/{soundId}` ; hints film* inchangés.
- **Migration** : doc.filmT prioritaire ; sinon `convertFilmV3ToTimeline` (`utils/filmV3Convert.ts`, async) matérialise les durées v3 via `buildFilmSegments` + `estimateFilmDurations` (ids conservés → pas de re-upload) — appelée à l'ouverture (FilmEditorT) et à la lecture (ScanPage) ; anciens `scene.film` → `convertLegacySceneFilm` puis conversion. 1ʳᵉ sauvegarde → doc.filmT.
- **PLAY** : `PlayPage` gate `published && (filmTIsPlayable(filmT) || filmIsPlayable(film))` ; `BookPage` filtre `hasFilm` (`computeDocHasFilm` lit filmT d'abord). ⚠ Admin et play se déploient ENSEMBLE.

## Stack technique

| Couche | Technologie |
|--------|------------|
| Framework UI | React 19 + TypeScript strict |
| Routing | React Router 7 |
| Base de données | Firebase (Firestore + Cloud Storage) |
| Géométrie maillage | Delaunator (triangulation de Delaunay) |
| Rendu graphique | PIXI.js 7 (WebGL 2D) |
| Vision par ordinateur | OpenCV.js dans Web Worker |
| Traitement image | Canvas API HTML5 |
| Build | Vite 7 |
| PDF | jsPDF |
| Inpainting | LaMa via Cloud Function Python (GCP) |

## Architecture des routes

```
/                    → HomePage     (liste/création de projets)
/admin/:projectId    → AdminPage   (workflow 10 étapes)
/scan/:projectId     → ScanPage    (scan + animation)
```

## Multi-Animation

Un projet contient **plusieurs animations** partageant la même image et géométrie :
- **Rest** (exactement 1) : animation en boucle infinie (idle). Pipeline complet 10 étapes. Seule animation autorisée à modifier la géométrie.
- **Oneshot** (0+) : animations à la demande (wave, jump...). Pipeline réduit 6 étapes (tracking seul, géométrie héritée de rest).
- **Physics** (0+) : animations procédurales par code JS. Pas de vidéo ni tracking — l'utilisateur écrit du code qui transforme les vertices du maillage. Les frames sont pré-calculées à la validation et stockées comme `videoFramesMesh`, ce qui les rend identiques aux oneshots pour le playback. Option **overlay** : si activée, l'animation se superpose instantanément à la rest loop (déplacements additifs) sans attendre la fin du cycle.
- **Bone** (0+) : animations par déformation squelettique. Pipeline 7 étapes (vidéo + tracking des anchors comme oneshot, puis définition de bones + calcul par skinning au lieu d'ARAP). Self-contained comme physics — hérite la géométrie de rest, produit son propre `videoFramesMesh`. Utilisé comme oneshot/overlay dans le playback.
- **Walk** (0+) : animations de marche procédurale quadrupède. Pipeline 6 étapes (squelette 18 keypoints, séparation membres par courbes Bézier, édition maillage zone par zone, face cachée derrière les pattes, paramètres cinématiques, calcul LBS). Pas de vidéo ni tracking — les positions sont calculées par cinématique inverse + LBS. Produit `videoFramesMesh` + `walkZoneFrames`/`walkBodyFrames` pour le rendu séparé par zone.
- **Members-Bones** (0+) : type **autonome** (n'hérite pas la géométrie rest). Pipeline 4 étapes (Vidéo, Définir Zones, Définition Points, Tracking Points). Combine **SAM 2** (Meta 2024, segmentation vidéo native via Cloud Function) pour segmenter le body + 4 pattes par zone, et **CoTracker3** (Meta 2024, Cloud Function existante) pour le tracking de points caractéristiques. Pipeline robuste aux occlusions : les points caractéristiques sont auto-tagués à leur zone via le masque SAM 2 frame 0, et **clampés dans leur zone** au tracking si CoTracker les fait drift hors de leur masque. Stockage : `mesh.sam2Zones`/`sam2Prompts`/`sam2MasksRLE` (RLE COCO compact) + `mesh.anchorPointZoneIds` parallèle à `anchorPoints`.
- **Members-Bones-V3** (0+) : variante qui **hérite toute la topologie** (body + 4 pattes, P0 + anchors + subdivision + internes) de `projectTriangulation`. Plus de `bodyChain` : le body est animé par **ARAP** depuis les anchors contour trackés. Pipeline 11 étapes (Vidéo → Zones SAM2 vidéo → Lissage contours → Tracking P0 / Anchors / Subdivision déterministe sur contours vidéo → Lissage anchors Butterworth → Calc Body ARAP + Butterworth post-ARAP → Bones Pattes → Calc Pattes LBS + Butterworth post-LBS). Pré-requis : `projectTriangulation.step3Validated === true`. V3 bloque la création tant que la Triangulation projet n'est pas complète. Faces cachées alignées naturellement (même topologie body/pattes).

### Topologie partagée

La géométrie frame 0 (contourOrigin, contourAnchors, contourSubdivisionPoints, anchorPoints, internalPoints, triangles, trackedTriangles, internalBarycentrics) est définie sur la rest animation et **propagée** aux oneshots, physics et bone. Si la géométrie rest change, le tracking des oneshots est invalidé, les frames pré-calculées des physics sont effacées, et les bones sont invalidés (boneWeights recalculé nécessaire).

### Adapter pattern

Les step components ne connaissent pas le multi-animation. `AdminPage` construit un `ProjectStepView` (projet + videoBlob/mesh de l'animation sélectionnée) et intercepte le save pour merger dans la bonne animation. Les physics animations utilisent un composant dédié (`PhysicsAnimationEditor`) qui reçoit directement le projet et l'animation.

### Import projet (ProjectImportSection)

Section dédiée au-dessus de la barre animations dans `AdminPage`. Carte avec 3 zones d'import :
- **Image coloriage** (PNG/JPEG) — obligatoire
- **Vidéo de fond** (MP4/WebM) — optionnelle, jouée en boucle en arrière-plan
- **Son d'ambiance** (MP3/WAV/OGG) — optionnel, joué en boucle continue dans le player, avec toggle activer/désactiver

Ces assets sont au **niveau projet** (partagés par toutes les animations). Le composant `ProjectImportSection.tsx` reçoit le `Project` directement et sauvegarde avec les hints `'image'`, `'backgroundVideo'`, `'ambientSound'`.

### Preview panel (AdminPreview)

Layout split-panel dans `AdminPage` : volet gauche (édition pipeline) + volet droit (preview live PIXI.js). La preview utilise l'image PNG originale comme texture (pas de scan). Affiche l'animation rest en boucle + boutons oneshot/physics.

- **Masquable** : bouton "Masquer/Afficher preview" dans le header
- **Redimensionnable** : barre de séparation draggable (15% à 60%), défaut ~1/3
- **Condition** : visible seulement quand la rest animation a un `videoFramesMesh` calculé
- **Responsive** : pleine largeur avec marges 5vw sur écrans 4K (>2000px) ; empilement vertical sous 1024px
- **Composant** : `AdminPreview.tsx` — PIXI.js léger, FPS capé à 30, ResizeObserver, pas de fullscreen/parallax
- **Pas de physique tactile** — la physique spring-back a été supprimée

### Zones Corporelles

Système de **zones corporelles** pour les interactions tactiles dans le ScenePlayer. L'admin définit des groupes de triangles labellisés (tête, queue, etc.) sur le maillage, puis dans l'éditeur de scène, chaque zone est liée à une animation par rest point.

- **Modèle** : `BodyZone { id, label, color, triangleIndices[] }` sur `Project.bodyZones`
- **Mapping** : `ZoneAnimationMapping { zoneId, animationId }` sur `SceneRestPoint.zoneAnimationMappings`
- **Éditeur** : onglet "Zones" dans l'admin (4ème section), éditeur canvas avec sélection par triangle (clic, peinture, rectangle)
- **Player** : au toucher pendant l'état interaction, détection du triangle → zone → animation → `requestOneshot()`
- **Sécurité** : les zones sont invalidées (vidées) quand la géométrie rest change

### Design system

Système de design CSS variables dans `global.css` :
- **Boutons** : hiérarchie `btn-primary` (bleu, actions principales), `btn-secondary` (outlined), `btn-ghost` (transparent), `btn-icon` (carré), `btn-danger` (rouge), `btn-sm`/`btn-lg` (tailles). Le hover par défaut est neutre (pas bleu).
- **Tokens** : spacing scale (`--space-1` à `--space-8`), typography scale (`--text-xs` à `--text-2xl`), shadows (`--shadow-sm/md/lg`), radius (`--radius-sm/lg/full`)
- **Responsive** : breakpoints 480px, 768px, 1024px, 2000px

### Pipeline stepper

Navigation admin via **stepper numéroté** (remplace les tabs plats) :
- Cercles connectés par des lignes, numérotés 1 à 10
- 3 états visuels : **done** (✓ vert), **active** (● bleu avec glow), **pending** (○ gris)
- Statut dérivé des champs mesh existants (pas de données supplémentaires)
- Scroll horizontal sur mobile, labels cachés sur petit écran

### Section actions rapides

Ligne sous la section import projet avec 3 encadrés côte-à-côte :
- **Animations** : `AnimationManager` (pills sélection animation) — flex: 1
- **PDF** : encadré orange, icône document, téléchargement PDF imprimable — visible dès l'import de l'image
- **Scanner** : encadré bleu, icône appareil photo, lien vers la page scan

## Workflow Admin (10 étapes rest / 6 étapes oneshot / 1 étape physics)

Pipeline "contour-first" avec coordonnées curvilignes. Un point d'origine P0 définit le s=0 du contour. Seuls 4-5 points caractéristiques du contour sont trackés par extrema de courbure CSS ; les points intermédiaires sont calculés déterministiquement par coordonnée curviligne sur le contour Canny détecté à chaque frame.

### Pipeline rest (10 étapes)
1. **Vidéo** — Upload vidéo d'animation MP4/WebM + son optionnel pour oneshot (image importée dans la section projet)
2. **Canny** — Preview contour externe Canny sur vidéo + réglage 3 seuils (low, high, blur)
3. **Point 0 Contour** — Placement du point d'origine P0 sur le contour Canny de l'image (auto-snap 30px, définit s=0)
4. **Tracking Point 0** — Optical flow + snap-to-contour Canny sur P0 frame par frame, édition keyframes
5. **Anchors Contour** — Placement points caractéristiques sur le contour (auto-snap unbounded Canny) + auto-détection par extrema de courbure (`detectCurvatureExtrema`, 4-20 pts). P0 inclus automatiquement en premier anchor. Tri par ordre contour.
6. **Subdivision** — Points intermédiaires entre anchors (placement statique frame 0 seulement). Compteur +/- par segment et global. Le calcul par frame est fait à l'étape 10.
7. **Tracking Contour** — Placement déterministe par coordonnée curviligne normalisée + snap extrema courbure CSS (`detectGlobalCurvatureExtrema`). Pas d'optical flow. 2 modes : s fixe ou proche en proche.
8. **Ancres Internes** — Placement points features intérieurs (contour en overlay lecture seule) + auto-détection par grille
9. **Tracking Ancres** — Optical flow sur ancres internes + keyframes. Contraintes hardcodées : anti-saut + voisinage ON, temporel + outlier OFF.
10. **Triangulation** — Points internes + Delaunay + verrouillage topologie + calcul animation ARAP (As-Rigid-As-Possible) + lissage temporel + preview 3 modes (vidéo/wireframe/gradient) + crossfade configurable

### Pipeline oneshot (6 étapes)
1. **Vidéo** — Upload vidéo d'animation + son optionnel (image héritée du projet)
2. **Canny** — Preview contour Canny sur la vidéo oneshot (géométrie héritée de rest en lecture seule)
3. **Tracking Point 0** — Tracking P0 sur la vidéo oneshot (optical flow + snap Canny)
4. **Tracking Contour** — Placement curviligne + snap extrema courbure sur la vidéo oneshot
5. **Tracking Ancres** — Optical flow ancres internes sur la vidéo oneshot (anti-saut + voisinage)
6. **Triangulation** — Calcul animation finale ARAP (géométrie héritée, lecture seule)

### Pipeline physics (1 étape)
1. **Code Editeur** — Éditeur de code JS avec preview PIXI temps réel + pré-calcul des frames

### Pipeline members-bones (10 étapes — SAM 2 + bones barycentriques + lissage)
1. **Vidéo** — Upload vidéo d'animation (autonome : pas d'image originale ni de géométrie héritée)
2. **Définir Zones** — Définition de 5 zones (body + 4 pattes) avec clics SAM 2 natifs (1-3 prompts foreground/background par zone) sur la frame 0. Appel `requestSam2Segmentation` → masques RLE par frame par zone. Stocké dans `mesh.sam2Zones`/`sam2Prompts`/`sam2MasksRLE` (Storage `sam2Masks.json`).
3. **Lissage Contours** — Extraction du contour externe de chaque masque RLE via `cv.findContours` (worker OpenCV) puis lissage gaussien 1D cyclique sur les coordonnées x/y du polygone (sigma configurable, défaut 3 px). **Soustraction body** : le masque body est nettoyé des masques pattes (`decodeRLEMinusRLEs`) avant extraction du contour, puis `bridgeContourAtLegs` saute les portions du contour body qui longent un contour de patte (threshold configurable, défaut 8 px). Lissage temporel (`temporalSmoothContours`, moving average 3 frames, 300 pts resamplés en arc-length) sur le body pour éliminer le jitter frame-à-frame. Stocké dans `mesh.sam2Contours: Record<zoneId, Point2D[][]>` (en pixels VIDÉO). Storage `sam2Contours.json`.
4. **P0 par zone** — Placement statique d'un point d'origine P0 sur un **extremum de courbure** du contour lissé de chaque zone (à frame 0). Snap sur les top-20 extrema détectés par `detectCurvatureExtrema` (affichés en orange, rayon snap 50 px video). Sélecteur de zone active. `mesh.sam2ContourOrigins: Record<zoneId, Point2D>`.
5. **Tracking P0 zones** — Calcul **déterministe** : pour chaque zone, `s_0 = pointToArcLength(P0, contour_frame_0)` puis pour chaque frame, échantillonnage à `s_0` + **snap sur l'extremum de courbure le plus proche** en distance d'arc circulaire (`detectGlobalCurvatureExtrema`, top 20). `mesh.sam2ContourOriginFrames: Record<zoneId, Point2D[]>` (Storage `sam2ContourOriginFrames.json`).
6. **Anchors par zone** — Placement statique des anchors caractéristiques sur le contour lissé de chaque zone (P0 inclus comme premier anchor). Auto-détection par courbure CSS (`detectCurvatureExtrema`). **Tri par arc-length sur le contour réordonné depuis P0** (pas le contour brut) pour que la chaîne soit P0→1→2→...→n→P0. `mesh.sam2ContourAnchors: Record<zoneId, Point2D[]>`.
7. **Subdivision par zone** — Compteurs +/- par segment et global. Segments cycliques : P0→1, 1→2, ..., n→P0. Réutilise `subdivideContour` du pipeline rest sur les contours SAM 2 lissés. `mesh.sam2ContourSubdivisionPoints/Params: Record<zoneId, ...>`.
8. **Tracking Anchors zones** — Calcul **déterministe instantané** : pour chaque anchor et chaque point de subdivision, on calcule sa coordonnée curviligne `s_i` à frame 0 puis on échantillonne le contour de chaque frame à `s_i`. Stocke `mesh.sam2ContourAnchorFrames` + `sam2ContourSubdivisionFrames` en `Record<zoneId, Point2D[][]>` (Storage JSON).
9. **Bones par zone** — Définition du squelette : **colonne vertébrale** (chaîne de joints, multi-clic puis clic droit pour finir) + **pattes** (hip/foot par barycentre sur anchors, genou par IK 2-bones draggable). Chaque endpoint est positionné par barycentre entre 1-2 anchors de zone (`Sam2BoneEndpointRef { zoneId, anchorIndexA, anchorIndexB, t }`). Preview vidéo + contours lissés + squelette animé frame par frame. `mesh.sam2Skeleton`, `mesh.sam2BonesValidated`.
10. **Lissage Bones** — Lissage temporel Butterworth (cutoff Hz configurable) sur les anchor frames pour éliminer le tremblement des bones. Stocke `mesh.sam2SmoothedAnchorFrames` séparément (les frames bruts restent intacts). Preview comparaison brut/lissé. `mesh.sam2SmoothingValidated`.

### Pipeline members-bones-v2 (15 étapes — corps + pattes séparés, lissage multi-niveaux)

Variante du pipeline members-bones qui découple le calcul du maillage corps et celui des pattes, avec lissage à 3 frontières de données. Partage les étapes 1-8 avec la V1. À partir de l'étape 9, la séparation corps/pattes permet d'attacher le hip d'une patte à un vertex du maillage corps animé (`hipBodyVertexIndex`).

1-8. Identique au pipeline V1 (Vidéo, Définir Zones, Lissage Contours, P0 par zone, Tracking P0 zones, Anchors par zone, Subdivision par zone, Tracking Anchors zones).
9. **Lissage Anchor** — Lissage temporel Butterworth (cutoff Hz configurable) sur `sam2ContourAnchorFrames` **et** `sam2ContourSubdivisionFrames` **et** `sam2ContourOriginFrames` avec le même cutoff. Produit `sam2SmoothedAnchorFrames`/`sam2SmoothedSubdivisionFrames`/`sam2SmoothedContourOriginFrames`. `mesh.sam2SmoothingValidated`.
10. **Bones Corps** — Définition de la colonne vertébrale uniquement (chaîne de joints). `mesh.sam2Skeleton.bodyChain`, `mesh.sam2BodyBonesValidated`.
11. **Calcul Corps** — Calcul LBS du maillage corps via la body chain + `projectTriangulation.bodyPoints/bodyTriangles`. Lit les anchors lissés si disponibles. Produit `mesh.walkBodyFrames`.
12. **Lissage Maillage Corps** — **NOUVEAU** — Lissage Butterworth sur `walkBodyFrames` (chaque vertex corps indépendamment). Slider cutoff propre. Toggle preview brut/lissé. Produit `mesh.walkBodyFramesSmoothed` (gardé séparément du brut). `mesh.walkBodyFramesSmoothingValidated`. Essentiel pour les pattes avec hip `hipBodyVertexIndex`.
13. **Bones Pattes** — Définition des leg bones (hip/foot par barycentre anchors OR hip par body vertex, genou IK). Preview utilise `walkBodyFramesSmoothed ?? walkBodyFrames`. `mesh.sam2Skeleton.legs`, `mesh.sam2BonesValidated`.
14. **Calcul Pattes** — Calcul LBS par patte via `projectTriangulation.zonePoints/zoneTriangles`, utilise `walkBodyFramesSmoothed ?? walkBodyFrames` comme override de hip body-vertex par frame. Produit `mesh.walkZoneFrames`.
15. **Lissage Maillage Pattes** — **NOUVEAU** — Lissage Butterworth sur `walkZoneFrames` zone par zone. Slider cutoff propre. Toggle preview brut/lissé. Produit `mesh.walkZoneFramesSmoothed`. `mesh.walkZoneFramesSmoothingValidated`.

**Invalidation cascade (silencieuse)** : toute re-validation d'une étape amont remet les flags `validated` des étapes en aval à `false` et vide leurs champs de sortie. Pas de badge UI ni de re-run automatique — le stepper affiche simplement le cercle gris "pending".

**Pourquoi pas d'optical flow** : le contour SAM 2 lissé fournit déjà une géométrie cohérente frame par frame, donc le tracking se réduit à un échantillonnage par coordonnée curviligne. CoTracker a été retiré (ne servait à rien après SAM 2). Aucune ressource cloud nécessaire après l'étape 2 (calcul SAM 2).

### Pipeline members-bones-v3 (11 étapes — topologie héritée de Triangulation projet + ARAP body)

Refonte majeure : V3 supprime la duplication de topologie entre `projectTriangulation` et l'animation members-bones. Toute la topologie (body + 4 pattes, P0 + anchors + subdivision + vertices internes + triangles + hidden faces) est définie **une seule fois** dans la Triangulation projet (voir section "Pipeline Triangulation Projet"). V3 se contente de tracker ces anchors sur la vidéo, anime le body par **ARAP** (plus de `bodyChain` LBS), et anime les pattes par LBS comme en V2.

**Pré-requis** : `project.projectTriangulation?.step3Validated === true` (Triangulation projet complète jusqu'aux faces cachées). La création d'une animation V3 est bloquée sinon.

1. **Vidéo** — Upload vidéo d'animation (autonome).
2. **Zones SAM 2 vidéo** — SAM 2 natif sur la vidéo pour produire des masques par frame par zone (réutilise `MembersBonesZonesStep`). Les zones sont celles définies dans `projectTriangulation.zones`.
3. **Lissage Contours** — Extraction contours + lissage gaussien + bridge body-legs + lissage temporel (réutilise `MembersBonesContourSmoothingStep`). `mesh.sam2Contours`.
4. **Tracking P0 zones** — Déterministe. Pour chaque zone, `projectTriangulation.zoneOrigins[zoneId]` (coords image) est mappé image→vidéo et snappé sur l'extremum de courbure le plus proche sur le contour vidéo frame 0. Frames suivantes : continuité par extremum le plus proche. `mesh.sam2ContourOriginFrames`.
5. **Tracking Anchors zones** — Déterministe. Pour chaque anchor (P0 inclus) + chaque point de subdivision issu de `projectTriangulation.zoneAnchors/zoneSubdivisionParams`, échantillonnage à coordonnée curviligne `s_i` sur le contour de chaque frame + snap courbure pour les anchors (pas de snap pour subdivisions). `mesh.sam2ContourAnchorFrames` + `sam2ContourSubdivisionFrames`.
6. **Lissage Anchor Frames** — Butterworth sur origin + anchor + subdivision frames (réutilise `MembersBonesSmoothingStep`). `mesh.sam2SmoothedAnchorFrames` etc.
7. **Calc Animation Body (ARAP)** — `precomputeARAP(bodyVertices, bodyTriangles, pinnedContourIndices)` depuis `projectTriangulation.bodyPoints/bodyTriangles`, avec les N premiers indices pinnés (contour body = P0 + anchors + subdivisions). Solve par frame avec positions cibles = contour body vidéo tracké et lissé. Produit `mesh.walkBodyFrames` en coords vidéo.
8. **Lissage Maillage Body** — Butterworth sur `walkBodyFrames` (chaque vertex body). Réutilise `MembersBonesV2BodySmoothingStep`. `mesh.walkBodyFramesSmoothed`.
9. **Bones Pattes** — Définition leg bones hip/foot/genou (réutilise `MembersBonesV2LegBoneStep`). Pas de `bodyChain` en V3. Hip par barycentre anchors ou par body vertex (`hipBodyVertexIndex`). `mesh.sam2Skeleton.legs`.
10. **Calc Pattes (LBS)** — LBS par patte via `projectTriangulation.zonePoints/zoneTriangles`, utilise `walkBodyFramesSmoothed ?? walkBodyFrames` comme override hip body-vertex. `mesh.walkZoneFrames`.
11. **Lissage Maillage Pattes** — Butterworth sur `walkZoneFrames` zone par zone (réutilise `MembersBonesV2LegSmoothingStep`). `mesh.walkZoneFramesSmoothed`.

**Différences clés vs V2** :
- Plus de P0/anchors/subdivision définis dans l'animation — hérités de `projectTriangulation`.
- Plus de `bodyChain` ni de "Bones Corps" / "Calcul Corps" LBS — ARAP remplace tout.
- Body et pattes partagent la même topologie que les hidden faces → alignement naturel au rendu.
- V2 reste disponible en parallèle pour projets legacy ; pas de migration automatique.

### Bone "machoire" (cotracker-bones)

Une animation `cotracker-bones` peut optionnellement définir un **bone machoire unique** (`CoTrackerJawBone` dans `cotrackerSkeleton.jaw`) qui pilote l'angle d'ouverture de la zone bouche Bézier (`project.projectMouth`) à partir d'**un seul point cotracker** placé à la pointe de la mâchoire. Pas de LBS — le bone produit un `cotrackerJawOpennessFrames[]` (openness ∈ [0,1] par frame) calculé à partir de l'écart angulaire entre la direction de référence `restDirImage` (capturée à frame 0) et la direction `pivot→tail` courante, normalisé par `maxOpenAngleDeg` puis clampé. Le pivot réutilise `projectMouth.hingeAnchor` (barycentrique sur `bodyPoints`). Au playback, l'`openness` final = `max(openness_parole_RMS, openness_jaw)`, ce qui permet de cumuler parole et animations type rugissement/cri/atchoum. Calculé dans `runCoTrackerLBSCompute` (étape LBS) via `utils/cotrackerJawCompute.ts`. Le pipeline marche strip le champ `jaw` du snapshot hérité (pas de point cotracker pour le piloter).

### Pipeline marche (3 étapes — squelette hérité d'une animation CoTracker + gait procédural)

Animation procédurale qui **hérite la topologie** de `projectTriangulation` (comme V3) **et le squelette** (`CoTrackerSkeleton`) d'une animation parente `cotracker-bones` validée. Pas de vidéo propre, pas de tracking : les positions du squelette sont calculées frame par frame via les sliders `WalkParams`. Sortie : `walkBodyFrames` + `walkZoneFrames` consommés par `zoneMeshRenderer` exactement comme V3.

**Pré-requis** : `projectTriangulation.step3Validated === true` ET au moins une animation `cotracker-bones` avec `cotrackerBonesValidated === true`.

1. **Hériter bones** — sélecteur d'animation parente cotracker-bones. À la validation, copie de `cotrackerSkeleton` → `mesh.marcheSkeleton`, extraction des positions rest des joints (frame 0 des chaînes lissées du parent), conversion video→image coords. Stocke `marcheBodyJointRestPositions` + `marcheLegRestPositions`.
2. **Pattes** — liste à cocher des `marcheSkeleton.legs[]`. L'admin coche les bones qui suivent le cycle de marche (pied au sol/en l'air) ; les non cochés restent fixes à leur rest position. `mesh.marcheGaitLegIds[]`.
3. **Paramètres marche** — sliders `WalkParams` (speed, strideLength, footLift, bodySway, headSway, kneeForward front/back). Preview live du squelette animé en boucle. Bouton « Calculer » → [marcheSolver.computeMarcheFrames](apps/admin/src/utils/marcheSolver.ts) → `walkBodyFrames` + `walkZoneFrames`.

**Solver** : `marcheSolver.ts` construit des sub-bones à partir des paires de joints consécutifs (body chain + chaque chaîne de patte `[hip, ...joints, foot]`). Auto-weights par distance inverse au carré, restreints par zone (les vertices `body` ne sont influencés que par les sub-bones du body chain ; les vertices d'une zone-patte par les sub-bones de cette patte uniquement). Trajectoire pied stance/aerial + IK 2-bones pour les genoux (legs avec 1 joint intermédiaire) ou interpolation proportionnelle (≥2 joints intermédiaires).

### Pipeline bone (7 étapes)
1. **Vidéo** — Upload vidéo d'animation (image héritée du projet)
2. **Canny** — Preview contour Canny sur la vidéo bone (géométrie héritée de rest en lecture seule)
3. **Tracking Point 0** — Tracking P0 sur la vidéo bone (optical flow + snap Canny)
4. **Tracking Contour** — Placement curviligne + snap extrema courbure sur la vidéo bone
5. **Tracking Ancres** — Optical flow ancres internes sur la vidéo bone (anti-saut + voisinage)
6. **Bones** — Définition du squelette : chaque bone a 2 endpoints (head/tail) positionnés relativement à une paire d'anchor points trackés. Option **longueur constante** par bone. Option **coude** (elbow IK 2-bones) avec 3 modes de pli. Validation → calcul auto-weights par distance inverse sur les sub-bones.
7. **Triangulation** — Calcul animation par déformation squelettique (bones + LBS au lieu d'ARAP) → `videoFramesMesh`. Preview wireframe/gradient avec overlay bones animés.

### Système Bone

**Concept** : au lieu de tracker chaque point du maillage et d'utiliser ARAP pour déformer, on définit un squelette de bones dont les positions sont déduites des anchor points trackés. Les vertices du maillage sont liés aux bones par skinning automatique. Chaque bone est indépendant (pas de hiérarchie parent-enfant).

**Bone** : segment défini par 2 endpoints (head + tail). Chaque endpoint est positionné dans le repère local d'une paire d'anchors :
- `origin = anchorA`, `axe_x = anchorB - anchorA`, `axe_y = perp(axe_x)`
- `position = anchorA + localX × (B-A) + localY × perp(B-A)`
- `localX`/`localY` normalisés par `|A-B|` — le bone se déplace et se redimensionne avec ses anchors
- Si `anchorA === anchorB` : le bone suit la translation pure de l'anchor (pas de rotation)

**Longueur constante** (`fixedLength: boolean`) : si activé, la direction du bone suit les anchors mais sa longueur est figée à celle du rest pose. Le tail est repositionné sur la droite head→tail à distance constante.

**Coude (elbow IK)** : un bone peut avoir un coude intermédiaire (`elbowPos: Point2D | null`). Le coude crée 2 sous-segments (head→elbow, elbow→tail) dont les longueurs sont constantes (déterminées au repos). La position du coude est calculée par IK 2-bones (intersection de 2 cercles, cosine rule) à chaque frame. 3 modes pour choisir le côté du pli (`elbowMode: ElbowMode`) :
- **`rest`** : côté fixé par le placement du coude au repos (cross product)
- **`centroid`** : le coude plie vers le centroïde des points trackés (intérieur du mesh)
- **`continuity`** : le coude reste du même côté que la frame précédente (continuité temporelle)

Le coude est draggable dans l'éditeur (mousedown/move/up).

**Sub-bones** : en interne, un bone avec coude est éclaté en 2 sub-bones pour le calcul des weights et du skinning. Un bone sans coude = 1 sub-bone. Les auto-weights et matrices travaillent sur les sub-bones.

**Auto-weights** : poids par distance inverse au carré au segment du sub-bone. `w = 1/(dist+1)²`, normalisés par vertex. Seuil < 0.01 → 0.

**Skinning** : Linear Blend Skinning (LBS) — chaque vertex est déformé par la moyenne pondérée des transformations rigides (rotation + translation) de ses sub-bones influents.

**Rest pose** : le rest pose des bones utilise `trackedFrames[0]` (positions trackées frame 0 de la vidéo), pas les positions éditeur statiques. Cela évite le micro-décalage entre l'image statique et la frame 0 de la vidéo.

**Déformation par frame** :
1. Calcul positions endpoints depuis les tracked anchors (`contourAnchorFrames[f]` + `anchorFrames[f]`)
2. Si `fixedLength` (sans coude) : normaliser la longueur au rest pose
3. Si coude : résoudre IK 2-bones → position du coude, avec bendSide selon le mode
4. Calcul transform rigide (rotation + translation) par sub-bone vs rest pose
5. LBS : `position_vertex = Σ weight_sb × transform_sb(rest_position_vertex)`
6. Résultat : `videoFramesMesh[f]`

### Pipeline Walk (6 étapes)

1. **Zones membres** — Définition des 4 zones pattes par courbes Bézier fermées + séparation limb/corps
2. **Maillage zones** — Édition maillage par zone : limb (Delaunay auto + internals) + corps (fixe + patch manuel : ajouter/relier/déplacer)
3. **Face cachée** — Définition des zones de face cachée derrière chaque patte. Pour chaque patte : sélection de 2 vertices du contour body (A et B), placement de bridge points entre A et B, puis Delaunay dans le polygone fermé (bridge + body boundary). Les nouveaux triangles sont fusionnés dans bodyPoints/bodyTriangles. Texture générée par LaMa inpainting (Cloud Function) au scan, avec fallback diffusion Laplacienne.
4. **Bones marche** — Placement 18 keypoints du squelette quadrupède (6 groupes : 4 pattes + cou/tête + queue)
5. **Paramètres** — Paramètres cinématiques (longueur pas, levée pied, balancement corps/tête, phases de marche)
6. **Calcul** — Calcul animation par LBS séparé (zones + body) + legacy unifié, preview wireframe/gradient

### Face cachée (système)

Quand une patte s'anime, elle révèle la zone du corps qui était occultée dans l'image originale (l'enfant a colorié la patte, pas le corps derrière). Le système de "face cachée" comble ces trous :

**Modèle** : `HiddenFaceZone { limbZoneId, bodyVertexA, bodyVertexB, bridgePoints, bodyTriangleIndices }` — sous-ensemble du body mesh, pas une triangulation indépendante.

**Édition admin** (`WalkHiddenFaceStep`) :
1. L'admin sélectionne 2 vertices du contour body (A et B)
2. Il place des bridge points manuels entre A et B (contour intérieur)
3. Polygone fermé = [A, ...bridgePoints, B] + body boundary path B→A
4. Delaunay dans le polygone → points internes auto-générés (grille Poisson)
5. Nouveaux points/triangles fusionnés dans `bodyPoints`/`bodyTriangles`
6. Les indices des triangles ajoutés sont mémorisés dans `bodyTriangleIndices`

**Animation** : les hidden face triangles font partie du body mesh → animés par `bodyFrames` (aucun calcul supplémentaire).

**Rendu** : `zoneMeshRenderer` split le body en 2 PIXI meshes (pur body + hidden face) avec z-order différent. Le body visible utilise la texture scan haute résolution. Les hidden face meshes utilisent une texture inpaintée :
- **LaMa** (prioritaire) : Cloud Function Python (`functions/main.py`) reçoit le scan + un masque binaire des zones pattes (généré par `limbMaskGenerator.ts` depuis les Bézier dilatées), exécute LaMa neural inpainting, retourne un "scan sans pattes". Résolution 512px pour la vitesse, upscalé aux dimensions originales.
- **Fallback K-means/BFS** : si LaMa échoue, `inpaintHiddenFaceOnScan` (dans `hiddenFaceTexture.ts`) peint des couleurs plates par K-means sur les pixels de bordure puis propagation BFS avec barrières inter-clusters.

**Z-order** : body (z=0) → hidden face (z=limb.zOrder - 0.5) → limb (z=limb.zOrder)

### Hidden Face Limb (extension de patte)

Symétrique au système body : quand le corps (animé) recouvre une partie de la patte qui était visible dans l'image originale, il faut "rallonger" la patte sous le corps. Modèle : `HiddenFaceLimbZone { limbZoneId, zoneVertexA, zoneVertexB, bridgePoints, zoneTriangleIndices }` — sous-ensemble du zone mesh d'une patte (pas du body).

**Texture** : `flowExtrudeLimbOnScan` (dans `hiddenFaceTexture.ts`) extrude les couleurs de la patte visible vers la zone d'extension par échantillonnage perpendiculaire à la corde A↔B (le "genou" de la zone) :
1. Rasterisation des triangles visibles → masque local.
2. Pour chaque position latérale `iu ∈ [0, N_U)`, lance un rayon **perpendiculaire à la corde** depuis `lerp(A, B, iu/(N_U-1))` dans la patte visible et collecte les pixels jusqu'à sortir du masque (skip de quelques px pour éviter le contour noir) → 1 colonne RGB 1D = "rivière" du genou vers le pied.
3. Pour chaque pixel d'extension : `u = projection sur corde`, `dPx = |distance perpendiculaire|`, lookup `column[round(u·(N_U-1))][clamp(floor(dPx), 0, len-1)]`.

Conséquence : les "lignes" de la patte se prolongent par symétrie autour de la corde, sans bande répétée (clamp en profondeur, pas de tiling cyclique).

### Pipeline Triangulation Projet (4 étapes)

Section dédiée dans `AdminLayout` (onglet "Triangulation"), indépendante du pipeline rest/oneshot/walk. Permet de créer une triangulation au niveau projet partagée par les animations `members-bones` / `members-bones-v3`.

1. **Image référence** — Import image colorée (pas le coloriage N&B). Utilisée par SAM 2 pour segmenter les zones.
2. **Zones SAM 2** — Placement clics foreground/background par zone (body + 4 pattes) sur l'image. Appel SAM 2 (Cloud Function ou serveur local MPS) → masques RLE → contours lissés par zone.
3. **Maillage par zone** — Édition **curvilignée** en 4 sous-phases par zone puis Delaunay interne :
   - (a) **Placement P0** — clic sur le contour lissé avec snap sur top-20 extrema de courbure (`detectCurvatureExtrema`). Définit `s=0` de la zone.
   - (b) **Anchors contour** — auto-détection par courbure (P0 inclus comme [0]) + édition manuelle (add/drag/delete). Tri par arc-length depuis P0.
   - (c) **Subdivision** — compteurs +/- par segment et global. Utilise `subdivideContour` pour produire points + params curvilignes.
   - (d) **Triangulation intérieure** — Delaunay sur `[P0, subdivision_seg0, anchor_1, subdivision_seg1, ..., anchor_N, subdivision_segN]` + points internes auto (densité slider) + manuels. Patch body Ajouter/Relier/Déplacer pour combler les trous. Z-order éditable.

   Le body est automatiquement troué aux zones pattes (tout triangle touchant une patte est supprimé, points orphelins compactés).

   **Invariant d'indexation** : `zonePoints[zoneId]` est ordonné `[P0, subdiv_seg0..., anchor_1, subdiv_seg1..., ..., anchor_N, subdiv_segN..., ...internes]`. Les N premiers indices (= `zoneContourLength[zoneId]`) sont le contour "trackable" par V3 ; les suivants sont les internes déformés par ARAP.
4. **Faces cachées** — Même système que Walk : sélection 2 vertices boundary (A/B), bridge points manuels, Delaunay dans le polygone fermé. Split body visible / hidden face au rendu.

**Rendu** : `buildPseudoSeparation()` convertit `ProjectTriangulation` en format `WalkLimbSeparation` pour réutiliser `zoneMeshRenderer.buildZoneMeshes()`. Le `zOrder` défini en étape 3 est propagé aux meshes PIXI.

## Workflow Scan (utilisateur final)

**Orientation forcée** : toute la page scan est en mode paysage. `screen.orientation.lock('landscape')` au montage de `ScanPage`, avec fallback CSS `transform: rotate(90deg)` en portrait.

**Layout animation** : plein écran fixe en `flex-direction: row` — canvas PIXI à gauche (`flex: 1`), sidebar paramètres à droite (220px).

1. **Caméra** — Détection temps réel des marqueurs L + analyse qualité
2. **Ajustement coins** — Repositionnement manuel des 4 coins
3. **Correction perspective** — Homographie OpenCV → image 2048×2048 → crop marges 64px → resize aux dimensions originales
4. **Debug** — Visualisation 4 étapes du pipeline (photo brute, 2048 avec marges, croppée, overlay mesh)
5. **Animation** — Rendu PIXI.js du maillage texturé animé à 24 FPS + parallax gyroscope + boutons oneshot + interactions par zones corporelles

## Structure des fichiers

```
src/
├── main.tsx                    Point d'entrée
├── App.tsx                     Router
├── types/project.ts            Types (Point2D, Animation, BodyZone, SceneBackground, SceneForeground, ProjectStepView, MeshData, Project, Scan)
├── db/
│   ├── firebase.ts             Init Firebase
│   ├── projectsStore.ts        CRUD projets (Firestore + Storage)
│   └── scansStore.ts           CRUD scans
├── hooks/useProject.ts         Hook chargement/sauvegarde projet
├── pages/
│   ├── HomePage.tsx            Liste projets
│   ├── AdminPage.tsx           Onglets admin (10 étapes) + preview split-panel
│   ├── admin/
│   │   ├── AdminLayout.tsx     Layout admin avec navigation par sections (Paramètres, Animations, Zones, Scène, Triangulation)
│   │   └── TriangulationSection.tsx  Section triangulation projet (4 étapes : Image réf, Zones SAM 2, Maillage, Faces cachées)
│   └── ScanPage.tsx            Machine d'états scan
├── components/
│   ├── admin/                  Étapes admin (10 étapes + support + AnimationManager + AdminPreview + BodyZoneEditor + ProjectImportSection + PhysicsAnimationEditor + BoneEditorStep + BoneTriangulationStep + Walk*Steps + ProjectTriang*Steps + MembersBones*Steps)
│   ├── keyframes/              Éditeur de keyframes (éditeur canvas)
│   ├── triangulation/          Éditeur maillage (canvas, interactions, dessin)
│   └── scan/                   Composants scan (caméra, coins, processing, animation)
├── utils/
│   ├── autoMeshGenerator.ts    Détection contour + génération grille interne
│   ├── barycentricUtils.ts     Coordonnées barycentriques (calcul, recherche triangle, interpolation)
│   ├── geometry.ts             Point-in-polygon, distanceSq, centroïde
│   ├── keyframePropagation.ts  Interpolation linéaire entre keyframes
│   ├── markerGenerator.ts      Dessin marqueurs L
│   ├── opticalFlowComputer.ts  Pipeline extraction frames + tracking + segment re-tracking
│   ├── trackingConstraints.ts  Contraintes voisinage + snap-to-contour + spring curviligne
│   ├── contourAnchorTracker.ts Raffinement hybride LK + template matching + snap contour (utilisé par opticalFlowComputer)
│   ├── curvilinearContour.ts   Coordonnées curvilignes sur contour Canny
│   ├── curvatureScaleSpace.ts  Détection extrema courbure (single-scale + global) + snap anchor par courbure
│   ├── arapSolver.ts           Déformation ARAP (As-Rigid-As-Possible) du maillage
│   ├── optimalTransportSnap.ts Assignment optimal (transport) pour snap contour robuste
│   ├── contourSpatialIndex.ts  Index spatial bucket 2D pour snap-to-contour
│   ├── perspectiveCorrection.ts Bridge Worker OpenCV (RPC)
│   ├── pdfGenerator.ts         Génération PDF
│   ├── pdfLayout.ts            Constantes layout A4
│   ├── textureExtractor.ts     Calcul UVs pour PIXI
│   ├── bodyZoneUtils.ts        Détection zones corporelles (triangle→zone, hit test, touch detection)
│   ├── boneSolver.ts           Déformation squelettique (bones, auto-weights, LBS, forward kinematics)
│   ├── sam2BoneSolver.ts       Squelette members-bones (résolution barycentrique par zone, IK genoux)
│   ├── walkSolver.ts           Cinématique marche quadrupède (squelette, IK, LBS, séparation zones)
│   ├── limbSeparation.ts       Séparation membres/corps (Bézier→polygone, Delaunay par zone, patch manuel body, triangulation face cachée)
│   ├── bezierUtils.ts          Utilitaires courbes Bézier (flatten, expand, évaluation)
│   ├── hiddenFaceTexture.ts    Inpainting body fallback (K-means + BFS) + extrusion patte par colonnes perpendiculaires
│   ├── limbMaskGenerator.ts    Génération masque binaire des zones pattes (Bézier dilatées) pour LaMa
│   ├── lamaInpainting.ts       Client API Cloud Function LaMa (envoi scan+masque, réception inpainté)
│   ├── zoneMeshRenderer.ts     Rendu PIXI.js par zone (build/update meshes séparés, z-order, split body/hidden face)
│   ├── multiAnimationPlayback.ts Machine d'états playback multi-animation (rest loop + oneshot transitions + physics overlay)
│   └── membersBonesTriangSolver.ts Calcul animation members-bones par zone (auto-weights distance inverse, LBS par zone)
└── styles/global.css
public/
├── opencv.js                   Bibliothèque OpenCV.js compilée
└── opencv-worker.js            Web Worker OpenCV (détection, flow, perspective)
```

## Modèle de données

```typescript
AnimationType = 'rest' | 'oneshot' | 'physics' | 'bone' | 'walk' | 'members-bones' | 'members-bones-v2' | 'members-bones-v3' | 'cotracker-bones' | 'marche'

Animation {
  id: string                         // crypto.randomUUID()
  name: string                       // "Idle", "Wave", "Jump", "Tourbillon"
  type: AnimationType
  createdAt: number
  videoBlob: Blob | null             // Vidéo propre (rest/oneshot), null pour physics
  mesh: MeshData | null              // Pipeline complet propre (géométrie partagée, tracking indépendant)
  physicsCode: string | null         // Code JS pour physics animations
  physicsDuration: number | null     // Durée en secondes (défaut 2)
  physicsOverlay: boolean            // Si true, se superpose à la rest loop sans attendre la fin du cycle
}

BodyZone {
  id: string                         // crypto.randomUUID()
  label: string                      // "tête", "queue"
  color: string                      // hex pour l'éditeur
  triangleIndices: number[]          // indices dans mesh.triangles
}

ZoneAnimationMapping {
  zoneId: string
  animationId: string                // réf Animation.id (oneshot ou physics)
}

Project {
  id, name, createdAt
  originalImageBlob: Blob | null     // Image coloriage (niveau projet)
  backgroundVideoBlob: Blob | null   // Vidéo fond (niveau projet)
  ambientSoundBlob: Blob | null      // Son d'ambiance (niveau projet, boucle continue)
  ambientSoundEnabled: boolean       // Toggle activer/désactiver le son
  animations: Animation[]            // Exactement 1 rest + 0..N oneshots + 0..N physics + 0..N bones
  bodyZones: BodyZone[]              // Zones corporelles (triangles groupés par label)
  markers: MarkerCorners | null      // 4 coins marqueurs L
  projectTriangulation: ProjectTriangulation | null  // Triangulation projet (SAM 2 + maillage par zone)
}

ProjectTriangulation {
  // Étape 0 : Image de référence (colorée, pour SAM 2)
  referenceImageBlob: Blob | null

  // Étape 1 : Zones SAM 2 sur image
  zones: SAM2Zone[]                                    // body + 4 pattes
  prompts: SAM2Prompt[]                                // clics foreground/background
  masksRLE: Record<string, RLEMask[]> | null           // 1 frame par zone
  maskWidth, maskHeight: number
  contours: Record<string, Point2D[]> | null           // contours lissés (coords image)
  contourSmoothSigma, bridgeThreshold: number
  step1Validated: boolean

  // Étape 2 : Maillage par zone (4 sous-phases curvilignes + Delaunay)
  // 2a : P0 par zone (coords image)
  zoneOrigins: Record<string, Point2D>
  zoneOriginsValidated: Record<string, boolean>
  // 2b : Anchors contour par zone (P0 inclus comme [0], tri arc-length depuis P0)
  zoneAnchors: Record<string, Point2D[]>
  zoneAnchorsValidated: Record<string, boolean>
  // 2c : Subdivision par zone (params curvilignes + points résultants)
  zoneSubdivisionPoints: Record<string, Point2D[]>
  zoneSubdivisionParams: Record<string, CurvilinearParam[]>
  zoneSubdivisionValidated: Record<string, boolean>
  // 2d : Triangulation Delaunay intérieure
  zonePoints: Record<string, Point2D[]>                // [P0, subdivs_seg0, anchor_1, subdivs_seg1, ..., anchor_N, subdivs_segN, ...internes]
  zoneTriangles: Record<string, [number,number,number][]>
  zoneDensity: Record<string, number>                  // densité intérieure
  zoneContourLength: Record<string, number>            // N premiers indices de zonePoints = contour (pinned ARAP)
  bodyPoints: Point2D[]                                // rééindexé (compacté) après filtrage trous pattes
  bodyTriangles: [number,number,number][]
  step2Validated: boolean

  // Étape 3 : Faces cachées
  hiddenFaceZones: HiddenFaceZone[]
  hiddenFaceLimbZones: HiddenFaceLimbZone[]
  step3Validated: boolean
}

SAM2Zone {
  id: string               // 'body' | 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
  label: string
  color: string            // hex
  zOrder?: number          // ordre rendu (0 = derrière, plus grand = devant)
}

// Adapter pattern — vue pour les step components (ne connaissent pas le multi-animation)
ProjectStepView {
  ...Project fields
  videoBlob: Blob | null             // = animation sélectionnée .videoBlob
  mesh: MeshData | null              // = animation sélectionnée .mesh
}

MeshData {
  cannyParams: CannyParams | null     // Seuils Canny validés (étape 2)

  // Point d'origine contour (étape 3)
  contourOrigin: Point2D | null              // Position P0 sur l'image originale

  // Tracking point d'origine (étape 4)
  contourOriginKeyframeInterval: number
  contourOriginKeyframes: KeyframeData[]
  contourOriginFrames: Point2D[][] | null    // 1 élément par inner array
  contourOriginTrackingValidated: boolean

  // Contour anchors (placement étape 5, tracking étape 7)
  contourAnchors: Point2D[]                    // 4-5 points caractéristiques
  contourAnchorKeyframeInterval: number
  contourAnchorKeyframes: KeyframeData[]
  contourAnchorFrames: Point2D[][] | null      // rempli étape 7
  contourAnchorTrackingValidated: boolean      // validé étape 7

  // Subdivision contour (étape 6 — points curvilignes calculés par frame)
  contourSubdivisionPoints: Point2D[]
  contourSubdivisionParams: CurvilinearParam[]  // {segmentIndex, t}
  contourSubdivisionFrames: Point2D[][] | null
  contourSubdivisionValidated: boolean

  // Cache contours Canny ordonnés par frame (calculé étape 6, réutilisé étape 7 et 10)
  contourCannyFrames: Point2D[][] | null

  // Ancres internes (étape 8 — features : yeux, ailes, etc.)
  anchorPoints: Point2D[]
  anchorKeyframeInterval: number
  anchorKeyframes: KeyframeData[]
  anchorFrames: Point2D[][] | null
  anchorTrackingValidated: boolean

  // Points internes (étape 10 — non trackés, suivent via barycentrics)
  internalPoints: Point2D[]

  // Topologie (verrouillée étape 10)
  triangles: [number,number,number][]
  topologyLocked: boolean
  trackedTriangles: [number,number,number][]
  internalBarycentrics: BarycentricRef[]

  // Bones (animation type 'bone')
  bones: Bone[]                          // Définitions des bones (étape 6 bone)
  boneWeights: number[][] | null         // [vertexIndex][boneIndex], normalisés sum=1 (Cloud Storage JSON)
  bonesValidated: boolean                // Étape 6 bone validée

  // Sortie finale (étape 10, consommé par AnimationPlayer)
  videoFramesMesh: Point2D[][] | null
}

BoneEndpointRef {
  anchorIndexA: number                   // index dans tracked = [...contourAnchors, ...anchorPoints]
  anchorIndexB: number
  localX: number                         // 0=A, 1=B, le long du segment A→B
  localY: number                         // offset perpendiculaire, normalisé par |A-B|
}

ElbowMode = 'rest' | 'centroid' | 'continuity'

Bone {
  id: string
  name: string
  head: BoneEndpointRef
  tail: BoneEndpointRef
  fixedLength: boolean                   // si true, longueur constante (rest pose)
  elbowPos: Point2D | null              // position du coude au repos (null = pas de coude)
  elbowMode: ElbowMode                  // mode de choix du côté du pli
}

Sam2BoneEndpointRef {
  zoneId: string                         // 'body' | 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
  anchorIndexA: number                   // index dans sam2ContourAnchors[zoneId]
  anchorIndexB: number                   // si A === B → snap sur anchor A
  t: number                              // barycentre : position = A + t × (B − A). 0=A, 1=B
}

Sam2BodyJoint {
  id: string
  name: string
  ref: Sam2BoneEndpointRef
}

Sam2LegBone {
  id: string
  zoneId: string                         // 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
  name: string
  hip: Sam2BoneEndpointRef
  foot: Sam2BoneEndpointRef
  kneeRestPos: Point2D                   // position repos du genou (vidéo coords), défaut midpoint hip↔foot
  kneeMode: ElbowMode                    // 'rest' | 'centroid' | 'continuity'
}

Sam2Skeleton {
  bodyChain: Sam2BodyJoint[]             // chaîne ordonnée, min 2 joints pour 1 segment
  legs: Sam2LegBone[]                    // 0-4 pattes
}

SceneBackground {
  imageBlob: Blob | null
  videoBlob: Blob | null              // image OU vidéo (en boucle)
  width: number
  height: number
}

SceneForeground {
  imageBlob: Blob | null              // PNG (transparence) ; même dimensions que l'arrière-plan
  width: number
  height: number
}

Scene {
  id, name
  background: SceneBackground | null  // Fond (image ou vidéo) derrière le personnage
  foreground: SceneForeground | null  // PNG transparent superposé devant le personnage (devant le perso, derrière le HUD)
  characterScale: number
  characterY: number
  restPoints: SceneRestPoint[]
  transitions: SceneTransition[]
  startMode: 'rest' | 'transition'
  speakSounds: SpeakSound[]
  speakSoundBlobs: (Blob | null)[]
}

SceneRestPoint {
  id, backgroundX
  restAnimationId?: string
  presentation?: SceneAction          // Intro jouée 1× à l'arrivée (anim + son « parlé »), avant interaction
  randomAnimationIds?: string[]
  zoneAnimationMappings?: ZoneAnimationMapping[]  // Zone corporelle → animation
  speakSoundIds?: string[]
  helpTexts?: string[]
}

Scan {
  id, projectId, scannedAt
  scanImageBlob: Blob                // Image rectifiée
  textureMap: TextureTriangle[] | null
}
```

## Indexation des points

Convention utilisée partout :
```
allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
tracked   = [...contourAnchors, ...anchorPoints]   // Optical flow uniquement
contour   = [...contourAnchors, ...contourSubdivisionPoints]  // Polygone fermé
```
Les indices dans `triangles` réfèrent à `allPoints`. AnimationPlayer consomme `videoFramesMesh` avec cette même convention.

## Systèmes de coordonnées

Trois espaces de coordonnées coexistent :
1. **Image** — coordonnées originales de l'image (stockage du maillage)
2. **Vidéo** — coordonnées du frame vidéo (pendant l'optical flow et la détection Canny)
3. **Écran** — coordonnées canvas/PIXI (rendu avec DPI)

**Règle critique** : les positions des anchors (`contourAnchorFrames`, `anchorFrames`, etc.) sont toujours stockées en **coordonnées image**. Les pixels Canny détectés sur les frames vidéo doivent être convertis de coords vidéo → coords image avant toute utilisation avec les positions anchor : `imgX = (videoX / videoWidth) * imageWidth`.

## Stockage Firebase

- **Firestore** : métadonnées projet (nom, dates, `animations: AnimationDoc[]` avec mesh geometry sauf gros JSON)
- **Cloud Storage** — chemins scopés par animation :
  - `projects/{id}/originalImage` — blob image (niveau projet)
  - `projects/{id}/backgroundVideo` — vidéo fond (niveau projet)
  - `projects/{id}/ambientSound` — son d'ambiance (niveau projet)
  - `projects/{id}/sceneBackground` — arrière-plan scène (image ou vidéo, derrière le perso)
  - `projects/{id}/sceneForeground` — avant-plan scène (PNG transparent, devant le perso)
  - `projects/{id}/animations/{animId}/video` — vidéo animation
  - `projects/{id}/animations/{animId}/contourOriginKeyframes.json`
  - `projects/{id}/animations/{animId}/contourOriginFrames.json`
  - `projects/{id}/animations/{animId}/contourAnchorKeyframes.json`
  - `projects/{id}/animations/{animId}/contourAnchorFrames.json`
  - `projects/{id}/animations/{animId}/contourSubdivisionFrames.json`
  - `projects/{id}/animations/{animId}/contourCannyFrames.json`
  - `projects/{id}/animations/{animId}/anchorKeyframes.json`
  - `projects/{id}/animations/{animId}/anchorFrames.json`
  - `projects/{id}/animations/{animId}/boneWeights.json`
  - `projects/{id}/animations/{animId}/videoFramesMesh.json`
  - `scans/{id}/scanImage` — image rectifiée

### Migration legacy

Les projets existants (sans `animations` au root, avec `mesh`/`hasVideo` directement) sont automatiquement migrés en mémoire : une animation rest est créée avec les données existantes. Les anciens chemins Storage sont lus tels quels. À la prochaine sauvegarde, le nouveau format est écrit.

### Upload Hints

```typescript
UploadHint = 'image' | 'backgroundVideo' | 'ambientSound'
  | 'sceneBackground' | 'sceneForeground'
  | { animationId: string; field: AnimationUploadField }
  | { speakSoundId: string } | { deleteSpeakSoundId: string }
StepUploadHint = string  // champ simple pour les steps (scopé par AdminPage)
```

## Cloud Function — LaMa Inpainting

**Répertoire** : `functions/` (Python 3.11, `simple-lama-inpainting`)

**URL** : `https://lama-inpaint-6gzhik6pka-ew.a.run.app` (configurable via `VITE_LAMA_FUNCTION_URL`)

**Spécifications** : gen2, 2 CPU, 2GB RAM, timeout 120s, concurrency 1, min-instances 0

**Protocole** :
- `GET /` → health check (déclenche cold start)
- `POST /` → `{ image: base64, mask: base64 }` → `{ inpainted: base64 JPEG }`

**Pipeline scan** : après correction perspective, le client génère un masque binaire (zones pattes Bézier dilatées 8px via `limbMaskGenerator.ts`), downscale à 512px, envoie à la Cloud Function. Le résultat est upscalé aux dimensions originales et utilisé comme texture pour les hidden face meshes uniquement.

**Deploy** :
```bash
gcloud functions deploy lama-inpaint \
  --gen2 --runtime python311 --trigger-http --allow-unauthenticated \
  --memory 2048MB --cpu 2 --timeout 120s --concurrency 1 \
  --min-instances 0 --max-instances 3 \
  --source functions/ --entry-point lama_inpaint \
  --project coloriage-anime-prod --region europe-west1
```

## Cloud Function — SAM 2 (segmentation vidéo par zone)

**Répertoire** : `sam2/` (Python 3.11, PyTorch + Meta SAM 2 Hiera Tiny via `git+facebookresearch/sam2`)

**URL** : `https://sam2-segment-6gzhik6pka-ew.a.run.app` (configurable via `VITE_SAM2_FUNCTION_URL`)

**Spécifications** : gen2, 4 CPU, 16GB RAM, timeout 540s, concurrency 1, min-instances 0

**Protocole** :
- `GET /` → health check (déclenche cold start, télécharge le checkpoint ~150 MB depuis HuggingFace au premier appel)
- `POST /` → `{ video: base64-MP4, zones: [{ id: string, prompts: [{x, y, label: 0|1}] }] }` → `{ masks: { zoneId: RLEMask[] }, videoWidth, videoHeight, numFrames }`
- `RLEMask = { size: [H, W], counts: [int] }` — format COCO uncompressed JSON-friendly, alterné bg/fg run lengths starting with bg (column-major)

**Usage** : segmentation vidéo native pour le pipeline `members-bones` (étape 2 "Définir Zones"). Le client envoie la vidéo entière + des prompts SAM 2 (1-3 clics par zone) sur la frame 0. Le serveur charge SAM 2 Hiera Tiny (cache instance après cold start), décode la vidéo via OpenCV, init `predictor.init_state(video_path)`, ajoute les prompts via `add_new_points_or_box(frame_idx=0, obj_id, points, labels)`, propage avec `propagate_in_video()`, encode chaque masque binaire en RLE COCO uncompressed via `encode_rle_uncompressed()` (pure Python, JSON-friendly).

**Limites** : max 50 MB par vidéo (HTTP 413), max 300 frames (cap CPU), max 5 zones. Cold start ~3-5 min (download model + init). Inference CPU ~30-90s pour vidéo courte.

**Côté client** : `src/utils/sam2Segmentation.ts` (wrapper REST) + `src/utils/rleMask.ts` (decode/pointInMask/clampPointToMask/`decodeRLEMinusRLEs` pour soustraction body−pattes) + `src/utils/sam2Contour.ts` (`rleToContour` via worker `cv.findContours`, `smoothPolygonGaussian` 1D cyclique, `bridgeContourAtLegs` pour sauter les portions du contour body longeant les pattes, `temporalSmoothContours` pour le lissage frame-à-frame, `pointToArcLength`/`arcLengthToPoint` pour la projection curviligne). Les contours lissés alimentent les 5 étapes par zone (`MembersBonesContour*Step.tsx`) qui réutilisent les utilitaires curvilignes du pipeline rest (`curvilinearContour.ts`, `curvatureScaleSpace.ts`, `contourSpatialIndex.ts`).

**Deploy** :
```bash
gcloud functions deploy sam2-segment \
  --gen2 --runtime python311 --trigger-http --allow-unauthenticated \
  --memory 16384MB --cpu 4 --timeout 540s --concurrency 1 \
  --min-instances 0 --max-instances 2 \
  --source sam2/ --entry-point sam2_segment \
  --project coloriage-anime-prod --region europe-west1
```

## Serveur local SAM 2 MPS (Mac Apple Silicon)

La Cloud Function SAM 2 en CPU est **trop lente** pour des vidéos > ~30 frames (la propagation SAM 2 sur 145 frames × 5 zones prend ~55 min en CPU et dépasse le timeout 9 min). Pour les sessions admin sur Mac M2/M3, on dispose d'un **serveur Flask local** qui expose la **même API REST** et utilise **PyTorch MPS** (GPU Metal) pour un speedup ~5-15× : `sam2-local/server.py` (port 8765).

**Architecture** :
- Helpers Python partagés dans `sam2/_common.py` (decode video, validation, run_inference). La Cloud Function et le serveur local importent les mêmes fonctions — refactor zero-coût.
- Vite proxy (`vite.config.ts`) forwarde `https://localhost:5174/api/sam2/*` → `http://127.0.0.1:8765/*` (évite mixed-content puisque Vite est en HTTPS via basicSsl).
- Le client TypeScript (`sam2Segmentation.ts`) bascule cloud ↔ local via la variable d'env Vite `VITE_SAM2_FUNCTION_URL` — le code REST est inchangé.

**Bascule local ↔ cloud** : créer/éditer `.env.local` à la racine du projet puis **redémarrer Vite** (`npm run dev`, Vite ne hot-reload pas les env vars) :
```
VITE_SAM2_FUNCTION_URL=/api/sam2/
```
Pour repasser au cloud : commenter ou supprimer cette ligne et redémarrer Vite. La Cloud Function reste déployée comme fallback et pour les autres devs.

**Setup et lancement** : voir `sam2-local/README.md`. Le pipeline admin (`MembersBonesZonesStep.tsx`) intègre un composant `LocalServerHelp.tsx` qui affiche les commandes shell prêtes à copier-coller (cliquer sur "Serveur SAM 2 local pas démarré ?").

**MPS troubleshooting** : SAM 2 utilise des opérations transformer attention dont certaines ne sont pas implémentées sur MPS. Mitigation : variable d'env `PYTORCH_ENABLE_MPS_FALLBACK=1` (fallback CPU silencieux pour les ops manquantes), ou flag `--device cpu` au lancement du serveur.

## Conventions

- Tout le traitement lourd (OpenCV) tourne dans un Web Worker
- Communication Worker via messages typés avec pattern RPC (perspectiveCorrection.ts)
- Le maillage est toujours stocké en coordonnées image
- FPS cible : 24 images/seconde
- Résolution de sortie perspective : 2048×2048
- Les triangles Firestore sont sérialisés en objets `{a, b, c}` (limitation arrays imbriqués)
- Les points sont indexés : contourAnchors 0..A-1, contourSubdivision A..A+S-1, anchorPoints A+S..A+S+M-1, internals après
- Les pixels retournés par OpenCV `findContours` sont déjà ordonnés — `orderContourPixels()` n'est plus nécessaire dans le pipeline normal
- Le cache `contourCannyFrames` (calculé étape 6) est propagé aux étapes 7 et 10 pour éviter la re-détection Canny
- **Frame 0 cohérence vidéo** : le tracking contour (étape 7) détecte le Canny sur la frame 0 de la vidéo (pas l'image statique) et snappe les anchors dessus. L'optical flow (étape 9) applique le snap-to-contour à frame 0 aussi. Le bone solver utilise `trackedFrames[0]` comme rest pose. Cela élimine le micro-décalage image statique vs vidéo frame 0.
- **Canvas éditables — pan/zoom obligatoires** : tout canvas où l'admin édite quelque chose (points, courbes, zones, bones, masques…) doit exposer un viewport pan/zoom. Convention :
  - **Molette** = zoom anchoré sur le curseur (listener `wheel` non-passif pour `preventDefault`).
  - **Espace maintenu + clic-glisser** = pan (curseur `grab` quand Espace est down, `grabbing` pendant le drag). Alt+clic et bouton du milieu acceptés en plus.
  - Bornes zoom typiques `[0.2, 8]`, fit-to-container au montage, bouton « Réinit. vue » + raccourci **Cmd/Ctrl+0**.
  - Implémentation : appliquer la transformation via `ctx.setTransform(k, 0, 0, k, panX, panY)` avec `k = baseScale * zoom` (coords image partout dans la logique métier), et diviser les épaisseurs/rayons d'écran par `k` pour qu'ils restent constants visuellement. Hit-tests en coords image avec rayon `pxScreen / k`.
  - Référence d'implémentation : `apps/admin/src/pages/admin/EyesSection.tsx`.

## Commandes

```bash
npm run dev      # Serveur dev HTTPS (Vite, host: true pour accès réseau)
npm run build    # Build production (tsc + vite)
npm run lint     # ESLint
npm run preview  # Preview build
```
