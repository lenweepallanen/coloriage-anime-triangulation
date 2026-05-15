/**
 * Bone Solver — Skeletal animation engine for bone-type animations.
 *
 * Bones are defined by head/tail endpoints positioned relative to pairs of
 * tracked anchor points. Vertex deformation uses Linear Blend Skinning (LBS)
 * with auto-computed inverse-distance weights.
 *
 * Bones can optionally have an **elbow** (coude) joint, creating a 2-bone IK
 * chain. The elbow position is computed procedurally to maintain constant
 * segment lengths when the head and tail move closer/further apart.
 */

import type { Point2D, Bone, BoneEndpointRef, ElbowMode } from '../types/project'

// ─── Geometry helpers ────────────────────────────────────────────────────

export function pointToSegmentDistanceSq(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const projX = a.x + t * dx
  const projY = a.y + t * dy
  return (p.x - projX) ** 2 + (p.y - projY) ** 2
}

// ─── Bone endpoint computation ───────────────────────────────────────────

/**
 * Compute world-space position of a bone endpoint from tracked anchor positions.
 * Local coordinate frame: origin = anchorA, x-axis = A→B, y-axis = perp(A→B).
 * localX/localY are normalized by |A-B|.
 */
export function computeBoneEndpoint(ref: BoneEndpointRef, trackedPositions: Point2D[]): Point2D {
  const a = trackedPositions[ref.anchorIndexA]
  const b = trackedPositions[ref.anchorIndexB]
  const dx = b.x - a.x
  const dy = b.y - a.y
  // perp = rotate90 CCW of (dx, dy) = (-dy, dx)
  return {
    x: a.x + ref.localX * dx + ref.localY * (-dy),
    y: a.y + ref.localX * dy + ref.localY * dx,
  }
}

// ─── Elbow IK solver ─────────────────────────────────────────────────────

/**
 * Solve 2-bone IK: find elbow position given head, tail, segment lengths, and bend side.
 * Uses circle-circle intersection (triangle cosine rule).
 */
export function solveElbowIK(
  head: Point2D, tail: Point2D,
  len1: number, len2: number,
  bendSide: number,
): Point2D {
  const dx = tail.x - head.x
  const dy = tail.y - head.y
  const d = Math.hypot(dx, dy)

  // Fully extended or beyond reach
  if (d >= len1 + len2 || d < 0.001) {
    const dirX = d > 0 ? dx / d : 1
    const dirY = d > 0 ? dy / d : 0
    return { x: head.x + dirX * len1, y: head.y + dirY * len1 }
  }

  // Degenerate: one segment much longer than the other
  if (d <= Math.abs(len1 - len2)) {
    const dirX = dx / d
    const dirY = dy / d
    return { x: head.x + dirX * len1, y: head.y + dirY * len1 }
  }

  // Triangle cosine rule: angle at head
  const cosA = (len1 * len1 + d * d - len2 * len2) / (2 * len1 * d)
  const cosAClamped = Math.max(-1, Math.min(1, cosA))
  const sinA = Math.sqrt(1 - cosAClamped * cosAClamped)

  const dirX = dx / d
  const dirY = dy / d
  const perpX = -dirY  // rotate 90° CCW
  const perpY = dirX

  return {
    x: head.x + dirX * (len1 * cosAClamped) + perpX * (bendSide * len1 * sinA),
    y: head.y + dirY * (len1 * cosAClamped) + perpY * (bendSide * len1 * sinA),
  }
}

/**
 * Compute elbow IK parameters from rest-pose positions.
 */
export function getElbowParams(
  headRest: Point2D, tailRest: Point2D, elbowRest: Point2D,
): { len1: number; len2: number; bendSide: number } {
  const len1 = Math.hypot(elbowRest.x - headRest.x, elbowRest.y - headRest.y)
  const len2 = Math.hypot(tailRest.x - elbowRest.x, tailRest.y - elbowRest.y)
  // bendSide = sign of cross product (tail-head) × (elbow-head)
  const cross = (tailRest.x - headRest.x) * (elbowRest.y - headRest.y)
    - (tailRest.y - headRest.y) * (elbowRest.x - headRest.x)
  const bendSide = cross >= 0 ? 1 : -1
  return { len1, len2, bendSide }
}

