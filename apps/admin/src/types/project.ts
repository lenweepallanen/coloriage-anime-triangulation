export interface Point2D {
  x: number;
  y: number;
}

export interface BarycentricRef {
  anchorTriangleIndex: number; // index into trackedTriangles[]
  u: number; // weight for vertex A
  v: number; // weight for vertex B
  w: number; // weight for vertex C
}

export interface KeyframeData {
  frameIndex: number;
  anchorPositions: Point2D[]; // point positions at this keyframe (contour OR anchor depending on context)
}

export interface CannyParams {
  lowThreshold: number;
  highThreshold: number;
  blurSize: number;
}

export interface CurvilinearParam {
  segmentIndex: number;    // Index du segment [anchor_i, anchor_{i+1}] dans le contour fermé
  t: number;               // Position curviligne normalisée [0,1] sur ce segment
}

export interface BoneEndpointRef {
  anchorIndexA: number;   // index dans tracked = [...contourAnchors, ...anchorPoints]
  anchorIndexB: number;
  localX: number;         // 0=A, 1=B, le long du segment A→B
  localY: number;         // offset perpendiculaire, normalisé par |A-B|
}

export type ElbowMode = 'rest' | 'centroid' | 'continuity'

export interface Bone {
  id: string;
  name: string;
  head: BoneEndpointRef;
  tail: BoneEndpointRef;
  fixedLength: boolean;     // si true, longueur constante (rest pose)
  elbowPos: Point2D | null; // position du coude au repos (null = pas de coude, IK 2-bones)
  elbowMode: ElbowMode;    // 'rest' = côté fixé au placement, 'centroid' = vers intérieur mesh, 'continuity' = frame précédente
}

// ─── Members-Bones Skeleton types (pipeline members-bones, étape 9) ─────

/** Zone-aware endpoint reference — barycentric between 1 or 2 zone anchors */
export interface Sam2BoneEndpointRef {
  zoneId: string;           // libre — 'body' réservé pour la zone corps, autres IDs libres (membres)
  anchorIndexA: number;     // index into sam2ContourAnchors[zoneId]
  anchorIndexB: number;     // same zone. If A === B → snaps to anchor A
  t: number;                // barycentric weight: position = A + t × (B − A). 0=A, 1=B, 0.5=midpoint
}

/** Joint in the body chain — consecutive joints form bone segments */
export interface Sam2BodyJoint {
  id: string;               // crypto.randomUUID()
  name: string;             // 'Cou', 'Poitrine', 'Hanches'...
  ref: Sam2BoneEndpointRef;
}

/** Leg bone hip mode
 *  - 'anchor'      → barycentric on zone anchors (default V2)
 *  - 'body-vertex' → barycentre de 1 à 3 vertices du body mesh (V2 legacy 1-vertex + V3 multi) */
export type Sam2LegHipMode = 'anchor' | 'body-vertex'

/** Leg bone with IK knee (reuses ElbowMode from bone animations) */
export interface Sam2LegBone {
  id: string;
  zoneId: string;           // libre — ID de la zone membre (≠ 'body')
  name: string;
  hip: Sam2BoneEndpointRef;
  foot: Sam2BoneEndpointRef;
  kneeRestPos: Point2D;     // rest pose knee position (video coords)
  kneeMode: ElbowMode;      // 'rest' | 'centroid' | 'continuity'
  /** V2 legacy : 1 vertex body. Migré au load en hipBodyVertexIndices=[idx]. */
  hipBodyVertexIndex?: number | null;
  /** Mode de calcul du hip. Défaut 'anchor' (back-compat). */
  hipMode?: Sam2LegHipMode;
  /** Indices dans le body mesh — [idx] (1 vertex) | [idx1,idx2] | [idx1,idx2,idx3]. */
  hipBodyVertexIndices?: number[] | null;
  /** Poids associés (somme = 1). Défaut équirépartis si null/absent. */
  hipBodyVertexWeights?: number[] | null;
}

/** Complete skeleton definition for members-bones animations */
export interface Sam2Skeleton {
  bodyChain: Sam2BodyJoint[];  // ordered chain, minimum 2 joints for 1 segment
  legs: Sam2LegBone[];         // 0..N membres (le nom 'legs' est historique — peut contenir tête, queue, ailes...)
}

export interface MeshData {
  // Étape 2 : Paramètres Canny validés
  cannyParams: CannyParams | null;

  // Étape 3 : Point 0 contour (origine du repère curviligne)
  contourOrigin: Point2D | null;

  // Étape 4 : Tracking Point 0
  contourOriginKeyframeInterval: number;
  contourOriginKeyframes: KeyframeData[];
  contourOriginFrames: Point2D[][] | null;  // 1 élément par inner array, cohérence pipeline
  contourOriginTrackingValidated: boolean;

  // Étape 5 : Anchors contour caractéristiques (4-5 points, frame 0, sur Canny)
  contourAnchors: Point2D[];

  // Étape 4 : Tracking anchors contour
  contourAnchorKeyframeInterval: number;
  contourAnchorKeyframes: KeyframeData[];
  contourAnchorFrames: Point2D[][] | null;   // Positions anchors contour par frame
  contourAnchorTrackingValidated: boolean;

  // Étape 5 : Points contour intermédiaires (subdivision entre anchors)
  contourSubdivisionPoints: Point2D[];       // Positions frame 0
  contourSubdivisionParams: CurvilinearParam[]; // Coordonnées curvilignes
  contourSubdivisionFrames: Point2D[][] | null;  // Positions calculées par frame (via Canny)
  contourSubdivisionValidated: boolean;

  // Cache : contours Canny ordonnés par frame (calculés à l'étape 6, réutilisés à l'étape 7)
  contourCannyFrames: Point2D[][] | null;

  // Étape 6 : Anchors internes (features intérieures : yeux, ailes, etc.)
  anchorPoints: Point2D[];

  // Étape 7 : Tracking anchors internes
  anchorKeyframeInterval: number;
  anchorKeyframes: KeyframeData[];
  anchorFrames: Point2D[][] | null;
  anchorTrackingValidated: boolean;

  // Étape 8 : Triangulation + Animation finale
  internalPoints: Point2D[];
  triangles: [number, number, number][];  // indices dans allPoints = [...contourAnchors, ...contourSubdivisionPoints, ...anchorPoints, ...internalPoints]
  topologyLocked: boolean;
  trackedTriangles: [number, number, number][];  // Delaunay sur [...contourAnchors, ...anchorPoints]
  internalBarycentrics: BarycentricRef[];  // Pour contourSubdivisionPoints + internalPoints

  // Bones (animation type 'bone')
  bones: Bone[];
  boneWeights: number[][] | null;   // [vertexIndex][boneIndex], normalisés sum=1
  bonesValidated: boolean;

  // SAM 2 zones (animation type 'members-bones', étape "Définir Zones")
  sam2Zones?: SAM2Zone[];
  sam2Prompts?: SAM2Prompt[];
  sam2MasksRLE?: Record<string, RLEMask[]> | null;  // zoneId → masks par frame
  sam2VideoWidth?: number;          // dims vidéo au moment du calcul (invalidation)
  sam2VideoHeight?: number;
  sam2Validated?: boolean;

  // Pipeline triangulation par zone SAM 2 (members-bones étapes 3-8)
  // Étape 3 "Lissage Contours" — extraction du contour de chaque masque RLE puis lissage gaussien.
  // Coordonnées en pixels VIDÉO (mêmes que sam2VideoWidth/Height).
  sam2Contours?: Record<string, Point2D[][]> | null;  // zoneId → polygone par frame
  sam2ContourSmoothSigma?: number;                    // sigma utilisé pour le lissage (UI)
  sam2ContoursValidated?: boolean;
  // Validité par zone par frame (détection automatique d'occlusion via aire de masque).
  // Une frame invalide est ignorée par les trackings V3 et interpolée linéairement.
  sam2ZoneValidFrames?: Record<string, boolean[]> | null;
  sam2ZoneMinAreaFraction?: number;                   // seuil utilisé (UI)

  // Étape 4 "P0 par zone" — placement statique frame 0
  sam2ContourOrigins?: Record<string, Point2D>;       // zoneId → P0

