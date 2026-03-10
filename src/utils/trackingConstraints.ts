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

// ---------------------------------------------------------------------------
// 1. Anti-saut: clamp max displacement per frame
// ---------------------------------------------------------------------------

/**
 * Clamp each anchor's displacement so it cannot exceed vmax pixels per frame.
 * If a point moves farther than vmax, it is pulled back in the same direction.
 */
export function applyAntiSaut(
  currentPositions: Point2D[],
  previousPositions: Point2D[],
  vmax: number
): Point2D[] {
  return currentPositions.map((p, i) => {
    const prev = previousPositions[i]
    const dx = p.x - prev.x
    const dy = p.y - prev.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > vmax) {
      const scale = vmax / dist
      return { x: prev.x + dx * scale, y: prev.y + dy * scale }
    }
    return { ...p }
  })
}

// ---------------------------------------------------------------------------
// 2. Temporal smoothing: moving average over a window of frames
// ---------------------------------------------------------------------------

/**
 * Smooth anchor trajectories with a centered moving average.
 * Frame 0 and the last frame are preserved as-is.
 * At edges the window shrinks symmetrically.
 */
export function applyTemporalSmoothing(
  allFrames: Point2D[][],
  windowSize: number = 3
): Point2D[][] {
  const totalFrames = allFrames.length
  if (totalFrames <= 2) return allFrames.map(f => f.map(p => ({ ...p })))

  const halfWin = Math.floor(windowSize / 2)
  const numAnchors = allFrames[0].length
  const result: Point2D[][] = new Array(totalFrames)

  // Keep first and last frame unchanged
  result[0] = allFrames[0].map(p => ({ ...p }))
  result[totalFrames - 1] = allFrames[totalFrames - 1].map(p => ({ ...p }))

  for (let f = 1; f < totalFrames - 1; f++) {
    const lo = Math.max(0, f - halfWin)
    const hi = Math.min(totalFrames - 1, f + halfWin)
    const count = hi - lo + 1
    const positions: Point2D[] = new Array(numAnchors)

    for (let a = 0; a < numAnchors; a++) {
      let sx = 0, sy = 0
      for (let k = lo; k <= hi; k++) {
        sx += allFrames[k][a].x
        sy += allFrames[k][a].y
      }
      positions[a] = { x: sx / count, y: sy / count }
    }
    result[f] = positions
  }

  return result
}

// ---------------------------------------------------------------------------
// 3. Contour constraints: tighter consensus + ordering enforcement
// ---------------------------------------------------------------------------

export interface ContourConstraintOptions {
  maxDeviation?: number   // px, default 1.5
  blendFactor?: number    // default 0.8
  enforceOrdering?: boolean // default true
}

/**
 * Apply stricter displacement constraints to contour anchors.
 * Uses contour-neighbor median (prev/next along contour) with a tight threshold.
 * Optionally enforces that consecutive contour anchors do not swap order.
 */
export function applyContourConstraints(
  currentPositions: Point2D[],
  previousPositions: Point2D[],
  contourAnchorOrder: number[],
  options?: ContourConstraintOptions
): Point2D[] {
  const maxDev = options?.maxDeviation ?? 1.5
  const blend = options?.blendFactor ?? 0.8
  const enforce = options?.enforceOrdering ?? true

  if (contourAnchorOrder.length < 3) return currentPositions.map(p => ({ ...p }))

  const corrected = currentPositions.map(p => ({ ...p }))
  const n = contourAnchorOrder.length

  // Compute displacements for contour anchors
  const displacements: Point2D[] = currentPositions.map((p, i) => ({
    x: p.x - previousPositions[i].x,
    y: p.y - previousPositions[i].y,
  }))

  // Contour-neighbor median constraint
  for (let k = 0; k < n; k++) {
    const idx = contourAnchorOrder[k]
    const prevIdx = contourAnchorOrder[(k - 1 + n) % n]
    const nextIdx = contourAnchorOrder[(k + 1) % n]

    // Median of prev/next contour neighbor displacements
    const medDx = (displacements[prevIdx].x + displacements[nextIdx].x) / 2
    const medDy = (displacements[prevIdx].y + displacements[nextIdx].y) / 2

    const devX = displacements[idx].x - medDx
    const devY = displacements[idx].y - medDy
    const dev = Math.sqrt(devX * devX + devY * devY)

    if (dev > maxDev) {
      const correctedDx = displacements[idx].x + (medDx - displacements[idx].x) * blend
      const correctedDy = displacements[idx].y + (medDy - displacements[idx].y) * blend
      corrected[idx] = {
        x: previousPositions[idx].x + correctedDx,
        y: previousPositions[idx].y + correctedDy,
      }
    }
  }

  // Ordering enforcement: if consecutive contour anchors cross, interpolate
  if (enforce) {
    for (let k = 0; k < n; k++) {
      const idxA = contourAnchorOrder[k]
      const idxB = contourAnchorOrder[(k + 1) % n]
      const idxC = contourAnchorOrder[(k + 2) % n]

      const a = corrected[idxA]
      const b = corrected[idxB]
      const c = corrected[idxC]

      // Check if B crossed over the AC line using cross product sign
      const abx = b.x - a.x, aby = b.y - a.y
      const acx = c.x - a.x, acy = c.y - a.y
      const crossCurr = abx * acy - aby * acx

      const pa = previousPositions[idxA]
      const pb = previousPositions[idxB]
      const pc = previousPositions[idxC]
      const pabx = pb.x - pa.x, paby = pb.y - pa.y
      const pacx = pc.x - pa.x, pacy = pc.y - pa.y
      const crossPrev = pabx * pacy - paby * pacx

      // If sign flipped, B crossed the AC line → interpolate B between A and C
      if (crossPrev !== 0 && Math.sign(crossCurr) !== Math.sign(crossPrev)) {
        corrected[idxB] = {
          x: (a.x + c.x) / 2,
          y: (a.y + c.y) / 2,
        }
      }
    }
  }

  return corrected
}

