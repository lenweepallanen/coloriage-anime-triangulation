/**
 * Members-Bones Triangulation Solver
 *
 * Computes per-zone auto-weights and LBS animation from a ProjectTriangulation
 * (project-level mesh) driven by a Sam2Skeleton (members-bones animation).
 *
 * Key concept: the triangulation vertices live in IMAGE coords, while the
 * skeleton is resolved in VIDEO coords. All skeleton positions are rescaled
 * to image coords before computing transforms.
 */

import type { Point2D, ProjectTriangulation, Sam2Skeleton } from '../types/project'
import {
  pointToSegmentDistanceSq,
  computeBoneTransform,
  boneLocalMatrix,
  type AffineMatrix,
} from './boneSolver'
import {
  resolveSkeletonFrame,
  computeLegRestPose,
  type LegRestPose,
  type Sam2SkeletonFrame,
} from './sam2BoneSolver'

const WEIGHT_EPSILON = 1.0
const WEIGHT_THRESHOLD = 0.01

// ─── Coordinate rescaling ────────────────────────────────────────────

function videoToImage(p: Point2D, imgW: number, imgH: number, vidW: number, vidH: number): Point2D {
  return { x: p.x * (imgW / vidW), y: p.y * (imgH / vidH) }
}

// ─── Auto-weights (strict per zone) ─────────────────────────────────

interface TriangWeights {
  /** bodyWeights[vertexIdx][bodySubBoneIdx] — body chain sub-bones only */
  bodyWeights: number[][]
  /** zoneWeights[zoneId][vertexIdx][legSubBoneIdx] — 2 sub-bones per leg (hip→knee, knee→foot) */
  zoneWeights: Record<string, number[][]>
}

/**
 * Compute auto-weights for project triangulation vertices, strictly per zone.
 * Body chain bones influence body vertices only, each leg's bones influence
 * only that leg zone's vertices.
 */
export function computeTriangAutoWeights(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  imgW: number, imgH: number,
  vidW: number, vidH: number,
): TriangWeights {
  // Resolve skeleton at frame 0 (rest pose)
  const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames))
  const frame0 = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null)

  // Convert all skeleton positions to image coords
  const bodyJointsImg = frame0.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
  const legsImg = frame0.legs.map(leg => ({
    hip: videoToImage(leg.hip, imgW, imgH, vidW, vidH),
    foot: videoToImage(leg.foot, imgW, imgH, vidW, vidH),
    knee: videoToImage(leg.knee, imgW, imgH, vidW, vidH),
  }))

  // --- Body chain sub-bones ---
  const bodySubBones: { head: Point2D; tail: Point2D }[] = []
  for (let i = 0; i < bodyJointsImg.length - 1; i++) {
    bodySubBones.push({ head: bodyJointsImg[i], tail: bodyJointsImg[i + 1] })
  }

  // Body vertex weights
  const bodyPts = triangulation.bodyPoints
  const bodyWeights = computeWeightsForVertices(bodyPts, bodySubBones)

  // --- Leg sub-bones (per zone) ---
  const zoneWeights: Record<string, number[][]> = {}
  for (let li = 0; li < skeleton.legs.length; li++) {
    const leg = skeleton.legs[li]
    const legImg = legsImg[li]
    const legSubBones = [
      { head: legImg.hip, tail: legImg.knee },
      { head: legImg.knee, tail: legImg.foot },
    ]
    const zonePts = triangulation.zonePoints[leg.zoneId]
    if (zonePts) {
      zoneWeights[leg.zoneId] = computeWeightsForVertices(zonePts, legSubBones)
    }
  }

  return { bodyWeights, zoneWeights }
}

/** Inverse-distance weights from vertices to bone segments, normalized per vertex. */
function computeWeightsForVertices(
  vertices: Point2D[],
  subBones: { head: Point2D; tail: Point2D }[],
): number[][] {
  const n = vertices.length
  const numBones = subBones.length
  const weights: number[][] = new Array(n)

  for (let i = 0; i < n; i++) {
    const w = new Array(numBones)
    let sum = 0
    for (let j = 0; j < numBones; j++) {
      const dist = Math.sqrt(pointToSegmentDistanceSq(vertices[i], subBones[j].head, subBones[j].tail))
      const val = 1 / ((dist + WEIGHT_EPSILON) * (dist + WEIGHT_EPSILON))
      w[j] = val
      sum += val
    }
    // Normalize
    if (sum > 0) {
      for (let j = 0; j < numBones; j++) w[j] /= sum
    }
    // Threshold small weights
    let sum2 = 0
    for (let j = 0; j < numBones; j++) {
      if (w[j] < WEIGHT_THRESHOLD) w[j] = 0
      sum2 += w[j]
    }
    // Re-normalize after threshold
    if (sum2 > 0) {
      for (let j = 0; j < numBones; j++) w[j] /= sum2
    }
    weights[i] = w
  }
  return weights
}

// ─── LBS animation computation ──────────────────────────────────────

interface TriangAnimationResult {
  walkZoneFrames: Record<string, Point2D[][]>  // zoneId → [frame][vertex]
  walkBodyFrames: Point2D[][]                   // [frame][vertex]
}

