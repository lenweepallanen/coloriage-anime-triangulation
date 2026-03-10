import type { Point2D, BarycentricRef } from '../types/project'

/**
 * Compute barycentric coordinates of point P in triangle (A, B, C).
 * Returns { u, v, w } where P = u*A + v*B + w*C.
 */
export function computeBarycentric(
  p: Point2D,
  a: Point2D,
  b: Point2D,
  c: Point2D
): { u: number; v: number; w: number } {
  const v0x = c.x - a.x
  const v0y = c.y - a.y
  const v1x = b.x - a.x
  const v1y = b.y - a.y
  const v2x = p.x - a.x
  const v2y = p.y - a.y

  const dot00 = v0x * v0x + v0y * v0y
  const dot01 = v0x * v1x + v0y * v1y
  const dot02 = v0x * v2x + v0y * v2y
  const dot11 = v1x * v1x + v1y * v1y
  const dot12 = v1x * v2x + v1y * v2y

  const denom = dot00 * dot11 - dot01 * dot01
  if (Math.abs(denom) < 1e-10) {
    // Degenerate triangle — return equal weights
    return { u: 1 / 3, v: 1 / 3, w: 1 / 3 }
  }

  const inv = 1 / denom
  const wC = (dot11 * dot02 - dot01 * dot12) * inv // weight for C
  const wB = (dot00 * dot12 - dot01 * dot02) * inv // weight for B
  const wA = 1 - wC - wB                            // weight for A

  return { u: wA, v: wB, w: wC }
}

/**
 * Check if barycentric coordinates indicate the point is inside the triangle.
 */
function isInsideTriangle(u: number, v: number, w: number): boolean {
  return u >= -1e-6 && v >= -1e-6 && w >= -1e-6
}

/**
 * Find which anchor triangle contains the given point.
 * Returns BarycentricRef or null if no triangle contains it.
 * If no exact match, returns the nearest triangle (extrapolation).
 */
export function findContainingAnchorTriangle(
  point: Point2D,
  anchors: Point2D[],
  anchorTriangles: [number, number, number][]
): BarycentricRef | null {
  if (anchorTriangles.length === 0) return null

  let bestIndex = 0
  let bestMinCoord = -Infinity

  for (let i = 0; i < anchorTriangles.length; i++) {
    const [ia, ib, ic] = anchorTriangles[i]
    const bary = computeBarycentric(point, anchors[ia], anchors[ib], anchors[ic])

    if (isInsideTriangle(bary.u, bary.v, bary.w)) {
      return { anchorTriangleIndex: i, u: bary.u, v: bary.v, w: bary.w }
    }

    // Track the "least outside" triangle for fallback
    const minCoord = Math.min(bary.u, bary.v, bary.w)
    if (minCoord > bestMinCoord) {
      bestMinCoord = minCoord
      bestIndex = i
    }
  }

  // Fallback: use nearest triangle (extrapolation with negative bary coords)
  const [ia, ib, ic] = anchorTriangles[bestIndex]
  const bary = computeBarycentric(point, anchors[ia], anchors[ib], anchors[ic])
  return { anchorTriangleIndex: bestIndex, u: bary.u, v: bary.v, w: bary.w }
}

/**
 * Interpolate an internal point position from anchor positions using barycentric coordinates.
 */
export function interpolateInternalPoint(
  bary: BarycentricRef,
  anchorPositions: Point2D[],
  anchorTriangles: [number, number, number][]
): Point2D {
  const [ia, ib, ic] = anchorTriangles[bary.anchorTriangleIndex]
  const a = anchorPositions[ia]
  const b = anchorPositions[ib]
  const c = anchorPositions[ic]
  return {
    x: bary.u * a.x + bary.v * b.x + bary.w * c.x,
    y: bary.u * a.y + bary.v * b.y + bary.w * c.y,
  }
}

/**
 * Compute barycentric references for all internal points given anchor triangulation.
 */
export function computeAllBarycentrics(
  internalPoints: Point2D[],
  anchors: Point2D[],
  anchorTriangles: [number, number, number][]
): BarycentricRef[] {
  return internalPoints.map(p =>
    findContainingAnchorTriangle(p, anchors, anchorTriangles)!
  )
}
