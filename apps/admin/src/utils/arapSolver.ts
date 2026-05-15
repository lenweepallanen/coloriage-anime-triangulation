/**
 * ARAP (As-Rigid-As-Possible) 2D mesh deformation solver.
 *
 * Given a triangulated mesh at rest pose (frame 0) with some pinned vertices
 * whose positions are known at every frame, computes optimal positions for
 * free (internal) vertices that minimize local rigidity distortion.
 */

import type { Point2D } from '../types/project'

// ─── Types ───────────────────────────────────────────────────────────

interface EdgeData {
  i: number
  j: number
  wij: number // cotangent weight
  eix: number // rest edge vector (pi - pj).x
  eiy: number // rest edge vector (pi - pj).y
}

export interface ARAPSystem {
  nAll: number
  nFree: number
  pinnedIndices: number[]
  freeIndices: number[]
  globalToFree: Int32Array  // global index → free index (-1 if pinned)
  globalToPinned: Int32Array // global index → pinned index (-1 if free)
  edges: EdgeData[]
  neighbors: number[][]     // adjacency list
  // Cholesky factor of L_ff
  cholL: Float64Array[]     // dense lower triangular (nFree × nFree)
  restX: Float64Array
  restY: Float64Array
  // Per-vertex: list of { neighbor, weight, rest edge }
  vertexEdges: { j: number; wij: number; eix: number; eiy: number }[][]
  // L_ff dense (for RHS pinned contribution)
  Lff: Float64Array  // nFree × nFree row-major
  Lfp: Float64Array  // nFree × nPinned row-major
}

// ─── Cotangent weights ───────────────────────────────────────────────

function computeCotanWeights(
  points: Point2D[],
  triangles: [number, number, number][]
): Map<string, number> {
  const weights = new Map<string, number>()

  const edgeKey = (i: number, j: number) =>
    i < j ? `${i},${j}` : `${j},${i}`

  for (const [a, b, c] of triangles) {
    const verts = [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ] as const

    for (const [vi, vj, vk] of verts) {
      // Cotangent of angle at vk for edge (vi, vj)
      const eki_x = points[vi].x - points[vk].x
      const eki_y = points[vi].y - points[vk].y
      const ekj_x = points[vj].x - points[vk].x
      const ekj_y = points[vj].y - points[vk].y

      const dot = eki_x * ekj_x + eki_y * ekj_y
      const cross = Math.abs(eki_x * ekj_y - eki_y * ekj_x)
      // cot = dot / |cross|, clamped for stability
      const cot = cross < 1e-10 ? 10 : Math.max(-10, Math.min(10, dot / cross))

      const key = edgeKey(vi, vj)
      weights.set(key, (weights.get(key) ?? 0) + 0.5 * cot)
    }
  }

  // Clamp final weights to small positive value for positive-definiteness
  for (const [key, w] of weights) {
    if (w < 0.001) weights.set(key, 0.001)
  }

  return weights
}

// ─── Dense Cholesky factorization ────────────────────────────────────

function choleskyFactor(A: Float64Array, n: number): Float64Array {
  // L stored row-major, n×n lower triangular
  const L = new Float64Array(n * n)

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j]
      for (let k = 0; k < j; k++) {
        sum -= L[i * n + k] * L[j * n + k]
      }
      if (i === j) {
        if (sum <= 0) sum = 1e-10 // numerical safety
        L[i * n + j] = Math.sqrt(sum)
      } else {
        L[i * n + j] = sum / L[j * n + j]
      }
    }
  }

  return L
}

function choleskySolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  // Forward substitution: L * y = b
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = b[i]
    for (let k = 0; k < i; k++) {
      sum -= L[i * n + k] * y[k]
    }
    y[i] = sum / L[i * n + i]
  }

  // Backward substitution: L^T * x = y
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]
    for (let k = i + 1; k < n; k++) {
      sum -= L[k * n + i] * x[k]
    }
    x[i] = sum / L[i * n + i]
  }

  return x
}

// ─── 2×2 closest rotation ───────────────────────────────────────────

function closestRotation2x2(
  a: number, b: number, c: number, d: number
): [number, number, number, number] {
  // Given 2x2 matrix S = [[a,b],[c,d]], find closest rotation R
  // Using polar decomposition: S = R * P, R = S * (S^T S)^{-1/2}
  // For 2D, simpler: R = [cos θ, -sin θ; sin θ, cos θ]
  // where θ = atan2(c - b, a + d)
  const theta = Math.atan2(c - b, a + d)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return [cos, -sin, sin, cos]
}

// ─── Precompute ──────────────────────────────────────────────────────

