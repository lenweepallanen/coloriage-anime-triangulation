/**
 * ARAP (As-Rigid-As-Possible) 2D mesh deformation solver.
 *
 * Deforms a canonical mesh (frame 0) to match constrained vertex positions (anchors)
 * while preserving local rigidity. Uses cotangent-weighted Laplacian and
 * dense Cholesky factorization.
 */

import type { Point2D } from '../types/project'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ARAPPrecomputation {
  nVertices: number
  freeIndices: number[]
  constrainedIndices: number[]
  freeToLocal: Map<number, number>   // global index → index in reduced system
  constrainedSet: Set<number>
  choleskyL: Float64Array[]          // lower-triangular factor of L_ff
  nFree: number
  // Per-edge cotangent weight
  edgeWeights: Map<string, number>
  // Adjacency: vertex → set of neighbor indices
  adjacency: Map<number, Set<number>>
  // Rest-pose edge vectors (i→j)
  restEdges: Map<string, Point2D>
  // Rest-pose vertex positions
  restPositions: Point2D[]
  // Pre-built RHS contributions from constrained neighbors (constant across frames for matrix structure)
  // For the global step, we need w_ic for each free vertex i with constrained neighbor c
  freeConstrainedWeights: Map<number, { c: number; w: number }[]>
}

function edgeKey(i: number, j: number): string {
  return i < j ? `${i}_${j}` : `${j}_${i}`
}

// ─── Cotangent Weights ──────────────────────────────────────────────────────

function computeCotangentWeights(
  vertices: Point2D[],
  triangles: [number, number, number][]
): { edgeWeights: Map<string, number>; adjacency: Map<number, Set<number>> } {
  const edgeWeights = new Map<string, number>()
  const adjacency = new Map<number, Set<number>>()

  const ensureAdj = (a: number, b: number) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    if (!adjacency.has(b)) adjacency.set(b, new Set())
    adjacency.get(a)!.add(b)
    adjacency.get(b)!.add(a)
  }

  for (const [a, b, c] of triangles) {
    const verts = [
      [a, b, c],  // angle at c, opposite edge (a,b)
      [b, c, a],  // angle at a, opposite edge (b,c)
      [a, c, b],  // angle at b, opposite edge (a,c)
    ] as const

    for (const [ei, ej, opposite] of verts) {
      const po = vertices[opposite]
      const pi = vertices[ei]
      const pj = vertices[ej]

      // Vectors from opposite vertex to edge endpoints
      const eoiX = pi.x - po.x
      const eoiY = pi.y - po.y
      const eojX = pj.x - po.x
      const eojY = pj.y - po.y

      const dot = eoiX * eojX + eoiY * eojY
      const cross = Math.abs(eoiX * eojY - eoiY * eojX)

      // cot(angle) = cos/sin = dot/|cross|
      // Clamp to avoid degenerate triangles
      const cot = cross < 1e-10 ? 100 : Math.min(Math.max(dot / cross, -100), 100)
      const w = cot / 2

      const key = edgeKey(ei, ej)
      edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + w)
      ensureAdj(ei, ej)
    }
  }

  // Clamp final weights to be non-negative (ensures positive-definite Laplacian)
  for (const [key, w] of edgeWeights) {
    if (w < 1e-8) edgeWeights.set(key, 1e-8)
  }

  return { edgeWeights, adjacency }
}

// ─── Dense Cholesky ─────────────────────────────────────────────────────────

function choleskyFactor(A: Float64Array[]): Float64Array[] {
  const n = A.length
  const L: Float64Array[] = new Array(n)
  for (let i = 0; i < n; i++) L[i] = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k]
      }
      if (i === j) {
        const diag = A[i][i] - sum
        if (diag <= 0) {
          // Matrix not positive-definite; add regularization
          L[i][i] = Math.sqrt(Math.max(diag, 1e-10))
        } else {
          L[i][i] = Math.sqrt(diag)
        }
      } else {
        L[i][j] = (A[i][j] - sum) / L[j][j]
      }
    }
  }
  return L
}