  // Étape 5 "Tracking P0 zones" — déterministe via coordonnée curviligne
  sam2ContourOriginFrames?: Record<string, Point2D[]> | null;  // zoneId → P0 par frame
  sam2ContourOriginTrackingValidated?: boolean;

  // Étape 6 "Anchors par zone" — placement statique frame 0 (P0 inclus comme premier anchor)
  sam2ContourAnchors?: Record<string, Point2D[]>;     // zoneId → anchors

  // Étape 7 "Subdivision par zone" — placement statique frame 0
  sam2ContourSubdivisionPoints?: Record<string, Point2D[]>;
  sam2ContourSubdivisionParams?: Record<string, CurvilinearParam[]>;
  sam2ContourSubdivisionValidated?: boolean;

  // Étape 8 "Tracking Anchors zones" — déterministe via coordonnée curviligne
  sam2ContourAnchorFrames?: Record<string, Point2D[][]> | null;  // zoneId → frame → positions anchors
  sam2ContourSubdivisionFrames?: Record<string, Point2D[][]> | null;  // zoneId → frame → positions subdivision
  sam2ContourAnchorTrackingValidated?: boolean;

  // Étape 9 "Bones par zone" — définition squelette members-bones
  sam2Skeleton?: Sam2Skeleton;
  sam2BonesValidated?: boolean;

  // V2 : body chain validée séparément (members-bones-v2)
  sam2BodyBonesValidated?: boolean;

  // Étape 10 "Lissage Bones" / V2 "Lissage Anchor" — lissage temporel des entrées tracking
  sam2SmoothedAnchorFrames?: Record<string, Point2D[][]> | null;
  // V2 extension : lissage des subdivisions et P0 avec le même cutoff (cohérence contour)
  sam2SmoothedSubdivisionFrames?: Record<string, Point2D[][]> | null;
  sam2SmoothedContourOriginFrames?: Record<string, Point2D[]> | null;
  sam2SmoothingCutoffHz?: number;  // Butterworth cutoff frequency (défaut 4)
  sam2SmoothingValidated?: boolean;

  // V3 "Calcul Corps" — triangulation Delaunay du contour body uniquement (pas d'internes).
  // Indices dans [...sam2ContourAnchors['body'], ...sam2ContourSubdivisionPoints['body']].
  v3BodyTriangles?: [number, number, number][];
  v3BodyTriangulationValidated?: boolean;

  // V2 "Lissage Maillage Corps" — lissage temporel de walkBodyFrames
  walkBodyFramesSmoothed?: Point2D[][] | null;
  walkBodyFramesSmoothingCutoffHz?: number;
  walkBodyFramesSmoothingValidated?: boolean;

  // V2 "Lissage Maillage Pattes" — lissage temporel de walkZoneFrames
  walkZoneFramesSmoothed?: Record<string, Point2D[][]> | null;
  walkZoneFramesSmoothingCutoffHz?: number;
  walkZoneFramesSmoothingValidated?: boolean;

  // V3 "Lissage Bones Pattes" — pré-résolution hip/knee/foot par patte par frame
  // (video coords) puis Butterworth temporel. Coupe le jitter du knee IK à la source.
  sam2LegBoneFrames?: Record<string, { hip: Point2D[]; knee: Point2D[]; foot: Point2D[] }> | null;
  sam2LegBoneFramesSmoothed?: Record<string, { hip: Point2D[]; knee: Point2D[]; foot: Point2D[] }> | null;
  sam2LegBoneSmoothingCutoffHz?: number;
  sam2LegBoneSmoothingValidated?: boolean;

  // ─── CoTracker + Bones (animation type 'cotracker-bones') ──────────────
  // Étape 2 : Points trackables + prompts (multi-frame queries)
  cotrackerPoints?: CoTrackerPoint[];
  // Dimensions vidéo au moment du tracking (invalidation si re-upload)
  cotrackerVideoWidth?: number;
  cotrackerVideoHeight?: number;
  // Résultats CoTracker3 : pointId → positions par frame (coords vidéo).
  // Positions INTERPOLÉES si visibilité disponible (frames occluses remplacées
  // par lerp entre dernière/prochaine position visible) — l'aval consomme ce champ.
  cotrackerFrames?: Record<string, Point2D[]> | null;
  // Trajectoires brutes serveur (avant interpolation occlusion) — permet de
  // rejouer le seuil sans relancer l'inférence. Coords vidéo.
  cotrackerFramesRaw?: Record<string, Point2D[]> | null;
  // Visibilité CoTracker3 par point par frame (0..1 ; bool serveur → 0/1,
  // fractionnaire après agrégation multi-query / subsample). null si ancien serveur.
  cotrackerVisibility?: Record<string, number[]> | null;
  // Seuil utilisé pour dériver cotrackerFrames depuis Raw (défaut 0.5)
  cotrackerVisibilityThreshold?: number;
  cotrackerTrackingValidated?: boolean;
  // Étape 3 : squelette N-aire référencé sur les points CoTracker
  cotrackerSkeleton?: CoTrackerSkeleton;
  cotrackerBonesValidated?: boolean;
  // Étape 5 : lissage Butterworth des positions joints (pré-résolution IK)
  // Chaîne complète par patte : chain[i][f] = position du joint i à la frame f.
  // chain[0] = hip, chain[N-1] = foot, intermédiaires entre. Coords vidéo.
  cotrackerLegBoneFrames?: Record<string, { chain: Point2D[][] }> | null;
  cotrackerLegBoneFramesSmoothed?: Record<string, { chain: Point2D[][] }> | null;
  cotrackerBodyJointFrames?: Point2D[][] | null;          // [jointIdx][frameIdx]
  cotrackerBodyJointFramesSmoothed?: Point2D[][] | null;
  cotrackerBoneSmoothingCutoffHz?: number;
  cotrackerBoneSmoothingValidated?: boolean;
  // Étape "LBS" : paramètres du solver de skinning
  cotrackerLBSParams?: CoTrackerLBSParams;
  cotrackerLBSValidated?: boolean;
  // Jaw bone : openness ∈ [0,1] par frame, pilote la rotation de projectMouth.
  // null si l'animation n'a pas de jaw bone.
  cotrackerJawOpennessFrames?: number[] | null;
  // Pupille des yeux : eyeId → offset par frame en repère LOCAL de l'œil (coords
  // image), relatif au centre de l'œil déformé, clampé dans l'ellipse 1.
  // Consommé par EyeBlinkOverlay pendant la lecture de cette animation.
  cotrackerEyePupilFrames?: Record<string, Point2D[]> | null;

  // ─── Marche (animation type 'marche') ──────────────────────────────────
  // Étape 1 : héritage depuis une animation parente cotracker-bones (snapshot)
  marcheParentAnimationId?: string | null;
  marcheSkeleton?: CoTrackerSkeleton | null;
  marcheBodyJointRestPositions?: Point2D[];      // coords image (frame 0 du parent, mappées)
  marcheLegRestPositions?: Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }>;
  marcheInheritValidated?: boolean;
  // Étape 2 : sélection des pattes participant au cycle de marche
  marcheGaitLegIds?: string[];
  marcheGaitLegsValidated?: boolean;
  // Phase d'oscillation par patte (0..1), keyé par leg.id. Utilisé pour gait ET non-gait.
  // Si absent : préset 4-pattes [0,.5,.25,.75] pour gait, 0.37*idx pour non-gait.
  marcheLegPhases?: Record<string, number>;
  // Étape 3 : params + sortie via walkParams + walkBodyFrames + walkZoneFrames (champs existants)

  // Walk animation data (optional — only used by walk animations)
  walkLimbSeparation?: WalkLimbSeparation | null;
  walkLimbSeparationValidated?: boolean;
  walkSkeleton?: WalkSkeletonDefinition | null;
  walkSkeletonValidated?: boolean;
  walkBodyTriangles?: number[];      // indices de triangles formant le torse
  walkBodyValidated?: boolean;
  walkParams?: WalkParams | null;
  walkParamsValidated?: boolean;
  walkHiddenFaceValidated?: boolean;

  // Sortie finale (consumed by AnimationPlayer)
  crossfadeFrames?: number;  // Nombre de frames de crossfade pour la boucle seamless (défaut 7)
  videoFramesMesh: Point2D[][] | null;  // allPoints par frame
  // Walk limb separation frames (alternative à videoFramesMesh pour walk avec séparation)
  walkZoneFrames?: Record<string, Point2D[][]> | null;  // zoneId → frames par zone
  walkBodyFrames?: Point2D[][] | null;                   // frames du corps (inclut les triangles face cachée)
}