// ─── Rest pose ───────────────────────────────────────────────────────────

export interface BonePose {
  head: Point2D
  tail: Point2D
  elbow?: Point2D       // rest elbow position (only if bone has elbowPos)
  elbowLen1?: number
  elbowLen2?: number
  elbowBendSide?: number
}

export function computeBoneRestPose(
  bones: Bone[],
  restTrackedPositions: Point2D[],
): Map<string, BonePose> {
  const result = new Map<string, BonePose>()
  for (const bone of bones) {
    const head = computeBoneEndpoint(bone.head, restTrackedPositions)
    const tail = computeBoneEndpoint(bone.tail, restTrackedPositions)
    const pose: BonePose = { head, tail }

    if (bone.elbowPos) {
      const params = getElbowParams(head, tail, bone.elbowPos)
      pose.elbow = bone.elbowPos
      pose.elbowLen1 = params.len1
      pose.elbowLen2 = params.len2
      pose.elbowBendSide = params.bendSide
    }

    result.set(bone.id, pose)
  }
  return result
}

// ─── Sub-bone expansion ──────────────────────────────────────────────────

/**
 * A sub-bone is an internal segment used for weight computation and skinning.
 * Bones without elbow → 1 sub-bone. Bones with elbow → 2 sub-bones.
 */
export interface SubBone {
  restHead: Point2D
  restTail: Point2D
  boneIndex: number     // index in the original bones array
  subIndex: number      // 0 = head→elbow (or head→tail), 1 = elbow→tail
}

/**
 * Expand bones into sub-bones for rest pose.
 * Returns sub-bones array and a mapping: boneIndex → [subBoneIndices].
 */
export function expandToSubBones(
  bones: Bone[],
  restPose: Map<string, BonePose>,
): { subBones: SubBone[]; boneToSub: number[][] } {
  const subBones: SubBone[] = []
  const boneToSub: number[][] = []

  for (let bi = 0; bi < bones.length; bi++) {
    const bone = bones[bi]
    const pose = restPose.get(bone.id)!
    const indices: number[] = []

    if (bone.elbowPos && pose.elbow) {
      // 2 sub-bones: head→elbow, elbow→tail
      indices.push(subBones.length)
      subBones.push({ restHead: pose.head, restTail: pose.elbow, boneIndex: bi, subIndex: 0 })
      indices.push(subBones.length)
      subBones.push({ restHead: pose.elbow, restTail: pose.tail, boneIndex: bi, subIndex: 1 })
    } else {
      // 1 sub-bone: head→tail
      indices.push(subBones.length)
      subBones.push({ restHead: pose.head, restTail: pose.tail, boneIndex: bi, subIndex: 0 })
    }

    boneToSub.push(indices)
  }

  return { subBones, boneToSub }
}

// ─── Per-bone rigid transform ────────────────────────────────────────────

export interface BoneTransform {
  angle: number   // rotation in radians
  headRest: Point2D
  headCurr: Point2D
}

/**
 * Compute rigid transform (rotation + translation) for a single segment.
 * Transform maps rest-pose points to current-frame points:
 *   p' = rotate(p - restHead, angle) + currHead
 */
export function computeBoneTransform(
  restHead: Point2D, restTail: Point2D,
  currHead: Point2D, currTail: Point2D,
): BoneTransform {
  const restAngle = Math.atan2(restTail.y - restHead.y, restTail.x - restHead.x)
  const currAngle = Math.atan2(currTail.y - currHead.y, currTail.x - currHead.x)
  return {
    angle: currAngle - restAngle,
    headRest: restHead,
    headCurr: currHead,
  }
}

// ─── Forward kinematics ──────────────────────────────────────────────────

