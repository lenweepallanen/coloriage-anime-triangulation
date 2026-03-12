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
// 3. Curvilinear contour stabilization
// ---------------------------------------------------------------------------

export interface ContourStabilizationOptions {
  minSpacingRatio?: number      // min spacing as fraction of initial spacing, default 0.5
  spacingRegularization?: number // strength of pull toward initial spacing (0-1), default 0.5
  smoothingWeight?: number       // Laplacian smoothing weight (0-1), default 0.25
  smoothingIterations?: number   // number of smoothing passes, default 2
}

/**
 * Compute cumulative arc lengths along a closed polyline.
 * Returns an array of length n+1 where [0]=0 and [n]=totalLength.
 */
function computeCumulativeLengths(polyline: Point2D[]): number[] {
  const n = polyline.length
  const cumLen = [0]
  for (let i = 1; i <= n; i++) {
    const a = polyline[i - 1]
    const b = polyline[i % n]
    const dx = b.x - a.x, dy = b.y - a.y
    cumLen.push(cumLen[i - 1] + Math.sqrt(dx * dx + dy * dy))
  }
  return cumLen
}

/**
 * Project a point onto a closed polyline segment and return curvilinear coordinate s ∈ [0,1].
 */
function projectOntoPolyline(
  p: Point2D,
  polyline: Point2D[],
  cumLen: number[]
): number {
  const n = polyline.length
  const totalLen = cumLen[n]
  if (totalLen < 1e-10) return 0

  let bestS = 0
  let bestDistSq = Infinity

  for (let i = 0; i < n; i++) {
    const a = polyline[i]
    const b = polyline[(i + 1) % n]
    const abx = b.x - a.x, aby = b.y - a.y
    const segLenSq = abx * abx + aby * aby

    let t = 0
    if (segLenSq > 1e-10) {
      t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / segLenSq
      t = Math.max(0, Math.min(1, t))
    }

    const projX = a.x + t * abx
    const projY = a.y + t * aby
    const dx = p.x - projX, dy = p.y - projY
    const distSq = dx * dx + dy * dy

    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestS = (cumLen[i] + t * (cumLen[i + 1] - cumLen[i])) / totalLen
    }
  }

  return bestS
}

/**
 * Reconstruct a 2D point from curvilinear coordinate s on a closed polyline.
 */
function pointOnPolyline(
  s: number,
  polyline: Point2D[],
  cumLen: number[]
): Point2D {
  const n = polyline.length
  const totalLen = cumLen[n]
  // Wrap s into [0,1)
  let sNorm = ((s % 1) + 1) % 1
  const targetLen = sNorm * totalLen

  // Find the segment containing targetLen
  for (let i = 0; i < n; i++) {
    if (targetLen >= cumLen[i] && targetLen <= cumLen[i + 1]) {
      const segLen = cumLen[i + 1] - cumLen[i]
      const t = segLen > 1e-10 ? (targetLen - cumLen[i]) / segLen : 0
      const a = polyline[i]
      const b = polyline[(i + 1) % n]
      return {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
      }
    }
  }

  // Fallback: return last point
  return { ...polyline[n - 1] }
}

/**
 * Compute initial curvilinear spacings between consecutive contour anchors.
 * Returns d_i = s_{i+1} - s_i for i=0..n-1 (wrapping).
 * Call this once at frame 0 and pass to stabilizeContourAnchors.
 */
export function computeInitialContourSpacings(
  positions: Point2D[],
  contourAnchorOrder: number[]
): number[] {
  const n = contourAnchorOrder.length
  if (n < 3) return []

  // Build polyline from contour anchors in order
  const polyline = contourAnchorOrder.map(idx => positions[idx])
  const cumLen = computeCumulativeLengths(polyline)

  // Project each anchor onto its own polyline to get s values
  const sValues: number[] = []
  for (let k = 0; k < n; k++) {
    sValues.push(projectOntoPolyline(positions[contourAnchorOrder[k]], polyline, cumLen))
  }

  // Compute spacings (circular)
  const spacings: number[] = []
  for (let k = 0; k < n; k++) {
    let d = sValues[(k + 1) % n] - sValues[k]
    if (d < 0) d += 1 // wrap around
    spacings.push(d)
  }

  return spacings
}

