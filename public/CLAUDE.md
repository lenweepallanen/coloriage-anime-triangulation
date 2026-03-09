# Web Worker OpenCV

## Fichiers

| Fichier | Rôle |
|---------|------|
| `opencv-worker.js` | Worker principal (~780 lignes) — toute la vision par ordinateur |
| `opencv.js` | Bibliothèque OpenCV.js compilée (~8 MB, backup local) |

## Chargement OpenCV

Stratégie multi-fallback :
1. CDN primaire : `https://docs.opencv.org/4.9.0/opencv.js`
2. CDN secondaire : `https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js`
3. Chargement via `importScripts()` dans le Worker
4. Initialisation : détection `cv.Mat`, puis `cv.then()`, puis `cv.onRuntimeInitialized`
5. Polling de secours : 100ms × 100 tentatives max

## Messages supportés

| Type message | Direction | Payload | Réponse |
|-------------|-----------|---------|---------|
| `init` | → Worker | — | `ready` ou `error` |
| `detect` | → Worker | `imageData` | `detect-result` + `corners` |
| `contour` | → Worker | `imageData, density` | `contour-result` + `points` |
| `process` | → Worker | `imageData, predetectedCorners?` | `result` + `imageData 2048×2048` |
| `flow-init` | → Worker | `points: Point2D[]` | `flow-init-done` |
| `flow-frame` | → Worker | `imageData` | `flow-frame-result` + `points` |
| `flow-cleanup` | → Worker | — | `flow-cleanup-done` |

## Algorithmes implémentés

### Détection de coins L (`detectCorners`, lignes ~326-403)

Chaîne de fallback seuillage :
1. Seuils fixes : [50, 70, 90, 110, 130, 150]
2. Otsu automatique
3. Gaussien adaptatif (bloc 51×51)

Filtrage contours : surface (0.0002%–3%), solidité (25%–50%), ratio (<2.5), vertices (5–8), noirceur (<80).

Validation quad : convexité, surface ≥8%, ratio ≤3, dispersion >15%.

### Détection lightweight (`detectCornersLightweight`, lignes ~440-498)

Version rapide pour le feedback caméra temps réel (200ms).

### Correction perspective (`correctPerspective`, lignes ~405-437)

```
src = 4 coins détectés
dst = carré 2048×2048 avec marges 64px
M = getPerspectiveTransform(src, dst)
warpPerspective(src, dst, M, 2048×2048, INTER_LINEAR, fond blanc)
```

### Détection contour (`detectContour`, lignes ~586-651)

Pour l'auto-mesh :
1. Grayscale → seuil 128 → fermeture morphologique → dilatation
2. Trouver contours externes → sélectionner le plus grand
3. Approximation polygonale (epsilon = `arcLength × 0.008 / density`)

### Optical Flow Lucas-Kanade (lignes ~500-577)

```
flowInit(points)     → stocke points initiaux, reset état
flowProcessFrame()   → calcOpticalFlowPyrLK(prev, curr, ...)
                       fenêtre 21×21, pyramide 3 niveaux
                       30 itérations max, epsilon 0.01
                       fallback position précédente si tracking perdu
flowCleanup()        → libère tous les cv.Mat
```

## Variables d'état persistantes (entre messages)

- `flowPrevGray` — frame précédente en niveaux de gris
- `flowPrevPts` — positions précédentes des points
- `flowInitialPoints` — points initiaux du maillage
- `flowWinSize`, `flowMaxLevel`, `flowCriteria` — paramètres LK
