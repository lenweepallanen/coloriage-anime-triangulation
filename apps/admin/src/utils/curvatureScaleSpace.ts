/**
 * Curvature Scale Space (CSS) — pur TypeScript, zéro dépendance lourde.
 *
 * Fournit :
 * - Détection automatique des anchor points par courbure multi-échelle
 * - CSS snap pour le tracking (snap sur pic de courbure plutôt que plus proche point XY)
 */

import type { Point2D } from '../types/project'
import { computeArcLengths, interpolateAtArcLength } from './curvilinearContour'

// ─── Types exportés ─────────────────────────────────────────────────

export interface CSSCandidate {
  arcLengthNorm: number  // position sur le contour [0, 1)
  position: Point2D      // position 2D sur le contour rééchantillonné
  score: number          // score de stabilité multi-échelle
}

interface CSSSnapResult {
  position: Point2D
  arcLengthNorm: number
  confidence: number       // 0-1
  usedFallback: boolean
}

export interface CurvatureSignature {
  kappaSign: number      // signe brut de κ au pic (+1/-1), invariant à l'orientation si comparé dans la même frame
  absKappa: number       // |κ| à l'enregistrement
  prominence: number     // prominence topographique
  localRank: number      // rang parmi les pics de la fenêtre (0 = plus fort)
  arcLengthNorm: number  // position arc-length de référence
}

// ─── Gaussian kernels ───────────────────────────────────────────────

/**
 * Génère un kernel gaussien discret 1D ou sa dérivée première/seconde.
 * Taille = ceil(4σ)×2 + 1.
 */
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

  // Normaliser le kernel d'ordre 0
  if (order === 0) {
    for (let i = 0; i < size; i++) kernel[i] /= sum
  }

  return kernel
}

// ─── Convolution 1D wrappée ─────────────────────────────────────────

/**
 * Convolve un signal périodique (contour fermé) avec un kernel.
 * Indexation modulaire pour gérer le wrap-around.
 */
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

// ─── Rééchantillonnage arc-length uniforme ──────────────────────────

/**
 * Rééchantillonne un chemin ordonné en N points uniformément espacés en arc-length.
 */
function reparameterizeByArcLength(
  path: Point2D[],
  numSamples: number
): { points: Point2D[]; totalLength: number } {
  const arcLengths = computeArcLengths(path)
  const totalLength = arcLengths[arcLengths.length - 1]

  if (totalLength < 1e-6) {
    return {
      points: new Array(numSamples).fill({ ...path[0] }),
      totalLength: 0,
    }
  }

  const points: Point2D[] = []
  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples  // [0, 1) pour contour fermé
    points.push(interpolateAtArcLength(path, arcLengths, t))
  }

  return { points, totalLength }
}

// ─── Courbure à une échelle ─────────────────────────────────────────

/**
 * Calcule la courbure κ(s, σ) sur un contour uniformément échantillonné.
 * κ = (x'·y'' - y'·x'') / (x'² + y'²)^(3/2)
 */
function computeCurvature(xs: number[], ys: number[], sigma: number): number[] {
  const g1 = gaussianDerivativeKernel(sigma, 1)
  const g2 = gaussianDerivativeKernel(sigma, 2)

  const xPrime = convolveWrapped(xs, g1)
  const yPrime = convolveWrapped(ys, g1)
  const xDoublePrime = convolveWrapped(xs, g2)
  const yDoublePrime = convolveWrapped(ys, g2)

  const N = xs.length
  const kappa = new Array<number>(N)
  const EPS = 1e-10

  for (let i = 0; i < N; i++) {
    const xp = xPrime[i]
    const yp = yPrime[i]
    const xpp = xDoublePrime[i]
    const ypp = yDoublePrime[i]
    const denom = Math.pow(xp * xp + yp * yp, 1.5)
    kappa[i] = denom > EPS ? (xp * ypp - yp * xpp) / denom : 0
  }

  return kappa
}

