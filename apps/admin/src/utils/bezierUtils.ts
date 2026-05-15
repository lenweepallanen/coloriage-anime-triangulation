/**
 * Bezier curve utilities for limb zone definition.
 *
 * Provides cubic Bezier evaluation, flattening closed curves to polygons,
 * polygon expansion (offset outward), and segment intersection.
 */

import type { Point2D, BezierNode } from '../types/project'

// ─── Cubic Bezier evaluation ──────────────────────────────────────────

/** Evaluate a cubic Bezier segment at parameter t ∈ [0,1]. */
export function evaluateCubicBezier(
  p0: Point2D, cp1: Point2D, cp2: Point2D, p3: Point2D, t: number
): Point2D {
  const t2 = t * t
  const t3 = t2 * t
  const mt = 1 - t
  const mt2 = mt * mt
  const mt3 = mt2 * mt
  return {
    x: mt3 * p0.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * p3.y,
  }
}

// ─── Flatten closed Bezier to polygon ─────────────────────────────────

/**
 * Sample a closed Bezier curve (defined by BezierNode[]) into a polygon.
 * Each pair of consecutive nodes forms a cubic segment:
 *   P0 = node[i].anchor, CP1 = node[i].handleOut, CP2 = node[i+1].handleIn, P3 = node[i+1].anchor
 * The last node connects back to the first.
 */
export function flattenClosedBezier(
  nodes: BezierNode[],
  samplesPerSegment = 50
): Point2D[] {
  if (nodes.length < 2) return nodes.map(n => n.anchor)
  const result: Point2D[] = []
  const n = nodes.length
  for (let i = 0; i < n; i++) {
    const curr = nodes[i]
    const next = nodes[(i + 1) % n]
    const p0 = curr.anchor
    const cp1 = curr.handleOut
    const cp2 = next.handleIn
    const p3 = next.anchor
    // Don't add last point of segment (it's the start of the next)
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment
      result.push(evaluateCubicBezier(p0, cp1, cp2, p3, t))
    }
  }
  return result
}

// ─── Nearest point on a cubic Bezier segment ─────────────────────────

/**
 * Find the parameter t of the closest point on a cubic Bezier to `pt`.
 * Uses sampling + Newton refinement. Returns { t, dist, point }.
 */
export function nearestOnCubicBezier(
  p0: Point2D, cp1: Point2D, cp2: Point2D, p3: Point2D, pt: Point2D, samples = 20
): { t: number; dist: number; point: Point2D } {
  let bestT = 0, bestDist = Infinity
  // Coarse sampling
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const p = evaluateCubicBezier(p0, cp1, cp2, p3, t)
    const d = Math.hypot(p.x - pt.x, p.y - pt.y)
    if (d < bestDist) { bestDist = d; bestT = t }
  }
  // Refine with bisection in the best interval
  let lo = Math.max(0, bestT - 1 / samples)
  let hi = Math.min(1, bestT + 1 / samples)
  for (let iter = 0; iter < 10; iter++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    const p1 = evaluateCubicBezier(p0, cp1, cp2, p3, m1)
    const p2 = evaluateCubicBezier(p0, cp1, cp2, p3, m2)
    const d1 = Math.hypot(p1.x - pt.x, p1.y - pt.y)
    const d2 = Math.hypot(p2.x - pt.x, p2.y - pt.y)
    if (d1 < d2) hi = m2; else lo = m1
  }
  bestT = (lo + hi) / 2
  const bestPt = evaluateCubicBezier(p0, cp1, cp2, p3, bestT)
  bestDist = Math.hypot(bestPt.x - pt.x, bestPt.y - pt.y)
  return { t: bestT, dist: bestDist, point: bestPt }
}

// ─── Split a cubic Bezier at parameter t (De Casteljau) ───────────────

/**
 * Split a cubic Bezier (p0, cp1, cp2, p3) at parameter t.
 * Returns two sets of 4 control points: [left, right].
 */
export function splitCubicBezier(
  p0: Point2D, cp1: Point2D, cp2: Point2D, p3: Point2D, t: number
): { left: [Point2D, Point2D, Point2D, Point2D]; right: [Point2D, Point2D, Point2D, Point2D] } {
  const lerp = (a: Point2D, b: Point2D, u: number): Point2D => ({
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
  })
  const a = lerp(p0, cp1, t)
  const b = lerp(cp1, cp2, t)
  const c = lerp(cp2, p3, t)
  const d = lerp(a, b, t)
  const e = lerp(b, c, t)
  const mid = lerp(d, e, t)
  return {
    left: [p0, a, d, mid],
    right: [mid, e, c, p3],
  }
}

// ─── Polygon expansion (offset outward) ───────────────────────────────

/**
 * Expand a closed polygon outward by `margin` pixels along vertex normals.
 * Each vertex normal is the average of the two adjacent edge normals (outward).
 * Assumes polygon vertices are in CW or CCW order.
 */
export function expandPolygon(polygon: Point2D[], margin: number): Point2D[] {
  const n = polygon.length
  if (n < 3 || margin === 0) return polygon

  // Determine winding direction (signed area)
  let signedArea = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    signedArea += (polygon[j].x - polygon[i].x) * (polygon[j].y + polygon[i].y)
  }
  // If CW (signedArea > 0 in screen coords), outward normals point right of edge direction
  // If CCW, outward normals point left
  const flip = signedArea > 0 ? 1 : -1

  const result: Point2D[] = []
  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n]
    const curr = polygon[i]
    const next = polygon[(i + 1) % n]

    // Edge normals (perpendicular, pointing outward)
    const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1) || 1
    const nx1 = -dy1 / len1 * flip, ny1 = dx1 / len1 * flip

    const dx2 = next.x - curr.x, dy2 = next.y - curr.y
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1
    const nx2 = -dy2 / len2 * flip, ny2 = dx2 / len2 * flip

    // Average normal
    let nx = (nx1 + nx2) / 2, ny = (ny1 + ny2) / 2
    const nLen = Math.sqrt(nx * nx + ny * ny) || 1
    nx /= nLen
    ny /= nLen

    result.push({
      x: curr.x + nx * margin,
      y: curr.y + ny * margin,
    })
  }
  return result
}

// ─── Segment intersection ─────────────────────────────────────────────

/**
 * Find the intersection of two line segments [a1, a2] and [b1, b2].
 * Returns the intersection point and parameter t along [a1, a2] (0 = a1, 1 = a2),
 * or null if no intersection.
 */
export function segmentIntersection(
  a1: Point2D, a2: Point2D, b1: Point2D, b2: Point2D
): { t: number; u: number; point: Point2D } | null {
  const dax = a2.x - a1.x, day = a2.y - a1.y
  const dbx = b2.x - b1.x, dby = b2.y - b1.y

  const denom = dax * dby - day * dbx
  if (Math.abs(denom) < 1e-10) return null // Parallel or collinear

  const dx = b1.x - a1.x, dy = b1.y - a1.y
  const t = (dx * dby - dy * dbx) / denom
  const u = (dx * day - dy * dax) / denom

  if (t < 0 || t > 1 || u < 0 || u > 1) return null

  return {
    t,
    u,
    point: {
      x: a1.x + t * dax,
      y: a1.y + t * day,
    },
  }
}
