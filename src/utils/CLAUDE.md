# Utilitaires

Fonctions pures et modules de traitement utilisés par les composants.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `autoMeshGenerator.ts` | Génération automatique de maillage (contour + points internes) |
| `barycentricUtils.ts` | Coordonnées barycentriques (calcul, recherche triangle, interpolation) |
| `geometry.ts` | Fonctions géométriques (point-in-polygon, distanceSq, centroïde) |
| `keyframePropagation.ts` | Interpolation linéaire entre keyframes |
| `markerGenerator.ts` | Dessin des marqueurs L aux coins |
| `opticalFlowComputer.ts` | Orchestration du pré-calcul optical flow + tracking par segment |
| `trackingConstraints.ts` | Contraintes de voisinage + snap-to-contour + spring curviligne pour stabiliser le tracking |
| `contourAnchorTracker.ts` | Raffinement hybride LK + template matching + snap contour pour anchors contour (utilisé par opticalFlowComputer.ts) |
| `curvilinearContour.ts` | Coordonnées curvilignes sur contour Canny (ordonnancement pixels, subdivision, calcul par frame) |
| `curvatureScaleSpace.ts` | Détection extrema de courbure (single-scale + global) + snap anchor par courbure + arc-lengths/signatures initiales |
| `arapSolver.ts` | Déformation ARAP (As-Rigid-As-Possible) du maillage 2D |
| `optimalTransportSnap.ts` | Assignment optimal (transport) pour snap contour robuste |
| `contourSpatialIndex.ts` | Index spatial bucket 2D pour recherche rapide du pixel contour le plus proche |
| `perspectiveCorrection.ts` | Bridge RPC vers le Worker OpenCV |
| `pdfGenerator.ts` | Génération PDF (jsPDF) |
| `pdfLayout.ts` | Constantes layout A4 partagées |
| `textureExtractor.ts` | Calcul des coordonnées UV pour PIXI.js |
| `bodyZoneUtils.ts` | Détection zones corporelles (triangle→zone map, hit test point-in-triangle, touch detection) |
| `loopPlayback.ts` | Playback seamless avec crossfade smoothstep configurable |
| `multiAnimationPlayback.ts` | Machine d'états playback multi-animation (rest loop + oneshot transitions) |
| `deviceParallax.ts` | Wrapper DeviceOrientation API avec gestion permission iOS + smoothing EMA + swap axes landscape |
| `walkSolver.ts` | Cinématique marche quadrupède : squelette 18 keypoints, IK 2-bones (genoux), LBS par zone, calcul séparé zones/body |
| `limbSeparation.ts` | Séparation membres/corps : Bézier→polygone, filtrage vertex-based, Delaunay par zone, patch manuel body (buildBodyMesh, findTwoNearest) |
| `bezierUtils.ts` | Courbes Bézier : évaluation cubique, flatten en polyline, expansion polygone, sampling contour |
| `zoneMeshRenderer.ts` | Rendu PIXI.js par zone : build meshes séparés (zone + body + hidden face), z-ordering, update vertices par frame |
| `hiddenFaceTexture.ts` | Inpainting diffusion Laplacienne (fallback) : K-means couleurs bordure + BFS propagation pour les faces cachées |
| `limbMaskGenerator.ts` | Génération masque binaire PNG des zones pattes (Bézier dilatées) pour envoi à LaMa Cloud Function |
| `lamaInpainting.ts` | Client API Cloud Function LaMa : envoi scan+masque (512px JPEG), réception résultat inpainté, upscale |

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

## keyframePropagation.ts

| Fonction | Rôle |
|----------|------|
| `propagateKeyframes(keyframes, totalFrames)` | Interpole linéairement les positions anchors entre keyframes pour toutes les frames. Hold en dehors des keyframes. |

## geometry.ts