/**
 * Compute the full animation: for each frame, resolve the skeleton in video coords,
 * rescale to image coords, compute bone transforms vs rest pose, and LBS-deform
 * all triangulation vertices (body + per-zone).
 */
export function computeTriangAnimation(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  bodyWeights: number[][],
  zoneWeights: Record<string, number[][]>,
  imgW: number, imgH: number,
  vidW: number, vidH: number,
  onProgress?: (frame: number, total: number) => void,
): TriangAnimationResult {
  // Determine total frames from anchor data
  const firstZoneFrames = Object.values(anchorFrames)[0]
  if (!firstZoneFrames || firstZoneFrames.length === 0) {
    return { walkZoneFrames: {}, walkBodyFrames: [] }
  }
  const totalFrames = firstZoneFrames.length

  // Compute leg rest poses and rest skeleton (frame 0)
  const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames))
  const restFrame = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null)

  // Rest pose bone positions in IMAGE coords
  const restBodyJoints = restFrame.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
  const restLegs = restFrame.legs.map(leg => ({
    hip: videoToImage(leg.hip, imgW, imgH, vidW, vidH),
    foot: videoToImage(leg.foot, imgW, imgH, vidW, vidH),
    knee: videoToImage(leg.knee, imgW, imgH, vidW, vidH),
  }))

  // Rest body chain sub-bones
  const restBodySubBones: { head: Point2D; tail: Point2D }[] = []
  for (let i = 0; i < restBodyJoints.length - 1; i++) {
    restBodySubBones.push({ head: restBodyJoints[i], tail: restBodyJoints[i + 1] })
  }

  // Rest leg sub-bones per zone
  const restLegSubBones: Record<string, { head: Point2D; tail: Point2D }[]> = {}
  for (let li = 0; li < skeleton.legs.length; li++) {
    const zoneId = skeleton.legs[li].zoneId
    restLegSubBones[zoneId] = [
      { head: restLegs[li].hip, tail: restLegs[li].knee },
      { head: restLegs[li].knee, tail: restLegs[li].foot },
    ]
  }

  // Output arrays
  const walkBodyFrames: Point2D[][] = new Array(totalFrames)
  const walkZoneFrames: Record<string, Point2D[][]> = {}
  for (const leg of skeleton.legs) {
    walkZoneFrames[leg.zoneId] = new Array(totalFrames)
  }

  let prevFrame: Sam2SkeletonFrame | null = null

  for (let f = 0; f < totalFrames; f++) {
    // Resolve skeleton at this frame (video coords)
    const skelFrame = resolveSkeletonFrame(skeleton, anchorFrames, f, legRestPoses, prevFrame)
    prevFrame = skelFrame

    // Convert to image coords
    const currBodyJoints = skelFrame.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
    const currLegs = skelFrame.legs.map(leg => ({
      hip: videoToImage(leg.hip, imgW, imgH, vidW, vidH),
      foot: videoToImage(leg.foot, imgW, imgH, vidW, vidH),
      knee: videoToImage(leg.knee, imgW, imgH, vidW, vidH),
    }))

    // --- Body chain LBS ---
    const bodyMatrices: AffineMatrix[] = []
    for (let i = 0; i < restBodySubBones.length; i++) {
      const rest = restBodySubBones[i]
      const curr = { head: currBodyJoints[i], tail: currBodyJoints[i + 1] }
      const transform = computeBoneTransform(rest.head, rest.tail, curr.head, curr.tail)
      bodyMatrices.push(boneLocalMatrix(transform))
    }
    walkBodyFrames[f] = lbsDeform(triangulation.bodyPoints, bodyWeights, bodyMatrices)

    // --- Per-leg zone LBS ---
    for (let li = 0; li < skeleton.legs.length; li++) {
      const zoneId = skeleton.legs[li].zoneId
      const restSubs = restLegSubBones[zoneId]
      if (!restSubs) continue

      const legMatrices: AffineMatrix[] = [
        boneLocalMatrix(computeBoneTransform(restSubs[0].head, restSubs[0].tail, currLegs[li].hip, currLegs[li].knee)),
        boneLocalMatrix(computeBoneTransform(restSubs[1].head, restSubs[1].tail, currLegs[li].knee, currLegs[li].foot)),
      ]

      const zonePts = triangulation.zonePoints[zoneId]
      const zoneW = zoneWeights[zoneId]
      if (zonePts && zoneW) {
        walkZoneFrames[zoneId][f] = lbsDeform(zonePts, zoneW, legMatrices)
      }
    }

    onProgress?.(f + 1, totalFrames)
  }

  return { walkZoneFrames, walkBodyFrames }
}

/** Apply LBS: for each vertex, blend affine-transformed position by weights. */
function lbsDeform(
  restPoints: Point2D[],
  weights: number[][],
  matrices: AffineMatrix[],
): Point2D[] {
  const n = restPoints.length
  const out: Point2D[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const p = restPoints[i]
    const w = weights[i]
    let x = 0, y = 0
    for (let j = 0; j < matrices.length; j++) {
      if (w[j] <= 0) continue
      const [a, b, tx, c, d, ty] = matrices[j]
      x += w[j] * (a * p.x + b * p.y + tx)
      y += w[j] * (c * p.x + d * p.y + ty)
    }
    out[i] = { x, y }
  }
  return out
}