export interface BodyZone {
  id: string;
  label: string;
  color: string;
  triangleIndices: number[];
}

export interface ZoneAnimationMapping {
  zoneId: string;
  animationId: string;
}

export interface MarkerCorners {
  topLeft: Point2D;
  topRight: Point2D;
  bottomLeft: Point2D;
  bottomRight: Point2D;
}

export interface WalkLegDefinition {
  baseIndex: number;      // index dans walkKeyPoints (hanche/épaule)
  kneeIndex: number;      // index dans walkKeyPoints (genou)
  footIndex: number;      // index dans walkKeyPoints (pied)
  phaseOffset: number;    // 0-1, déphasage dans le cycle
}

export interface WalkSkeletonDefinition {
  keyPoints: Point2D[];           // 14 points placés sur le canvas (espace image)
  legs: [WalkLegDefinition, WalkLegDefinition, WalkLegDefinition, WalkLegDefinition];
  neckChain: [number, number, number];  // indices: baseCou, baseTête, sommetTête
  tailChain: [number, number, number];  // indices: baseQueue, milieuQueue, pointeQueue
}

export interface WalkParams {
  speed: number;           // cycles/seconde (0.5-3, défaut 1)
  strideLength: number;    // amplitude horizontale du pas en px (10-200, défaut 80)
  footLift: number;        // hauteur max pied en l'air en px (5-100, défaut 30)
  bodySway: number;        // oscillation verticale du corps en px (0-30, défaut 8)
  headSway: number;        // intensité oscillation cou/tête (0-100, défaut 50)
  kneeForwardFront: boolean;  // si true, genoux avant plient vers l'avant (humain) au lieu de l'arrière (cheval)
  kneeForwardBack: boolean;   // si true, genoux arrière plient vers l'avant (humain) au lieu de l'arrière (cheval)
  direction?: 1 | -1;         // sens de marche : 1 = droite, -1 = gauche (défaut 1)
  secondarySway?: number;     // oscillation secondaire des membres non-gait (0-100, défaut 30)
  jumpHeight?: number;        // hauteur de saut du corps quand les pattes décollent (px, défaut 0)
}

// ─── Walk Limb Separation ─────────────────────────────────────────────

export interface BezierNode {
  anchor: Point2D;
  handleIn: Point2D;     // handle vers le nœud précédent
  handleOut: Point2D;    // handle vers le nœud suivant
  smooth: boolean;       // false = corner (ligne brisée), true = courbe (handles visibles)
}

export interface WalkLimbZone {
  id: string;                    // crypto.randomUUID()
  label: string;                 // "Patte AV gauche"
  color: string;                 // hex pour l'éditeur
  bezierNodes: BezierNode[];     // courbe fermée (dernier → premier)
  zOrder: number;                // ordre de rendu (0 = derrière, 4 = devant tout)
  legIndex: number;              // 0-3, correspondance avec les legs du squelette walk
}

// ─── SAM 2 zones (members-bones animation) ────────────────────────────

/** SAM 2 prompt label : 0 = background, 1 = foreground */
export type SAM2PromptLabel = 0 | 1

/** A single SAM 2 prompt point assigned to a zone */
export interface SAM2Prompt {
  x: number              // image coordinates
  y: number
  zoneId: string         // libre — 'body' réservé pour la zone corps
  label: SAM2PromptLabel
}

/** Une zone SAM 2 : 'body' (zone corps obligatoire) + 0..N membres (tête, pattes, queue, ailes...) */
export interface SAM2Zone {
  id: string             // 'body' réservé pour la zone corps ; autres IDs libres
  label: string          // libellé custom (renommable par l'admin)
  color: string          // hex for the editor / overlay
  zOrder?: number        // ordre de rendu (0 = derrière, plus grand = devant). Défini dans l'étape maillage.
}

/** RLE COCO uncompressed mask, JSON-friendly. counts is alternated bg/fg run lengths,
 *  always starting with a background run (length may be 0). */
export interface RLEMask {
  size: [number, number]  // [H, W] in video pixels
  counts: number[]
}

export interface HiddenFaceZone {
  limbZoneId: string;              // réf WalkLimbZone.id (patte associée)
  bodyVertexA: number;             // index dans bodyPoints du vertex de départ du contour bridge
  bodyVertexB: number;             // index dans bodyPoints du vertex de fin du contour bridge
  bridgePoints: Point2D[];         // points manuels placés entre A et B (contour intérieur)
  bodyTriangleIndices: number[];   // indices dans bodyTriangles[] marqués comme face cachée
}

export interface HiddenFaceLimbZone {
  /** ID unique de cette face cachée. Permet plusieurs faces cachées par membre
   *  (ex : aile cachée par body ET par tête). Absent sur les anciens projets ; le
   *  deserializer en génère un à la volée. */
  id?: string;
  limbZoneId: string;              // réf WalkLimbZone.id (patte à étendre)
  zoneVertexA: number;             // index dans zonePoints[limbZoneId] — vertex de contour A
  zoneVertexB: number;             // index dans zonePoints[limbZoneId] — vertex de contour B
  bridgePoints: Point2D[];         // points manuels étendant la patte vers l'extérieur
  zoneTriangleIndices: number[];   // indices dans zoneTriangles[limbZoneId] marqués comme extension
}

export interface WalkLimbSeparation {
  zones: WalkLimbZone[];
  overlapMargin: number;                                      // pixels de chevauchement (défaut 3)
  // Per-zone fresh triangulation (own points + triangles, independent of rest mesh)
  zonePoints: Record<string, Point2D[]>;                      // zoneId → all vertices (contour samples + internals)
  zoneTriangles: Record<string, [number, number, number][]>;  // zoneId → triangles (indices dans zonePoints[zoneId])
  // Body = rest triangles not touching any limb zone (vertex-based filtering)
  bodyTriangleIndices: number[];                               // indices into rest mesh triangles[]
  // Body mesh (auto rest triangles + manual patch)
  bodyZOrder?: number;                                         // zIndex du body (défaut 0 si absent)
  bodyPoints?: Point2D[];                                      // all body vertices (auto + manual extras)
  bodyTriangles?: [number, number, number][];                  // all body triangles (auto + manual, indexed into bodyPoints)
  bodyExtraPoints?: Point2D[];                                 // manually added points
  bodyManualTriangles?: [number, number, number][];            // manually created triangles (indexed into bodyPoints)
  // Hidden face zones (optional — one per limb, behind each leg)
  hiddenFaceZones?: HiddenFaceZone[];                          // 0-4 zones face cachée body
  // Hidden face limb zones (optional — extension de patte cachée derrière le corps)
  hiddenFaceLimbZones?: HiddenFaceLimbZone[];                  // 0-4 zones face cachée jambe
}

// ─── Project-level Triangulation (shared by all members-bones animations) ────

export interface ProjectTriangulation {
  // Étape 0 : Image de référence (colorée, pour SAM 2)
  referenceImageBlob: Blob | null

  // Étape 1 : Zones SAM 2 sur image
  zones: SAM2Zone[]
  prompts: SAM2Prompt[]
  masksRLE: Record<string, RLEMask[]> | null   // 1 frame par zone
  maskWidth: number
  maskHeight: number
  contours: Record<string, Point2D[]> | null    // zoneId → contour lissé (coords IMAGE)
  contourSmoothSigma: number
  bridgeThreshold: number
  step1Validated: boolean
  // Segmentation method used to produce masksRLE/contours at step 1.
  // 'sam2' (default) = Cloud Function / local SAM 2 server.
  // 'canny' = Canny + findContours on the reference image (coloring book trace).
  segmentationMode?: 'sam2' | 'canny'
  cannyParams?: CannyParams | null   // only used when segmentationMode === 'canny'
  /** Seeds (clics admin) par zone membre, en coords image. Permet de
   *  reprendre l'édition d'une zone après reload : ajouter / retirer un
   *  seed et relancer le calcul Canny.
   *  Le body n'a pas de seeds (silhouette auto-détectée). */
  zoneSeeds?: Record<string, Point2D[]>
  /** Override sigma (lissage gaussien) par zone (sinon prend `contourSmoothSigma`). */
  zoneSmoothSigmas?: Record<string, number>
  /** Override inflate (dilatation Canny) par zone (sinon prend le slider global). */
  zoneInflates?: Record<string, number>
  /** Représentation Bézier éditable par zone. Si présent pour une zone, c'est
   *  cette courbe qui fait foi — le contour Canny est remplacé par la
   *  Bézier aplatie (`flattenClosedBezier`). Permet l'ajustement manuel. */
  zoneBeziers?: Record<string, BezierNode[]>
  /** Contour Canny lissé snapshoté au moment de la conversion en Bézier.
   *  Sert de **référence** pour le re-fit à N anchors via le slider — on
   *  resample TOUJOURS depuis ce contour, jamais depuis la Bézier courante,
   *  afin de retrouver au maximum la forme Canny d'origine. */
  zoneCannyRefs?: Record<string, Point2D[]>

