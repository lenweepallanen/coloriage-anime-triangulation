# Composants Keyframes

Éditeur de keyframes pour la validation et correction du tracking des anchor points.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `KeyframeTimeline.tsx` | Barre timeline avec marqueurs de keyframes cliquables |
| `KeyframeEditor.tsx` | Éditeur canvas d'une keyframe avec drag des anchors |

## KeyframeTimeline

Barre horizontale affichant les keyframes proportionnellement à leur position dans la vidéo.

- Marqueurs positionnés à `(frameIndex / (totalFrames - 1)) * 100%`
- Clic sur un marqueur → `onSelect(index)`
- Marqueur sélectionné visuellement distinct (classe `selected`)
- Labels avec numéro de frame sous chaque marqueur
- Bornes 0 et totalFrames-1 affichées

## KeyframeEditor

Éditeur canvas interactif pour corriger les positions des anchor points sur une frame vidéo.

### Layout
```
┌─────────────────────────────┬──────────┐
│  Canvas principal (flex: 3) │ Ref      │
│  Frame vidéo + anchors      │ (flex:1) │
│  draggables & numérotés     │ Frame 0  │
└─────────────────────────────┴──────────┘
```

### Canvas principal
- Affiche la frame vidéo correspondante à `frameIndex`
- Overlay des anchor points (convertis image → vidéo coords)
- Points draggables : clic + glisser pour repositionner
- Couleurs : or (normal), jaune (hover), vert (drag)
- Numéros affichés à côté de chaque point
- Pan/zoom via `useCanvasInteraction`
- Info overlay : "Keyframe X / Y" en haut à gauche

### Canvas référence
- Panneau latéral montrant toujours la frame 0
- Vidéo séparée (évite conflits de seek)
- Anchor points numérotés aux positions initiales
- Pas d'interaction (lecture seule)

### Interactions
- **Mouse down** sur anchor → début drag (hit test rayon 10/scale)
- **Mouse move** pendant drag → mise à jour position → `onUpdatePositions`
- **Mouse up** → fin drag
- **Hover** → highlight point survolé (jaune + plus gros)

### Props
```typescript
videoBlob: Blob              // Vidéo source
imageWidth/Height: number    // Dimensions image de référence
frameIndex: number           // Frame à afficher
anchorPositions: Point2D[]   // Positions courantes des anchors
referencePositions?: Point2D[]  // Positions frame 0 (panneau référence)
totalFrames: number
onUpdatePositions: (positions: Point2D[]) => void
onValidate: () => void       // "Valider & Propager"
onValidateOnly?: () => void  // "Valider sans propager"
propagating?: boolean
```

### Conversion de coordonnées
```
Image coords ←→ Video coords :
  vx = (imgX / imageWidth) * videoWidth
  vy = (imgY / imageHeight) * videoHeight
```
Les positions sont stockées en coords image, converties en coords vidéo uniquement pour le rendu.
