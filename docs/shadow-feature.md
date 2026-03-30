# Ombre projetée — AnimationPlayer

## Principe

L'ombre est une **copie noire, floue et décalée** du maillage triangulé principal. Elle est rendue **sous** le mesh texturé pour simuler une ombre portée, donnant un effet de relief au coloriage animé.

## Architecture PIXI.js

Le stage PIXI contient 3 containers empilés dans cet ordre (du fond vers l'avant) :

```
app.stage
  ├── bgContainer        ← vidéo de fond (si présente)
  ├── shadowContainer    ← ombre (mesh noir flouté)
  └── meshContainer      ← mesh texturé + overlay éclairage
```

L'ombre est donc toujours rendue **entre** le fond et le coloriage.

## Construction du mesh ombre

### 1. Texture noire unie

Plutôt qu'une texture image, l'ombre utilise une texture 1×1 noire générée à la volée :

```typescript
const shadowGfx = new PIXI.Graphics()
shadowGfx.beginFill(0x000000)
shadowGfx.drawRect(0, 0, 1, 1)
shadowGfx.endFill()
const shadowTexture = app.renderer.generateTexture(shadowGfx)
```

Les coordonnées UV de l'ombre sont toutes à `(0, 0)` — chaque triangle échantillonne le même pixel noir.

### 2. Même topologie que le mesh principal

L'ombre partage exactement les mêmes **indices de triangles** (`Uint16Array`) que le mesh texturé. Seuls les vertices (positions) diffèrent — ils sont décalés de `(+4px, +6px)` par rapport au mesh principal.

### 3. Semi-transparence

Le material de l'ombre a un `alpha` contrôlable via le slider "Ombre" dans la sidebar :

| Paramètre | Défaut | Plage | Pas |
|-----------|--------|-------|-----|
| `shadowAlpha` | 0.25 | 0 – 0.5 | 0.05 |

`alpha = 0` → ombre invisible. `alpha = 0.5` → ombre très marquée.

### 4. Flou gaussien

Un `BlurFilter(12)` est appliqué sur le container de l'ombre, pas sur le mesh individuel. Cela floute la silhouette entière de manière uniforme, donnant un aspect de pénombre douce.

```typescript
shadowContainer.filters = [new PIXI.BlurFilter(12)]
```

## Animation et lissage anti-tremblement

### Problème

Le maillage animé provient de données de tracking (optical flow + coordonnées curvilignes). Même après le lissage temporel appliqué lors du pré-calcul (`applyTemporalSmoothing` dans `TriangulationStep`), il reste des micro-tremblements entre frames. Ces micro-mouvements sont à peine perceptibles sur le mesh texturé lui-même, mais l'ombre — étant une forme noire unie sans texture de distraction — les rend très visibles.

### Solution : lissage EMA (Exponential Moving Average)

Un buffer EMA dédié (`Float32Array`) stocke la position lissée de chaque vertex de l'ombre. À chaque frame du ticker PIXI (~60fps), chaque vertex de l'ombre converge vers la position cible avec un facteur de lissage :

```typescript
const shadowSmoothingFactor = 0.08

// À chaque frame :
shadowEMA[i] = (1 - sf) * shadowEMA[i] + sf * targetPosition[i]
```

#### Fonctionnement

- **`shadowSmoothingFactor = 0.08`** signifie que l'ombre ne prend que **8%** de la nouvelle position par frame d'affichage (~60fps)
- À 60fps, il faut environ **28 frames (~0.47s)** pour que l'ombre atteigne 90% d'un mouvement brusque
- Les tremblements haute fréquence (1-2px entre frames) sont quasi totalement absorbés
- Les mouvements lents et continus (animation du personnage) sont suivis avec un léger retard imperceptible

#### Constante de temps

La demi-vie du filtre EMA à 60fps :

```
t_half = -1 / (60 * ln(1 - 0.08)) ≈ 0.20 secondes
```

L'ombre met ~0.2s pour parcourir la moitié de la distance vers sa cible. Suffisamment rapide pour suivre le mouvement, suffisamment lent pour filtrer les tremblements.

### Pipeline complet par frame

```
LoopPlayback.getPositions()          ← positions interpolées depuis videoFramesMesh
  → physics.update() + apply()       ← ajout déformation tactile (magnétisation)
  → modifiedPositions[]               ← positions finales du mesh principal

Mesh principal :
  vertex[i] = modifiedPositions[i] * scale + offset
  → verts.update()                    ← envoi GPU immédiat

Ombre :
  target[i] = modifiedPositions[i] * scale + offset + shadowOffset
  shadowEMA[i] = 0.92 * shadowEMA[i] + 0.08 * target[i]   ← lissage EMA
  → sVerts.update()                   ← envoi GPU lissé
```

## Paramètres

### Constantes internes (non exposées à l'UI)

| Constante | Valeur | Rôle |
|-----------|--------|------|
| `shadowOffsetX` | 4 px | Décalage horizontal (lumière venant de la gauche) |
| `shadowOffsetY` | 6 px | Décalage vertical (lumière venant du haut) |
| `BlurFilter` | 12 | Rayon du flou gaussien PIXI |
| `shadowSmoothingFactor` | 0.08 | Facteur EMA (plus bas = plus lisse, plus de latence) |

### Contrôle utilisateur (sidebar)

| Slider | Paramètre | Défaut | Effet |
|--------|-----------|--------|-------|
| Ombre | `shadowAlpha` | 0.25 | Opacité de l'ombre (0 = invisible, 0.5 = marquée) |

## Cas particuliers

### Mesh statique (pas d'animation vidéo)

Si `videoFramesMesh` est absent, le ticker n'avance pas le playback mais la physique tactile reste active. L'ombre suit les mêmes positions modifiées par la physique, avec le même lissage EMA.

### Initialisation

Le buffer EMA est initialisé avec les positions statiques (frame 0) du maillage + offset ombre. Cela évite un "saut" de l'ombre au démarrage de l'animation.

```typescript
for (let i = 0; i < allPoints.length; i++) {
  shadowEMA[i * 2]     = allPoints[i].x * scale + offsetX + shadowOffsetX
  shadowEMA[i * 2 + 1] = allPoints[i].y * scale + offsetY + shadowOffsetY
}
```

## Fichier source

Tout le code de l'ombre est dans `src/components/scan/AnimationPlayer.tsx`, sections :
- **Construction** : lignes 382–408
- **Update animé** : lignes 469–481
- **Update statique** : lignes 510–521
- **Config UI** : lignes 36–63