  // Étape 2 : Maillage par zone — placement curviligne (V3) + Delaunay interne
  // Phase 1 : P0 par zone (coords image, snap courbure)
  zoneOrigins?: Record<string, Point2D>                       // zoneId → P0
  zoneOriginsValidated?: Record<string, boolean>              // zoneId → P0 validé
  // Phase 2 : Anchors contour par zone (P0 inclus comme [0], tri arc-length depuis P0)
  zoneAnchors?: Record<string, Point2D[]>                     // zoneId → anchors caractéristiques
  zoneAnchorsValidated?: Record<string, boolean>              // zoneId → anchors validés
  // Phase 3 : Subdivision par zone (params curvilignes + points générés)
  zoneSubdivisionPoints?: Record<string, Point2D[]>           // zoneId → points subdivision
  zoneSubdivisionParams?: Record<string, CurvilinearParam[]>  // zoneId → params curvilignes (auto + manuels mergés)
  zoneManualSubdivisionParams?: Record<string, CurvilinearParam[]>  // zoneId → params curvilignes des points manuels ajoutés après auto
  zoneManualSubdivisionPoints?: Record<string, Point2D[]>            // zoneId → positions snappées sur la polyligne maillage (parallèle à params)
  zoneSubdivisionValidated?: Record<string, boolean>          // zoneId → subdivision validée
  zonePixelAdjusted?: Record<string, boolean>                 // zoneId → ajustement pixel actif (gèle le recalcul curviligne)
  // Phase 4 : Delaunay interne + layout
  zoneContourLength?: Record<string, number>                  // zoneId → nb points contour (contour = N premiers indices de zonePoints)
  // Legacy (conservés pour migration) : utilisés quand zoneAnchors absent
  zoneContourCount: Record<string, number>                   // zoneId → nb points contour (slider legacy)
  zoneContourPoints: Record<string, Point2D[]>               // zoneId → vertices contour legacy
  zoneContourValidated: Record<string, boolean>              // zoneId → contour verrouillé (legacy)
  zonePoints: Record<string, Point2D[]>                      // zoneId → vertices (contour + internes)
  zoneTriangles: Record<string, [number, number, number][]>  // zoneId → triangles Delaunay
  zoneManualPoints?: Record<string, Point2D[]>                      // zoneId → points internes manuels (mode "Ajouter")
  zoneManualTriangles?: Record<string, [number, number, number][]>  // zoneId → triangles manuels (mode "Relier") indexés sur [...cPts, ...autoInternal, ...manualPoints]
  zoneDensity: Record<string, number>                        // zoneId → slider densité intérieure
  bodyPoints: Point2D[]
  bodyTriangles: [number, number, number][]
  /** Snapshot du body mesh "propre" (avant fusion des faces cachées). Permet
   *  au step3 de réinitialiser une face cachée body sans laisser de résidus.
   *  Capturé à chaque validation de step2 avant le replay des hidden faces. */
  bodyPointsBaseline?: Point2D[]
  bodyTrianglesBaseline?: [number, number, number][]
  /** Snapshots équivalents pour chaque zone membre (faces cachées limb). */
  zonePointsBaseline?: Record<string, Point2D[]>
  zoneTrianglesBaseline?: Record<string, [number, number, number][]>
  step2Validated: boolean

  // Étape 3 : Faces cachées (même structure que Walk)
  hiddenFaceZones: HiddenFaceZone[]          // corps caché derrière patte
  hiddenFaceLimbZones: HiddenFaceLimbZone[]  // extension patte sous corps
  step3Validated: boolean

  // Étape 5 : Preview / Rendu — épaisseur du contour noir ajouté autour de chaque zone (px image).
  // L'érosion de 1px (gomme blanc résiduel) est appliquée automatiquement en plus.
  outlineWidthGlobal?: number                          // défaut 2
  outlineWidthByZone?: Record<string, number>          // override par zone (sinon prend global)
  /** Alignement du trait : 0 = 100% extérieur, 0.5 = centré, 1 = 100% intérieur. Défaut 0.5. */
  outlineAlignment?: number
  /** Override alignement par zone (sinon prend outlineAlignment global). */
  outlineAlignmentByZone?: Record<string, number>
  /** Lissage du contour : 0 = ligne brisée, 5 = très lisse (Chaikin iters). Défaut 0. */
  outlineSmoothing?: number
  outlineSmoothingByZone?: Record<string, number>
  /** Couleur du trait par zone (hex). Défaut "#000". */
  outlineColorByZone?: Record<string, string>
  /** Décalage (inflate/deflate) du contour en px image. Positif = vers l'extérieur, négatif = vers l'intérieur. Défaut 0. */
  outlineInflateGlobal?: number
  outlineInflateByZone?: Record<string, number>
  previewInpaintingEnabled?: boolean                   // toggle inpainting LaMa dans le preview
}

export type AnimationType = 'rest' | 'oneshot' | 'physics' | 'bone' | 'walk' | 'members-bones' | 'members-bones-v2' | 'members-bones-v3' | 'cotracker-bones' | 'marche';

// ─── CoTracker3 + Bones (animation type 'cotracker-bones') ────────────────

/** Prompt CoTracker pour un point trackable : position à une frame donnée.
 *  CoTracker3 accepte plusieurs prompts par point (queries multi-frame). */
export interface CoTrackerPrompt {
  frameIdx: number;
  x: number;            // coords vidéo
  y: number;
}

/** Un point trackable défini par l'admin + prompts (1+ frames). */
export interface CoTrackerPoint {
  id: string;           // crypto.randomUUID()
  name?: string;
  color: string;        // hex
  prompts: CoTrackerPrompt[];
}

/** Référence d'endpoint N-aire : combinaison linéaire de N points trackés.
 *  position = sum(weights[i] * pointFrames[pointIds[i]]) — weights normalisés. */
export interface CoTrackerEndpointRef {
  pointIds: string[];   // référence CoTrackerPoint.id
  weights: number[];    // même longueur que pointIds, somme = 1
}

export interface CoTrackerBodyJoint {
  id: string;
  name: string;
  ref: CoTrackerEndpointRef;
}

export interface CoTrackerLegBone {
  id: string;
  zoneId: string;       // libre — ID de la zone membre (≠ 'body')
  name: string;
  hip: CoTrackerEndpointRef;
  // Joints intermédiaires (0..N) entre hip et foot. Chaîne complète = [hip, ...joints, foot].
  // Chaque joint est un barycentre N-aire de points CoTracker (comme la body chain).
  joints: CoTrackerEndpointRef[];
  foot: CoTrackerEndpointRef;
  // Optionnel : hip attaché à un body vertex (override) — comme V2/V3
  hipBodyVertexIndices?: number[] | null;
  hipBodyVertexWeights?: number[] | null;
  // Mode de résolution des joints intermédiaires :
  //  - 'barycentre' (défaut) : chaque joint = barycentre N-aire des points CoTracker
  //  - 'solver' : 2 segments / 3 joints (hip→knee→foot). Hip & foot par barycentre,
  //    knee résolu par IK 2-bones (longueurs fixes du rest pose). `joints[0].pointIds`
  //    est ignoré dans ce mode.
  legSolverMode?: 'barycentre' | 'solver';
  // Utilisé uniquement en mode 'solver' : position de repos du genou (coords vidéo).
  // Détermine L1, L2 et bendSide via solveElbowIK / getElbowParams.
  kneeRestPos?: Point2D | null;
  kneeMode?: ElbowMode;  // défaut 'rest'
}

