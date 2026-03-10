# Pipeline de stabilisation de la triangulation — Optical Flow

## Vue d'ensemble

Le tracking des points du maillage utilise Lucas-Kanade (sparse optical flow) via OpenCV.js dans un Web Worker. Un pipeline de **9 stages** filtre, corrige et régularise les positions à chaque frame pour maintenir un maillage stable.

Fichier : `public/opencv-worker.js`

## Données de référence (1ère frame)

Au premier frame, le système calcule et stocke :

| Donnée | Variable | Usage |
|--------|----------|-------|
| Longueurs d'arêtes | `flowRefEdgeLengths` | Stage 5 : préservation des arêtes |
| Classification couleur | `flowPointClassifications` | Stages 2.5 & 7 : cohérence noir/blanc |
| Géométrie des triangles | `flowRefTriangleData` | Stage 6.5 : aire, angle min, forme |
| Adjacence points | `flowNeighborMap` | Stages 4, 6, 6.6 : voisinage |

## Pipeline par frame

```
Frame vidéo
    │
    ▼
┌─────────────────────────────────────────────┐
│  Lucas-Kanade forward (prev → curr)         │
│  fenêtre 21×21, pyramide 3 niveaux          │
│  30 itérations, epsilon 0.01                │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 1 : Status + Error Threshold         │
│  Rejette si LK status ≠ 1 ou erreur > 12   │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 2 : Forward-Backward Consistency     │
│  LK inverse (curr → prev)                  │
│  Rejette si erreur aller-retour > 1.0 px   │
│  (Kalal et al. 2010)                       │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 2.5 : Cohérence couleur             │
│  Blur gaussien 5×5 du frame courant        │
│  Point "dark" → rejette si pixel > 158     │
│  Point "light" → rejette si pixel < 98     │
│  (threshold 128 ± tolérance 30)            │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 3 : Displacement Cap                 │
│  Rejette si déplacement > 3% de la frame   │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 4 : Median Flow Outlier              │
│  Compare le mouvement aux voisins           │
│  Rejette si déviation > 50% du max disp    │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 5 : Edge Length Preservation         │
│  Pour chaque arête de triangle :            │
│  ratio = longueur courante / référence      │
│  Rejette le pire sommet si ratio hors       │
│  [0.5, 2.0]                                │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 6 : Interpolation Affine            │
│  Points rejetés reconstruits via voisins :  │
│  ≥3 voisins → transformation affine 2D     │
│  1-2 voisins → translation médiane         │
│  0 voisins → freeze position précédente    │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 6.5 : Contraintes géométriques       │
│  Pour chaque triangle :                     │
│  • Aire < 30% ou > 300% de réf → violation │
│  • Angle min < 10° → violation             │
│  Correction : forme idéale (réf centrée +  │
│  mise à l'échelle), blend 50% sur le       │
│  sommet le plus éloigné de l'idéal         │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 6.6 : Lissage Laplacien             │
│  Chaque point → barycentre des voisins     │
│  Blend alpha = 15%                          │
│  Lecture sur snapshot (pas de biais)        │
└─────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────┐
│  Stage 7 : Color Snap                       │
│  Vérification finale couleur de chaque pt  │
│  Si mauvaise couleur :                      │
│  → recherche du pixel correct le plus      │
│    proche (rayon 20px, anneaux concentriq.) │
│  → sinon freeze position précédente        │
└─────────────────────────────────────────────┘
    │
    ▼
  finalPoints → flowPrevPts pour le frame suivant
```

## Paramètres tunables

