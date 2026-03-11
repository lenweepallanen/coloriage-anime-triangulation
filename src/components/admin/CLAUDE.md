# Workflow Admin (8 étapes)

Interface à onglets dans `AdminPage.tsx` pour configurer un projet. Pipeline "contour-first" : le contour est défini, validé et tracké en priorité, puis les ancres internes.

## Fichiers

| Fichier | Étape | Rôle |
|---------|-------|------|
| `ImportStep.tsx` | 1 | Upload image coloriage + vidéo animation |
| `ContourDefinitionStep.tsx` | 2 | Placement sommets du contour (auto + manuel) |
| `CannyValidationStep.tsx` | 3 | Preview edges Canny sur vidéo + réglage seuils |
| `ContourTrackingStep.tsx` | 4 | Tracking contour par optical flow + keyframes |
| `AnchorPointsStep.tsx` | 5 | Placement points d'ancrage intérieurs (features) |
| `AnchorTrackingStep.tsx` | 6 | Tracking ancres par optical flow + keyframes |
| `TriangulationStep.tsx` | 7 | Points internes + Delaunay + verrouillage topologie + PDF |
| `FinalAnimationStep.tsx` | 8 | Calcul animation finale via coordonnées barycentriques |

## Étape 1 — Import (`ImportStep.tsx`)

- Upload image (PNG/JPEG) → `project.originalImageBlob`
- Upload vidéo (MP4/WebM) → `project.videoBlob`

## Étape 2 — Contour (`ContourDefinitionStep.tsx`)

Place les sommets du contour sur la frame 0. Tous seront trackés par optical flow.

- Auto-détection via OpenCV (`generateAutoMesh`)
- Densité ajustable (1-10), re-génère live si auto-détecté
- Resample (± 5 points) quand le contour est fermé
- Clic gauche = ajouter, clic sur 1er point = fermer, clic droit = supprimer
- Sauvegarde → `mesh.contourVertices`

## Étape 3 — Validation Canny (`CannyValidationStep.tsx`)

Preview du **contour externe** détecté par Canny sur la vidéo, frame par frame.

- Lecteur vidéo : play/pause + slider frame par frame
- Overlay : contour externe jaune épais (5px) — uniquement la silhouette, pas les traits intérieurs
- Pipeline Worker : Canny → dilate + close → floodFill → findContours(RETR_EXTERNAL) → plus grand contour
- 3 sliders : seuil bas (10-200), seuil haut (50-400), taille blur (3/5/7)
- Bouton "Valider" → sauvegarde `mesh.cannyParams`
- Utilise `flowCannyContour` (RPC vers `extractCannyContour` dans le Worker)

## Étape 4 — Tracking Contour (`ContourTrackingStep.tsx`)

Prérequis : contour défini + Canny validé + vidéo importée.

### Phases
1. **Config** : intervalle keyframes + checkboxes contraintes (anti-saut, voisinage, contour, temporel, outliers, snap-to-contour Canny)
2. **Tracking** : `precomputeOpticalFlow` sur `contourVertices`
3. **Keyframes** : édition/correction via `KeyframeEditor` + `KeyframeTimeline`, propagation segment par segment via `trackSegment`
4. **Validé** : `contourTrackingValidated = true`, sauvegarde `contourKeyframes` + `contourFrames`

## Étape 5 — Ancres (`AnchorPointsStep.tsx`)

Prérequis : tracking contour validé.

- Points features intérieurs uniquement (yeux, ailes, queue...)
- Contour affiché en overlay lecture seule
- Auto-détection + densité ajustable
- Sauvegarde → `mesh.anchorPoints`

## Étape 6 — Tracking Ancres (`AnchorTrackingStep.tsx`)

Prérequis : tracking contour validé + ancres définies.

Même structure que l'étape 4 mais pour les ancres internes :
- Config contraintes (anti-saut, voisinage, temporel, outliers — pas de contour)
- Tracking → keyframes → édition → validation
- Sauvegarde `anchorKeyframes` + `anchorFrames`

## Étape 7 — Triangulation (`TriangulationStep.tsx`)

Prérequis : tracking ancres validé.

- Points trackés = `[...contourVertices, ...anchorPoints]` (lecture seule)
- L'utilisateur ajoute des **points internes** (auto-grille ou manuels)
- Delaunay sur `[...tracked, ...internals]`, filtré par contour polygon
- **Verrouiller la topologie** :
  1. Delaunay sur tracked seuls → `trackedTriangles`
  2. Pour chaque point interne → `computeAllBarycentrics` → `internalBarycentrics`
  3. Met `topologyLocked = true`
- **Bouton PDF** (appelle `generateTemplatePDF`)
- **Déverrouiller** avec avertissement

## Étape 8 — Animation finale (`FinalAnimationStep.tsx`)

Prérequis : topologie verrouillée + contourFrames + anchorFrames.

### Algorithme
```
Pour chaque frame f :
  trackedPositions = [...contourFrames[f], ...anchorFrames[f]]
  internalPositions = internalBarycentrics.map(b => interpolate(b, trackedPositions, trackedTriangles))
  allPoints[f] = [...trackedPositions, ...internalPositions]
```

### UI
- Bouton "Calculer l'animation" → boucle sur toutes les frames
- Barre de progression (yield UI tous les 10 frames)
- Preview : vidéo + overlay maillage animé (play/pause/rewind)
- Sauvegarde `videoFramesMesh` dans Storage
