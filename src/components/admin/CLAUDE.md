# Workflow Admin (10 étapes)

Interface à onglets dans `AdminPage.tsx` pour configurer un projet. Pipeline "contour-first" avec coordonnées curvilignes : un point d'origine P0 définit s=0, on tracke 4-5 points caractéristiques du contour par extrema de courbure CSS, les points intermédiaires sont calculés par coordonnée curviligne sur le contour Canny détecté à chaque frame.

## Fichiers

| Fichier | Étape | Rôle |
|---------|-------|------|
| `ImportStep.tsx` | 1 | Upload image coloriage + vidéo animation |
| `CannyValidationStep.tsx` | 2 | Preview edges Canny sur vidéo + réglage seuils |
| `ContourOriginStep.tsx` | 3 | Placement du point d'origine P0 sur le contour |
| `ContourOriginTrackingStep.tsx` | 4 | Tracking P0 par optical flow + snap-to-contour |
| `ContourAnchorsStep.tsx` | 5 | Placement 4-5 points caractéristiques contour avec auto-snap Canny |
| `ContourSubdivisionStep.tsx` | 6 | Définition points intermédiaires + calcul par frame via Canny |
| `ContourTrackingStep.tsx` | 7 | Placement déterministe par coordonnée curviligne + snap extrema courbure CSS |
| `AnchorPointsStep.tsx` | 8 | Placement points d'ancrage intérieurs (features) |
| `AnchorTrackingStep.tsx` | 9 | Tracking ancres par optical flow + keyframes |
| `TriangulationStep.tsx` | 10 | Triangulation + animation finale (Delaunay + barycentrics + preview) |
| `MarkerStep.tsx` | support | Placement des 4 marqueurs L pour le scan |
| `PdfStep.tsx` | support | Génération et téléchargement du PDF coloriage |

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

## Étape 3 — Point 0 Contour (`ContourOriginStep.tsx`)

Prérequis : Canny validé (`cannyParams` défini).

Place un point d'origine **P0** sur le contour Canny. Ce point définit le **s=0** de la paramétrisaton curviligne du contour pour toutes les étapes suivantes.

- Détecte le contour Canny sur l'image originale, overlay jaune
- Clic gauche ou drag pour placer P0, auto-snap Canny (rayon 30px)
- Clic droit pour supprimer P0
- Preview : cercle rose avec label "P0"
- Canvas avec zoom/pan (espace pour grab, molette pour zoom)
- Sauvegarde → `mesh.contourOrigin`, réinitialise les étapes en aval

## Étape 4 — Tracking Point 0 (`ContourOriginTrackingStep.tsx`)

Prérequis : point d'origine P0 défini (étape 3).

Tracke le point P0 sur toutes les frames vidéo par optical flow + snap-to-contour Canny.

### Phases
1. **Config** : bouton "Lancer le tracking"
2. **Tracking** : `precomputeOpticalFlow` sur `[contourOrigin]` (1 seul point), contraintes anti-saut + snap-to-contour
3. **Editing** : édition keyframes, re-track segments (forward/backward/bidirectionnel), snap Canny en édition
4. **Validated** : sauvegarde `contourOriginKeyframes`, `contourOriginFrames`, `contourOriginTrackingValidated = true`

Post-traitement : snap sur Canny toutes les 5 frames pour robustesse.

## Étape 5 — Anchors Contour (`ContourAnchorsStep.tsx`)

Prérequis : Canny validé + P0 tracké.

