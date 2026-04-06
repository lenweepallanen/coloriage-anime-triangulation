# Coloriage Animé - Triangulation Custom

Application web de livres de coloriage animés avec triangulation de maillage et suivi vidéo.

## Concept

L'utilisateur crée un projet avec une image de coloriage et **plusieurs animations** (une "rest" en boucle infinie + des "oneshot" déclenchées à la demande). L'admin définit des **anchor points** (points structurels trackés) sur l'image, puis un maillage triangulé avec des points internes. Le suivi optique est pré-calculé sur les anchors seuls, avec validation par keyframes. Les points internes suivent via coordonnées barycentriques. Toutes les animations partagent la même géométrie (topologie mesh) mais ont chacune leur propre vidéo et tracking. L'utilisateur final scanne son coloriage colorié, et l'app injecte ses couleurs dans le maillage animé via PIXI.js avec transitions fluides entre animations.

## Stack technique

| Couche | Technologie |
|--------|------------|
| Framework UI | React 19 + TypeScript strict |
| Routing | React Router 7 |
| Base de données | Firebase (Firestore + Cloud Storage) |
| Géométrie maillage | Delaunator (triangulation de Delaunay) |
| Rendu graphique | PIXI.js 7 (WebGL 2D) |
| Vision par ordinateur | OpenCV.js dans Web Worker |
| Traitement image | Canvas API HTML5 |
| Build | Vite 7 |
| PDF | jsPDF |
| Inpainting | LaMa via Cloud Function Python (GCP) |

## Architecture des routes

```
/                    → HomePage     (liste/création de projets)
/admin/:projectId    → AdminPage   (workflow 10 étapes)
/scan/:projectId     → ScanPage    (scan + animation)
```

## Multi-Animation