- `pointInPolygon(point, polygon)` — ray-casting algorithm
- `triangleCentroid(a, b, c)` — moyenne des 3 sommets
- `distanceSq(a, b)` — distance euclidienne au carré

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
  minSeparationRatio?: number          // fraction longueur médiane arêtes, défaut 0.25
  enableContourRefinement?: boolean    // défaut false — hybride LK + template + snap contour
  contourRefinementConfig?: Partial<Omit<ContourTrackingConfig, 'contourAnchorIndices'>>
  enableSnapToContour?: boolean        // défaut false — snap sur contour Canny
  snapToContourConfig?: Partial<SnapToContourOptions>
  enableCurvilinearSpring?: boolean    // défaut false — répulsion ressort le long du contour Canny
  curvilinearSpringConfig?: Partial<CurvilinearSpringOptions>
  cannyParams?: CannyParams            // params Canny pour détection contour pendant tracking
}
```

### precomputeOpticalFlow

`precomputeOpticalFlow(cv, videoBlob, meshPoints, imageW, imageH, onProgress?, constraints?)` :

1. Créer `<video>` depuis blob, extraire durée/dimensions
2. Convertir points image → coordonnées vidéo
3. Construire l'adjacence si `constraints` fourni
4. `flowInit()` : initialiser tracker dans Worker
5. Si contour refinement activé : `flowInitTemplates()` + extraction contour dense frame 0
6. Boucle sur tous les frames (24 FPS) : `flowProcessFrame()` par frame
7. Si contour refinement : `flowExtractContourDense()` + `refineContourAnchors()` (phase 0)
8. Si contraintes activées (et frame > 0) : applique dans l'ordre anti-saut → voisinage → contour → min-separation → snap-to-contour → spring curviligne, puis `flowUpdatePoints()` une seule fois
9. Post-traitement : lissage temporel puis détection outliers (si activés)
10. Reconvertir résultats vers coordonnées image
11. `flowCleanup()` : libérer mémoire Worker
12. Retour : `Point2D[][]`

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
| `flowInitTemplates(contourAnchorIndices, templateSize?)` | `flow-init-templates` | confirmation |
| `flowExtractContourDense(imageData)` | `flow-contour-dense` | `contourPoints: Point2D[] \| null` |

## textureExtractor.ts

- `detectDrawingBBox(canvas)` — détecte la bbox du dessin (pixels sombres lum < 128) par scan lignes/colonnes (≥3 pixels sombres). Gardes-fous : skip si < 0.1% dark pixels ou bbox > 95% canvas
- `computeMeshBBox(points)` — simple min/max sur tous les points du maillage
- `computeUVs(points, imageW, imageH, alignment?)` — normalise les coordonnées `[0,1]` :
  - Sans alignment : `u = x / imageWidth`, `v = y / imageHeight`
  - Avec `ContentAlignment { drawBBox, meshBBox }` : mappe la bbox mesh sur la bbox dessin
    ```
    u = (x - meshMinX) / meshW * drawW / imageW + drawMinX / imageW
    v = (y - meshMinY) / meshH * drawH / imageH + drawMinY / imageH
    ```

## curvatureScaleSpace.ts

Détection des extrema de courbure et snap anchor par courbure via Curvature Scale Space (CSS).

### Fonctions principales

| Fonction | Rôle |
|----------|------|
| `detectCurvatureExtrema(contour, N)` | Single-scale : top-N points de plus forte \|κ\| sur contour rééchantillonné |
| `detectGlobalCurvatureExtrema(contour, N)` | Détection globale des extrema de courbure (top-N) |
| `cssSnapToContour(pos, contour, arcLengths, window)` | Snap anchor vers le pic κ le plus fort dans une fenêtre locale |
| `cssSnapToContourRegistered(pos, contour, arcLengths, window, signature)` | Snap avec matching de signature de courbure (signe, magnitude, prominence) |
| `computeInitialAnchorArcLengths(anchors, contour)` | Arc-length de référence de chaque anchor à frame 0 |
| `computeInitialSignatures(anchors, contour)` | Signature de courbure (signe, \|κ\|, prominence, rang local) de chaque anchor à frame 0 |

### Utilisé par
- `ContourAnchorsStep` (étape 5) : `detectCurvatureExtrema` pour auto-détection des points caractéristiques
- `ContourTrackingStep` (étape 7) : `detectGlobalCurvatureExtrema` pour snap anchors vers les pics de courbure

## arapSolver.ts

Déformation ARAP (As-Rigid-As-Possible) du maillage 2D avec sommets pinnés.

### Fonctions principales

| Fonction | Rôle |
|----------|------|
| `precomputeARAP(allPoints, triangles, pinnedIndices)` | Pré-calcul : Laplacien L_ff/L_fp, poids cotangent, factorisation Cholesky. Appelé une fois par topologie |
| `solveARAP(system, pinnedPositions, iterations?)` | Résout 1 frame : étape locale (rotation polaire par sommet) + étape globale (résolution Cholesky) |
| `batchSolveARAP(system, pinnedFrames, iterations?)` | Résout toutes les frames séquentiellement avec warm-start |

### Algorithme (par itération)
1. **Étape locale** : pour chaque sommet, matrice covariance 2×2 des arêtes déformées vs repos → rotation la plus proche via décomposition polaire
2. **Étape globale** : construire RHS depuis rotations + contraintes pinnées → résoudre via Cholesky

### Utilisé par
- `TriangulationStep` (étape 10) : seule méthode de calcul des points internes, minimise la distorsion locale lors de la déformation

## optimalTransportSnap.ts

Assignment optimal (transport) pour snap contour robuste via algorithme hongrois.

### Fonction principale

`applyOTSnap(anchors, cannyPixels, contourOrigin?)` → `{ snapped: Point2D[], success: boolean }`

### Algorithme
1. Ordonner les pixels Canny en chaîne continue
2. Rééchantillonner à ~300 points uniformes en arc-length
3. Calculer courbure κ à chaque échantillon
4. Projeter anchors sur le contour → paires (s, κ)
5. **Beam pre-selection** : top-5 candidats les plus proches par anchor en espace (s, κ)
6. Matrice de coût normalisée : `C(i,j) = (Δs/σ_s)² + λ(Δκ/σ_κ)²`
7. Résolution par algorithme hongrois (O(n³))
8. **Validation monotonie** : la séquence snap doit respecter l'ordre arc-length, sinon fallback géométrique

### Utilisé par
- Optionnel dans le pipeline de tracking contour comme alternative robuste au snap géométrique pur

## trackingConstraints.ts

Stabilisation du tracking optical flow par contraintes multiples. 7 mécanismes complémentaires appliqués dans un ordre précis.

### Ordre d'application (par frame)

```
0. refineContourAnchors        — (optionnel) hybride LK + template matching + snap contour dense
1. applyAntiSaut               — clamp déplacement max
2. applyNeighborConstraints    — consensus médiane voisins (topologie)
3. stabilizeContourAnchors     — stabilisation curviligne contour + ordre + espacement
4. applyMinSeparation          — anti-agglutination (distance min entre voisins)
5. applySnapToContour          — snap sur contour Canny détecté (ContourSpatialIndex)
   └→ recoverLostPoints        — récupération des points perdus (rayon étendu)
