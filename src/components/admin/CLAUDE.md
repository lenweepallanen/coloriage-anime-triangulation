# Workflow Admin (5 étapes)

Interface à onglets dans `AdminPage.tsx` pour configurer un projet.

## Fichiers

| Fichier | Étape | Rôle |
|---------|-------|------|
| `ImportStep.tsx` | 1 | Upload image coloriage + vidéo animation |
| `AnchorPointsStep.tsx` | 2 | Placement points d'ancrage (contour + features) |
| `TriangulationStep.tsx` | 3 | Points internes + Delaunay + verrouillage topologie + PDF |
| `KeyframeValidationStep.tsx` | 4 | Tracking anchors + validation/correction keyframes + propagation |
| `FinalPropagationStep.tsx` | 5 | Calcul animation finale via coordonnées barycentriques |
| `OpticalFlowStep.tsx` | (legacy) | Ancien pré-calcul optical flow brut (conservé mais non utilisé) |

## Étape 1 — Import (`ImportStep.tsx`)

- Upload image (PNG/JPEG) → `project.originalImageBlob`
- Upload vidéo (MP4/WebM) → `project.videoBlob`
- Sauvegarde avec `updateProject(project, ['image'])` ou `['video']`

## Étape 2 — Points d'ancrage (`AnchorPointsStep.tsx`)

Place les anchor points = points structurels qui seront trackés dans la vidéo.

### Deux modes
- **Mode Contour** : placement/édition des points du contour (bleus)
  - Auto-détection via OpenCV (`generateAutoMesh`)
  - Densité contour ajustable (1-10), re-génère live si auto-détecté
  - Resample du bord (± 5 points) quand le contour est fermé
  - Clic gauche = ajouter, clic sur 1er point = fermer, clic droit = supprimer
- **Mode Ancres** : placement des features intérieures (or/amber)
  - Auto-détection des points internes via `generateAutoMesh`
  - Densité ancres ajustable (1-10)
  - Clic gauche = ajouter, glisser = déplacer, clic droit = supprimer

### Données produites
- `anchorPoints = [...contourPoints, ...featureAnchors]`
- `contourIndices = [0, 1, ..., N-1]` (N = nombre de points contour)

### Numérotation
Les anchors sont numérotés sur le canvas : contour 0..N-1 (bleu), features N..N+M-1 (or). Cette numérotation est cohérente avec l'éditeur de keyframes.

### État interne
- `isAutoContour` ref : si vrai, la densité contour re-génère le contour
- `isAutoAnchors` ref : si vrai, la densité ancres re-génère les features
- `featureAnchors` state séparé des contourPoints (du hook useTriangulation)

## Étape 3 — Triangulation (`TriangulationStep.tsx`)

- Reçoit `anchorPoints` en lecture seule depuis le mesh
- L'utilisateur ajoute des **points internes** uniquement (auto-grille ou manuels)
- Delaunay sur `[...anchors, ...internals]`, filtré par contour polygon
- **Bouton "Verrouiller la topologie"** :
  1. Calcule Delaunay sur les anchors seuls → `anchorTriangles`
  2. Pour chaque point interne → `findContainingAnchorTriangle` → `internalBarycentrics`
  3. Met `topologyLocked = true`
- **Bouton PDF** intégré (appelle `generateTemplatePDF`)
- **Bouton "Déverrouiller"** avec avertissement (perte des keyframes/animation)
- Une fois verrouillé : plus de modification de points, UI grisée

## Étape 4 — Keyframes (`KeyframeValidationStep.tsx`)

Prérequis : topologie verrouillée + vidéo importée.

### Tracking initial
1. Configure l'intervalle de keyframes (±5, ex: 10 frames)
2. Checkbox **"Contrainte voisinage"** (activée par défaut) : utilise `anchorTriangles` et `contourIndices` pour stabiliser le tracking via `applyNeighborConstraints` après chaque frame
3. Bouton "Lancer le tracking" → `precomputeOpticalFlow` sur les **anchors seuls** (avec contraintes si activées)
4. Extraction des keyframes aux intervalles → `extractKeyframes()`
5. Résultat stocké dans `rawTrackingRef` (données brutes par frame)

### Timeline (`KeyframeTimeline`)
- Barre avec marqueurs positionnés proportionnellement
- Clic sur un marqueur → ouvre l'éditeur de cette keyframe

### Éditeur (`KeyframeEditor`)
- Canvas principal (flex: 3) : frame vidéo + overlay anchors draggables numérotés
- Canvas référence (flex: 1) : frame 0 avec anchors numérotés (comparaison visuelle)
- Pan/zoom via `useCanvasInteraction`
- Deux boutons :
  - **"Valider & Propager"** : re-tracke via `trackSegment()` (avec contraintes si activées) depuis les positions corrigées vers la keyframe suivante, met à jour `rawTrackingRef` et les positions de la keyframe suivante
  - **"Valider sans propager"** : passe simplement à la keyframe suivante

### Sauvegarde
- `propagateKeyframes(keyframes, totalFrames)` → interpolation linéaire → `anchorFrames`
- Sauvegarde keyframes + anchorFrames dans Storage

## Étape 5 — Animation finale (`FinalPropagationStep.tsx`)

Prérequis : topologie verrouillée + anchorFrames calculées.

### Algorithme
```
Pour chaque frame f :
  allPoints[f] = [...anchorFrames[f]]
  Pour chaque point interne i :
    allPoints[f].push(interpolateInternalPoint(bary[i], anchorFrames[f], anchorTriangles))
```

### Composants
- Bouton "Calculer l'animation" → boucle sur toutes les frames
- Barre de progression (yield UI tous les 10 frames)
- `FlowPreview` : prévisualisation avec vidéo + overlay maillage animé (play/pause/rewind)
- Sauvegarde `videoFramesMesh` dans Storage