Un projet contient **plusieurs animations** partageant la même image et géométrie :
- **Rest** (exactement 1) : animation en boucle infinie (idle). Pipeline complet 10 étapes. Seule animation autorisée à modifier la géométrie.
- **Oneshot** (0+) : animations à la demande (wave, jump...). Pipeline réduit 6 étapes (tracking seul, géométrie héritée de rest).
- **Physics** (0+) : animations procédurales par code JS. Pas de vidéo ni tracking — l'utilisateur écrit du code qui transforme les vertices du maillage. Les frames sont pré-calculées à la validation et stockées comme `videoFramesMesh`, ce qui les rend identiques aux oneshots pour le playback. Option **overlay** : si activée, l'animation se superpose instantanément à la rest loop (déplacements additifs) sans attendre la fin du cycle.
- **Bone** (0+) : animations par déformation squelettique. Pipeline 7 étapes (vidéo + tracking des anchors comme oneshot, puis définition de bones + calcul par skinning au lieu d'ARAP). Self-contained comme physics — hérite la géométrie de rest, produit son propre `videoFramesMesh`. Utilisé comme oneshot/overlay dans le playback.
- **Walk** (0+) : animations de marche procédurale quadrupède. Pipeline 6 étapes (squelette 18 keypoints, séparation membres par courbes Bézier, édition maillage zone par zone, face cachée derrière les pattes, paramètres cinématiques, calcul LBS). Pas de vidéo ni tracking — les positions sont calculées par cinématique inverse + LBS. Produit `videoFramesMesh` + `walkZoneFrames`/`walkBodyFrames` pour le rendu séparé par zone.

### Topologie partagée

La géométrie frame 0 (contourOrigin, contourAnchors, contourSubdivisionPoints, anchorPoints, internalPoints, triangles, trackedTriangles, internalBarycentrics) est définie sur la rest animation et **propagée** aux oneshots, physics et bone. Si la géométrie rest change, le tracking des oneshots est invalidé, les frames pré-calculées des physics sont effacées, et les bones sont invalidés (boneWeights recalculé nécessaire).

### Adapter pattern

Les step components ne connaissent pas le multi-animation. `AdminPage` construit un `ProjectStepView` (projet + videoBlob/mesh de l'animation sélectionnée) et intercepte le save pour merger dans la bonne animation. Les physics animations utilisent un composant dédié (`PhysicsAnimationEditor`) qui reçoit directement le projet et l'animation.

### Import projet (ProjectImportSection)

Section dédiée au-dessus de la barre animations dans `AdminPage`. Carte avec 3 zones d'import :
- **Image coloriage** (PNG/JPEG) — obligatoire
- **Vidéo de fond** (MP4/WebM) — optionnelle, jouée en boucle en arrière-plan
- **Son d'ambiance** (MP3/WAV/OGG) — optionnel, joué en boucle continue dans le player, avec toggle activer/désactiver

Ces assets sont au **niveau projet** (partagés par toutes les animations). Le composant `ProjectImportSection.tsx` reçoit le `Project` directement et sauvegarde avec les hints `'image'`, `'backgroundVideo'`, `'ambientSound'`.

### Preview panel (AdminPreview)

Layout split-panel dans `AdminPage` : volet gauche (édition pipeline) + volet droit (preview live PIXI.js). La preview utilise l'image PNG originale comme texture (pas de scan). Affiche l'animation rest en boucle + boutons oneshot/physics.

- **Masquable** : bouton "Masquer/Afficher preview" dans le header
- **Redimensionnable** : barre de séparation draggable (15% à 60%), défaut ~1/3
- **Condition** : visible seulement quand la rest animation a un `videoFramesMesh` calculé
- **Responsive** : pleine largeur avec marges 5vw sur écrans 4K (>2000px) ; empilement vertical sous 1024px
- **Composant** : `AdminPreview.tsx` — PIXI.js léger, FPS capé à 30, ResizeObserver, pas de fullscreen/parallax
- **Pas de physique tactile** — la physique spring-back a été supprimée

### Zones Corporelles

Système de **zones corporelles** pour les interactions tactiles dans le ScenePlayer. L'admin définit des groupes de triangles labellisés (tête, queue, etc.) sur le maillage, puis dans l'éditeur de scène, chaque zone est liée à une animation par rest point.

- **Modèle** : `BodyZone { id, label, color, triangleIndices[] }` sur `Project.bodyZones`
- **Mapping** : `ZoneAnimationMapping { zoneId, animationId }` sur `SceneRestPoint.zoneAnimationMappings`
- **Éditeur** : onglet "Zones" dans l'admin (4ème section), éditeur canvas avec sélection par triangle (clic, peinture, rectangle)
- **Player** : au toucher pendant l'état interaction, détection du triangle → zone → animation → `requestOneshot()`
- **Sécurité** : les zones sont invalidées (vidées) quand la géométrie rest change

### Design system

Système de design CSS variables dans `global.css` :
- **Boutons** : hiérarchie `btn-primary` (bleu, actions principales), `btn-secondary` (outlined), `btn-ghost` (transparent), `btn-icon` (carré), `btn-danger` (rouge), `btn-sm`/`btn-lg` (tailles). Le hover par défaut est neutre (pas bleu).
- **Tokens** : spacing scale (`--space-1` à `--space-8`), typography scale (`--text-xs` à `--text-2xl`), shadows (`--shadow-sm/md/lg`), radius (`--radius-sm/lg/full`)
- **Responsive** : breakpoints 480px, 768px, 1024px, 2000px

### Pipeline stepper

Navigation admin via **stepper numéroté** (remplace les tabs plats) :
- Cercles connectés par des lignes, numérotés 1 à 10
- 3 états visuels : **done** (✓ vert), **active** (● bleu avec glow), **pending** (○ gris)
- Statut dérivé des champs mesh existants (pas de données supplémentaires)
- Scroll horizontal sur mobile, labels cachés sur petit écran

### Section actions rapides

Ligne sous la section import projet avec 3 encadrés côte-à-côte :
- **Animations** : `AnimationManager` (pills sélection animation) — flex: 1
- **PDF** : encadré orange, icône document, téléchargement PDF imprimable — visible dès l'import de l'image
- **Scanner** : encadré bleu, icône appareil photo, lien vers la page scan

## Workflow Admin (10 étapes rest / 6 étapes oneshot / 1 étape physics)

Pipeline "contour-first" avec coordonnées curvilignes. Un point d'origine P0 définit le s=0 du contour. Seuls 4-5 points caractéristiques du contour sont trackés par extrema de courbure CSS ; les points intermédiaires sont calculés déterministiquement par coordonnée curviligne sur le contour Canny détecté à chaque frame.

### Pipeline rest (10 étapes)
1. **Vidéo** — Upload vidéo d'animation MP4/WebM + son optionnel pour oneshot (image importée dans la section projet)
2. **Canny** — Preview contour externe Canny sur vidéo + réglage 3 seuils (low, high, blur)
3. **Point 0 Contour** — Placement du point d'origine P0 sur le contour Canny de l'image (auto-snap 30px, définit s=0)
4. **Tracking Point 0** — Optical flow + snap-to-contour Canny sur P0 frame par frame, édition keyframes
5. **Anchors Contour** — Placement points caractéristiques sur le contour (auto-snap unbounded Canny) + auto-détection par extrema de courbure (`detectCurvatureExtrema`, 4-20 pts). P0 inclus automatiquement en premier anchor. Tri par ordre contour.
6. **Subdivision** — Points intermédiaires entre anchors (placement statique frame 0 seulement). Compteur +/- par segment et global. Le calcul par frame est fait à l'étape 10.
7. **Tracking Contour** — Placement déterministe par coordonnée curviligne normalisée + snap extrema courbure CSS (`detectGlobalCurvatureExtrema`). Pas d'optical flow. 2 modes : s fixe ou proche en proche.
8. **Ancres Internes** — Placement points features intérieurs (contour en overlay lecture seule) + auto-détection par grille
9. **Tracking Ancres** — Optical flow sur ancres internes + keyframes. Contraintes hardcodées : anti-saut + voisinage ON, temporel + outlier OFF.
10. **Triangulation** — Points internes + Delaunay + verrouillage topologie + calcul animation ARAP (As-Rigid-As-Possible) + lissage temporel + preview 3 modes (vidéo/wireframe/gradient) + crossfade configurable

### Pipeline oneshot (6 étapes)
1. **Vidéo** — Upload vidéo d'animation + son optionnel (image héritée du projet)
2. **Canny** — Preview contour Canny sur la vidéo oneshot (géométrie héritée de rest en lecture seule)
3. **Tracking Point 0** — Tracking P0 sur la vidéo oneshot (optical flow + snap Canny)
4. **Tracking Contour** — Placement curviligne + snap extrema courbure sur la vidéo oneshot
5. **Tracking Ancres** — Optical flow ancres internes sur la vidéo oneshot (anti-saut + voisinage)
6. **Triangulation** — Calcul animation finale ARAP (géométrie héritée, lecture seule)

### Pipeline physics (1 étape)
1. **Code Editeur** — Éditeur de code JS avec preview PIXI temps réel + pré-calcul des frames

### Pipeline bone (7 étapes)
1. **Vidéo** — Upload vidéo d'animation (image héritée du projet)
2. **Canny** — Preview contour Canny sur la vidéo bone (géométrie héritée de rest en lecture seule)
3. **Tracking Point 0** — Tracking P0 sur la vidéo bone (optical flow + snap Canny)
4. **Tracking Contour** — Placement curviligne + snap extrema courbure sur la vidéo bone
5. **Tracking Ancres** — Optical flow ancres internes sur la vidéo bone (anti-saut + voisinage)
6. **Bones** — Définition du squelette : chaque bone a 2 endpoints (head/tail) positionnés relativement à une paire d'anchor points trackés. Option **longueur constante** par bone. Option **coude** (elbow IK 2-bones) avec 3 modes de pli. Validation → calcul auto-weights par distance inverse sur les sub-bones.
7. **Triangulation** — Calcul animation par déformation squelettique (bones + LBS au lieu d'ARAP) → `videoFramesMesh`. Preview wireframe/gradient avec overlay bones animés.

### Système Bone

**Concept** : au lieu de tracker chaque point du maillage et d'utiliser ARAP pour déformer, on définit un squelette de bones dont les positions sont déduites des anchor points trackés. Les vertices du maillage sont liés aux bones par skinning automatique. Chaque bone est indépendant (pas de hiérarchie parent-enfant).

**Bone** : segment défini par 2 endpoints (head + tail). Chaque endpoint est positionné dans le repère local d'une paire d'anchors :
- `origin = anchorA`, `axe_x = anchorB - anchorA`, `axe_y = perp(axe_x)`
- `position = anchorA + localX × (B-A) + localY × perp(B-A)`
- `localX`/`localY` normalisés par `|A-B|` — le bone se déplace et se redimensionne avec ses anchors
- Si `anchorA === anchorB` : le bone suit la translation pure de l'anchor (pas de rotation)

**Longueur constante** (`fixedLength: boolean`) : si activé, la direction du bone suit les anchors mais sa longueur est figée à celle du rest pose. Le tail est repositionné sur la droite head→tail à distance constante.

**Coude (elbow IK)** : un bone peut avoir un coude intermédiaire (`elbowPos: Point2D | null`). Le coude crée 2 sous-segments (head→elbow, elbow→tail) dont les longueurs sont constantes (déterminées au repos). La position du coude est calculée par IK 2-bones (intersection de 2 cercles, cosine rule) à chaque frame. 3 modes pour choisir le côté du pli (`elbowMode: ElbowMode`) :
- **`rest`** : côté fixé par le placement du coude au repos (cross product)
- **`centroid`** : le coude plie vers le centroïde des points trackés (intérieur du mesh)
- **`continuity`** : le coude reste du même côté que la frame précédente (continuité temporelle)

Le coude est draggable dans l'éditeur (mousedown/move/up).

**Sub-bones** : en interne, un bone avec coude est éclaté en 2 sub-bones pour le calcul des weights et du skinning. Un bone sans coude = 1 sub-bone. Les auto-weights et matrices travaillent sur les sub-bones.

**Auto-weights** : poids par distance inverse au carré au segment du sub-bone. `w = 1/(dist+1)²`, normalisés par vertex. Seuil < 0.01 → 0.

**Skinning** : Linear Blend Skinning (LBS) — chaque vertex est déformé par la moyenne pondérée des transformations rigides (rotation + translation) de ses sub-bones influents.

**Rest pose** : le rest pose des bones utilise `trackedFrames[0]` (positions trackées frame 0 de la vidéo), pas les positions éditeur statiques. Cela évite le micro-décalage entre l'image statique et la frame 0 de la vidéo.

**Déformation par frame** :
1. Calcul positions endpoints depuis les tracked anchors (`contourAnchorFrames[f]` + `anchorFrames[f]`)
2. Si `fixedLength` (sans coude) : normaliser la longueur au rest pose
3. Si coude : résoudre IK 2-bones → position du coude, avec bendSide selon le mode
4. Calcul transform rigide (rotation + translation) par sub-bone vs rest pose
5. LBS : `position_vertex = Σ weight_sb × transform_sb(rest_position_vertex)`
6. Résultat : `videoFramesMesh[f]`

### Pipeline Walk (6 étapes)

1. **Zones membres** — Définition des 4 zones pattes par courbes Bézier fermées + séparation limb/corps
2. **Maillage zones** — Édition maillage par zone : limb (Delaunay auto + internals) + corps (fixe + patch manuel : ajouter/relier/déplacer)
3. **Face cachée** — Définition des zones de face cachée derrière chaque patte. Pour chaque patte : sélection de 2 vertices du contour body (A et B), placement de bridge points entre A et B, puis Delaunay dans le polygone fermé (bridge + body boundary). Les nouveaux triangles sont fusionnés dans bodyPoints/bodyTriangles. Texture générée par LaMa inpainting (Cloud Function) au scan, avec fallback diffusion Laplacienne.
4. **Bones marche** — Placement 18 keypoints du squelette quadrupède (6 groupes : 4 pattes + cou/tête + queue)
5. **Paramètres** — Paramètres cinématiques (longueur pas, levée pied, balancement corps/tête, phases de marche)
6. **Calcul** — Calcul animation par LBS séparé (zones + body) + legacy unifié, preview wireframe/gradient

### Face cachée (système)

Quand une patte s'anime, elle révèle la zone du corps qui était occultée dans l'image originale (l'enfant a colorié la patte, pas le corps derrière). Le système de "face cachée" comble ces trous :

**Modèle** : `HiddenFaceZone { limbZoneId, bodyVertexA, bodyVertexB, bridgePoints, bodyTriangleIndices }` — sous-ensemble du body mesh, pas une triangulation indépendante.

**Édition admin** (`WalkHiddenFaceStep`) :
1. L'admin sélectionne 2 vertices du contour body (A et B)
2. Il place des bridge points manuels entre A et B (contour intérieur)
3. Polygone fermé = [A, ...bridgePoints, B] + body boundary path B→A
4. Delaunay dans le polygone → points internes auto-générés (grille Poisson)
5. Nouveaux points/triangles fusionnés dans `bodyPoints`/`bodyTriangles`
6. Les indices des triangles ajoutés sont mémorisés dans `bodyTriangleIndices`

**Animation** : les hidden face triangles font partie du body mesh → animés par `bodyFrames` (aucun calcul supplémentaire).

**Rendu** : `zoneMeshRenderer` split le body en 2 PIXI meshes (pur body + hidden face) avec z-order différent. Le body visible utilise la texture scan haute résolution. Les hidden face meshes utilisent une texture inpaintée :
- **LaMa** (prioritaire) : Cloud Function Python (`functions/main.py`) reçoit le scan + un masque binaire des zones pattes (généré par `limbMaskGenerator.ts` depuis les Bézier dilatées), exécute LaMa neural inpainting, retourne un "scan sans pattes". Résolution 512px pour la vitesse, upscalé aux dimensions originales.
- **Fallback K-means/BFS** : si LaMa échoue, `inpaintHiddenFaceOnScan` (dans `hiddenFaceTexture.ts`) peint des couleurs plates par K-means sur les pixels de bordure puis propagation BFS avec barrières inter-clusters.

**Z-order** : body (z=0) → hidden face (z=limb.zOrder - 0.5) → limb (z=limb.zOrder)

### Hidden Face Limb (extension de patte)

Symétrique au système body : quand le corps (animé) recouvre une partie de la patte qui était visible dans l'image originale, il faut "rallonger" la patte sous le corps. Modèle : `HiddenFaceLimbZone { limbZoneId, zoneVertexA, zoneVertexB, bridgePoints, zoneTriangleIndices }` — sous-ensemble du zone mesh d'une patte (pas du body).

**Texture** : `flowExtrudeLimbOnScan` (dans `hiddenFaceTexture.ts`) extrude les couleurs de la patte visible vers la zone d'extension par échantillonnage perpendiculaire à la corde A↔B (le "genou" de la zone) :
1. Rasterisation des triangles visibles → masque local.
2. Pour chaque position latérale `iu ∈ [0, N_U)`, lance un rayon **perpendiculaire à la corde** depuis `lerp(A, B, iu/(N_U-1))` dans la patte visible et collecte les pixels jusqu'à sortir du masque (skip de quelques px pour éviter le contour noir) → 1 colonne RGB 1D = "rivière" du genou vers le pied.
3. Pour chaque pixel d'extension : `u = projection sur corde`, `dPx = |distance perpendiculaire|`, lookup `column[round(u·(N_U-1))][clamp(floor(dPx), 0, len-1)]`.

Conséquence : les "lignes" de la patte se prolongent par symétrie autour de la corde, sans bande répétée (clamp en profondeur, pas de tiling cyclique).

## Workflow Scan (utilisateur final)

**Orientation forcée** : toute la page scan est en mode paysage. `screen.orientation.lock('landscape')` au montage de `ScanPage`, avec fallback CSS `transform: rotate(90deg)` en portrait.

**Layout animation** : plein écran fixe en `flex-direction: row` — canvas PIXI à gauche (`flex: 1`), sidebar paramètres à droite (220px).

1. **Caméra** — Détection temps réel des marqueurs L + analyse qualité
2. **Ajustement coins** — Repositionnement manuel des 4 coins
3. **Correction perspective** — Homographie OpenCV → image 2048×2048 → crop marges 64px → resize aux dimensions originales
4. **Debug** — Visualisation 4 étapes du pipeline (photo brute, 2048 avec marges, croppée, overlay mesh)
5. **Animation** — Rendu PIXI.js du maillage texturé animé à 24 FPS + parallax gyroscope + boutons oneshot + interactions par zones corporelles

## Structure des fichiers

```
src/
├── main.tsx                    Point d'entrée
├── App.tsx                     Router
├── types/project.ts            Types (Point2D, Animation, BodyZone, SceneBackgroundLayer, ProjectStepView, MeshData, Project, Scan)
├── db/
│   ├── firebase.ts             Init Firebase
│   ├── projectsStore.ts        CRUD projets (Firestore + Storage)
│   └── scansStore.ts           CRUD scans
├── hooks/useProject.ts         Hook chargement/sauvegarde projet
├── pages/
│   ├── HomePage.tsx            Liste projets
│   ├── AdminPage.tsx           Onglets admin (10 étapes) + preview split-panel
│   └── ScanPage.tsx            Machine d'états scan
├── components/
│   ├── admin/                  Étapes admin (10 étapes + support + AnimationManager + AdminPreview + BodyZoneEditor + ProjectImportSection + PhysicsAnimationEditor + BoneEditorStep + BoneTriangulationStep + Walk*Steps)
│   ├── keyframes/              Éditeur de keyframes (éditeur canvas)
│   ├── triangulation/          Éditeur maillage (canvas, interactions, dessin)
│   └── scan/                   Composants scan (caméra, coins, processing, animation)
├── utils/
│   ├── autoMeshGenerator.ts    Détection contour + génération grille interne
│   ├── barycentricUtils.ts     Coordonnées barycentriques (calcul, recherche triangle, interpolation)
│   ├── geometry.ts             Point-in-polygon, distanceSq, centroïde
│   ├── keyframePropagation.ts  Interpolation linéaire entre keyframes
│   ├── markerGenerator.ts      Dessin marqueurs L
│   ├── opticalFlowComputer.ts  Pipeline extraction frames + tracking + segment re-tracking
│   ├── trackingConstraints.ts  Contraintes voisinage + snap-to-contour + spring curviligne
│   ├── contourAnchorTracker.ts Raffinement hybride LK + template matching + snap contour (utilisé par opticalFlowComputer)
│   ├── curvilinearContour.ts   Coordonnées curvilignes sur contour Canny
│   ├── curvatureScaleSpace.ts  Détection extrema courbure (single-scale + global) + snap anchor par courbure
│   ├── arapSolver.ts           Déformation ARAP (As-Rigid-As-Possible) du maillage
│   ├── optimalTransportSnap.ts Assignment optimal (transport) pour snap contour robuste
│   ├── contourSpatialIndex.ts  Index spatial bucket 2D pour snap-to-contour
│   ├── perspectiveCorrection.ts Bridge Worker OpenCV (RPC)
│   ├── pdfGenerator.ts         Génération PDF
│   ├── pdfLayout.ts            Constantes layout A4
│   ├── textureExtractor.ts     Calcul UVs pour PIXI
│   ├── bodyZoneUtils.ts        Détection zones corporelles (triangle→zone, hit test, touch detection)
│   ├── boneSolver.ts           Déformation squelettique (bones, auto-weights, LBS, forward kinematics)
│   ├── walkSolver.ts           Cinématique marche quadrupède (squelette, IK, LBS, séparation zones)
│   ├── limbSeparation.ts       Séparation membres/corps (Bézier→polygone, Delaunay par zone, patch manuel body, triangulation face cachée)
│   ├── bezierUtils.ts          Utilitaires courbes Bézier (flatten, expand, évaluation)
│   ├── hiddenFaceTexture.ts    Inpainting body fallback (K-means + BFS) + extrusion patte par colonnes perpendiculaires
│   ├── limbMaskGenerator.ts    Génération masque binaire des zones pattes (Bézier dilatées) pour LaMa
│   ├── lamaInpainting.ts       Client API Cloud Function LaMa (envoi scan+masque, réception inpainté)
│   ├── zoneMeshRenderer.ts     Rendu PIXI.js par zone (build/update meshes séparés, z-order, split body/hidden face)
│   └── multiAnimationPlayback.ts Machine d'états playback multi-animation (rest loop + oneshot transitions + physics overlay)
└── styles/global.css
public/
├── opencv.js                   Bibliothèque OpenCV.js compilée
└── opencv-worker.js            Web Worker OpenCV (détection, flow, perspective)
```

## Modèle de données

```typescript
AnimationType = 'rest' | 'oneshot' | 'physics' | 'bone' | 'walk'

Animation {
  id: string                         // crypto.randomUUID()
  name: string                       // "Idle", "Wave", "Jump", "Tourbillon"
  type: AnimationType
  createdAt: number
  videoBlob: Blob | null             // Vidéo propre (rest/oneshot), null pour physics
  mesh: MeshData | null              // Pipeline complet propre (géométrie partagée, tracking indépendant)
  physicsCode: string | null         // Code JS pour physics animations
  physicsDuration: number | null     // Durée en secondes (défaut 2)
  physicsOverlay: boolean            // Si true, se superpose à la rest loop sans attendre la fin du cycle
}

BodyZone {
  id: string                         // crypto.randomUUID()
  label: string                      // "tête", "queue"
  color: string                      // hex pour l'éditeur
  triangleIndices: number[]          // indices dans mesh.triangles
}

ZoneAnimationMapping {
  zoneId: string
  animationId: string                // réf Animation.id (oneshot ou physics)
}

Project {
  id, name, createdAt
  originalImageBlob: Blob | null     // Image coloriage (niveau projet)
  backgroundVideoBlob: Blob | null   // Vidéo fond (niveau projet)
  ambientSoundBlob: Blob | null      // Son d'ambiance (niveau projet, boucle continue)
  ambientSoundEnabled: boolean       // Toggle activer/désactiver le son
  animations: Animation[]            // Exactement 1 rest + 0..N oneshots + 0..N physics + 0..N bones
  bodyZones: BodyZone[]              // Zones corporelles (triangles groupés par label)
  markers: MarkerCorners | null      // 4 coins marqueurs L
}

// Adapter pattern — vue pour les step components (ne connaissent pas le multi-animation)
ProjectStepView {
  ...Project fields
  videoBlob: Blob | null             // = animation sélectionnée .videoBlob
  mesh: MeshData | null              // = animation sélectionnée .mesh
}

MeshData {
  cannyParams: CannyParams | null     // Seuils Canny validés (étape 2)

  // Point d'origine contour (étape 3)
  contourOrigin: Point2D | null              // Position P0 sur l'image originale

  // Tracking point d'origine (étape 4)
  contourOriginKeyframeInterval: number
  contourOriginKeyframes: KeyframeData[]
  contourOriginFrames: Point2D[][] | null    // 1 élément par inner array
  contourOriginTrackingValidated: boolean

  // Contour anchors (placement étape 5, tracking étape 7)
  contourAnchors: Point2D[]                    // 4-5 points caractéristiques
  contourAnchorKeyframeInterval: number
  contourAnchorKeyframes: KeyframeData[]
  contourAnchorFrames: Point2D[][] | null      // rempli étape 7
  contourAnchorTrackingValidated: boolean      // validé étape 7

  // Subdivision contour (étape 6 — points curvilignes calculés par frame)
  contourSubdivisionPoints: Point2D[]
  contourSubdivisionParams: CurvilinearParam[]  // {segmentIndex, t}
  contourSubdivisionFrames: Point2D[][] | null
  contourSubdivisionValidated: boolean

  // Cache contours Canny ordonnés par frame (calculé étape 6, réutilisé étape 7 et 10)
  contourCannyFrames: Point2D[][] | null

  // Ancres internes (étape 8 — features : yeux, ailes, etc.)
  anchorPoints: Point2D[]
  anchorKeyframeInterval: number
  anchorKeyframes: KeyframeData[]
  anchorFrames: Point2D[][] | null
  anchorTrackingValidated: boolean

  // Points internes (étape 10 — non trackés, suivent via barycentrics)
  internalPoints: Point2D[]

  // Topologie (verrouillée étape 10)
  triangles: [number,number,number][]
  topologyLocked: boolean
  trackedTriangles: [number,number,number][]
  internalBarycentrics: BarycentricRef[]

  // Bones (animation type 'bone')
  bones: Bone[]                          // Définitions des bones (étape 6 bone)
  boneWeights: number[][] | null         // [vertexIndex][boneIndex], normalisés sum=1 (Cloud Storage JSON)
  bonesValidated: boolean                // Étape 6 bone validée

  // Sortie finale (étape 10, consommé par AnimationPlayer)
  videoFramesMesh: Point2D[][] | null
}

BoneEndpointRef {
  anchorIndexA: number                   // index dans tracked = [...contourAnchors, ...anchorPoints]
  anchorIndexB: number
  localX: number                         // 0=A, 1=B, le long du segment A→B
  localY: number                         // offset perpendiculaire, normalisé par |A-B|
}

ElbowMode = 'rest' | 'centroid' | 'continuity'

Bone {
  id: string
  name: string
  head: BoneEndpointRef
  tail: BoneEndpointRef
  fixedLength: boolean                   // si true, longueur constante (rest pose)
  elbowPos: Point2D | null              // position du coude au repos (null = pas de coude)
  elbowMode: ElbowMode                  // mode de choix du côté du pli
}

SceneBackgroundLayer {
  imageBlob: Blob | null
  width: number
  height: number
  depthFactor: number                // 0.0–1.0, vitesse défilement (0.3=arrière, 0.6=milieu, 1.0=premier plan)
}

Scene {
  id, name
  backgroundLayers: SceneBackgroundLayer[]  // Toujours 3 : [arrière-plan, milieu, premier plan]
  characterScale: number
  characterY: number
  restPoints: SceneRestPoint[]
  transitions: SceneTransition[]
  startMode: 'rest' | 'transition'
  speakSounds: SpeakSound[]
  speakSoundBlobs: (Blob | null)[]
}

SceneRestPoint {
  id, backgroundX
  restAnimationId?: string
  randomAnimationIds?: string[]
  zoneAnimationMappings?: ZoneAnimationMapping[]  // Zone corporelle → animation
  speakSoundIds?: string[]
  helpTexts?: string[]
}

Scan {
  id, projectId, scannedAt
  scanImageBlob: Blob                // Image rectifiée
  textureMap: TextureTriangle[] | null
}
```

## Indexation des points

Convention utilisée partout :
```
allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
tracked   = [...contourAnchors, ...anchorPoints]   // Optical flow uniquement
contour   = [...contourAnchors, ...contourSubdivisionPoints]  // Polygone fermé
```
Les indices dans `triangles` réfèrent à `allPoints`. AnimationPlayer consomme `videoFramesMesh` avec cette même convention.

## Systèmes de coordonnées

Trois espaces de coordonnées coexistent :
1. **Image** — coordonnées originales de l'image (stockage du maillage)
2. **Vidéo** — coordonnées du frame vidéo (pendant l'optical flow et la détection Canny)
3. **Écran** — coordonnées canvas/PIXI (rendu avec DPI)

**Règle critique** : les positions des anchors (`contourAnchorFrames`, `anchorFrames`, etc.) sont toujours stockées en **coordonnées image**. Les pixels Canny détectés sur les frames vidéo doivent être convertis de coords vidéo → coords image avant toute utilisation avec les positions anchor : `imgX = (videoX / videoWidth) * imageWidth`.

## Stockage Firebase

- **Firestore** : métadonnées projet (nom, dates, `animations: AnimationDoc[]` avec mesh geometry sauf gros JSON)
- **Cloud Storage** — chemins scopés par animation :
  - `projects/{id}/originalImage` — blob image (niveau projet)
  - `projects/{id}/backgroundVideo` — vidéo fond (niveau projet)
  - `projects/{id}/ambientSound` — son d'ambiance (niveau projet)
  - `projects/{id}/sceneBackgroundLayer0` — arrière-plan scène
  - `projects/{id}/sceneBackgroundLayer1` — milieu scène
  - `projects/{id}/sceneBackgroundLayer2` — premier plan scène
  - `projects/{id}/animations/{animId}/video` — vidéo animation
  - `projects/{id}/animations/{animId}/contourOriginKeyframes.json`
  - `projects/{id}/animations/{animId}/contourOriginFrames.json`
  - `projects/{id}/animations/{animId}/contourAnchorKeyframes.json`
  - `projects/{id}/animations/{animId}/contourAnchorFrames.json`
  - `projects/{id}/animations/{animId}/contourSubdivisionFrames.json`
  - `projects/{id}/animations/{animId}/contourCannyFrames.json`
  - `projects/{id}/animations/{animId}/anchorKeyframes.json`
  - `projects/{id}/animations/{animId}/anchorFrames.json`
  - `projects/{id}/animations/{animId}/boneWeights.json`
  - `projects/{id}/animations/{animId}/videoFramesMesh.json`
  - `scans/{id}/scanImage` — image rectifiée

### Migration legacy

Les projets existants (sans `animations` au root, avec `mesh`/`hasVideo` directement) sont automatiquement migrés en mémoire : une animation rest est créée avec les données existantes. Les anciens chemins Storage sont lus tels quels. À la prochaine sauvegarde, le nouveau format est écrit.

### Upload Hints

```typescript
UploadHint = 'image' | 'backgroundVideo' | 'ambientSound'
  | 'sceneBackgroundLayer0' | 'sceneBackgroundLayer1' | 'sceneBackgroundLayer2'
  | { animationId: string; field: AnimationUploadField }
  | { speakSoundId: string } | { deleteSpeakSoundId: string }
StepUploadHint = string  // champ simple pour les steps (scopé par AdminPage)
```

## Cloud Function — LaMa Inpainting

**Répertoire** : `functions/` (Python 3.11, `simple-lama-inpainting`)

**URL** : `https://lama-inpaint-6gzhik6pka-ew.a.run.app` (configurable via `VITE_LAMA_FUNCTION_URL`)

**Spécifications** : gen2, 2 CPU, 2GB RAM, timeout 120s, concurrency 1, min-instances 0

**Protocole** :
- `GET /` → health check (déclenche cold start)
- `POST /` → `{ image: base64, mask: base64 }` → `{ inpainted: base64 JPEG }`

**Pipeline scan** : après correction perspective, le client génère un masque binaire (zones pattes Bézier dilatées 8px via `limbMaskGenerator.ts`), downscale à 512px, envoie à la Cloud Function. Le résultat est upscalé aux dimensions originales et utilisé comme texture pour les hidden face meshes uniquement.

**Deploy** :
```bash
gcloud functions deploy lama-inpaint \
  --gen2 --runtime python311 --trigger-http --allow-unauthenticated \
  --memory 2048MB --cpu 2 --timeout 120s --concurrency 1 \
  --min-instances 0 --max-instances 3 \
  --source functions/ --entry-point lama_inpaint \
  --project coloriage-anime-prod --region europe-west1
```

## Conventions

- Tout le traitement lourd (OpenCV) tourne dans un Web Worker
- Communication Worker via messages typés avec pattern RPC (perspectiveCorrection.ts)
- Le maillage est toujours stocké en coordonnées image
- FPS cible : 24 images/seconde
- Résolution de sortie perspective : 2048×2048
- Les triangles Firestore sont sérialisés en objets `{a, b, c}` (limitation arrays imbriqués)
- Les points sont indexés : contourAnchors 0..A-1, contourSubdivision A..A+S-1, anchorPoints A+S..A+S+M-1, internals après
- Les pixels retournés par OpenCV `findContours` sont déjà ordonnés — `orderContourPixels()` n'est plus nécessaire dans le pipeline normal
- Le cache `contourCannyFrames` (calculé étape 6) est propagé aux étapes 7 et 10 pour éviter la re-détection Canny
- **Frame 0 cohérence vidéo** : le tracking contour (étape 7) détecte le Canny sur la frame 0 de la vidéo (pas l'image statique) et snappe les anchors dessus. L'optical flow (étape 9) applique le snap-to-contour à frame 0 aussi. Le bone solver utilise `trackedFrames[0]` comme rest pose. Cela élimine le micro-décalage image statique vs vidéo frame 0.

## Commandes

```bash
npm run dev      # Serveur dev HTTPS (Vite, host: true pour accès réseau)
npm run build    # Build production (tsc + vite)
npm run lint     # ESLint
npm run preview  # Preview build
```