6. applyCurvilinearSpringOnCanny — (optionnel) répulsion ressort le long du contour Canny
→ flowUpdatePoints() une seule fois après toutes les contraintes
```

Post-traitement (après boucle complète, precomputeOpticalFlow uniquement) :
```
7. applyTemporalSmoothing      — moving average temporel
8. detectAndCorrectOutliers    — détection/correction outliers
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

### stabilizeContourAnchors

`stabilizeContourAnchors(currentPositions, previousPositions, contourAnchorOrder, initialSpacings, options?)` → `Point2D[]`

Stabilise les anchors de contour via coordonnées curvilignes sur le polyline formé par les positions précédentes :

1. Projette les positions courantes sur le polyline → coordonnées curvilignes `s_i ∈ [0,1)`
2. Enforce l'ordre monotone (pas de croisements)
3. Enforce l'espacement minimum (`minSpacingRatio` × espacement initial, défaut 0.5)
4. Régularise vers la distribution d'espacement initiale (`spacingRegularization`, défaut 0.5)
5. Lissage Laplacien sur les valeurs s (2 itérations, poids 0.25)
6. Reconstruit les positions 2D sur le polyline

### computeInitialContourSpacings

`computeInitialContourSpacings(positions, contourAnchorOrder)` → `number[]`

Calcule les espacements curvilignes initiaux entre anchors consécutifs sur le polyline contour. Appelé une fois à la frame 0, les espacements servent de référence pour `stabilizeContourAnchors`.

### applyMinSeparation

`applyMinSeparation(positions, adjacency, minDist)` → `Point2D[]`

Empêche l'agglutination : pour chaque arête de l'adjacence, si la distance est inférieure à `minDist`, repousse les deux points symétriquement. `minDist` = `median(longueurs arêtes) × minSeparationRatio` (défaut 0.25).

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

### applyCurvilinearSpringOnCanny

`applyCurvilinearSpringOnCanny(positions, contourAnchorOrder, cannyPolyline, initialCannySpacings, options?)` → `Point2D[]`

