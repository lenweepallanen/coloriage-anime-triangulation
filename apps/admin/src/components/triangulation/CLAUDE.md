# Éditeur de Triangulation

Éditeur interactif de maillage sur canvas HTML5 avec triangulation de Delaunay.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `TriangulationCanvas.tsx` | Composant principal : rendu canvas, gestion interactions utilisateur |
| `useTriangulation.ts` | Hook état du maillage : points, fermeture contour, calcul Delaunay |
| `useCanvasInteraction.ts` | Hook pan/zoom : transform, conversion coordonnées, ResizeObserver |
| `drawingUtils.ts` | Fonctions dessin canvas et détection hit-test |

## Modèle de données

```typescript
contourPoints: Point2D[]         // Points du contour (ordre séquentiel)
internalPoints: Point2D[]        // Points internes (ordre quelconque)
anchorPoints?: Point2D[]         // Points d'ancrage (contour + features), affichés en overlay
allPoints = [...anchors ?? contour, ...internal]  // Fusion pour indexation Delaunay
triangles: [number, number, number][]  // Indices dans allPoints
contourClosed: boolean           // Verrouillage du contour
```

## Modes d'interaction

### Mode Contour (`mode === 'contour'`)
- **Clic gauche** zone vide → ajouter point contour
- **Clic gauche** sur 1er point (≥3 points) → fermer contour
- **Clic gauche** sur segment contour (fermé) → insérer point sur le bord
- **Double-clic** (≥3 points) → fermer contour
- **Glisser** un point → déplacer
- **Clic droit** sur point → supprimer

### Mode Interne (`mode === 'internal'`)
- **Clic gauche** zone vide → ajouter point interne
- **Glisser** un point → déplacer
- **Clic droit** sur point → supprimer

### Mode Anchor (`mode === 'anchor'`)
- **Clic gauche** zone vide → ajouter point d'ancrage (feature)
- **Glisser** un point → déplacer (contour ou anchor)
- **Clic droit** sur point → supprimer

### Navigation
- **Molette** → zoom (×1.1 / ×0.9) centré sur curseur
- **Espace + glisser** ou **bouton milieu** → pan
- Rayon de hit : `10 / transform.scale` (adaptatif au zoom)

## Algorithme Delaunay

1. Fusion `anchorPoints + internalPoints` (ou `contourPoints + internalPoints` si pas d'anchors) en `Float64Array`
2. Calcul via bibliothèque `Delaunator`
3. **Filtrage** : seuls les triangles dont le centroïde est à l'intérieur du contour sont gardés
4. Test point-in-polygon par ray-casting (`geometry.ts`)
5. Recalcul automatique via `useMemo` quand les points changent

## useTriangulation

Le hook accepte optionnellement `anchorPoints` et `contourIndices` pour le mode anchor-aware :
- Si fournis, `allPoints = [...anchorPoints, ...internalPoints]` pour Delaunay
- Le contour polygon est dérivé de `contourIndices.map(i => anchorPoints[i])`
- Expose `resampleContour(targetCount)` pour ajuster la densité du bord

## Rendu Canvas (drawingUtils.ts)

| Élément | Couleur | Style |
|---------|---------|-------|
| Triangles | `rgba(34, 197, 94, 0.15)` | Fill semi-transparent vert |
| Bords triangles | `rgba(34, 197, 94, 0.5)` | Stroke vert |
| Lignes contour | `rgba(59, 130, 246, 0.6)` | Stroke bleu |
| Points contour | `#3b82f6` | Cercles bleus (6px, 10px hover) |
| Points internes | `#ef4444` | Cercles rouges |
| Points anchor (features) | `#f59e0b` | Cercles or/amber |

### Numérotation des anchors

Quand `showAnchorNumbers` est activé, chaque point affiche un numéro :
- Contour : indices `contourIndexOffset + i` (défaut 0)
- Features : indices `contourPoints.length + i`
- Labels : texte blanc sur fond noir semi-transparent, taille adaptée au zoom

## Transformation (useCanvasInteraction.ts)

```typescript
Transform { offsetX, offsetY, scale }  // scale entre 0.1 et 10

screenToImage(sx, sy) → { x: (sx - offsetX) / scale, y: (sy - offsetY) / scale }
imageToScreen(ix, iy) → { x: ix * scale + offsetX, y: iy * scale + offsetY }
```

`fitToCanvas(imageW, imageH)` : calcule le scale pour afficher l'image entière avec 20px de padding.
