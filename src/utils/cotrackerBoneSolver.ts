/**
 * CoTracker Bone Solver — Skeleton position resolver for cotracker-bones animations.
 *
 * Resolves skeleton joint/bone positions for any frame from a set of tracked
 * CoTracker3 points. Endpoints are N-ary barycentres (linear combination of
 * arbitrary points) instead of zone-aware pairs (V2/V3 SAM2 style).
 */

import type {
  Point2D,
  CoTrackerSkeleton,
  CoTrackerBodyJoint,
  CoTrackerLegBone,
  CoTrackerEndpointRef,
  ElbowMode,
} from '../types/project'
import { solveElbowIK, getElbowParams } from './boneSolver'

/** Normalise weights → sum to 1. Returns uniform if degenerate. */
export function normalizeWeights(weights: number[]): number[] {
  const n = weights.length
  if (n === 0) return []
  let s = 0
  for (const w of weights) s += w
  if (s === 0) return new Array(n).fill(1 / n)
  return weights.map(w => w / s)
}

/**
 * Resolve an N-ary endpoint to a 2D position for a given frame.
 * position = Σ weights[i] × cotrackerFrames[pointIds[i]][frameIdx]
 */
export function resolveEndpointFrame(
  ref: CoTrackerEndpointRef,
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
): Point2D {
  if (!ref.pointIds.length) return { x: 0, y: 0 }
  const w = normalizeWeights(ref.weights)
  let x = 0, y = 0, used = 0
  for (let i = 0; i < ref.pointIds.length; i++) {
    const traj = cotrackerFrames[ref.pointIds[i]]
    const p = traj?.[frameIdx]
    if (!p) continue
    x += w[i] * p.x
    y += w[i] * p.y
    used += w[i]
  }
  if (used === 0) return { x: 0, y: 0 }
  // Renormalise if some refs were missing
  return { x: x / used, y: y / used }
}

/**
 * Resolve from per-point prompts at frame 0 (rest pose, when CoTracker hasn't been
 * run yet). Uses the first prompt position of each point as its "static" position.
 */
export function resolveEndpointStatic(
  ref: CoTrackerEndpointRef,
  pointStaticPositions: Record<string, Point2D>,
): Point2D {
  if (!ref.pointIds.length) return { x: 0, y: 0 }
  const w = normalizeWeights(ref.weights)
  let x = 0, y = 0, used = 0
  for (let i = 0; i < ref.pointIds.length; i++) {
    const p = pointStaticPositions[ref.pointIds[i]]
    if (!p) continue
    x += w[i] * p.x
    y += w[i] * p.y
    used += w[i]
  }
  if (used === 0) return { x: 0, y: 0 }
  return { x: x / used, y: y / used }
}

// ─── Body chain ─────────────────────────────────────────────────────────

export function resolveCoTrackerBodyChain(
  chain: CoTrackerBodyJoint[],
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
): Point2D[] {
  return chain.map(j => resolveEndpointFrame(j.ref, cotrackerFrames, frameIdx))
}

// ─── Leg rest pose & per-frame resolution ───────────────────────────────

export interface CoTrackerLegRestPose {
  hip: Point2D
  foot: Point2D
  knee: Point2D
  len1: number
  len2: number
  bendSide: number
}

function bodyBarycentricHip(
  indices: number[] | null | undefined,
  weights: number[] | null | undefined,
  bodyVertexPositions: Point2D[],
): Point2D | null {
  if (!indices || indices.length === 0) return null
  const n = indices.length
  const w = (weights && weights.length === n) ? weights : new Array(n).fill(1 / n)
  let x = 0, y = 0, ws = 0
  for (let i = 0; i < n; i++) {
    const p = bodyVertexPositions[indices[i]]
    if (!p) continue
    x += w[i] * p.x
    y += w[i] * p.y
    ws += w[i]
  }
  if (ws === 0) return null
  return { x: x / ws, y: y / ws }
}

export function computeCoTrackerLegRestPose(
  leg: CoTrackerLegBone,
  cotrackerFrames: Record<string, Point2D[]>,
  bodyFramesF0?: Point2D[] | null,
): CoTrackerLegRestPose {
  let hip: Point2D
  const bodyHip = bodyBarycentricHip(leg.hipBodyVertexIndices, leg.hipBodyVertexWeights, bodyFramesF0 ?? [])
  if (bodyHip && bodyFramesF0) {
    hip = bodyHip
  } else {
    hip = resolveEndpointFrame(leg.hip, cotrackerFrames, 0)
  }
  const foot = resolveEndpointFrame(leg.foot, cotrackerFrames, 0)
  const knee = (leg.kneeRestPos.x === 0 && leg.kneeRestPos.y === 0)
    ? { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2 }
    : leg.kneeRestPos
  const params = getElbowParams(hip, foot, knee)
  return { hip, foot, knee, ...params }
}

