# Utilitaires

Fonctions pures et modules de traitement utilisés par les composants.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `autoMeshGenerator.ts` | Génération automatique de maillage (contour + points internes) |
| `barycentricUtils.ts` | Coordonnées barycentriques (calcul, recherche triangle, interpolation) |
| `geometry.ts` | Fonctions géométriques (point-in-polygon, distance, centroïde) |
| `keyframePropagation.ts` | Interpolation linéaire entre keyframes + extraction depuis tracking brut |
| `markerGenerator.ts` | Dessin des marqueurs L aux coins |
| `opticalFlowComputer.ts` | Orchestration du pré-calcul optical flow + tracking par segment |
| `trackingConstraints.ts` | Contraintes de voisinage pour stabiliser le tracking |
| `perspectiveCorrection.ts` | Bridge RPC vers le Worker OpenCV |
| `pdfGenerator.ts` | Génération PDF (jsPDF) |
| `textureExtractor.ts` | Calcul des coordonnées UV pour PIXI.js |

## autoMeshGenerator.ts

`generateAutoMesh(imageBlob, density: 1-10)` :

1. **Contour** : downscale image à 400px max → Worker OpenCV `detectContour` → rescale points
2. **Points internes** : grille avec espacement `maxDim / (density * 3 + 5)`, filtrés par point-in-polygon et distance min aux bords (40% espacement)
3. **Fallback** : rectangle avec 5px de marge si détection échoue

## barycentricUtils.ts

Utilitaires pour piloter les points internes à partir des anchor points via coordonnées barycentriques.

| Fonction | Rôle |
|----------|------|
| `computeBarycentric(p, a, b, c)` | Calcule les poids (u, v, w) tels que P = u*A + v*B + w*C |
| `findContainingAnchorTriangle(p, anchors, triangles)` | Trouve le triangle anchor contenant P, avec fallback au triangle le plus proche |
| `interpolateInternalPoint(bary, anchorPositions, triangles)` | Reconstruit la position d'un point interne à partir des positions anchor courantes |
| `computeAllBarycentrics(internals, anchors, triangles)` | Calcule les BarycentricRef pour tous les points internes |

Utilisé par :
- `TriangulationStep` (verrouillage topologie → calcul des barycentrics)
- `FinalPropagationStep` (calcul positions internes pour chaque frame)

## keyframePropagation.ts

| Fonction | Rôle |
|----------|------|
| `extractKeyframes(allFrameAnchors, interval)` | Extrait des keyframes à intervalles réguliers depuis le tracking brut. Inclut toujours la première et dernière frame. |
| `propagateKeyframes(keyframes, totalFrames)` | Interpole linéairement les positions anchors entre keyframes pour toutes les frames. Hold en dehors des keyframes. |

## geometry.ts

- `pointInPolygon(point, polygon)` — ray-casting algorithm
- `triangleCentroid(a, b, c)` — moyenne des 3 sommets
- `distance(a, b)` / `distanceSq(a, b)` — distance euclidienne

## markerGenerator.ts

Dessine des marqueurs en L :
- Taille et épaisseur configurables (défaut 40px / 10px)
- Orientation vers l'intérieur selon le coin (TL→↘, TR→↙, BR→↖, BL→↗)

## opticalFlowComputer.ts

### TrackingConstraintParams

Interface optionnelle passée à `precomputeOpticalFlow` et `trackSegment` pour activer les contraintes de voisinage :

```typescript
interface TrackingConstraintParams {
  anchorTriangles: [number, number, number][]
  contourIndices: number[]
}
```

### precomputeOpticalFlow

`precomputeOpticalFlow(cv, videoBlob, meshPoints, imageW, imageH, onProgress?, constraints?)` :

