export interface Point2D {
  x: number;
  y: number;
}

export interface MeshData {
  contourPoints: Point2D[];
  internalPoints: Point2D[];
  triangles: [number, number, number][]; // indices into allPoints (contour + internal)
  videoFramesMesh: Point2D[][] | null;   // [frameIndex][pointIndex] = {x, y}, null until optical flow computed
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
