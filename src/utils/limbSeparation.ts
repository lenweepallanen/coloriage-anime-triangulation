/**
 * Limb Separation — simplified approach.
 *
 * Each limb zone gets a **fresh** Delaunay triangulation from its Bezier
 * contour polygon (sampled) + optional internal points. No triangle cutting.
 *
 * The body keeps the original rest triangles whose centroid is NOT inside
 * any limb zone polygon.
 */

import Delaunator from 'delaunator'
import type { Point2D, WalkLimbZone, WalkLimbSeparation } from '../types/project'
import { flattenClosedBezier, expandPolygon } from './bezierUtils'
import { pointInPolygon, triangleCentroid } from './geometry'

/**
 * Build the initial limb separation from Bezier zones.
 *
 * - Per limb: sample the Bezier contour → Delaunay → filter by polygon
 * - Body: rest triangles not inside any limb polygon
 */
export function separateLimbs(
  restAllPoints: Point2D[],
  restTriangles: [number, number, number][],
  zones: WalkLimbZone[],
  overlapMargin: number,
): WalkLimbSeparation {
  // Flatten each zone's Bezier to a polygon
  const zonePolygons = new Map<string, Point2D[]>()
  for (const zone of zones) {
    if (zone.bezierNodes.length < 3) continue
    const flat = flattenClosedBezier(zone.bezierNodes, 30)
    zonePolygons.set(zone.id, overlapMargin > 0 ? expandPolygon(flat, overlapMargin) : flat)
  }

  // ── Body: rest triangles where NO vertex is inside any limb zone ──
  const bodyTriangleIndices: number[] = []
  for (let ti = 0; ti < restTriangles.length; ti++) {
    const [a, b, c] = restTriangles[ti]
    let insideAny = false
    for (const poly of zonePolygons.values()) {
      if (pointInPolygon(restAllPoints[a], poly) ||
          pointInPolygon(restAllPoints[b], poly) ||
          pointInPolygon(restAllPoints[c], poly)) {
        insideAny = true; break
      }
    }
    if (!insideAny) bodyTriangleIndices.push(ti)
  }

  // ── Build bodyPoints + bodyTriangles (re-indexed local arrays) ──
  const bodyVertSet = new Set<number>()
  for (const ti of bodyTriangleIndices) {
    const [a, b, c] = restTriangles[ti]
    bodyVertSet.add(a); bodyVertSet.add(b); bodyVertSet.add(c)
  }
  const bodyGlobal = [...bodyVertSet].sort((a, b) => a - b)
  const g2l = new Map<number, number>()
  bodyGlobal.forEach((gi, li) => g2l.set(gi, li))
  const bodyPoints = bodyGlobal.map(gi => restAllPoints[gi])
  const bodyTriangles: [number, number, number][] = bodyTriangleIndices.map(ti => {
    const [a, b, c] = restTriangles[ti]
    return [g2l.get(a)!, g2l.get(b)!, g2l.get(c)!]
  })

  // ── Per-zone: fresh Delaunay from Bezier contour samples ──
  const zonePoints: Record<string, Point2D[]> = {}
  const zoneTriangles: Record<string, [number, number, number][]> = {}

  for (const zone of zones) {
    const polygon = zonePolygons.get(zone.id)
    if (!polygon || polygon.length < 3) {
      zonePoints[zone.id] = []
      zoneTriangles[zone.id] = []
      continue
    }

    // Sample contour at lower density for vertices (every ~10px arc-length)
    const contourPts = sampleContourVertices(polygon, 10)

    const result = triangulateZone(contourPts, [], polygon)
    zonePoints[zone.id] = result.points
    zoneTriangles[zone.id] = result.triangles
  }

  return {
    zones,
    overlapMargin,
    zonePoints,
    zoneTriangles,
    bodyTriangleIndices,
    bodyPoints,
    bodyTriangles,
  }
}

/**
 * Re-triangulate a single limb zone with optional internal points.
 */
