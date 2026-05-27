import type { Point2D } from '../types/project'
import { pointInPolygon, distanceSq } from './geometry'
import { detectContourViaWorker } from './perspectiveCorrection'

export interface AutoMeshResult {
  contourPoints: Point2D[]
  internalPoints: Point2D[]
}

const PROCESS_SIZE = 400

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')) }
    img.src = url
  })
}

/**
 * Detect the contour of the drawing via the OpenCV Web Worker.
 */
async function detectContourOpenCV(
  img: HTMLImageElement,
  density: number
): Promise<Point2D[]> {
  const origW = img.naturalWidth
  const origH = img.naturalHeight
  const scale = PROCESS_SIZE / Math.max(origW, origH)
  const w = Math.round(origW * scale)
  const h = Math.round(origH * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)

  const points = await detectContourViaWorker(imageData, density)

  if (!points || points.length < 3) {
    return fallbackRect(origW, origH)
  }

  // Scale back to original coordinates
  return points.map(p => ({ x: p.x / scale, y: p.y / scale }))
}

function fallbackRect(w: number, h: number): Point2D[] {
  const m = 5
  return [
    { x: m, y: m },
    { x: w - m, y: m },
    { x: w - m, y: h - m },
    { x: m, y: h - m },
  ]
}

export async function generateAutoMesh(
  imageBlob: Blob,
  density: number
): Promise<AutoMeshResult> {
  const img = await loadImage(imageBlob)
  const origW = img.naturalWidth
  const origH = img.naturalHeight

  const contourPoints = await detectContourOpenCV(img, density)
  const internalPoints = generateInternalPoints(contourPoints, origW, origH, density)

  return { contourPoints, internalPoints }
}

/**
 * Generate a Poisson-style grid of internal points within a closed polygon.
 * Spacing is derived from `density` (1-10, lower = sparser).
 * Points within ~40% of spacing from the polygon boundary are skipped.
 */
export function generateInternalPointsInPolygon(
  polygon: Point2D[],
  width: number,
  height: number,
  density: number,
): Point2D[] {
  return generateInternalPoints(polygon, width, height, density)
}

function generateInternalPoints(
  contourPoints: Point2D[],
  width: number,
  height: number,
  density: number
): Point2D[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of contourPoints) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  // Compute centroid for adaptive spacing
  let cx = 0, cy = 0
  for (const p of contourPoints) { cx += p.x; cy += p.y }
  cx /= contourPoints.length
  cy /= contourPoints.length

  // Max distance from centroid to any contour point
  let maxDistFromCentroid = 0
  for (const p of contourPoints) {
    const d = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2)
    if (d > maxDistFromCentroid) maxDistFromCentroid = d
  }
  if (maxDistFromCentroid < 1) maxDistFromCentroid = 1

  const baseSpacing = Math.max(width, height) / (density * 3 + 5)
  // Use a finer grid to generate candidates, then filter with adaptive Poisson-disk
  const fineSpacing = baseSpacing * 0.5
  const points: Point2D[] = []

  for (let y = minY + fineSpacing / 2; y < maxY; y += fineSpacing) {
    for (let x = minX + fineSpacing / 2; x < maxX; x += fineSpacing) {
      const p = { x, y }
      if (!pointInPolygon(p, contourPoints)) continue

      // Adaptive spacing: denser near periphery (far from centroid), sparser at center
      const distToCentroid = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      const flexibility = distToCentroid / maxDistFromCentroid // 0=center, 1=edge
      // Near edge: spacing = 50% of base. At center: spacing = 100% of base.
      const localSpacing = baseSpacing * (0.5 + 0.5 * (1 - flexibility))
      const localMinDistSq = (localSpacing * 0.4) ** 2

      // Check distance to contour points
      let tooClose = false
      for (const cp of contourPoints) {
        if (distanceSq(p, cp) < localMinDistSq) {
          tooClose = true
          break
        }
      }
      if (tooClose) continue

      // Poisson-disk: check distance to already-accepted internal points
      for (const ep of points) {
        if (distanceSq(p, ep) < localMinDistSq) {
          tooClose = true
          break
        }
      }
      if (!tooClose) points.push(p)
    }
  }

  return points
}