// ─── Détection extrema locaux ───────────────────────────────────────

interface CurvaturePeak {
  index: number
  arcLengthNorm: number  // [0, 1)
  absKappa: number
  prominence: number
  isConvex: boolean       // true = convex (outward bump), false = concave (inward notch)
}

/**
 * Détermine l'orientation du contour (CW/CCW) via l'aire signée du polygone.
 * Retourne +1 si CCW (aire positive), -1 si CW.
 */
function contourOrientation(xs: number[], ys: number[]): number {
  const N = xs.length
  let signedArea = 0
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    signedArea += xs[i] * ys[j] - xs[j] * ys[i]
  }
  return signedArea >= 0 ? 1 : -1
}

/**
 * Trouve les maxima locaux de |κ| avec wrap-around.
 * Calcule la prominence topographique de chaque pic.
 * Tague chaque pic comme convexe ou concave via le signe de κ et l'orientation du contour.
 */
function findCurvatureExtrema(kappa: number[], minProminence: number, orientation: number): CurvaturePeak[] {
  const N = kappa.length
  if (N < 3) return []

  const absK = kappa.map(Math.abs)

  // Trouver les maxima locaux de |κ| (avec wrap)
  const peaks: { index: number; value: number }[] = []
  for (let i = 0; i < N; i++) {
    const prev = absK[(i - 1 + N) % N]
    const curr = absK[i]
    const next = absK[(i + 1) % N]
    if (curr > prev && curr > next) {
      peaks.push({ index: i, value: curr })
    }
  }

  if (peaks.length === 0) return []

  // Calculer la prominence de chaque pic
  const result: CurvaturePeak[] = []

  for (const peak of peaks) {
    let leftMin = peak.value
    let rightMin = peak.value

    for (let steps = 1; steps < N; steps++) {
      const idx = (peak.index - steps + N) % N
      leftMin = Math.min(leftMin, absK[idx])
      if (absK[idx] > peak.value) break
    }

    for (let steps = 1; steps < N; steps++) {
      const idx = (peak.index + steps) % N
      rightMin = Math.min(rightMin, absK[idx])
      if (absK[idx] > peak.value) break
    }

    const prominence = peak.value - Math.max(leftMin, rightMin)

    if (prominence >= minProminence) {
      // Convexe si κ et orientation ont le même signe (pointe vers l'extérieur)
      const isConvex = (kappa[peak.index] * orientation) > 0

      result.push({
        index: peak.index,
        arcLengthNorm: peak.index / N,
        absKappa: peak.value,
        prominence,
        isConvex,
      })
    }
  }

  result.sort((a, b) => b.absKappa - a.absKappa)
  return result
}

// ─── Détection simplifiée par courbure (single-scale) ───────────────

/**
 * Détecte les N points de plus forte courbure |κ| sur un contour ordonné.
 *
 * Algorithme :
 * 1. Rééchantillonne à N points uniformes
 * 2. Calcule κ à une seule échelle σ
 * 3. Trouve les maxima locaux de |κ|
 * 4. Classe par |κ| décroissant
 * 5. NMS en arc-length circulaire
 * 6. Retourne les top numPoints candidats
 */
export function detectCurvatureExtrema(
  path: Point2D[],
  numPoints: number,
  sigma: number = 4
): CSSCandidate[] {
  if (path.length < 10) return []

  const N = Math.min(path.length, 1024)
  const { points } = reparameterizeByArcLength(path, N)

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)

  const orientation = contourOrientation(xs, ys)
  const kappa = computeCurvature(xs, ys, sigma)
  const peaks = findCurvatureExtrema(kappa, 0, orientation)

  if (peaks.length === 0) return []

  // NMS en arc-length circulaire (espacement min = moitié de l'espacement uniforme)
  const minArcSpacing = 1 / (numPoints * 2)
  const accepted: CSSCandidate[] = []
  for (const peak of peaks) {
    if (accepted.length >= numPoints) break

    let tooClose = false
    for (const acc of accepted) {
      let d = Math.abs(peak.arcLengthNorm - acc.arcLengthNorm)
      if (d > 0.5) d = 1 - d
      if (d < minArcSpacing) {
        tooClose = true
        break
      }
    }

    if (!tooClose) {
      accepted.push({
        arcLengthNorm: peak.arcLengthNorm,
        position: points[peak.index],
        score: peak.absKappa,
      })
    }
  }
  return accepted
}

