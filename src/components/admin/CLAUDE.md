# Workflow Admin (8 étapes)

Interface à onglets dans `AdminPage.tsx` pour configurer un projet. Pipeline "contour-first" avec coordonnées curvilignes : on ne tracke que 4-5 points caractéristiques du contour, les points intermédiaires sont calculés par coordonnée curviligne sur le contour Canny détecté à chaque frame.

## Fichiers

| Fichier | Étape | Rôle |
|---------|-------|------|
| `ImportStep.tsx` | 1 | Upload image coloriage + vidéo animation |
| `CannyValidationStep.tsx` | 2 | Preview edges Canny sur vidéo + réglage seuils |
| `ContourAnchorsStep.tsx` | 3 | Placement 4-5 points caractéristiques contour avec auto-snap Canny |
| `ContourSubdivisionStep.tsx` | 4 | Définition points intermédiaires + calcul par frame via Canny |
| `ContourTrackingStep.tsx` | 5 | Tracking anchors contour par optical flow + keyframes |
| `AnchorPointsStep.tsx` | 6 | Placement points d'ancrage intérieurs (features) |
| `AnchorTrackingStep.tsx` | 7 | Tracking ancres par optical flow + keyframes |
| `TriangulationStep.tsx` | 8 | Triangulation + animation finale (Delaunay + barycentrics + preview) |

## Étape 1 — Import (`ImportStep.tsx`)

- Upload image (PNG/JPEG) → `project.originalImageBlob`
- Upload vidéo (MP4/WebM) → `project.videoBlob`

## Étape 2 — Validation Canny (`CannyValidationStep.tsx`)

Preview du **contour externe** détecté par Canny sur la vidéo, frame par frame.

- Lecteur vidéo : play/pause + slider frame par frame
- Overlay : contour externe jaune épais (5px)
- Pipeline Worker : Canny → dilate + close → floodFill → findContours(RETR_EXTERNAL) → plus grand contour
- 3 sliders : seuil bas (10-200), seuil haut (50-400), taille blur (3/5/7)
- Bouton "Valider" → sauvegarde `mesh.cannyParams`
- Initialise `MeshData` si absent

## Étape 3 — Anchors Contour (`ContourAnchorsStep.tsx`)

Prérequis : Canny validé (`cannyParams` défini).

