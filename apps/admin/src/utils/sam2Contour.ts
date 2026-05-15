/**
 * SAM 2 contour extraction + Gaussian smoothing + curvilinear projection.
 *
 * Pipeline pour le type d'animation `members-bones` (étapes 3-8) :
 *
 *   RLE mask SAM 2  →  decodeRLE (rleMask.ts)
 *                  →  flowMaskToContour (worker OpenCV cv.findContours)
 *                  →  smoothPolygonGaussian (1D Gaussian on x/y, cyclic)
 *                  →  Point2D[] polygone fermé lissé
 *
 * Les coordonnées retournées sont en pixels VIDÉO (mêmes dimensions que le masque
 * RLE, c'est-à-dire mesh.sam2VideoWidth × mesh.sam2VideoHeight).
 */

import type { CurvilinearParam, Point2D, RLEMask } from '../types/project'
import { decodeRLE } from './rleMask'
import { flowMaskToContour } from './perspectiveCorrection'
import {
  computeArcLengths,
  extractPathBetweenAnchors,
  interpolateAtArcLength,
  reorderContourFromOrigin,
} from './curvilinearContour'

/**
 * Extrait le contour externe (le plus grand polygone) d'un masque RLE SAM 2.
 * Délègue à OpenCV.js dans le Worker.
 *
 * @returns Polygone ordonné en pixels mask, ou [] si aucun contour
 */
export async function rleToContour(rle: RLEMask): Promise<Point2D[]> {
  const [h, w] = rle.size
  const mask = decodeRLE(rle)
  return flowMaskToContour(mask, w, h)
}

/**
 * Lisse un polygone fermé via une convolution gaussienne 1D séparable sur les
 * coordonnées x et y. Le polygone est traité comme **cyclique** (le dernier
 * point se connecte au premier), donc les indices sont calculés modulo n —
 * pas de biais aux extrémités.
 *
 * @param polygon  polygone fermé (ordre quelconque)
 * @param sigma    écart-type du noyau gaussien en pixels (1-10 typique)
 * @returns        polygone lissé (même nombre de points)
 */
