/**
 * ARAP 1D sur contour fermé avec cibles douces (LBS).
 *
 * Pour un contour ordonné en boucle, on minimise
 *   E = Σ_i Σ_{j∈{i±1}} ‖(p_j − p_i) − R_i (p_j^rest − p_i^rest)‖²
 *     + λ · Σ_i ‖p_i − t_i‖²
 *
 * Alternance phase locale (R_i = rotation rigide par décomposition polaire 2×2
 * sur la covariance des arêtes incidentes) et phase globale (linéaire, Cholesky
 * sur M = L + λI où L est le Laplacien graphe de la boucle, deg 2 partout).
 *
 * La matrice M est pré-factorisée une fois pour une topologie donnée
 * (`precomputeContourArap`), puis appliquée à chaque frame
 * (`solveContourArapFrame`).
 */

import type { Point2D } from '../types/project'

export interface ContourArapSystem {
  n: number
  restPositions: Point2D[]
  /** Cholesky lower-triangular factor de M = L + λI, row-major. */
  cholL: Float64Array
  lambda: number
}

// ─── Dense Cholesky (petit n, ≤ 200) ───────────────────────────────────

function choleskyFactor(A: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * n + j]
      for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k]
      if (i === j) {
        if (sum <= 0) sum = 1e-10
        L[i * n + j] = Math.sqrt(sum)
      } else {
        L[i * n + j] = sum / L[j * n + j]
      }
    }
  }
  return L
}

function choleskySolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]
    y[i] = s / L[i * n + i]
  }
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]
    x[i] = s / L[i * n + i]
  }
  return x
}

// ─── 2×2 rotation la plus proche (polaire) ─────────────────────────────

function closestRotation2x2(a: number, b: number, c: number, d: number):
  [number, number, number, number]
{
  // S = [[a,b],[c,d]] → R = rotation par angle θ tel que (cosθ, sinθ) = (a+d, c-b) normalisé
  const cs = a + d
  const sn = c - b
  const r = Math.hypot(cs, sn)
  if (r < 1e-12) return [1, 0, 0, 1]
  const co = cs / r, si = sn / r
  return [co, -si, si, co]
}

// ─── API ───────────────────────────────────────────────────────────────

/**
 * Pré-calcul de la factorisation Cholesky de M = L + λI pour un contour fermé
 * de longueur n. L est le Laplacien graphe de la boucle (deg 2, voisins ±1 mod n).
 *
 * @param restPositions positions de repos du contour (boucle fermée)
 * @param lambda force d'attache aux cibles douces (≥ 0). λ=0 → ARAP pur (sous-déterminé,
 *               à éviter ici). λ ≈ 1 = équilibré. λ grand = colle au LBS.
 */
export function precomputeContourArap(
  restPositions: Point2D[],
  lambda: number,
): ContourArapSystem {
  const n = restPositions.length
  if (n < 3) throw new Error('contour ARAP : au moins 3 vertices requis')
  if (lambda <= 0) throw new Error('contour ARAP : lambda > 0 requis (système sinon singulier)')

  // M = L + λI, L Laplacien circulant : diag=2, off=-1 sur i±1 mod n.
  const M = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    M[i * n + i] = 2 + lambda
    const ip = (i + 1) % n
    const im = (i - 1 + n) % n
    M[i * n + ip] = -1
    M[i * n + im] = -1
  }
  // Symétrique → on factorise sur la partie triangulaire inférieure.
  const cholL = choleskyFactor(M, n)

  return { n, restPositions: restPositions.map(p => ({ ...p })), cholL, lambda }
}

/**
 * Résout 1 frame de l'ARAP 1D contour, en partant des positions cibles LBS.
 *
 * @param system pré-factorisation
 * @param targets positions LBS du contour (= cibles douces, attaches λ)
 * @param iterations nombre d'itérations local/global (2-4 typique)
 * @returns nouvelles positions du contour
 */
export function solveContourArapFrame(
  system: ContourArapSystem,
  targets: Point2D[],
  iterations: number,
): Point2D[] {
  const { n, restPositions, cholL, lambda } = system
  if (targets.length !== n) throw new Error('contour ARAP : longueur targets mismatch')

  // Initialisation = positions LBS
  let pX = new Float64Array(n)
  let pY = new Float64Array(n)
  for (let i = 0; i < n; i++) { pX[i] = targets[i].x; pY[i] = targets[i].y }

  // Rotations par vertex
  const cosR = new Float64Array(n)
  const sinR = new Float64Array(n)

  const iters = Math.max(1, iterations)
  for (let it = 0; it < iters; it++) {
    // ── Phase locale : R_i depuis covariance 2×2 sur arêtes incidentes ──
    for (let i = 0; i < n; i++) {
      const ip = (i + 1) % n, im = (i - 1 + n) % n
      // S_i = Σ_{j∈{i±1}} (p_j − p_i) (p_j^rest − p_i^rest)^T
      const dx1 = pX[ip] - pX[i], dy1 = pY[ip] - pY[i]
      const rx1 = restPositions[ip].x - restPositions[i].x
      const ry1 = restPositions[ip].y - restPositions[i].y
      const dx2 = pX[im] - pX[i], dy2 = pY[im] - pY[i]
      const rx2 = restPositions[im].x - restPositions[i].x
      const ry2 = restPositions[im].y - restPositions[i].y
      const a = dx1 * rx1 + dx2 * rx2
      const b = dx1 * ry1 + dx2 * ry2
      const c = dy1 * rx1 + dy2 * rx2
      const d = dy1 * ry1 + dy2 * ry2
      const [r00, r01, r10, r11] = closestRotation2x2(a, b, c, d)
      cosR[i] = r00
      sinR[i] = r10
      // r01 = -sinR[i], r11 = cosR[i] (rotation 2D)
      void r01; void r11
    }

    // ── Phase globale : M · p = b avec
    //   b_i = (1/2) Σ_{j∈{i±1}} (R_i + R_j) · (p_i^rest − p_j^rest) + λ · t_i ──
    const bX = new Float64Array(n)
    const bY = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const ip = (i + 1) % n, im = (i - 1 + n) % n
      // arête i↔ip
      const eX1 = restPositions[i].x - restPositions[ip].x
      const eY1 = restPositions[i].y - restPositions[ip].y
      const c1 = cosR[i] + cosR[ip], s1 = sinR[i] + sinR[ip]
      const rx1 = 0.5 * (c1 * eX1 - s1 * eY1)
      const ry1 = 0.5 * (s1 * eX1 + c1 * eY1)
      // arête i↔im
      const eX2 = restPositions[i].x - restPositions[im].x
      const eY2 = restPositions[i].y - restPositions[im].y
      const c2 = cosR[i] + cosR[im], s2 = sinR[i] + sinR[im]
      const rx2 = 0.5 * (c2 * eX2 - s2 * eY2)
      const ry2 = 0.5 * (s2 * eX2 + c2 * eY2)
      bX[i] = rx1 + rx2 + lambda * targets[i].x
      bY[i] = ry1 + ry2 + lambda * targets[i].y
    }

    const newX = choleskySolve(cholL, n, bX)
    const newY = choleskySolve(cholL, n, bY)
    pX = newX
    pY = newY
  }

  const out: Point2D[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = { x: pX[i], y: pY[i] }
  return out
}
