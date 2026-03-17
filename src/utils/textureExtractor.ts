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
 *
 * When insets are provided, compensates for the fact that the scan texture
 * is slightly zoomed in (L-marker centroids are inside the image edges).
 * The scan shows content from (insetX, insetY) to (imageWidth - insetX, imageHeight - insetY).
 */
export function computeUVs(
  points: Point2D[],
  imageWidth: number,
  imageHeight: number,
  insets?: { insetX: number; insetY: number }
): Float32Array {
  const uvs = new Float32Array(points.length * 2)
  const ix = insets?.insetX ?? 0
  const iy = insets?.insetY ?? 0
  const effectiveW = imageWidth - 2 * ix
  const effectiveH = imageHeight - 2 * iy
  for (let i = 0; i < points.length; i++) {
    uvs[i * 2] = (points[i].x - ix) / effectiveW
    uvs[i * 2 + 1] = (points[i].y - iy) / effectiveH
  }
  return uvs
}