export function precomputeARAP(
  allPoints: Point2D[],
  triangles: [number, number, number][],
  pinnedIndices: number[]
): ARAPSystem {
  const nAll = allPoints.length
  const pinnedSet = new Set(pinnedIndices)

  const freeIndices: number[] = []
  const globalToFree = new Int32Array(nAll).fill(-1)
  const globalToPinned = new Int32Array(nAll).fill(-1)

  for (let i = 0; i < nAll; i++) {
    if (pinnedSet.has(i)) {
      globalToPinned[i] = pinnedIndices.indexOf(i)
    } else {
      globalToFree[i] = freeIndices.length
      freeIndices.push(i)
    }
  }

  const nFree = freeIndices.length
  const nPinned = pinnedIndices.length

  // Cotangent weights
  const weightMap = computeCotanWeights(allPoints, triangles)

  // Build edges & adjacency
  const edges: EdgeData[] = []
  const neighbors: number[][] = Array.from({ length: nAll }, () => [])
  const vertexEdges: { j: number; wij: number; eix: number; eiy: number }[][] =
    Array.from({ length: nAll }, () => [])

  for (const [key, wij] of weightMap) {
    const [si, sj] = key.split(',').map(Number)
    const eix = allPoints[si].x - allPoints[sj].x
    const eiy = allPoints[si].y - allPoints[sj].y

    edges.push({ i: si, j: sj, wij, eix, eiy })
    neighbors[si].push(sj)
    neighbors[sj].push(si)

    vertexEdges[si].push({ j: sj, wij, eix, eiy })
    vertexEdges[sj].push({ j: si, wij, eix: -eix, eiy: -eiy })
  }

  // Build L_ff and L_fp dense matrices
  // L[i][j] = -wij for neighbors, L[i][i] = sum of wij
  const Lff = new Float64Array(nFree * nFree)
  const Lfp = new Float64Array(nFree * nPinned)

  for (const { i, j, wij } of edges) {
    const fi = globalToFree[i]
    const fj = globalToFree[j]
    const pi = globalToPinned[i]
    const pj = globalToPinned[j]

    if (fi >= 0 && fj >= 0) {
      // Both free
      Lff[fi * nFree + fj] -= wij
      Lff[fj * nFree + fi] -= wij
      Lff[fi * nFree + fi] += wij
      Lff[fj * nFree + fj] += wij
    } else if (fi >= 0 && pj >= 0) {
      // i free, j pinned
      Lfp[fi * nPinned + pj] -= wij
      Lff[fi * nFree + fi] += wij
    } else if (fj >= 0 && pi >= 0) {
      // j free, i pinned
      Lfp[fj * nPinned + pi] -= wij
      Lff[fj * nFree + fj] += wij
    }
    // both pinned: skip
  }

  // Cholesky factorization of L_ff
  const cholL = choleskyFactor(Lff, nFree)

  // Rest positions
  const restX = new Float64Array(nAll)
  const restY = new Float64Array(nAll)
  for (let i = 0; i < nAll; i++) {
    restX[i] = allPoints[i].x
    restY[i] = allPoints[i].y
  }

  return {
    nAll,
    nFree,
    pinnedIndices,
    freeIndices,
    globalToFree,
    globalToPinned,
    edges,
    neighbors,
    cholL: [cholL], // wrap in array for the interface
    restX,
    restY,
    vertexEdges,
    Lff,
    Lfp,
  }
}

// ─── Per-frame ARAP solve ────────────────────────────────────────────

