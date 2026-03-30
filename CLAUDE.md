# Coloriage Animé - Triangulation Custom

Application web de livres de coloriage animés avec triangulation de maillage et suivi vidéo.

## Concept

L'utilisateur crée un projet avec une image de coloriage et **plusieurs animations** (une "rest" en boucle infinie + des "oneshot" déclenchées à la demande). L'admin définit des **anchor points** (points structurels trackés) sur l'image, puis un maillage triangulé avec des points internes. Le suivi optique est pré-calculé sur les anchors seuls, avec validation par keyframes. Les points internes suivent via coordonnées barycentriques. Toutes les animations partagent la même géométrie (topologie mesh) mais ont chacune leur propre vidéo et tracking. L'utilisateur final scanne son coloriage colorié, et l'app injecte ses couleurs dans le maillage animé via PIXI.js avec transitions fluides entre animations.

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

### Topologie partagée

La géométrie frame 0 (contourOrigin, contourAnchors, contourSubdivisionPoints, anchorPoints, internalPoints, triangles, trackedTriangles, internalBarycentrics) est définie sur la rest animation et **propagée** aux oneshots et physics. Si la géométrie rest change, le tracking des oneshots est invalidé et les frames pré-calculées des physics sont effacées.

### Adapter pattern

Les step components ne connaissent pas le multi-animation. `AdminPage` construit un `ProjectStepView` (projet + videoBlob/mesh de l'animation sélectionnée) et intercepte le save pour merger dans la bonne animation. Les physics animations utilisent un composant dédié (`PhysicsAnimationEditor`) qui reçoit directement le projet et l'animation.

### Import projet (ProjectImportSection)

Section dédiée au-dessus de la barre animations dans `AdminPage`. Carte avec 3 zones d'import :
- **Image coloriage** (PNG/JPEG) — obligatoire
- **Vidéo de fond** (MP4/WebM) — optionnelle, jouée en boucle en arrière-plan
- **Son d'ambiance** (MP3/WAV/OGG) — optionnel, joué en boucle continue dans le player, avec toggle activer/désactiver

Ces assets sont au **niveau projet** (partagés par toutes les animations). Le composant `ProjectImportSection.tsx` reçoit le `Project` directement et sauvegarde avec les hints `'image'`, `'backgroundVideo'`, `'ambientSound'`.

### Preview panel (AdminPreview)

Layout split-panel dans `AdminPage` : volet gauche (édition pipeline) + volet droit (preview live PIXI.js). La preview utilise l'image PNG originale comme texture (pas de scan). Affiche l'animation rest en boucle + boutons oneshot/physics + physique tactile + effets visuels.

- **Masquable** : bouton "Masquer/Afficher preview" dans le header
- **Redimensionnable** : barre de séparation draggable (15% à 60%), défaut ~1/3
- **Condition** : visible seulement quand la rest animation a un `videoFramesMesh` calculé
- **Responsive** : pleine largeur avec marges 5vw sur écrans 4K (>2000px) ; empilement vertical sous 1024px
- **Composant** : `AdminPreview.tsx` — PIXI.js léger (~320 lignes), FPS capé à 30, ResizeObserver, pas de fullscreen/parallax

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

## Workflow Scan (utilisateur final)

**Orientation forcée** : toute la page scan est en mode paysage. `screen.orientation.lock('landscape')` au montage de `ScanPage`, avec fallback CSS `transform: rotate(90deg)` en portrait.

**Layout animation** : plein écran fixe en `flex-direction: row` — canvas PIXI à gauche (`flex: 1`), sidebar paramètres à droite (220px).

1. **Caméra** — Détection temps réel des marqueurs L + analyse qualité
2. **Ajustement coins** — Repositionnement manuel des 4 coins
3. **Correction perspective** — Homographie OpenCV → image 2048×2048 → crop marges 64px → resize aux dimensions originales
4. **Debug** — Visualisation 4 étapes du pipeline (photo brute, 2048 avec marges, croppée, overlay mesh)
5. **Animation** — Rendu PIXI.js du maillage texturé animé à 24 FPS + parallax gyroscope + boutons oneshot

## Structure des fichiers

```
src/
├── main.tsx                    Point d'entrée
├── App.tsx                     Router
├── types/project.ts            Types (Point2D, Animation, AnimationType, ProjectStepView, MeshData, Project, Scan)
├── db/
│   ├── firebase.ts             Init Firebase
│   ├── projectsStore.ts        CRUD projets (Firestore + Storage)
│   └── scansStore.ts           CRUD scans
├── hooks/useProject.ts         Hook chargement/sauvegarde projet
├── pages/
│   ├── HomePage.tsx            Liste projets
│   ├── AdminPage.tsx           Onglets admin (10 étapes) + preview split-panel
│   └── ScanPage.tsx            Machine d'états scan
├── components/
│   ├── admin/                  Étapes admin (10 étapes + support + AnimationManager + AdminPreview + ProjectImportSection + PhysicsAnimationEditor)
│   ├── keyframes/              Éditeur de keyframes (timeline, éditeur canvas)
│   ├── triangulation/          Éditeur maillage (canvas, interactions, dessin)
│   └── scan/                   Composants scan (caméra, coins, processing, animation)
├── utils/
│   ├── autoMeshGenerator.ts    Détection contour + génération grille interne
│   ├── barycentricUtils.ts     Coordonnées barycentriques (calcul, recherche triangle, interpolation)
│   ├── geometry.ts             Point-in-polygon, distance, centroïde
│   ├── keyframePropagation.ts  Interpolation linéaire entre keyframes + extraction
│   ├── markerGenerator.ts      Dessin marqueurs L
│   ├── opticalFlowComputer.ts  Pipeline extraction frames + tracking + segment re-tracking
│   ├── trackingConstraints.ts  Contraintes voisinage + snap-to-contour + spring curviligne
│   ├── contourAnchorTracker.ts Raffinement hybride LK + template matching + snap contour
│   ├── curvilinearContour.ts   Coordonnées curvilignes sur contour Canny
│   ├── curvatureScaleSpace.ts  Détection extrema courbure CSS + tracking frame par frame
│   ├── arapSolver.ts           Déformation ARAP (As-Rigid-As-Possible) du maillage
│   ├── optimalTransportSnap.ts Assignment optimal (transport) pour snap contour robuste
│   ├── contourSpatialIndex.ts  Index spatial bucket 2D pour snap-to-contour
│   ├── perspectiveCorrection.ts Bridge Worker OpenCV (RPC)
│   ├── pdfGenerator.ts         Génération PDF
│   ├── pdfLayout.ts            Constantes layout A4 + calcul offset centroïde L-marker
│   ├── textureExtractor.ts     Calcul UVs pour PIXI
│   └── multiAnimationPlayback.ts Machine d'états playback multi-animation (rest loop + oneshot transitions + physics overlay)
└── styles/global.css
public/
├── opencv.js                   Bibliothèque OpenCV.js compilée
└── opencv-worker.js            Web Worker OpenCV (détection, flow, perspective)
```

## Modèle de données

```typescript
AnimationType = 'rest' | 'oneshot' | 'physics'

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

Project {
  id, name, createdAt
  originalImageBlob: Blob | null     // Image coloriage (niveau projet)
  backgroundVideoBlob: Blob | null   // Vidéo fond (niveau projet)
  ambientSoundBlob: Blob | null      // Son d'ambiance (niveau projet, boucle continue)
  ambientSoundEnabled: boolean       // Toggle activer/désactiver le son
  animations: Animation[]            // Exactement 1 rest + 0..N oneshots + 0..N physics
  markers: MarkerCorners | null      // 4 coins marqueurs L
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

  // Sortie finale (étape 10, consommé par AnimationPlayer)
  videoFramesMesh: Point2D[][] | null
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
  - `projects/{id}/animations/{animId}/video` — vidéo animation
  - `projects/{id}/animations/{animId}/contourOriginKeyframes.json`
  - `projects/{id}/animations/{animId}/contourOriginFrames.json`
  - `projects/{id}/animations/{animId}/contourAnchorKeyframes.json`
  - `projects/{id}/animations/{animId}/contourAnchorFrames.json`
  - `projects/{id}/animations/{animId}/contourSubdivisionFrames.json`
  - `projects/{id}/animations/{animId}/contourCannyFrames.json`
  - `projects/{id}/animations/{animId}/anchorKeyframes.json`
  - `projects/{id}/animations/{animId}/anchorFrames.json`
  - `projects/{id}/animations/{animId}/videoFramesMesh.json`
  - `scans/{id}/scanImage` — image rectifiée

### Migration legacy

Les projets existants (sans `animations` au root, avec `mesh`/`hasVideo` directement) sont automatiquement migrés en mémoire : une animation rest est créée avec les données existantes. Les anciens chemins Storage sont lus tels quels. À la prochaine sauvegarde, le nouveau format est écrit.

### Upload Hints

```typescript
UploadHint = 'image' | 'backgroundVideo' | 'ambientSound' | { animationId: string; field: AnimationUploadField }
StepUploadHint = string  // champ simple pour les steps (scopé par AdminPage)
```

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

## Commandes

```bash
npm run dev      # Serveur dev HTTPS (Vite, host: true pour accès réseau)
npm run build    # Build production (tsc + vite)
npm run lint     # ESLint
npm run preview  # Preview build
```
