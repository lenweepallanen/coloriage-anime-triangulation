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

export interface ContourPathEntry {
  type: 'anchor' | 'contour';
  index: number; // into anchorPoints[] or contourPoints[]
}

export interface MeshData {
  // 3 distinct point categories
  anchorPoints: Point2D[];       // tracked points only (promoted contour + interior features)
  contourPoints: Point2D[];      // non-promoted contour points (NOT tracked, derived via barycentric)
  internalPoints: Point2D[];     // fill points (NOT tracked, derived via barycentric)

  // Ordered contour path (interleaves promoted anchors + contour points)
  contourPath: ContourPathEntry[];  // polygon reconstructed by resolving each entry

  // Topology (locked after triangulation step)
  triangles: [number, number, number][]; // indices into allPoints = [...anchors, ...contour, ...internals]
  topologyLocked: boolean;

  // Anchor-only triangulation (for barycentric interpolation)
  anchorTriangles: [number, number, number][]; // Delaunay on anchors only
  contourBarycentrics: BarycentricRef[];       // one per contour point
  internalBarycentrics: BarycentricRef[];      // one per internal point

  // Keyframe animation (anchors only)
  keyframeInterval: number;
  keyframes: KeyframeData[];
  anchorFrames: Point2D[][] | null;

  // Final output (consumed by AnimationPlayer)
  videoFramesMesh: Point2D[][] | null; // [...anchors, ...contour, ...internals] per frame
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