/** Bone "machoire" optionnel : pilote l'angle d'ouverture de la zone bouche Bézier
 *  (project.projectMouth) à partir d'UN point cotracker tracké à la pointe de la
 *  mâchoire. Pas de LBS — produit un openness ∈ [0,1] par frame combiné avec la
 *  parole via max(openness_parole, openness_jaw). */
export interface CoTrackerJawBone {
  id: string;
  name: string;
  /** Barycentre N-aire de cotracker points qui définit la pointe de la mâchoire. */
  tailRef: CoTrackerEndpointRef;
  /** Vecteur unitaire pivot→tail au repos (frame 0, image coords). Sert de
   *  référence "bouche fermée" pour le calcul de l'angle relatif. */
  restDirImage: Point2D;
  /** Override optionnel du maxOpenAngleDeg de projectMouth. */
  maxOpenAngleDegOverride?: number | null;
}

/** Lien œil → point cotracker. La pupille de l'œil (project.projectEyes) suit ce
 *  point pendant la lecture de cette animation. Défini par animation (hérité avec
 *  le squelette). */
export interface CoTrackerEyeLink {
  eyeId: string;        // référence EyeRegion.id (project.projectEyes)
  pointId: string;      // référence CoTrackerPoint.id
}

export interface CoTrackerSkeleton {
  bodyChain: CoTrackerBodyJoint[];
  legs: CoTrackerLegBone[];
  jaw?: CoTrackerJawBone | null;
  /** Liens œil→point cotracker (animation des pupilles). */
  eyeLinks?: CoTrackerEyeLink[] | null;
}

export type CoTrackerLBSMode = 'lbs-arap' | 'lbs-contour-arap';

export interface CoTrackerLBSParams {
  mode: CoTrackerLBSMode;
  /** Exposant de chute des weights : w = 1/(d+ε)^p. Plus haut = plus local. */
  weightPower: number;
  weightEpsilon: number;
  /** lbs-arap : itérations ARAP par frame (2-6 raisonnable). */
  arapIterations?: number;
  /** Lissage Laplacien des weights le long du mesh. 0 = désactivé. */
  weightSmoothIterations?: number;
  /** Force du lissage par itération (0-1, défaut 0.5). */
  weightSmoothAlpha?: number;
  /** lbs-contour-arap : force d'attache du contour aux positions LBS (> 0). */
  contourArapLambda?: number;
  /** lbs-contour-arap : itérations local/global du solver 1D contour. */
  contourArapIterations?: number;
  /** Post-pass préservation d'aire lissée (0 = off, 1 = pleine correction par itération). */
  areaPostStrength?: number;
  /** Post-pass préservation d'aire : itérations. */
  areaPostIterations?: number;
}

export const DEFAULT_COTRACKER_LBS_PARAMS: CoTrackerLBSParams = {
  mode: 'lbs-arap',
  weightPower: 2,
  weightEpsilon: 1,
  arapIterations: 3,
  weightSmoothIterations: 0,
  weightSmoothAlpha: 0.5,
  contourArapLambda: 1.0,
  contourArapIterations: 2,
  areaPostStrength: 0,
  areaPostIterations: 3,
};

/**
 * Mode de lecture d'une animation, orthogonal à son type de pipeline.
 * - 'loop'    : jouable en boucle infinie (idle, fond), avec crossfade.
 * - 'oneshot' : jouée une seule fois sur déclenchement.
 */
export type AnimationPlaybackMode = 'loop' | 'oneshot';

export interface Animation {
  id: string;
  name: string;
  type: AnimationType;
  /**
   * Mode de lecture. Optionnel pour rétro-compat (projets legacy : voir getPlaybackMode).
   */
  playbackMode?: AnimationPlaybackMode;
  createdAt: number;
  videoBlob: Blob | null;
  mesh: MeshData | null;
  physicsCode: string | null;
  physicsDuration: number | null;
  physicsOverlay: boolean;
  audioBlob: Blob | null;
  audioEnabled: boolean;
}

/**
 * Mode de lecture effectif. Par défaut : 'oneshot' (migration safe).
 * Le type 'rest' n'est plus traité spécialement — un projet legacy avec une
 * animation rest devra être basculé manuellement en 'loop' par l'utilisateur.
 */
export function getPlaybackMode(anim: Animation): AnimationPlaybackMode {
  return anim.playbackMode ?? 'oneshot';
}

export function isLoopAnimation(anim: Animation): boolean {
  return getPlaybackMode(anim) === 'loop';
}

/** Check if an animation has computed frames (single mesh or separated zones). */
export function animationHasFrames(anim: Animation): boolean {
  const m = anim.mesh
  if (!m) return false
  return (m.videoFramesMesh != null && m.videoFramesMesh.length > 0)
    || (m.walkZoneFrames != null && m.walkBodyFrames != null)
}

/**
 * Animation utilisée pour le playback "idle" d'une scène ou du player legacy.
 * Priorité : 1) animation explicitement référencée par `preferredId` ; 2) première
 * animation en mode loop avec frames ; 3) première animation legacy `type === 'rest'`
 * avec frames ; 4) première animation prête tout court.
 */
export function getIdleAnimation(animations: Animation[], preferredId?: string): Animation | undefined {
  if (preferredId) {
    const explicit = animations.find(a => a.id === preferredId)
    if (explicit && animationHasFrames(explicit)) return explicit
  }
  const ready = animations.filter(animationHasFrames)
  return ready.find(isLoopAnimation) ?? ready.find(a => a.type === 'rest') ?? ready[0]
}

/**
 * Animation source de la topologie partagée (= mesh affiché à l'admin pour les
 * éditeurs transverses : zones corporelles, scène, preview). En legacy c'est
 * l'animation `type === 'rest'`. Fallback : n'importe quelle animation avec un
 * mesh dont la topologie est verrouillée, ou à défaut un mesh quelconque.
 */
export function getGeometryOwner(animations: Animation[]): Animation | undefined {
  return animations.find(a => a.type === 'rest')
    ?? animations.find(a => a.mesh?.topologyLocked === true)
    ?? animations.find(a => a.mesh != null && (a.mesh.triangles?.length ?? 0) > 0)
}

/**
 * Son rattaché à une référence d'animation (rest point random ou segment).
 * `blob` est nullable car les métadonnées sont chargées avant les blobs Storage.
 */
export interface SceneSound {
  id: string;
  name: string;
  blob: Blob | null;
  /** Volume de lecture entre 0 et 1 (défaut 1). */
  volume?: number;
  /** Si true, le son boucle tant que son animation/trajet joue, puis est coupé
   *  (ex. bruit de pas pendant toute la marche). Ignoré si le son est « parlé ». */
  loop?: boolean;
  /** Vitesse de lecture du son (playbackRate, défaut 1). Permet de synchroniser
   *  le son avec l'animation (ex. pas plus rapides quand l'anim est accélérée). */
  rate?: number;
}

/**
 * Une étape d'une action : 1 animation + un son optionnel propre à l'étape (bruitage),
 * avec un toggle `isSpoken` qui pilote la bouche (lip-sync RMS) le temps du son.
 */
export interface SceneActionStep {
  animationId: string;
  sound?: SceneSound;
  isSpoken?: boolean;
  /** Multiplicateur de vitesse de LECTURE de l'animation de cette étape (défaut 1). */
  animSpeedMul?: number;
  /** Si true, l'animation de cette étape est REJOUÉE en boucle jusqu'à la fin de
   *  l'action (durée = son d'action / dernier son d'étape). Permet p. ex. de courir
   *  sur place pendant toute la durée d'un dialogue superposé. */
  loop?: boolean;
}

/**
 * Une ACTION = séquence ordonnée d'étapes + 1 son optionnel "action" (typiquement
 * dialogue) lancé au début, avec son propre toggle `isSpoken`. Le son d'action
 * et les sons d'étape se superposent.
 */
export interface SceneAction {
  id: string;
  name: string;
  steps: SceneActionStep[];
  sound?: SceneSound;
  isSpoken?: boolean;
}

