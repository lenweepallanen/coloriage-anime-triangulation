import type { Point2D } from '../types/project'

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface ContentAlignment {
  drawBBox: BBox
  meshBBox: BBox
}

/**
 * Compute the bounding box of all mesh points.
 */
export function computeMeshBBox(points: Point2D[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Compute UV coordinates for each mesh point.
 *
 * When alignment is provided, maps mesh bbox to drawing bbox on the scan:
 *   u = (x - meshMinX) / meshW * drawW / canvasW + drawMinX / canvasW
 *   v = (y - meshMinY) / meshH * drawH / canvasH + drawMinY / canvasH
 *
 * When absent: simple u = x / canvasW, v = y / canvasH.
 */
export function computeUVs(
  points: Point2D[],
  imageWidth: number,
  imageHeight: number,
  alignment?: ContentAlignment
): Float32Array {
  const uvs = new Float32Array(points.length * 2)

  if (alignment) {
    const { drawBBox, meshBBox } = alignment
    const meshW = meshBBox.maxX - meshBBox.minX
    const meshH = meshBBox.maxY - meshBBox.minY
    const drawW = drawBBox.maxX - drawBBox.minX
    const drawH = drawBBox.maxY - drawBBox.minY

    for (let i = 0; i < points.length; i++) {
      const normX = meshW > 0 ? (points[i].x - meshBBox.minX) / meshW : 0.5
      const normY = meshH > 0 ? (points[i].y - meshBBox.minY) / meshH : 0.5
      uvs[i * 2] = normX * drawW / imageWidth + drawBBox.minX / imageWidth
      uvs[i * 2 + 1] = normY * drawH / imageHeight + drawBBox.minY / imageHeight
    }
  } else {
    for (let i = 0; i < points.length; i++) {
      uvs[i * 2] = points[i].x / imageWidth
      uvs[i * 2 + 1] = points[i].y / imageHeight
    }
  }

  return uvs
}
