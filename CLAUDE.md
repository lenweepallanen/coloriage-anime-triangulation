# Coloriage Animé - Triangulation Custom

Application web de livres de coloriage animés avec triangulation de maillage et suivi vidéo.

## Concept

L'utilisateur crée un projet avec une image de coloriage et une vidéo d'animation. L'admin définit des **anchor points** (points structurels trackés) sur l'image, puis un maillage triangulé avec des points internes. Le suivi optique est pré-calculé sur les anchors seuls, avec validation par keyframes. Les points internes suivent via coordonnées barycentriques. L'utilisateur final scanne son coloriage colorié, et l'app injecte ses couleurs dans le maillage animé via PIXI.js.

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

## Workflow Admin (10 étapes)

Pipeline "contour-first" avec coordonnées curvilignes. Un point d'origine P0 définit le s=0 du contour. Seuls 4-5 points caractéristiques du contour sont trackés par extrema de courbure CSS ; les points intermédiaires sont calculés déterministiquement par coordonnée curviligne sur le contour Canny détecté à chaque frame.

1. **Import** — Upload image PNG/JPEG + vidéo MP4/WebM
2. **Canny** — Preview contour externe Canny sur vidéo + réglage seuils
3. **Point 0 Contour** — Placement du point d'origine P0 sur le contour (définit s=0)
4. **Tracking Point 0** — Optical flow + snap-to-contour Canny sur P0 frame par frame
5. **Anchors Contour** — Placement 4-5 points caractéristiques sur le contour (auto-snap Canny)
6. **Subdivision** — Points intermédiaires entre anchors + calcul par frame via coordonnées curvilignes Canny
7. **Tracking Contour** — Placement déterministe par coordonnée curviligne normalisée + snap extrema courbure CSS
8. **Ancres Internes** — Placement points features intérieurs (contour en overlay lecture seule)
9. **Tracking Ancres** — Optical flow sur ancres internes + keyframes
10. **Triangulation** — Points internes + Delaunay + verrouillage topologie + PDF + animation finale

## Workflow Scan (utilisateur final)

1. **Caméra** — Détection temps réel des marqueurs L + analyse qualité
2. **Ajustement coins** — Repositionnement manuel des 4 coins
3. **Correction perspective** — Homographie OpenCV → image 2048×2048 → crop marges 64px → resize aux dimensions originales
4. **Debug** — Visualisation 4 étapes du pipeline (photo brute, 2048 avec marges, croppée, overlay mesh)
5. **Animation** — Rendu PIXI.js du maillage texturé animé à 24 FPS

## Structure des fichiers

```
src/
├── main.tsx                    Point d'entrée
├── App.tsx                     Router
├── types/project.ts            Types (Point2D, BarycentricRef, KeyframeData, MeshData, Project, Scan)
├── db/
│   ├── firebase.ts             Init Firebase
│   ├── projectsStore.ts        CRUD projets (Firestore + Storage)
│   └── scansStore.ts           CRUD scans
├── hooks/useProject.ts         Hook chargement/sauvegarde projet
├── pages/
│   ├── HomePage.tsx            Liste projets
│   ├── AdminPage.tsx           Onglets admin (10 étapes)
│   └── ScanPage.tsx            Machine d'états scan
├── components/
│   ├── admin/                  Étapes admin (10 étapes + support)
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
│   └── textureExtractor.ts     Calcul UVs pour PIXI
└── styles/global.css
public/
├── opencv.js                   Bibliothèque OpenCV.js compilée
└── opencv-worker.js            Web Worker OpenCV (détection, flow, perspective)
```

## Modèle de données

```typescript
Project {
  id, name, createdAt
  originalImageBlob: Blob | null     // Image coloriage
  videoBlob: Blob | null             // Vidéo animation
  mesh: MeshData | null
  markers: MarkerCorners | null      // 4 coins marqueurs L
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

- **Firestore** : métadonnées projet (nom, dates, mesh geometry sauf gros JSON)
- **Cloud Storage** :
  - `projects/{id}/originalImage` — blob image
  - `projects/{id}/video` — blob vidéo
  - `projects/{id}/contourOriginKeyframes.json` — keyframes point d'origine
  - `projects/{id}/contourOriginFrames.json` — positions P0 par frame
  - `projects/{id}/contourAnchorKeyframes.json` — keyframes anchors contour
  - `projects/{id}/contourAnchorFrames.json` — positions anchors contour par frame
  - `projects/{id}/contourSubdivisionFrames.json` — positions subdivision par frame
  - `projects/{id}/contourCannyFrames.json` — cache contours Canny ordonnés par frame
  - `projects/{id}/anchorKeyframes.json` — keyframes ancres internes
  - `projects/{id}/anchorFrames.json` — positions ancres internes par frame
  - `projects/{id}/videoFramesMesh.json` — données animation finale
  - `scans/{id}/scanImage` — image rectifiée

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
