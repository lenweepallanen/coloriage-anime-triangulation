/**
 * Sam2 Bone Solver — Skeleton position resolver for members-bones animations.
 *
 * Resolves skeleton joint/bone positions for any frame from zone-aware tracked
 * anchor data (sam2ContourAnchorFrames). Body chain = straight segments between
 * joints. Leg bones use 2-bone IK for knee (reuses solveElbowIK from boneSolver).
 */

import type { Point2D, Sam2Skeleton, Sam2BodyJoint, Sam2LegBone, Sam2BoneEndpointRef, ElbowMode } from '../types/project'
import { solveElbowIK, getElbowParams } from './boneSolver'

// ─── Endpoint computation ───────────────────────────────────────────────

/**
 * Resolve a zone-aware endpoint to world-space position for a given frame.
 * Barycentric: if A === B → snap to A, otherwise position = A + t × (B − A).
 */
export function computeSam2Endpoint(
  ref: Sam2BoneEndpointRef,
  anchorFrames: Record<string, Point2D[][]>,
  frameIdx: number,
): Point2D {
  const zoneAnchors = anchorFrames[ref.zoneId]?.[frameIdx]
  if (!zoneAnchors) return { x: 0, y: 0 }
  const a = zoneAnchors[ref.anchorIndexA]
  if (!a) return { x: 0, y: 0 }
  if (ref.anchorIndexA === ref.anchorIndexB) return { x: a.x, y: a.y }
  const b = zoneAnchors[ref.anchorIndexB]
  if (!b) return { x: a.x, y: a.y }
  return {
    x: a.x + ref.t * (b.x - a.x),
    y: a.y + ref.t * (b.y - a.y),
  }
}

/**
 * Resolve a zone-aware endpoint using static frame-0 anchors (for rest pose / editor).
 */
export function computeSam2EndpointStatic(
  ref: Sam2BoneEndpointRef,
  sam2ContourAnchors: Record<string, Point2D[]>,
): Point2D {
  const zoneAnchors = sam2ContourAnchors[ref.zoneId]
  if (!zoneAnchors) return { x: 0, y: 0 }
  const a = zoneAnchors[ref.anchorIndexA]
  if (!a) return { x: 0, y: 0 }
  if (ref.anchorIndexA === ref.anchorIndexB) return { x: a.x, y: a.y }
  const b = zoneAnchors[ref.anchorIndexB]
  if (!b) return { x: a.x, y: a.y }
  return {
    x: a.x + ref.t * (b.x - a.x),
    y: a.y + ref.t * (b.y - a.y),
  }
}

// ─── Body chain ─────────────────────────────────────────────────────────

/**
 * Resolve all body chain joint positions for a given frame.
 */
export function resolveBodyChain(
  chain: Sam2BodyJoint[],
  anchorFrames: Record<string, Point2D[][]>,
  frameIdx: number,
): Point2D[] {
  return chain.map(joint => computeSam2Endpoint(joint.ref, anchorFrames, frameIdx))
}

// ─── Leg rest pose ──────────────────────────────────────────────────────

export interface LegRestPose {
  hip: Point2D
  foot: Point2D
  knee: Point2D
  len1: number       // hip → knee distance
  len2: number       // knee → foot distance
  bendSide: number   // +1 or -1
}

/**
 * Compute rest pose for a leg bone at frame 0.
 */
export function computeLegRestPose(
  leg: Sam2LegBone,
  anchorFrames: Record<string, Point2D[][]>,
): LegRestPose {
  const hip = computeSam2Endpoint(leg.hip, anchorFrames, 0)
  const foot = computeSam2Endpoint(leg.foot, anchorFrames, 0)
  // Default knee to midpoint if not placed yet
  const knee = (leg.kneeRestPos.x === 0 && leg.kneeRestPos.y === 0)
    ? { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2 }
    : leg.kneeRestPos
  const params = getElbowParams(hip, foot, knee)
  return { hip, foot, knee, ...params }
}

// ─── Leg per-frame resolution ───────────────────────────────────────────

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

export interface LegFrame {
  hip: Point2D
  foot: Point2D
  knee: Point2D
}

/**
 * Resolve a leg bone for one frame: hip, foot, and knee (via IK).
 */
export function resolveLegBone(
  leg: Sam2LegBone,
  anchorFrames: Record<string, Point2D[][]>,
  frameIdx: number,
  restPose: LegRestPose,
  prevKnee: Point2D | null,
  centroid: Point2D | null,
): LegFrame {
  const hip = computeSam2Endpoint(leg.hip, anchorFrames, frameIdx)
  const foot = computeSam2Endpoint(leg.foot, anchorFrames, frameIdx)
  const side = chooseBendSide(
    leg.kneeMode, hip, foot,
    restPose.len1, restPose.len2, restPose.bendSide,
    centroid, prevKnee,
  )
  const knee = solveElbowIK(hip, foot, restPose.len1, restPose.len2, side)
  return { hip, foot, knee }
}

// ─── Full skeleton frame ────────────────────────────────────────────────

export interface Sam2SkeletonFrame {
  bodyJoints: Point2D[]
  legs: LegFrame[]
}

/**
 * Resolve the entire skeleton for a given frame.
 */
export function resolveSkeletonFrame(
  skeleton: Sam2Skeleton,
  anchorFrames: Record<string, Point2D[][]>,
  frameIdx: number,
  legRestPoses: LegRestPose[],
  prevFrame: Sam2SkeletonFrame | null,
): Sam2SkeletonFrame {
  const bodyJoints = resolveBodyChain(skeleton.bodyChain, anchorFrames, frameIdx)

  // Compute centroid of all body joints for 'centroid' knee mode
  let centroid: Point2D | null = null
  if (bodyJoints.length > 0) {
    let cx = 0, cy = 0
    for (const p of bodyJoints) { cx += p.x; cy += p.y }
    centroid = { x: cx / bodyJoints.length, y: cy / bodyJoints.length }
  }

  const legs = skeleton.legs.map((leg, i) => {
    const restPose = legRestPoses[i]
    if (!restPose) {
      const hip = computeSam2Endpoint(leg.hip, anchorFrames, frameIdx)
      const foot = computeSam2Endpoint(leg.foot, anchorFrames, frameIdx)
      return { hip, foot, knee: { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2 } }
    }
    const prevKnee = prevFrame?.legs[i]?.knee ?? null
    return resolveLegBone(leg, anchorFrames, frameIdx, restPose, prevKnee, centroid)
  })

  return { bodyJoints, legs }
}
