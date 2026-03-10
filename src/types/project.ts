export interface Point2D {
  x: number;
  y: number;
}

export interface BarycentricRef {
  anchorTriangleIndex: number; // index into anchorTriangles[]
  u: number; // weight for vertex A
  v: number; // weight for vertex B
  w: number; // weight for vertex C
}

export interface KeyframeData {
  frameIndex: number;
  anchorPositions: Point2D[]; // anchor positions at this keyframe
}

export interface MeshData {
  // Points (anchors = contour + interior feature points)
  anchorPoints: Point2D[];
  contourIndices: number[];    // indices into anchorPoints forming the contour polygon
  internalPoints: Point2D[];   // fill points (not tracked, derived from anchors)

  // Topology (locked after triangulation step)
  triangles: [number, number, number][]; // indices into allPoints = [...anchors, ...internals]
  topologyLocked: boolean;

  // Anchor-only triangulation (for barycentric interpolation of internal points)
  anchorTriangles: [number, number, number][]; // Delaunay on anchors only
  internalBarycentrics: BarycentricRef[];      // one per internal point

  // Keyframe animation
  keyframeInterval: number;          // e.g. every 10 frames
  keyframes: KeyframeData[];         // anchor positions at keyframes
  anchorFrames: Point2D[][] | null;  // interpolated anchor positions for ALL frames

  // Final output (consumed by AnimationPlayer unchanged)
  videoFramesMesh: Point2D[][] | null; // [...anchors, ...internals] per frame
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
