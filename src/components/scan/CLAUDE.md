# Scan — Détection, Correction Perspective, Animation

Machine d'états dans `ScanPage.tsx` : caméra → ajustement coins → traitement → debug → animation.

## Fichiers

| Fichier | Rôle |
|---------|------|
| `CameraView.tsx` | Flux caméra temps réel + détection marqueurs L + analyse qualité |
| `CornerAdjustment.tsx` | Ajustement manuel des 4 coins détectés (SVG draggable) |
| `ScanProcessor.tsx` | Hook de traitement : correction perspective + debug pipeline + sauvegarde scan |
| `AnimationPlayer.tsx` | Rendu PIXI.js du maillage texturé animé |

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

## Détection marqueurs L (Worker OpenCV)

### Stratégies de seuillage (fallback chain)

1. **Seuils fixes** : [50, 70, 90, 110, 130, 150] — `THRESH_BINARY_INV`
2. **Otsu automatique** — seuil adaptatif
3. **Gaussien adaptatif** — bloc 51×51, constante 10

### Validation contour L

| Critère | Valeur |
|---------|--------|
| Surface | 0.0002% – 3% de l'image |
| Solidité | 25% – 50% |
| Ratio aspect | < 2.5 |
| Vertices (approx) | 5 – 8 |
| Noirceur moyenne | < 80 |

### Validation quadrilatère

- **Convexité** : tous les produits vectoriels de même signe
- **Surface** : ≥ 8% de l'image
- **Ratio aspect** : ≤ 3
- **Dispersion** : aucun coin < 15% de la distance max au centroïde
- **Intérieur lumineux** : ≥ 50% des 9 points tests > 150

## Correction perspective (perspectiveCorrection.ts + Worker)

```
Coins détectés (centroïdes des L)
  → getPerspectiveTransform(src, dst)
  → dst = carré 2048×2048 avec marges 64px
  → warpPerspective → image rectifiée
  → Crop des marges 64px (zone utile = 1920×1920)
  → Rescale aux dimensions originales de l'image du projet
```

Fallback si aucun coin : crop carré centré + scale à 2048×2048.

## Debug pipeline (ScanProcessor.tsx)

Le hook `useScanProcessor` expose un objet `debugImages: DebugImages | null` avec 4 étapes visuelles :

| Étape | Image | Description |
|-------|-------|-------------|
| 1 | `capturedUrl` | Photo brute prise par la caméra |
| 2 | `raw2048Url` | Image 2048×2048 après correction perspective (avec marges 64px) |
| 3 | `rectifiedUrl` | Image croppée aux dimensions originales (marges retirées) |
| 4 | `meshOverlayUrl` | Image croppée + overlay triangulation frame 0 (triangles verts, anchors rouges, internes bleus) |

La page ScanPage affiche ces 4 images dans un stage `debug` entre `processing` et `animation`, permettant de vérifier visuellement chaque étape du pipeline avant de lancer l'animation.

## CornerAdjustment

- SVG overlay sur l'image capturée
- 4 points draggables (touch/pointer)
- Polygone de prévisualisation
- Reset vers coins auto-détectés
- Valider pour lancer la correction perspective

## AnimationPlayer — Rendu PIXI.js

### Pipeline de rendu

```
Image scannée rectifiée
  → PIXI.Texture
  → computeUVs(points, width, height) → Float32Array [0,1]
  → Vertices en coordonnées écran (scale + offset)
  → Indices triangles → Uint16Array
  → PIXI.MeshGeometry(vertices, uvs, indices)
  → PIXI.MeshMaterial(texture)
  → PIXI.Mesh → stage
```

### Boucle d'animation (24 FPS)

```typescript
// À chaque frame :
const framePoints = videoFramesMesh[frameIndex]
for (point in framePoints) {
  verts[i*2]   = point.x * scale + offsetX
  verts[i*2+1] = point.y * scale + offsetY
}
verts.update()  // Sync GPU
// Les UVs ne changent jamais → la texture se déforme avec le maillage
```

### Contrôles

- Play / Pause
- Plein écran
- Compteur de frames
- Boucle automatique
