import type { Point2D } from '../../types/project'
import type { Transform } from './useCanvasInteraction'

const CONTOUR_COLOR = '#3b82f6'
const INTERNAL_COLOR = '#ef4444'
const ANCHOR_COLOR = '#f59e0b'       // gold/amber for feature anchors
const TRIANGLE_FILL = 'rgba(34, 197, 94, 0.15)'
const TRIANGLE_STROKE = 'rgba(34, 197, 94, 0.5)'
const CONTOUR_LINE_COLOR = 'rgba(59, 130, 246, 0.6)'
const POINT_RADIUS = 6
const HOVER_RADIUS = 10

export type PointType = 'contour' | 'internal' | 'anchor'

export function drawScene(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement | null,
  transform: Transform,
  contourPoints: Point2D[],
  internalPoints: Point2D[],
  triangles: [number, number, number][],
  contourClosed: boolean,
  hoveredPoint: { type: PointType; index: number } | null,
  anchorPoints?: Point2D[],
  readOnlyAnchors?: boolean,
  showAnchorNumbers?: boolean,
  contourIndexOffset?: number,
  promotedContourIndices?: Set<number>,
  nonPromotedContourPoints?: Point2D[]
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

  // Determine all points for triangle rendering
  // Must match useTriangulation: [...anchors, ...nonPromotedContour, ...internals]
  // or [...contour, ...internals] if no anchors
  const basePoints = anchorPoints ?? contourPoints
  const allPoints = [...basePoints, ...(nonPromotedContourPoints ?? []), ...internalPoints]

  // Draw triangles
  if (triangles.length > 0) {
    ctx.fillStyle = TRIANGLE_FILL
    ctx.strokeStyle = TRIANGLE_STROKE
    ctx.lineWidth = 1 / transform.scale

    for (const [a, b, c] of triangles) {
      if (a >= allPoints.length || b >= allPoints.length || c >= allPoints.length) continue
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

  const pr = POINT_RADIUS / transform.scale
  const hr = HOVER_RADIUS / transform.scale

  // Draw contour points
  const labelSize = Math.max(8, 11 / transform.scale)
  for (let i = 0; i < contourPoints.length; i++) {
    const p = contourPoints[i]
    const isHovered = hoveredPoint?.type === 'contour' && hoveredPoint.index === i
    const isPromoted = promotedContourIndices?.has(i) ?? false

    ctx.fillStyle = isPromoted ? ANCHOR_COLOR : CONTOUR_COLOR
    ctx.beginPath()
    ctx.arc(p.x, p.y, isHovered ? hr : pr, 0, Math.PI * 2)
    ctx.fill()

    if (isPromoted) {
      ctx.strokeStyle = '#d97706'
      ctx.lineWidth = 1.5 / transform.scale
      ctx.stroke()
    }

    if (isHovered) {
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 2 / transform.scale
      ctx.stroke()
    }

    // Number label
    if (showAnchorNumbers) {
      const anchorIdx = (contourIndexOffset ?? 0) + i
      drawPointLabel(ctx, p, anchorIdx, pr, labelSize, transform.scale)
    }
  }

  // Draw anchor points (feature anchors — non-contour anchors)
  if (anchorPoints) {
    for (let i = 0; i < anchorPoints.length; i++) {
      const p = anchorPoints[i]
      const isHovered = hoveredPoint?.type === 'anchor' && hoveredPoint.index === i
      const isContourAnchor = contourPoints.some(cp => cp.x === p.x && cp.y === p.y)

      // Skip contour anchors — they're already drawn as contour points
      if (isContourAnchor) continue

      ctx.fillStyle = readOnlyAnchors ? 'rgba(245, 158, 11, 0.5)' : ANCHOR_COLOR
      ctx.beginPath()
      ctx.arc(p.x, p.y, isHovered ? hr : pr, 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = readOnlyAnchors ? 'rgba(245, 158, 11, 0.3)' : '#d97706'
      ctx.lineWidth = 1.5 / transform.scale
      ctx.stroke()

      if (isHovered) {
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 2 / transform.scale
        ctx.stroke()
      }

      // Number label
      if (showAnchorNumbers) {
        const anchorIdx = contourPoints.length + i
        drawPointLabel(ctx, p, anchorIdx, pr, labelSize, transform.scale)
      }
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
  filterType?: PointType,
  anchorPoints?: Point2D[]
): { type: PointType; index: number } | null {
  const hitRadiusSq = hitRadius * hitRadius

  // Check internal points first (they're drawn on top)
  if (filterType !== 'contour' && filterType !== 'anchor') {
    for (let i = internalPoints.length - 1; i >= 0; i--) {
      const dx = imagePos.x - internalPoints[i].x
      const dy = imagePos.y - internalPoints[i].y
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return { type: 'internal', index: i }
      }
    }
  }

  // Check anchor points (feature anchors that aren't contour points)
  if (anchorPoints && filterType !== 'contour' && filterType !== 'internal') {
    for (let i = anchorPoints.length - 1; i >= 0; i--) {
      const dx = imagePos.x - anchorPoints[i].x
      const dy = imagePos.y - anchorPoints[i].y
      if (dx * dx + dy * dy <= hitRadiusSq) {
        return { type: 'anchor', index: i }
      }
    }
  }

  // Then contour points
  if (filterType !== 'internal' && filterType !== 'anchor') {
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

function drawPointLabel(
  ctx: CanvasRenderingContext2D,
  p: Point2D,
  index: number,
  pointRadius: number,
  fontSize: number,
  scale: number
) {
  const label = String(index)
  ctx.font = `bold ${fontSize}px sans-serif`
  const tw = ctx.measureText(label).width
  const pad = 2 / scale
  const bx = p.x + pointRadius + 2 / scale
  const by = p.y - pointRadius

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
  ctx.fillRect(bx - pad, by - fontSize + pad, tw + pad * 2, fontSize + pad)
  ctx.fillStyle = '#fff'
  ctx.fillText(label, bx, by)
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