function choleskySolve(L: Float64Array[], b: Float64Array): Float64Array {
  const n = L.length
  // Forward substitution: L * y = b
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let k = 0; k < i; k++) sum += L[i][k] * y[k]
    y[i] = (b[i] - sum) / L[i][i]
  }
  // Back substitution: L^T * x = y
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0
    for (let k = i + 1; k < n; k++) sum += L[k][i] * x[k]
    x[i] = (y[i] - sum) / L[i][i]
  }
  return x
}

// ─── Precomputation ─────────────────────────────────────────────────────────

export function precomputeARAP(
  restVertices: Point2D[],
  triangles: [number, number, number][],
  constrainedIndices: number[]
): ARAPPrecomputation {
  const nVertices = restVertices.length
  const constrainedSet = new Set(constrainedIndices)

  // Free vertices = all vertices not constrained
  const freeIndices: number[] = []
  const freeToLocal = new Map<number, number>()
  for (let i = 0; i < nVertices; i++) {
    if (!constrainedSet.has(i)) {
      freeToLocal.set(i, freeIndices.length)
      freeIndices.push(i)
    }
  }
  const nFree = freeIndices.length

  // Cotangent weights
  const { edgeWeights, adjacency } = computeCotangentWeights(restVertices, triangles)

  // Rest-pose edge vectors
  const restEdges = new Map<string, Point2D>()
  for (const [key, _w] of edgeWeights) {
    const [si, sj] = key.split('_')
    const i = parseInt(si)
    const j = parseInt(sj)
    restEdges.set(`${i}_${j}`, {
      x: restVertices[j].x - restVertices[i].x,
      y: restVertices[j].y - restVertices[i].y,
    })
    restEdges.set(`${j}_${i}`, {
      x: restVertices[i].x - restVertices[j].x,
      y: restVertices[i].y - restVertices[j].y,
    })
  }

  // Pre-build free-constrained neighbor weights
  const freeConstrainedWeights = new Map<number, { c: number; w: number }[]>()
  for (const fi of freeIndices) {
    const neighbors = adjacency.get(fi)
    if (!neighbors) continue
    const cw: { c: number; w: number }[] = []
    for (const nj of neighbors) {
      if (constrainedSet.has(nj)) {
        const w = edgeWeights.get(edgeKey(fi, nj)) ?? 0
        if (w > 0) cw.push({ c: nj, w })
      }
    }
    if (cw.length > 0) freeConstrainedWeights.set(fi, cw)
  }

  // Build reduced Laplacian L_ff
  const Lff: Float64Array[] = new Array(nFree)
  for (let i = 0; i < nFree; i++) Lff[i] = new Float64Array(nFree)

  for (let li = 0; li < nFree; li++) {
    const gi = freeIndices[li]
    const neighbors = adjacency.get(gi)
    if (!neighbors) continue

    let diag = 0
    for (const nj of neighbors) {
      const w = edgeWeights.get(edgeKey(gi, nj)) ?? 0
      diag += w

      const lj = freeToLocal.get(nj)
      if (lj !== undefined) {
        // Both free
        Lff[li][lj] = -w
      }
      // If nj is constrained, it contributes to RHS, not L_ff
    }
    Lff[li][li] = diag
  }

  // Cholesky factorization
  const choleskyL = choleskyFactor(Lff)

  return {
    nVertices,
    freeIndices,
    constrainedIndices,
    freeToLocal,
    constrainedSet,
    choleskyL,
    nFree,
    edgeWeights,
    adjacency,
    restEdges,
    restPositions: restVertices.slice(),
    freeConstrainedWeights,
  }
}

// ─── Per-Frame Solve ────────────────────────────────────────────────────────