/**
 * 2D affine matrix [a, b, tx, c, d, ty] representing:
 *   x' = a*x + b*y + tx
 *   y' = c*x + d*y + ty
 */
export type AffineMatrix = [number, number, number, number, number, number]

function identityMatrix(): AffineMatrix {
  return [1, 0, 0, 0, 1, 0]
}


export function boneLocalMatrix(transform: BoneTransform): AffineMatrix {
  const cos = Math.cos(transform.angle)
  const sin = Math.sin(transform.angle)
  const { headRest, headCurr } = transform
  const tx = -cos * headRest.x + sin * headRest.y + headCurr.x
  const ty = -sin * headRest.x - cos * headRest.y + headCurr.y
  return [cos, -sin, tx, sin, cos, ty]
}

/**
 * Choose bendSide for elbow IK based on the elbow mode.
 * - 'rest': use the side determined at rest pose placement (fixed)
 * - 'centroid': choose the side closest to the centroid of tracked points (towards interior)
 * - 'continuity': choose the side closest to previous frame's elbow position
 */
function chooseBendSide(
  mode: ElbowMode,
  head: Point2D, tail: Point2D,
  len1: number, len2: number,
  restBendSide: number,
  centroid: Point2D | null,
  prevElbow: Point2D | null,
): number {
  if (mode === 'rest' || (!centroid && !prevElbow)) return restBendSide

  if (mode === 'centroid' && centroid) {
    const ePlus = solveElbowIK(head, tail, len1, len2, +1)
    const eMinus = solveElbowIK(head, tail, len1, len2, -1)
    const dPlus = Math.hypot(ePlus.x - centroid.x, ePlus.y - centroid.y)
    const dMinus = Math.hypot(eMinus.x - centroid.x, eMinus.y - centroid.y)
    return dPlus <= dMinus ? +1 : -1
  }

  if (mode === 'continuity' && prevElbow) {
    const ePlus = solveElbowIK(head, tail, len1, len2, +1)
    const eMinus = solveElbowIK(head, tail, len1, len2, -1)
    const dPlus = Math.hypot(ePlus.x - prevElbow.x, ePlus.y - prevElbow.y)
    const dMinus = Math.hypot(eMinus.x - prevElbow.x, eMinus.y - prevElbow.y)
    return dPlus <= dMinus ? +1 : -1
  }

  return restBendSide
}

/**
 * Resolve current-frame head, tail, and optional elbow for a bone.
 * Handles fixedLength and elbow IK with dynamic bendSide.
 */
function resolveBonePositions(
  bone: Bone,
  restPose: BonePose,
  trackedPositions: Point2D[],
  centroid: Point2D | null,
  prevElbow: Point2D | null,
): { head: Point2D; tail: Point2D; elbow?: Point2D } {
  const head = computeBoneEndpoint(bone.head, trackedPositions)
  let tail = computeBoneEndpoint(bone.tail, trackedPositions)

  // Enforce fixed length (for the full head→tail span)
  if (bone.fixedLength && !bone.elbowPos) {
    const restLen = Math.hypot(restPose.tail.x - restPose.head.x, restPose.tail.y - restPose.head.y)
    const dx = tail.x - head.x, dy = tail.y - head.y
    const currLen = Math.hypot(dx, dy)
    if (currLen > 0) {
      const scale = restLen / currLen
      tail = { x: head.x + dx * scale, y: head.y + dy * scale }
    }
  }

  // Elbow IK
  if (bone.elbowPos && restPose.elbowLen1 != null && restPose.elbowLen2 != null && restPose.elbowBendSide != null) {
    const mode = bone.elbowMode ?? 'rest'
    const bendSide = chooseBendSide(
      mode, head, tail, restPose.elbowLen1, restPose.elbowLen2,
      restPose.elbowBendSide, centroid, prevElbow,
    )
    const elbow = solveElbowIK(head, tail, restPose.elbowLen1, restPose.elbowLen2, bendSide)
    return { head, tail, elbow }
  }

  return { head, tail }
}

