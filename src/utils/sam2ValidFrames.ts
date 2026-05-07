/**
 * Détection des frames "perdues" par zone SAM 2 + interpolation linéaire des positions
 * trackées sur les gaps. Utilisé par le pipeline members-bones V3 pour gérer les zones
 * occultées brièvement (patte derrière le corps) qui sinon produisent des bones aberrants.
 */

import type { Point2D, RLEMask } from '../types/project'

export const DEFAULT_MIN_AREA_FRACTION = 0.005 // 0.5% de l'aire frame

/** Compte les pixels foreground d'un masque RLE (somme des runs d'index impair). */
export function rleArea(rle: RLEMask): number {
  let area = 0
  for (let i = 1; i < rle.counts.length; i += 2) area += rle.counts[i]
  return area
}

/**
 * Détecte les frames valides par zone : foreground area / frame area >= minAreaFraction.
 * Retourne un Record<zoneId, boolean[]> aligné sur les masques par frame.
 */
export function detectValidFrames(
  masks: Record<string, RLEMask[]>,
  minAreaFraction: number = DEFAULT_MIN_AREA_FRACTION,
): Record<string, boolean[]> {
  const result: Record<string, boolean[]> = {}
  for (const zoneId of Object.keys(masks)) {
    const zoneMasks = masks[zoneId]
    if (!zoneMasks) {
      result[zoneId] = []
      continue
    }
    const valid = new Array<boolean>(zoneMasks.length)
    for (let f = 0; f < zoneMasks.length; f++) {
      const m = zoneMasks[f]
      const [h, w] = m.size
      const total = h * w
      const area = rleArea(m)
      valid[f] = total > 0 && (area / total) >= minAreaFraction
    }
    result[zoneId] = valid
  }
  return result
}

function lerpPoint(a: Point2D, b: Point2D, t: number): Point2D {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/**
 * Interpole les positions sur les frames invalides en se basant sur les frames valides
 * encadrantes. Gap initial → clamp au premier valide. Gap final → clamp au dernier valide.
 * Aucune frame valide → retourne frames inchangées.
 */
export function interpolatePointFrames(frames: Point2D[], valid: boolean[]): Point2D[] {
  const N = frames.length
  if (N === 0 || valid.length !== N) return frames
  // Trouve premier et dernier valide
  let firstValid = -1, lastValid = -1
  for (let i = 0; i < N; i++) if (valid[i]) { firstValid = i; break }
  for (let i = N - 1; i >= 0; i--) if (valid[i]) { lastValid = i; break }
  if (firstValid === -1) return frames

  const out = frames.slice()
  // Gap initial
  for (let i = 0; i < firstValid; i++) out[i] = frames[firstValid]
  // Gap final
  for (let i = lastValid + 1; i < N; i++) out[i] = frames[lastValid]
  // Gaps internes
  let i = firstValid
  while (i < lastValid) {
    if (valid[i]) { i++; continue }
    // i est invalide, prev = i-1 valide, find next valide
    const prev = i - 1
    let next = i + 1
    while (next <= lastValid && !valid[next]) next++
    const a = frames[prev]
    const b = frames[next]
    for (let k = i; k < next; k++) {
      const t = (k - prev) / (next - prev)
      out[k] = lerpPoint(a, b, t)
    }
    i = next + 1
  }
  return out
}

/**
 * Variante pour Point2D[][] : interpole chaque "track" indépendamment sur les gaps.
 * frames[f] = positions de tous les anchors à la frame f.
 */
export function interpolatePointArrayFrames(frames: Point2D[][], valid: boolean[]): Point2D[][] {
  const N = frames.length
  if (N === 0 || valid.length !== N) return frames
  const nPoints = frames.find(f => f && f.length > 0)?.length ?? 0
  if (nPoints === 0) return frames

  // Transpose → per-anchor arrays, interpolate, transpose back.
  const out: Point2D[][] = frames.map(f => (f ? f.slice() : new Array(nPoints).fill({ x: 0, y: 0 })))
  for (let p = 0; p < nPoints; p++) {
    const track: Point2D[] = new Array(N)
    for (let f = 0; f < N; f++) track[f] = frames[f]?.[p] ?? { x: 0, y: 0 }
    const interp = interpolatePointFrames(track, valid)
    for (let f = 0; f < N; f++) out[f][p] = interp[f]
  }
  return out
}

/** Compte les frames invalides par zone. */
export function countInvalidFrames(valid: Record<string, boolean[]>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const z of Object.keys(valid)) {
    result[z] = valid[z].filter(v => !v).length
  }
  return result
}