/**
 * Détecte les extrema globaux de κ (maxima et minima de la courbure signée).
 * Contrairement à detectCurvatureExtrema qui utilise |κ|, cette fonction
 * trouve les vrais pics convexes (κ max) et concaves (κ min), en ignorant
 * les zones plates (points d'inflexion où κ ≈ 0).
 */
export function detectGlobalCurvatureExtrema(
  path: Point2D[],
  numPoints: number,
  sigma: number = 4
): CSSCandidate[] {
  if (path.length < 10) return []

  const N = Math.min(path.length, 1024)
  const { points } = reparameterizeByArcLength(path, N)

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)

  const kappa = computeCurvature(xs, ys, sigma)

  // Trouver les maxima locaux de κ (convexes) et les minima locaux de κ (concaves)
  const extrema: { index: number; value: number }[] = []
  for (let i = 0; i < N; i++) {
    const prev = kappa[(i - 1 + N) % N]
    const curr = kappa[i]
    const next = kappa[(i + 1) % N]
    // Maximum local de κ
    if (curr > prev && curr > next) {
      extrema.push({ index: i, value: Math.abs(curr) })
    }
    // Minimum local de κ
    if (curr < prev && curr < next) {
      extrema.push({ index: i, value: Math.abs(curr) })
    }
  }

  // Trier par |κ| décroissant → les vrais extrema en premier, le bruit en dernier
  extrema.sort((a, b) => b.value - a.value)

  // NMS en arc-length circulaire
  const minArcSpacing = 1 / (numPoints * 2)
  const accepted: CSSCandidate[] = []
  for (const ext of extrema) {
    if (accepted.length >= numPoints) break

    const arcNorm = ext.index / N
    let tooClose = false
    for (const acc of accepted) {
      let d = Math.abs(arcNorm - acc.arcLengthNorm)
      if (d > 0.5) d = 1 - d
      if (d < minArcSpacing) {
        tooClose = true
        break
      }
    }

    if (!tooClose) {
      accepted.push({
        arcLengthNorm: arcNorm,
        position: points[ext.index],
        score: ext.value,
      })
    }
  }
  return accepted
}

// ─── Extraction fenêtre locale (helper partagé) ─────────────────────

interface LocalWindow {
  xs: number[]
  ys: number[]
  globalIdx: number[]
  windowSize: number
  centerIdx: number
  totalLength: number
}

const MIN_KAPPA = 0.005

/**
 * Extrait une fenêtre locale autour d'une position arc-length sur le contour.
 * Partagé par cssSnapToContour, cssSnapToContourRegistered, et computeInitialSignatures.
 */
function extractLocalWindow(
  initialArcLength: number,
  orderedContour: Point2D[],
  arcLengths: number[],
  windowFraction: number
): LocalWindow | null {
  const N = orderedContour.length
  const totalLength = arcLengths[N - 1]

  if (N < 10 || totalLength < 1e-6) return null

  const windowIndices = Math.max(3, Math.round(windowFraction * N))
  const windowSize = windowIndices * 2 + 1
  const xs = new Array<number>(windowSize)
  const ys = new Array<number>(windowSize)
  const globalIdx = new Array<number>(windowSize)

  const centerArcTarget = initialArcLength * totalLength
  let centerIdx = 0
  let bestArcDist = Infinity
  for (let i = 0; i < N; i++) {
    const d = Math.abs(arcLengths[i] - centerArcTarget)
    const dWrap = Math.min(d, totalLength - d)
    if (dWrap < bestArcDist) {
      bestArcDist = dWrap
      centerIdx = i
    }
  }

  for (let j = 0; j < windowSize; j++) {
    const idx = ((centerIdx - windowIndices + j) % N + N) % N
    globalIdx[j] = idx
    xs[j] = orderedContour[idx].x
    ys[j] = orderedContour[idx].y
  }

  return { xs, ys, globalIdx, windowSize, centerIdx, totalLength }
}