export interface SceneRestPoint {
  id: string;
  backgroundX: number;
  restAnimationId?: string;
  /** Bouton ACTION (logo étoile). On n'utilise que `actions[0]` (séquence unique). */
  actions?: SceneAction[];
  /** Boutons « Discours » (1, 2, 3) — mêmes séquences que les actions. Max 3. */
  speeches?: SceneAction[];
  /** Animation de présentation (intro) : jouée une fois automatiquement à l'arrivée
   *  au rest point, AVANT que l'interaction ne soit débloquée. Même structure qu'une
   *  action (séquence d'animations + son optionnel avec toggle « parlé »). */
  presentation?: SceneAction;
  /** @deprecated legacy lecture-seule, migré vers `actions` à la lecture. */
  randomAnimationIds?: string[];
  /** @deprecated legacy lecture-seule. */
  randomAnimationSounds?: SceneSound[][];
  zoneAnimationMappings?: ZoneAnimationMapping[];
  speakSoundIds?: string[];
  helpTexts?: string[];
  arrivalCrossfadeMs?: number;
}

export interface SpeakSound {
  id: string;
  name: string;
  /** Si true, déclenche l'animation de la bouche (lip-sync amplitude) pendant la lecture. */
  isVoice?: boolean;
}

export type SegmentEasing = 'smoothstep' | 'linear' | 'ease-out' | 'ease-in';

export interface SceneSegment {
  duration: number;
  animationId?: string;
  easing?: SegmentEasing;
  crossfadeMs?: number;
  /** Sons attachés à l'animation de ce segment. */
  sounds?: SceneSound[];
}

export interface SceneTransition {
  waypoints: number[];
  segments: SceneSegment[];
}

/** Arrière-plan de la scène. Image ou vidéo (en boucle). */
export interface SceneBackground {
  imageBlob: Blob | null;
  videoBlob: Blob | null;
  width: number;
  height: number;
}

/** Avant-plan superposé devant le personnage. PNG transparent statique OU vidéo
 *  (avec chroma key au rendu : la couleur uniforme du fond est rendue transparente).
 *  Doit avoir les mêmes dimensions que l'arrière-plan pour s'aligner. */
export interface SceneForeground {
  imageBlob: Blob | null;
  videoBlob: Blob | null;
  width: number;
  height: number;
  /** Couleur (hex "#rrggbb") rendue transparente par chroma key. Null = pas de chroma
   *  (PNG transparent natif ou vidéo sans suppression). Défaut "#000000" pour vidéo. */
  chromaKeyColor?: string | null;
  /** Tolérance chroma key [0..1]. 0 = match strict de la couleur, 1 = tout pixel rendu transparent.
   *  Défaut 0.1. */
  chromaKeyThreshold?: number;
  /** Largeur de la bande de transition douce [0..0.5]. Plus élevé = bord plus flou et progressif.
   *  Défaut 0.12. Indépendant du threshold pour pouvoir corriger les liserés sans toucher la sélection. */
  chromaKeySmoothness?: number;
}

export interface SceneWalkTrapezoid {
  /** 4 coins en coords du layer front (premier plan), ordre topLeft, topRight, bottomRight, bottomLeft.
   *  Top = "arrière" (loin caméra, scale min), Bottom = "avant" (proche caméra, scale max). */
  topLeft: Point2D;
  topRight: Point2D;
  bottomRight: Point2D;
  bottomLeft: Point2D;
  /** Multiplicateur de `Scene.characterScale` au sommet du trapèze (loin). */
  scaleAtTop: number;
  /** Multiplicateur de `Scene.characterScale` au bas du trapèze (proche). */
  scaleAtBottom: number;
  /** Inclinaison max en degrés appliquée quand la marche est oblique (±). */
  tiltDegMax: number;
  /** Skew vertical max (cisaillement) appliqué quand la marche est oblique (±). */
  skewYMax: number;
  /** Id d'une `Animation` de type 'marche' du projet à jouer en boucle pendant le déplacement. */
  walkAnimationId: string;
  /** Vitesse en pixels (coords background front) par seconde. */
  walkSpeedPxPerSec: number;
  /** Frame de démarrage du cycle de marche (le perso commence le pas à cette frame).
   *  Défaut 0 ; un offset permet d'aligner le départ sur une frame "pas naturel". */
  walkStartFrame?: number;
  /** Angle (degrés depuis l'horizontale) au-delà duquel le trajet est considéré trop pentu.
   *  Dans ce cas, on emprunte un trajet horizontal-edge→téléport→horizontal-edge au lieu
   *  d'un diagonale qui ferait glisser le perso. Défaut 20°. */
  walkSteepAngleThresholdDeg?: number;
}

/**
 * Mode film : la scène se joue seule comme une vidéo. Un film = un CHEMIN de
 * points posés sur le décor. Entre les points, le personnage se déplace
 * (animation de déplacement + vitesse + son optionnel) ; à chaque point il joue
 * une séquence d'animations avec sons (SceneAction). L'entrée (hors-champ) et
 * la fin (sortie de champ ou fin sur place) font partie du chemin. La caméra
 * est FIXE (cadrage `cameraX`), l'échelle du perso est définie par point et
 * interpolée pendant les trajets.
 */

/** Origine d'un trajet entrant. Absent = `{ kind: 'previous' }` (rétro-compat).
 *  'offscreen'/'custom' téléportent le perso au départ du trajet — si le point
 *  précédent n'a pas de `departure`, la disparition est un cut sec (voulu).
 *  'appear' = PAS de trajet : le perso apparaît directement posé sur le point
 *  (utile en début de plan après une transition). */
export type FilmTravelOrigin =
  | { kind: 'previous' }
  | { kind: 'offscreen'; side: 'left' | 'right' }
  | { kind: 'custom'; x: number; y: number }
  | { kind: 'appear' };

export type FilmTravelEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/** Trajet ENTRANT vers un point (ou vers la sortie). */
export interface FilmTravel {
  /** Animation de déplacement ; défaut = `SceneFilm.moveAnimationId`. */
  animationId?: string;
  /** Vitesse en px background/s ; défaut = `SceneFilm.moveSpeedPxPerSec`. */
  speedPxPerSec?: number;
  /** Multiplicateur de vitesse de LECTURE de l'animation de déplacement (défaut 1).
   *  Ex. déplacement 2× plus rapide → animSpeedMul 2 pour que les jambes suivent. */
  animSpeedMul?: number;
  /** Son joué pendant le trajet, coupé à l'arrivée. */
  sound?: SceneSound;
  /** Origine du trajet (défaut : point précédent). Ignoré sur les trajets sortants
   *  (departure/ending) qui partent toujours du point courant. */
  origin?: FilmTravelOrigin;
  /** Points de contrôle Bézier en coords background : 0/absent = ligne droite,
   *  1 = quadratique, 2 = cubique. Vitesse constante en espace (paramétrisation arc-length). */
  controlPoints?: Point2D[];
  /** Easing temporel du trajet (défaut linear). Module la vitesse instantanée,
   *  la durée totale (= distance/vitesse) est inchangée. */
  easing?: FilmTravelEasing;
}

/** Cible d'un trajet de sortie de point (symétrique de FilmTravelOrigin). */
export type FilmDepartureTarget =
  | { kind: 'offscreen'; side: 'left' | 'right' }
  | { kind: 'custom'; x: number; y: number; scale?: number };

/** Trajet SORTANT d'un point, joué après l'action/pause. Permet au perso de
 *  sortir hors-champ (ou d'aller à une position libre) avant que le point
 *  suivant le fasse revenir d'ailleurs — jamais de téléportation visible. */
export interface FilmDeparture {
  target: FilmDepartureTarget;
  travel: FilmTravel;
}

export interface FilmPoint {
  id: string;
  /** Position de l'origine du perso, en coords background. */
  x: number;
  y: number;
  /** Échelle du perso à ce point (défaut 1). Interpolée pendant les trajets. */
  scale: number;
  /** Trajet entrant (depuis le point précédent ; pour le 1er : depuis l'entrée hors-champ). */
  travel: FilmTravel;
  /** Séquence jouée à l'arrivée. Absent = point de passage. */
  action?: SceneAction;
  /** Attente en idle au point (après l'action si présente), en ms. */
  pauseMs?: number;
  /** Sens du regard du perso À CE POINT (idle). Absent = auto (garde le sens
   *  d'arrivée du trajet). Appliqué à l'arrivée au point. */
  facing?: 'left' | 'right';
  /** Trajet de sortie après action/pause (voir FilmDeparture). */
  departure?: FilmDeparture;
}

