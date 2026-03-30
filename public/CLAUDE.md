# Coloriage Animé - Documentation complète pour brainstorm

## Vision du projet

Application web qui transforme un coloriage papier en animation interactive. L'utilisateur (admin) prépare un projet avec une image de coloriage et des animations. L'utilisateur final imprime le coloriage, le colorie, le scanne avec son téléphone, et voit son dessin prendre vie avec ses propres couleurs injectées dans un maillage triangulé animé.

---

## Parcours utilisateur complet

### Côté Admin (création du projet)

1. **Import** : L'admin importe une image de coloriage (PNG/JPEG), optionnellement une vidéo de fond et un son d'ambiance
2. **Pipeline 10 étapes** : Il configure le tracking vidéo et la triangulation sur l'animation principale ("rest")
3. **Multi-animations** : Il peut ajouter des animations oneshot (déclenchées à la demande) et des animations physics (procédurales par code JS)
4. **PDF** : Il génère un PDF imprimable avec l'image + marqueurs L aux 4 coins (pour la détection au scan)

### Côté Utilisateur final (scan + animation)

1. **Impression** : L'utilisateur imprime le PDF du coloriage
2. **Coloriage** : Il colorie le dessin avec ses crayons/feutres
3. **Scan caméra** : Il ouvre la page scan sur son téléphone, la caméra détecte les 4 marqueurs L
4. **Ajustement coins** : Repositionnement manuel des coins si nécessaire
5. **Correction perspective** : Homographie OpenCV → image rectifiée (2048×2048 → crop marges → resize)
6. **Animation** : Le maillage triangulé s'anime en temps réel avec PIXI.js, texturé avec les couleurs du coloriage scanné

---

## Architecture technique

### Stack

| Couche | Technologie |
|--------|------------|
| Framework UI | React 19 + TypeScript strict |
| Routing | React Router 7 (3 routes : `/`, `/admin/:id`, `/scan/:id`) |
| Base de données | Firebase (Firestore + Cloud Storage) |
| Géométrie maillage | Delaunator (triangulation de Delaunay) |
| Rendu graphique | PIXI.js 7 (WebGL 2D) |
| Vision par ordinateur | OpenCV.js dans Web Worker |
| Build | Vite 7 |
| PDF | jsPDF |

### Routes

- `/` → HomePage : liste et création de projets
- `/admin/:projectId` → AdminPage : workflow admin 10 étapes + preview split-panel
- `/scan/:projectId` → ScanPage : scan caméra + animation temps réel

### Structure des fichiers

```
src/
├── types/project.ts            Types centraux (Point2D, Animation, MeshData, Project, Scan)
├── db/
│   ├── firebase.ts             Init Firebase
│   ├── projectsStore.ts        CRUD projets (Firestore + Storage)
│   └── scansStore.ts           CRUD scans
├── hooks/useProject.ts         Hook chargement/sauvegarde projet
├── pages/
│   ├── HomePage.tsx            Liste projets
│   ├── AdminPage.tsx           Orchestrateur admin (steps + animations + preview)
│   └── ScanPage.tsx            Machine d'états scan (camera → adjust → processing → animation)
├── components/
│   ├── admin/                  Composants des 10 étapes + AnimationManager + AdminPreview + PhysicsAnimationEditor
│   ├── keyframes/              Éditeur de keyframes (timeline + canvas)
│   ├── triangulation/          Éditeur maillage (canvas + interactions)
│   └── scan/                   Composants scan (CameraView, CornerAdjustment, ScanProcessor, AnimationPlayer)
├── utils/                      Logique métier pure (voir section dédiée)
└── styles/global.css           Design system CSS variables
```

---

## Modèle de données

### Project