function chooseBendSide(
  mode: ElbowMode,
  hip: Point2D, foot: Point2D,
  len1: number, len2: number,
  restBendSide: number,
  centroid: Point2D | null,
  prevKnee: Point2D | null,
): number {
  if (mode === 'rest') return restBendSide
  if (mode === 'centroid' && centroid) {
    const ePlus = solveElbowIK(hip, foot, len1, len2, +1)
    const eMinus = solveElbowIK(hip, foot, len1, len2, -1)
    const dPlus = (ePlus.x - centroid.x) ** 2 + (ePlus.y - centroid.y) ** 2
    const dMinus = (eMinus.x - centroid.x) ** 2 + (eMinus.y - centroid.y) ** 2
    return dPlus <= dMinus ? +1 : -1
  }
  if (mode === 'continuity' && prevKnee) {
    const ePlus = solveElbowIK(hip, foot, len1, len2, +1)
    const eMinus = solveElbowIK(hip, foot, len1, len2, -1)
    const dPlus = (ePlus.x - prevKnee.x) ** 2 + (ePlus.y - prevKnee.y) ** 2
    const dMinus = (eMinus.x - prevKnee.x) ** 2 + (eMinus.y - prevKnee.y) ** 2
    return dPlus <= dMinus ? +1 : -1
  }
  return restBendSide
}

export interface CoTrackerLegFrame {
  hip: Point2D
  foot: Point2D
  knee: Point2D
}

export function resolveCoTrackerLeg(
  leg: CoTrackerLegBone,
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
  restPose: CoTrackerLegRestPose,
  prevKnee: Point2D | null,
  centroid: Point2D | null,
  bodyVertexPositions?: Point2D[] | null,
): CoTrackerLegFrame {
  const bodyHip = bodyBarycentricHip(leg.hipBodyVertexIndices, leg.hipBodyVertexWeights, bodyVertexPositions ?? [])
  const hip = (bodyHip && bodyVertexPositions) ? bodyHip : resolveEndpointFrame(leg.hip, cotrackerFrames, frameIdx)
  const foot = resolveEndpointFrame(leg.foot, cotrackerFrames, frameIdx)
  const side = chooseBendSide(
    leg.kneeMode, hip, foot,
    restPose.len1, restPose.len2, restPose.bendSide,
    centroid, prevKnee,
  )
  const knee = solveElbowIK(hip, foot, restPose.len1, restPose.len2, side)
  return { hip, foot, knee }
}

export interface CoTrackerSkeletonFrame {
  bodyJoints: Point2D[]
  legs: CoTrackerLegFrame[]
}

export function resolveCoTrackerSkeletonFrame(
  skeleton: CoTrackerSkeleton,
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
  legRestPoses: CoTrackerLegRestPose[],
  prevFrame: CoTrackerSkeletonFrame | null,
  bodyVertexPositions?: Point2D[] | null,
): CoTrackerSkeletonFrame {
  const bodyJoints = resolveCoTrackerBodyChain(skeleton.bodyChain, cotrackerFrames, frameIdx)

  let centroid: Point2D | null = null
  if (bodyJoints.length > 0) {
    let cx = 0, cy = 0
    for (const p of bodyJoints) { cx += p.x; cy += p.y }
    centroid = { x: cx / bodyJoints.length, y: cy / bodyJoints.length }
  }

  const legs = skeleton.legs.map((leg, i) => {
    const restPose = legRestPoses[i]
    if (!restPose) {
      const hip = resolveEndpointFrame(leg.hip, cotrackerFrames, frameIdx)
      const foot = resolveEndpointFrame(leg.foot, cotrackerFrames, frameIdx)
      return { hip, foot, knee: { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2 } }
    }
    const prevKnee = prevFrame?.legs[i]?.knee ?? null
    return resolveCoTrackerLeg(leg, cotrackerFrames, frameIdx, restPose, prevKnee, centroid, bodyVertexPositions)
  })

  return { bodyJoints, legs }
}