Répulsion ressort le long du contour Canny détecté. Après le snap-to-contour, assure un espacement régulier entre anchors consécutifs :

1. Projette les anchors contour sur le polyline Canny → coordonnées curvilignes `s_i`
2. Enforce l'ordre monotone
3. Relaxation itérative par ressorts : force proportionnelle à `(espacement_courant - espacement_cible) × stiffness`
4. Enforce l'espacement minimum
5. Reconstruit les positions 2D sur le polyline Canny

```typescript
interface CurvilinearSpringOptions {
  springStiffness?: number    // [0,1], défaut 0.4
  iterations?: number         // nombre d'itérations de relaxation, défaut 3
  minSpacingRatio?: number    // espacement min comme fraction de la cible, défaut 0.3
}
```

### computeInitialCannySpacings

`computeInitialCannySpacings(positions, contourAnchorOrder, cannyPolyline)` → `number[]`

Calcule les espacements curvilignes initiaux sur un polyline Canny de référence. Appelé une fois à la frame 0 avec le premier contour Canny.

### median

`median(values)` → `number`

Utilitaire : médiane d'un tableau de nombres. Utilisé dans opticalFlowComputer pour calculer `minDist`.

## contourAnchorTracker.ts

Raffinement hybride des anchors contour combinant 3 sources d'information :
- **LK (Lucas-Kanade)** : tracking optical flow standard
- **Template matching** : corrélation de patches autour des anchors
- **Snap-to-contour** : projection sur le contour dense extrait

### ContourTrackingConfig

```typescript
interface ContourTrackingConfig {
  contourAnchorIndices: number[]  // indices des anchors contour dans le tableau global
  snapRadius: number              // px, distance max snap (défaut 8)
  snapLostFactor: number          // multiplicateur pour seuil lost (défaut 3)
  templateWeight: number          // poids du template matching dans la fusion (défaut 0.3)
  snapWeight: number              // poids du snap contour dans la fusion (défaut 0.5)
  minConfidence: number           // en dessous → point marqué douteux (défaut 0.3)
  maxLostFrames: number           // gèle à lastGood après N frames perdues (défaut 5)
}
```

### Fonctions

| Fonction | Rôle |
|----------|------|
| `initContourTracking(config, initialPositions)` | Initialise l'état : confidences à 1.0, lastGoodPositions = positions initiales |
| `refineContourAnchors(allPositions, contourMatches, contourPolyline, state, config)` | Raffine les positions par fusion pondérée LK/template/snap, gestion confidence et récupération |

### Algorithme de fusion (par anchor, par frame)

```
1. Template match → pTM si score > 0.5
2. Snap-to-contour → pSnap si distance < snapRadius × snapLostFactor
3. Fusion pondérée :
   - 3 sources : wLK × pLK + wTM × pTM + wSnap × pSnap
   - 2 sources (LK+TM ou LK+snap) : blend pondéré
   - 1 source (LK seul) : position LK brute
4. Calcul confidence (1.0 / 0.7 / decay 0.85)
5. Si confidence < minConfidence → point lost
   - Si > maxLostFrames → gèle à lastGoodPosition
   - Sinon si snap disponible → récupération via snap
```

## curvilinearContour.ts

Coordonnées curvilignes sur contour Canny. Place des points intermédiaires entre les anchor points caractéristiques en utilisant le contour Canny détecté à chaque frame.

| Fonction | Rôle |
|----------|------|
| `orderContourPixels(pixels)` | Ordonne les pixels Canny en chaîne continue (grille spatiale 4px pour nearest-neighbor O(n)) |
| `computeArcLengths(path)` | Calcule les longueurs d'arc cumulées le long du chemin |
| `interpolateAtArcLength(path, arcLengths, t)` | Interpole un point à la position curviligne normalisée `t` ∈ [0,1] |
| `reorderContourFromOrigin(contour, originPoint)` | Réordonne le contour pour que P0 soit à l'index 0 (s=0) |
| `extractPathBetweenAnchors(orderedContour, anchorA, anchorB)` | Extrait le sous-chemin le plus court entre deux anchors sur le contour fermé |
| `subdivideSegment(path, count, segmentIndex)` | Place N points uniformes le long d'un segment → `{ points, params }` |
| `subdivideContour(orderedContour, anchors, pointsPerSegment)` | Génère tous les points de subdivision pour tous les segments |
| `computeSubdivisionForFrame(orderedContour, anchorPositions, params)` | Calcule les positions de subdivision pour une frame |
| `computeAllSubdivisionFrames(videoBlob, anchorFrames, params, cannyParams, imageWidth, imageHeight, onProgress?, originFrames?, cachedCannyFrames?)` | Pipeline complet avec cache Canny optionnel → retourne `SubdivisionResult` |