/**
 * Compute world-space skinning matrices for all sub-bones via forward kinematics.
 * Returns an array of AffineMatrix, one per sub-bone (indexed same as expandToSubBones output).
 */
export function computeSubBoneMatrices(
  bones: Bone[],
  restPose: Map<string, BonePose>,
  trackedPositions: Point2D[],
  subBones: SubBone[],
  boneToSub: number[][],
  centroid?: Point2D | null,
  prevElbows?: Map<string, Point2D> | null,
): AffineMatrix[] {
  const boneIndexMap = new Map(bones.map((b, i) => [b.id, i]))
  const matrices: AffineMatrix[] = new Array(subBones.length).fill(null)

  for (const bone of bones) {
    const bi = boneIndexMap.get(bone.id)!
    const rest = restPose.get(bone.id)!
    const resolved = resolveBonePositions(bone, rest, trackedPositions, centroid ?? null, prevElbows?.get(bone.id) ?? null)
    const subIndices = boneToSub[bi]

    if (resolved.elbow && subIndices.length === 2) {
      // Sub-bone 0: head → elbow
      const t0 = computeBoneTransform(rest.head, rest.elbow!, resolved.head, resolved.elbow)
      matrices[subIndices[0]] = boneLocalMatrix(t0)

      // Sub-bone 1: elbow → tail
      const t1 = computeBoneTransform(rest.elbow!, rest.tail, resolved.elbow, resolved.tail)
      matrices[subIndices[1]] = boneLocalMatrix(t1)
    } else {
      // Single sub-bone: head → tail
      const t = computeBoneTransform(rest.head, rest.tail, resolved.head, resolved.tail)
      matrices[subIndices[0]] = boneLocalMatrix(t)
    }
  }

  return matrices
}

// ─── Auto-weights (inverse distance) ────────────────────────────────────

const WEIGHT_EPSILON = 1.0
const WEIGHT_THRESHOLD = 0.01

/**
 * Compute skinning weights for all vertices via inverse-square distance to sub-bone segments.
 * Returns weights[vertexIndex][subBoneIndex], normalized per vertex.
 */
export function computeAutoWeights(
  allRestPoints: Point2D[],
  bones: Bone[],
  restPose: Map<string, BonePose>,
): number[][] {
  const { subBones } = expandToSubBones(bones, restPose)
  const nVerts = allRestPoints.length
  const nSub = subBones.length
  const weights: number[][] = new Array(nVerts)

  for (let i = 0; i < nVerts; i++) {
    const p = allRestPoints[i]
    const raw = new Array<number>(nSub)
    let sum = 0

    for (let j = 0; j < nSub; j++) {
      const sb = subBones[j]
      const distSq = pointToSegmentDistanceSq(p, sb.restHead, sb.restTail)
      const dist = Math.sqrt(distSq)
      const w = 1.0 / ((dist + WEIGHT_EPSILON) * (dist + WEIGHT_EPSILON))
      raw[j] = w
      sum += w
    }

    if (sum > 0) {
      for (let j = 0; j < nSub; j++) raw[j] /= sum
    }

    let sum2 = 0
    for (let j = 0; j < nSub; j++) {
      if (raw[j] < WEIGHT_THRESHOLD) raw[j] = 0
      sum2 += raw[j]
    }
    if (sum2 > 0) {
      for (let j = 0; j < nSub; j++) raw[j] /= sum2
    }

    weights[i] = raw
  }

  return weights
}

// ─── Linear Blend Skinning ───────────────────────────────────────────────

/**
 * Deform all vertices via LBS using sub-bone matrices and weights.
 */