export function triangulateZone(
  contourPts: Point2D[],
  internalPts: Point2D[],
  filterPolygon: Point2D[],
): { points: Point2D[]; triangles: [number, number, number][] } {
  const allPts = [...contourPts, ...internalPts]
  if (allPts.length < 3) return { points: allPts, triangles: [] }

  const coords = new Float64Array(allPts.length * 2)
  allPts.forEach((p, i) => { coords[i * 2] = p.x; coords[i * 2 + 1] = p.y })

  try {
    const delaunay = new Delaunator(coords)
    const triangles: [number, number, number][] = []
    for (let i = 0; i < delaunay.triangles.length; i += 3) {
      const a = delaunay.triangles[i]
      const b = delaunay.triangles[i + 1]
      const c = delaunay.triangles[i + 2]
      const cent = triangleCentroid(allPts[a], allPts[b], allPts[c])
      if (pointInPolygon(cent, filterPolygon)) {
        triangles.push([a, b, c])
      }
    }
    return { points: allPts, triangles }
  } catch {
    return { points: allPts, triangles: [] }
  }
}

/**
 * Sample a polygon into vertices with roughly `spacing` px between them.
 */
function sampleContourVertices(polygon: Point2D[], spacing: number): Point2D[] {
  if (polygon.length < 3) return [...polygon]

  // Compute total perimeter
  let totalLen = 0
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length
    totalLen += Math.hypot(polygon[j].x - polygon[i].x, polygon[j].y - polygon[i].y)
  }

  const numPts = Math.max(8, Math.round(totalLen / spacing))
  const step = totalLen / numPts
  const result: Point2D[] = []

  let segIdx = 0
  let segStart = 0

  for (let i = 0; i < numPts; i++) {
    const targetDist = i * step

    // Advance along polygon edges
    while (segIdx < polygon.length) {
      const j = (segIdx + 1) % polygon.length
      const segLen = Math.hypot(polygon[j].x - polygon[segIdx].x, polygon[j].y - polygon[segIdx].y)
      if (segStart + segLen >= targetDist || segIdx === polygon.length - 1) {
        const t = segLen > 0 ? (targetDist - segStart) / segLen : 0
        result.push({
          x: polygon[segIdx].x + t * (polygon[j].x - polygon[segIdx].x),
          y: polygon[segIdx].y + t * (polygon[j].y - polygon[segIdx].y),
        })
        break
      }
      segStart += segLen
      segIdx++
    }
  }

  return result
}

/**
 * Build body mesh from auto triangles + manual patch.
 * Auto body triangles are FIXED. Manual extra points + triangles are appended.
 * bodyPoints = [...autoBodyPoints, ...extraPoints]
 * bodyTriangles = [...autoBodyTriangles, ...manualTriangles]
 */
export function buildBodyMesh(
  autoBodyPoints: Point2D[],
  autoBodyTriangles: [number, number, number][],
  extraPoints: Point2D[],
  manualTriangles: [number, number, number][],
): { bodyPoints: Point2D[]; bodyTriangles: [number, number, number][] } {
  return {
    bodyPoints: [...autoBodyPoints, ...extraPoints],
    bodyTriangles: [...autoBodyTriangles, ...manualTriangles],
  }
}

/**
 * Find the 2 nearest vertices to a point in a body mesh.
 * Returns their indices in bodyPoints.
 */
export function findTwoNearest(pt: Point2D, bodyPoints: Point2D[]): [number, number] {
  let best1 = 0, best2 = 1
  let dist1 = Infinity, dist2 = Infinity
  for (let i = 0; i < bodyPoints.length; i++) {
    const d = Math.hypot(pt.x - bodyPoints[i].x, pt.y - bodyPoints[i].y)
    if (d < dist1) {
      dist2 = dist1; best2 = best1
      dist1 = d; best1 = i
    } else if (d < dist2) {
      dist2 = d; best2 = i
    }
  }
  return [best1, best2]
}
