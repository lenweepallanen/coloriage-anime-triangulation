# Coloriage Animé - Triangulation Custom

Application web de livres de coloriage animés avec triangulation de maillage et suivi vidéo.

## Concept

L'utilisateur crée un projet avec une image de coloriage et une vidéo d'animation. L'admin définit un maillage triangulé sur l'image, puis pré-calcule le suivi optique des points du maillage à travers les frames vidéo. L'utilisateur final scanne son coloriage colorié, et l'app injecte ses couleurs dans le maillage animé via PIXI.js.

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
/admin/:projectId    → AdminPage   (workflow 4 étapes)
/scan/:projectId     → ScanPage    (scan + animation)
```

## Workflow Admin (4 étapes)

1. **Import** — Upload image PNG/JPEG + vidéo MP4/WebM
2. **Triangulation** — Éditeur de maillage (contour + points internes + Delaunay)
3. **PDF** — Génération PDF avec overlay maillage et marqueurs L
4. **Optical Flow** — Pré-calcul Lucas-Kanade du suivi des points sur la vidéo

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
├── types/project.ts            Types (Point2D, MeshData, Project, Scan)
├── db/
│   ├── firebase.ts             Init Firebase
│   ├── projectsStore.ts        CRUD projets (Firestore + Storage)
│   └── scansStore.ts           CRUD scans
├── hooks/useProject.ts         Hook chargement/sauvegarde projet
├── pages/
│   ├── HomePage.tsx            Liste projets
│   ├── AdminPage.tsx           Onglets admin
│   └── ScanPage.tsx            Machine d'états scan
├── components/
│   ├── admin/                  Étapes admin (Import, Triangulation, PDF, OpticalFlow)
│   ├── triangulation/          Éditeur maillage (canvas, interactions, dessin)
│   └── scan/                   Composants scan (caméra, coins, processing, animation)
├── utils/
│   ├── autoMeshGenerator.ts    Détection contour + génération grille interne
│   ├── geometry.ts             Point-in-polygon, distance, centroïde
│   ├── markerGenerator.ts      Dessin marqueurs L
│   ├── opticalFlowComputer.ts  Pipeline extraction frames + tracking
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
  mesh: {
    contourPoints: Point2D[]         // Points du contour
    internalPoints: Point2D[]        // Points internes
    triangles: [number,number,number][] // Indices Delaunay
    videoFramesMesh: Point2D[][] | null // Points trackés par frame
  } | null
  markers: MarkerCorners | null      // 4 coins marqueurs L
}

Scan {
  id, projectId, scannedAt
  scanImageBlob: Blob                // Image rectifiée
  textureMap: TextureTriangle[] | null
}
```

## Stockage Firebase

- **Firestore** : métadonnées projet (nom, dates, mesh geometry, markers)
- **Cloud Storage** :
  - `projects/{id}/originalImage` — blob image
  - `projects/{id}/video` — blob vidéo
  - `projects/{id}/videoFramesMesh.json` — données optical flow
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

## Commandes

```bash
npm run dev      # Serveur dev HTTPS (Vite)
npm run build    # Build production (tsc + vite)
npm run lint     # ESLint
npm run preview  # Preview build
```
