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
  zoneId: string;           // 'body' | 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
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
  zoneId: string;           // 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
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
  legs: Sam2LegBone[];         // 0-4 legs
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
  zoneId: string         // 'body' | 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
  label: SAM2PromptLabel
}

/** A SAM 2 zone definition (body or one of the 4 legs) */
export interface SAM2Zone {
  id: string             // 'body' | 'leg-fl' | 'leg-fr' | 'leg-bl' | 'leg-br'
  label: string          // "Body", "Patte AVG", etc.
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

  // Étape 2 : Maillage par zone — placement curviligne (V3) + Delaunay interne
  // Phase 1 : P0 par zone (coords image, snap courbure)
  zoneOrigins?: Record<string, Point2D>                       // zoneId → P0
  zoneOriginsValidated?: Record<string, boolean>              // zoneId → P0 validé
  // Phase 2 : Anchors contour par zone (P0 inclus comme [0], tri arc-length depuis P0)
  zoneAnchors?: Record<string, Point2D[]>                     // zoneId → anchors caractéristiques
  zoneAnchorsValidated?: Record<string, boolean>              // zoneId → anchors validés
  // Phase 3 : Subdivision par zone (params curvilignes + points générés)
  zoneSubdivisionPoints?: Record<string, Point2D[]>           // zoneId → points subdivision
  zoneSubdivisionParams?: Record<string, CurvilinearParam[]>  // zoneId → params curvilignes
  zoneSubdivisionValidated?: Record<string, boolean>          // zoneId → subdivision validée
  // Phase 4 : Delaunay interne + layout
  zoneContourLength?: Record<string, number>                  // zoneId → nb points contour (contour = N premiers indices de zonePoints)
  // Legacy (conservés pour migration) : utilisés quand zoneAnchors absent
  zoneContourCount: Record<string, number>                   // zoneId → nb points contour (slider legacy)
  zoneContourPoints: Record<string, Point2D[]>               // zoneId → vertices contour legacy
  zoneContourValidated: Record<string, boolean>              // zoneId → contour verrouillé (legacy)
  zonePoints: Record<string, Point2D[]>                      // zoneId → vertices (contour + internes)
  zoneTriangles: Record<string, [number, number, number][]>  // zoneId → triangles Delaunay
  zoneDensity: Record<string, number>                        // zoneId → slider densité intérieure
  bodyPoints: Point2D[]
  bodyTriangles: [number, number, number][]
  step2Validated: boolean

  // Étape 3 : Faces cachées (même structure que Walk)
  hiddenFaceZones: HiddenFaceZone[]          // corps caché derrière patte
  hiddenFaceLimbZones: HiddenFaceLimbZone[]  // extension patte sous corps
  step3Validated: boolean
}

export type AnimationType = 'rest' | 'oneshot' | 'physics' | 'bone' | 'walk' | 'members-bones' | 'members-bones-v2' | 'members-bones-v3';

export interface Animation {
  id: string;
  name: string;
  type: AnimationType;
  createdAt: number;
  videoBlob: Blob | null;
  mesh: MeshData | null;
  physicsCode: string | null;
  physicsDuration: number | null;
  physicsOverlay: boolean;
  audioBlob: Blob | null;
  audioEnabled: boolean;
}

/** Check if an animation has computed frames (single mesh or separated zones). */
export function animationHasFrames(anim: Animation): boolean {
  const m = anim.mesh
  if (!m) return false
  return (m.videoFramesMesh != null && m.videoFramesMesh.length > 0)
    || (m.walkZoneFrames != null && m.walkBodyFrames != null)
}

export interface SceneRestPoint {
  id: string;
  backgroundX: number;
  restAnimationId?: string;
  randomAnimationIds?: string[];
  zoneAnimationMappings?: ZoneAnimationMapping[];
  speakSoundIds?: string[];
  helpTexts?: string[];
}

export interface SpeakSound {
  id: string;
  name: string;
}

export type SegmentEasing = 'smoothstep' | 'linear';

export interface SceneSegment {
  duration: number;
  animationId?: string;
  easing?: SegmentEasing;
}

export interface SceneTransition {
  waypoints: number[];
  segments: SceneSegment[];
}

export interface SceneBackgroundLayer {
  imageBlob: Blob | null;
  width: number;
  height: number;
  depthFactor: number;
}

export interface Scene {
  id: string;
  name: string;
  backgroundLayers: SceneBackgroundLayer[];
  characterScale: number;
  characterY: number;
  restPoints: SceneRestPoint[];
  transitions: SceneTransition[];
  startMode: 'rest' | 'transition';
  startX?: number;
  startTransition?: SceneTransition;
  speakSounds: SpeakSound[];
  speakSoundBlobs: (Blob | null)[];
}

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
  scene: Scene | null;
  projectTriangulation: ProjectTriangulation | null;
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