### Type SubdivisionResult

```typescript
interface SubdivisionResult {
  subdivisionFrames: Point2D[][]  // positions de subdivision par frame
  cannyFrames: Point2D[][]        // contours Canny ordonnés par frame (pour cache)
}
```

### Pipeline par frame (computeAllSubdivisionFrames)

**Fast path** (si `cachedCannyFrames` fourni) : réutilise les contours Canny pré-calculés, skip l'extraction vidéo et la détection Canny. Recompute uniquement la subdivision sur chaque contour.

**Normal path** :
```
1. Extraire frame vidéo sur canvas (coords vidéo)
2. Frame-skip : si similarité > 95% avec frame précédente (sous-échantillonné ~200px),
   réutiliser le contour précédent (max 3 frames consécutives)
3. flowCannyContour() → pixels contour Canny (coords vidéo)
4. Convertir pixels vidéo → coords image (× imageWidth/videoWidth)
5. Utiliser directement les pixels (OpenCV findContours retourne déjà un contour ordonné)
6. reorderContourFromOrigin() depuis P0 tracké
7. Pour chaque segment [anchor_i, anchor_{i+1}] :
   - extractPathBetweenAnchors() → sous-chemin
   - computeArcLengths() → longueurs d'arc
   - interpolateAtArcLength(t) → position point intermédiaire
8. Fallback si Canny vide : interpolation linéaire entre anchors
9. Stocker le contour Canny ordonné dans cannyFrames[] pour cache
```

**Note** : la conversion coords vidéo → image est critique car les `anchorFrames` sont toujours en coordonnées image.

**Note** : `orderContourPixels()` n'est plus appelé dans le pipeline normal car OpenCV `findContours` retourne déjà des pixels ordonnés. La fonction reste disponible pour les cas où un réordonnancement est nécessaire, et utilise une grille spatiale (buckets 4px) pour un parcours nearest-neighbor en O(n) au lieu de O(n²).

## contourSpatialIndex.ts

Index spatial bucket 2D pour recherche rapide du pixel contour le plus proche. Stocke chaque point avec son index original dans le contour.

```typescript
class ContourSpatialIndex {
  constructor(contourPixels: Point2D[], bucketSize = 8)
  nearest(point: Point2D, maxDist: number): { point: Point2D; dist: number } | null
  nearestWithIndex(point: Point2D, maxDist: number): { point: Point2D; dist: number; index: number } | null
  nearestUnbounded(point: Point2D): { point: Point2D; dist: number } | null  // sans limite de distance
}
```

- Construit une grille de buckets au constructeur (O(n)), stocke `{ point, index }` par bucket
- `nearest()` cherche dans les buckets voisins dans un rayon `maxDist` (O(1) amortie)
- `nearestWithIndex()` idem mais retourne aussi l'index original dans le contour — utilisé par ContourTrackingStep pour retrouver la position curviligne
- Utilisé par `applySnapToContour`, `recoverLostPoints`, et `ContourTrackingStep` à chaque frame

## pdfLayout.ts

Constantes de layout A4 partagées entre la génération PDF et la correction de perspective :
- Dimensions A4 en mm et marges
- Utilisé par `pdfGenerator.ts` et `ScanProcessor.tsx`

## pdfGenerator.ts

Génère un PDF avec jsPDF contenant l'image du coloriage, l'overlay du maillage triangulé et les marqueurs L aux 4 coins pour la détection au scan.

## bodyZoneUtils.ts

Utilitaires pour la détection de zones corporelles au toucher dans le ScenePlayer.

| Fonction | Rôle |
|----------|------|
| `buildTriangleZoneMap(triangles, zones)` | Construit un lookup triangle index → zone ID (direct, chaque triangle assigné explicitement) |
| `findTriangleAtPoint(point, positions, triangles)` | Point-in-triangle par coordonnées barycentriques, retourne l'index du triangle ou -1 |
| `detectTouchedZone(imagePoint, positions, triangles, triangleZoneMap)` | Combine hit test + lookup zone → retourne le zone ID ou null |

