# Scan — Détection, Correction Perspective, Animation

**DA / UX** : ces composants sont rendus dans l'app PLAY. Avant tout ajout ou
modification d'UI visible côté play, lire et respecter la charte
`apps/play/CLAUDE.md` (couleurs, fontes, titres ✦, pilules, cartes soft, safe areas).

Machine d'états dans `ScanPage.tsx` : caméra → ajustement coins → traitement → debug → animation.

**Orientation forcée** : `ScanPage` verrouille l'écran en paysage via `screen.orientation.lock('landscape')` au montage (unlock au démontage). Fallback CSS : `.scan-page` est rotationné de 90° en portrait via `@media (orientation: portrait)`. La page entière est `position: fixed` plein écran.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `CameraView.tsx` | Flux caméra temps réel + détection des 4 viseurs + analyse qualité |
| `CornerAdjustment.tsx` | Ajustement manuel des 4 coins détectés (SVG draggable) |
| `ScanProcessor.tsx` | Hook de traitement : correction perspective + debug pipeline + sauvegarde scan |
| `AnimationPlayer.tsx` | Rendu PIXI.js du maillage texturé animé (sans physique tactile) |
| `ScenePlayer.tsx` | Rendu PIXI.js scène multi-layer parallax + interactions zones corporelles |

## CameraView — Détection temps réel

### Pipeline détection

```
Frame caméra (200ms interval)
  → Downscale max 640px
  → Envoi au Worker OpenCV (detectCornersLightweight)
  → Retour 0-4 coins détectés
  → Matching avec 4 guides (10% marge depuis bords)
  → Seuil matching : 30% de la diagonale
  → Stabilité : 6 frames consécutives avec 4 coins → auto-capture (1s delay)
```

### Analyse qualité image

| Métrique | Seuil | Message si problème |
|----------|-------|---------------------|
| Luminosité | 80–220 | "Image trop sombre" / "Trop de lumière" |
| Contraste | > 25 | "Coins peu visibles" |
| Reflets | < 5% pixels saturés | "Reflet détecté — inclinez le téléphone" |
| Netteté | > 4 (énergie gradient) | "Image floue — stabilisez" |

### Guides visuels

- Guides L aux 4 coins (blanc ou vert si matché)
- Effet glow vert quand matché
- Bordure carrée pointillée quand les 4 sont matchés
- Barre de statut colorée (vert=OK, rouge=éclairage, orange=flou)

### Caméra

- Résolution idéale : 3840×2160
- Crop carré du flux rectangulaire
- Support torche/flash mobile
- Fallback import image si caméra indisponible

## Détection des viseurs (Worker OpenCV)

Repères = 4 **viseurs** (motif de QR code : carré noir 7×7 modules, anneau blanc, carré
noir 3×3), 12 mm, posés DANS l'image à 2 mm de chaque coin sur un carré blanc de 16 mm
(contrat `utils/pdfLayout.ts`). `detectFinders(imageData)` dans `opencv-worker.js` :

1. Gris ; si l'image fait < 1000 px, sur-échantillonnage ×2 (modules ≈ 5 px à 640 px).
2. Binarisations successives (adaptatif gaussien 41/7, adaptatif moyenne 25/5, Otsu, seuils fixes 70/110/150), arrêt dès 4 candidats.
3. Candidat = contour externe (`RETR_TREE`) à 4 sommets convexes, contenant un trou, ET
   (structure emboîtée noir→blanc→noir à centres confondus avec rapports d'aires 49:25:9
   **ou** profil de gris 1:1:3:1:1 sur les deux axes, tolérance 50 % comme ZXing),
   ET anneau autour de la bbox nettement plus clair que l'intérieur (zone blanche).
4. Si > 4 candidats : les 4 de tailles cohérentes formant le plus grand quadrilatère convexe.
5. Sortie : `centers[4]` (TL TR BR BL) + `tagCorners[4][4]` (coins du carré extérieur,
   affinés par `cornerSubPix` si dispo) → message `detect-result { markers, found }`.

Aucun filtre de forme « à seuils » : une lettre, un QR code ou un trait ne satisfont pas
la structure emboîtée / le rapport 1:1:3:1:1 → pas de faux positif par nature. Sur banc
synthétique (page T-Rex, titre noir + encadré QR) : 0 faux quad, 80/80 à 640 px.

## Correction perspective (perspectiveCorrection.ts + Worker)

