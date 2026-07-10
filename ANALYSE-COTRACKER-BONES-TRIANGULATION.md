# Lien CoTracker ↔ Bones ↔ Triangulation (animations vidéo `cotracker-bones`)

> Document de référence destiné à une analyse externe. Décrit comment, dans ce
> monorepo, une animation **par vidéo** de type `cotracker-bones` relie trois
> systèmes : le **tracking de points** (CoTracker3), un **squelette de bones**
> N-aire, et la **topologie de maillage** héritée de la **Triangulation projet**
> (`projectTriangulation`). Tout le code cité est dans `apps/admin/src/`.

---

## 1. Vue d'ensemble en une phrase

Une animation `cotracker-bones` **n'a pas sa propre géométrie** : elle hérite
toute sa topologie (body + pattes + faces cachées) de `project.projectTriangulation`,
**tracke quelques points** sur sa vidéo via CoTracker3, **place des bones** dont
les endpoints sont des **barycentres N-aires de ces points trackés**, puis
**déforme le maillage hérité par LBS** (Linear Blend Skinning) + un post-pass
**ARAP** optionnel, pour produire `walkBodyFrames` + `walkZoneFrames` —
exactement le format consommé par `zoneMeshRenderer` au playback.

```
Vidéo + points placés (prompts)
   │  CoTracker3 (Cloud Function / serveur local)
   ▼
cotrackerFrames : { pointId → Point2D[] par frame }            [COORDS VIDÉO]
   │  squelette N-aire (bodyChain + legs + jaw + eyeLinks)
   ▼
résolution endpoints = Σ weights·points  →  positions joints/bones par frame  [COORDS VIDÉO]
   │  videoToImage()  +  topologie héritée de projectTriangulation
   ▼
LBS (computeBoneTransform → skinVerticesSubBones)  →  walkBodyFrames / walkZoneFrames  [COORDS IMAGE]
   │  post-pass ARAP optionnel (precomputeARAP + batchSolveARAP, contour pinné)
   ▼
zoneMeshRenderer.buildZoneMeshes() + updateVertices() par frame  →  rendu PIXI
```

---

## 2. Les trois systèmes et leur point de jonction

| Système | Rôle | Donnée pivot |
|---|---|---|
| **CoTracker3** | Tracke 2D N points sur la vidéo | `mesh.cotrackerFrames: Record<pointId, Point2D[]>` (coords vidéo) |
| **Bones** | Squelette dont chaque endpoint = barycentre N-aire de points trackés | `mesh.cotrackerSkeleton: CoTrackerSkeleton` |
| **Triangulation** | Topologie partagée du maillage (body + pattes + faces cachées) | `project.projectTriangulation` (requiert `step3Validated === true`) |

**Le point de jonction** est le type `CoTrackerEndpointRef` : il relie un endpoint
de bone à des **points CoTracker** (par `pointIds` + `weights`). Le LBS, lui, relie
les bones à la **topologie Triangulation** (par poids de skinning calculés sur
`bodyPoints` / `zonePoints`). Les bones sont donc l'**intermédiaire** :
points trackés → bones → vertices du maillage.

---

## 3. Pipeline `cotracker-bones` (étapes admin)

Composants `apps/admin/src/components/admin/CoTrackerBones*Step.tsx` :

| # | Étape | Composant | Sortie sur `mesh` |
|---|---|---|---|
| 1 | **Vidéo** | `ImportStep` | `animation.videoBlob` |
| 2 | **Tracking** | `CoTrackerBonesTrackingStep` | `cotrackerPoints`, `cotrackerFrames`, `cotrackerVideoWidth/Height`, `cotrackerTrackingValidated` |
| 3 | **Bones** | `CoTrackerBonesBoneStep` | `cotrackerSkeleton`, `cotrackerBonesValidated` |
| 4 | **Calcul** | `CoTrackerBonesComputeStep` | `walkBodyFrames`, `walkZoneFrames` (LBS de base) |
| 5 | **Lissage Bones** | `CoTrackerBonesBoneSmoothingStep` | `cotrackerBodyJointFramesSmoothed`, `cotrackerLegBoneFramesSmoothed`, `cotrackerBoneSmoothingValidated` |
| 6 | **LBS** | `CoTrackerBonesLBSStep` | `walkBodyFrames`, `walkZoneFrames` (écrase — LBS complet + ARAP + jaw + yeux) |

