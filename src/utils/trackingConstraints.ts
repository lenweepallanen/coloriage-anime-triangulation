import type { Point2D } from '../types/project'

/**
 * Build adjacency map from anchor triangles.
 * Two anchors are neighbors if they share an edge in any triangle.
 */
export function buildAnchorAdjacency(
  anchorTriangles: [number, number, number][]
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>()

  function addEdge(a: number, b: number) {
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }

  for (const [a, b, c] of anchorTriangles) {
    addEdge(a, b)
    addEdge(b, c)
    addEdge(a, c)
  }

  return adj
}

export interface ConstraintOptions {
  thresholdAbsolute?: number   // min deviation to trigger correction (px), default 2.0
  thresholdRelative?: number   // deviation in multiples of neighbor spread, default 3.0
  blendFactor?: number         // correction strength, default 0.6
}

/**
 * Apply neighbor-consensus displacement constraints after one frame of optical flow.
 * Detects anchors whose displacement deviates too much from their neighbors'
 * median displacement, and blends them back toward the median.
 * All tracked points are now true anchors (contour points are no longer tracked).
 */
export function applyNeighborConstraints(
  currentPositions: Point2D[],
  previousPositions: Point2D[],
  adjacency: Map<number, Set<number>>,
  options?: ConstraintOptions
): Point2D[] {
  const threshAbs = options?.thresholdAbsolute ?? 2.0
  const threshRel = options?.thresholdRelative ?? 3.0
  const blend = options?.blendFactor ?? 0.6

  const n = currentPositions.length

  // Compute displacements
  const displacements: Point2D[] = []
  for (let i = 0; i < n; i++) {
    displacements.push({
      x: currentPositions[i].x - previousPositions[i].x,
      y: currentPositions[i].y - previousPositions[i].y,
    })
  }

  const corrected = currentPositions.map(p => ({ ...p }))

  for (let i = 0; i < n; i++) {
    const neighbors = adjacency.get(i)
    if (!neighbors || neighbors.size === 0) continue

    // For points with only 1-2 neighbors, use a higher threshold to avoid over-constraining
    const neighborCount = neighbors.size
    const effectiveThreshRel = neighborCount <= 2 ? threshRel * 1.5 : threshRel

    // Collect neighbor displacements
    const neighborDx: number[] = []
    const neighborDy: number[] = []
    for (const j of neighbors) {
      neighborDx.push(displacements[j].x)
      neighborDy.push(displacements[j].y)
    }

    // Median displacement of neighbors
    const medianDx = median(neighborDx)
    const medianDy = median(neighborDy)

    // Deviation of this point from the median
    const devX = displacements[i].x - medianDx
    const devY = displacements[i].y - medianDy
    const dev = Math.sqrt(devX * devX + devY * devY)

    // Spread: median deviation of neighbors from their own median
    const neighborDevs: number[] = []
    for (const j of neighbors) {
      const dx = displacements[j].x - medianDx
      const dy = displacements[j].y - medianDy
      neighborDevs.push(Math.sqrt(dx * dx + dy * dy))
    }
    const spread = median(neighborDevs)

    // Trigger correction if deviation exceeds threshold
    const threshold = Math.max(threshAbs, spread * effectiveThreshRel)
    if (dev > threshold) {
      const correctedDx = displacements[i].x + (medianDx - displacements[i].x) * blend
      const correctedDy = displacements[i].y + (medianDy - displacements[i].y) * blend
      corrected[i] = {
        x: previousPositions[i].x + correctedDx,
        y: previousPositions[i].y + correctedDy,
      }
    }
  }

  return corrected
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}
