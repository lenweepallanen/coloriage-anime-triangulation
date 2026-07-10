/**
 * Gestion des occlusions CoTracker3.
 *
 * Quand des parties du corps se croisent (ex. pattes avant d'un T-rex qui boxe),
 * CoTracker fait dériver/fusionner les points occlus et le mesh s'écroule.
 * CoTracker3 fournit une visibilité par point par frame (0..1) : les frames
 * "perdues" (visibilité < seuil) sont remplacées par interpolation linéaire
 * entre la dernière position visible et la prochaine position visible.
 */

import type { Point2D } from '../types/project'

/** Plage de frames occluses, bornes incluses. */
export interface OccludedSegment {
  start: number
  end: number
}

/** Segments contigus de frames non visibles. */
export function computeOccludedSegments(visible: boolean[]): OccludedSegment[] {
  const segments: OccludedSegment[] = []
  let start = -1
  for (let f = 0; f < visible.length; f++) {
    if (!visible[f]) {
      if (start < 0) start = f
    } else if (start >= 0) {
      segments.push({ start, end: f - 1 })
      start = -1
    }
  }
  if (start >= 0) segments.push({ start, end: visible.length - 1 })
  return segments
}

/**
 * Remplace les positions des frames non visibles par interpolation linéaire
 * entre la dernière frame visible et la prochaine frame visible.
 * - Gap en tête : hold de la première frame visible.
 * - Gap en queue : hold de la dernière frame visible.
 * - Tout perdu : trajectoire brute inchangée (interpoler depuis rien serait pire).
 */
export function interpolateOccludedTrack(track: Point2D[], visible: boolean[]): Point2D[] {
  const n = track.length
  const visibleIndices: number[] = []
  for (let f = 0; f < n; f++) {
    if (visible[f] ?? true) visibleIndices.push(f)
  }
  if (visibleIndices.length === 0 || visibleIndices.length === n) return track

  const result = track.slice()
  const first = visibleIndices[0]
  const last = visibleIndices[visibleIndices.length - 1]

  for (let f = 0; f < first; f++) result[f] = { ...track[first] }
  for (let f = last + 1; f < n; f++) result[f] = { ...track[last] }

  for (let k = 0; k < visibleIndices.length - 1; k++) {
    const a = visibleIndices[k]
    const b = visibleIndices[k + 1]
    if (b - a <= 1) continue
    for (let f = a + 1; f < b; f++) {
      const t = (f - a) / (b - a)
      result[f] = {
        x: track[a].x * (1 - t) + track[b].x * t,
        y: track[a].y * (1 - t) + track[b].y * t,
      }
    }
  }
  return result
}

/**
 * Applique l'interpolation d'occlusion à toutes les trajectoires.
 * Un point sans visibilité (ou visibilité plus courte que la trajectoire sur les
 * frames manquantes) est traité comme visible → pass-through.
 * Retourne aussi les segments occlus par point pour la visualisation.
 */
export function applyOcclusionInterpolation(
  framesRaw: Record<string, Point2D[]>,
  visibility: Record<string, number[]> | null | undefined,
  threshold: number,
): { frames: Record<string, Point2D[]>; segments: Record<string, OccludedSegment[]> } {
  const frames: Record<string, Point2D[]> = {}
  const segments: Record<string, OccludedSegment[]> = {}
  for (const [pid, track] of Object.entries(framesRaw)) {
    const vis = visibility?.[pid]
    if (!vis || vis.length === 0) {
      frames[pid] = track
      segments[pid] = []
      continue
    }
    const visible = track.map((_, f) => (vis[f] ?? 1) >= threshold)
    const segs = computeOccludedSegments(visible)
    // Tout perdu : on garde le brut (le caller affiche un warning).
    if (segs.length === 1 && segs[0].start === 0 && segs[0].end === track.length - 1) {
      frames[pid] = track
      segments[pid] = segs
      continue
    }
    frames[pid] = interpolateOccludedTrack(track, visible)
    segments[pid] = segs
  }
  return { frames, segments }
}