**Pré-requis bloquant** (étapes 4 et 6) :

```ts
const ready =
  mesh?.cotrackerFrames != null &&
  mesh?.cotrackerSkeleton != null &&
  mesh?.cotrackerBonesValidated === true &&
  tri?.step3Validated === true &&            // ← Triangulation projet complète
  mesh?.cotrackerVideoWidth != null &&
  mesh?.cotrackerVideoHeight != null
```

> Le lissage (étape 5) agit sur les **positions des joints** (Butterworth, cutoff
> Hz configurable) et est stocké séparément du brut. Le LBS final lit les frames
> lissés si disponibles.

---

## 4. Étape Tracking — CoTracker3

- Client : `apps/admin/src/utils/cotrackerTracking.ts` (REST vers la Cloud Function
  CoTracker3, bascule cloud/local comme SAM 2).
- L'admin place des `CoTrackerPoint` ; chaque point porte 1+ `CoTrackerPrompt`
  (`{ frameIdx, x, y }` en coords vidéo) — CoTracker3 accepte des requêtes
  multi-frames.
- Résultat stocké : `mesh.cotrackerFrames: Record<string, Point2D[]>` —
  `pointId → trajectoire par frame`, **en coordonnées vidéo**.
- Dimensions vidéo mémorisées (`cotrackerVideoWidth/Height`) pour invalidation au
  re-upload et pour la conversion vidéo→image ultérieure.

```ts
// types/project.ts
export interface CoTrackerPrompt { frameIdx: number; x: number; y: number; } // coords vidéo
export interface CoTrackerPoint  { id: string; name?: string; color: string; prompts: CoTrackerPrompt[]; }
```

---

## 5. Étape Bones — squelette N-aire

