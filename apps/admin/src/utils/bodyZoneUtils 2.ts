import type { Point2D, BodyZone } from '../types/project'

/**
 * Build a lookup: triangle index → zone ID (or null).
 * Direct lookup — each triangle is explicitly assigned to a zone.
 */
export function buildTriangleZoneMap(
  triangles: [number, number, number][],
  zones: BodyZone[],
): (string | null)[] {
  const map: (string | null)[] = new Array(triangles.length).fill(null)
  for (const zone of zones) {
    for (const ti of zone.triangleIndices) {
      if (ti >= 0 && ti < triangles.length) {
        map[ti] = zone.id
      }
    }
  }
  return map
}

/**
 * Point-in-triangle test using barycentric coordinates.
 * Returns the triangle index, or -1 if not in any triangle.
 */
export function findTriangleAtPoint(
  point: Point2D,
  positions: Point2D[],
  triangles: [number, number, number][],
): number {
  for (let i = 0; i < triangles.length; i++) {
    const [ai, bi, ci] = triangles[i]
    const a = positions[ai], b = positions[bi], c = positions[ci]

    const v0x = c.x - a.x, v0y = c.y - a.y
    const v1x = b.x - a.x, v1y = b.y - a.y
    const v2x = point.x - a.x, v2y = point.y - a.y

    const dot00 = v0x * v0x + v0y * v0y
    const dot01 = v0x * v1x + v0y * v1y
    const dot02 = v0x * v2x + v0y * v2y
    const dot11 = v1x * v1x + v1y * v1y
    const dot12 = v1x * v2x + v1y * v2y

    const inv = 1 / (dot00 * dot11 - dot01 * dot01)
    const u = (dot11 * dot02 - dot01 * dot12) * inv
    const v = (dot00 * dot12 - dot01 * dot02) * inv

    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) {
      return i
    }
  }
  return -1
}

/**
 * Given a touch point in image coordinates, find which zone was touched.
 */
export function detectTouchedZone(
  imagePoint: Point2D,
  currentPositions: Point2D[],
  triangles: [number, number, number][],
  triangleZoneMap: (string | null)[],
): string | null {
  const triIdx = findTriangleAtPoint(imagePoint, currentPositions, triangles)
  if (triIdx < 0) return null
  return triangleZoneMap[triIdx]
}
