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
  resolveBodyChain,
  resolveSkeletonFrame,
  computeLegRestPose,
  type Sam2SkeletonFrame,
} from './sam2BoneSolver'
import { precomputeARAP, batchSolveARAP } from './arapSolver'

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

// ─── V2: Split body/leg computation ─────────────────────────────────

function imageToVideo(p: Point2D, imgW: number, imgH: number, vidW: number, vidH: number): Point2D {
  return { x: p.x * (vidW / imgW), y: p.y * (imgH > 0 ? vidH / imgH : 1) }
}

/**
 * V2: Compute auto-weights for body vertices only (body chain sub-bones).
 */
export function computeBodyAutoWeights(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  imgW: number, imgH: number,
  vidW: number, vidH: number,
): number[][] {
  const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames))
  const frame0 = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null)
  const bodyJointsImg = frame0.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))

  const bodySubBones: { head: Point2D; tail: Point2D }[] = []
  for (let i = 0; i < bodyJointsImg.length - 1; i++) {
    bodySubBones.push({ head: bodyJointsImg[i], tail: bodyJointsImg[i + 1] })
  }

  return computeWeightsForVertices(triangulation.bodyPoints, bodySubBones)
}

/**
 * V2: Compute body animation only (LBS with body chain sub-bones).
 * Returns walkBodyFrames in IMAGE coords.
 */
export function computeBodyAnimation(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  bodyWeights: number[][],
  imgW: number, imgH: number,
  vidW: number, vidH: number,
  onProgress?: (frame: number, total: number) => void,
): Point2D[][] {
  const firstZoneFrames = Object.values(anchorFrames)[0]
  if (!firstZoneFrames || firstZoneFrames.length === 0) return []
  const totalFrames = firstZoneFrames.length

  const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames))
  const restFrame = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null)
  const restBodyJoints = restFrame.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))

  const restBodySubBones: { head: Point2D; tail: Point2D }[] = []
  for (let i = 0; i < restBodyJoints.length - 1; i++) {
    restBodySubBones.push({ head: restBodyJoints[i], tail: restBodyJoints[i + 1] })
  }

  const walkBodyFrames: Point2D[][] = new Array(totalFrames)

  for (let f = 0; f < totalFrames; f++) {
    const bodyJoints = resolveBodyChain(skeleton.bodyChain, anchorFrames, f)
    const currBodyJoints = bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))

    const bodyMatrices: AffineMatrix[] = []
    for (let i = 0; i < restBodySubBones.length; i++) {
      const rest = restBodySubBones[i]
      const curr = { head: currBodyJoints[i], tail: currBodyJoints[i + 1] }
      bodyMatrices.push(boneLocalMatrix(computeBoneTransform(rest.head, rest.tail, curr.head, curr.tail)))
    }
    walkBodyFrames[f] = lbsDeform(triangulation.bodyPoints, bodyWeights, bodyMatrices)
    onProgress?.(f + 1, totalFrames)
  }

  return walkBodyFrames
}

/**
 * V2: Compute auto-weights for leg zone vertices only (2 sub-bones per leg).
 * Uses walkBodyFrames frame 0 for legs with hipBodyVertexIndex.
 */
export function computeLegAutoWeights(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  imgW: number, imgH: number,
  vidW: number, vidH: number,
  walkBodyFramesF0?: Point2D[] | null,
): Record<string, number[][]> {
  // Convert body frame 0 to video coords for leg rest pose computation
  const bodyF0Vid = walkBodyFramesF0
    ? walkBodyFramesF0.map(p => imageToVideo(p, imgW, imgH, vidW, vidH))
    : null

  const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames, bodyF0Vid))
  const frame0 = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null, bodyF0Vid)

  const legsImg = frame0.legs.map(leg => ({
    hip: videoToImage(leg.hip, imgW, imgH, vidW, vidH),
    foot: videoToImage(leg.foot, imgW, imgH, vidW, vidH),
    knee: videoToImage(leg.knee, imgW, imgH, vidW, vidH),
  }))

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

  return zoneWeights
}

/**
 * V2: Compute leg animation only (LBS per zone), using walkBodyFrames for
 * legs with hipBodyVertexIndex. Returns walkZoneFrames in IMAGE coords.
 */
