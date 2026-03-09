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

  const spacing = Math.max(width, height) / (density * 3 + 5)
  const minDistSq = (spacing * 0.4) ** 2
  const points: Point2D[] = []

  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      const p = { x, y }
      if (!pointInPolygon(p, contourPoints)) continue

      let tooClose = false
      for (const cp of contourPoints) {
        if (distanceSq(p, cp) < minDistSq) {
          tooClose = true
          break
        }
      }
      if (!tooClose) points.push(p)
    }
  }

  return points
}
