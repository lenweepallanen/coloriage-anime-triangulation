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

  // Walk animation data (optional — only used by walk animations)
  walkLimbSeparation?: WalkLimbSeparation | null;
  walkLimbSeparationValidated?: boolean;
  walkSkeleton?: WalkSkeletonDefinition | null;
  walkSkeletonValidated?: boolean;
  walkBodyTriangles?: number[];      // indices de triangles formant le torse
  walkBodyValidated?: boolean;
  walkParams?: WalkParams | null;
  walkParamsValidated?: boolean;

  // Sortie finale (consumed by AnimationPlayer)
  crossfadeFrames?: number;  // Nombre de frames de crossfade pour la boucle seamless (défaut 7)
  videoFramesMesh: Point2D[][] | null;  // allPoints par frame
  // Walk limb separation frames (alternative à videoFramesMesh pour walk avec séparation)
  walkZoneFrames?: Record<string, Point2D[][]> | null;  // zoneId → frames par zone
  walkBodyFrames?: Point2D[][] | null;                   // frames du corps
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
}

export type AnimationType = 'rest' | 'oneshot' | 'physics' | 'bone' | 'walk';

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

export interface SceneSegment {
  duration: number;
  animationId?: string;
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