export function computeLegAnimation(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  zoneWeights: Record<string, number[][]>,
  walkBodyFrames: Point2D[][],
  imgW: number, imgH: number,
  vidW: number, vidH: number,
  onProgress?: (frame: number, total: number) => void,
): Record<string, Point2D[][]> {
  const firstZoneFrames = Object.values(anchorFrames)[0]
  if (!firstZoneFrames || firstZoneFrames.length === 0) return {}
  const totalFrames = firstZoneFrames.length

  // Convert body frame 0 to video coords for rest pose
  const bodyF0Vid = walkBodyFrames[0]
    ? walkBodyFrames[0].map(p => imageToVideo(p, imgW, imgH, vidW, vidH))
    : null

  const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames, bodyF0Vid))
  const restFrame = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null, bodyF0Vid)

  const restLegs = restFrame.legs.map(leg => ({
    hip: videoToImage(leg.hip, imgW, imgH, vidW, vidH),
    foot: videoToImage(leg.foot, imgW, imgH, vidW, vidH),
    knee: videoToImage(leg.knee, imgW, imgH, vidW, vidH),
  }))

  const restLegSubBones: Record<string, { head: Point2D; tail: Point2D }[]> = {}
  for (let li = 0; li < skeleton.legs.length; li++) {
    const zoneId = skeleton.legs[li].zoneId
    restLegSubBones[zoneId] = [
      { head: restLegs[li].hip, tail: restLegs[li].knee },
      { head: restLegs[li].knee, tail: restLegs[li].foot },
    ]
  }

  const walkZoneFrames: Record<string, Point2D[][]> = {}
  for (const leg of skeleton.legs) {
    walkZoneFrames[leg.zoneId] = new Array(totalFrames)
  }

  let prevFrame: Sam2SkeletonFrame | null = null

  for (let f = 0; f < totalFrames; f++) {
    // Convert current body frame to video coords for hip override
    const bodyFVid = walkBodyFrames[f]
      ? walkBodyFrames[f].map(p => imageToVideo(p, imgW, imgH, vidW, vidH))
      : null

    const skelFrame = resolveSkeletonFrame(skeleton, anchorFrames, f, legRestPoses, prevFrame, bodyFVid)
    prevFrame = skelFrame

    const currLegs = skelFrame.legs.map(leg => ({
      hip: videoToImage(leg.hip, imgW, imgH, vidW, vidH),
      foot: videoToImage(leg.foot, imgW, imgH, vidW, vidH),
      knee: videoToImage(leg.knee, imgW, imgH, vidW, vidH),
    }))

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

  return walkZoneFrames
}

// ─── V3: Leg LBS from pre-resolved (smoothed) hip/knee/foot per frame ──

/**
 * V3 variant of computeLegAnimation that bypasses per-frame skeleton resolution
 * (resolveSkeletonFrame + IK 2-bones) and instead consumes pre-resolved hip/knee/foot
 * trajectories per zone (typically Butterworth-smoothed at the Lissage Bones Pattes step).
 *
 * legBoneFrames are in VIDEO coords (same as resolveSkeletonFrame output).
 * Frame 0 of legBoneFrames is taken as the rest pose for each leg.
 */
