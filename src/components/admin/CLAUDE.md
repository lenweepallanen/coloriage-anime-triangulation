# Workflow Admin (10 étapes rest / 6 étapes oneshot / 1 étape physics)

Interface dans `AdminPage.tsx` pour configurer un projet **multi-animation**. Pipeline "contour-first" avec coordonnées curvilignes : un point d'origine P0 définit s=0, on tracke 4-5 points caractéristiques du contour par extrema de courbure CSS, les points intermédiaires sont calculés par coordonnée curviligne sur le contour Canny détecté à chaque frame.

Navigation via **pipeline stepper numéroté** (cercles connectés, états done/active/pending dérivés du mesh). Section import projet (image, vidéo fond, son ambiance) au-dessus de la ligne d'actions rapides. Ligne d'actions rapides : encadré Animations (pills), encadré PDF orange (téléchargement dès l'import image), encadré Scanner bleu (lien scan).

## Multi-animation

`AdminPage` gère un sélecteur d'animation (`AnimationManager`) en haut de la page. Les step components reçoivent un `ProjectStepView` (adapter pattern) et ne connaissent pas le multi-animation. Les physics animations utilisent un composant dédié (`PhysicsAnimationEditor`).

- **Rest animation** : pipeline complet 10 étapes, seule autorisée à modifier la géométrie
- **Oneshot animations** : pipeline réduit 6 étapes (Import vidéo + tracking uniquement), géométrie héritée de rest
- **Physics animations** : 1 seule étape (Code Editeur), code JS qui transforme les vertices, pré-calcul à la validation
- **Walk animations** : pipeline 6 étapes (séparation membres, maillage zones, face cachée, squelette, paramètres, calcul), marche procédurale quadrupède

### Propagation géométrie partagée

Quand la géométrie change sur la rest animation (steps 3, 5, 6, 8, 10 topology), les champs partagés (`SHARED_GEOMETRY_FIELDS`) sont copiés vers les oneshots/physics et leur tracking est invalidé (les frames pré-calculées des physics sont effacées).

## Fichiers

| Fichier | Étape | Rôle |
|---------|-------|------|
| `ProjectImportSection.tsx` | — | Import assets projet (image, vidéo fond, son ambiance) avec toggle activer/désactiver |
| `AnimationManager.tsx` | — | Sélecteur/gestion animations (ajout oneshot/physics, suppression, renommage, toggle type) |
| `AdminPreview.tsx` | — | Preview live PIXI.js de l'animation dans le split-panel admin (sans physique tactile) |
| `BodyZoneEditor.tsx` | — | Éditeur de zones corporelles (sélection triangles, peinture, rectangle) |
| `PhysicsAnimationEditor.tsx` | Code Editeur | Éditeur code JS + preview PIXI temps réel + pré-calcul frames |
| `ImportStep.tsx` | 1 | Upload vidéo d'animation (+ son optionnel pour oneshot) |
| `CannyValidationStep.tsx` | 2 | Preview edges Canny sur vidéo + réglage seuils |
| `ContourOriginStep.tsx` | 3 | Placement du point d'origine P0 sur le contour |
| `ContourOriginTrackingStep.tsx` | 4 | Tracking P0 par optical flow + snap-to-contour |
| `ContourAnchorsStep.tsx` | 5 | Placement 4-5 points caractéristiques contour avec auto-snap Canny |
| `ContourSubdivisionStep.tsx` | 6 | Définition points intermédiaires + calcul par frame via Canny |
| `ContourTrackingStep.tsx` | 7 | Placement déterministe par coordonnée curviligne + snap extrema courbure CSS |
| `AnchorPointsStep.tsx` | 8 | Placement points d'ancrage intérieurs (features) |
| `AnchorTrackingStep.tsx` | 9 | Tracking ancres par optical flow + keyframes |
| `TriangulationStep.tsx` | 10 | Triangulation + animation finale (Delaunay + ARAP + preview) |
| `WalkBoneEditorStep.tsx` | Walk 1 | Placement 18 keypoints du squelette quadrupède (6 groupes : 4 pattes + cou/tête + queue) |
| `WalkLimbEditorStep.tsx` | Walk 2 | Définition zones pattes par courbes Bézier fermées + séparation limb/corps |
| `WalkZoneMeshStep.tsx` | Walk 3 | Édition maillage par zone : limb (Delaunay auto + internals) + corps (fixe + patch manuel : ajouter/relier/déplacer) |
| `WalkHiddenFaceStep.tsx` | Walk 4 | Face cachée : sélection 2 vertices body (A/B), bridge points manuels, Delaunay dans polygone fermé, fusion dans body mesh. Texture auto-générée par diffusion Laplacienne au scan. |
| `WalkParamsStep.tsx` | Walk 5 | Paramètres cinématiques (longueur pas, levée pied, balancement corps/tête, phases) |
| `WalkComputeStep.tsx` | Walk 6 | Calcul animation par LBS séparé (zones + body) + legacy unifié, preview wireframe/gradient |
| `MarkerStep.tsx` | support | Placement des 4 marqueurs L pour le scan |
| `PdfStep.tsx` | support | Génération et téléchargement du PDF coloriage |

## AnimationManager (`AnimationManager.tsx`)

Composant de gestion multi-animation dans l'encadré "Animations" de l'AdminPage :
- Barre de pills : une animation par pill, badge couleur (vert=rest, orange=oneshot, violet=physics)
- **Ajout** : deux boutons ghost `+ Oneshot` et `+ Physics`, copie la géométrie partagée depuis la rest (`copySharedGeometry`)
- **Suppression** : uniquement les oneshots/physics (rest est obligatoire), avec confirmation
- **Renommage** : double-clic pour édition inline
- **Toggle type** : bascule rest↔oneshot (enforce exactement 1 rest), masqué pour physics
- Exporte `SHARED_GEOMETRY_FIELDS` et `copySharedGeometry()` pour la propagation
- Encadré dans une section card avec label "ANIMATIONS" en small caps

## PhysicsAnimationEditor (`PhysicsAnimationEditor.tsx`)

Éditeur de code JS pour les animations physiques. Reçoit `{ project, animation, onSave }` directement (pas le pattern adapter).

### Layout
- **Textarea** monospace pour le code JS
- **Erreur** compilation/exécution en rouge sous le textarea
- **Durée** : slider 0.5–5s (défaut 2s), 24fps fixe
- **Checkbox overlay** : "Superposer rest loop" — si coché, l'animation se superpose instantanément à la rest loop
- **Preview** : canvas PIXI avec le maillage rest, code appliqué en temps réel (debounce 300ms)
- **Boutons** : Play/Pause, Reset, Sauvegarder le code, Valider et pré-calculer

### Modèle d'exécution

Le code est le body d'une fonction avec les paramètres : `positions` (Point2D[] à muter), `time` (secondes), `frameIndex`, `totalFrames`, `numVertices`, `progress` (0 à 1). Exécuté via `new Function()`.

### Pré-calcul

"Valider et pré-calculer" exécute le code pour `duration × 24` frames, stocke le résultat dans `mesh.videoFramesMesh`. Après pré-calcul, l'animation est identique à un oneshot pour le playback.

### Prérequis

La rest animation doit avoir une triangulation calculée (topologie verrouillée) pour que les positions de base et les triangles soient disponibles.

## AdminPreview (`AdminPreview.tsx`)

Preview live PIXI.js intégrée dans le split-panel droit de `AdminPage`. Rendu du maillage animé avec l'image PNG originale comme texture (pas de scan nécessaire).

- **Props** : `{ project: Project, style?: CSSProperties }`
- **Texture** : `originalImageBlob` → Image → canvas offscreen → PIXI.Texture (UVs directs, pas de contentAlignment)
- **Animation** : `MultiAnimationPlayback` (rest loop + oneshots + physics overlays) ou `LoopPlayback` si aucun
- **Contrôles** : play/pause, boutons oneshot/physics
- **Son ambiance** : joué en boucle si `project.ambientSoundBlob` et `ambientSoundEnabled`, synchronisé avec play/pause via `ambientAudioRef`
- **Performance** : FPS capé à 30 (`app.ticker.maxFPS`), `ResizeObserver` pour le redimensionnement
- **Pas de** : physique tactile, fullscreen, landscape lock, parallax gyroscope

## BodyZoneEditor (`BodyZoneEditor.tsx`)

Éditeur de zones corporelles. Canvas interactif pour assigner des triangles du maillage à des zones labellisées.

- **Prérequis** : topologie verrouillée sur la rest animation
- **Layout** : canvas (gauche) + panneau liste zones (droite)
- **Canvas** : image originale en fond, triangles colorés par zone, wireframe gris
- **Sélection** : clic sur triangle (toggle), drag pour peindre, rectangle de sélection (drag dans le vide), clic droit pour retirer
- **Zones** : ajout/suppression, couleur configurable, label éditable (double-clic), compteur triangles
- **Sauvegarde** : `project.bodyZones` mis à jour via `onSave`
- **Zoom/Pan** : réutilise `useCanvasInteraction`

## Import projet (`ProjectImportSection.tsx`)

Carte au-dessus de la barre animations. Import des assets niveau projet :
- **Image coloriage** (PNG/JPEG) → `project.originalImageBlob`
- **Vidéo de fond** (MP4/WebM, optionnel) → `project.backgroundVideoBlob`
- **Son d'ambiance** (MP3/WAV/OGG, optionnel) → `project.ambientSoundBlob` + checkbox `ambientSoundEnabled`

Props : `{ project: Project, onSave }`. Sauvegarde directe avec hints `'image'`, `'backgroundVideo'`, `'ambientSound'`.

## Étape 1 — Vidéo (`ImportStep.tsx`)

- Upload vidéo d'animation (MP4/WebM) → `animation.videoBlob`
- **Oneshot** : + section son optionnel (MP3/WAV/OGG) → `animation.audioBlob`
- Prop `isRestAnimation?: boolean` contrôle la visibilité de la section audio

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

Place des points **caractéristiques** sur le contour (bout d'aile, pli, sommet). **P0 est automatiquement inclus comme premier anchor** à la sauvegarde — l'admin ne voit et ne place que les anchors supplémentaires.

- Détecte le contour Canny sur l'image originale au montage, calcule les arc-lengths
- **Auto-snap unbounded** : chaque clic/drag est snappé au pixel Canny le plus proche (sans limite de distance, `nearestUnbounded`)
- **Auto-détection par courbure** : `detectCurvatureExtrema` (single-scale, top N). Slider nombre de points (4-20, défaut 6). Candidats trop proches de P0 (< 20px) filtrés. Candidats restants affichés en orange (taille/opacité proportionnelle au score).
- **Tri par ordre contour** : les anchors sont automatiquement triés par position le long du contour ordonné (`computeInitialAnchorArcLengths`)
- Sauvegarde → `mesh.contourAnchors` = `[P0, ...anchors]`
- Réinitialise les étapes suivantes si les anchors changent (subdivision, tracking contour, topologie)

## Étape 6 — Subdivision Contour (`ContourSubdivisionStep.tsx`)

Prérequis : anchors contour définis (étape 5) + Canny validé.

Définit les points intermédiaires entre les anchors caractéristiques. **Placement statique seulement** (frame 0 sur l'image) — le calcul par frame via `computeAllSubdivisionFrames` est fait à l'étape 10.

- Détection Canny sur l'image originale, réordonnancement depuis P0 via `reorderContourFromOrigin`
- `subdivideContour(orderedContour, contourAnchors, countsPerSegment)` génère N points uniformes par segment (en arc-length)
- **Compteur par segment** : +/- individuel pour chaque segment `[anchor_i → anchor_{i+1}]`, défaut 3 par segment
- **Compteur global** : +/- pour tous les segments simultanément
- Clic sur un segment = surbrillance verte
- Bouton "Recalculer preview contour" pour forcer la re-détection Canny
- Sauvegarde → `contourSubdivisionPoints`, `contourSubdivisionParams` (les `{segmentIndex, t}`)
- Ne sauvegarde PAS de frames — les `contourSubdivisionFrames` et `contourCannyFrames` sont calculées et sauvegardées à l'étape 10

### Algorithme de subdivision par frame (utilisé à l'étape 10 via `computeAllSubdivisionFrames`)
```
1. Détecter contour Canny sur le frame vidéo (coords vidéo)
   — OpenCV findContours retourne déjà des pixels ordonnés (pas besoin de orderContourPixels)
2. Convertir pixels Canny de coords vidéo → coords image
3. Réordonner depuis P0 tracké (reorderContourFromOrigin)
4. Pour chaque segment [anchor_i, anchor_{i+1}] :
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

### Optimisation : cache Canny
Si `mesh.contourCannyFrames` est disponible (calculé à l'étape 6), les contours Canny pré-calculés sont réutilisés directement, évitant la détection Canny et le chargement du Worker OpenCV. Gain de performance significatif.

### Optimisation : index spatial
Utilise `ContourSpatialIndex.nearestWithIndex()` au lieu de recherches linéaires pour le snap-to-contour et la recherche de voisins. Retourne l'index dans le contour pour retrouver la position curviligne.

### Phases
1. **Ready** : 2 modes au choix — "s fixe" (anchorS constants) ou "proche en proche" (anchorS mis à jour)
2. **Computing** : boucle sur frames, détection Canny (ou cache) + extrema CSS + placement + snap
3. **Preview** : preview frame par frame, drag anchors pour corriger, "Propager avant" depuis une frame éditée
4. **Validated** : `contourAnchorTrackingValidated = true`, sauvegarde `contourAnchorKeyframes` + `contourAnchorFrames`
   - Deux boutons post-validation : "Reediter frame par frame" (reprend l'édition sans réinitialiser) et "Reinitialiser depuis zero" (reset complet)

### Algorithme par frame
```
1. Obtenir contour Canny (cache ou détection live sur frame vidéo)
2. Si live : convertir pixels vidéo → coords image
3. Réordonner depuis P0 tracké (OpenCV retourne déjà ordonné)
4. Construire ContourSpatialIndex pour recherche rapide
5. Calculer arc-lengths normalisés
6. Détecter extrema de courbure CSS (detectGlobalCurvatureExtrema)
7. Pour chaque anchor :
   a. Position brute = interpolateAtArcLength(ordered, arcLengths, anchorS[a])
   b. Extremum tracké = extrema[anchorExtremumIdx[a]]
   c. Si distance < 15px → snap complet vers extremum
   d. Si distance < 40px → blend partiel
   e. Sinon → perdu, fallback position brute
8. Re-snap non-perdus sur pixel Canny le plus proche (via ContourSpatialIndex.nearestWithIndex)
9. Mode step-by-step : mettre à jour anchorS depuis position snappée
```

### Preview contour complet
Bouton "Preview contour complet" → appelle `computeAllSubdivisionFrames()` avec les dimensions image et le cache Canny pour recalculer les subdivisions. Affiche anchors rouges + subdivisions verts + polygone complet jaune.

## Étape 8 — Ancres Internes (`AnchorPointsStep.tsx`)

Prérequis : tracking contour validé (`contourAnchorTrackingValidated`).

- Points features intérieurs uniquement (yeux, ailes, queue...)
- Contour complet `[...contourAnchors, ...contourSubdivisionPoints]` affiché en overlay lecture seule
- Auto-détection + densité ajustable
- Sauvegarde → `mesh.anchorPoints`

## Étape 9 — Tracking Ancres (`AnchorTrackingStep.tsx`)

Prérequis : tracking contour validé + ancres définies.

Même structure que les étapes de tracking mais pour les ancres internes :
- Contraintes **hardcodées** (pas de config UI) : anti-saut ON, voisinage ON (topologie chaînée `[i, i+1, i+2]`), temporel OFF, outliers OFF
- Tracking (`precomputeOpticalFlow`) → keyframes → édition frame par frame → propagation (`trackSegment`) → validation
- Sauvegarde `anchorKeyframes` + `anchorFrames` (interpolés via `propagateKeyframes`)

## Étape 10 — Triangulation + Animation (`TriangulationStep.tsx`)

Prérequis : tracking contour validé. Tracking ancres internes optionnel (si absent, les ancres gardent leur position initiale).

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

### Animation (ARAP uniquement)

Bouton "Calculer Animation" → `handleComputeARAP` :
  1. Appelle `computeAllSubdivisionFrames` avec cache Canny (`mesh.contourCannyFrames`) si disponible, sinon détection live
  2. Si `anchorFrames` absent → utilise les positions initiales pour toutes les frames
  3. Ne charge le Worker OpenCV que si le cache Canny n'est pas disponible
  4. Pose de repos = positions frame 0 originales de `allPoints` (pas les positions trackées)
  5. Points pinnés = tous sauf `internalPoints` (contourAnchors + subdivision + anchorPoints)
  6. `precomputeARAP(allPoints0, triangles, pinnedIndices)` — poids cotangent + factorisation Cholesky
  7. `batchSolveARAP(system, pinnedFrames)` — résolution itérative par frame (rotation polaire + Cholesky)
  8. Lissage temporel optionnel (`applyTemporalSmoothing`, fenêtre configurable slider, défaut 3)

### Preview
- 3 modes d'affichage : **vidéo** (wireframe vert sur vidéo), **wireframe** (fond sombre), **gradient** (triangles colorés HSL par centroïde)
- Loop seamless via `LoopPlayback` avec **crossfade configurable** (slider 0-20 frames, défaut 7)
- Play/pause + slider frame + rewind
- Vertices colorés par catégorie : rouge (contour anchors), jaune (subdivision), cyan (anchors internes), blanc (internes)
- Sauvegarde `videoFramesMesh` dans Storage

## Pipeline Triangulation Projet (4 étapes)

Section séparée dans `AdminLayout` (onglet "Triangulation"), gérée par `TriangulationSection.tsx`. Pipeline indépendant du pipeline rest/oneshot.

| Fichier | Étape | Rôle |
|---------|-------|------|
| `TriangulationSection.tsx` (pages/admin/) | — | Layout + stepper 4 étapes + ReferenceImageStep inline |
| `ProjectTriangZonesStep.tsx` | 2 | Placement clics SAM 2 par zone (body + 4 pattes) sur image réf → masques → contours lissés |
| `ProjectTriangMeshStep.tsx` | 3 | Maillage par zone en 2 phases : contour subdivision → triangulation intérieure. Z-order éditable. |
| `ProjectTriangHiddenFaceStep.tsx` | 4 | Faces cachées body/limb : sélection A/B boundary + bridge points + Delaunay |
| `MembersBonesTriangulationStep.tsx` | — | Calcul animation members-bones par zone (auto-weights + LBS) → `walkZoneFrames`/`walkBodyFrames` |

### ProjectTriangZonesStep (Étape 2 — Zones SAM 2)

- Sélecteur zone active (5 boutons colorés : Body, Patte AVG/AVD/ARG/ARD)
- Clic = placer prompt foreground, Shift+clic = background, clic droit = supprimer
- Encode l'image comme faux WebM 1-frame (`encodePngAsFakeMp4`) pour l'API SAM 2
- Passe `videoDimensions` connu pour bypass `readVideoDimensions` (le faux WebM peut être invalide pour `<video>`)
- Extraction contours + lissage gaussien + bridge body-legs

### ProjectTriangMeshStep (Étape 3 — Maillage par zone)

**4 sous-phases par zone** (curvilignes, alignées sur le pipeline rest) :
1. **Placement P0** : clic sur le contour lissé avec snap sur top-20 extrema de courbure (`detectCurvatureExtrema`). Définit `s=0` de la zone. Sauvegarde `zoneOrigins[zoneId]`.
2. **Anchors contour** : auto-détection par courbure (slider 4-20 pts, P0 inclus comme [0]) + édition manuelle (add/drag/delete). Tri par arc-length depuis P0. Sauvegarde `zoneAnchors[zoneId]`.
3. **Subdivision** : compteurs +/- par segment (`anchor_i → anchor_{i+1}`) et global. Utilise `subdivideContour` pour produire les points + params curvilignes. Sauvegarde `zoneSubdivisionPoints/Params[zoneId]`.
4. **Triangulation** : Delaunay sur `[P0, subdivs_seg0, anchor_1, subdivs_seg1, ..., anchor_N, subdivs_segN]` (contour fermé) + points internes auto (densité slider) + manuels. "Rééditer contour" pour revenir à la phase 1/2/3.

**Invariant d'indexation** : `zonePoints[zoneId]` est ordonné `[...contour_curviligne, ...internes]`. `zoneContourLength[zoneId]` = N premiers indices (contour pinned en ARAP V3). Cet ordre rend les faces cachées et l'animation V3 naturellement alignées.

**Filtrage body (trous aux pattes)** : après le Delaunay body, tout triangle dont au moins un sommet est dans un contour de patte validé est supprimé. Les points internes orphelins sont aussi supprimés par compaction (réindexation). Crée des trous larges sous les pattes, comblés en étape 4 ou par patch manuel.

**Patch body (Ajouter / Relier / Déplacer)** : en phase 4 du body, 3 modes pour combler les trous (même pattern que `WalkZoneMeshStep`) :
- **Ajouter** : clic = nouveau point connecté aux 2 plus proches vertices (`findTwoNearest`)
- **Relier** : clic 1 = ancre (orange), clic 2+ = triangles chaînés
- **Déplacer** : drag des points manuels (cyan)
Points manuels en cyan, triangles manuels intégrés au mesh body. Reset automatique si la densité body change.

**Z-order** : champ numérique par zone dans le panneau latéral. Sauvé sur `SAM2Zone.zOrder`, propagé au renderer via `buildPseudoSeparation()`.

**Persistance** : `zoneOrigins` + `zoneAnchors` + `zoneSubdivisionPoints/Params` + `zonePoints`, `zoneTriangles`, `zoneDensity`, `zoneContourLength`, flags `zoneOriginsValidated`/`zoneAnchorsValidated`/`zoneSubdivisionValidated`. Invalidation cascade : revalider P0 vide anchors/subdivision/triangulation aval.

### ProjectTriangHiddenFaceStep (Étape 4 — Faces cachées)

Même pattern que `WalkHiddenFaceStep` : body mode (face cachée derrière patte) + limb mode (extension patte sous corps). Utilise `triangulateHiddenFace()` / `triangulateHiddenFaceLimb()` de `limbSeparation.ts`.

### MembersBonesTriangulationStep

Calcul de l'animation par zone : auto-weights (distance inverse) + LBS. Produit `walkZoneFrames` + `walkBodyFrames` consommés par `AnimationPlayer` / `ScenePlayer` via `zoneMeshRenderer`.

## Composants support

### MarkerStep.tsx
Place les 4 marqueurs L aux coins de l'image pour la détection au scan. Auto-placement avec 20px de marge. Sauvegarde → `project.markers`.

### PdfStep.tsx
Génère et télécharge le PDF coloriage avec image + overlay maillage + marqueurs L. Utilise `generateTemplatePDF()`. Preview dans iframe avant téléchargement.

## Pipeline Members-Bones V2 (15 étapes)

Variante qui sépare le calcul corps et pattes pour permettre l'attachement d'un hip de patte à un vertex du maillage corps animé (`Sam2LegBone.hipBodyVertexIndex`), et qui insère 3 lissages aux frontières de données (entrées anchors, sortie maillage corps, sortie maillage pattes). Partage les étapes 1-8 avec la V1 members-bones.

| Fichier | Étape | Rôle |
|---------|-------|------|
| `MembersBonesSmoothingStep.tsx` | 9 "Lissage Anchor" (V2) / 10 "Lissage Bones" (V1) | Butterworth sur `sam2ContourAnchorFrames` + `sam2ContourSubdivisionFrames` + `sam2ContourOriginFrames` avec le même cutoff. V1 ignore les deux derniers à la lecture. |
| `MembersBonesV2BodyBoneStep.tsx` | 10 "Bones Corps" | Éditeur body chain uniquement (colonne vertébrale). Valide `sam2BodyBonesValidated` et invalide tout l'aval V2. |
| `MembersBonesV2BodyComputeStep.tsx` | 11 "Calcul Corps" | LBS body via body chain + `projectTriangulation.body*`. Lit les anchors lissés si dispo. Produit `walkBodyFrames`. |
| `MembersBonesV2BodySmoothingStep.tsx` | 12 "Lissage Maillage Corps" (NEW) | Butterworth sur `walkBodyFrames` (chaque vertex corps). Slider cutoff dédié. Toggle preview brut/lissé. Produit `walkBodyFramesSmoothed`. |
| `MembersBonesV2LegBoneStep.tsx` | 13 "Bones Pattes" | Éditeur leg bones uniquement (body chain read-only). Supporte hip par anchor OR par body vertex (`hipBodyVertexIndex`). Preview utilise `walkBodyFramesSmoothed ?? walkBodyFrames`. |
| `MembersBonesV2AnimComputeStep.tsx` | 14 "Calcul Pattes" | LBS pattes par zone. Utilise `walkBodyFramesSmoothed ?? walkBodyFrames` pour les hip body-vertex. Produit `walkZoneFrames`. |
| `MembersBonesV2LegSmoothingStep.tsx` | 15 "Lissage Maillage Pattes" (NEW) | Butterworth sur `walkZoneFrames` zone par zone. Slider cutoff dédié. Toggle preview brut/lissé. Produit `walkZoneFramesSmoothed`. |

**Invalidation silencieuse** : chaque sauvegarde amont remet à `false`/`null` les flags `validated` et les sorties des étapes en aval. Aucun badge ni auto re-run — le stepper affiche "pending" (cercle gris).

## Pipeline Members-Bones V3 (11 étapes)

Refonte majeure qui **hérite toute la topologie** (body + 4 pattes, P0 + anchors + subdivision + vertices internes + triangles + hidden faces) de `projectTriangulation`. Le body est animé par **ARAP** (plus de `bodyChain` LBS). Pré-requis : `project.projectTriangulation?.step3Validated === true` — la création d'une animation V3 est bloquée sinon.

| Fichier | Étape | Rôle |
|---------|-------|------|
| `ImportStep.tsx` | 1 "Vidéo" | Upload vidéo autonome |
| `MembersBonesZonesStep.tsx` | 2 "Zones SAM 2 vidéo" | SAM 2 sur vidéo → masques par frame |
| `MembersBonesContourSmoothingStep.tsx` | 3 "Lissage Contours" | Contours lissés + bridge body-legs + lissage temporel |
| `MembersBonesV3TrackingP0Step.tsx` | 4 "Tracking P0 zones" | Déterministe : `projectTriangulation.zoneOrigins` mappé image→vidéo + snap courbure + continuité |
| `MembersBonesV3TrackingAnchorsStep.tsx` | 5 "Tracking Anchors zones" | Déterministe : anchors+subdivs échantillonnés à `s_i` par arc-length sur contour de chaque frame + snap courbure (anchors) |
| `MembersBonesSmoothingStep.tsx` | 6 "Lissage Anchor Frames" | Butterworth sur origin + anchor + subdivision frames |
| `MembersBonesV3BodyComputeStep.tsx` | 7 "Calc Body ARAP" | `precomputeARAP(bodyPoints, bodyTriangles, pinnedContourIndices)` depuis `projectTriangulation`, solve par frame. Produit `walkBodyFrames` |
| `MembersBonesV2BodySmoothingStep.tsx` | 8 "Lissage Maillage Body" | Butterworth sur `walkBodyFrames` (partagé avec V2) |
| `MembersBonesV2LegBoneStep.tsx` | 9 "Bones Pattes" | Leg bones uniquement (pas de `bodyChain` en V3). Hip par anchor ou body vertex (partagé avec V2) |
| `MembersBonesV2AnimComputeStep.tsx` | 10 "Calc Pattes LBS" | LBS par zone via `projectTriangulation.zonePoints/zoneTriangles`, hip body-vertex via `walkBodyFramesSmoothed ?? walkBodyFrames` (partagé avec V2) |
| `MembersBonesV2LegSmoothingStep.tsx` | 11 "Lissage Maillage Pattes" | Butterworth par zone (partagé avec V2) |

**Différences clés vs V2** :
- Plus de `MembersBonesContourOriginStep`, `MembersBonesContourAnchorsStep`, `MembersBonesContourSubdivisionStep` — hérités de la Triangulation projet.
- Plus de `MembersBonesV2BodyBoneStep` / `MembersBonesV2BodyComputeStep` — ARAP remplace le body chain LBS.
- Solver ARAP body : `computeBodyAnimationARAP(projectTriangulation, smoothedContourFrames, imgW, imgH, vidW, vidH)` dans `membersBonesTriangSolver.ts` — wrappe `arapSolver.precomputeARAP` + `batchSolveARAP` avec les N premiers indices contour (`zoneContourLength['body']`) pinnés.
- Gate création V3 dans `AnimationManager.tsx` : bouton `+ Members-Bones V3` grisé tant que `projectTriangulation.step3Validated !== true`.

## Convention d'indexation

```
allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
tracked   = [...contourAnchors, ...anchorPoints]  // Optical flow (ancres) ou curviligne (contour)
contour   = [...contourAnchors, ...contourSubdivisionPoints]  // Polygone fermé
```
