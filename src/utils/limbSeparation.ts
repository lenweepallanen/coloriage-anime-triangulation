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
 * Find the boundary edges of a triangle mesh.
 * Returns edges as [vertexA, vertexB] pairs (ordered A < B).
 * A boundary edge appears in exactly 1 triangle.
 */
export function findBoundaryEdges(triangles: [number, number, number][]): [number, number][] {
  const edgeCount = new Map<string, { a: number; b: number; count: number }>()
  for (const [a, b, c] of triangles) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(u, v)}_${Math.max(u, v)}`
      const e = edgeCount.get(key)
      if (e) e.count++
      else edgeCount.set(key, { a: Math.min(u, v), b: Math.max(u, v), count: 1 })
    }
  }
  const result: [number, number][] = []
  for (const e of edgeCount.values()) {
    if (e.count === 1) result.push([e.a, e.b])
  }
  return result
}

/**
 * Walk the boundary of a mesh from vertex A to vertex B.
 * Returns the ordered list of vertex indices along the boundary path (inclusive A and B).
 */
export function walkBoundaryPath(
  boundaryEdges: [number, number][],
  fromIdx: number,
  toIdx: number,
): number[] {
  // Build adjacency from boundary edges
  const adj = new Map<number, number[]>()
  for (const [a, b] of boundaryEdges) {
    if (!adj.has(a)) adj.set(a, [])
    if (!adj.has(b)) adj.set(b, [])
    adj.get(a)!.push(b)
    adj.get(b)!.push(a)
  }

  // BFS from fromIdx to toIdx along boundary
  const visited = new Set<number>([fromIdx])
  const parent = new Map<number, number>()
  const queue = [fromIdx]
  let found = false

  while (queue.length > 0) {
    const curr = queue.shift()!
    if (curr === toIdx) { found = true; break }
    for (const next of adj.get(curr) ?? []) {
      if (!visited.has(next)) {
        visited.add(next)
        parent.set(next, curr)
        queue.push(next)
      }
    }
  }

  if (!found) return [fromIdx, toIdx]

  // Reconstruct path
  const path: number[] = []
  let c = toIdx
  while (c !== fromIdx) {
    path.push(c)
    c = parent.get(c)!
  }
  path.push(fromIdx)
  path.reverse()
  return path
}

/**
 * Generate internal points inside a closed polygon using a Poisson-like grid.
 * Filters by point-in-polygon and minimum distance from boundary.
 */
export function generateInternalPoints(
  polygon: Point2D[],
  spacing: number,
): Point2D[] {
  if (polygon.length < 3) return []

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }

  const margin = spacing * 0.4
  const result: Point2D[] = []

  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      const p = { x, y }
      if (!pointInPolygon(p, polygon)) continue
      // Check min distance from boundary
      let tooClose = false
      for (let i = 0; i < polygon.length; i++) {
        const j = (i + 1) % polygon.length
        const d = pointToSegmentDist(p, polygon[i], polygon[j])
        if (d < margin) { tooClose = true; break }
      }
      if (!tooClose) result.push(p)
    }
  }
  return result
}

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * Triangulate a hidden face zone and merge into body mesh.
 *
 * 1. Build closed polygon: [A, ...bridgePoints, B] + body boundary path B→A
 * 2. Generate internal points (Poisson grid)
 * 3. Delaunay + filter by polygon
 * 4. Append new points to bodyPoints, new triangles to bodyTriangles
 * 5. Return updated body + triangle indices of the hidden face
 */
export function triangulateHiddenFace(
  bodyPoints: Point2D[],
  bodyTriangles: [number, number, number][],
  vertexA: number,
  vertexB: number,
  bridgePoints: Point2D[],
  spacing?: number,
): {
  updatedBodyPoints: Point2D[]
  updatedBodyTriangles: [number, number, number][]
  hiddenFaceTriangleIndices: number[]
} {
  // 1. Build closed polygon
  const boundaryEdges = findBoundaryEdges(bodyTriangles)
  const boundaryPath = walkBoundaryPath(boundaryEdges, vertexB, vertexA)
  // boundaryPath goes from B to A along the boundary

  // Closed polygon: A → bridgePoints → B → boundary(B→A)
  const polygon: Point2D[] = [bodyPoints[vertexA]]
  for (const bp of bridgePoints) polygon.push(bp)
  polygon.push(bodyPoints[vertexB])
  // Add boundary path from B to A (skip first=B and last=A since they're already in polygon)
  for (let i = 1; i < boundaryPath.length - 1; i++) {
    polygon.push(bodyPoints[boundaryPath[i]])
  }

  if (polygon.length < 3) {
    return { updatedBodyPoints: bodyPoints, updatedBodyTriangles: bodyTriangles, hiddenFaceTriangleIndices: [] }
  }

  // 2. Generate internal points
  const sp = spacing ?? Math.max(10, Math.hypot(
    bodyPoints[vertexA].x - bodyPoints[vertexB].x,
    bodyPoints[vertexA].y - bodyPoints[vertexB].y,
  ) / 5)
  const internalPts = generateInternalPoints(polygon, sp)

  // 3. Build contour points for Delaunay
  //    Contour = bridge points (new) + body boundary path points (existing, referenced by index)
  //    We need to create a unified point array for Delaunay:
  //    - Reuse existing body vertex indices for A, B, and boundary path vertices
  //    - Add bridge points and internal points as NEW body vertices

  const newPoints: Point2D[] = [...bridgePoints, ...internalPts]
  const baseNewIdx = bodyPoints.length  // index where new points start

  // All points for Delaunay (in local index space for the triangulation)
  // We map: local index → global body index
  const localPoints: Point2D[] = []
  const localToGlobal: number[] = []

  // A
  localPoints.push(bodyPoints[vertexA])
  localToGlobal.push(vertexA)

  // Bridge points (new)
  for (let i = 0; i < bridgePoints.length; i++) {
    localPoints.push(bridgePoints[i])
    localToGlobal.push(baseNewIdx + i)
  }

  // B
  localPoints.push(bodyPoints[vertexB])
  localToGlobal.push(vertexB)

  // Boundary path vertices from B to A (skip B and A themselves)
  for (let i = 1; i < boundaryPath.length - 1; i++) {
    localPoints.push(bodyPoints[boundaryPath[i]])
    localToGlobal.push(boundaryPath[i])
  }

  // Internal points (new)
  for (let i = 0; i < internalPts.length; i++) {
    localPoints.push(internalPts[i])
    localToGlobal.push(baseNewIdx + bridgePoints.length + i)
  }

  // 4. Delaunay + filter
  if (localPoints.length < 3) {
    return { updatedBodyPoints: bodyPoints, updatedBodyTriangles: bodyTriangles, hiddenFaceTriangleIndices: [] }
  }

  const coords = new Float64Array(localPoints.length * 2)
  localPoints.forEach((p, i) => { coords[i * 2] = p.x; coords[i * 2 + 1] = p.y })

  let newTriangles: [number, number, number][] = []
  try {
    const delaunay = new Delaunator(coords)
    for (let i = 0; i < delaunay.triangles.length; i += 3) {
      const a = delaunay.triangles[i]
      const b = delaunay.triangles[i + 1]
      const c = delaunay.triangles[i + 2]
      const cent = triangleCentroid(localPoints[a], localPoints[b], localPoints[c])
      if (pointInPolygon(cent, polygon)) {
        // Map local indices to global body indices
        newTriangles.push([localToGlobal[a], localToGlobal[b], localToGlobal[c]])
      }
    }
  } catch {
    return { updatedBodyPoints: bodyPoints, updatedBodyTriangles: bodyTriangles, hiddenFaceTriangleIndices: [] }
  }

  // 5. Merge into body
  const updatedBodyPoints = [...bodyPoints, ...newPoints]
  const triStartIdx = bodyTriangles.length
  const updatedBodyTriangles = [...bodyTriangles, ...newTriangles]
  const hiddenFaceTriangleIndices = newTriangles.map((_, i) => triStartIdx + i)

  return { updatedBodyPoints, updatedBodyTriangles, hiddenFaceTriangleIndices }
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