```
processCapturedImage(blob, markers, imageSize)
  → targets = scanTargetsForImage(imageSize)   // cibles px scan des 16 coins + 4 centres (contrat pdfLayout)
  → worker 'process' { imageData, markers, targets }
      markers.tagCorners (16 pts) → homographie DLT moindres carrés   (strategy 'predetected-16')
      markers.centers seuls (ajustement manuel) → 4 ↔ 4               (strategy 'manual-4')
      pas de markers → detectFinders dans le worker                   (strategy 'detected-16')
  → warpPerspective 2048×2048 : l'image entière occupe (64,64)↔(1984,1984)
```

`contentAlignment` est donc constant : `drawBBox = (64,64)↔(1984,1984)`, `meshBBox` = image
native. Fallback si aucun repère (admin seulement) : crop carré centré à 2048×2048.

## Debug pipeline (ScanProcessor.tsx)

Le hook `useScanProcessor` expose un objet `debugImages: DebugImages | null` avec 4 étapes visuelles :

| Étape | Image | Description |
|-------|-------|-------------|
| 1 | `capturedUrl` | Photo brute prise par la caméra |
| 2 | `raw2048Url` | Image 2048×2048 après correction perspective (avec marges 64px) |
| 3 | `rectifiedUrl` | Image croppée aux dimensions originales (marges retirées) |
| 4 | `meshOverlayUrl` | Image croppée + overlay triangulation frame 0 + bboxes d'alignement (cyan=dessin, jaune=mesh mappé) |
| 5 | LaMa inpainting | Masque (zones pattes) + résultat inpainting (scan sans pattes) — affiché si walk animation présente |

La page ScanPage affiche ces images dans un stage `debug` entre `processing` et `animation`. Un bandeau de statut LaMa indique la phase en cours (Lancement instance / Calcul inpainting / Terminé / Erreur). Le bouton "Lancer l'animation" est désactivé pendant l'inpainting.

### Alignement contenu scan ↔ maillage (ContentAlignment)

Après `enhanceContrast`, le processeur détecte automatiquement la bounding box du dessin sur le scan et la compare à la bounding box du maillage pour calculer un mapping UV précis.

**Pipeline** :
1. `detectDrawingBBoxViaWorker(imageData)` — Worker OpenCV : Otsu + dilate 3×3 + `findContours(RETR_EXTERNAL)` → union des `boundingRect` de tous les contours dont l'aire ≥ 5% du plus gros (préserve les parties détachées du dessin, ignore le bruit isolé)
2. `computeMeshBBox(allPoints)` — min/max sur tous les points du maillage
3. Validation : scale X et Y dans [0.8, 1.2] sinon skip
4. `ContentAlignment { drawBBox, meshBBox }` passé à `AnimationPlayer` via `ScanPage`

**Gardes-fous** :
- Skip si l'aire max < 0.1% du canvas (page blanche)
- Skip si aucun contour significatif retenu
- Skip si ratio scale hors [0.8, 1.2]

**Debug overlay** : l'étape 4 affiche les bboxes en pointillé (cyan = dessin détecté, jaune = mesh mappé) et les triangles/points transformés via l'alignement.

## CornerAdjustment

- SVG overlay sur l'image capturée
- 4 points draggables (touch/pointer)
- Polygone de prévisualisation
- Reset vers coins auto-détectés
- Valider pour lancer la correction perspective

## AnimationPlayer — Rendu PIXI.js + Multi-Animation

### Layout

Layout horizontal plein écran (`position: fixed`, `z-index: 100`) :
- **Gauche** : canvas PIXI (`flex: 1`, fond noir)
- **Droite** : sidebar 220px (180px mobile) avec boutons (Play/Pause, Fullscreen, Fermer) et sliders dans des `<details>` dépliables (Effets visuels)
- **Bas centre** : boutons oneshot/physics flottants (un par animation oneshot ou physics prête, bordure violette pour les physics overlay)

### Multi-animation playback

Prop `animations: Animation[]` reçue de ScanPage. Si des oneshots ou physics ont un `videoFramesMesh`, utilise `MultiAnimationPlayback` au lieu de `LoopPlayback`. Les physics overlay passent `overlay: true` à `OneshotAnimation`.

**Machine d'états** (`multiAnimationPlayback.ts`) :
```
REST_LOOPING → (requestOneshot) → WAIT_LOOP_END → (loop point) → TRANSITION_OUT
TRANSITION_OUT → (7 frames smoothstep blend) → ONESHOT_PLAYING
ONESHOT_PLAYING → (dernière frame) → TRANSITION_IN
TRANSITION_IN → (7 frames smoothstep blend) → REST_LOOPING
```

