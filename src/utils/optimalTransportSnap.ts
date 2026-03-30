/**
 * Optimal Transport snap for contour anchor tracking.
 *
 * Replaces geometric snap by solving an assignment problem in (s, κ) space:
 * - s = normalized arc-length on the Canny contour
 * - κ = curvature at scale σ (CSS)
 *
 * Cost matrix: C(i,j) = (s_i - s_j)²/std(s)² + λ·(κ_i - κ_j)²/std(κ)²
 * with beam pre-selection and monotonicity check.
 */

import type { Point2D } from '../types/project'
import { orderContourPixels, computeArcLengths } from './curvilinearContour'

// ─── Types ───────────────────────────────────────────────────────────

export interface OTSnapParams {
  lambda: number   // weight of curvature term (default 1.0)
  beam: number     // beam width per anchor (default 5)
  sigma: number    // Gaussian scale for curvature (default 16)
  numSamples: number // resample contour to N points (default 300)
}

export const DEFAULT_OT_PARAMS: OTSnapParams = {
  lambda: 1.0,
  beam: 5,
  sigma: 16,
  numSamples: 300,
}

export interface OTSnapResult {
  snapped: Point2D[]
  success: boolean    // false if monotonicity violated → used fallback
}

// ─── Gaussian derivative kernels ─────────────────────────────────────

function gaussianDerivativeKernel(sigma: number, order: 0 | 1 | 2): number[] {
  const halfK = Math.ceil(4 * sigma)
  const size = halfK * 2 + 1
  const kernel = new Array<number>(size)
  const sigma2 = sigma * sigma
  const sigma4 = sigma2 * sigma2

  let sum = 0
  for (let i = 0; i < size; i++) {
    const x = i - halfK
    const g = Math.exp(-(x * x) / (2 * sigma2))
    if (order === 0) {
      kernel[i] = g
      sum += g
    } else if (order === 1) {
      kernel[i] = (-x / sigma2) * g
    } else {
      kernel[i] = ((x * x - sigma2) / sigma4) * g
    }
  }
  if (order === 0) {
    for (let i = 0; i < size; i++) kernel[i] /= sum
  }
  return kernel
}

function convolveWrapped(signal: number[], kernel: number[]): number[] {
  const N = signal.length
  const halfK = (kernel.length - 1) / 2
  const result = new Array<number>(N)
  for (let i = 0; i < N; i++) {
    let val = 0
    for (let j = 0; j < kernel.length; j++) {
      const idx = ((i - halfK + j) % N + N) % N
      val += signal[idx] * kernel[j]
    }
    result[i] = val
  }
  return result
}

// ─── Compute curvature on resampled contour ──────────────────────────

function computeCurvature(xs: number[], ys: number[], sigma: number): number[] {
  const effectiveSigma = Math.min(sigma, Math.max(1, Math.floor(xs.length / 8)))
  const g1 = gaussianDerivativeKernel(effectiveSigma, 1)
  const g2 = gaussianDerivativeKernel(effectiveSigma, 2)

  const xp = convolveWrapped(xs, g1)
  const yp = convolveWrapped(ys, g1)
  const xpp = convolveWrapped(xs, g2)
  const ypp = convolveWrapped(ys, g2)

  const N = xs.length
  const kappa = new Array<number>(N)
  const EPS = 1e-10
  for (let i = 0; i < N; i++) {
    const denom = Math.pow(xp[i] * xp[i] + yp[i] * yp[i], 1.5)
    kappa[i] = denom > EPS ? (xp[i] * ypp[i] - yp[i] * xpp[i]) / denom : 0
  }
  return kappa
}

// ─── Resample contour uniformly by arc-length ────────────────────────

function resampleContour(
  orderedContour: Point2D[],
  arcLengths: number[],
  numSamples: number
): { points: Point2D[]; sNorm: number[] } {
  const N = orderedContour.length
  const totalLen = arcLengths[N - 1]
  if (totalLen < 1e-6 || N < 3) {
    return {
      points: new Array(numSamples).fill({ ...orderedContour[0] }),
      sNorm: Array.from({ length: numSamples }, (_, i) => i / numSamples),
    }
  }

  const points: Point2D[] = []
  const sNorm: number[] = []

  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples // [0, 1)
    const targetLen = t * totalLen
    sNorm.push(t)

    // Binary search for the segment
    let lo = 0, hi = N - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arcLengths[mid] < targetLen) lo = mid + 1
      else hi = mid
    }
    const idx = Math.max(0, lo - 1)
    const segLen = arcLengths[idx + 1] - arcLengths[idx]
    const frac = segLen > 1e-10 ? (targetLen - arcLengths[idx]) / segLen : 0
    const a = orderedContour[idx]
    const b = orderedContour[(idx + 1) % N]
    points.push({
      x: a.x + frac * (b.x - a.x),
      y: a.y + frac * (b.y - a.y),
    })
  }

  return { points, sNorm }
}