export type FilmEnding =
  | { kind: 'exit'; side: 'left' | 'right'; travel: FilmTravel }
  | { kind: 'stay' };

/** Transition visuelle entre deux plans du film. */
export type FilmPlanTransition =
  | { kind: 'cut' }
  | { kind: 'fadeBlack'; durationMs?: number }   // défaut 500
  | { kind: 'crossfade'; durationMs?: number }   // défaut 500
  | { kind: 'wipe'; direction: 'left' | 'right' | 'up' | 'down'; durationMs?: number } // défaut 500
  | { kind: 'iris'; durationMs?: number };       // défaut 700

/**
 * LEGACY (moteur + anciens docs) — plan d'un film stocké dans la scène.
 * Le moteur de lecture (ScenePlayer/FilmDirector) consomme cette forme via
 * `buildFilmScene()`. Ne plus utiliser pour l'édition : voir `Film`/`FilmPlan`.
 */
export interface SceneFilmPlan {
  id: string;
  name?: string;
  /** Décor propre au plan. null = fallback sur le décor de la scène
   *  (`Scene.background`/`Scene.foreground`, cas du plan issu de la migration). */
  background: SceneBackground | null;
  foreground: SceneForeground | null;
  /** Centre du cadre caméra fixe, en coords background DU PLAN. */
  cameraX: number;
  /** Côté d'entrée en scène du plan (le perso arrive hors-champ par ce bord). */
  entrySide: 'left' | 'right';
  points: FilmPoint[];
  /** Fin du plan. Plan intermédiaire : la sortie enchaîne sur la transition ;
   *  seule la fin du DERNIER plan déclenche le fade + écran Bravo. */
  ending: FilmEnding;
  /** Transition vers le plan suivant (ignorée sur le dernier plan). Défaut cut. */
  transitionToNext?: FilmPlanTransition;
  /** Défauts de déplacement du plan (fallback → SceneFilm). */
  moveAnimationId?: string;
  moveSpeedPxPerSec?: number;
  idleSpeedMul?: number;
}

/** LEGACY (moteur + anciens docs) — film stocké dans la scène. */
export interface SceneFilm {
  enabled: boolean;
  plans: SceneFilmPlan[];
  /** Animation de déplacement par défaut (fallback global). */
  moveAnimationId?: string;
  /** Vitesse de déplacement par défaut (px background/s, fallback global). */
  moveSpeedPxPerSec: number;
  /** Multiplicateur de vitesse de lecture de l'animation idle aux points (défaut 1).
   *  Ex. idle un peu rapide → 0.5 = 2× plus lent. */
  idleSpeedMul?: number;
  endBehavior: 'menu';
}

// ---------------------------------------------------------------------------
// FILM (niveau projet) — modèle cible, totalement indépendant de la scène.
// Un coloriage = un FILM : une séquence de PLANS (au sens cinéma), chacun avec
// SON décor, son cadrage caméra et son chemin de points. L'app play ne joue
// que les coloriages qui ont un film. Le mode scène interactif est déprécié.
// ---------------------------------------------------------------------------

/** Arrière-plan d'un plan de film : image OU vidéo en boucle. */
export interface FilmBackdrop {
  imageBlob: Blob | null;
  videoBlob: Blob | null;
  width: number;
  height: number;
}

/** Avant-plan d'un plan de film (devant le perso) : PNG transparent ou vidéo chroma key. */
export interface FilmOverlay extends FilmBackdrop {
  chromaKeyColor?: string | null;
  chromaKeyThreshold?: number;
  chromaKeySmoothness?: number;
}

/** PLAN d'un film (au sens cinéma) : SON décor + cadrage + chemin de points. */
export interface FilmPlan {
  id: string;
  name?: string;
  /** Décor du plan. null = plan pas encore prêt (l'éditeur demande l'import). */
  backdrop: FilmBackdrop | null;
  overlay: FilmOverlay | null;
  /** Centre du cadre caméra fixe 16:9, en coords backdrop. */
  cameraX: number;
  /** Côté d'entrée en scène du plan (le perso arrive hors-champ par ce bord). */
  entrySide: 'left' | 'right';
  points: FilmPoint[];
  /** Fin du plan. Intermédiaire : enchaîne sur la transition ; dernier plan : fade + Bravo. */
  ending: FilmEnding;
  /** Transition vers le plan suivant (ignorée sur le dernier plan). Défaut cut. */
  transitionToNext?: FilmPlanTransition;
  /** Défauts de déplacement du plan (fallback → Film). */
  moveAnimationId?: string;
  moveSpeedPxPerSec?: number;
  idleSpeedMul?: number;
}

/** Réglages du personnage DANS le film (indépendants de la scène). */
export interface FilmCharacter {
  /** Échelle de base du perso (multipliée par l'échelle de chaque point). */
  scale: number;
  /** Sens dans lequel le coloriage est dessiné (pilote le flip auto des trajets). */
  facing: 'left' | 'right';
  /** Origine d'ancrage normalisée dans l'image (0..1). Défaut (0.5, 1.0) = pieds. */
  originU: number;
  originV: number;
}

/** Son du film (musique de fond). Blob en Storage `projects/{id}/film/sounds/{id}`. */
export interface FilmSound {
  id: string;
  name: string;
  blob: Blob | null;
  volume?: number;
}

/** FILM d'un coloriage — entité de niveau projet, prioritaire sur la scène. */
export interface Film {
  plans: FilmPlan[];
  character: FilmCharacter;
  /** Musique de fond du film, jouée en boucle continue. */
  music?: FilmSound;
  /** Animation de déplacement par défaut (fallback global des trajets). */
  moveAnimationId?: string;
  /** Vitesse de déplacement par défaut (px backdrop/s). */
  moveSpeedPxPerSec: number;
  /** Multiplicateur de vitesse de lecture de l'idle aux points (défaut 1). */
  idleSpeedMul?: number;
}

/** true si le film a de quoi être joué (au moins un plan avec décor et point). */
export function filmIsPlayable(film: Film | null | undefined): boolean {
  return !!film && film.plans.some(pl => pl.backdrop != null && pl.points.length > 0);
}

export interface Scene {
  id: string;
  name: string;
  background: SceneBackground | null;
  foreground: SceneForeground | null;
  characterScale: number;
  characterY: number;
  /** Point de repos unique de la scène (anciennement restPoints[0]). */
  restPoint: SceneRestPoint;
  /** Zone autorisée de marche + perspective 2.5D. Si null, pas de marche libre. */
  walkTrapezoid?: SceneWalkTrapezoid | null;
  /** Mode film optionnel. Si `film.enabled`, la scène se joue seule (voir SceneFilm). */
  film?: SceneFilm;
  /** Orientation du coloriage tel qu'il est dessiné. 'right' = par défaut (personnage tourné vers la droite),
   *  'left' = personnage dessiné tourné vers la gauche → le rendu applique un flip horizontal de base. */
  characterFacing?: 'right' | 'left';
  /** Origine du personnage normalisée dans l'image du coloriage (0..1).
   *  Le clic en marche libre vise cette origine. Défaut : (0.5, 1.0) = milieu-bas (pieds). */
  characterOriginU?: number;
  characterOriginV?: number;
  /** Mode d'entrée : 'fixed' = apparition immédiate au restPoint, 'moving' = trajet entryStartX → restPoint.backgroundX. */
  entry: 'fixed' | 'moving';
  /** Position X de départ pour entry='moving'. */
  entryStartX?: number;
  /** Durée du trajet d'entrée en ms (défaut 1500). */
  entryDurationMs?: number;
  /** Animation jouée en boucle pendant le trajet d'entrée. Fallback : idle du rest point. */
  entryAnimationId?: string;
  /** Son joué une fois au début de la scène (au démarrage de l'entrée ou à l'apparition immédiate). */
  entrySound?: SceneSound;
  /** Son d'ambiance joué en boucle pendant toute la scène (démarre au chargement). */
  ambientSound?: SceneSound;
  speakSounds: SpeakSound[];
  speakSoundBlobs: (Blob | null)[];
}

