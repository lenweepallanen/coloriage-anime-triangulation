import type { Point2D } from '../../types/project'
import type { Transform } from './useCanvasInteraction'

const CONTOUR_COLOR = '#3b82f6'
const INTERNAL_COLOR = '#ef4444'
const TRIANGLE_FILL = 'rgba(34, 197, 94, 0.15)'
const TRIANGLE_STROKE = 'rgba(34, 197, 94, 0.5)'
const CONTOUR_LINE_COLOR = 'rgba(59, 130, 246, 0.6)'
const POINT_RADIUS = 6
const HOVER_RADIUS = 10

export function drawScene(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  transform: Transform,
  contourPoints: Point2D[],
  internalPoints: Point2D[],
  triangles: [number, number, number][],
  contourClosed: boolean,
  hoveredPoint: { type: 'contour' | 'internal'; index: number } | null
) {
  // Clear in CSS pixel space (context is already scaled by DPR via setTransform)
  const dpr = window.devicePixelRatio || 1
  const cssWidth = ctx.canvas.width / dpr
  const cssHeight = ctx.canvas.height / dpr
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  ctx.save()
  ctx.translate(transform.offsetX, transform.offsetY)
  ctx.scale(transform.scale, transform.scale)

  // Draw image
  if (image) {
    ctx.drawImage(image, 0, 0)
  }

  const allPoints = [...contourPoints, ...internalPoints]

  // Draw triangles
  if (triangles.length > 0) {
    ctx.fillStyle = TRIANGLE_FILL
    ctx.strokeStyle = TRIANGLE_STROKE
    ctx.lineWidth = 1 / transform.scale

    for (const [a, b, c] of triangles) {
      ctx.beginPath()
      ctx.moveTo(allPoints[a].x, allPoints[a].y)
      ctx.lineTo(allPoints[b].x, allPoints[b].y)
      ctx.lineTo(allPoints[c].x, allPoints[c].y)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
  }

  // Draw contour lines
  if (contourPoints.length >= 2) {
    ctx.strokeStyle = CONTOUR_LINE_COLOR
    ctx.lineWidth = 2 / transform.scale
    ctx.beginPath()
    ctx.moveTo(contourPoints[0].x, contourPoints[0].y)
    for (let i = 1; i < contourPoints.length; i++) {
      ctx.lineTo(contourPoints[i].x, contourPoints[i].y)
    }
    if (contourClosed) ctx.closePath()
    ctx.stroke()
  }

  // Draw contour points
  const pr = POINT_RADIUS / transform.scale
  const hr = HOVER_RADIUS / transform.scale

  for (let i = 0; i < contourPoints.length; i++) {
    const p = contourPoints[i]
    const isHovered = hoveredPoint?.type === 'contour' && hoveredPoint.index === i

    ctx.fillStyle = CONTOUR_COLOR
    ctx.beginPath()
    ctx.arc(p.x, p.y, isHovered ? hr : pr, 0, Math.PI * 2)
    ctx.fill()

    if (isHovered) {
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2 / transform.scale
      ctx.stroke()
    }
  }

  // Draw internal points
  for (let i = 0; i < internalPoints.length; i++) {
    const p = internalPoints[i]
    const isHovered = hoveredPoint?.type === 'internal' && hoveredPoint.index === i

    ctx.fillStyle = INTERNAL_COLOR
    ctx.beginPath()
    ctx.arc(p.x, p.y, isHovered ? hr : pr, 0, Math.PI * 2)
    ctx.fill()

    if (isHovered) {
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2 / transform.scale
      ctx.stroke()
    }
  }

  ctx.restore()
}

export function findPointAt(
  imagePos: Point2D,
  contourPoints: Point2D[],
  internalPoints: Point2D[],
  hitRadius: number,
  filterType?: 'contour' | 'internal'
): { type: 'contour' | 'internal'; index: number } | null {
  const hitRadiusSq = hitRadius * hitRadius

  // Check internal points first (they're drawn on top)
  if (filterType !== 'contour') {
    for (let i = internalPoints.length - 1; i >= 0; i--) {
      const dx = imagePos.x - internalPoints[i].x
      const dy = imagePos.y - internalPoints[i].y
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return { type: 'internal', index: i }
      }
    }
  }

  // Then contour points
  if (filterType !== 'internal') {
    for (let i = contourPoints.length - 1; i >= 0; i--) {
      const dx = imagePos.x - contourPoints[i].x
      const dy = imagePos.y - contourPoints[i].y
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return { type: 'contour', index: i }
      }
    }
  }

  return null
}

/** Find the nearest contour edge segment and return the index of the first point of that segment */
export function findNearestContourEdge(
  imagePos: Point2D,
  contourPoints: Point2D[],
  maxDist: number
): { afterIndex: number; projection: Point2D } | null {
  if (contourPoints.length < 2) return null

  let bestDist = maxDist * maxDist
  let bestIdx = -1
  let bestProj: Point2D = { x: 0, y: 0 }

  const n = contourPoints.length
  for (let i = 0; i < n; i++) {
    const a = contourPoints[i]
    const b = contourPoints[(i + 1) % n]

    const abx = b.x - a.x
    const aby = b.y - a.y
    const lenSq = abx * abx + aby * aby
    if (lenSq === 0) continue

    let t = ((imagePos.x - a.x) * abx + (imagePos.y - a.y) * aby) / lenSq
    t = Math.max(0, Math.min(1, t))

    const px = a.x + t * abx
    const py = a.y + t * aby
    const dx = imagePos.x - px
    const dy = imagePos.y - py
    const distSq = dx * dx + dy * dy

    if (distSq < bestDist) {
      bestDist = distSq
      bestIdx = i
      bestProj = { x: px, y: py }
    }
  }

  if (bestIdx === -1) return null
  return { afterIndex: bestIdx, projection: bestProj }
}