export function computeLegAnimationFromBoneFrames(
  triangulation: ProjectTriangulation,
  skeleton: Sam2Skeleton,
  legBoneFrames: Record<string, { hip: Point2D[]; knee: Point2D[]; foot: Point2D[] }>,
  zoneWeights: Record<string, number[][]>,
  imgW: number, imgH: number,
  vidW: number, vidH: number,
  onProgress?: (frame: number, total: number) => void,
): Record<string, Point2D[][]> {
  const firstZoneId = skeleton.legs[0]?.zoneId
  const firstFrames = firstZoneId ? legBoneFrames[firstZoneId] : null
  if (!firstFrames || firstFrames.hip.length === 0) return {}
  const totalFrames = firstFrames.hip.length

  // Rest pose per leg (frame 0, image coords)
  const restLegSubBones: Record<string, { head: Point2D; tail: Point2D }[]> = {}
  for (const leg of skeleton.legs) {
    const f = legBoneFrames[leg.zoneId]
    if (!f) continue
    const hip0 = videoToImage(f.hip[0], imgW, imgH, vidW, vidH)
    const knee0 = videoToImage(f.knee[0], imgW, imgH, vidW, vidH)
    const foot0 = videoToImage(f.foot[0], imgW, imgH, vidW, vidH)
    restLegSubBones[leg.zoneId] = [
      { head: hip0, tail: knee0 },
      { head: knee0, tail: foot0 },
    ]
  }

  const walkZoneFrames: Record<string, Point2D[][]> = {}
  for (const leg of skeleton.legs) {
    walkZoneFrames[leg.zoneId] = new Array(totalFrames)
  }

  for (let f = 0; f < totalFrames; f++) {
    for (const leg of skeleton.legs) {
      const fr = legBoneFrames[leg.zoneId]
      const restSubs = restLegSubBones[leg.zoneId]
      if (!fr || !restSubs) continue

      const hip = videoToImage(fr.hip[f], imgW, imgH, vidW, vidH)
      const knee = videoToImage(fr.knee[f], imgW, imgH, vidW, vidH)
      const foot = videoToImage(fr.foot[f], imgW, imgH, vidW, vidH)

      const legMatrices: AffineMatrix[] = [
        boneLocalMatrix(computeBoneTransform(restSubs[0].head, restSubs[0].tail, hip, knee)),
        boneLocalMatrix(computeBoneTransform(restSubs[1].head, restSubs[1].tail, knee, foot)),
      ]

      const zonePts = triangulation.zonePoints[leg.zoneId]
      const zoneW = zoneWeights[leg.zoneId]
      if (zonePts && zoneW) {
        walkZoneFrames[leg.zoneId][f] = lbsDeform(zonePts, zoneW, legMatrices)
      }
    }
    onProgress?.(f + 1, totalFrames)
  }

  return walkZoneFrames
}

// ─── V3: ARAP body animation from inherited topology ───────────────

/**
 * V3: Compute body animation via ARAP from `projectTriangulation` topology.
 * The body contour vertices (first N indices of bodyPoints, where N comes from
 * `zoneContourLength['body']`) are pinned at positions provided per frame
 * (already in IMAGE coords, lissés ou bruts). Internal vertices deform via ARAP.
 *
 * Returns walkBodyFrames in IMAGE coords (length = bodyPoints.length per frame).
 */
export function computeBodyAnimationARAP(
  triangulation: ProjectTriangulation,
  smoothedContourFrames: Point2D[][],  // [frame][vertex] in IMAGE coords, length = N_contour per frame
  onProgress?: (frame: number, total: number) => void,
): Point2D[][] {
  const bodyPoints = triangulation.bodyPoints
  const bodyTriangles = triangulation.bodyTriangles
  if (!bodyPoints?.length || !bodyTriangles?.length) {
    throw new Error('[computeBodyAnimationARAP] missing bodyPoints/bodyTriangles')
  }
  if (!smoothedContourFrames?.length) {
    throw new Error('[computeBodyAnimationARAP] missing contour frames')
  }

  // Determine N_contour : explicit field, else infer from frames length
  const nContour = triangulation.zoneContourLength?.['body']
    ?? smoothedContourFrames[0]?.length
    ?? 0
  if (nContour <= 0) {
    throw new Error('[computeBodyAnimationARAP] zoneContourLength["body"] missing or invalid')
  }
  if (nContour > bodyPoints.length) {
    throw new Error(`[computeBodyAnimationARAP] N_contour (${nContour}) > bodyPoints (${bodyPoints.length})`)
  }

  // Validate frames length
  for (let f = 0; f < smoothedContourFrames.length; f++) {
    if (smoothedContourFrames[f].length !== nContour) {
      throw new Error(`[computeBodyAnimationARAP] frame ${f} has ${smoothedContourFrames[f].length} vertices, expected ${nContour}`)
    }
  }

  // Pinned indices = first N_contour vertices of bodyPoints
  const pinnedIndices: number[] = []
  for (let i = 0; i < nContour; i++) pinnedIndices.push(i)

  // Precompute ARAP system once with rest pose
  const sys = precomputeARAP(bodyPoints, bodyTriangles, pinnedIndices)

  // Batch solve : provides pinned positions per frame (already in same order as pinnedIndices)
  return batchSolveARAP(sys, smoothedContourFrames, 3, onProgress)
}

// ─── Shared LBS ─────────────────────────────────────────────────────

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
