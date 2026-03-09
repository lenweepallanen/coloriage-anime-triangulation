import type { Point2D } from '../types/project'

/**
 * Extract the colored texture from a rectified scan image.
 * Returns a canvas containing just the scan image, ready to be used as a PIXI texture.
 * The mesh UV coordinates map directly to this canvas.
 */
export function extractTextureCanvas(
  rectifiedCanvas: HTMLCanvasElement
): HTMLCanvasElement {
  // The rectified canvas is already aligned to the original image coordinates.
  // We just return it as-is — it serves as the texture source.
  return rectifiedCanvas
}

/**
 * Compute UV coordinates for each mesh point based on the original image dimensions.
 * UVs are normalized [0,1] coordinates that map to the texture.
 */
export function computeUVs(
  points: Point2D[],
  imageWidth: number,
  imageHeight: number
): Float32Array {
  const uvs = new Float32Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    uvs[i * 2] = points[i].x / imageWidth
    uvs[i * 2 + 1] = points[i].y / imageHeight
  }
  return uvs
}