// ---------------------------------------------------------------------------
// 4. Outlier detection & correction
// ---------------------------------------------------------------------------

export interface OutlierOptions {
  accelerationThreshold?: number  // px, default 5.0
  velocityMultiplier?: number     // default 4.0
  minConsecutiveFrames?: number   // default 2
}

/**
 * Detect and correct outlier anchors based on abnormal velocity/acceleration.
 * An anchor is suspect if:
 *   - Its acceleration exceeds a threshold, OR
 *   - Its velocity is > N× the median velocity of its neighbors for 2+ frames
 * Correction: temporal interpolation between last good and next good position.
 */
export function detectAndCorrectOutliers(
  allFrames: Point2D[][],
  adjacency: Map<number, Set<number>>,
  options?: OutlierOptions
): { corrected: Point2D[][]; suspects: Map<number, number[]> } {
  const accelThresh = options?.accelerationThreshold ?? 5.0
  const velMult = options?.velocityMultiplier ?? 4.0
  const minConsec = options?.minConsecutiveFrames ?? 2

  const totalFrames = allFrames.length
  const numAnchors = allFrames[0]?.length ?? 0
  const suspects = new Map<number, number[]>()

  if (totalFrames < 3 || numAnchors === 0) {
    return { corrected: allFrames.map(f => f.map(p => ({ ...p }))), suspects }
  }

  // Compute velocities (displacement per frame)
  const vel: Point2D[][] = [] // vel[frame][anchor]
  for (let f = 0; f < totalFrames; f++) {
    if (f === 0) {
      vel.push(allFrames[0].map(() => ({ x: 0, y: 0 })))
    } else {
      vel.push(allFrames[f].map((p, a) => ({
        x: p.x - allFrames[f - 1][a].x,
        y: p.y - allFrames[f - 1][a].y,
      })))
    }
  }

  // Mark suspect frames per anchor
  const isSuspect: boolean[][] = Array.from({ length: totalFrames }, () =>
    new Array(numAnchors).fill(false)
  )

  for (let a = 0; a < numAnchors; a++) {
    let consecutiveHighVel = 0

    for (let f = 2; f < totalFrames; f++) {
      // Acceleration check
      const ax = vel[f][a].x - vel[f - 1][a].x
      const ay = vel[f][a].y - vel[f - 1][a].y
      const accel = Math.sqrt(ax * ax + ay * ay)

      if (accel > accelThresh) {
        isSuspect[f][a] = true
      }

      // Velocity vs neighbors check
      const neighbors = adjacency.get(a)
      if (neighbors && neighbors.size > 0) {
        const neighborVels: number[] = []
        for (const j of neighbors) {
          neighborVels.push(Math.sqrt(vel[f][j].x ** 2 + vel[f][j].y ** 2))
        }
        const medVel = median(neighborVels)
        const myVel = Math.sqrt(vel[f][a].x ** 2 + vel[f][a].y ** 2)

        if (medVel > 0 && myVel > medVel * velMult) {
          consecutiveHighVel++
          if (consecutiveHighVel >= minConsec) {
            // Mark current and previous high-velocity frames
            for (let k = f - consecutiveHighVel + 1; k <= f; k++) {
              isSuspect[k][a] = true
            }
          }
        } else {
          consecutiveHighVel = 0
        }
      }
    }
  }

  // Build corrected frames
  const corrected = allFrames.map(f => f.map(p => ({ ...p })))

  for (let a = 0; a < numAnchors; a++) {
    // Find suspect runs and interpolate
    let runStart = -1
    for (let f = 0; f <= totalFrames; f++) {
      if (f < totalFrames && isSuspect[f][a]) {
        if (runStart < 0) runStart = f
      } else if (runStart >= 0) {
        // End of suspect run [runStart, f-1]
        const lastGood = Math.max(0, runStart - 1)
        const nextGood = Math.min(totalFrames - 1, f)
        const span = nextGood - lastGood

        // Record suspects
        for (let k = runStart; k < f; k++) {
          if (!suspects.has(k)) suspects.set(k, [])
          suspects.get(k)!.push(a)
        }

        // Temporal interpolation
        if (span > 0) {
          for (let k = runStart; k < f; k++) {
            const t = (k - lastGood) / span
            corrected[k][a] = {
              x: allFrames[lastGood][a].x + (allFrames[nextGood][a].x - allFrames[lastGood][a].x) * t,
              y: allFrames[lastGood][a].y + (allFrames[nextGood][a].y - allFrames[lastGood][a].y) * t,
            }
          }
        }

        runStart = -1
      }
    }
  }

  return { corrected, suspects }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}
