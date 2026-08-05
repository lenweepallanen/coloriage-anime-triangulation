import type { FilmTravelEasing, Point2D } from '../types/project'

/**
 * Chemin de trajet film échantillonné en arc-length : source de vérité UNIQUE
 * des longueurs (playback + estimation de durées + dessin éditeur). Un trajet
 * sans point de contrôle est une ligne droite (2 échantillons) ; 1 CP = Bézier
 * quadratique, 2 CPs = cubique.
 */
export interface FilmPathTable {
  samples: Point2D[]
  /** Longueurs cumulées : cumLen[i] = distance de samples[0] à samples[i]. */
  cumLen: number[]
  totalLen: number
}

function evalQuadratic(p0: Point2D, c: Point2D, p1: Point2D, t: number): Point2D {
  const u = 1 - t
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  }
}

function evalCubic(p0: Point2D, c1: Point2D, c2: Point2D, p1: Point2D, t: number): Point2D {
  const u = 1 - t
  const uu = u * u
  const tt = t * t
  return {
    x: uu * u * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + tt * t * p1.x,
    y: uu * u * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + tt * t * p1.y,
  }
}

/**
 * Échantillonne le chemin `from → controlPoints → to` en N pas et construit la
 * table arc-length. Sans CP : ligne droite (table minimale à 2 points).
 */
export function sampleFilmPath(
  from: Point2D,
  to: Point2D,
  controlPoints?: Point2D[],
  n = 96,
): FilmPathTable {
  const cps = controlPoints ?? []
  let samples: Point2D[]
  if (cps.length === 0) {
    samples = [{ ...from }, { ...to }]
  } else {
    samples = new Array<Point2D>(n + 1)
    for (let i = 0; i <= n; i++) {
      const t = i / n
      samples[i] = cps.length === 1
        ? evalQuadratic(from, cps[0], to, t)
        : evalCubic(from, cps[0], cps[1], to, t)
    }
  }
  const cumLen = new Array<number>(samples.length)
  cumLen[0] = 0
  for (let i = 1; i < samples.length; i++) {
    cumLen[i] = cumLen[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y)
  }
  return { samples, cumLen, totalLen: cumLen[cumLen.length - 1] }
}

/** Position sur le chemin à la distance `len` (clampée), par binary search + lerp. */
export function pointAtLen(table: FilmPathTable, len: number): Point2D {
  const { samples, cumLen, totalLen } = table
  if (totalLen <= 1e-9 || len <= 0) return { ...samples[0] }
  if (len >= totalLen) return { ...samples[samples.length - 1] }
  let lo = 0
  let hi = cumLen.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cumLen[mid] <= len) lo = mid
    else hi = mid
  }
  const segLen = cumLen[hi] - cumLen[lo]
  const t = segLen > 1e-9 ? (len - cumLen[lo]) / segLen : 0
  return {
    x: samples[lo].x + (samples[hi].x - samples[lo].x) * t,
    y: samples[lo].y + (samples[hi].y - samples[lo].y) * t,
  }
}

/**
 * Easing temporel d'un trajet : mappe le temps normalisé [0,1] vers la fraction
 * de DISTANCE parcourue [0,1]. La durée totale (distance/vitesse) est inchangée.
 */
export function applyFilmEasing(easing: FilmTravelEasing | undefined, t: number): number {
  const c = Math.max(0, Math.min(1, t))
  switch (easing) {
    case 'easeIn': return c * c
    case 'easeOut': return c * (2 - c)
    case 'easeInOut': return c * c * (3 - 2 * c) // smoothstep
    default: return c
  }
}