- **Rest** : boucle infinie via `LoopPlayback` (avec crossfade seamless)
- **Oneshot** : lecture linéaire une seule fois (pas de crossfade interne, pas de loop)
- **Transitions** : blend smoothstep sur `transitionFrames` (défaut 7) entre les positions rest et oneshot
- Boutons oneshot désactivés pendant transition/oneshot (actifs uniquement en `rest` ou `wait`)
- Indicateur visuel de l'état courant

### Pipeline de rendu

```
Image scannée rectifiée
  → PIXI.Texture
  → computeUVs(points, width, height, contentAlignment?) → Float32Array [0,1]
  → Vertices en coordonnées écran (scale + offset)
  → Indices triangles → Uint16Array
  → PIXI.MeshGeometry(vertices, uvs, indices)
  → PIXI.MeshMaterial(texture)
  → PIXI.Mesh → stage
```

Quand `contentAlignment` est fourni, les UVs mappent la bbox du maillage sur la bbox du dessin détecté sur le scan, au lieu du simple `x/width`.

### Scaling responsive

Le mesh est affiché en `Math.min(scaleX, scaleY)` (fit sans déformation), centré dans le canvas. S'adapte à toutes les résolutions d'écran et ratios d'image.

### Boucle d'animation (24 FPS)

```typescript
// À chaque frame :
const positions = multiPlayback.getPositions()  // ou loopPlayback.getPositions()
for (point in positions) {
  verts[i*2]   = point.x * scale + offsetX
  verts[i*2+1] = point.y * scale + offsetY
}
verts.update()  // Sync GPU
// Les UVs ne changent jamais → la texture se déforme avec le maillage
```

### Parallax gyroscope

`DeviceParallax` lit le gyroscope et applique un offset sur le sprite background :
- **Sensitivity** : 6° (angle max pour offset ±1)
- **Smoothing** : 0.8 (EMA)
- **Axes landscape** : détection automatique de `screen.orientation.angle` — swap beta↔gamma en mode paysage (90°/270°)
- **iOS** : bouton "Mouvement" pour `DeviceOrientationEvent.requestPermission()`

### Son d'ambiance

Si `project.ambientSoundBlob` et `project.ambientSoundEnabled` : un `HTMLAudioElement` en boucle est créé au montage, stocké dans `ambientAudioRef`. Synchronisé avec le bouton play/pause via un `useEffect` sur `playing`. Nettoyé (pause + revokeObjectURL) au démontage.

### Contrôles (sidebar)

- Play / Pause, Plein écran, Fermer
- Sliders Visuels : Parallax
- Boutons oneshot/physics : un par animation oneshot ou physics avec `videoFramesMesh` prêt (les boutons overlay restent cliquables même pendant un oneshot)

## ScenePlayer — Rendu scène avec parallax + zones corporelles

### Plans de scène (background + foreground)

Deux plans, rendus dans cet ordre z : **arrière-plan → personnage (+ overlays) → avant-plan → HUD (DOM)** :
- `scene.background` : image ou vidéo (en boucle), derrière le perso. Sprite dans `bgContainer`.
- `scene.foreground` : PNG transparent, devant le perso (donne l'impression que le perso passe derrière des fougères, branches, etc.). Sprite dans `foregroundContainer`.

Les deux plans **partagent les mêmes dimensions** et défilent **1:1 avec la position du perso** (la "caméra" cadre le perso quand le fond est plus large que l'écran) :

```ts
const offsetPx = scenePlayback.backgroundOffsetX * bgScale
backgroundSprite.x = -offsetPx
foregroundSprite.x = -offsetPx
```

Le `bgScale = viewH / background.height` ; les deux sprites sont scalés par `bgScale`. Le `backgroundOffsetX` de `ScenePlayback` est en pixels image du background.

### Détection zones corporelles

Au `pointerdown` pendant l'état `interaction` :
1. Conversion screen → image via `screenToImage`
2. `findTriangleAtPoint` → index du triangle touché
3. Lookup dans `triangleZoneMap` (pré-calculé depuis `project.bodyZones`)
4. Lookup du mapping zone→animation dans `restPoint.zoneAnimationMappings`
5. Si mapping trouvé → `multiPlayback.requestOneshot(animationId)`

Les positions courantes (`latestPositions`) sont mises à jour à chaque frame du ticker pour un hit-test précis sur le mesh déformé.
