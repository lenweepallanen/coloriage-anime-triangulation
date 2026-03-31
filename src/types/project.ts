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

  // Sortie finale (consumed by AnimationPlayer)
  crossfadeFrames?: number;  // Nombre de frames de crossfade pour la boucle seamless (défaut 7)
  videoFramesMesh: Point2D[][] | null;  // allPoints par frame
}

export interface MarkerCorners {
  topLeft: Point2D;
  topRight: Point2D;
  bottomLeft: Point2D;
  bottomRight: Point2D;
}

export type AnimationType = 'rest' | 'oneshot' | 'physics';

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

export interface SceneRestPoint {
  id: string;
  backgroundX: number;
  restAnimationId?: string;
  availableAnimationIds?: string[];
}

export interface SceneSegment {
  duration: number;
  animationId?: string;
}

export interface SceneTransition {
  waypoints: number[];
  segments: SceneSegment[];
}

export interface Scene {
  id: string;
  name: string;
  backgroundImageBlob: Blob | null;
  backgroundWidth: number;
  backgroundHeight: number;
  characterScale: number;
  characterY: number;
  restPoints: SceneRestPoint[];
  transitions: SceneTransition[];
  startMode: 'rest' | 'transition';
  startX?: number;
  startTransition?: SceneTransition;
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
