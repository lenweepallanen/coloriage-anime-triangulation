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
 * Extract the colored texture from a rectified scan image.
 * Returns a canvas containing just the scan image, ready to be used as a PIXI texture.
 * The mesh UV coordinates map directly to this canvas.
 */
export function extractTextureCanvas(
  rectifiedCanvas: HTMLCanvasElement
): HTMLCanvasElement {
  return rectifiedCanvas
}

/**
 * Detect the bounding box of drawn content (dark pixels) on the scan canvas.
 * Scans rows and columns to find the first/last that contain enough dark pixels,
 * so thin extremities (wing tips, tails) are not cut off.
 * Returns null if not enough dark pixels or bbox covers nearly the entire canvas.
 */
export function detectDrawingBBox(canvas: HTMLCanvasElement): BBox | null {
  const ctx = canvas.getContext('2d')!
  const w = canvas.width
  const h = canvas.height
  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data

  // Count dark pixels per row and per column
  const rowCounts = new Uint32Array(h)
  const colCounts = new Uint32Array(w)
  let totalDark = 0

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (lum < 128) {
        rowCounts[y]++
        colCounts[x]++
        totalDark++
      }
    }
  }

  // Guard: skip if < 0.1% dark pixels (blank page)
  if (totalDark < w * h * 0.001) return null

  // Minimum dark pixels in a row/column to consider it part of the drawing
  // Use 0.1% of the dimension width to filter isolated noise pixels
  const minRowPixels = Math.max(3, Math.floor(w * 0.001))
  const minColPixels = Math.max(3, Math.floor(h * 0.001))

  let minY = 0, maxY = h - 1, minX = 0, maxX = w - 1

  // Find first/last row with enough dark pixels
  for (let y = 0; y < h; y++) {
    if (rowCounts[y] >= minRowPixels) { minY = y; break }
  }
  for (let y = h - 1; y >= 0; y--) {
    if (rowCounts[y] >= minRowPixels) { maxY = y; break }
  }

  // Find first/last column with enough dark pixels
  for (let x = 0; x < w; x++) {
    if (colCounts[x] >= minColPixels) { minX = x; break }
  }
  for (let x = w - 1; x >= 0; x--) {
    if (colCounts[x] >= minColPixels) { maxX = x; break }
  }

  const bbox: BBox = { minX, minY, maxX, maxY }

  // Guard: skip if bbox covers > 95% of canvas (noise everywhere)
  const bboxW = maxX - minX
  const bboxH = maxY - minY
  if (bboxW > w * 0.95 && bboxH > h * 0.95) return null

  return bbox
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