/**
 * Trouve tous les pics locaux de |κ| dans un tableau de courbure.
 * Retourne les pics triés par |κ| décroissant, avec prominence et signe.
 */
function findLocalPeaks(kappa: number[]): { windowIdx: number; absKappa: number; kappaSign: number; prominence: number }[] {
  const N = kappa.length
  if (N < 3) return []

  const absK = kappa.map(Math.abs)
  const peaks: { windowIdx: number; absKappa: number; kappaSign: number }[] = []

  for (let i = 1; i < N - 1; i++) {
    if (absK[i] > absK[i - 1] && absK[i] > absK[i + 1] && absK[i] > MIN_KAPPA) {
      peaks.push({ windowIdx: i, absKappa: absK[i], kappaSign: kappa[i] >= 0 ? 1 : -1 })
    }
  }

  if (peaks.length === 0) return []

  // Calculer la prominence de chaque pic
  const result: { windowIdx: number; absKappa: number; kappaSign: number; prominence: number }[] = []
  for (const peak of peaks) {
    let leftMin = peak.absKappa
    let rightMin = peak.absKappa

    for (let steps = 1; steps < N; steps++) {
      const idx = peak.windowIdx - steps
      if (idx < 0) break
      leftMin = Math.min(leftMin, absK[idx])
      if (absK[idx] > peak.absKappa) break
    }

    for (let steps = 1; steps < N; steps++) {
      const idx = peak.windowIdx + steps
      if (idx >= N) break
      rightMin = Math.min(rightMin, absK[idx])
      if (absK[idx] > peak.absKappa) break
    }

    const prominence = peak.absKappa - Math.max(leftMin, rightMin)
    result.push({ ...peak, prominence })
  }

  result.sort((a, b) => b.absKappa - a.absKappa)
  return result
}

// ─── CSS snap local (pour tracking) ─────────────────────────────────

/**
 * Snap un anchor sur le pic de courbure le plus fort dans une fenêtre
 * arc-length autour de sa position initiale.
 * Version originale sans signature — prend le max |κ|.
 */
export function cssSnapToContour(
  currentPosition: Point2D,
  initialArcLength: number,
  orderedContour: Point2D[],
  arcLengths: number[],
  windowFraction: number = 0.08,
  sigma: number = 16
): CSSSnapResult {
  const win = extractLocalWindow(initialArcLength, orderedContour, arcLengths, windowFraction)
  if (!win) {
    return { position: currentPosition, arcLengthNorm: initialArcLength, confidence: 0, usedFallback: true }
  }

  const kappa = computeCurvatureLocal(win.xs, win.ys, sigma)
  const peaks = findLocalPeaks(kappa)

  if (peaks.length === 0) {
    return { position: currentPosition, arcLengthNorm: initialArcLength, confidence: 0, usedFallback: true }
  }

  // Prendre le pic le plus fort (comportement original)
  const best = peaks[0]
  const globalIdx = win.globalIdx[best.windowIdx]
  const snappedPos = orderedContour[globalIdx]
  const snappedArc = arcLengths[globalIdx] / win.totalLength
  const confidence = Math.min(1, best.absKappa / 0.05)

  return {
    position: { ...snappedPos },
    arcLengthNorm: snappedArc,
    confidence,
    usedFallback: false,
  }
}

// ─── CSS snap registered (avec signature de courbure) ───────────────