| Paramètre | Valeur | Stage | Rôle |
|-----------|--------|-------|------|
| `FLOW_ERROR_THRESHOLD` | 12.0 | 1 | Seuil d'erreur LK |
| `FLOW_FB_THRESHOLD` | 1.0 px | 2 | Erreur max aller-retour |
| `FLOW_COLOR_THRESHOLD` | 128 | 2.5, 7 | Frontière dark/light (0-255) |
| `FLOW_COLOR_BLUR_SIZE` | 5 | 2.5, 7 | Kernel flou pour échantillonnage |
| `FLOW_COLOR_TOLERANCE` | 30 | 2.5, 7 | Bande de tolérance autour du seuil |
| `FLOW_MAX_DISP_RATIO` | 0.03 | 3 | Déplacement max = 3% de la frame |
| `FLOW_MEDIAN_DEV_RATIO` | 0.5 | 4 | Déviation max = 50% du max disp |
| `FLOW_MIN_EDGE_RATIO` | 0.5 | 5 | Ratio min longueur arête (50%) |
| `FLOW_MAX_EDGE_RATIO` | 2.0 | 5 | Ratio max longueur arête (200%) |
| `FLOW_MIN_AREA_RATIO` | 0.3 | 6.5 | Aire min = 30% de la référence |
| `FLOW_MAX_AREA_RATIO` | 3.0 | 6.5 | Aire max = 300% de la référence |
| `FLOW_MIN_ANGLE_DEG` | 10° | 6.5 | Angle minimum acceptable |
| `FLOW_SHAPE_CORRECTION` | 0.5 | 6.5 | Force de correction vers forme idéale |
| `FLOW_LAPLACIAN_ALPHA` | 0.15 | 6.6 | Force du lissage Laplacien |
| `FLOW_COLOR_SEARCH_RADIUS` | 20 px | 7 | Rayon de recherche du pixel correct |

## Philosophie du pipeline

Le pipeline est organisé en 3 phases :

### Phase 1 — Rejet (Stages 1 → 5)
Élimine les points dont le tracking est douteux. Critères multiples et redondants, du plus sévère (LK status) au plus fin (edge length). Les points rejetés sont marqués mais pas supprimés.

### Phase 2 — Reconstruction (Stage 6)
Reconstruit les positions des points rejetés par interpolation depuis leurs voisins valides. Utilise une transformation affine locale quand possible (≥3 voisins), sinon une translation médiane.

### Phase 3 — Régularisation (Stages 6.5 → 7)
Corrige les positions finales pour maintenir la qualité du maillage :
- **6.5** : contraintes dures sur la géométrie des triangles (aire, angles)
- **6.6** : lissage doux global (Laplacien)
- **7** : contrainte de cohérence couleur (un point noir reste sur du noir)

## Helpers géométriques

| Fonction | Rôle |
|----------|------|
| `triangleArea(a, b, c)` | Aire par produit vectoriel |
| `triangleMinAngle(a, b, c)` | Angle min via loi des cosinus |
| `computeRefTriangleData(pts, tris)` | Pré-calcul aire + angle + sommets de référence |
| `buildNeighborMap(tris, n)` | Graphe d'adjacence depuis les triangles |
| `computeEdgeLengths(pts, tris)` | Longueurs d'arêtes de référence |
| `fitAffine2D(src, dst)` | Ajustement affine 2D (moindres carrés, Cramer) |
| `applyAffine(affine, pt)` | Application de la transformation affine |
| `median(arr)` | Médiane robuste |

## Algorithme de correction de forme (Stage 6.5)

Pour un triangle violant une contrainte :

1. Calculer le centroïde courant C = (A+B+C)/3
2. Calculer l'échelle courante = moyenne des arêtes courantes / moyenne des arêtes de référence
3. Projeter la forme de référence : `idéal[v] = C + (ref[v] - refCentroïde) × échelle`
4. Identifier le sommet le plus éloigné de sa position idéale
5. Corriger : `position += 50% × (idéal - position)`
6. Si plusieurs triangles corrigent le même sommet, les corrections sont moyennées

## Algorithme de Color Snap (Stage 7)

Pour un point sur la mauvaise couleur :

1. Recherche en anneaux concentriques (rayon 1, 2, ... 20 px)
2. Sur chaque anneau, tester les pixels du périmètre
3. Retenir le pixel le plus proche qui matche la bonne couleur
4. Si rien trouvé en 20 px → freeze à la position précédente