1. Créer `<video>` depuis blob, extraire durée/dimensions
2. Convertir points image → coordonnées vidéo
3. Construire l'adjacence si `constraints` fourni
4. `flowInit()` : initialiser tracker dans Worker
5. Boucle sur tous les frames (24 FPS) : `flowProcessFrame()` par frame
6. Si contraintes activées (et frame > 0) : `applyNeighborConstraints()` + `flowUpdatePoints()` pour synchroniser le Worker
7. Reconvertir résultats vers coordonnées image
8. `flowCleanup()` : libérer mémoire Worker
9. Retour : `Point2D[][]`

### trackSegment

`trackSegment(videoBlob, initialPoints, imageW, imageH, startFrame, endFrame, onProgress?, constraints?)` :

Re-tracke un segment de frames entre deux keyframes, en partant des positions corrigées. Utilisé lors de la propagation après correction d'une keyframe.

1. Seek vers startFrame, initialise le tracker LK avec les positions corrigées
2. Boucle frame par frame de startFrame vers endFrame (forward ou backward)
3. Si contraintes activées : applique `applyNeighborConstraints()` + `flowUpdatePoints()` après chaque frame
4. Retourne `{ frameIndex, points }[]` en coordonnées image

## perspectiveCorrection.ts

Bridge de communication avec le Web Worker OpenCV (`public/opencv-worker.js`).

### Cycle de vie Worker

- `loadOpenCVWorker()` — création singleton, timeout 30s
- Pattern RPC : handler temporaire swappé pendant l'appel, Promise-based

### Fonctions RPC exposées

| Fonction | Message Worker | Retour |
|----------|---------------|--------|
| `detectCorners(imageData)` | `detect` | `corners: Point2D[]` |
| `detectContourViaWorker(imageData, density)` | `contour` | `points: Point2D[]` |
| `processCapturedImage(blob, corners?)` | `process` | `ImageData 2048×2048` |
| `flowInit(points)` | `flow-init` | confirmation |
| `flowProcessFrame(imageData)` | `flow-frame` | `points: Point2D[]` |
| `flowUpdatePoints(points)` | `flow-update-points` | confirmation |
| `flowCleanup()` | `flow-cleanup` | confirmation |

## textureExtractor.ts

- `extractTextureCanvas(canvas)` — retourne le canvas rectifié tel quel
- `computeUVs(points, imageW, imageH)` — normalise les coordonnées `[0,1]` :
  ```
  u = point.x / imageWidth
  v = point.y / imageHeight
  ```

## trackingConstraints.ts

Stabilisation du tracking optical flow par contraintes de voisinage basées sur la topologie du maillage anchor.

### buildAnchorAdjacency

`buildAnchorAdjacency(anchorTriangles)` → `Map<number, Set<number>>`

Construit la carte d'adjacence : deux anchors sont voisins s'ils partagent une arête dans `anchorTriangles`.

### applyNeighborConstraints

`applyNeighborConstraints(currentPositions, previousPositions, adjacency, contourIndices, options?)` → `Point2D[]`

Après chaque frame de tracking, détecte les anchors dont le déplacement dévie de la médiane de leurs voisins, et les ramène vers cette médiane.

| Paramètre | Défaut | Rôle |
|-----------|--------|------|
| `thresholdAbsolute` | 2.0 px | Déviation minimum pour déclencher la correction |
| `thresholdRelative` | 3.0 | Déviation en multiples de la dispersion voisins |
| `blendFactor` | 0.6 | Force de correction (points intérieurs) |
| `contourBlendFactor` | 0.75 | Force de correction (points de contour) |

Algorithme :
1. Calcule le déplacement (dx, dy) de chaque anchor vs frame précédente
2. Pour chaque anchor, calcule la médiane des déplacements de ses voisins
3. Si la déviation dépasse `max(threshAbs, spread × threshRel)` → blend vers la médiane
4. Les points avec ≤ 2 voisins ont un seuil relatif majoré (×1.5) pour éviter le sur-contrainte

## pdfGenerator.ts

Génère un PDF avec jsPDF contenant l'image du coloriage, l'overlay du maillage triangulé et les marqueurs L aux 4 coins pour la détection au scan.