export function skinVerticesSubBones(
  allRestPoints: Point2D[],
  boneWeights: number[][],
  matrices: AffineMatrix[],
): Point2D[] {
  const nVerts = allRestPoints.length
  const nSub = matrices.length
  const result: Point2D[] = new Array(nVerts)

  for (let i = 0; i < nVerts; i++) {
    const p = allRestPoints[i]
    const w = boneWeights[i]
    let x = 0, y = 0

    for (let j = 0; j < nSub; j++) {
      if (w[j] === 0) continue
      const m = matrices[j]
      x += w[j] * (m[0] * p.x + m[1] * p.y + m[2])
      y += w[j] * (m[3] * p.x + m[4] * p.y + m[5])
    }

    result[i] = { x, y }
  }

  return result
}

// Keep old API for backward compat (used nowhere currently but safe)
export function skinVertices(
  allRestPoints: Point2D[],
  boneWeights: number[][],
  worldMatrices: Map<string, AffineMatrix>,
  bones: Bone[],
): Point2D[] {
  const matrices: AffineMatrix[] = bones.map(b => worldMatrices.get(b.id) ?? identityMatrix())
  return skinVerticesSubBones(allRestPoints, boneWeights, matrices)
}

// ─── Batch solver ────────────────────────────────────────────────────────

/**
 * Compute videoFramesMesh for all frames using bone deformation.
 * Handles bones with and without elbow joints transparently.
 */
export function batchSolveBone(
  bones: Bone[],
  boneWeights: number[][],
  allRestPoints: Point2D[],
  trackedFrames: Point2D[][],
  restTrackedPositions: Point2D[],
  onProgress?: (frame: number, total: number) => void,
): Point2D[][] {
  const nFrames = trackedFrames.length
  const restPose = computeBoneRestPose(bones, restTrackedPositions)
  const { subBones, boneToSub } = expandToSubBones(bones, restPose)
  const result: Point2D[][] = new Array(nFrames)

  // Track previous elbow positions for 'continuity' mode
  let prevElbows: Map<string, Point2D> | null = null

  // Check if any bone uses centroid or continuity mode
  const needsCentroid = bones.some(b => b.elbowPos && b.elbowMode === 'centroid')
  const needsContinuity = bones.some(b => b.elbowPos && b.elbowMode === 'continuity')

  for (let f = 0; f < nFrames; f++) {
    const tracked = trackedFrames[f]

    // Compute centroid of tracked points (for 'centroid' mode)
    let centroid: Point2D | null = null
    if (needsCentroid && tracked.length > 0) {
      let cx = 0, cy = 0
      for (const p of tracked) { cx += p.x; cy += p.y }
      centroid = { x: cx / tracked.length, y: cy / tracked.length }
    }

    const matrices = computeSubBoneMatrices(
      bones, restPose, tracked, subBones, boneToSub,
      centroid, needsContinuity ? prevElbows : null,
    )
    result[f] = skinVerticesSubBones(allRestPoints, boneWeights, matrices)

    // Store current elbow positions for next frame's continuity
    if (needsContinuity) {
      const elbows = new Map<string, Point2D>()
      for (const bone of bones) {
        if (!bone.elbowPos) continue
        const rest = restPose.get(bone.id)!
        const resolved = resolveBonePositions(
          bone, rest, tracked, centroid, prevElbows?.get(bone.id) ?? null,
        )
        if (resolved.elbow) elbows.set(bone.id, resolved.elbow)
      }
      prevElbows = elbows
    }

    if (onProgress && f % 10 === 0) {
      onProgress(f, nFrames)
    }
  }

  if (onProgress) onProgress(nFrames, nFrames)
  return result
}

// ─── Legacy compat: computeWorldMatrices (still used by old code paths) ──

export function computeWorldMatrices(
  bones: Bone[],
  restPose: Map<string, BonePose>,
  trackedPositions: Point2D[],
): Map<string, AffineMatrix> {
  const worldMatrices = new Map<string, AffineMatrix>()

  for (const bone of bones) {
    const rest = restPose.get(bone.id)!
    const resolved = resolveBonePositions(bone, rest, trackedPositions, null, null)
    const localTransform = computeBoneTransform(rest.head, rest.tail, resolved.head, resolved.tail)
    worldMatrices.set(bone.id, boneLocalMatrix(localTransform))
  }

  return worldMatrices
}
