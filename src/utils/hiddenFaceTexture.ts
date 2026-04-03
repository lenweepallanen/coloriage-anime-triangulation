/**
 * Hidden Face Texture — Laplacian diffusion inpainting for hidden face zones.
 *
 * Paints diffused colors directly onto the scan canvas for the hidden face triangles.
 * These triangles are a subset of bodyTriangles (same bodyPoints).
 *
 * Algorithm:
 * 1. Convert body vertices to scan canvas coords (via contentAlignment)
 * 2. Rasterize the hidden face triangles into a mask on the scan canvas
 * 3. Identify border pixels (interior pixels adjacent to exterior with existing color)
 * 4. Iterative Jacobi diffusion: each interior pixel = average of 4 neighbors
 * 5. Write diffused pixels back onto the scan canvas
 */

import type { Point2D, HiddenFaceZone } from '../types/project'
import type { ContentAlignment } from './textureExtractor'

/**
 * Paint diffused colors onto the scan canvas for a hidden face zone.
 * After this, the scan canvas contains plausible colors in the zone area.
 */
export function inpaintHiddenFaceOnScan(
  scanCanvas: HTMLCanvasElement,
  zone: HiddenFaceZone,
  bodyPoints: Point2D[],
  bodyTriangles: [number, number, number][],
  imageWidth: number,
  imageHeight: number,
  contentAlignment?: ContentAlignment,
): void {
  if (zone.bodyTriangleIndices.length === 0) return

  const scanW = scanCanvas.width
  const scanH = scanCanvas.height

  // 1. Convert body points to scan canvas pixel coords
  const scanPoints = bodyPoints.map(p => imageToScanPixel(p, imageWidth, imageHeight, scanW, scanH, contentAlignment))

  // 2. Compute bounding box of hidden face triangles in scan space
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ti of zone.bodyTriangleIndices) {
    const tri = bodyTriangles[ti]
    if (!tri) continue
    for (const vi of tri) {
      const p = scanPoints[vi]
      if (!p) continue
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  const PAD = 6
  minX = Math.max(0, Math.floor(minX) - PAD)
  minY = Math.max(0, Math.floor(minY) - PAD)
  maxX = Math.min(scanW - 1, Math.ceil(maxX) + PAD)
  maxY = Math.min(scanH - 1, Math.ceil(maxY) + PAD)

  const w = maxX - minX + 1
  const h = maxY - minY + 1
  if (w <= 0 || h <= 0) return

  // 3. Rasterize hidden face triangles into mask
  const mask = new Uint8Array(w * h) // 0=exterior, 1=interior, 2=border
  for (const ti of zone.bodyTriangleIndices) {
    const tri = bodyTriangles[ti]
    if (!tri) continue
    const [a, b, c] = tri
    const pa = scanPoints[a], pb = scanPoints[b], pc = scanPoints[c]
    if (!pa || !pb || !pc) continue
    rasterizeTriangle(pa, pb, pc, minX, minY, w, h, mask)
  }

  // 4. Identify border pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue
      const hasExterior =
        (x === 0 || mask[y * w + x - 1] === 0) ||
        (x === w - 1 || mask[y * w + x + 1] === 0) ||
        (y === 0 || mask[(y - 1) * w + x] === 0) ||
        (y === h - 1 || mask[(y + 1) * w + x] === 0)
      if (hasExterior) mask[y * w + x] = 2
    }
  }

  // 5. Read scan pixels and initialize diffusion from border
  const ctx = scanCanvas.getContext('2d')
  if (!ctx) return
  const imgData = ctx.getImageData(minX, minY, w, h)
  const pixels = imgData.data

  const r = new Float32Array(w * h)
  const g = new Float32Array(w * h)
  const b = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 2) {
      r[i] = pixels[i * 4]
      g[i] = pixels[i * 4 + 1]
      b[i] = pixels[i * 4 + 2]
    }
  }

  // 6. Jacobi diffusion with SOR
  const ITERATIONS = 150
  const OMEGA = 1.7
  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = y * w + x
        if (mask[idx] !== 1) continue
        const avgR = (r[idx - 1] + r[idx + 1] + r[idx - w] + r[idx + w]) / 4
        const avgG = (g[idx - 1] + g[idx + 1] + g[idx - w] + g[idx + w]) / 4
        const avgB = (b[idx - 1] + b[idx + 1] + b[idx - w] + b[idx + w]) / 4
        r[idx] += OMEGA * (avgR - r[idx])
        g[idx] += OMEGA * (avgG - g[idx])
        b[idx] += OMEGA * (avgB - b[idx])
      }
    }
  }

  // 7. Write diffused pixels back
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (mask[idx] !== 1) continue
      const pIdx = idx * 4
      pixels[pIdx] = Math.round(Math.max(0, Math.min(255, r[idx])))
      pixels[pIdx + 1] = Math.round(Math.max(0, Math.min(255, g[idx])))
      pixels[pIdx + 2] = Math.round(Math.max(0, Math.min(255, b[idx])))
      pixels[pIdx + 3] = 255
    }
  }
  ctx.putImageData(imgData, minX, minY)
}

// ─── Coordinate conversion ──────────────────────────────────────────

function imageToScanPixel(
  p: Point2D,
  imageWidth: number, imageHeight: number,
  scanW: number, scanH: number,
  contentAlignment?: ContentAlignment,
): Point2D {
  if (contentAlignment) {
    const { drawBBox, meshBBox } = contentAlignment
    const meshW = meshBBox.maxX - meshBBox.minX
    const meshH = meshBBox.maxY - meshBBox.minY
    const drawW = drawBBox.maxX - drawBBox.minX
    const drawH = drawBBox.maxY - drawBBox.minY
    const normX = meshW > 0 ? (p.x - meshBBox.minX) / meshW : 0.5
    const normY = meshH > 0 ? (p.y - meshBBox.minY) / meshH : 0.5
    return { x: normX * drawW + drawBBox.minX, y: normY * drawH + drawBBox.minY }
  }
  return { x: p.x / imageWidth * scanW, y: p.y / imageHeight * scanH }
}

// ─── Triangle rasterization ──────────────────────────────────────────

function rasterizeTriangle(
  p0: Point2D, p1: Point2D, p2: Point2D,
  originX: number, originY: number,
  w: number, h: number,
  mask: Uint8Array,
) {
  const ax = p0.x - originX, ay = p0.y - originY
  const bx = p1.x - originX, by = p1.y - originY
  const cx = p2.x - originX, cy = p2.y - originY

  const minPx = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
  const maxPx = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)))
  const minPy = Math.max(0, Math.floor(Math.min(ay, by, cy)))
  const maxPy = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)))

  for (let py = minPy; py <= maxPy; py++) {
    for (let px = minPx; px <= maxPx; px++) {
      const x = px + 0.5, y = py + 0.5
      const d0 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
      const d1 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
      const d2 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
      if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) {
        if (mask[py * w + px] === 0) mask[py * w + px] = 1
      }
    }
  }
}
