/**
 * Bone Solver — Skeletal animation engine for bone-type animations.
 *
 * Bones are defined by head/tail endpoints positioned relative to pairs of
 * tracked anchor points. Vertex deformation uses Linear Blend Skinning (LBS)
 * with auto-computed inverse-distance weights.
 */

import type { Point2D, Bone, BoneEndpointRef } from '../types/project'

// ─── Geometry helpers ────────────────────────────────────────────────────

function pointToSegmentDistanceSq(p: Point2D, a: Point2D, b: Point2D): number {
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

// ─── Rest pose ───────────────────────────────────────────────────────────

export interface BonePose {
  head: Point2D
  tail: Point2D
}

export function computeBoneRestPose(
  bones: Bone[],
  restTrackedPositions: Point2D[],
): Map<string, BonePose> {
  const result = new Map<string, BonePose>()
  for (const bone of bones) {
    result.set(bone.id, {
      head: computeBoneEndpoint(bone.head, restTrackedPositions),
      tail: computeBoneEndpoint(bone.tail, restTrackedPositions),
    })
  }
  return result
}

// ─── Per-bone rigid transform ────────────────────────────────────────────

export interface BoneTransform {
  angle: number   // rotation in radians
  headRest: Point2D
  headCurr: Point2D
}

/**
 * Compute rigid transform (rotation + translation) for a single bone.
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

function composeMatrices(m1: AffineMatrix, m2: AffineMatrix): AffineMatrix {
  // m1 * m2 (m2 applied first, then m1)
  const [a1, b1, tx1, c1, d1, ty1] = m1
  const [a2, b2, tx2, c2, d2, ty2] = m2
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    a1 * tx2 + b1 * ty2 + tx1,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    c1 * tx2 + d1 * ty2 + ty1,
  ]
}

function boneLocalMatrix(transform: BoneTransform): AffineMatrix {
  const cos = Math.cos(transform.angle)
  const sin = Math.sin(transform.angle)
  const { headRest, headCurr } = transform
  // Translate to rest head origin, rotate, translate to current head
  // p' = R * (p - headRest) + headCurr
  // = R*p - R*headRest + headCurr
  const tx = -cos * headRest.x + sin * headRest.y + headCurr.x
  const ty = -sin * headRest.x - cos * headRest.y + headCurr.y
  return [cos, -sin, tx, sin, cos, ty]
}

/**
 * Topological sort of bones: parents before children.
 */
function topologicalSort(bones: Bone[]): Bone[] {
  const byId = new Map(bones.map(b => [b.id, b]))
  const sorted: Bone[] = []
  const visited = new Set<string>()

  function visit(bone: Bone) {
    if (visited.has(bone.id)) return
    if (bone.parentId && byId.has(bone.parentId)) {
      visit(byId.get(bone.parentId)!)
    }
    visited.add(bone.id)
    sorted.push(bone)
  }

  for (const bone of bones) visit(bone)
  return sorted
}

/**
 * Compute world-space skinning matrices for all bones via forward kinematics.
 * Each matrix maps a rest-pose point to its deformed position for a given bone.
 *
 * In V1, each bone computes its transform independently from its anchor pairs.
 * Hierarchy composes parent transforms onto children for additive effects.
 */
export function computeWorldMatrices(
  bones: Bone[],
  restPose: Map<string, BonePose>,
  trackedPositions: Point2D[],
): Map<string, AffineMatrix> {
  const sorted = topologicalSort(bones)
  const worldMatrices = new Map<string, AffineMatrix>()

  for (const bone of sorted) {
    const rest = restPose.get(bone.id)!
    const currHead = computeBoneEndpoint(bone.head, trackedPositions)
    let currTail = computeBoneEndpoint(bone.tail, trackedPositions)

    // Enforce fixed length: keep direction, snap to rest-pose length
    if (bone.fixedLength) {
      const restLen = Math.hypot(rest.tail.x - rest.head.x, rest.tail.y - rest.head.y)
      const dx = currTail.x - currHead.x
      const dy = currTail.y - currHead.y
      const currLen = Math.hypot(dx, dy)
      if (currLen > 0) {
        const scale = restLen / currLen
        currTail = { x: currHead.x + dx * scale, y: currHead.y + dy * scale }
      }
    }

    const localTransform = computeBoneTransform(rest.head, rest.tail, currHead, currTail)
    const localMat = boneLocalMatrix(localTransform)

    if (bone.parentId && worldMatrices.has(bone.parentId)) {
      // Compose: first undo parent's rest transform on child,
      // For V1 with independent anchor positioning, we use local directly
      // but hierarchy allows future extension
      worldMatrices.set(bone.id, composeMatrices(worldMatrices.get(bone.parentId)!, localMat))
    } else {
      worldMatrices.set(bone.id, localMat)
    }
  }

  return worldMatrices
}

// ─── Auto-weights (inverse distance) ────────────────────────────────────

const WEIGHT_EPSILON = 1.0  // pixels, prevents div-by-zero
const WEIGHT_THRESHOLD = 0.01

/**
 * Compute skinning weights for all vertices via inverse-square distance to bone segments.
 * Returns weights[vertexIndex][boneIndex], normalized per vertex.
 */
export function computeAutoWeights(
  allRestPoints: Point2D[],
  bones: Bone[],
  restPose: Map<string, BonePose>,
): number[][] {
  const nVerts = allRestPoints.length
  const nBones = bones.length
  const weights: number[][] = new Array(nVerts)

  // Pre-collect bone segment endpoints in rest pose
  const boneSegments = bones.map(b => {
    const pose = restPose.get(b.id)!
    return { head: pose.head, tail: pose.tail }
  })

  for (let i = 0; i < nVerts; i++) {
    const p = allRestPoints[i]
    const raw = new Array<number>(nBones)
    let sum = 0

    for (let j = 0; j < nBones; j++) {
      const seg = boneSegments[j]
      const distSq = pointToSegmentDistanceSq(p, seg.head, seg.tail)
      const dist = Math.sqrt(distSq)
      const w = 1.0 / ((dist + WEIGHT_EPSILON) * (dist + WEIGHT_EPSILON))
      raw[j] = w
      sum += w
    }

    // Normalize
    if (sum > 0) {
      for (let j = 0; j < nBones; j++) raw[j] /= sum
    }

    // Threshold small weights and renormalize
    let sum2 = 0
    for (let j = 0; j < nBones; j++) {
      if (raw[j] < WEIGHT_THRESHOLD) raw[j] = 0
      sum2 += raw[j]
    }
    if (sum2 > 0) {
      for (let j = 0; j < nBones; j++) raw[j] /= sum2
    }

    weights[i] = raw
  }

  return weights
}

// ─── Linear Blend Skinning ───────────────────────────────────────────────

/**
 * Deform all vertices via LBS using precomputed world matrices and weights.
 */
export function skinVertices(
  allRestPoints: Point2D[],
  boneWeights: number[][],
  worldMatrices: Map<string, AffineMatrix>,
  bones: Bone[],
): Point2D[] {
  const nVerts = allRestPoints.length
  const nBones = bones.length
  const result: Point2D[] = new Array(nVerts)

  // Pre-collect matrices in array order for fast access
  const matrices: AffineMatrix[] = bones.map(b => worldMatrices.get(b.id) ?? identityMatrix())

  for (let i = 0; i < nVerts; i++) {
    const p = allRestPoints[i]
    const w = boneWeights[i]
    let x = 0, y = 0

    for (let j = 0; j < nBones; j++) {
      if (w[j] === 0) continue
      const m = matrices[j]
      x += w[j] * (m[0] * p.x + m[1] * p.y + m[2])
      y += w[j] * (m[3] * p.x + m[4] * p.y + m[5])
    }

    result[i] = { x, y }
  }

  return result
}

// ─── Batch solver ────────────────────────────────────────────────────────

/**
 * Compute videoFramesMesh for all frames using bone deformation.
 *
 * @param bones - Bone definitions
 * @param boneWeights - Pre-computed weights [vertexIndex][boneIndex]
 * @param allRestPoints - All mesh vertices at rest (frame 0): [...contourAnchors, ...subdivision, ...anchorPoints, ...internals]
 * @param trackedFrames - Tracked positions per frame: [...contourAnchorFrames[f], ...anchorFrames[f]]
 * @param restTrackedPositions - Tracked positions at rest (frame 0)
 * @param onProgress - Optional progress callback (frameIndex, totalFrames)
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
  const result: Point2D[][] = new Array(nFrames)

  for (let f = 0; f < nFrames; f++) {
    const worldMatrices = computeWorldMatrices(bones, restPose, trackedFrames[f])
    result[f] = skinVertices(allRestPoints, boneWeights, worldMatrices, bones)

    if (onProgress && f % 10 === 0) {
      onProgress(f, nFrames)
    }
  }

  if (onProgress) onProgress(nFrames, nFrames)
  return result
}