// ─── Hungarian algorithm (Jonker-Volgenant / simple O(n³)) ──────────

/**
 * Solve the assignment problem on a square cost matrix.
 * Returns col[row] — the column assigned to each row.
 * Uses the Hungarian algorithm (Kuhn-Munkres).
 */
function hungarianAssignment(cost: number[][]): number[] {
  const n = cost.length
  if (n === 0) return []
  if (n === 1) return [0]

  const INF = 1e18
  const u = new Array(n + 1).fill(0) // row potentials
  const v = new Array(n + 1).fill(0) // col potentials
  const p = new Array(n + 1).fill(0) // p[j] = row assigned to col j
  const way = new Array(n + 1).fill(0)

  for (let i = 1; i <= n; i++) {
    const minv = new Array(n + 1).fill(INF)
    const used = new Array(n + 1).fill(false)
    p[0] = i
    let j0 = 0

    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0

      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }

      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }

      j0 = j1
    } while (p[j0] !== 0)

    // Trace back
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }

  // Build result: col[row] (0-indexed)
  const result = new Array(n).fill(0)
  for (let j = 1; j <= n; j++) {
    if (p[j] > 0) result[p[j] - 1] = j - 1
  }
  return result
}

// ─── Project anchors onto contour → arc-length ──────────────────────

function projectAnchorsOntoContour(
  anchors: Point2D[],
  contourPoints: Point2D[],
  sNorm: number[]
): number[] {
  return anchors.map(anchor => {
    let bestDistSq = Infinity
    let bestIdx = 0
    for (let j = 0; j < contourPoints.length; j++) {
      const dx = anchor.x - contourPoints[j].x
      const dy = anchor.y - contourPoints[j].y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        bestIdx = j
      }
    }
    return sNorm[bestIdx]
  })
}

// ─── Standard deviation ──────────────────────────────────────────────

function std(values: number[]): number {
  if (values.length === 0) return 1
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) || 1
}

// ─── Main OT snap function ──────────────────────────────────────────

/**
 * Apply Optimal Transport snap to contour anchors.
 *
 * Algorithm:
 * 1. Order and resample Canny contour to N≈300 points
 * 2. Compute (s, κ) for each resampled point
 * 3. Project anchors onto resampled contour → anchor (s, κ)
 * 4. Build cost matrix with normalized s and κ
 * 5. Beam pre-selection: keep top-beam candidates per anchor
 * 6. Solve n×n assignment via Hungarian
 * 7. Check arc-length monotonicity; fallback if violated
 *
 * @param anchorPositions Current anchor positions (after LK tracking)
 * @param contourAnchorOrder Indices of contour anchors in the positions array
 * @param cannyContourPixels Raw Canny contour pixels for this frame
 * @param params OT parameters (lambda, beam, sigma, numSamples)
 * @param fallbackSnap Geometric snap function to use as fallback
 * @returns Snapped positions and success flag
 */