```typescript
Project {
  id, name, createdAt
  originalImageBlob: Blob | null     // Image coloriage (niveau projet, partagée)
  backgroundVideoBlob: Blob | null   // Vidéo fond (optionnelle, boucle en arrière-plan)
  ambientSoundBlob: Blob | null      // Son d'ambiance (optionnel, boucle continue)
  ambientSoundEnabled: boolean
  animations: Animation[]            // 1 rest + 0..N oneshots + 0..N physics
  markers: MarkerCorners | null      // 4 coins marqueurs L pour le scan
}
```

### Animation

```typescript
type AnimationType = 'rest' | 'oneshot' | 'physics'

Animation {
  id: string
  name: string
  type: AnimationType
  videoBlob: Blob | null          // Vidéo propre (rest/oneshot), null pour physics
  mesh: MeshData | null           // Données du pipeline (géométrie + tracking + frames calculées)
  physicsCode: string | null      // Code JS pour physics animations
  physicsDuration: number | null  // Durée en secondes (défaut 2)
  physicsOverlay: boolean         // Si true, se superpose à la rest loop (déplacements additifs)
  audioBlob: Blob | null          // Son spécifique à cette animation
  audioEnabled: boolean
}
```

### MeshData (le coeur du système)

Le `MeshData` contient toutes les données du pipeline de tracking et triangulation :

```typescript
MeshData {
  // Étape 2 : Paramètres de détection de contour Canny
  cannyParams: { lowThreshold, highThreshold, blurSize }

  // Étape 3 : Point d'origine P0 (définit s=0 du repère curviligne)
  contourOrigin: Point2D

  // Étape 4 : Tracking de P0 frame par frame (optical flow + snap Canny)
  contourOriginFrames: Point2D[][]     // position de P0 à chaque frame vidéo

  // Étape 5 : 4-5 points caractéristiques sur le contour externe
  contourAnchors: Point2D[]

  // Étape 6 : Points intermédiaires entre anchors (coordonnées curvilignes)
  contourSubdivisionPoints: Point2D[]
  contourSubdivisionParams: CurvilinearParam[]  // {segmentIndex, t} — position relative normalisée
  contourSubdivisionFrames: Point2D[][]          // recalculé par frame via contour Canny

  // Cache : contours Canny ordonnés par frame (évite la re-détection)
  contourCannyFrames: Point2D[][]

  // Étape 7 : Tracking des anchors contour frame par frame
  contourAnchorFrames: Point2D[][]

  // Étape 8 : Points features intérieurs (yeux, ailes, etc.)
  anchorPoints: Point2D[]

  // Étape 9 : Tracking des anchors internes (optical flow + keyframes)
  anchorFrames: Point2D[][]

  // Étape 10 : Triangulation + calcul animation finale
  internalPoints: Point2D[]                      // Points de remplissage (non trackés)
  triangles: [number,number,number][]            // Indices Delaunay dans allPoints
  trackedTriangles: [number,number,number][]     // Delaunay sur les seuls points trackés
  internalBarycentrics: BarycentricRef[]         // Coordonnées barycentriques des points internes
  videoFramesMesh: Point2D[][]                   // SORTIE FINALE : positions de tous les points par frame
}
```

---

## Le pipeline de triangulation et tracking (détail)

### Concept fondamental : "contour-first" avec coordonnées curvilignes

Le pipeline repose sur une idée centrale : **séparer les points du contour externe (trackés sur le bord Canny) des points internes (trackés par optical flow classique)**. Les points de contour sont repositionnés à chaque frame en utilisant le contour Canny détecté comme guide.

### Les 3 types de points du maillage

```
allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
```