export function smoothPolygonGaussian(polygon: Point2D[], sigma: number): Point2D[] {
  const n = polygon.length
  if (n < 3 || sigma <= 0) return polygon

  const radius = Math.max(1, Math.ceil(3 * sigma))
  // Pré-calcul du noyau gaussien normalisé
  const kernel: number[] = new Array(2 * radius + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = w
    sum += w
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  // Convolution cyclique
  const out: Point2D[] = new Array(n)
  for (let i = 0; i < n; i++) {
    let sx = 0
    let sy = 0
    for (let k = -radius; k <= radius; k++) {
      const idx = ((i + k) % n + n) % n
      const w = kernel[k + radius]
      sx += polygon[idx].x * w
      sy += polygon[idx].y * w
    }
    out[i] = { x: sx, y: sy }
  }
  return out
}

/**
 * Pipeline complet : RLE → contour brut → contour lissé.
 */
export async function sam2RleToSmoothedContour(
  rle: RLEMask,
  smoothSigma = 3
): Promise<Point2D[]> {
  const raw = await rleToContour(rle)
  if (raw.length === 0) return raw
  return smoothPolygonGaussian(raw, smoothSigma)
}

/**
 * Resample un polygone fermé à exactement N points uniformément répartis en arc-length.
 */
export function resampleContour(polygon: Point2D[], n: number): Point2D[] {
  if (polygon.length < 2 || n < 2) return polygon
  const arcs = computeArcLengths(polygon)
  const total = arcs[arcs.length - 1]
  if (total === 0) return polygon.slice(0, n)
  const result: Point2D[] = new Array(n)
  for (let i = 0; i < n; i++) {
    result[i] = interpolateAtArcLength(polygon, arcs, i / n)
  }
  return result
}

/**
 * Lissage temporel d'une séquence de contours body.
 * 1. Resample chaque frame à `numSamples` points uniformes en arc-length
 * 2. Moving average de `window` frames sur chaque position de point
 *
 * Élimine les sauts frame-à-frame du bridge (une frame sur deux mal bridgée).
 */
export function temporalSmoothContours(
  frames: Point2D[][],
  numSamples = 300,
  window = 3,
): Point2D[][] {
  const nf = frames.length
  if (nf === 0) return frames
  const half = Math.floor(window / 2)

  const resampled: Point2D[][] = new Array(nf)
  for (let f = 0; f < nf; f++) {
    resampled[f] = frames[f].length >= 2
      ? resampleContour(frames[f], numSamples)
      : frames[f]
  }

  const result: Point2D[][] = new Array(nf)
  for (let f = 0; f < nf; f++) {
    if (resampled[f].length !== numSamples) {
      result[f] = resampled[f]
      continue
    }
    const pts: Point2D[] = new Array(numSamples)
    const lo = Math.max(0, f - half)
    const hi = Math.min(nf - 1, f + half)
    let count = 0
    for (let t = lo; t <= hi; t++) {
      if (resampled[t].length === numSamples) count++
    }
    if (count === 0) { result[f] = resampled[f]; continue }
    for (let i = 0; i < numSamples; i++) {
      let sx = 0, sy = 0
      for (let t = lo; t <= hi; t++) {
        if (resampled[t].length === numSamples) {
          sx += resampled[t][i].x
          sy += resampled[t][i].y
        }
      }
      pts[i] = { x: sx / count, y: sy / count }
    }
    result[f] = pts
  }
  return result
}

/**
 * Post-traitement du contour body après soustraction des masques pattes :
 * quand le contour body passe près d'un contour de patte (distance < threshold),
 * on "saute" ce segment au lieu de suivre la concavité — on ne garde que le point
 * d'entrée et le point de sortie de la zone de proximité, bridgant ainsi la patte.
 *
 * @param contour       contour body (issu du masque soustrait), en mask coords
 * @param legContours   contours des pattes, en mask coords
 * @param threshold     distance de proximité en pixels mask (défaut 8)
 * @returns             contour body nettoyé (moins de points, concavités supprimées)
 */
export function bridgeContourAtLegs(
  contour: Point2D[],
  legContours: Point2D[][],
  threshold = 8,
): Point2D[] {
  if (contour.length < 3 || legContours.length === 0) return contour

  const n = contour.length
  const threshSq = threshold * threshold

  // Build a simple bucket spatial index over all leg contour points for fast lookup
  const bucketSize = threshold * 2
  const legBuckets = new Map<string, true>()
  for (const leg of legContours) {
    for (const p of leg) {
      const bx = Math.floor(p.x / bucketSize)
      const by = Math.floor(p.y / bucketSize)
      legBuckets.set(`${bx},${by}`, true)
    }
  }

  // For each body contour point, check if it's near any leg contour point
  const inProximity = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = contour[i]
    const bx = Math.floor(p.x / bucketSize)
    const by = Math.floor(p.y / bucketSize)
    // Check if any nearby bucket has leg points — if not, skip expensive distance check
    let hasBucket = false
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (legBuckets.has(`${bx + dx},${by + dy}`)) { hasBucket = true; break }
      }
      if (hasBucket) break
    }
    if (!hasBucket) continue

    // Fine distance check against all leg contour points
    for (const leg of legContours) {
      for (const q of leg) {
        const dx = p.x - q.x
        const dy = p.y - q.y
        if (dx * dx + dy * dy < threshSq) {
          inProximity[i] = 1
          break
        }
      }
      if (inProximity[i]) break
    }
  }

  // Find a starting index that's NOT in proximity
  let startIdx = -1
  for (let j = 0; j < n; j++) {
    if (!inProximity[j]) { startIdx = j; break }
  }
  if (startIdx === -1) return contour // entire contour in proximity — degenerate

  // Walk from startIdx, skip proximity zones (keep entry + exit points)
  const result: Point2D[] = []
  for (let step = 0; step < n; ) {
    const idx = (startIdx + step) % n
    if (!inProximity[idx]) {
      result.push(contour[idx])
      step++
    } else {
      // Entering proximity zone — the previous point (already in result) is the entry
      // Skip all points in the zone
      const entryIdx = idx
      let runLen = 0
      while (step + runLen < n && inProximity[(startIdx + step + runLen) % n]) {
        runLen++
      }
      // Add entry and exit points of the zone for a clean bridge
      result.push(contour[entryIdx])
      if (runLen > 1) {
        const exitIdx = (startIdx + step + runLen - 1) % n
        result.push(contour[exitIdx])
      }
      step += runLen
    }
  }

  return result
}