Tous les types : [apps/admin/src/types/project.ts](apps/admin/src/types/project.ts#L524-L632).

```ts
// Le LIEN CoTracker→Bones : un endpoint = combinaison linéaire de points trackés.
// position = Σ weights[i] · cotrackerFrames[pointIds[i]][frame]   (weights normalisés, somme=1)
export interface CoTrackerEndpointRef {
  pointIds: string[];   // réfèrent CoTrackerPoint.id
  weights: number[];    // même longueur, somme = 1
}

export interface CoTrackerBodyJoint {
  id: string; name: string;
  ref: CoTrackerEndpointRef;
}

export interface CoTrackerLegBone {
  id: string;
  zoneId: string;                 // ID zone membre (≠ 'body')
  name: string;
  hip: CoTrackerEndpointRef;
  joints: CoTrackerEndpointRef[]; // 0..N joints entre hip et foot ; chaîne = [hip, ...joints, foot]
  foot: CoTrackerEndpointRef;
  hipBodyVertexIndices?: number[] | null;   // option : hip attaché à un vertex du body mesh animé
  hipBodyVertexWeights?: number[] | null;
  legSolverMode?: 'barycentre' | 'solver';  // 'solver' = IK 2-bones pour le genou
  kneeRestPos?: Point2D | null;              // rest pose du genou (coords vidéo) → L1, L2, bendSide
  kneeMode?: ElbowMode;                      // 'rest' | 'centroid' | 'continuity'
}

// Bone "machoire" optionnel — PAS de LBS, produit un openness ∈ [0,1] par frame
export interface CoTrackerJawBone {
  id: string; name: string;
  tailRef: CoTrackerEndpointRef;  // pointe de la mâchoire (barycentre N-aire)
  restDirImage: Point2D;          // direction pivot→tail au repos (frame 0, image) = "bouche fermée"
  maxOpenAngleDegOverride?: number | null;
}

export interface CoTrackerEyeLink { eyeId: string; pointId: string; } // pupille suit un point

export interface CoTrackerSkeleton {
  bodyChain: CoTrackerBodyJoint[];   // chaîne ordonnée → N-1 segments (bones body)
  legs: CoTrackerLegBone[];          // 0..N pattes, chacune liée à une zoneId
  jaw?: CoTrackerJawBone | null;
  eyeLinks?: CoTrackerEyeLink[] | null;
}
```

**Points clés conceptuels :**
- Aucun bone n'a de position absolue stockée : il est **toujours reconstruit par
  frame** depuis les points CoTracker via ses `CoTrackerEndpointRef`.
- La `bodyChain` ordonnée définit des **segments consécutifs** (`joint_i → joint_{i+1}`)
  qui deviennent les sub-bones du body.
- Chaque `CoTrackerLegBone` est rattachée à une `zoneId` correspondant à une zone
  de `projectTriangulation.zones` (les pattes).
- Le **hip d'une patte** peut être attaché soit à des points CoTracker (barycentre),
  soit à un/des **vertices du body mesh déjà animé** (`hipBodyVertexIndices/Weights`)
  — c'est ce qui ancre la patte au corps en mouvement.

---

## 6. Étape Calcul / LBS — résolution + skinning

### 6.1 Résolution du squelette par frame
`apps/admin/src/utils/cotrackerBoneSolver.ts`

- `resolveEndpointFrame(ref, cotrackerFrames, f)` → `Σ normalizedWeights·points` (coords vidéo).
- `resolveCoTrackerBodyChain(...)` → tableau de joints body à la frame `f`.
- `resolveCoTrackerLegChain(leg, ..., bodyVertexPositions?)` → chaîne `[hip, ...joints, foot]` ;
  en mode `'solver'` (3 joints hip-knee-foot), hip & foot par barycentre, **genou par
  IK 2-bones** (`solveElbowIK`, longueurs figées au rest pose `kneeRestPos`).
- `resolveCoTrackerSkeletonFrame(...)` agrège body + pattes pour une frame.

> Toute cette résolution est en **coordonnées vidéo**.

### 6.2 Skinning LBS
`apps/admin/src/utils/cotrackerLBSCompute.ts` → `runCoTrackerLBSCompute(project, animation, params, onProgress, override)`

**Rest pose & poids (frame 0) :**
- Sub-bones body = segments de la `bodyChain` résolue à frame 0.
- Poids LBS par **distance inverse au carré** : `w[v,b] = 1 / (dist(v, bone_b) + ε)^p`
  (`p = weightPower`, défaut 2), normalisés par vertex, seuil `< 0.01 → 0`.
- Lissage Laplacien optionnel des poids le long du maillage.
- Idem indépendamment **par zone-patte**.

**Par frame `f` :**
1. `resolveCoTrackerSkeletonFrame` → joints body + chaînes pattes (coords vidéo).
2. `videoToImage(p, imgW, imgH, vidW, vidH)` → coords **image** (dimensions image =
   `tri.maskWidth/maskHeight`).
3. `computeBoneTransform(restHead, restTail, currHead, currTail)` → transform rigide par sub-bone.
4. `skinVerticesSubBones(points, weights, matrices)` → vertices déformés.
   - Body : `walkBodyFrames[f]` sur `tri.bodyPoints`.
   - Chaque patte : `walkZoneFrames[zoneId][f]` sur `tri.zonePoints[zoneId]`.

**Post-pass ARAP optionnel** (`params.mode`) :
- `'lbs-arap'` : pin des **N premiers indices** (`tri.zoneContourLength[zoneId]` = contour),
  `precomputeARAP(points, triangles, pinned)` une fois, puis
  `batchSolveARAP(system, pinnedFrames, iters)` sur toutes les frames.
- `'lbs-contour-arap'` : ARAP 1D sur le contour (lissage arc-length) puis ARAP 2D
  intérieur avec le nouveau contour pinné.
- Post-pass facultatif de **préservation d'aire** (scale par vertex + lissage Laplacien).

**Sortie** (`LBSComputeResult`, coords image) :
```ts
{
  walkBodyFrames: Point2D[][];                     // [frame] → vertices body déformés
  walkZoneFrames: Record<string, Point2D[][]>;     // zoneId → [frame] → vertices zone
  cotrackerBodyJointFrames: Point2D[][];           // [jointIdx][frame] (squelette brut conservé)
  cotrackerLegBoneFrames: Record<string, { chain: Point2D[][] }>;
  cotrackerJawOpennessFrames: number[] | null;
  cotrackerEyePupilFrames: Record<string, Point2D[]> | null;
}
```

### 6.3 Jaw bone (machoire)
`apps/admin/src/utils/cotrackerJawCompute.ts` → `computeJawOpennessFrames(...)`

- Reconstruit la pointe de mâchoire (`tailRef`, barycentre N-aire) par frame.
- Repère local construit depuis le triangle de `projectMouth.hingeAnchor` (barycentrique
  sur `bodyPoints`), à partir des `walkBodyFrames` déjà déformés.
- Angle entre `restDirImage` (bouche fermée, frame 0) et la direction courante,
  normalisé par `maxOpenAngleDeg` → `openness` clampé, lissé EMA.
- Au playback : `openness_final = max(openness_parole_RMS, openness_jaw)` — cumule
  parole et cris/rugissements/atchoum.
- **Pas de LBS** ; pilote uniquement la rotation de la zone bouche Bézier.

### 6.4 Yeux
`cotrackerEyeCompute.ts` → `cotrackerEyePupilFrames: Record<eyeId, Point2D[]>` (offset
pupille par frame, repère local de l'œil). Consommé par `EyeBlinkOverlay`.

---

## 7. Lien avec la Triangulation projet (`projectTriangulation`)

`cotracker-bones` **n'invente aucune topologie** ; elle consomme celle de
`project.projectTriangulation` (voir le pipeline « Triangulation Projet » 4 étapes :
Image réf → Zones SAM 2 → Maillage par zone → Faces cachées).

| Champ `projectTriangulation` | Usage par cotracker-bones |
|---|---|
| `bodyPoints` / `bodyTriangles` | Vertices + topologie du corps animés par LBS (+ ARAP) |
| `zonePoints[zoneId]` / `zoneTriangles[zoneId]` | Vertices + topologie par patte |
| `zoneContourLength[zoneId]` | Nombre de vertices de contour à **pinner** en ARAP (frontière) |
| `zones` (body + pattes, `zOrder`) | Identifiants `zoneId` des `CoTrackerLegBone` + z-order au rendu |
| `maskWidth` / `maskHeight` | Dimensions image pour `videoToImage` |
| `hiddenFaceZones` / `hiddenFaceLimbZones` | Faces cachées intégrées au mesh (animées avec) ; alignement naturel car même topologie |
| `step3Validated` | Gate de création/calcul de l'animation |

**Invariant d'indexation critique** : `zonePoints[zoneId]` est ordonné
`[P0, subdiv_seg0, anchor_1, subdiv_seg1, …, anchor_N, subdiv_segN, …internes]`. Les
`zoneContourLength[zoneId]` **premiers** indices sont le contour « trackable » /
pinnable ; les suivants sont les internes déformés par ARAP. Le LBS et l'ARAP
s'appuient sur cet ordre pour savoir quels vertices contraindre.

---

## 8. Champs `mesh` (`MeshData`) propres à cotracker-bones

[apps/admin/src/types/project.ts:223-253](apps/admin/src/types/project.ts#L223-L253)

```ts
// Étape 2 — Tracking
cotrackerPoints?: CoTrackerPoint[];
cotrackerVideoWidth?: number;
cotrackerVideoHeight?: number;
cotrackerFrames?: Record<string, Point2D[]> | null;   // pointId → positions/frame (COORDS VIDÉO)
cotrackerTrackingValidated?: boolean;

// Étape 3 — Bones
cotrackerSkeleton?: CoTrackerSkeleton;
cotrackerBonesValidated?: boolean;

// Étape 5 — Lissage des positions joints (Butterworth)
cotrackerLegBoneFrames?: Record<string, { chain: Point2D[][] }> | null;        // chain[i][f] (vidéo)
cotrackerLegBoneFramesSmoothed?: Record<string, { chain: Point2D[][] }> | null;
cotrackerBodyJointFrames?: Point2D[][] | null;          // [jointIdx][frameIdx]
cotrackerBodyJointFramesSmoothed?: Point2D[][] | null;
cotrackerBoneSmoothingCutoffHz?: number;
cotrackerBoneSmoothingValidated?: boolean;

// Étape LBS — solver
cotrackerLBSParams?: CoTrackerLBSParams;
cotrackerLBSValidated?: boolean;

// Jaw / yeux
cotrackerJawOpennessFrames?: number[] | null;           // openness/frame [0,1]
cotrackerEyePupilFrames?: Record<string, Point2D[]> | null;
```

> La **sortie finale** réutilise les champs `walkBodyFrames` / `walkZoneFrames`
> (mêmes champs que V3 / walk), ce qui rend l'animation interchangeable au rendu.

---

## 9. Rendu — consommation de `walkBodyFrames` / `walkZoneFrames`

`apps/admin/src/utils/zoneMeshRenderer.ts` → `buildZoneMeshes(separation, restPoints,
restTriangles, texture, imgW, imgH, scale, offX, offY, alignment, hiddenFaceTexture,
hiddenFaceLimbTextures)`.

- `buildPseudoSeparation()` convertit `ProjectTriangulation` → format
  `WalkLimbSeparation` pour réutiliser le même renderer que Walk/V3.
- Par frame `f` au playback : `walkBodyFrames[f]` → géométrie du PIXI.Mesh body ;
  `walkZoneFrames[zoneId][f]` → mesh de chaque zone.
- **Z-order** par `zone.zOrder` ; faces cachées rendues séparément (texture
  inpaintée LaMa / fallback) à un z inférieur.
- Jaw : rotation de la zone bouche via `cotrackerJawOpennessFrames`.
- Yeux : offset pupille via `cotrackerEyePupilFrames`.

Consommé par `AnimationPlayer` (play) et `AdminPreview` (preview live admin).

---

## 10. Animation dérivée `marche` (procédurale, sans vidéo)

Pour contexte : le type `marche` **hérite le squelette** (`CoTrackerSkeleton`) d'une
animation parente `cotracker-bones` validée (snapshot dans `mesh.marcheSkeleton`,
rest positions des joints converties vidéo→image), puis génère les positions par
cinématique procédurale (`marcheSolver.ts`) au lieu de tracking. Sortie identique :
`walkBodyFrames` + `walkZoneFrames`. Le pipeline `marche` **strip le champ `jaw`**
du snapshot (pas de point cotracker pour le piloter). Cf.
[apps/admin/src/types/project.ts:255-262](apps/admin/src/types/project.ts#L255-L262).

---

## 11. Fichiers de référence

| Rôle | Fichier |
|---|---|
| Types | `apps/admin/src/types/project.ts` (L223-253, L524-632) |
| Client tracking | `apps/admin/src/utils/cotrackerTracking.ts` |
| Résolution squelette | `apps/admin/src/utils/cotrackerBoneSolver.ts` |
| Calcul LBS + ARAP | `apps/admin/src/utils/cotrackerLBSCompute.ts` |
| Jaw | `apps/admin/src/utils/cotrackerJawCompute.ts` |
| Yeux | `apps/admin/src/utils/cotrackerEyeCompute.ts` |
| Marche dérivée | `apps/admin/src/utils/marcheSolver.ts` |
| Steps admin | `apps/admin/src/components/admin/CoTrackerBones*Step.tsx` |
| Rendu | `apps/admin/src/utils/zoneMeshRenderer.ts` |

---

## 12. Questions ouvertes / pistes d'analyse

À destination de l'analyse externe, points méritant un regard :

1. **Double conversion de coordonnées** : le tracking et la résolution du squelette
   sont en coords vidéo, le LBS/ARAP en coords image (`videoToImage` via
   `tri.maskWidth/Height`). Vérifier la cohérence si la vidéo et l'image de
   référence n'ont pas le même ratio d'aspect.
2. **Hip attaché au body** (`hipBodyVertexIndices`) : la patte dépend des
   `walkBodyFrames` déjà calculés — ordre de calcul body→pattes à confirmer, et
   sensibilité au lissage des frames body.
3. **Pinning ARAP** : robustesse du `zoneContourLength` comme frontière (si le
   contour tracké drift, le pin peut introduire des artefacts).
4. **Lissage** : le LBS final lit-il systématiquement les frames lissés
   (`*Smoothed`) quand ils existent, ou seulement si l'étape 5 est validée ?
5. **Invalidation en cascade** : toute re-validation amont (Triangulation projet,
   tracking, bones) doit invalider le LBS — confirmer que les flags `*Validated` et
   le vidage des sorties sont bien propagés.