1. **Contour Anchors** (4-20 points) : Points caractéristiques sur le bord externe (extrema de courbure). P0 est toujours le premier. Trackés par placement curviligne + snap sur extrema de courbure CSS (pas d'optical flow).

2. **Contour Subdivision** (N points) : Points intermédiaires entre anchors, recalculés à chaque frame via coordonnées curvilignes sur le contour Canny détecté. Pas d'optical flow — leur position est déterministe.

3. **Anchor Points** (points intérieurs) : Features internes comme les yeux, les ailes, etc. Trackés par optical flow Lucas-Kanade avec contraintes anti-saut et voisinage.

4. **Internal Points** (remplissage) : Points additionnels pour densifier le maillage. **Jamais trackés** — ils suivent les points trackés via déformation ARAP (As-Rigid-As-Possible).

### Étape par étape

#### Étape 1 : Import vidéo (`ImportStep.tsx`)
Upload de la vidéo d'animation MP4/WebM (l'image est importée au niveau projet dans `ProjectImportSection`). Pour les oneshots, section additionnelle pour un son optionnel (MP3/WAV/OGG) avec toggle activé/désactivé.

#### Étape 2 : Validation Canny (`CannyValidationStep.tsx`)
Prérequis : vidéo + image importées.

Preview du contour externe détecté par Canny sur la vidéo, frame par frame. Pipeline Worker : Canny → dilate + close → floodFill → findContours(RETR_EXTERNAL) → plus grand contour.

- Lecteur vidéo : play/pause + slider frame par frame (24 FPS)
- Overlay : contour externe jaune épais (5px)
- 3 sliders : seuil bas (10-200, défaut 50), seuil haut (50-400, défaut 150), taille blur (3/5/7, défaut 5)
- Compteur de points du contour
- Canny non calculé pendant la lecture (trop lent), recalculé à la pause
- "Valider" → sauvegarde `mesh.cannyParams`, initialise le MeshData si absent
- Si la géométrie partagée existe déjà (oneshot), seul le tracking est réinitialisé ; sinon tout est reset

#### Étape 3 : Point 0 Contour (`ContourOriginStep.tsx`)
Prérequis : Canny validé.

L'admin place un point d'origine P0 sur le contour Canny de l'image originale. Ce point définit le `s=0` du repère curviligne.

- Détection Canny sur l'image originale au montage, overlay jaune
- Clic gauche ou drag pour placer/déplacer P0, **auto-snap Canny** (rayon 30px via `ContourSpatialIndex`)
- Clic droit pour supprimer P0
- Point fantôme (ghost) sous le curseur montrant la position snappée
- Canvas avec zoom (molette) et pan (espace+glisser)
- "Sauvegarder" → `mesh.contourOrigin`, reset complet en aval (anchors, subdivision, tracking, topologie)

#### Étape 4 : Tracking P0 (`ContourOriginTrackingStep.tsx`)
Prérequis : P0 défini (étape 3).

Tracke P0 sur toutes les frames vidéo par optical flow + snap-to-contour Canny.

**Phases :**
1. **Config** : bouton "Lancer le tracking"
2. **Tracking** : `precomputeOpticalFlow` sur `[contourOrigin]` (1 seul point), contraintes anti-saut + snap-to-contour activées
3. **Editing** : édition frame par frame avec `KeyframeEditor` + `FrameNavigator`. Propagation forward/backward/bidi par re-tracking de segments (`trackSegment`). Snap Canny en édition (rayon 30px).
4. **Validated** : sauvegarde `contourOriginKeyframes`, `contourOriginFrames` (interpolés via `propagateKeyframes`), `contourOriginTrackingValidated = true`

Post-traitement à la validation : snap sur Canny toutes les 5 frames (échantillonné pour les performances).

#### Étape 5 : Anchors Contour (`ContourAnchorsStep.tsx`)
Prérequis : P0 tracké (étape 4) + Canny validé.

L'admin place des points caractéristiques sur le contour (bout d'aile, pli, sommet). **P0 est automatiquement inclus comme premier anchor** à la sauvegarde — l'admin ne voit et ne place que les anchors supplémentaires.