/**
 * Stabilize contour anchor positions using curvilinear coordinates.
 *
 * Pipeline:
 * 1. Build polyline from previous contour anchor positions
 * 2. Project raw tracked positions onto polyline → curvilinear s_i
 * 3. Enforce ordering: s_i < s_{i+1}
 * 4. Enforce minimum spacing: s_{i+1} - s_i >= d_min
 * 5. Regularize toward initial spacing distribution
 * 6. Laplacian smoothing on s values
 * 7. Reconstruct 2D positions from stabilized s values
 */
export function stabilizeContourAnchors(
  currentPositions: Point2D[],
  previousPositions: Point2D[],
  contourAnchorOrder: number[],
  initialSpacings: number[],
  options?: ContourStabilizationOptions
): Point2D[] {
  const n = contourAnchorOrder.length
  if (n < 3) return currentPositions.map(p => ({ ...p }))

  const minSpacingRatio = options?.minSpacingRatio ?? 0.5
  const spacingReg = options?.spacingRegularization ?? 0.5
  const smoothW = options?.smoothingWeight ?? 0.25
  const smoothIter = options?.smoothingIterations ?? 2

  const corrected = currentPositions.map(p => ({ ...p }))

  // Step 1: Build polyline from previous frame's contour anchors
  const polyline = contourAnchorOrder.map(idx => previousPositions[idx])
  const cumLen = computeCumulativeLengths(polyline)

  // Step 2: Project current positions onto polyline → curvilinear coordinates
  let sValues: number[] = []
  for (let k = 0; k < n; k++) {
    sValues.push(projectOntoPolyline(
      currentPositions[contourAnchorOrder[k]], polyline, cumLen
    ))
  }

  // Step 3: Enforce ordering (s_i should increase monotonically, with wrap)
  // Sort by initial s value to detect permutations, then fix
  for (let k = 1; k < n; k++) {
    // Compute signed circular difference
    let diff = sValues[k] - sValues[k - 1]
    if (diff < -0.5) diff += 1 // handle wrap-around
    if (diff < 0) {
      // k crossed over k-1 → place k just after k-1
      sValues[k] = sValues[k - 1] + 1e-6
    }
  }

  // Step 4: Enforce minimum spacing
  if (initialSpacings.length === n) {
    for (let k = 0; k < n; k++) {
      const nextK = (k + 1) % n
      let spacing = sValues[nextK] - sValues[k]
      if (spacing < 0) spacing += 1 // wrap

      const dMin = initialSpacings[k] * minSpacingRatio
      if (spacing < dMin && dMin > 0) {
        // Push next anchor forward by half the deficit
        const deficit = dMin - spacing
        sValues[nextK] = sValues[nextK] + deficit * 0.5
        sValues[k] = sValues[k] - deficit * 0.5
      }
    }
  }

  // Step 5: Regularize toward initial spacing distribution
  if (initialSpacings.length === n && spacingReg > 0) {
    for (let k = 0; k < n; k++) {
      const nextK = (k + 1) % n
      let currentSpacing = sValues[nextK] - sValues[k]
      if (currentSpacing < 0) currentSpacing += 1

      const targetSpacing = initialSpacings[k]
      const error = targetSpacing - currentSpacing

      // Move both endpoints to reduce error
      const correction = error * spacingReg * 0.5
      sValues[k] -= correction * 0.5
      sValues[nextK] += correction * 0.5
    }
  }

  // Step 6: Laplacian smoothing on s values
  for (let iter = 0; iter < smoothIter; iter++) {
    const smoothed = [...sValues]
    for (let k = 0; k < n; k++) {
      const prev = sValues[(k - 1 + n) % n]
      const next = sValues[(k + 1) % n]
      // For circular coordinates, handle wrap
      let sPrev = prev, sNext = next
      const sCurr = sValues[k]

      // Unwrap neighbors relative to current
      if (sCurr - sPrev > 0.5) sPrev += 1
      if (sPrev - sCurr > 0.5) sPrev -= 1
      if (sCurr - sNext > 0.5) sNext += 1
      if (sNext - sCurr > 0.5) sNext -= 1

      const avg = smoothW * sPrev + (1 - 2 * smoothW) * sCurr + smoothW * sNext
      smoothed[k] = ((avg % 1) + 1) % 1 // wrap back to [0,1)
    }
    sValues = smoothed
  }

  // Step 7: Reconstruct 2D positions
  for (let k = 0; k < n; k++) {
    corrected[contourAnchorOrder[k]] = pointOnPolyline(sValues[k], polyline, cumLen)
  }

  return corrected
}