export function applyOTSnap(
  positions: Point2D[],
  contourAnchorOrder: number[],
  cannyContourPixels: Point2D[],
  params: OTSnapParams = DEFAULT_OT_PARAMS,
  fallbackSnap?: (positions: Point2D[], contourAnchorOrder: number[], cannyContour: Point2D[]) => Point2D[]
): OTSnapResult {
  const n = contourAnchorOrder.length
  if (n === 0 || cannyContourPixels.length < 10) {
    return { snapped: positions.map(p => ({ ...p })), success: false }
  }

  // 1. Order and resample contour
  const ordered = orderContourPixels(cannyContourPixels)
  const arcLens = computeArcLengths(ordered)
  const N = Math.min(params.numSamples, ordered.length)
  const { points: contourPts, sNorm } = resampleContour(ordered, arcLens, N)

  // 2. Compute curvature for resampled contour
  const xs = contourPts.map(p => p.x)
  const ys = contourPts.map(p => p.y)
  const kappa = computeCurvature(xs, ys, params.sigma)

  // 3. Project anchors onto contour → (s_anchor, κ_anchor)
  const anchorPoints = contourAnchorOrder.map(idx => positions[idx])
  const anchorS = projectAnchorsOntoContour(anchorPoints, contourPts, sNorm)
  const anchorKappa = anchorS.map((s) => {
    // Find nearest contour point to get curvature
    const idx = Math.round(s * N) % N
    return kappa[idx]
  })

  // 4. Normalize by std
  const allS = [...anchorS, ...sNorm]
  const allK = [...anchorKappa, ...kappa]
  const stdS = std(allS)
  const stdK = std(allK)
  const lambda = params.lambda

  // 5. Beam pre-selection: for each anchor, find top-beam candidates
  const beam = Math.min(params.beam, N)
  const beamIndices: number[][] = [] // beamIndices[anchorIdx] = [contour indices]

  for (let i = 0; i < n; i++) {
    const costs: { idx: number; cost: number }[] = []
    for (let j = 0; j < N; j++) {
      // Circular arc-length distance
      let ds = anchorS[i] - sNorm[j]
      if (ds > 0.5) ds -= 1
      if (ds < -0.5) ds += 1

      const dk = anchorKappa[i] - kappa[j]
      const cost = (ds / stdS) ** 2 + lambda * (dk / stdK) ** 2
      costs.push({ idx: j, cost })
    }
    costs.sort((a, b) => a.cost - b.cost)
    beamIndices.push(costs.slice(0, beam).map(c => c.idx))
  }

  // 6. Build reduced n×n cost matrix (each anchor picks from its beam)
  // We need to solve assignment on n anchors × (n columns from beam candidates)
  // Collect unique candidate columns
  const candidateSet = new Set<number>()
  for (const bi of beamIndices) {
    for (const idx of bi) candidateSet.add(idx)
  }
  const candidates = Array.from(candidateSet).sort((a, b) => a - b)

  // If fewer candidates than anchors, cannot solve — fallback
  if (candidates.length < n) {
    if (fallbackSnap) {
      return { snapped: fallbackSnap(positions, contourAnchorOrder, cannyContourPixels), success: false }
    }
    return { snapped: positions.map(p => ({ ...p })), success: false }
  }

  // Build square cost matrix of size max(n, candidates.length)
  // We want n rows (anchors) → pick n columns from candidates
  // Use n × candidates.length matrix, then pad to square
  const m = candidates.length
  const size = Math.max(n, m)
  const INF_COST = 1e12
  const costMatrix: number[][] = Array.from({ length: size }, () =>
    new Array(size).fill(INF_COST)
  )

  for (let i = 0; i < n; i++) {
    for (let jj = 0; jj < m; jj++) {
      const j = candidates[jj]
      let ds = anchorS[i] - sNorm[j]
      if (ds > 0.5) ds -= 1
      if (ds < -0.5) ds += 1
      const dk = anchorKappa[i] - kappa[j]
      costMatrix[i][jj] = (ds / stdS) ** 2 + lambda * (dk / stdK) ** 2
    }
  }
  // Dummy rows (if m > n) get zero cost to any column
  for (let i = n; i < size; i++) {
    for (let j = 0; j < size; j++) costMatrix[i][j] = 0
  }

  // 7. Solve assignment
  const assignment = hungarianAssignment(costMatrix)

  // Extract assigned contour indices for each anchor
  const assignedContourIdx = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const colIdx = assignment[i]
    if (colIdx < m) {
      assignedContourIdx[i] = candidates[colIdx]
    } else {
      // Assigned to a dummy column — fallback
      if (fallbackSnap) {
        return { snapped: fallbackSnap(positions, contourAnchorOrder, cannyContourPixels), success: false }
      }
      return { snapped: positions.map(p => ({ ...p })), success: false }
    }
  }

  // 8. Check monotonicity in arc-length
  const assignedS = assignedContourIdx.map(idx => sNorm[idx])
  let monotonic = true
  for (let i = 1; i < n; i++) {
    // Allow circular wrap: check that successive s values increase (mod 1)
    let diff = assignedS[i] - assignedS[i - 1]
    if (diff < -0.5) diff += 1
    if (diff < 0) {
      monotonic = false
      break
    }
  }

  if (!monotonic) {
    if (fallbackSnap) {
      return { snapped: fallbackSnap(positions, contourAnchorOrder, cannyContourPixels), success: false }
    }
    return { snapped: positions.map(p => ({ ...p })), success: false }
  }

  // 9. Build result: snap each anchor to its assigned contour point
  const snapped = positions.map(p => ({ ...p }))
  for (let i = 0; i < n; i++) {
    const contourIdx = assignedContourIdx[i]
    snapped[contourAnchorOrder[i]] = { ...contourPts[contourIdx] }
  }

  return { snapped, success: true }
}
