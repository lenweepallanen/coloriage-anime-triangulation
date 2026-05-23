import type { Point2D, CoTrackerJawBone, BarycentricRef } from '../types/project'
import { resolveEndpointFrame } from './cotrackerBoneSolver'
import { interpolateInternalPoint } from './barycentricUtils'

export interface ComputeJawArgs {
  jaw: CoTrackerJawBone
  cotrackerFrames: Record<string, Point2D[]>
  videoSize: { width: number; height: number }
  imageSize: { width: number; height: number }
  /** Mesh déformé attaché à la bouche, par frame (coords image). */
  attachDeformedFrames: Point2D[][]
  attachTriangles: [number, number, number][]
  hingeAnchor: BarycentricRef
  /** Facteur de normalisation = projectMouth.maxOpenAngleDeg.
   *  L'angle final appliqué au rendu sera `openness × scalingMaxDeg` (MouthOverlay).
   *  En autorisant openness > 1, on permet à la mâchoire d'ouvrir plus que
   *  l'amplitude parole sans toucher au comportement parole. */
  scalingMaxDeg: number
  /** Plafond physique de l'angle de mâchoire en degrés (override jaw).
   *  Si non fourni → pas de plafond (l'angle réel mesuré est utilisé). */
  capMaxDeg?: number
  rotationSign: 1 | -1
  emaAlpha?: number
}

/**
 * Calcule openness ∈ [0,1] par frame.
 *
 * Pour éviter que la rotation de la tête entière soit comptée comme une
 * ouverture de mâchoire, on travaille dans le **repère local de la tête**
 * défini par le triangle du body mesh contenant le hinge. La direction
 * pivot→tail est exprimée dans ce repère ; au repos (frame 0) elle vaut
 * `restLocalDir`. L'angle entre `restLocalDir` et `localDir_f` est la
 * rotation **propre** de la mâchoire.
 */
export function computeJawOpennessFrames(args: ComputeJawArgs): number[] {
  const { jaw, cotrackerFrames, videoSize, imageSize,
    attachDeformedFrames, attachTriangles, hingeAnchor,
    scalingMaxDeg, capMaxDeg, emaAlpha = 0.5 } = args

  if (jaw.tailRef.pointIds.length === 0) return []
  const anyTraj = cotrackerFrames[jaw.tailRef.pointIds[0]]
  if (!anyTraj || anyTraj.length === 0) return []
  const totalFrames = anyTraj.length
  if (scalingMaxDeg <= 0) return new Array(totalFrames).fill(0)
  if (attachDeformedFrames.length === 0) return new Array(totalFrames).fill(0)

  const sx = imageSize.width / videoSize.width
  const sy = imageSize.height / videoSize.height

  // Indices des sommets du triangle contenant le hinge — sert à dériver le repère local.
  const triHinge = attachTriangles[hingeAnchor.anchorTriangleIndex]
  if (!triHinge) return new Array(totalFrames).fill(0)
  const [ia, ib] = triHinge

  // Helper : pivot + repère local au frame f, retourne null si données manquantes.
  function frameLocalFrame(f: number): { pivot: Point2D; ux: number; uy: number; vx: number; vy: number } | null {
    const def = attachDeformedFrames[Math.min(f, attachDeformedFrames.length - 1)]
    if (!def) return null
    const pivot = interpolateInternalPoint(hingeAnchor, def, attachTriangles)
    const A = def[ia], B = def[ib]
    if (!A || !B) return null
    const ex = B.x - A.x, ey = B.y - A.y
    const n = Math.hypot(ex, ey)
    if (n < 1e-6) return null
    const ux = ex / n, uy = ey / n
    // Perp (90° CCW dans l'espace image avec Y vers le bas)
    const vx = -uy, vy = ux
    return { pivot, ux, uy, vx, vy }
  }

  // Direction tail→pivot dans le repère local à frame 0 = "rest closed".
  const f0 = frameLocalFrame(0)
  const tail0 = resolveEndpointFrame(jaw.tailRef, cotrackerFrames, 0)
  if (!f0 || !tail0) return new Array(totalFrames).fill(0)
  const tail0Img = { x: tail0.x * sx, y: tail0.y * sy }
  const d0x = tail0Img.x - f0.pivot.x, d0y = tail0Img.y - f0.pivot.y
  const restLocalX = d0x * f0.ux + d0y * f0.uy
  const restLocalY = d0x * f0.vx + d0y * f0.vy
  const restNorm = Math.hypot(restLocalX, restLocalY)
  if (restNorm < 1e-6) return new Array(totalFrames).fill(0)
  const rlx = restLocalX / restNorm, rly = restLocalY / restNorm

  const out: number[] = new Array(totalFrames)
  let prev = 0
  for (let f = 0; f < totalFrames; f++) {
    const ff = frameLocalFrame(f)
    const tVid = resolveEndpointFrame(jaw.tailRef, cotrackerFrames, f)
    let raw = 0
    if (ff && tVid) {
      const tImg = { x: tVid.x * sx, y: tVid.y * sy }
      const dx = tImg.x - ff.pivot.x, dy = tImg.y - ff.pivot.y
      const localX = dx * ff.ux + dy * ff.uy
      const localY = dx * ff.vx + dy * ff.vy
      const n = Math.hypot(localX, localY)
      if (n >= 1e-6) {
        const lx = localX / n, ly = localY / n
        // Angle absolu entre restLocalDir et localDir_f
        const cross = rlx * ly - rly * lx
        const dot = rlx * lx + rly * ly
        const absRad = Math.abs(Math.atan2(cross, dot))
        const absDeg = (absRad * 180) / Math.PI
        // Plafonne l'angle au cap utilisateur, puis normalise par scalingMaxDeg.
        // Autorise openness > 1 → MouthOverlay rotate au-delà de scalingMaxDeg
        // (utile pour mâchoire qui ouvre plus que l'amplitude parole).
        const cappedDeg = capMaxDeg != null ? Math.min(absDeg, capMaxDeg) : absDeg
        raw = cappedDeg / scalingMaxDeg
      }
    } else {
      raw = prev
    }
    out[f] = f === 0 ? raw : prev + emaAlpha * (raw - prev)
    prev = out[f]
  }
  return out
}
