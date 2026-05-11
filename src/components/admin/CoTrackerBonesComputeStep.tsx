/**
 * CoTracker + Bones — Step 4 : compute body LBS + leg LBS from skeleton & tracked points.
 *
 * Body : LBS via body chain sub-bones (segments between consecutive joints).
 *        Auto-weights by inverse distance squared. Reuses projectTriangulation.bodyPoints/Triangles.
 *
 * Legs : LBS per zone with 2 sub-bones (hip-knee, knee-foot). Knee computed via IK.
 *        Reuses projectTriangulation.zonePoints[zoneId]/zoneTriangles[zoneId].
 *
 * Coordinate system : cotrackerFrames are in VIDEO coords, output is IMAGE coords
 * (compatible with downstream V2 smoothing steps).
 */

import { useState } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationLoopPreview from './TriangulationLoopPreview'
import {
  resolveCoTrackerBodyChain,
  computeCoTrackerLegRestPose,
  resolveCoTrackerSkeletonFrame,
  type CoTrackerSkeletonFrame,
  type CoTrackerLegRestPose,
} from '../../utils/cotrackerBoneSolver'
import {
  pointToSegmentDistanceSq,
  computeBoneTransform,
  boneLocalMatrix,
  skinVerticesSubBones,
  type AffineMatrix,
} from '../../utils/boneSolver'

const WEIGHT_EPSILON = 1.0
const WEIGHT_THRESHOLD = 0.01

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

function videoToImage(p: Point2D, imgW: number, imgH: number, vidW: number, vidH: number): Point2D {
  return { x: p.x * (imgW / vidW), y: p.y * (imgH / vidH) }
}

function computeWeights(
  restVertices: Point2D[],
  subBones: { head: Point2D; tail: Point2D }[],
): number[][] {
  const out: number[][] = new Array(restVertices.length)
  for (let i = 0; i < restVertices.length; i++) {
    const p = restVertices[i]
    const raw = new Array<number>(subBones.length)
    let s = 0
    for (let j = 0; j < subBones.length; j++) {
      const d = Math.sqrt(pointToSegmentDistanceSq(p, subBones[j].head, subBones[j].tail))
      const w = 1.0 / ((d + WEIGHT_EPSILON) * (d + WEIGHT_EPSILON))
      raw[j] = w; s += w
    }
    if (s > 0) for (let j = 0; j < subBones.length; j++) raw[j] /= s
    let s2 = 0
    for (let j = 0; j < subBones.length; j++) {
      if (raw[j] < WEIGHT_THRESHOLD) raw[j] = 0
      s2 += raw[j]
    }
    if (s2 > 0) for (let j = 0; j < subBones.length; j++) raw[j] /= s2
    out[i] = raw
  }
  return out
}

export default function CoTrackerBonesComputeStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const [progress, setProgress] = useState<{ frame: number; total: number; phase: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const tri = project.projectTriangulation
  const ready =
    mesh?.cotrackerFrames != null &&
    mesh?.cotrackerSkeleton != null &&
    mesh?.cotrackerBonesValidated === true &&
    tri?.step3Validated === true &&
    mesh?.cotrackerVideoWidth != null &&
    mesh?.cotrackerVideoHeight != null

  async function handleCompute() {
    setError(null)
    if (!ready || !tri || !mesh) { setError('Pré-requis manquants'); return }
    const skeleton = mesh.cotrackerSkeleton!
    const ctFrames = mesh.cotrackerFrames!
    const vidW = mesh.cotrackerVideoWidth!
    const vidH = mesh.cotrackerVideoHeight!
    const imgW = tri.maskWidth
    const imgH = tri.maskHeight

    // Determine totalFrames from any tracked trajectory
    const anyTraj = Object.values(ctFrames)[0]
    const totalFrames = anyTraj?.length ?? 0
    if (totalFrames === 0) { setError('Aucune frame trackée'); return }

    setProgress({ frame: 0, total: totalFrames, phase: 'Rest poses' })

    // ─── Body LBS setup ─────────────────────────────────────────────
    const bodyJointsF0Vid = resolveCoTrackerBodyChain(skeleton.bodyChain, ctFrames, 0)
    const bodyJointsF0Img = bodyJointsF0Vid.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
    const restBodySubBones: { head: Point2D; tail: Point2D }[] = []
    for (let i = 0; i < bodyJointsF0Img.length - 1; i++) {
      restBodySubBones.push({ head: bodyJointsF0Img[i], tail: bodyJointsF0Img[i + 1] })
    }
    if (restBodySubBones.length === 0) { setError('Body chain : au moins 2 joints requis'); return }
    const bodyWeights = computeWeights(tri.bodyPoints, restBodySubBones)

    // ─── Leg LBS setup ──────────────────────────────────────────────
    const legRestPoses: CoTrackerLegRestPose[] = skeleton.legs.map(leg =>
      computeCoTrackerLegRestPose(leg, ctFrames)
    )
    const legSubBones: Record<string, { head: Point2D; tail: Point2D }[]> = {}
    const legWeights: Record<string, number[][]> = {}
    for (let li = 0; li < skeleton.legs.length; li++) {
      const leg = skeleton.legs[li]
      const rp = legRestPoses[li]
      const hipI = videoToImage(rp.hip, imgW, imgH, vidW, vidH)
      const kneeI = videoToImage(rp.knee, imgW, imgH, vidW, vidH)
      const footI = videoToImage(rp.foot, imgW, imgH, vidW, vidH)
      legSubBones[leg.zoneId] = [{ head: hipI, tail: kneeI }, { head: kneeI, tail: footI }]
      const zonePts = tri.zonePoints[leg.zoneId]
      if (zonePts) legWeights[leg.zoneId] = computeWeights(zonePts, legSubBones[leg.zoneId])
    }

    // ─── Frame loop ─────────────────────────────────────────────────
    const walkBodyFrames: Point2D[][] = new Array(totalFrames)
    const walkZoneFrames: Record<string, Point2D[][]> = {}
    const cotrackerBodyJointFrames: Point2D[][] = []
    const cotrackerLegBoneFrames: Record<string, { hip: Point2D[]; knee: Point2D[]; foot: Point2D[] }> = {}
    for (const leg of skeleton.legs) {
      walkZoneFrames[leg.zoneId] = new Array(totalFrames)
      cotrackerLegBoneFrames[leg.zoneId] = { hip: [], knee: [], foot: [] }
    }
    for (let j = 0; j < skeleton.bodyChain.length; j++) cotrackerBodyJointFrames.push([])

    let prevSkeletonFrame: CoTrackerSkeletonFrame | null = null
    for (let f = 0; f < totalFrames; f++) {
      const skf = resolveCoTrackerSkeletonFrame(skeleton, ctFrames, f, legRestPoses, prevSkeletonFrame)
      prevSkeletonFrame = skf
      // Save raw skeleton frames (video coords) for smoothing
      skf.bodyJoints.forEach((p, j) => { cotrackerBodyJointFrames[j].push(p) })
      skf.legs.forEach((legF, li) => {
        const zoneId = skeleton.legs[li].zoneId
        cotrackerLegBoneFrames[zoneId].hip.push(legF.hip)
        cotrackerLegBoneFrames[zoneId].knee.push(legF.knee)
        cotrackerLegBoneFrames[zoneId].foot.push(legF.foot)
      })

      // Body LBS
      const bodyJointsImg = skf.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
      const bodyMatrices: AffineMatrix[] = []
      for (let i = 0; i < restBodySubBones.length; i++) {
        const curr = { head: bodyJointsImg[i], tail: bodyJointsImg[i + 1] }
        const rest = restBodySubBones[i]
        bodyMatrices.push(boneLocalMatrix(computeBoneTransform(rest.head, rest.tail, curr.head, curr.tail)))
      }
      walkBodyFrames[f] = skinVerticesSubBones(tri.bodyPoints, bodyWeights, bodyMatrices)

      // Legs LBS
      for (let li = 0; li < skeleton.legs.length; li++) {
        const leg = skeleton.legs[li]
        const legF = skf.legs[li]
        const hipI = videoToImage(legF.hip, imgW, imgH, vidW, vidH)
        const kneeI = videoToImage(legF.knee, imgW, imgH, vidW, vidH)
        const footI = videoToImage(legF.foot, imgW, imgH, vidW, vidH)
        const rest = legSubBones[leg.zoneId]
        const matrices: AffineMatrix[] = [
          boneLocalMatrix(computeBoneTransform(rest[0].head, rest[0].tail, hipI, kneeI)),
          boneLocalMatrix(computeBoneTransform(rest[1].head, rest[1].tail, kneeI, footI)),
        ]
        const zonePts = tri.zonePoints[leg.zoneId]
        const zoneW = legWeights[leg.zoneId]
        if (zonePts && zoneW) {
          walkZoneFrames[leg.zoneId][f] = skinVerticesSubBones(zonePts, zoneW, matrices)
        }
      }

      if (f % 5 === 0) setProgress({ frame: f, total: totalFrames, phase: 'LBS' })
    }

    const updatedAnim: Animation = {
      ...animation,
      mesh: {
        ...mesh,
        walkBodyFrames,
        walkZoneFrames,
        walkBodyFramesSmoothed: null,
        walkZoneFramesSmoothed: null,
        walkBodyFramesSmoothingValidated: false,
        walkZoneFramesSmoothingValidated: false,
        cotrackerBodyJointFrames,
        cotrackerLegBoneFrames,
        cotrackerBodyJointFramesSmoothed: null,
        cotrackerLegBoneFramesSmoothed: null,
        cotrackerBoneSmoothingValidated: false,
      },
    }
    await onSave(
      { ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) },
      [
        { animationId: animation.id, field: 'walkBodyFrames' },
        { animationId: animation.id, field: 'walkZoneFrames' },
      ],
    )
    setProgress(null)
  }

  if (!ready) {
    return (
      <div className="step-content">
        <p>Pré-requis pour le calcul :</p>
        <ul>
          <li>{mesh?.cotrackerTrackingValidated ? '✓' : '○'} Tracking CoTracker3 validé</li>
          <li>{mesh?.cotrackerBonesValidated ? '✓' : '○'} Squelette validé</li>
          <li>{tri?.step3Validated ? '✓' : '○'} Triangulation projet validée jusqu'aux faces cachées</li>
        </ul>
      </div>
    )
  }

  return (
    <div className="step-content">
      <h2>Calcul de l'animation</h2>
      <p>
        Body LBS via body chain sub-bones + Leg LBS (IK 2-bones) — réutilise la topologie de la Triangulation projet
        (body + 4 pattes). Sortie : <code>walkBodyFrames</code> + <code>walkZoneFrames</code>.
      </p>
      <button className="btn-primary" onClick={handleCompute} disabled={progress != null}>
        {progress ? `Calcul… (${progress.phase} ${progress.frame}/${progress.total})` : 'Calculer'}
      </button>
      {error && <p style={{ color: '#f87171' }}>{error}</p>}
      {mesh.walkBodyFrames && mesh.walkZoneFrames && (
        <p style={{ color: '#22c55e' }}>
          ✓ Calculé : body {mesh.walkBodyFrames.length} frames, pattes {Object.keys(mesh.walkZoneFrames).length} zones
        </p>
      )}
      <TriangulationLoopPreview project={project} animation={animation} />
    </div>
  )
}