// Poids de la fonction de coût pour le matching de signature
const W_SIGN = 5.0       // pénalité si signe κ différent
const W_PROMINENCE = 1.0  // ratio de prominence (log-scale)
const W_KAPPA = 0.5       // différence relative de |κ|
const W_ARC = 2.0         // distance arc-length relative à la fenêtre
const MAX_COST = 8.0      // au-delà → fallback au max |κ|

/**
 * Snap un anchor sur le pic de courbure correspondant à sa signature enregistrée.
 * Trouve tous les pics dans la fenêtre et matche contre la signature.
 * Fallback au pic le plus fort si aucun bon match.
 */
export function cssSnapToContourRegistered(
  currentPosition: Point2D,
  initialArcLength: number,
  signature: CurvatureSignature,
  orderedContour: Point2D[],
  arcLengths: number[],
  windowFraction: number = 0.08,
  sigma: number = 16
): CSSSnapResult {
  const win = extractLocalWindow(initialArcLength, orderedContour, arcLengths, windowFraction)
  if (!win) {
    return { position: currentPosition, arcLengthNorm: initialArcLength, confidence: 0, usedFallback: true }
  }

  const kappa = computeCurvatureLocal(win.xs, win.ys, sigma)
  const peaks = findLocalPeaks(kappa)

  if (peaks.length === 0) {
    return { position: currentPosition, arcLengthNorm: initialArcLength, confidence: 0, usedFallback: true }
  }

  // 1 seul pic → pas d'ambiguïté
  if (peaks.length === 1) {
    const p = peaks[0]
    const globalIdx = win.globalIdx[p.windowIdx]
    return {
      position: { ...orderedContour[globalIdx] },
      arcLengthNorm: arcLengths[globalIdx] / win.totalLength,
      confidence: Math.min(1, p.absKappa / 0.05),
      usedFallback: false,
    }
  }

  // 2+ pics → scorer chaque candidat contre la signature
  let bestCost = Infinity
  let bestPeakIdx = 0

  for (let i = 0; i < peaks.length; i++) {
    const cand = peaks[i]

    // Pénalité de signe : 0 si même signe, W_SIGN sinon
    const signPenalty = (cand.kappaSign === signature.kappaSign) ? 0 : W_SIGN

    // Ratio de prominence (log-scale pour robustesse)
    const promRatio = Math.abs(Math.log(Math.max(cand.prominence, 1e-6) / Math.max(signature.prominence, 1e-6)))

    // Différence relative de |κ|
    const kappaDiff = Math.abs(cand.absKappa - signature.absKappa) / Math.max(signature.absKappa, 0.01)

    // Distance arc-length (normalisée par la taille de fenêtre)
    const candArc = arcLengths[win.globalIdx[cand.windowIdx]] / win.totalLength
    let arcDist = Math.abs(candArc - initialArcLength)
    if (arcDist > 0.5) arcDist = 1 - arcDist
    const arcDistNorm = arcDist / Math.max(windowFraction, 0.01)

    const cost = signPenalty + W_PROMINENCE * promRatio + W_KAPPA * kappaDiff + W_ARC * arcDistNorm

    if (cost < bestCost) {
      bestCost = cost
      bestPeakIdx = i
    }
  }

  // Si le coût est trop élevé, fallback au pic le plus fort (rang 0)
  const selectedPeak = bestCost <= MAX_COST ? peaks[bestPeakIdx] : peaks[0]
  const globalIdx = win.globalIdx[selectedPeak.windowIdx]

  return {
    position: { ...orderedContour[globalIdx] },
    arcLengthNorm: arcLengths[globalIdx] / win.totalLength,
    confidence: Math.min(1, selectedPeak.absKappa / 0.05),
    usedFallback: false,
  }
}

/**
 * Calcule la courbure sur une fenêtre locale (non wrappée aux bords).
 * Utilise convolveWrapped car la fenêtre est considérée comme périodique
 * (approximation raisonnable pour une fenêtre large).
 */