// Legacy alias
export const applyContourConstraints = stabilizeContourAnchors

// ---------------------------------------------------------------------------
// 4. Min separation: anti-agglutination repulsion force
// ---------------------------------------------------------------------------

/**
 * Prevent anchor points from getting too close to their topological neighbors.
 * For each edge in the adjacency, if the distance is below minDist,
 * push both points apart symmetrically.
 */
export function applyMinSeparation(
  positions: Point2D[],
  adjacency: Map<number, Set<number>>,
  minDist: number
): Point2D[] {
  const corrected = positions.map(p => ({ ...p }))
  const processed = new Set<string>()

  for (const [i, neighbors] of adjacency) {
    for (const j of neighbors) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`
      if (processed.has(key)) continue
      processed.add(key)

      const dx = corrected[j].x - corrected[i].x
      const dy = corrected[j].y - corrected[i].y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist < minDist) {
        if (dist > 1e-6) {
          const push = (minDist - dist) / 2
          const ux = dx / dist, uy = dy / dist
          corrected[i].x -= ux * push
          corrected[i].y -= uy * push
          corrected[j].x += ux * push
          corrected[j].y += uy * push
        } else {
          // Superimposed points: deterministic offset based on index
          const angle = ((i * 7 + j * 13) % 360) * Math.PI / 180
          const push = minDist / 2
          corrected[i].x -= Math.cos(angle) * push
          corrected[i].y -= Math.sin(angle) * push
          corrected[j].x += Math.cos(angle) * push
          corrected[j].y += Math.sin(angle) * push
        }
      }
    }
  }

  return corrected
}

// ---------------------------------------------------------------------------
// 5. Outlier detection & correction
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

// ---------------------------------------------------------------------------
// Snap-to-contour constraint
// ---------------------------------------------------------------------------

export interface SnapToContourOptions {
  enabled: boolean
  snapRadius: number        // px — max distance for full snap (default 12)
  lostRadius: number        // px — beyond this, point is lost (default 30)
  strengthNormal: number    // [0,1] — snap strength within snapRadius (default 1.0)
  strengthPartial: number   // [0,1] — snap strength between snapRadius and lostRadius (default 0.5)
}

export const DEFAULT_SNAP_OPTIONS: SnapToContourOptions = {
  enabled: true,
  snapRadius: 12,
  lostRadius: 30,
  strengthNormal: 1.0,
  strengthPartial: 0.5,
}

export interface SnapResult {
  snapped: Point2D[]
  confidences: number[]
  lostFlags: boolean[]
}

/**
 * Snap tracked points onto the detected contour.
 * Should be applied LAST in the constraint cascade, before flowUpdatePoints().
 */
export function applySnapToContour(
  points: Point2D[],
  contourIndex: { nearest(point: Point2D, maxDist: number): { point: Point2D; dist: number } | null },
  options: SnapToContourOptions = DEFAULT_SNAP_OPTIONS
): SnapResult {
  const snapped: Point2D[] = []
  const confidences: number[] = []
  const lostFlags: boolean[] = []

  for (const p of points) {
    const result = contourIndex.nearest(p, options.lostRadius)

    if (!result) {
      // No contour found within lostRadius → lost
      snapped.push({ x: p.x, y: p.y })
      confidences.push(0)
      lostFlags.push(true)
      continue
    }

    const { point: nearest, dist } = result

    if (dist <= options.snapRadius) {
      // Within snap radius → full snap
      snapped.push({
        x: p.x + (nearest.x - p.x) * options.strengthNormal,
        y: p.y + (nearest.y - p.y) * options.strengthNormal,
      })
      const confidence = 1.0 - (dist / options.snapRadius) * 0.3 // [0.7, 1.0]
      confidences.push(confidence)
      lostFlags.push(false)
    } else {
      // Between snapRadius and lostRadius → partial snap
      snapped.push({
        x: p.x + (nearest.x - p.x) * options.strengthPartial,
        y: p.y + (nearest.y - p.y) * options.strengthPartial,
      })
      const confidence = 1.0 - dist / options.lostRadius // [0, ~0.6]
      confidences.push(Math.max(0, confidence))
      lostFlags.push(false)
    }
  }

  return { snapped, confidences, lostFlags }
}

/**
 * Attempt to recover lost points by searching a wider radius.
 * Recovered points get low confidence (0.3) to signal need for manual review.
 */
export function recoverLostPoints(
  points: Point2D[],
  lostFlags: boolean[],
  contourIndex: { nearest(point: Point2D, maxDist: number): { point: Point2D; dist: number } | null },
  recoveryRadius = 60
): { recovered: Point2D[]; confidences: number[]; stillLost: boolean[] } {
  const recovered: Point2D[] = []
  const confidences: number[] = []
  const stillLost: boolean[] = []

  for (let i = 0; i < points.length; i++) {
    if (!lostFlags[i]) {
      recovered.push(points[i])
      confidences.push(1.0) // not lost, keep existing confidence
      stillLost.push(false)
      continue
    }

    const result = contourIndex.nearest(points[i], recoveryRadius)
    if (result) {
      // Recovered → snap fully but with low confidence
      recovered.push({ x: result.point.x, y: result.point.y })
      confidences.push(0.3)
      stillLost.push(false)
    } else {
      // Still lost
      recovered.push(points[i])
      confidences.push(0)
      stillLost.push(true)
    }
  }

  return { recovered, confidences, stillLost }
}

// ---------------------------------------------------------------------------
// 6. Curvilinear spring repulsion on Canny contour
// ---------------------------------------------------------------------------

export interface CurvilinearSpringOptions {
  springStiffness?: number    // [0,1], default 0.4 — correction strength per iteration
  iterations?: number         // number of relaxation iterations, default 3
  minSpacingRatio?: number    // min spacing as fraction of target, default 0.3
}

/**
 * Compute initial curvilinear spacings on a reference polyline (Canny contour).
 * Returns normalized spacings (sum ≈ 1.0) for each consecutive pair in contourAnchorOrder.
 * Call once at frame 0 with the first Canny contour polyline.
 */
export function computeInitialCannySpacings(
  positions: Point2D[],
  contourAnchorOrder: number[],
  cannyPolyline: Point2D[]
): number[] {
  const n = contourAnchorOrder.length
  if (n < 3 || cannyPolyline.length < 3) return []

  const cumLen = computeCumulativeLengths(cannyPolyline)

  const sValues: number[] = []
  for (let k = 0; k < n; k++) {
    sValues.push(projectOntoPolyline(positions[contourAnchorOrder[k]], cannyPolyline, cumLen))
  }

  const spacings: number[] = []
  for (let k = 0; k < n; k++) {
    let d = sValues[(k + 1) % n] - sValues[k]
    if (d < 0) d += 1
    spacings.push(d)
  }

  return spacings
}

/**
 * Apply curvilinear spring repulsion along the Canny contour.
 *
 * After snap-to-contour places vertices on the Canny edge map, this function
 * ensures even spacing by treating consecutive contour anchors as connected
 * by springs whose rest length is the initial curvilinear spacing.
 *
 * Algorithm:
 * 1. Project contour anchors onto the ordered Canny polyline → curvilinear s_i
 * 2. Enforce monotonic ordering of s values
 * 3. Iteratively relax springs: for each consecutive pair, apply force
 *    proportional to (currentSpacing - targetSpacing)
 * 4. Enforce minimum spacing
 * 5. Reconstruct 2D positions on the Canny polyline
 */
export function applyCurvilinearSpringOnCanny(
  positions: Point2D[],
  contourAnchorOrder: number[],
  cannyPolyline: Point2D[],
  initialCannySpacings: number[],
  options?: CurvilinearSpringOptions
): Point2D[] {
  const n = contourAnchorOrder.length
  if (n < 3 || cannyPolyline.length < 3) return positions.map(p => ({ ...p }))
  if (initialCannySpacings.length !== n) return positions.map(p => ({ ...p }))

  const stiffness = options?.springStiffness ?? 0.4
  const iterations = options?.iterations ?? 3
  const minSpacingRatio = options?.minSpacingRatio ?? 0.3

  const corrected = positions.map(p => ({ ...p }))

  // Build cumulative lengths of the Canny polyline
  const cumLen = computeCumulativeLengths(cannyPolyline)

  // Step 1: Project contour anchors onto Canny polyline → curvilinear coordinates
  let sValues: number[] = []
  for (let k = 0; k < n; k++) {
    sValues.push(projectOntoPolyline(
      positions[contourAnchorOrder[k]], cannyPolyline, cumLen
    ))
  }

  // Step 2: Enforce monotonic ordering
  for (let k = 1; k < n; k++) {
    let diff = sValues[k] - sValues[k - 1]
    if (diff < -0.5) diff += 1
    if (diff < 0) {
      sValues[k] = sValues[k - 1] + 1e-6
    }
  }

  // Step 3: Iterative spring relaxation
  for (let iter = 0; iter < iterations; iter++) {
    // Accumulate forces on each vertex
    const forces = new Array(n).fill(0)

    for (let k = 0; k < n; k++) {
      const nextK = (k + 1) % n
      let currentSpacing = sValues[nextK] - sValues[k]
      if (currentSpacing < 0) currentSpacing += 1

      const targetSpacing = initialCannySpacings[k]
      const error = targetSpacing - currentSpacing

      // Spring force: positive error means pair is too close, push apart
      const force = error * stiffness
      forces[k] -= force * 0.5
      forces[nextK] += force * 0.5
    }

    // Apply forces
    for (let k = 0; k < n; k++) {
      sValues[k] += forces[k]
      // Wrap to [0,1)
      sValues[k] = ((sValues[k] % 1) + 1) % 1
    }
  }

  // Step 4: Enforce minimum spacing
  for (let k = 0; k < n; k++) {
    const nextK = (k + 1) % n
    let spacing = sValues[nextK] - sValues[k]
    if (spacing < 0) spacing += 1

    const dMin = initialCannySpacings[k] * minSpacingRatio
    if (spacing < dMin && dMin > 0) {
      const deficit = dMin - spacing
      sValues[k] = ((sValues[k] - deficit * 0.5) % 1 + 1) % 1
      sValues[nextK] = ((sValues[nextK] + deficit * 0.5) % 1 + 1) % 1
    }
  }

  // Step 5: Reconstruct 2D positions on the Canny polyline
  for (let k = 0; k < n; k++) {
    corrected[contourAnchorOrder[k]] = pointOnPolyline(sValues[k], cannyPolyline, cumLen)
  }

  return corrected
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}
