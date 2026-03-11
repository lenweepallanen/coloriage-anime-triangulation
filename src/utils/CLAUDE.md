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
| `trackingConstraints.ts` | Contraintes de voisinage + snap-to-contour pour stabiliser le tracking |
| `contourSpatialIndex.ts` | Index spatial bucket 2D pour recherche rapide du pixel contour le plus proche |
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

Interface optionnelle passée à `precomputeOpticalFlow` et `trackSegment` pour activer les contraintes :

```typescript
interface TrackingConstraintParams {
  anchorTriangles: [number, number, number][]
  contourAnchorOrder?: number[]        // indices ordonnés le long du contour
  enableAntiSaut?: boolean             // défaut true
  antiSautVmax?: number                // px, défaut auto (1.5% diagonale)
  enableTemporalSmoothing?: boolean    // défaut false
  temporalSmoothingWindow?: number     // défaut 3
  enableContourConstraints?: boolean   // défaut false
  enableOutlierDetection?: boolean     // défaut false
  enableMinSeparation?: boolean        // défaut true (anti-agglutination)
  enableSnapToContour?: boolean        // défaut false — snap sur contour Canny
  snapToContourConfig?: Partial<SnapToContourOptions>
  cannyParams?: CannyParams            // params Canny pour détection contour pendant tracking
}
```

### precomputeOpticalFlow

`precomputeOpticalFlow(cv, videoBlob, meshPoints, imageW, imageH, onProgress?, constraints?)` :

1. Créer `<video>` depuis blob, extraire durée/dimensions
2. Convertir points image → coordonnées vidéo
3. Construire l'adjacence si `constraints` fourni
4. `flowInit()` : initialiser tracker dans Worker
5. Boucle sur tous les frames (24 FPS) : `flowProcessFrame()` par frame
6. Si contraintes activées (et frame > 0) : applique dans l'ordre anti-saut → voisinage → contour, puis `flowUpdatePoints()` une seule fois
7. Post-traitement : lissage temporel puis détection outliers (si activés)
8. Reconvertir résultats vers coordonnées image
9. `flowCleanup()` : libérer mémoire Worker
10. Retour : `Point2D[][]`

### trackSegment

`trackSegment(videoBlob, initialPoints, imageW, imageH, startFrame, endFrame, onProgress?, constraints?)` :

Re-tracke un segment de frames entre deux keyframes, en partant des positions corrigées. Utilisé lors de la propagation après correction d'une keyframe.

1. Seek vers startFrame, initialise le tracker LK avec les positions corrigées
2. Boucle frame par frame de startFrame vers endFrame (forward ou backward)
3. Si contraintes activées : applique anti-saut → voisinage → contour + `flowUpdatePoints()` après chaque frame (pas de lissage temporel ni outliers pour les segments courts)
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
| `flowProcessFrame(imageData, options?)` | `flow-frame` | `FlowFrameResult` (points + detectedContour?) |
| `flowUpdatePoints(points)` | `flow-update-points` | confirmation |
| `flowCleanup()` | `flow-cleanup` | confirmation |
| `flowCannyContour(imageData, params)` | `canny-contour` | `contourPoints: Point2D[]` |

## textureExtractor.ts

- `extractTextureCanvas(canvas)` — retourne le canvas rectifié tel quel
- `computeUVs(points, imageW, imageH)` — normalise les coordonnées `[0,1]` :
  ```
  u = point.x / imageWidth
  v = point.y / imageHeight
  ```

## trackingConstraints.ts

Stabilisation du tracking optical flow par contraintes multiples. 5 mécanismes complémentaires appliqués dans un ordre précis.

### Ordre d'application (par frame)

```
1. applyAntiSaut            — clamp déplacement max
2. applyNeighborConstraints — consensus médiane voisins (topologie)
3. applyContourConstraints  — consensus contour + ordre
4. applyMinSeparation       — anti-agglutination
5. applySnapToContour       — snap sur contour Canny détecté
→ flowUpdatePoints() une seule fois après les 5
```

Post-traitement (après boucle complète, precomputeOpticalFlow uniquement) :
```
6. applyTemporalSmoothing   — moving average temporel
7. detectAndCorrectOutliers — détection/correction outliers
```

### buildAnchorAdjacency