/**
 * Index du point du polygone le plus proche d'un point arbitraire (recherche linéaire).
 * Utilisé pour calculer la coordonnée curviligne d'un anchor placé manuellement.
 */
export function nearestPointIndex(p: Point2D, polygon: Point2D[]): number {
  if (polygon.length === 0) return -1
  let bestIdx = 0
  let bestD = Infinity
  for (let i = 0; i < polygon.length; i++) {
    const dx = polygon[i].x - p.x
    const dy = polygon[i].y - p.y
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Calcule la coordonnée curviligne normalisée (s ∈ [0, 1]) du point le plus proche
 * de p sur le contour cyclique. Snap = nearest neighbor (pas d'interpolation).
 *
 * Utilisé pour mémoriser la position d'un anchor placé manuellement à frame 0,
 * afin de pouvoir l'échantillonner à la même position relative sur les contours
 * des autres frames (tracking déterministe).
 */
export function pointToArcLength(p: Point2D, contour: Point2D[]): number {
  if (contour.length < 2) return 0
  const idx = nearestPointIndex(p, contour)
  const arcLengths = computeArcLengths(contour)
  const total = arcLengths[arcLengths.length - 1]
  if (total === 0) return 0
  return arcLengths[idx] / total
}

/**
 * Échantillonne un point sur le contour à la coordonnée curviligne normalisée s ∈ [0, 1].
 * Réutilise interpolateAtArcLength de curvilinearContour.ts pour l'interpolation linéaire
 * entre les deux pixels encadrants.
 *
 * NOTE : `interpolateAtArcLength` attend un t NORMALISÉ [0,1], PAS une longueur absolue.
 * On passe donc `s` directement (wrap cyclique pour gérer les valeurs hors [0,1]).
 */
export function arcLengthToPoint(s: number, contour: Point2D[]): Point2D {
  if (contour.length === 0) return { x: 0, y: 0 }
  if (contour.length === 1) return contour[0]
  const arcLengths = computeArcLengths(contour)
  const total = arcLengths[arcLengths.length - 1]
  if (total === 0) return contour[0]
  // Wrap s cyclically to [0, 1) — but pass NORMALIZED t to interpolateAtArcLength
  const tNormalized = ((s % 1) + 1) % 1
  return interpolateAtArcLength(contour, arcLengths, tNormalized)
}

/**
 * Convertit un point en coordonnées image vers les coordonnées vidéo (= mask) attendues
 * par les fonctions ci-dessus. Les contours SAM 2 sont stockés en pixels VIDÉO.
 */
export function imageToVideoCoords(
  p: Point2D,
  imageWidth: number,
  imageHeight: number,
  videoWidth: number,
  videoHeight: number
): Point2D {
  return {
    x: (p.x / imageWidth) * videoWidth,
    y: (p.y / imageHeight) * videoHeight,
  }
}

/**
 * Inverse de imageToVideoCoords : pixels vidéo → image.
 */
export function videoToImageCoords(
  p: Point2D,
  imageWidth: number,
  imageHeight: number,
  videoWidth: number,
  videoHeight: number
): Point2D {
  return {
    x: (p.x / videoWidth) * imageWidth,
    y: (p.y / videoHeight) * imageHeight,
  }
}

/**
 * Pour chaque zone et chaque frame, calcule les positions des points de subdivision
 * en utilisant les paramètres curvilignes RELATIFS `{segmentIndex, t}` (où t ∈ (0,1)
 * dans le sous-chemin entre anchors[segmentIndex] et anchors[(segmentIndex + 1) % n]).
 *
 * Ce calcul est équivalent à `computeAllSubdivisionFrames` du pipeline rest/oneshot,
 * mais sur les contours SAM 2 pré-calculés (pas de détection Canny live) — la boucle
 * vidéo n'est donc pas nécessaire, tout est en mémoire.
 *
 * **Inputs** :
 *   - `contoursAll` : contours SAM 2 lissés en **MASK coords** (par zone par frame)
 *   - `anchorFramesAll` : positions des anchors en **VIDEO coords** (par zone par frame)
 *   - `subdivisionParamsAll` : params `{segmentIndex, t}` par zone (statique depuis l'étape 7)
 *
 * **Output** : positions des subdivisions en **VIDEO coords**, par zone par frame.
 *
 * Pour chaque (zone, frame) :
 *   1. Convertir les anchors de la frame : video → mask coords
 *   2. Réordonner le contour SAM 2 depuis le P0 de cette frame (`anchorsMask[0]`)
 *   3. Pour chaque subdivision param `{segmentIndex, t}` :
 *      a. Extraire le sous-chemin entre `anchorsMask[i]` et `anchorsMask[(i+1) % n]`
 *      b. Interpoler à la fraction `t` de la longueur du sous-chemin
 *      c. Reconvertir mask → video coords
 *   4. Fallback si le sous-chemin est vide : interpolation linéaire directe entre
 *      les 2 anchors à fraction `t`
 */
export function computeSam2SubdivisionFramesAllZones(
  contoursAll: Record<string, Point2D[][]>,
  anchorFramesAll: Record<string, Point2D[][]>,
  subdivisionParamsAll: Record<string, CurvilinearParam[]>,
  sam2W: number,
  sam2H: number,
  videoW: number,
  videoH: number,
): Record<string, Point2D[][]> {
  const sx = videoW / sam2W
  const sy = videoH / sam2H
  const result: Record<string, Point2D[][]> = {}

  for (const zoneId of Object.keys(contoursAll)) {
    const polys = contoursAll[zoneId]
    const aFrames = anchorFramesAll[zoneId]
    const params = subdivisionParamsAll[zoneId]
    if (!polys || !aFrames || !params || params.length === 0) {
      result[zoneId] = []
      continue
    }

    const perFrame: Point2D[][] = new Array(polys.length)
    for (let f = 0; f < polys.length; f++) {
      const poly = polys[f]
      const anchorsVideo = aFrames[f]
      if (!poly || poly.length < 2 || !anchorsVideo || anchorsVideo.length < 2) {
        perFrame[f] = params.map(() => ({ x: 0, y: 0 }))
        continue
      }

      // Anchors video → mask coords
      const anchorsMask = anchorsVideo.map(p => ({ x: p.x / sx, y: p.y / sy }))
      const n = anchorsMask.length

      // Reorder contour from P0 (= anchors[0]) so s=0 is consistent with step 7 storage
      const ordered = reorderContourFromOrigin(poly, anchorsMask[0])

      // Cache extracted sub-paths + arc-lengths per segment (lazy build)
      const segPaths: (Point2D[] | null)[] = new Array(n).fill(null)
      const segArcs: (number[] | null)[] = new Array(n).fill(null)

      const pts: Point2D[] = new Array(params.length)
      for (let k = 0; k < params.length; k++) {
        const { segmentIndex: i, t } = params[k]
        const iClamped = ((i % n) + n) % n

        // Lazy build sub-path for this segment
        if (segPaths[iClamped] === null) {
          const a = anchorsMask[iClamped]
          const b = anchorsMask[(iClamped + 1) % n]
          const sub = extractPathBetweenAnchors(ordered, a, b)
          segPaths[iClamped] = sub
          segArcs[iClamped] = sub.length >= 2 ? computeArcLengths(sub) : null
        }

        const sub = segPaths[iClamped]!
        const arcs = segArcs[iClamped]
        let maskPt: Point2D
        if (sub.length >= 2 && arcs) {
          // Interpolate at fraction t along the sub-path
          maskPt = interpolateAtArcLength(sub, arcs, t)
        } else {
          // Fallback : linear between anchors
          const a = anchorsMask[iClamped]
          const b = anchorsMask[(iClamped + 1) % n]
          maskPt = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        }

        // mask → video coords
        pts[k] = { x: maskPt.x * sx, y: maskPt.y * sy }
      }
      perFrame[f] = pts
    }
    result[zoneId] = perFrame
  }

  return result
}