function computeCurvatureLocal(xs: number[], ys: number[], sigma: number): number[] {
  // Si la fenêtre est trop petite par rapport au kernel, réduire sigma
  const maxSigma = Math.floor(xs.length / 8)
  const effectiveSigma = Math.min(sigma, Math.max(1, maxSigma))

  return computeCurvature(xs, ys, effectiveSigma)
}

// ─── Helper : arc-lengths initiaux des anchors ──────────────────────

/**
 * Calcule l'abscisse curviligne normalisée de chaque anchor sur le contour ordonné.
 * Appelé une fois à la frame 0 pour fixer les positions de référence CSS.
 */
export function computeInitialAnchorArcLengths(
  anchors: Point2D[],
  orderedContour: Point2D[],
  arcLengths: number[]
): number[] {
  const N = orderedContour.length
  const totalLength = arcLengths[N - 1]

  if (N === 0 || totalLength < 1e-6) {
    return anchors.map(() => 0)
  }

  return anchors.map(anchor => {
    let bestIdx = 0
    let bestDistSq = Infinity
    for (let i = 0; i < N; i++) {
      const dx = anchor.x - orderedContour[i].x
      const dy = anchor.y - orderedContour[i].y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        bestIdx = i
      }
    }
    return arcLengths[bestIdx] / totalLength
  })
}

// ─── Signatures de courbure initiales ───────────────────────────────

/**
 * Calcule la signature de courbure de chaque anchor à la frame 0.
 * Appelé une fois pour enregistrer l'identité de l'extremum de chaque anchor.
 */
export function computeInitialSignatures(
  anchors: Point2D[],
  orderedContour: Point2D[],
  arcLengths: number[],
  windowFraction: number = 0.08,
  sigma: number = 16
): CurvatureSignature[] {
  const N = orderedContour.length
  const totalLength = arcLengths[N - 1]

  if (N < 10 || totalLength < 1e-6) {
    return anchors.map(() => ({
      kappaSign: 1, absKappa: 0, prominence: 0, localRank: 0, arcLengthNorm: 0,
    }))
  }

  // Trouver l'index contour le plus proche de chaque anchor
  const anchorIndices = anchors.map(anchor => {
    let bestIdx = 0
    let bestDistSq = Infinity
    for (let i = 0; i < N; i++) {
      const dx = anchor.x - orderedContour[i].x
      const dy = anchor.y - orderedContour[i].y
      const dSq = dx * dx + dy * dy
      if (dSq < bestDistSq) {
        bestDistSq = dSq
        bestIdx = i
      }
    }
    return bestIdx
  })

  return anchorIndices.map(anchorIdx => {
    const anchorArc = arcLengths[anchorIdx] / totalLength
    const win = extractLocalWindow(anchorArc, orderedContour, arcLengths, windowFraction)

    if (!win) {
      return { kappaSign: 1, absKappa: 0, prominence: 0, localRank: 0, arcLengthNorm: anchorArc }
    }

    const kappa = computeCurvatureLocal(win.xs, win.ys, sigma)
    const peaks = findLocalPeaks(kappa)

    if (peaks.length === 0) {
      return { kappaSign: 1, absKappa: 0, prominence: 0, localRank: 0, arcLengthNorm: anchorArc }
    }

    // Trouver le pic le plus proche de l'anchor (en indices de fenêtre)
    // Le centre de la fenêtre correspond à l'anchor
    const windowCenter = Math.floor(win.windowSize / 2)
    let closestPeakIdx = 0
    let closestDist = Infinity
    for (let i = 0; i < peaks.length; i++) {
      const d = Math.abs(peaks[i].windowIdx - windowCenter)
      if (d < closestDist) {
        closestDist = d
        closestPeakIdx = i
      }
    }

    const peak = peaks[closestPeakIdx]
    // localRank = rang par |κ| décroissant (peaks est déjà trié)
    const localRank = closestPeakIdx

    return {
      kappaSign: peak.kappaSign,
      absKappa: peak.absKappa,
      prominence: peak.prominence,
      localRank,
      arcLengthNorm: anchorArc,
    }
  })
}

