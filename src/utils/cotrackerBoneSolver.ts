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

/**
 * Rest pose of a leg : the full joint chain [hip, ...joints, foot] resolved at
 * frame 0 in VIDEO coords. `chain.length === 2 + leg.joints.length`.
 */
export interface CoTrackerLegRestPose {
  chain: Point2D[]
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

/** Resolve the full joint chain of a leg [hip, ...joints, foot] at a given frame. */
export function resolveCoTrackerLegChain(
  leg: CoTrackerLegBone,
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
  bodyVertexPositions?: Point2D[] | null,
): Point2D[] {
  const bodyHip = bodyBarycentricHip(leg.hipBodyVertexIndices, leg.hipBodyVertexWeights, bodyVertexPositions ?? [])
  const hip = (bodyHip && bodyVertexPositions) ? bodyHip : resolveEndpointFrame(leg.hip, cotrackerFrames, frameIdx)
  const foot = resolveEndpointFrame(leg.foot, cotrackerFrames, frameIdx)

  // Solver mode : 2 segments / 3 joints. Knee résolu par IK à partir de hip/foot
  // + longueurs et bendSide capturés au rest pose (frame 0).
  if (leg.legSolverMode === 'solver' && leg.kneeRestPos) {
    const bodyHip0 = bodyBarycentricHip(leg.hipBodyVertexIndices, leg.hipBodyVertexWeights, bodyVertexPositions ?? [])
    const hip0 = (bodyHip0 && bodyVertexPositions) ? bodyHip0 : resolveEndpointFrame(leg.hip, cotrackerFrames, 0)
    const foot0 = resolveEndpointFrame(leg.foot, cotrackerFrames, 0)
    const { len1, len2, bendSide } = getElbowParams(hip0, foot0, leg.kneeRestPos)
    const knee = solveElbowIK(hip, foot, len1, len2, bendSide)
    return [hip, knee, foot]
  }

  const mids = (leg.joints ?? []).map(j => resolveEndpointFrame(j, cotrackerFrames, frameIdx))
  return [hip, ...mids, foot]
}

export function computeCoTrackerLegRestPose(
  leg: CoTrackerLegBone,
  cotrackerFrames: Record<string, Point2D[]>,
  bodyFramesF0?: Point2D[] | null,
): CoTrackerLegRestPose {
  return { chain: resolveCoTrackerLegChain(leg, cotrackerFrames, 0, bodyFramesF0) }
}

export interface CoTrackerLegFrame {
  chain: Point2D[]   // [hip, ...joints, foot]
}

export function resolveCoTrackerLeg(
  leg: CoTrackerLegBone,
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
  _restPose: CoTrackerLegRestPose,
  _prevFrame: CoTrackerLegFrame | null,
  _centroid: Point2D | null,
  bodyVertexPositions?: Point2D[] | null,
): CoTrackerLegFrame {
  return { chain: resolveCoTrackerLegChain(leg, cotrackerFrames, frameIdx, bodyVertexPositions) }
}

export interface CoTrackerSkeletonFrame {
  bodyJoints: Point2D[]
  legs: CoTrackerLegFrame[]
}

export function resolveCoTrackerSkeletonFrame(
  skeleton: CoTrackerSkeleton,
  cotrackerFrames: Record<string, Point2D[]>,
  frameIdx: number,
  _legRestPoses: CoTrackerLegRestPose[],
  _prevFrame: CoTrackerSkeletonFrame | null,
  bodyVertexPositions?: Point2D[] | null,
): CoTrackerSkeletonFrame {
  const bodyJoints = resolveCoTrackerBodyChain(skeleton.bodyChain, cotrackerFrames, frameIdx)
  const legs = skeleton.legs.map(leg => ({
    chain: resolveCoTrackerLegChain(leg, cotrackerFrames, frameIdx, bodyVertexPositions),
  }))
  return { bodyJoints, legs }
}
