import type { Point2D } from '../types/project'

export function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function distanceSq(a: Point2D, b: Point2D): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function triangleCentroid(
  a: Point2D,
  b: Point2D,
  c: Point2D
): Point2D {
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3,
  }
}

/**
 * Compute the minimum angle (in degrees) of a triangle.
 * Uses the law of cosines: cos(A) = (b² + c² - a²) / (2bc)
 */
export function triangleMinAngle(a: Point2D, b: Point2D, c: Point2D): number {
  const ab = distance(a, b)
  const bc = distance(b, c)
  const ca = distance(c, a)
  if (ab < 1e-10 || bc < 1e-10 || ca < 1e-10) return 0

  const cosA = (ab * ab + ca * ca - bc * bc) / (2 * ab * ca)
  const cosB = (ab * ab + bc * bc - ca * ca) / (2 * ab * bc)
  const cosC = (bc * bc + ca * ca - ab * ab) / (2 * bc * ca)

  const clamp = (v: number) => Math.max(-1, Math.min(1, v))
  const angleA = Math.acos(clamp(cosA)) * 180 / Math.PI
  const angleB = Math.acos(clamp(cosB)) * 180 / Math.PI
  const angleC = Math.acos(clamp(cosC)) * 180 / Math.PI

  return Math.min(angleA, angleB, angleC)
}

/**
 * Compute circumradius / shortest edge ratio.
 * Higher values indicate more degenerate (sliver) triangles.
 * A perfect equilateral triangle has ratio ≈ 0.577.
 */
export function circumradiusEdgeRatio(a: Point2D, b: Point2D, c: Point2D): number {
  const ab = distance(a, b)
  const bc = distance(b, c)
  const ca = distance(c, a)
  const minEdge = Math.min(ab, bc, ca)
  if (minEdge < 1e-10) return Infinity

  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
  if (area < 1e-10) return Infinity

  const circumradius = (ab * bc * ca) / (4 * area)
  return circumradius / minEdge
}