export function solveARAPFrame(
  precomp: ARAPPrecomputation,
  constrainedPositions: Point2D[],
  initialGuess?: Point2D[],
  iterations: number = 3
): Point2D[] {
  const {
    nVertices, freeIndices, constrainedIndices,
    choleskyL, nFree,
    edgeWeights, adjacency, restEdges, restPositions,
    freeConstrainedWeights,
  } = precomp

  // If no free vertices, just return constrained positions + rest for others
  if (nFree === 0) {
    const result: Point2D[] = new Array(nVertices)
    for (let ci = 0; ci < constrainedIndices.length; ci++) {
      result[constrainedIndices[ci]] = constrainedPositions[ci]
    }
    return result
  }

  // Initialize current positions
  const px = new Float64Array(nVertices)
  const py = new Float64Array(nVertices)

  if (initialGuess && initialGuess.length === nVertices) {
    for (let i = 0; i < nVertices; i++) {
      px[i] = initialGuess[i].x
      py[i] = initialGuess[i].y
    }
  } else {
    // Use rest positions as initial guess
    for (let i = 0; i < nVertices; i++) {
      px[i] = restPositions[i].x
      py[i] = restPositions[i].y
    }
  }

  // Pin constrained vertices
  for (let ci = 0; ci < constrainedIndices.length; ci++) {
    const gi = constrainedIndices[ci]
    px[gi] = constrainedPositions[ci].x
    py[gi] = constrainedPositions[ci].y
  }

  // Per-vertex rotation storage
  const rotCos = new Float64Array(nVertices)
  const rotSin = new Float64Array(nVertices)

  for (let iter = 0; iter < iterations; iter++) {
    // ── Local step: compute best-fit rotation per vertex ──
    for (let i = 0; i < nVertices; i++) {
      const neighbors = adjacency.get(i)
      if (!neighbors || neighbors.size === 0) {
        rotCos[i] = 1
        rotSin[i] = 0
        continue
      }

      // Covariance matrix S = sum_j w_ij * e_ij_rest * e_ij_deformed^T
      let s00 = 0, s01 = 0, s10 = 0, s11 = 0
      for (const j of neighbors) {
        const w = edgeWeights.get(edgeKey(i, j)) ?? 0
        const eRest = restEdges.get(`${i}_${j}`)
        if (!eRest) continue

        const edx = px[j] - px[i]
        const edy = py[j] - py[i]

        // S += w * [eRest.x, eRest.y]^T * [edx, edy]
        // = w * [[eRest.x*edx, eRest.x*edy], [eRest.y*edx, eRest.y*edy]]
        s00 += w * eRest.x * edx
        s01 += w * eRest.x * edy
        s10 += w * eRest.y * edx
        s11 += w * eRest.y * edy
      }

      // Extract rotation from S via analytic 2x2 SVD
      // R = V * U^T where S = U * Sigma * V^T
      // For closest rotation: theta = atan2(s10 - s01, s00 + s11)
      const theta = Math.atan2(s10 - s01, s00 + s11)
      rotCos[i] = Math.cos(theta)
      rotSin[i] = Math.sin(theta)
    }

    // ── Global step: solve for free vertex positions ──
    const bx = new Float64Array(nFree)
    const by = new Float64Array(nFree)

    for (let li = 0; li < nFree; li++) {
      const gi = freeIndices[li]
      const neighbors = adjacency.get(gi)
      if (!neighbors) continue

      let bxi = 0, byi = 0

      for (const j of neighbors) {
        const w = edgeWeights.get(edgeKey(gi, j)) ?? 0
        if (w === 0) continue

        const eRest = restEdges.get(`${gi}_${j}`)
        if (!eRest) continue

        // Rotated rest edge: (R_i + R_j) / 2 * e_ij_rest
        // b_i += w/2 * (R_i + R_j) * e_ij_rest
        const avgCos = (rotCos[gi] + rotCos[j]) / 2
        const avgSin = (rotSin[gi] + rotSin[j]) / 2

        const rx = avgCos * eRest.x - avgSin * eRest.y
        const ry = avgSin * eRest.x + avgCos * eRest.y

        bxi += w * rx
        byi += w * ry
      }

      // Add constrained neighbor contributions: w_ic * p_c
      const cws = freeConstrainedWeights.get(gi)
      if (cws) {
        for (const { c, w } of cws) {
          bxi += w * px[c]
          byi += w * py[c]
        }
      }

      bx[li] = bxi
      by[li] = byi
    }

    // Solve L_ff * x = bx, L_ff * y = by
    const solX = choleskySolve(choleskyL, bx)
    const solY = choleskySolve(choleskyL, by)

    // Update free vertex positions
    for (let li = 0; li < nFree; li++) {
      const gi = freeIndices[li]
      px[gi] = solX[li]
      py[gi] = solY[li]
    }
  }

  // Assemble result
  const result: Point2D[] = new Array(nVertices)
  for (let i = 0; i < nVertices; i++) {
    result[i] = { x: px[i], y: py[i] }
  }
  return result
}