Place 4-5 points **caractéristiques** sur le contour (bout d'aile, pli, sommet). Seuls ces points seront trackés par optical flow.

- Détecte le contour Canny sur l'image originale au montage
- Construit un `ContourSpatialIndex` pour snap rapide
- Auto-snap sur le contour Canny à chaque clic/drag (rayon 30px)
- Sauvegarde → `mesh.contourAnchors`
- Réinitialise les étapes suivantes si les anchors changent

## Étape 4 — Subdivision Contour (`ContourSubdivisionStep.tsx`)

Prérequis : anchors contour définis (étape 3) + Canny validé.

Définit les points intermédiaires entre les anchors caractéristiques et calcule leur mouvement par coordonnées curvilignes sur le contour Canny de chaque frame.

### Phases
1. **define** : Détecte et ordonne le contour Canny sur l'image, génère N points uniformes par segment anchor via `subdivideContour()`
2. **computing** : Boucle sur toutes les frames vidéo via `computeAllSubdivisionFrames()` — détecte Canny, ordonne pixels, place les points à leur coordonnée curviligne `t`
3. **preview** : Preview frame par frame (anchors rouges + subdivision verts + polygone complet)
4. **validated** : Sauvegarde `contourSubdivisionPoints`, `contourSubdivisionParams`, `contourSubdivisionFrames`

### Algorithme par frame
```
1. Détecter contour Canny sur le frame vidéo
2. Ordonner les pixels Canny en chaîne continue (orderContourPixels)
3. Pour chaque anchor, trouver le point le plus proche sur la chaîne
4. Pour chaque segment [anchor_i, anchor_{i+1}] :
   a. Extraire le sous-chemin Canny entre les deux anchors (chemin le plus court sur contour cyclique)
   b. Calculer les longueurs d'arc cumulées le long du sous-chemin
   c. Pour chaque point intermédiaire (segmentIndex=i, t) :
      - t = fraction de longueur d'arc normalisée ∈ (0,1), constante entre frames
      - Recherche binaire du segment contenant t × longueur_totale
      - Interpolation linéaire entre les deux pixels encadrants
   d. Fallback si Canny vide : interpolation linéaire entre les deux anchors
```

## Étape 5 — Tracking Contour (`ContourTrackingStep.tsx`)

Prérequis : subdivision contour définie (étape 4) + Canny validé + vidéo importée.

### Phases
1. **Config** : intervalle keyframes + checkboxes contraintes (anti-saut, voisinage, contour, temporel, outliers, snap-to-contour Canny, spring curviligne)
2. **Tracking** : `precomputeOpticalFlow` sur `contourAnchors` (4-5 points seulement)
3. **Keyframes** : édition/correction via `KeyframeEditor` + `KeyframeTimeline`, propagation via `trackSegment`. Détection Canny par frame pour auto-snap en édition.
4. **Validé** : `contourAnchorTrackingValidated = true`, sauvegarde `contourAnchorKeyframes` + `contourAnchorFrames`

### Preview
Deux modes de preview disponibles pendant l'édition des keyframes :
- **Preview anchors** : interpolation linéaire des keyframes, affichage anchors seuls (instantané)
- **Preview complète** : recalcule les subdivisions Canny par frame via `computeAllSubdivisionFrames`, puis assemble le contour ordonné (anchors + subdivisions intercalés). Affiche anchors rouges + subdivisions verts + polygone complet jaune

## Étape 6 — Ancres Internes (`AnchorPointsStep.tsx`)

Prérequis : tracking contour validé (`contourAnchorTrackingValidated`).

- Points features intérieurs uniquement (yeux, ailes, queue...)
- Contour complet `[...contourAnchors, ...contourSubdivisionPoints]` affiché en overlay lecture seule
- Auto-détection + densité ajustable
- Sauvegarde → `mesh.anchorPoints`

## Étape 7 — Tracking Ancres (`AnchorTrackingStep.tsx`)

Prérequis : tracking contour validé + ancres définies.

Même structure que l'étape 5 mais pour les ancres internes :
- Config contraintes (anti-saut, voisinage, temporel, outliers — pas de contour)
- Tracking → keyframes → édition → validation
- Sauvegarde `anchorKeyframes` + `anchorFrames`

## Étape 8 — Triangulation + Animation (`TriangulationStep.tsx`)

Prérequis : tracking ancres validé.

### Triangulation
- Points trackés = `[...contourAnchors, ...anchorPoints]` (lecture seule)
- Contour complet = `[...contourAnchors, ...contourSubdivisionPoints]` pour filtrage polygon
- L'utilisateur ajoute des **points internes** (auto-grille ou manuels)
- Delaunay sur `[...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internals]`, filtré par contour polygon
- **Verrouiller la topologie** :
  1. Delaunay sur tracked seuls → `trackedTriangles`
  2. Pour chaque point interne → `computeAllBarycentrics` → `internalBarycentrics`
  3. Met `topologyLocked = true`
- **Bouton PDF** (appelle `generateTemplatePDF`)

### Animation
- Bouton "Calculer l'animation" → assemble `videoFramesMesh` par frame :
  ```
  allPoints[f] = [...contourAnchorFrames[f], ...contourSubdivisionFrames[f], ...anchorFrames[f], ...interpolatedInternals]
  ```
- Preview : vidéo + overlay maillage animé (play/pause/rewind)
- Sauvegarde `videoFramesMesh` dans Storage

## Convention d'indexation

```
allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
tracked   = [...contourAnchors, ...anchorPoints]  // Optical flow
contour   = [...contourAnchors, ...contourSubdivisionPoints]  // Polygone fermé
```