export interface EyeRegion {
  id: string;
  /** Source de vérité de la forme : courbe de Bézier fermée (coords IMAGE).
   *  Une ellipse par défaut a 4-8 nœuds smooth ; l'utilisateur peut ajouter/supprimer
   *  des nœuds et basculer smooth↔corner pour une forme custom. */
  bezierNodes: BezierNode[];
  /** Polygone échantillonné depuis bezierNodes (recalculé à la validation).
   *  Consommé par le rendu/clignement et l'ancrage barycentrique. */
  contourPoints: Point2D[];
  barycentricRefs: BarycentricRef[]; // 1 par point, via trackedTriangles du mesh rest
  /** Refs barycentriques contre le maillage de la zone d'attache (voir attachZoneId).
   *  Utilisé pour suivre la déformation des animations walk/members-bones/cotracker. */
  bodyBarycentricRefs?: BarycentricRef[];
  /** Zone du maillage à laquelle l'œil est rattaché ('body' par défaut, ou un id de
   *  zone patte de projectTriangulation). Détermine quels triangles déforment l'œil. */
  attachZoneId?: string;
  seed: Point2D;                    // centre approximatif (debug)

  // ─── Rendu de l'œil dessiné (3 ellipses) ───────────────────────────────
  /** Épaisseur du contour de la sclère, en px image. Défaut 3. */
  outlineThickness?: number;
  /** Couleur de remplissage de la sclère (ellipse 1). Défaut '#ffffff'. */
  scleraColor?: string;
  /** Couleur du contour de la sclère. Défaut '#000000'. */
  outlineColor?: string;
  /** Couleur de la pupille (ellipse 2 pleine). Défaut '#000000'. */
  pupilColor?: string;
  /** Rayon de la pupille en fraction du demi-petit-axe de l'œil. Défaut 0.45. */
  pupilRadiusFrac?: number;
  /** Position de repos de la pupille (repère local de l'œil, fraction des demi-axes).
   *  {0,0} = centrée. Le suivi de tracking s'ajoute par-dessus. Défaut {0,0}. */
  pupilOffsetFrac?: Point2D;
  /** Couleur du reflet (ellipse 3). Défaut '#ffffff'. */
  reflectionColor?: string;
  /** Rayon du reflet en fraction du rayon pupille. Défaut 0.30. */
  reflectionRadiusFrac?: number;
  /** Offset du reflet dans la pupille (repère local de l'œil, fraction du rayon pupille). Défaut {-0.3,-0.3}. */
  reflectionOffsetFrac?: Point2D;
}

export interface ProjectEyes {
  regions: EyeRegion[];
  blinkEnabled: boolean;
  blinkDurationMs: number;          // durée totale d'un clignement (fermeture + ouverture)
  blinkIntervalMinMs: number;
  blinkIntervalMaxMs: number;
  doubleBlinkProbability: number;   // 0..1
}

export const DEFAULT_PROJECT_EYES: ProjectEyes = {
  regions: [],
  blinkEnabled: true,
  blinkDurationMs: 180,
  blinkIntervalMinMs: 2500,
  blinkIntervalMaxMs: 7000,
  doubleBlinkProbability: 0.15,
};

/**
 * Bouche animée (lip-sync). Définie au niveau projet, ancrée barycentriquement
 * au maillage body (projectTriangulation). Le contour Bézier fermé représente la
 * mâchoire basse mobile ; elle pivote en bloc autour de `hingeAnchor` quand un
 * SpeakSound `isVoice` joue. L'amplitude RMS pilote `openness ∈ [0,1]` puis
 * l'angle = `openness × maxOpenAngleDeg × rotationSign`. Le haut de la bouche
 * est considéré comme solidaire du reste de la tête (pas de définition séparée).
 */
export interface MouthDefinition {
  /** Contour fermé de la mâchoire basse (nœuds Bézier en coordonnées image). */
  bezierNodes: BezierNode[];
  /** 1 ref par nœud Bézier — ancrage barycentrique au body mesh. */
  contourAnchors: BarycentricRef[];
  /** Alias body — conservé pour cohérence avec EyeRegion. */
  contourBodyAnchors?: BarycentricRef[];
  /** Charnière (pivot de rotation de la mâchoire). */
  hingeAnchor: BarycentricRef;
  /** Alias body — idem. */
  hingeBodyAnchor?: BarycentricRef;
  /** Angle max d'ouverture en degrés. */
  maxOpenAngleDeg: number;
  /** Sens de rotation : 1 ou -1 selon l'orientation visuelle souhaitée. */
  rotationSign: 1 | -1;
  /** Zone du squelette à laquelle la bouche est rattachée. 'body' par défaut.
   *  Si !== 'body', la bouche suit le maillage de la zone correspondante
   *  (`projectTriangulation.zonePoints[id]` / `zoneTriangles[id]`). */
  attachZoneId?: string;
}

export const DEFAULT_MOUTH_MAX_OPEN_DEG = 18;

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  originalImageBlob: Blob | null;
  backgroundVideoBlob: Blob | null;
  ambientSoundBlob: Blob | null;
  ambientSoundEnabled: boolean;
  animations: Animation[];
  bodyZones: BodyZone[];
  markers: MarkerCorners | null;
  /** FILM du coloriage (niveau projet, prioritaire sur la scène). null = pas de film. */
  film: Film | null;
  /** Flag léger « a un film jouable » renseigné par les chargements de LISTE
   *  (getProjectsByBook) sans désérialiser le film. Les chargements complets
   *  remplissent `film` directement. */
  hasFilm?: boolean;
  /** Transient (jamais sérialisé) : le film vient d'une conversion legacy
   *  (scene.film) — la prochaine sauvegarde du film doit uploader TOUS ses
   *  décors/sons vers les chemins film/… . */
  filmNeedsFullUpload?: boolean;
  /** Scène interactive (DÉPRÉCIÉ — remplacée par le film). */
  scene: Scene | null;
  projectTriangulation: ProjectTriangulation | null;
  projectEyes: ProjectEyes | null;
  projectMouth: MouthDefinition | null;
  /** Si true, le projet est accessible côté play (play.<domaine>/p/{id}). Par défaut false. */
  published: boolean;
  /** Timestamp de la première publication (ou re-publication). null tant que jamais publié. */
  publishedAt: number | null;
  /** Livre auquel ce projet est rattaché (null = non rangé). */
  bookId: string | null;
  /** Position dans le livre (asc). Initialisé à Date.now() lors du rattachement. */
  bookOrder: number;
  /** Vignette affichée dans le menu du livre côté play. */
  thumbnailBlob: Blob | null;
  /** Flag de présence d'une vignette dédiée côté Storage (`projects/{id}/thumbnail`).
   *  Renseigné par les chargements légers (getProjectsByBook) pour éviter une requête
   *  /thumbnail inutile quand il n'y en a pas. Optionnel : non garanti sur tous les
   *  chemins de chargement. */
  hasThumbnail?: boolean;
}

export interface Book {
  id: string;
  name: string;
  createdAt: number;
  /** Image de couverture optionnelle (affichage admin). */
  coverImageBlob: Blob | null;
  /** Si true, le menu livre est accessible publiquement (play.<domaine>/livre/{id}). */
  published: boolean;
  publishedAt: number | null;
  /** Lien Amazon du livre (défaut "amazon.com"). */
  amazonUrl: string;
  /** Lien vers le contenu bonus à télécharger (défaut "amazon.com"). */
  bonusUrl: string;
  /** Vignette bonus optionnelle (image affichée dans le sticky footer play). */
  bonusImageBlob: Blob | null;
}

/** View of a project for step components — includes current animation's video + mesh */
export interface ProjectStepView {
  id: string;
  name: string;
  createdAt: number;
  originalImageBlob: Blob | null;
  backgroundVideoBlob: Blob | null;
  ambientSoundBlob: Blob | null;
  ambientSoundEnabled: boolean;
  markers: MarkerCorners | null;
  videoBlob: Blob | null;
  mesh: MeshData | null;
  audioBlob: Blob | null;
  audioEnabled: boolean;
}

export interface TextureTriangle {
  triangleIndex: number;
  imageData: ImageData;
}

export interface Scan {
  id: string;
  projectId: string;
  scannedAt: number;
  scanImageBlob: Blob;
  textureMap: TextureTriangle[] | null;
}