`buildAnchorAdjacency(anchorTriangles)` → `Map<number, Set<number>>`

Construit la carte d'adjacence : deux anchors sont voisins s'ils partagent une arête dans `anchorTriangles`.

### applyAntiSaut

`applyAntiSaut(currentPositions, previousPositions, vmax)` → `Point2D[]`

Clamp le déplacement de chaque anchor à `vmax` pixels par frame. Si dépassé, réduit dans la même direction. `vmax` défaut : 1.5% de la diagonale vidéo (calculé dans opticalFlowComputer).

### applyNeighborConstraints

`applyNeighborConstraints(currentPositions, previousPositions, adjacency, options?)` → `Point2D[]`

Détecte les anchors dont le déplacement dévie de la médiane de leurs voisins, et les ramène vers la médiane.

| Paramètre | Défaut | Rôle |
|-----------|--------|------|
| `thresholdAbsolute` | 2.0 px | Déviation minimum pour déclencher la correction |
| `thresholdRelative` | 3.0 | Déviation en multiples de la dispersion voisins |
| `blendFactor` | 0.6 | Force de correction |

### applyContourConstraints

`applyContourConstraints(currentPositions, previousPositions, contourAnchorOrder, options?)` → `Point2D[]`

Contraintes spécifiques aux anchors de contour :
1. **Consensus contour** : médiane des 2 voisins de contour (prev/next dans l'ordre), seuil plus serré (1.5px, blend 0.8)
2. **Enforcement d'ordre** : si 2 anchors consécutifs se croisent (cross product sign flip), interpolation du fautif

### applyTemporalSmoothing

`applyTemporalSmoothing(allFrames, windowSize?)` → `Point2D[][]`

Moving average centré sur une fenêtre de N frames (défaut 3). Frame 0 et dernière frame inchangées. Fenêtres réduites aux bords.

### detectAndCorrectOutliers

`detectAndCorrectOutliers(allFrames, adjacency, options?)` → `{ corrected, suspects }`

Détecte les outliers par :
- **Accélération** : changement de vélocité > seuil (défaut 5px)
- **Vélocité relative** : > 4× médiane des voisins pendant 2+ frames

Correction : interpolation temporelle entre la dernière bonne position et la prochaine bonne position. `suspects` : `Map<frameIndex, anchorIndices[]>` pour feedback UI.

### applySnapToContour

`applySnapToContour(points, contourIndex, options)` → `{ snapped, confidences, lostFlags }`

Snap les points sur le contour Canny détecté à chaque frame. Utilise `ContourSpatialIndex` pour la recherche rapide.

**3 zones** :
- Distance ≤ `snapRadius` (12px) → snap complet avec `strengthNormal` (1.0), confidence [0.7, 1.0]
- Distance entre `snapRadius` et `lostRadius` (30px) → snap partiel avec `strengthPartial` (0.5), confidence [0, 0.7]
- Distance > `lostRadius` → point marqué lost, confidence 0, pas de déplacement

```typescript
interface SnapToContourOptions {
  enabled: boolean
  snapRadius: number        // défaut 12
  lostRadius: number        // défaut 30
  strengthNormal: number    // défaut 1.0
  strengthPartial: number   // défaut 0.5
}
```

### recoverLostPoints

`recoverLostPoints(points, lostFlags, contourIndex, recoveryRadius?)` → `{ recovered, confidences, stillLost }`

Tente de récupérer les points marqués "lost" en cherchant dans un rayon étendu (`recoveryRadius` = 60px). Si trouvé, snap complet ; sinon, le point reste à sa position LK.

## contourSpatialIndex.ts

Index spatial bucket 2D pour recherche rapide du pixel contour le plus proche.

```typescript
class ContourSpatialIndex {
  constructor(contourPixels: Point2D[], bucketSize = 8)
  nearest(point: Point2D, maxDist: number): { point: Point2D; dist: number } | null
}
```

- Construit une grille de buckets au constructeur (O(n))
- `nearest()` cherche dans les buckets voisins dans un rayon `maxDist` (O(1) amortie)
- Utilisé par `applySnapToContour` et `recoverLostPoints` à chaque frame

## pdfGenerator.ts

Génère un PDF avec jsPDF contenant l'image du coloriage, l'overlay du maillage triangulé et les marqueurs L aux 4 coins pour la détection au scan.