export function solveARAP(
  sys: ARAPSystem,
  pinnedPositions: Point2D[],
  prevFreePositions?: Point2D[],
  nIterations = 3
): Point2D[] {
  const { nAll, nFree, freeIndices, pinnedIndices,
          vertexEdges, Lfp, restX, restY } = sys
  const cholL = sys.cholL[0]
  const nPinned = pinnedIndices.length

  if (nFree === 0) {
    // All points are pinned
    const result: Point2D[] = new Array(nAll)
    for (let k = 0; k < nPinned; k++) {
      result[pinnedIndices[k]] = pinnedPositions[k]
    }
    return result
  }

  // Current positions (mutable)
  const curX = new Float64Array(nAll)
  const curY = new Float64Array(nAll)

  // Set pinned positions
  for (let k = 0; k < nPinned; k++) {
    const gi = pinnedIndices[k]
    curX[gi] = pinnedPositions[k].x
    curY[gi] = pinnedPositions[k].y
  }

  // Initialize free positions (warm start or rest)
  if (prevFreePositions) {
    for (let k = 0; k < nFree; k++) {
      curX[freeIndices[k]] = prevFreePositions[k].x
      curY[freeIndices[k]] = prevFreePositions[k].y
    }
  } else {
    for (let k = 0; k < nFree; k++) {
      curX[freeIndices[k]] = restX[freeIndices[k]]
      curY[freeIndices[k]] = restY[freeIndices[k]]
    }
  }

  // Pre-allocate pinned position flat array for RHS
  const pinnedX = new Float64Array(nPinned)
  const pinnedY = new Float64Array(nPinned)
  for (let k = 0; k < nPinned; k++) {
    pinnedX[k] = pinnedPositions[k].x
    pinnedY[k] = pinnedPositions[k].y
  }

  // ARAP iterations
  for (let iter = 0; iter < nIterations; iter++) {
    // ── Local step: compute per-vertex rotations ──
    // Store as flat array: rotations[i*4 + 0..3] = [r00, r01, r10, r11]
    const rotations = new Float64Array(nAll * 4)

    for (let i = 0; i < nAll; i++) {
      const vedges = vertexEdges[i]
      if (vedges.length === 0) {
        // Identity rotation
        rotations[i * 4] = 1
        rotations[i * 4 + 3] = 1
        continue
      }

      // Covariance matrix S = sum_j { wij * (p_i - p_j)_deformed * (p_i - p_j)_rest^T }
      let s00 = 0, s01 = 0, s10 = 0, s11 = 0

      for (const { j, wij, eix, eiy } of vedges) {
        // Deformed edge
        const dx = curX[i] - curX[j]
        const dy = curY[i] - curY[j]
        // Rest edge: eix, eiy

        s00 += wij * dx * eix
        s01 += wij * dx * eiy
        s10 += wij * dy * eix
        s11 += wij * dy * eiy
      }

      const [r00, r01, r10, r11] = closestRotation2x2(s00, s01, s10, s11)
      rotations[i * 4] = r00
      rotations[i * 4 + 1] = r01
      rotations[i * 4 + 2] = r10
      rotations[i * 4 + 3] = r11
    }

    // ── Global step: build RHS and solve ──
    const rhsX = new Float64Array(nFree)
    const rhsY = new Float64Array(nFree)

    // ARAP right-hand side: for each free vertex i,
    // rhs_i = sum_j { (wij / 2) * (R_i + R_j) * e_ij_rest }
    for (let fi = 0; fi < nFree; fi++) {
      const gi = freeIndices[fi]
      const vedges = vertexEdges[gi]
      let bx = 0, by = 0

      for (const { j, wij, eix, eiy } of vedges) {
        const ri0 = rotations[gi * 4], ri1 = rotations[gi * 4 + 1]
        const ri2 = rotations[gi * 4 + 2], ri3 = rotations[gi * 4 + 3]
        const rj0 = rotations[j * 4], rj1 = rotations[j * 4 + 1]
        const rj2 = rotations[j * 4 + 2], rj3 = rotations[j * 4 + 3]

        // (R_i + R_j) * e_rest
        const rx = (ri0 + rj0) * eix + (ri1 + rj1) * eiy
        const ry = (ri2 + rj2) * eix + (ri3 + rj3) * eiy

        bx += (wij / 2) * rx
        by += (wij / 2) * ry
      }

      rhsX[fi] = bx
      rhsY[fi] = by
    }

    // Subtract L_fp * pinned contributions
    for (let fi = 0; fi < nFree; fi++) {
      for (let pj = 0; pj < nPinned; pj++) {
        const lfp = Lfp[fi * nPinned + pj]
        if (lfp !== 0) {
          rhsX[fi] -= lfp * pinnedX[pj]
          rhsY[fi] -= lfp * pinnedY[pj]
        }
      }
    }

    // Solve L_ff * x = rhs via Cholesky
    const solX = choleskySolve(cholL, nFree, rhsX)
    const solY = choleskySolve(cholL, nFree, rhsY)

    // Update free positions
    for (let k = 0; k < nFree; k++) {
      curX[freeIndices[k]] = solX[k]
      curY[freeIndices[k]] = solY[k]
    }
  }

  // Build output
  const result: Point2D[] = new Array(nAll)
  for (let i = 0; i < nAll; i++) {
    result[i] = { x: curX[i], y: curY[i] }
  }
  return result
}

// ─── Batch solve ─────────────────────────────────────────────────────

export function batchSolveARAP(
  sys: ARAPSystem,
  allPinnedFrames: Point2D[][],
  nIterations = 3,
  onProgress?: (frame: number, total: number) => void
): Point2D[][] {
  const totalFrames = allPinnedFrames.length
  const results: Point2D[][] = new Array(totalFrames)

  let prevFree: Point2D[] | undefined

  for (let f = 0; f < totalFrames; f++) {
    const allPoints = solveARAP(sys, allPinnedFrames[f], prevFree, nIterations)
    results[f] = allPoints

    // Extract free positions for warm start
    prevFree = sys.freeIndices.map(gi => allPoints[gi])

    if (onProgress && f % 10 === 0) {
      onProgress(f, totalFrames)
    }
  }

  return results
}
