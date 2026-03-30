# Brief : ecrire du code pour une Physics Animation

## Contexte

Tu ecris le **body** d'une fonction JavaScript qui sera executee une fois par frame pour transformer les positions des vertices d'un maillage 2D triangule. Le maillage represente un coloriage anime (papillon, poisson, etc.). Chaque frame repart des positions de base (frame 0 de la rest animation) — il n'y a pas d'accumulation entre frames sauf si tu la geres toi-meme.

## Variables disponibles

| Variable | Type | Description |
|----------|------|-------------|
| `positions` | `{x: number, y: number}[]` | Tableau de vertices a **muter en place**. Clone des positions de base a chaque frame. |
| `time` | `number` | Temps ecoule en secondes depuis le debut de l'animation |
| `frameIndex` | `number` | Index de la frame courante (0 a `totalFrames - 1`) |
| `totalFrames` | `number` | Nombre total de frames (duree x 24fps) |
| `numVertices` | `number` | Nombre de vertices (`positions.length`) |
| `progress` | `number` | Progression normalisee de 0 a 1 |

## Regles

- **Muter `positions` en place** : modifier `positions[i].x` et `positions[i].y` directement. Ne pas retourner de valeur.
- **Pas de `function` ni de `return`** : tu ecris le body, pas une declaration de fonction.
- **Pas d'imports** : uniquement du JS vanilla. `Math` est disponible.
- **Coordonnees image** : les positions sont en pixels dans l'espace de l'image originale (typiquement 0-1000). Les deplacements doivent etre de l'ordre de 5-50px pour un effet visible sans casser le maillage.
- **L'animation est jouee comme un oneshot** : elle demarre, joue lineairement du debut a la fin, puis revient a la rest animation avec une transition smoothstep de 7 frames. Pense a ce que la premiere et la derniere frame soient proches de la pose de base pour une transition fluide (utilise `Math.sin(progress * Math.PI)` pour un effet qui part de 0 et revient a 0).
- **24fps**, duree configurable (0.5s a 5s, defaut 2s).

## Pattern recommande

```javascript
// 1. Definir le centre de l'effet (approximer le centre du maillage)
const cx = 300, cy = 300;

// 2. Enveloppe temporelle : commence a 0, monte, redescend a 0
const envelope = Math.sin(progress * Math.PI);

// 3. Boucle sur les vertices
for (let i = 0; i < numVertices; i++) {
  const dx = positions[i].x - cx;
  const dy = positions[i].y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // 4. Falloff spatial (plus loin = moins d'effet)
  const falloff = Math.exp(-dist / 200);

  // 5. Appliquer le deplacement
  positions[i].x += ... * envelope * falloff;
  positions[i].y += ... * envelope * falloff;
}
```

## Exemples d'effets

- **Tourbillon** : rotation autour du centre, angle proportionnel a `progress`
- **Pulsation** : scale radial depuis le centre avec `sin(progress * PI)`
- **Vague** : deplacement sinusoidal en Y base sur `positions[i].x`
- **Tremblement** : petits deplacements aleatoires (utiliser un seed deterministe base sur `i` et `frameIndex`, pas `Math.random()`)
- **Rebond** : translation verticale avec courbe de rebond (abs de sin amorti)

## Exemple complet : tourbillon

```javascript
const cx = 300, cy = 300;
const angle = progress * Math.PI * 4;
const strength = Math.sin(progress * Math.PI) * 20;
for (let i = 0; i < numVertices; i++) {
  const dx = positions[i].x - cx;
  const dy = positions[i].y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const falloff = Math.exp(-dist / 200);
  const a = angle * falloff;
  positions[i].x += Math.sin(a) * strength * falloff;
  positions[i].y += Math.cos(a) * strength * falloff;
}
```

## Exemple complet : pulsation

```javascript
const cx = 300, cy = 300;
const envelope = Math.sin(progress * Math.PI);
const scale = 1 + envelope * 0.15;
for (let i = 0; i < numVertices; i++) {
  const dx = positions[i].x - cx;
  const dy = positions[i].y - cy;
  positions[i].x = cx + dx * scale;
  positions[i].y = cy + dy * scale;
}
```

## Exemple complet : vague

```javascript
const envelope = Math.sin(progress * Math.PI);
const freq = 0.02;
const amp = 15 * envelope;
for (let i = 0; i < numVertices; i++) {
  positions[i].y += Math.sin(positions[i].x * freq + time * 4) * amp;
}
```