Place 4-5 points **caractéristiques** sur le contour (bout d'aile, pli, sommet). Seuls ces points seront trackés.

- Détecte le contour Canny sur l'image originale au montage
- Construit un `ContourSpatialIndex` pour snap rapide
- Auto-snap sur le contour Canny à chaque clic/drag (rayon 30px)
- Sauvegarde → `mesh.contourAnchors`
- Réinitialise les étapes suivantes si les anchors changent

## Étape 6 — Subdivision Contour (`ContourSubdivisionStep.tsx`)

Prérequis : anchors contour définis (étape 5) + Canny validé.

Définit les points intermédiaires entre les anchors caractéristiques et calcule leur mouvement par coordonnées curvilignes sur le contour Canny de chaque frame.

### Phases
1. **define** : Détecte et ordonne le contour Canny sur l'image, génère N points uniformes par segment anchor via `subdivideContour()`
2. **computing** : Boucle sur toutes les frames vidéo via `computeAllSubdivisionFrames()` — détecte Canny, convertit coords vidéo → image, ordonne pixels, place les points à leur coordonnée curviligne `t`
3. **preview** : Preview frame par frame (anchors rouges + subdivision verts + polygone complet)
4. **validated** : Sauvegarde `contourSubdivisionPoints`, `contourSubdivisionParams`, `contourSubdivisionFrames`

### Algorithme par frame
```
1. Détecter contour Canny sur le frame vidéo (coords vidéo)
2. Convertir pixels Canny de coords vidéo → coords image
3. Ordonner les pixels Canny en chaîne continue (orderContourPixels)
4. Réordonner depuis P0 tracké (reorderContourFromOrigin)
5. Pour chaque segment [anchor_i, anchor_{i+1}] :
   a. Extraire le sous-chemin Canny entre les deux anchors (chemin le plus court sur contour cyclique)
   b. Calculer les longueurs d'arc cumulées le long du sous-chemin
   c. Pour chaque point intermédiaire (segmentIndex=i, t) :
      - t = fraction de longueur d'arc normalisée ∈ (0,1), constante entre frames
      - Recherche binaire du segment contenant t × longueur_totale
      - Interpolation linéaire entre les deux pixels encadrants
   d. Fallback si Canny vide : interpolation linéaire entre les deux anchors
```

## Étape 7 — Tracking Contour (`ContourTrackingStep.tsx`)

Prérequis : subdivision contour définie (étape 6) + Canny validé + P0 tracké + vidéo importée.

**Approche** : pas d'optical flow. Pour chaque frame, on détecte le contour Canny, on le paramétrise en arc-length depuis P0, et on place chaque anchor à sa coordonnée curviligne `s` normalisée. On snap ensuite vers l'extremum de courbure CSS le plus proche (tracking par identité persistante frame par frame).

### Phases
1. **Ready** : 2 modes au choix — "s fixe" (anchorS constants) ou "proche en proche" (anchorS mis à jour)
2. **Computing** : boucle sur frames, détection Canny + extrema CSS + placement + snap
3. **Preview** : preview frame par frame, drag anchors pour corriger, "Propager avant" depuis une frame éditée
4. **Validated** : `contourAnchorTrackingValidated = true`, sauvegarde `contourAnchorKeyframes` + `contourAnchorFrames`

### Algorithme par frame
```
1. Détecter contour Canny sur frame vidéo
2. Convertir pixels vidéo → coords image
3. Ordonner et réordonner depuis P0 tracké
4. Calculer arc-lengths normalisés
5. Détecter extrema de courbure CSS (trackCurvatureExtrema)
6. Pour chaque anchor :
   a. Position brute = interpolateAtArcLength(ordered, arcLengths, anchorS[a])
   b. Extremum tracké = extrema[anchorExtremumIdx[a]]
   c. Si distance < 15px → snap complet vers extremum
   d. Si distance < 40px → blend partiel
   e. Sinon → perdu, fallback position brute
7. Re-snap non-perdus sur pixel Canny le plus proche
8. Mode step-by-step : mettre à jour anchorS depuis position snappée
```

### Preview contour complet
Bouton "Preview contour complet" → appelle `computeAllSubdivisionFrames()` avec les dimensions image pour recalculer les subdivisions sur le contour Canny de chaque frame. Affiche anchors rouges + subdivisions verts + polygone complet jaune.

## Étape 8 — Ancres Internes (`AnchorPointsStep.tsx`)

Prérequis : tracking contour validé (`contourAnchorTrackingValidated`).

- Points features intérieurs uniquement (yeux, ailes, queue...)
- Contour complet `[...contourAnchors, ...contourSubdivisionPoints]` affiché en overlay lecture seule
- Auto-détection + densité ajustable
- Sauvegarde → `mesh.anchorPoints`

## Étape 9 — Tracking Ancres (`AnchorTrackingStep.tsx`)

Prérequis : tracking contour validé + ancres définies.

Même structure que les étapes de tracking mais pour les ancres internes :
- Config contraintes (anti-saut, voisinage, temporel, outliers — pas de contour)
- Tracking → keyframes → édition → validation
- Sauvegarde `anchorKeyframes` + `anchorFrames`

## Étape 10 — Triangulation + Animation (`TriangulationStep.tsx`)

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
- Bouton "Calculer l'animation" → appelle `computeAllSubdivisionFrames` (avec imageWidth, imageHeight) si pas déjà calculé, puis assemble `videoFramesMesh` par frame :
  ```
  allPoints[f] = [...contourAnchorFrames[f], ...contourSubdivisionFrames[f], ...anchorFrames[f], ...interpolatedInternals]
  ```
- Preview : vidéo + overlay maillage animé (play/pause/rewind)
- Sauvegarde `videoFramesMesh` dans Storage

## Composants support

### MarkerStep.tsx
Place les 4 marqueurs L aux coins de l'image pour la détection au scan. Auto-placement avec 20px de marge. Sauvegarde → `project.markers`.

### PdfStep.tsx
Génère et télécharge le PDF coloriage avec image + overlay maillage + marqueurs L. Utilise `generateTemplatePDF()`. Preview dans iframe avant téléchargement.

## Convention d'indexation

```
allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
tracked   = [...contourAnchors, ...anchorPoints]  // Optical flow (ancres) ou curviligne (contour)
contour   = [...contourAnchors, ...contourSubdivisionPoints]  // Polygone fermé
```
