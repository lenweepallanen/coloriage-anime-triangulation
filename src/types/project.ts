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

export interface MeshData {
  // Étape 2 : Sommets du contour (frame 0, TOUS trackés par optical flow)
  contourVertices: Point2D[];

  // Étape 3 : Paramètres Canny validés
  cannyParams: CannyParams | null;

  // Étape 4 : Tracking contour
  contourKeyframeInterval: number;
  contourKeyframes: KeyframeData[];
  contourFrames: Point2D[][] | null;    // positions contour interpolées par frame
  contourTrackingValidated: boolean;

  // Étape 5 : Anchors internes (frame 0, features intérieures uniquement)
  anchorPoints: Point2D[];

  // Étape 6 : Tracking anchors
  anchorKeyframeInterval: number;
  anchorKeyframes: KeyframeData[];
  anchorFrames: Point2D[][] | null;
  anchorTrackingValidated: boolean;

  // Étape 7 : Triangulation
  internalPoints: Point2D[];
  triangles: [number, number, number][];  // indices dans [...contourVertices, ...anchorPoints, ...internalPoints]
  topologyLocked: boolean;
  trackedTriangles: [number, number, number][];  // Delaunay sur [...contourVertices, ...anchorPoints]
  internalBarycentrics: BarycentricRef[];

  // Étape 8 : Sortie finale (consumed by AnimationPlayer)
  videoFramesMesh: Point2D[][] | null;  // [...contourVertices, ...anchorPoints, ...internalPoints] per frame
}

export interface MarkerCorners {
  topLeft: Point2D;
  topRight: Point2D;
  bottomLeft: Point2D;
  bottomRight: Point2D;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  originalImageBlob: Blob | null;
  videoBlob: Blob | null;
  mesh: MeshData | null;
  markers: MarkerCorners | null;
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