- Détection Canny sur l'image originale, overlay jaune
- **Auto-snap unbounded** : chaque clic/drag est snappé au pixel Canny le plus proche (sans limite de distance, via `nearestUnbounded`)
- **Auto-détection par courbure** : bouton "Auto-détecter" qui utilise `detectCurvatureExtrema` pour trouver les N points de plus forte courbure (single-scale). Candidats trop proches de P0 (< 20px) filtrés. Slider nombre de points (4-20).
- **Tri par ordre contour** : les anchors sont automatiquement triés par position le long du contour ordonné (`computeInitialAnchorArcLengths`)
- Clic droit = supprimer, drag = déplacer (re-snappé + re-trié)
- Candidats CSS affichés en orange (cercles dont la taille/opacité reflète le score de courbure)
- "Sauvegarder" → `mesh.contourAnchors` (= [P0, ...anchors]), reset en aval (subdivision, tracking contour, topologie)

#### Étape 6 : Subdivision Contour (`ContourSubdivisionStep.tsx`)
Prérequis : anchors contour définis (étape 5) + Canny validé.

Définit les points intermédiaires entre anchors. **Placement statique seulement** (frame 0 sur l'image) — le calcul par frame est fait à l'étape 10.

- Détection Canny sur l'image originale, réordonnancement depuis P0 via `reorderContourFromOrigin`
- `subdivideContour()` génère N points uniformes par segment anchor (en arc-length)
- **Compteur par segment** : +/− individuel pour chaque segment [anchor_i → anchor_{i+1}], défaut 3 par segment
- **Compteur global** : +/− pour tous les segments simultanément
- Clic sur un segment = surbrillance verte
- Bouton "Recalculer preview contour" pour forcer la re-détection Canny
- "Sauvegarder" → `mesh.contourSubdivisionPoints`, `mesh.contourSubdivisionParams` (les `{segmentIndex, t}`)
- Ne sauvegarde PAS de frames — les `contourSubdivisionFrames` sont calculées à l'étape 10

#### Étape 7 : Tracking Contour (`ContourTrackingStep.tsx`)
Prérequis : subdivision définie (étape 6) + Canny validé + P0 tracké + vidéo importée.

**Pas d'optical flow.** Le tracking contour est purement géométrique et déterministe :

1. Obtenir contour Canny de chaque frame (cache `contourCannyFrames` de l'étape 6, ou détection live)
2. Si live : convertir pixels vidéo → coords image, réordonner depuis P0
3. Assurer une orientation cohérente du contour (`ensureConsistentOrientation` vs frame 0)
4. Construire `ContourSpatialIndex` pour recherche rapide
5. Calculer arc-lengths normalisés du contour
6. Détecter les **extrema de courbure globaux** (`detectGlobalCurvatureExtrema`, top 20)
7. Pour chaque anchor :
   a. **Position brute** = `interpolateAtArcLength(ordered, arcLengths, anchorS[a])`
   b. **Snap extremum** = l'extremum dont la distance d'arc circulaire à `anchorS[a]` est minimale
   c. Position = position de l'extremum snappé
   d. Si aucun extremum (contour Canny vide) → anchor marqué "lost", fallback position brute
8. **Re-snap Canny** : snap final de chaque anchor non-lost sur le pixel Canny le plus proche (rayon 50px via `ContourSpatialIndex.nearestWithIndex`)
9. Mode "proche en proche" : mise à jour des `anchorS` depuis la position snappée

**Deux modes :**
- **"s fixe"** : coordonnées curvilignes constantes entre frames (anchorS ne change jamais)
- **"proche en proche"** (step-by-step) : anchorS mis à jour après chaque snap, permet de suivre des déformations plus importantes

**Phase preview :** drag pour corriger un anchor, bouton "Propager avant" pour re-calculer depuis la frame éditée. Toggle "Snap extrema courbure" pour activer/désactiver le snap en édition manuelle. Preview du contour complet (anchors + subdivision) via `computeAllSubdivisionFrames`.

**Phase validée :** deux boutons — "Reediter frame par frame" (reprend l'édition sans perte) et "Reinitialiser depuis zero" (reset complet).

#### Étape 8 : Ancres Internes (`AnchorPointsStep.tsx`)
Prérequis : tracking contour validé (étape 7).

L'admin place des points features à l'intérieur du contour (yeux, centre des ailes, articulations...).

- Contour complet `[...contourAnchors, ...contourSubdivisionPoints]` affiché en overlay lecture seule (bleu)
- **Auto-détection** : bouton "Auto-détecter ancres" qui utilise `generateAutoMesh` (contour Canny + grille interne filtrée par point-in-polygon). Slider densité 1-10.
- Clic gauche = ajouter, drag = déplacer, clic droit = supprimer
- "Sauvegarder" → `mesh.anchorPoints`, reset en aval (tracking ancres, topologie)

#### Étape 9 : Tracking Ancres Internes (`AnchorTrackingStep.tsx`)
Prérequis : tracking contour validé + ancres définies.

Optical flow Lucas-Kanade sur les ancres internes. **Contraintes hardcodées** (pas configurable par l'UI) :
- **Anti-saut** : activé (clamp déplacement max)
- **Consensus voisins** : activé (topologie simple : triangles chaînés `[i, i+1, i+2]`)
- **Lissage temporel** : désactivé
- **Détection outliers** : désactivé

**Phases** (identiques à l'étape 4) :
1. **Config** : bouton "Lancer le tracking"
2. **Tracking** : `precomputeOpticalFlow` sur les `anchorPoints`
3. **Editing** : édition frame par frame avec `KeyframeEditor`, propagation forward/backward/bidi par `trackSegment`
4. **Validated** : sauvegarde `anchorKeyframes`, `anchorFrames` (interpolés), `anchorTrackingValidated = true`

#### Étape 10 : Triangulation + Animation finale (`TriangulationStep.tsx`)
Prérequis : tracking contour validé. Tracking ancres optionnel (si absent, les ancres gardent leur position initiale pour toutes les frames).

**Partie 1 — Triangulation et topologie :**
- Points trackés en lecture seule = `[...contourAnchors, ...anchorPoints]`
- Contour complet = `[...contourAnchors, ...contourSubdivisionPoints]` (polygone pour filtrage)
- L'admin ajoute des **points internes** : auto-grille via `generateAutoMesh` (densité 1-10) ou placement manuel
- Delaunay sur `allBasePoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints]` + les internes ajoutés
- Filtrage : seuls les triangles dont le centroïde est dans le polygone contour
- **"Verrouiller la topologie"** :
  1. Delaunay sur les points trackés seuls → `trackedTriangles`
  2. `computeAllBarycentrics(internalPoints, trackedPoints, trackedTriangles)` → `internalBarycentrics`
  3. `topologyLocked = true`
- **"Déverrouiller"** : supprime `trackedTriangles`, `internalBarycentrics`, `videoFramesMesh`

**Partie 2 — Calcul de l'animation (ARAP) :**

Le bouton "Calculer Animation" utilise la déformation **ARAP (As-Rigid-As-Possible)** pour positionner les points internes :

1. Si `contourSubdivisionFrames` non disponibles : recalcul via `computeAllSubdivisionFrames` (utilise le cache `contourCannyFrames` si dispo, sinon charge le Worker OpenCV)
2. Pose de repos = positions frame 0 de `allPoints` (positions originales du maillage, pas les positions trackées frame 0)
3. Points pinnés = tous sauf les `internalPoints` (contourAnchors + subdivision + anchorPoints)
4. `precomputeARAP(allPoints0, triangles, pinnedIndices)` — poids cotangent + factorisation Cholesky une seule fois
5. Pour chaque frame : assembler les positions pinnées `[...contourAnchorFrames[f], ...subPositions, ...(anchorFrames[f] ?? anchorPoints)]`
6. `batchSolveARAP(system, pinnedFrames)` — résolution itérative par frame (étape locale : rotation polaire par sommet, étape globale : résolution Cholesky)
7. Résultat : positions des internes qui minimisent la distorsion locale du maillage
8. Lissage temporel optionnel (`applyTemporalSmoothing`, fenêtre configurable, défaut 3)

Note : une méthode par barycentrics (`handleComputeAnimation`) existe encore dans le code mais n'est plus exposée dans l'UI. L'ARAP produit des résultats supérieurs car il préserve la rigidité locale des triangles au lieu de simplement interpoler linéairement.

**Preview animation :**
- 3 modes d'affichage : **vidéo** (wireframe vert sur vidéo), **wireframe** (sur fond sombre), **gradient** (triangles colorés par position HSL du centroïde)
- Loop seamless via `LoopPlayback` avec **crossfade configurable** (slider 0-20 frames, défaut 7)
- Play/pause + slider frame + rewind
- Vertices colorés par catégorie : rouge (contour anchors), jaune (subdivision), cyan (anchors internes), blanc (internes)

**Résultat** : un tableau `videoFramesMesh` de `Point2D[][]` (positions de tous les points par frame), sauvegardé en Storage.

### Pourquoi ARAP plutôt que les barycentrics ?

Les coordonnées barycentriques (interpolation linéaire dans un triangle) ont été la première approche mais produisaient des artefacts : quand un triangle se déforme fortement, l'interpolation linéaire cause de la distorsion visible (étirement, cisaillement).

**ARAP (As-Rigid-As-Possible)** résout ce problème en minimisant la distorsion locale. Pour chaque sommet, l'algorithme :
1. **Étape locale** : trouve la rotation rigide qui approxime le mieux la déformation des arêtes adjacentes (décomposition polaire de la matrice covariance 2×2)
2. **Étape globale** : résout un système linéaire (Cholesky pré-factorisé) pour trouver les positions des points libres qui respectent au mieux ces rotations locales + les contraintes des points pinnés

Résultat : les triangles du maillage conservent leur forme autant que possible, les déformations sont réparties uniformément, pas d'effondrement local.

Les coordonnées barycentriques restent utilisées dans le **verrouillage de topologie** (`computeAllBarycentrics`) pour établir la correspondance point interne ↔ triangle, mais le calcul d'animation utilise ARAP.

---

## Système multi-animation

### 3 types d'animations

| Type | Vidéo | Tracking | Géométrie | Pipeline |
|------|-------|----------|-----------|----------|
| **Rest** | Oui | Complet (10 étapes) | Définit la géométrie de référence | Complet |
| **Oneshot** | Oui | Réduit (6 étapes) | Héritée de rest | Tracking seul |
| **Physics** | Non | Non | Héritée de rest | Code JS → frames pré-calculées |

### Topologie partagée

La géométrie (contourAnchors, subdivisionPoints, anchorPoints, internalPoints, triangles, barycentrics) est définie **uniquement** sur l'animation rest. Les oneshots et physics héritent de cette géométrie. Si la géométrie rest change, le tracking des oneshots est invalidé et les frames physics sont effacées.

### Adapter pattern

Les composants des étapes (step components) ne connaissent pas le multi-animation. `AdminPage` construit un `ProjectStepView` (vue aplatie avec videoBlob et mesh de l'animation sélectionnée) et intercepte le save pour merger les modifications dans la bonne animation du projet.

### Physics animations

L'admin écrit du code JavaScript qui transforme les vertices du maillage. Le code a accès à :
- `frame` : numéro de frame courant
- `totalFrames` : nombre total de frames
- `points` : positions des points (copiées depuis frame 0)
- `t` : progression normalisée [0, 1]

Les frames sont **pré-calculées** à la validation et stockées dans `videoFramesMesh`, ce qui les rend identiques aux oneshots pour le playback.

Option **overlay** : si activée, l'animation physics se superpose instantanément à la rest loop (les déplacements sont additifs par rapport à la position de repos).

---

## Machine d'états du playback

### 5 états

```
rest → (requestOneshot) → wait → (loop point détecté) → trans-out → (blend N frames) → oneshot → (fin) → trans-in → (blend N frames) → rest
```

| État | Comportement |
|------|-------------|
| `rest` | Animation rest en boucle infinie avec crossfade seamless |
| `wait` | Rest continue, attend que le curseur revienne au début du cycle |
| `trans-out` | Blend smoothstep (7 frames) : dernières positions rest → frame 0 du oneshot |
| `oneshot` | Lecture linéaire du oneshot (pas de loop) |
| `trans-in` | Blend smoothstep (7 frames) : dernière frame oneshot → frame 0 rest |

### Loop seamless (rest)

Le `LoopPlayback` implémente un crossfade des N dernières frames avec les N premières :
- La longueur effective de la boucle est `totalFrames - crossfadeN`
- Dans la zone de crossfade (frames 0 à N), chaque frame est un blend smoothstep entre la frame "tail" correspondante et la frame "primary"
- Résultat : pas de saut visible au point de bouclage

### Overlay (physics)

Les animations marquées overlay démarrent **immédiatement** (pas de wait/transition). Elles avancent en parallèle de l'état principal. Le displacement est calculé comme :
```
position_finale = position_courante + (position_overlay_frame_i - position_overlay_frame_0)
```

---

## Le scan et le rendu final

### Pipeline scan

1. **Caméra** : détection temps réel des marqueurs L aux 4 coins
2. **Ajustement** : l'utilisateur repositionne manuellement les coins si nécessaire
3. **Perspective** : homographie OpenCV dans un Web Worker → image 2048×2048 → crop marges 64px → resize aux dimensions originales
4. **Debug** : visualisation des 4 étapes (photo brute, 2048 avec marges, croppée, overlay mesh)
5. **Animation** : rendu PIXI.js du maillage texturé animé

### Rendu PIXI.js (AnimationPlayer)

1. L'image scannée et rectifiée est utilisée comme **texture**
2. Les coordonnées UV sont calculées pour mapper chaque triangle du maillage sur la bonne zone de l'image
3. À chaque frame (24 FPS cible) :
   - `MultiAnimationPlayback.advance()` avance la machine d'états
   - `MultiAnimationPlayback.getPositions()` retourne les positions interpolées de tous les points
   - Les vertices du mesh PIXI sont mis à jour
   - Les effets physiques interactifs (magnétisation tactile) sont appliqués par-dessus
4. Le tout est affiché en plein écran en mode paysage forcé

### Effets interactifs

- **Magnétisation tactile** : quand l'utilisateur touche l'écran, le maillage se déforme vers le doigt. Direction globale (centroïde mesh → doigt), magnitude par vertex avec falloff doux. 4 paramètres réglables (force, rayon, concentration, vitesse de retour).
- **Parallax gyroscope** : DeviceOrientation API, offset normalisé [-1,1] avec lissage EMA, gestion portrait/paysage.
- **Effets visuels** : ombres, éclairage configurable.

---

## Systèmes de coordonnées

3 espaces coexistent :

1. **Image** : coordonnées de l'image originale (stockage du maillage, référence absolue)
2. **Vidéo** : coordonnées des frames vidéo (pendant l'optical flow et la détection Canny)
3. **Écran** : coordonnées canvas/PIXI (rendu avec DPI)

**Règle critique** : les positions des anchors sont toujours stockées en coordonnées image. Les pixels Canny détectés sur les frames vidéo doivent être convertis : `imgX = (videoX / videoWidth) * imageWidth`.

---

## Stockage Firebase

### Firestore
Métadonnées projet : nom, dates, `animations[]` avec les données mesh (sauf gros JSON).

### Cloud Storage
Chemins scopés par animation :
```
projects/{id}/originalImage            — image coloriage
projects/{id}/backgroundVideo          — vidéo fond
projects/{id}/ambientSound             — son d'ambiance
projects/{id}/animations/{animId}/video
projects/{id}/animations/{animId}/contourOriginFrames.json
projects/{id}/animations/{animId}/contourAnchorFrames.json
projects/{id}/animations/{animId}/contourSubdivisionFrames.json
projects/{id}/animations/{animId}/contourCannyFrames.json
projects/{id}/animations/{animId}/anchorFrames.json
projects/{id}/animations/{animId}/videoFramesMesh.json
scans/{id}/scanImage                   — image rectifiée
```

---

## Utilitaires clés

| Module | Rôle |
|--------|------|
| `barycentricUtils.ts` | Coordonnées barycentriques (calcul, recherche triangle, interpolation) |
| `curvilinearContour.ts` | Coordonnées curvilignes sur contour Canny (subdivision, calcul par frame) |
| `curvatureScaleSpace.ts` | Détection extrema de courbure multi-échelle + tracking frame par frame |
| `opticalFlowComputer.ts` | Pipeline extraction frames + tracking + re-tracking par segment |
| `trackingConstraints.ts` | 7 couches de stabilisation du tracking (anti-saut, voisinage, contour, etc.) |
| `contourAnchorTracker.ts` | Raffinement hybride LK + template matching + snap contour (legacy, non utilisé dans le pipeline actuel) |
| `arapSolver.ts` | Déformation ARAP (As-Rigid-As-Possible) du maillage |
| `multiAnimationPlayback.ts` | Machine d'états playback (rest loop + oneshot transitions + overlay) |
| `loopPlayback.ts` | Loop seamless avec crossfade smoothstep configurable |
| `meshPhysicsEffects.ts` | Effets physiques interactifs (magnétisation tactile) |
| `deviceParallax.ts` | Wrapper DeviceOrientation API + lissage EMA + swap axes paysage |
| `textureExtractor.ts` | Calcul UVs pour PIXI (mapping texture scannée sur mesh) |
| `perspectiveCorrection.ts` | Bridge RPC vers le Web Worker OpenCV |
| `contourSpatialIndex.ts` | Index spatial bucket 2D pour snap-to-contour rapide |
| `optimalTransportSnap.ts` | Assignment optimal (Hongrois) pour snap contour robuste |

---

## Design system

CSS variables dans `global.css` :
- **Boutons** : `btn-primary` (bleu), `btn-secondary` (outlined), `btn-ghost`, `btn-icon`, `btn-danger`, tailles `btn-sm`/`btn-lg`
- **Tokens** : spacing (`--space-1` à `--space-8`), typography (`--text-xs` à `--text-2xl`), shadows, radius
- **Responsive** : breakpoints 480px, 768px, 1024px, 2000px
- **Pipeline stepper** : cercles connectés numérotés 1–10, 3 états (done ✓ vert, active ● bleu, pending ○ gris)

---

## Points d'architecture notables

1. **Tout le traitement lourd (OpenCV) tourne dans un Web Worker** — communication via messages typés avec pattern RPC
2. **FPS cible : 24 images/seconde** pour les animations, 30 FPS pour la preview admin
3. **La topologie du maillage est fixe** — seules les positions des vertices changent frame par frame
4. **Le cache `contourCannyFrames`** est calculé une fois (étape 6) et propagé aux étapes suivantes pour éviter la re-détection Canny (opération coûteuse)
5. **Migration legacy** : les anciens projets (sans `animations[]`) sont automatiquement migrés en mémoire avec une animation rest
6. **Orientation forcée paysage** sur la page scan (`screen.orientation.lock`)
7. **Preview admin** : split-panel redimensionnable avec PIXI.js léger, visible seulement quand la rest animation a un `videoFramesMesh` calculé
