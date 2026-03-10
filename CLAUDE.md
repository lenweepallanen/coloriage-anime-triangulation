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
/admin/:projectId    → AdminPage   (workflow 5 étapes)
/scan/:projectId     → ScanPage    (scan + animation)
```

## Workflow Admin (5 étapes)

1. **Import** — Upload image PNG/JPEG + vidéo MP4/WebM
2. **Points d'ancrage** — Placement des anchor points (contour + features)
3. **Triangulation** — Points internes + Delaunay + verrouillage topologie + PDF
4. **Keyframes** — Tracking anchors + validation/correction par keyframe + propagation
5. **Animation finale** — Calcul positions tous points via coordonnées barycentriques

## Workflow Scan (utilisateur final)

1. **Caméra** — Détection temps réel des marqueurs L + analyse qualité
2. **Ajustement coins** — Repositionnement manuel des 4 coins
3. **Correction perspective** — Homographie OpenCV → image 2048×2048
4. **Animation** — Rendu PIXI.js du maillage texturé animé à 24 FPS

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
│   ├── AdminPage.tsx           Onglets admin (5 étapes)
│   └── ScanPage.tsx            Machine d'états scan
├── components/
│   ├── admin/                  Étapes admin (Import, Anchors, Triangulation, Keyframes, Animation)
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
│   ├── perspectiveCorrection.ts Bridge Worker OpenCV (RPC)
│   ├── pdfGenerator.ts         Génération PDF
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
  // Points structurels (trackés par optical flow)
  anchorPoints: Point2D[]            // Contour + features intérieures
  contourIndices: number[]           // Indices des anchors formant le contour
  internalPoints: Point2D[]          // Points de remplissage (non trackés)

  // Topologie (verrouillée après étape 3)
  triangles: [number,number,number][]  // Indices dans allPoints = [...anchors, ...internals]
  topologyLocked: boolean

  // Relation anchors → internes (coordonnées barycentriques)
  anchorTriangles: [number,number,number][]  // Delaunay sur anchors seuls
  internalBarycentrics: BarycentricRef[]     // 1 par point interne

  // Animation par keyframes
  keyframeInterval: number
  keyframes: KeyframeData[]          // Positions anchors aux keyframes
  anchorFrames: Point2D[][] | null   // Positions anchors interpolées pour toutes les frames

  // Sortie finale (consommé par AnimationPlayer)
  videoFramesMesh: Point2D[][] | null  // [...anchors, ...internals] par frame
}

Scan {
  id, projectId, scannedAt
  scanImageBlob: Blob                // Image rectifiée
  textureMap: TextureTriangle[] | null
}
```

## Indexation des points

Convention utilisée partout : `allPoints = [...anchorPoints, ...internalPoints]`. Les indices dans `triangles` réfèrent à cette fusion. AnimationPlayer consomme `videoFramesMesh` avec cette même convention.

## Stockage Firebase

- **Firestore** : métadonnées projet (nom, dates, mesh geometry sauf gros JSON)
- **Cloud Storage** :
  - `projects/{id}/originalImage` — blob image
  - `projects/{id}/video` — blob vidéo
  - `projects/{id}/keyframes.json` — données keyframes
  - `projects/{id}/anchorFrames.json` — positions anchors interpolées par frame
  - `projects/{id}/videoFramesMesh.json` — données animation finale
  - `scans/{id}/scanImage` — image rectifiée

## Systèmes de coordonnées

Trois espaces de coordonnées coexistent :
1. **Image** — coordonnées originales de l'image (stockage du maillage)
2. **Vidéo** — coordonnées du frame vidéo (pendant l'optical flow)
3. **Écran** — coordonnées canvas/PIXI (rendu avec DPI)

## Conventions

- Tout le traitement lourd (OpenCV) tourne dans un Web Worker
- Communication Worker via messages typés avec pattern RPC (perspectiveCorrection.ts)
- Le maillage est toujours stocké en coordonnées image
- FPS cible : 24 images/seconde
- Résolution de sortie perspective : 2048×2048
- Les triangles Firestore sont sérialisés en objets `{a, b, c}` (limitation arrays imbriqués)
- Les anchor points sont numérotés : contour 0..N-1, features N..N+M-1

## Commandes

```bash
npm run dev      # Serveur dev HTTPS (Vite, host: true pour accès réseau)
npm run build    # Build production (tsc + vite)
npm run lint     # ESLint
npm run preview  # Preview build
```