Utilisé par :
- `ScenePlayer` (détection zone au `pointerdown` pendant l'état interaction)
- `BodyZoneEditor` (`findTriangleAtPoint` pour la sélection de triangles dans l'éditeur)

## multiAnimationPlayback.ts

Machine d'états pour le playback multi-animation : rest en boucle + oneshots déclenchés à la demande avec transitions fluides + physics overlays superposés.

### Machine d'états (5 états)

```
rest → (requestOneshot) → wait → (loop point) → trans-out → (N frames blend) → oneshot → (dernière frame) → trans-in → (N frames blend) → rest
```

| État | Comportement |
|------|-------------|
| `rest` | Rest animation en boucle via `LoopPlayback` (crossfade seamless) |
| `wait` | Rest continue, attend le loop point (cursor repasse à 0) |
| `trans-out` | Blend smoothstep sur `transitionFrames` : rest positions → oneshot frame 0 |
| `oneshot` | Lecture linéaire frame par frame (pas de loop, pas de crossfade) |
| `trans-in` | Blend smoothstep sur `transitionFrames` : oneshot dernière frame → rest frame 0 |

### Overlay (physics animations)

Les animations marquées `overlay: true` dans `OneshotAnimation` sont traitées séparément de la machine d'états principale :
- `requestOneshot()` démarre l'overlay **immédiatement** (pas de wait/transition)
- L'overlay avance en parallèle de l'état principal (rest/oneshot continue normalement)
- `getPositions()` calcule les **déplacements** (position overlay − position base frame 0) et les ajoute aux positions courantes
- Quand l'overlay atteint sa dernière frame, il s'arrête
- Les boutons overlay restent cliquables même pendant un oneshot classique

### API

```typescript
class MultiAnimationPlayback {
  constructor(restFrames: Point2D[][], oneshotAnimations: OneshotAnimation[], options?)
  requestOneshot(animId: string): void   // Queue une oneshot ou démarre un overlay immédiatement
  advance(deltaTicks: number): void      // Avance la machine d'états + overlay
  getPositions(): Point2D[]              // Positions courantes (avec blend si transition, + overlay si actif)
  get currentState(): PlaybackState
  get isPlayingOneshot(): boolean
  get isOverlayActive(): boolean
  get activeOneshotName(): string | null
  speed: number                          // Getter/setter, propagé à LoopPlayback
}
```

### Options

| Paramètre | Défaut | Rôle |
|-----------|--------|------|
| `fps` | 24 | FPS de référence |
| `crossfadeFrames` | 7 | Crossfade pour le loop rest (passé à LoopPlayback) |
| `transitionFrames` | 7 | Nombre de frames de blend pour les transitions rest↔oneshot |
| `speed` | 1.0 | Vitesse de lecture |

### Différence crossfade vs transition

- **Crossfade** (rest loop) : blend des N dernières frames avec les N premières pour un loop seamless
- **Transition** (rest↔oneshot) : blend linéaire smoothstep entre deux positions statiques sur N frames

## deviceParallax.ts

Wrapper pour l'API DeviceOrientation avec gestion de permission iOS et lissage EMA. Fournit des offsets normalisés [-1, 1] à partir de l'inclinaison du téléphone.

### Configuration

| Paramètre | Défaut | Rôle |
|-----------|--------|------|
| `sensitivity` | 6 | Angle max (degrés) mappé sur offset ±1. Bas = très réactif |
| `smoothing` | 0.8 | Facteur EMA (0 = brut, 1 = figé) |

### Gestion des axes en paysage

Détecte `screen.orientation.angle` à chaque événement :
- **Portrait** (0°) : gamma → X, (beta - 45) → Y
- **Landscape** (90°/270°) : (beta - 45) → X, -gamma → Y, avec inversion du signe selon le côté de rotation

### API

```typescript
class DeviceParallax {
  constructor(options?: { sensitivity?: number, smoothing?: number })
  requestPermission(): Promise<boolean>  // Requis sur iOS 13+ (geste utilisateur)
  start(): void
  stop(): void
  getOffset(): { offsetX: number, offsetY: number }  // Appeler chaque frame
  destroy(): void
  get hasPermission(): boolean
  static get isAvailable(): boolean
  static get needsPermission(): boolean  // true sur iOS
}
