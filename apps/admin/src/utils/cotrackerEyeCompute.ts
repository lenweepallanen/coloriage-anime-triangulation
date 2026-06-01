import type { CoTrackerEyeLink, EyeRegion, Point2D } from '../types/project'
import { interpolateInternalPoint } from './barycentricUtils'
import { computeEyeFrame } from './eyeBlinkOverlay'

export interface ComputeEyePupilArgs {
  eyes: EyeRegion[]
  /** Liens œil→point cotracker (mesh.cotrackerSkeleton.eyeLinks). */
  eyeLinks: CoTrackerEyeLink[]
  /** pointId → positions par frame (coords vidéo). */
  cotrackerFrames: Record<string, Point2D[]>
  videoSize: { width: number; height: number }
  imageSize: { width: number; height: number }
  /** Frames déformées par zone (coords image) : 'body' = walkBodyFrames, zoneId = walkZoneFrames[zoneId]. */
  framesByZone: Record<string, Point2D[][]>
  /** Triangles par zone : 'body' = bodyTriangles, zoneId = zoneTriangles[zoneId]. */
  trianglesByZone: Record<string, [number, number, number][]>
}

/**
 * Calcule, pour chaque œil lié à `animationId`, l'offset de pupille par frame.
 *
 * L'offset est exprimé dans le **repère local de l'œil** (coords image), relatif
 * au centre de l'œil déformé. Au frame 0 l'offset vaut 0 (pupille centrée) ; les
 * frames suivantes suivent le déplacement du point CoTracker relativement à l'œil,
 * clampé dans l'ellipse 1 (moins le rayon pupille). Calque de computeJawOpennessFrames.
 */
export function computeEyePupilFrames(args: ComputeEyePupilArgs): Record<string, Point2D[]> {
  const { eyes, eyeLinks, cotrackerFrames, videoSize, imageSize, framesByZone, trianglesByZone } = args
  const out: Record<string, Point2D[]> = {}
  if (eyeLinks.length === 0) return out

  const sx = imageSize.width / videoSize.width
  const sy = imageSize.height / videoSize.height

  for (const link of eyeLinks) {
    const eye = eyes.find(e => e.id === link.eyeId)
    if (!eye) continue
    const traj = cotrackerFrames[link.pointId]
    if (!traj || traj.length === 0) continue
    const refs = eye.bodyBarycentricRefs
    if (!refs || refs.length !== eye.contourPoints.length || refs.length === 0) continue

    const zoneId = eye.attachZoneId ?? 'body'
    const deformedFrames = framesByZone[zoneId]
    const triangles = trianglesByZone[zoneId]
    if (!deformedFrames || deformedFrames.length === 0 || !triangles || triangles.length === 0) continue

    const totalFrames = Math.min(traj.length, deformedFrames.length)
    const pupilRadiusFrac = eye.pupilRadiusFrac ?? 0.45

    // Sémantique "look at" : la pupille essaie de coïncider avec le point CoTracker.
    // Si le point est dans l'œil → pupille = point. Sinon → pupille clampée sur le
    // bord de l'œil dans la direction du point (la pupille "regarde vers" lui).
    const frames: Point2D[] = new Array(totalFrames)
    for (let f = 0; f < totalFrames; f++) {
      const def = deformedFrames[Math.min(f, deformedFrames.length - 1)]
      const ct = traj[Math.min(f, traj.length - 1)]
      if (!def || !ct) { frames[f] = { x: 0, y: 0 }; continue }
      const poly = refs.map(r => interpolateInternalPoint(r, def, triangles))
      const frame = computeEyeFrame(poly)
      const px = ct.x * sx, py = ct.y * sy
      const dx = px - frame.center.x, dy = py - frame.center.y
      let ox = dx * frame.ux + dy * frame.uy
      let oy = dx * frame.vx + dy * frame.vy
      // Clamp dans l'ellipse 1 moins le rayon pupille.
      const minHalf = Math.min(frame.halfU, frame.halfV)
      const pupilR = pupilRadiusFrac * minHalf
      const ax = Math.max(1, frame.halfU - pupilR)
      const ay = Math.max(1, frame.halfV - pupilR)
      const e = (ox * ox) / (ax * ax) + (oy * oy) / (ay * ay)
      if (e > 1) {
        const s = 1 / Math.sqrt(e)
        ox *= s; oy *= s
      }
      frames[f] = { x: ox, y: oy }
    }
    out[eye.id] = frames
  }
  return out
}
