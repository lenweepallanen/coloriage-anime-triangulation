/**
 * Walk Solver — Procedural quadruped walk cycle generator.
 *
 * Given a walk skeleton (14 keypoints), body triangles, and walk parameters,
 * computes a full walk animation as videoFramesMesh via IK + LBS.
 *
 * Reuses solveElbowIK, computeBoneTransform, boneLocalMatrix,
 * skinVerticesSubBones and pointToSegmentDistanceSq from boneSolver.ts.
 */

import type { Point2D, WalkSkeletonDefinition, WalkParams, WalkLimbSeparation } from '../types/project'
import {
  solveElbowIK,
  computeBoneTransform,
  boneLocalMatrix,
  skinVerticesSubBones,
  pointToSegmentDistanceSq,
  type AffineMatrix,
} from './boneSolver'
import { flattenClosedBezier } from './bezierUtils'
import { pointInPolygon } from './geometry'

const FPS = 24
const CYCLES_PER_ANIM = 4
const STANCE_RATIO = 0.6 // 60% of cycle on the ground
const WEIGHT_EPSILON = 1.0
const WEIGHT_THRESHOLD = 0.01

// ─── Sub-bone definition for walk ──────────────────────────────────────

interface WalkSubBone {
  restHead: Point2D
  restTail: Point2D
}

// ─── Build virtual bones from skeleton keypoints ───────────────────────

/**
 * Build the list of sub-bones from the 14 keypoints (rest pose).
 * Returns sub-bones in order:
 *   [0..7]  = 4 legs × 2 (thigh, shin)
 *   [8]     = spine (midpoint shoulders → midpoint hips)
 *   [9]     = neck (baseCou → baseTete)
 *   [10]    = head (baseTete → sommetTete)
 *   [11]    = tail base (baseQueue → milieuQueue)
 *   [12]    = tail tip (milieuQueue → pointeQueue)
 */
function buildRestSubBones(skeleton: WalkSkeletonDefinition): WalkSubBone[] {
  const kp = skeleton.keyPoints
  const subBones: WalkSubBone[] = []

  // 4 legs × 2 sub-bones each (thigh: base→knee, shin: knee→foot)
  for (const leg of skeleton.legs) {
    subBones.push({ restHead: kp[leg.baseIndex], restTail: kp[leg.kneeIndex] })
    subBones.push({ restHead: kp[leg.kneeIndex], restTail: kp[leg.footIndex] })
  }

  // Spine: midpoint of front leg bases → midpoint of back leg bases
  const frontMid = midpoint(kp[skeleton.legs[0].baseIndex], kp[skeleton.legs[1].baseIndex])
  const backMid = midpoint(kp[skeleton.legs[2].baseIndex], kp[skeleton.legs[3].baseIndex])
  subBones.push({ restHead: frontMid, restTail: backMid })

  // Neck + Head
  const [baseCou, baseTete, sommetTete] = skeleton.neckChain
  subBones.push({ restHead: kp[baseCou], restTail: kp[baseTete] })
  subBones.push({ restHead: kp[baseTete], restTail: kp[sommetTete] })

  // Tail (2 segments)
  const [baseQueue, milieuQueue, pointeQueue] = skeleton.tailChain
  subBones.push({ restHead: kp[baseQueue], restTail: kp[milieuQueue] })
  subBones.push({ restHead: kp[milieuQueue], restTail: kp[pointeQueue] })

  return subBones
}

// ─── Auto-weights for walk sub-bones ───────────────────────────────────

function computeWalkAutoWeights(
  allRestPoints: Point2D[],
  subBones: WalkSubBone[],
): number[][] {
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

// ─── Foot trajectory ───────────────────────────────────────────────────

function computeFootPosition(
  restFoot: Point2D,
  strideLength: number,
  footLift: number,
  phase: number, // 0-1 within cycle
): Point2D {
  if (phase < STANCE_RATIO) {
    // Stance phase: foot on ground sliding backward
    const t = phase / STANCE_RATIO // 0→1
    return {
      x: restFoot.x + strideLength * (0.5 - t),
      y: restFoot.y,
    }
  } else {
    // Aerial phase: arc from back to front
    const airPhase = (phase - STANCE_RATIO) / (1 - STANCE_RATIO) // 0→1
    return {
      x: restFoot.x + strideLength * (-0.5 + airPhase),
      y: restFoot.y - footLift * Math.sin(Math.PI * airPhase),
    }
  }
}

// ─── Body motion ───────────────────────────────────────────────────────

interface BodyTransform {
  dx: number
  dy: number
  pitch: number // radians (front/back tilt)
  roll: number  // radians (left/right tilt)
}

function computeBodyTransform(
  skeleton: WalkSkeletonDefinition,
  keyPoints: Point2D[],
  legBaseOffsets: Point2D[], // vertical offsets at each leg base (4 entries)
  bodySway: number,
  cyclePhase: number,
): BodyTransform {
  // Body vertical oscillation: 2× cycle frequency (body bounces twice per step cycle)
  const dy = -bodySway * Math.sin(2 * Math.PI * 2 * cyclePhase)

  // Pitch: difference between front and back leg base oscillations
  const frontAvgY = (legBaseOffsets[0].y + legBaseOffsets[1].y) / 2
  const backAvgY = (legBaseOffsets[2].y + legBaseOffsets[3].y) / 2

  // Compute body length for pitch angle
  const frontMid = midpoint(keyPoints[skeleton.legs[0].baseIndex], keyPoints[skeleton.legs[1].baseIndex])
  const backMid = midpoint(keyPoints[skeleton.legs[2].baseIndex], keyPoints[skeleton.legs[3].baseIndex])
  const bodyLen = Math.hypot(frontMid.x - backMid.x, frontMid.y - backMid.y)
  const pitch = bodyLen > 0 ? Math.atan2((frontAvgY - backAvgY) * 0.3, bodyLen) : 0

  // Roll: difference between left and right sides
  const leftAvgY = (legBaseOffsets[0].y + legBaseOffsets[2].y) / 2
  const rightAvgY = (legBaseOffsets[1].y + legBaseOffsets[3].y) / 2
  const bodyWidth = Math.hypot(
    keyPoints[skeleton.legs[0].baseIndex].x - keyPoints[skeleton.legs[1].baseIndex].x,
    keyPoints[skeleton.legs[0].baseIndex].y - keyPoints[skeleton.legs[1].baseIndex].y,
  )
  const roll = bodyWidth > 0 ? Math.atan2((leftAvgY - rightAvgY) * 0.2, bodyWidth) : 0

  return { dx: 0, dy, pitch, roll }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function rotateAround(p: Point2D, center: Point2D, angle: number): Point2D {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return {
    x: center.x + cos * dx - sin * dy,
    y: center.y + sin * dx + cos * dy,
  }
}

function addOffset(p: Point2D, dx: number, dy: number): Point2D {
  return { x: p.x + dx, y: p.y + dy }
}

// ─── Main entry point ──────────────────────────────────────────────────

export function computeWalkFrames(
  skeleton: WalkSkeletonDefinition,
  _bodyTriangles: number[],
  params: WalkParams,
  allRestPoints: Point2D[],
  _triangles: [number, number, number][],
  onProgress?: (frame: number, total: number) => void,
  separation?: WalkLimbSeparation | null,
): Point2D[][] {
  const totalFrames = Math.round(CYCLES_PER_ANIM / params.speed * FPS)
  if (totalFrames < 2) return [allRestPoints.map(p => ({ ...p }))]

  const kp = skeleton.keyPoints

  // Build rest sub-bones and compute weights once
  const restSubBones = buildRestSubBones(skeleton)

  // If separation exists, use zone-restricted weights:
  // each vertex is only influenced by the bones of its zone
  let weights: number[][]
  if (separation) {
    weights = computeZoneRestrictedWeights(allRestPoints, restSubBones, separation)
  } else {
    weights = computeWalkAutoWeights(allRestPoints, restSubBones)
  }

  // Pre-compute rest leg segment lengths for IK
  const legRestLengths = skeleton.legs.map(leg => {
    const base = kp[leg.baseIndex]
    const knee = kp[leg.kneeIndex]
    const foot = kp[leg.footIndex]
    return {
      thighLen: Math.hypot(knee.x - base.x, knee.y - base.y),
      shinLen: Math.hypot(foot.x - knee.x, foot.y - knee.y),
    }
  })

  // Determine knee bend side from rest pose (cross product sign)
  const legBendSides = skeleton.legs.map((leg) => {
    const base = kp[leg.baseIndex]
    const knee = kp[leg.kneeIndex]
    const foot = kp[leg.footIndex]
    const cross = (knee.x - base.x) * (foot.y - base.y) - (knee.y - base.y) * (foot.x - base.x)
    return cross >= 0 ? 1 : -1
  })

  // Rest spine endpoints
  const restFrontMid = midpoint(kp[skeleton.legs[0].baseIndex], kp[skeleton.legs[1].baseIndex])
  const restBackMid = midpoint(kp[skeleton.legs[2].baseIndex], kp[skeleton.legs[3].baseIndex])
  const restBodyCenter = midpoint(restFrontMid, restBackMid)

  const result: Point2D[][] = new Array(totalFrames)

  for (let f = 0; f < totalFrames; f++) {
    const cyclePhase = ((f / totalFrames) * CYCLES_PER_ANIM) % 1

    // ── Leg base oscillation (vertical) ──
    const legBaseOffsets: Point2D[] = skeleton.legs.map(leg => {
      // Base oscillates at 2× frequency
      const dy = -params.bodySway * 0.5 * Math.sin(2 * Math.PI * 2 * (cyclePhase + leg.phaseOffset))
      return { x: 0, y: dy }
    })

    // ── Body transform ──
    const body = computeBodyTransform(skeleton, kp, legBaseOffsets, params.bodySway, cyclePhase)

    // Apply body transform to a rest point
    function applyBody(p: Point2D): Point2D {
      let result = addOffset(p, body.dx, body.dy)
      result = rotateAround(result, restBodyCenter, body.pitch + body.roll)
      return result
    }

    // ── Compute current keypoint positions ──
    const currentKP: Point2D[] = new Array(kp.length)

    // Leg bases: body transform + local oscillation
    for (let li = 0; li < 4; li++) {
      const leg = skeleton.legs[li]
      const baseRest = kp[leg.baseIndex]
      currentKP[leg.baseIndex] = addOffset(applyBody(baseRest), 0, legBaseOffsets[li].y)
    }

    // Feet: computed from trajectory
    const currentFeet: Point2D[] = skeleton.legs.map((leg) => {
      const legPhase = (cyclePhase + leg.phaseOffset) % 1
      return computeFootPosition(kp[leg.footIndex], params.strideLength, params.footLift, legPhase)
    })

    // Knees: IK from base and foot
    for (let li = 0; li < 4; li++) {
      const leg = skeleton.legs[li]
      const base = currentKP[leg.baseIndex]
      const foot = currentFeet[li]
      const knee = solveElbowIK(base, foot, legRestLengths[li].thighLen, legRestLengths[li].shinLen, legBendSides[li])
      currentKP[leg.kneeIndex] = knee
      currentKP[leg.footIndex] = foot
    }

    // Neck chain: body → rotation cou → rotation tête
    const [baseCouIdx, baseTeteIdx, sommetTeteIdx] = skeleton.neckChain
    const headFactor = (params.headSway ?? 50) / 50 // 0-2, 1 = default

    // Base cou follows body
    currentKP[baseCouIdx] = applyBody(kp[baseCouIdx])

    // Neck rotation: oscillation around base cou
    const neckAngle = headFactor * (params.bodySway / 80) * Math.sin(2 * Math.PI * 2 * cyclePhase + Math.PI / 4)
    currentKP[baseTeteIdx] = rotateAround(applyBody(kp[baseTeteIdx]), currentKP[baseCouIdx], neckAngle)

    // Head rotation: additional oscillation around base tête (déphasé)
    const headAngle = headFactor * (params.bodySway / 120) * Math.sin(2 * Math.PI * 2 * cyclePhase + Math.PI / 2)
    currentKP[sommetTeteIdx] = rotateAround(applyBody(kp[sommetTeteIdx]), currentKP[baseTeteIdx], headAngle)

    // Tail chain: sinusoidal wave
    const [baseQueueIdx, milieuQueueIdx, pointeQueueIdx] = skeleton.tailChain
    const tailBaseOsc = params.bodySway * 1.0 * Math.sin(2 * Math.PI * cyclePhase)
    const tailMidOsc = params.bodySway * 1.5 * Math.sin(2 * Math.PI * cyclePhase - Math.PI / 3)
    const tailTipOsc = params.bodySway * 2.0 * Math.sin(2 * Math.PI * cyclePhase - 2 * Math.PI / 3)

    // Tail oscillates perpendicular to the tail direction
    const tailDir = {
      x: kp[pointeQueueIdx].x - kp[baseQueueIdx].x,
      y: kp[pointeQueueIdx].y - kp[baseQueueIdx].y,
    }
    const tailLen = Math.hypot(tailDir.x, tailDir.y)
    const tailPerp = tailLen > 0
      ? { x: -tailDir.y / tailLen, y: tailDir.x / tailLen }
      : { x: 0, y: 1 }

    currentKP[baseQueueIdx] = addOffset(
      applyBody(kp[baseQueueIdx]),
      tailPerp.x * tailBaseOsc, tailPerp.y * tailBaseOsc,
    )
    currentKP[milieuQueueIdx] = addOffset(
      applyBody(kp[milieuQueueIdx]),
      tailPerp.x * tailMidOsc, tailPerp.y * tailMidOsc,
    )
    currentKP[pointeQueueIdx] = addOffset(
      applyBody(kp[pointeQueueIdx]),
      tailPerp.x * tailTipOsc, tailPerp.y * tailTipOsc,
    )

    // ── Build sub-bone current positions and compute matrices ──
    const currentSubBones: WalkSubBone[] = []

    // 4 legs × 2
    for (const leg of skeleton.legs) {
      currentSubBones.push({ restHead: currentKP[leg.baseIndex], restTail: currentKP[leg.kneeIndex] })
      currentSubBones.push({ restHead: currentKP[leg.kneeIndex], restTail: currentKP[leg.footIndex] })
    }

    // Spine
    const currFrontMid = midpoint(currentKP[skeleton.legs[0].baseIndex], currentKP[skeleton.legs[1].baseIndex])
    const currBackMid = midpoint(currentKP[skeleton.legs[2].baseIndex], currentKP[skeleton.legs[3].baseIndex])
    currentSubBones.push({ restHead: currFrontMid, restTail: currBackMid })

    // Neck + Head
    currentSubBones.push({ restHead: currentKP[baseCouIdx], restTail: currentKP[baseTeteIdx] })
    currentSubBones.push({ restHead: currentKP[baseTeteIdx], restTail: currentKP[sommetTeteIdx] })

    // Tail
    currentSubBones.push({ restHead: currentKP[baseQueueIdx], restTail: currentKP[milieuQueueIdx] })
    currentSubBones.push({ restHead: currentKP[milieuQueueIdx], restTail: currentKP[pointeQueueIdx] })

    // Compute affine matrices
    const matrices: AffineMatrix[] = restSubBones.map((rest, i) => {
      const curr = currentSubBones[i]
      const transform = computeBoneTransform(rest.restHead, rest.restTail, curr.restHead, curr.restTail)
      return boneLocalMatrix(transform)
    })

    // LBS deformation
    result[f] = skinVerticesSubBones(allRestPoints, weights, matrices)

    if (onProgress && f % 5 === 0) {
      onProgress(f, totalFrames)
    }
  }

  if (onProgress) onProgress(totalFrames, totalFrames)
  return result
}

/**
 * Compute bone positions for a single frame (used by live preview, no mesh deformation).
 * Returns the 14 keypoint positions + derived spine midpoints.
 */
export function computeWalkBonePositions(
  skeleton: WalkSkeletonDefinition,
  params: WalkParams,
  cyclePhase: number,
): { keyPoints: Point2D[]; spineFront: Point2D; spineBack: Point2D } {
  const kp = skeleton.keyPoints

  // Pre-compute rest leg segment lengths for IK
  const legRestLengths = skeleton.legs.map(leg => {
    const base = kp[leg.baseIndex]
    const knee = kp[leg.kneeIndex]
    const foot = kp[leg.footIndex]
    return {
      thighLen: Math.hypot(knee.x - base.x, knee.y - base.y),
      shinLen: Math.hypot(foot.x - knee.x, foot.y - knee.y),
    }
  })

  const legBendSides = skeleton.legs.map(leg => {
    const base = kp[leg.baseIndex]
    const knee = kp[leg.kneeIndex]
    const foot = kp[leg.footIndex]
    const cross = (knee.x - base.x) * (foot.y - base.y) - (knee.y - base.y) * (foot.x - base.x)
    return cross >= 0 ? 1 : -1
  })

  const restFrontMid = midpoint(kp[skeleton.legs[0].baseIndex], kp[skeleton.legs[1].baseIndex])
  const restBackMid = midpoint(kp[skeleton.legs[2].baseIndex], kp[skeleton.legs[3].baseIndex])
  const restBodyCenter = midpoint(restFrontMid, restBackMid)

  const legBaseOffsets: Point2D[] = skeleton.legs.map(leg => {
    const dy = -params.bodySway * 0.5 * Math.sin(2 * Math.PI * 2 * (cyclePhase + leg.phaseOffset))
    return { x: 0, y: dy }
  })

  const body = computeBodyTransform(skeleton, kp, legBaseOffsets, params.bodySway, cyclePhase)

  function applyBody(p: Point2D): Point2D {
    let result = addOffset(p, body.dx, body.dy)
    result = rotateAround(result, restBodyCenter, body.pitch + body.roll)
    return result
  }

  const currentKP: Point2D[] = new Array(kp.length)

  // Leg bases
  for (let li = 0; li < 4; li++) {
    const leg = skeleton.legs[li]
    currentKP[leg.baseIndex] = addOffset(applyBody(kp[leg.baseIndex]), 0, legBaseOffsets[li].y)
  }

  // Feet + knees
  for (let li = 0; li < 4; li++) {
    const leg = skeleton.legs[li]
    const legPhase = (cyclePhase + leg.phaseOffset) % 1
    const foot = computeFootPosition(kp[leg.footIndex], params.strideLength, params.footLift, legPhase)
    const base = currentKP[leg.baseIndex]
    const knee = solveElbowIK(base, foot, legRestLengths[li].thighLen, legRestLengths[li].shinLen, legBendSides[li])
    currentKP[leg.kneeIndex] = knee
    currentKP[leg.footIndex] = foot
  }

  // Neck/head: body → rotation cou → rotation tête
  const [baseCouIdx, baseTeteIdx, sommetTeteIdx] = skeleton.neckChain
  const headFactor = (params.headSway ?? 50) / 50
  currentKP[baseCouIdx] = applyBody(kp[baseCouIdx])
  const neckAngle = headFactor * (params.bodySway / 80) * Math.sin(2 * Math.PI * 2 * cyclePhase + Math.PI / 4)
  currentKP[baseTeteIdx] = rotateAround(applyBody(kp[baseTeteIdx]), currentKP[baseCouIdx], neckAngle)
  const headAngle = headFactor * (params.bodySway / 120) * Math.sin(2 * Math.PI * 2 * cyclePhase + Math.PI / 2)
  currentKP[sommetTeteIdx] = rotateAround(applyBody(kp[sommetTeteIdx]), currentKP[baseTeteIdx], headAngle)

  // Tail
  const [baseQueueIdx, milieuQueueIdx, pointeQueueIdx] = skeleton.tailChain
  const tailDir = { x: kp[pointeQueueIdx].x - kp[baseQueueIdx].x, y: kp[pointeQueueIdx].y - kp[baseQueueIdx].y }
  const tailLength = Math.hypot(tailDir.x, tailDir.y)
  const tailPerp = tailLength > 0 ? { x: -tailDir.y / tailLength, y: tailDir.x / tailLength } : { x: 0, y: 1 }

  const tailBaseOsc = params.bodySway * 1.0 * Math.sin(2 * Math.PI * cyclePhase)
  const tailMidOsc = params.bodySway * 1.5 * Math.sin(2 * Math.PI * cyclePhase - Math.PI / 3)
  const tailTipOsc = params.bodySway * 2.0 * Math.sin(2 * Math.PI * cyclePhase - 2 * Math.PI / 3)

  currentKP[baseQueueIdx] = addOffset(applyBody(kp[baseQueueIdx]), tailPerp.x * tailBaseOsc, tailPerp.y * tailBaseOsc)
  currentKP[milieuQueueIdx] = addOffset(applyBody(kp[milieuQueueIdx]), tailPerp.x * tailMidOsc, tailPerp.y * tailMidOsc)
  currentKP[pointeQueueIdx] = addOffset(applyBody(kp[pointeQueueIdx]), tailPerp.x * tailTipOsc, tailPerp.y * tailTipOsc)

  const spineFront = midpoint(currentKP[skeleton.legs[0].baseIndex], currentKP[skeleton.legs[1].baseIndex])
  const spineBack = midpoint(currentKP[skeleton.legs[2].baseIndex], currentKP[skeleton.legs[3].baseIndex])

  return { keyPoints: currentKP, spineFront, spineBack }
}

/** Keypoint labels for the walk skeleton editor (18 points). */
export const WALK_KEYPOINT_LABELS = [
  'Épaule AV gauche', 'Genou AV gauche', 'Pied AV gauche',       // 0-2
  'Épaule AV droite', 'Genou AV droite', 'Pied AV droite',       // 3-5
  'Hanche AR gauche', 'Genou AR gauche', 'Pied AR gauche',        // 6-8
  'Hanche AR droite', 'Genou AR droite', 'Pied AR droite',        // 9-11
  'Base Cou', 'Base Tête', 'Sommet Tête',                         // 12-14
  'Base Queue', 'Milieu Queue', 'Pointe Queue',                   // 15-17
] as const

export const WALK_NUM_KEYPOINTS = 18

/** Default walk parameters. */
export const DEFAULT_WALK_PARAMS: WalkParams = {
  speed: 1,
  strideLength: 80,
  footLift: 30,
  bodySway: 8,
  headSway: 50,
}

/** Walk gait presets (leg phase offsets). */
export const WALK_PRESETS = {
  walk:   [0, 0.5, 0.25, 0.75] as [number, number, number, number],
  trot:   [0, 0.5, 0.0, 0.5]  as [number, number, number, number],
  gallop: [0, 0.1, 0.5, 0.6]  as [number, number, number, number],
}

/**
 * Build default skeleton definition from placed keypoints.
 * Expects exactly 18 keypoints in the order defined by WALK_KEYPOINT_LABELS.
 */
export function buildWalkSkeleton(
  keyPoints: Point2D[],
  legPhases: [number, number, number, number] = WALK_PRESETS.walk,
): WalkSkeletonDefinition {
  return {
    keyPoints,
    legs: [
      { baseIndex: 0, kneeIndex: 1, footIndex: 2, phaseOffset: legPhases[0] },
      { baseIndex: 3, kneeIndex: 4, footIndex: 5, phaseOffset: legPhases[1] },
      { baseIndex: 6, kneeIndex: 7, footIndex: 8, phaseOffset: legPhases[2] },
      { baseIndex: 9, kneeIndex: 10, footIndex: 11, phaseOffset: legPhases[3] },
    ],
    neckChain: [12, 13, 14],
    tailChain: [15, 16, 17],
  }
}

// ─── Zone-restricted weights for single-mesh mode ─────────────────────

/**
 * Compute weights where each vertex is only influenced by bones of its zone.
 * Vertices inside a limb polygon → only that leg's 2 sub-bones.
 * Vertices not in any limb → only body sub-bones (spine, neck, head, tail).
 */
function computeZoneRestrictedWeights(
  allRestPoints: Point2D[],
  subBones: WalkSubBone[],
  separation: WalkLimbSeparation,
): number[][] {
  // Flatten zone polygons for point-in-polygon tests
  const zonePolygons: { legIndex: number; polygon: Point2D[] }[] = []
  for (const zone of separation.zones) {
    if (zone.bezierNodes.length < 3) continue
    const poly = flattenClosedBezier(zone.bezierNodes, 20)
    zonePolygons.push({ legIndex: zone.legIndex, polygon: poly })
  }

  const nVerts = allRestPoints.length
  const weights: number[][] = new Array(nVerts)

  for (let i = 0; i < nVerts; i++) {
    const p = allRestPoints[i]

    // Determine which zone this vertex belongs to
    let allowedBones: number[] = BODY_SUBBONE_INDICES
    for (const zp of zonePolygons) {
      if (pointInPolygon(p, zp.polygon)) {
        allowedBones = [zp.legIndex * 2, zp.legIndex * 2 + 1]
        break
      }
    }

    weights[i] = computeSingleVertexWeights(p, subBones, allowedBones)
  }

  return weights
}

function computeSingleVertexWeights(
  p: Point2D,
  subBones: WalkSubBone[],
  allowedIndices: number[],
): number[] {
  const nSub = subBones.length
  const raw = new Array<number>(nSub).fill(0)
  let sum = 0

  for (const j of allowedIndices) {
    const sb = subBones[j]
    const distSq = pointToSegmentDistanceSq(p, sb.restHead, sb.restTail)
    const dist = Math.sqrt(distSq)
    const w = 1.0 / ((dist + WEIGHT_EPSILON) * (dist + WEIGHT_EPSILON))
    raw[j] = w
    sum += w
  }

  if (sum > 0) for (const j of allowedIndices) raw[j] /= sum

  let sum2 = 0
  for (const j of allowedIndices) {
    if (raw[j] < WEIGHT_THRESHOLD) raw[j] = 0
    sum2 += raw[j]
  }
  if (sum2 > 0) for (const j of allowedIndices) raw[j] /= sum2

  return raw
}

// ─── Separated walk computation (per-zone) ────────────────────────────

/**
 * Sub-bone index mapping:
 *   [0,1]     = leg 0 (thigh, shin)
 *   [2,3]     = leg 1
 *   [4,5]     = leg 2
 *   [6,7]     = leg 3
 *   [8]       = spine
 *   [9]       = neck
 *   [10]      = head
 *   [11]      = tail base
 *   [12]      = tail tip
 *
 * Limb zone i uses only sub-bones [i*2, i*2+1].
 * Body zone uses sub-bones [8..12].
 */

const BODY_SUBBONE_INDICES = [8, 9, 10, 11, 12]

/**
 * Compute zone-specific weights: for each vertex, only the specified
 * sub-bones have non-zero weight. All others are forced to 0.
 */
function computeZoneWeights(
  zoneVertexPositions: Point2D[],
  allSubBones: WalkSubBone[],
  allowedSubBoneIndices: number[],
): number[][] {
  const nVerts = zoneVertexPositions.length
  const nSub = allSubBones.length
  const weights: number[][] = new Array(nVerts)

  for (let i = 0; i < nVerts; i++) {
    const p = zoneVertexPositions[i]
    const raw = new Array<number>(nSub).fill(0)
    let sum = 0

    for (const j of allowedSubBoneIndices) {
      const sb = allSubBones[j]
      const distSq = pointToSegmentDistanceSq(p, sb.restHead, sb.restTail)
      const dist = Math.sqrt(distSq)
      const w = 1.0 / ((dist + WEIGHT_EPSILON) * (dist + WEIGHT_EPSILON))
      raw[j] = w
      sum += w
    }

    if (sum > 0) {
      for (const j of allowedSubBoneIndices) raw[j] /= sum
    }

    let sum2 = 0
    for (const j of allowedSubBoneIndices) {
      if (raw[j] < WEIGHT_THRESHOLD) raw[j] = 0
      sum2 += raw[j]
    }
    if (sum2 > 0) {
      for (const j of allowedSubBoneIndices) raw[j] /= sum2
    }

    weights[i] = raw
  }
  return weights
}

/**
 * Compute walk frames with limb separation.
 * Returns per-zone and body frames independently.
 *
 * Each zone's vertices are deformed only by the sub-bones belonging to that zone,
 * eliminating cross-zone bleed.
 */
export function computeWalkFramesSeparated(
  skeleton: WalkSkeletonDefinition,
  params: WalkParams,
  separation: WalkLimbSeparation,
  allRestPoints: Point2D[],
  restTriangles: [number, number, number][],
  onProgress?: (frame: number, total: number) => void,
): { zoneFrames: Record<string, Point2D[][]>; bodyFrames: Point2D[][] } {
  const totalFrames = Math.round(CYCLES_PER_ANIM / params.speed * FPS)
  const kp = skeleton.keyPoints

  const restSubBones = buildRestSubBones(skeleton)

  // ── Per-zone weights (each zone has its own points, independent of rest mesh) ──
  const zoneData: Record<string, { restPts: Point2D[]; weights: number[][] }> = {}
  for (const zone of separation.zones) {
    const restPts = separation.zonePoints[zone.id] || []
    const legSubBones = [zone.legIndex * 2, zone.legIndex * 2 + 1]
    const weights = computeZoneWeights(restPts, restSubBones, legSubBones)
    zoneData[zone.id] = { restPts, weights }
  }

  // ── Body: use pre-computed bodyPoints if available, else derive from indices ──
  let bodyRestPts: Point2D[]
  if (separation.bodyPoints) {
    bodyRestPts = separation.bodyPoints
  } else {
    const bodyIdxSet = new Set<number>()
    for (const ti of separation.bodyTriangleIndices) {
      const [a, b, c] = restTriangles[ti]
      bodyIdxSet.add(a); bodyIdxSet.add(b); bodyIdxSet.add(c)
    }
    const bodyIndices = [...bodyIdxSet].sort((a, b) => a - b)
    bodyRestPts = bodyIndices.map(i => allRestPoints[i])
  }
  const bodyWeights = computeZoneWeights(bodyRestPts, restSubBones, BODY_SUBBONE_INDICES)


  // Pre-compute rest leg lengths and bend sides
  const legRestLengths = skeleton.legs.map(leg => ({
    thighLen: Math.hypot(kp[leg.kneeIndex].x - kp[leg.baseIndex].x, kp[leg.kneeIndex].y - kp[leg.baseIndex].y),
    shinLen: Math.hypot(kp[leg.footIndex].x - kp[leg.kneeIndex].x, kp[leg.footIndex].y - kp[leg.kneeIndex].y),
  }))
  const legBendSides = skeleton.legs.map(leg => {
    const base = kp[leg.baseIndex], knee = kp[leg.kneeIndex], foot = kp[leg.footIndex]
    return (knee.x - base.x) * (foot.y - base.y) - (knee.y - base.y) * (foot.x - base.x) >= 0 ? 1 : -1
  })

  const restFrontMid = midpoint(kp[skeleton.legs[0].baseIndex], kp[skeleton.legs[1].baseIndex])
  const restBackMid = midpoint(kp[skeleton.legs[2].baseIndex], kp[skeleton.legs[3].baseIndex])
  const restBodyCenter = midpoint(restFrontMid, restBackMid)

  // Initialize result
  const zoneFrames: Record<string, Point2D[][]> = {}
  for (const zone of separation.zones) zoneFrames[zone.id] = new Array(totalFrames)
  const bodyFrames: Point2D[][] = new Array(totalFrames)

  for (let f = 0; f < totalFrames; f++) {
    const cyclePhase = ((f / totalFrames) * CYCLES_PER_ANIM) % 1

    // ── Kinematic computation (identical to computeWalkFrames) ──
    const legBaseOffsets: Point2D[] = skeleton.legs.map(leg => ({
      x: 0,
      y: -params.bodySway * 0.5 * Math.sin(2 * Math.PI * 2 * (cyclePhase + leg.phaseOffset)),
    }))

    const body = computeBodyTransform(skeleton, kp, legBaseOffsets, params.bodySway, cyclePhase)
    const applyBody = (p: Point2D): Point2D => {
      const r = addOffset(p, body.dx, body.dy)
      return rotateAround(r, restBodyCenter, body.pitch + body.roll)
    }

    const currentKP: Point2D[] = new Array(kp.length)
    for (let li = 0; li < 4; li++) {
      const leg = skeleton.legs[li]
      currentKP[leg.baseIndex] = addOffset(applyBody(kp[leg.baseIndex]), 0, legBaseOffsets[li].y)
    }
    for (let li = 0; li < 4; li++) {
      const leg = skeleton.legs[li]
      const legPhase = (cyclePhase + leg.phaseOffset) % 1
      const foot = computeFootPosition(kp[leg.footIndex], params.strideLength, params.footLift, legPhase)
      currentKP[leg.kneeIndex] = solveElbowIK(currentKP[leg.baseIndex], foot, legRestLengths[li].thighLen, legRestLengths[li].shinLen, legBendSides[li])
      currentKP[leg.footIndex] = foot
    }

    const [baseCouIdx, baseTeteIdx, sommetTeteIdx] = skeleton.neckChain
    const headFactor = (params.headSway ?? 50) / 50
    currentKP[baseCouIdx] = applyBody(kp[baseCouIdx])
    const neckAngle = headFactor * (params.bodySway / 80) * Math.sin(2 * Math.PI * 2 * cyclePhase + Math.PI / 4)
    currentKP[baseTeteIdx] = rotateAround(applyBody(kp[baseTeteIdx]), currentKP[baseCouIdx], neckAngle)
    const headAngle = headFactor * (params.bodySway / 120) * Math.sin(2 * Math.PI * 2 * cyclePhase + Math.PI / 2)
    currentKP[sommetTeteIdx] = rotateAround(applyBody(kp[sommetTeteIdx]), currentKP[baseTeteIdx], headAngle)

    const [baseQueueIdx, milieuQueueIdx, pointeQueueIdx] = skeleton.tailChain
    const tailDir = { x: kp[pointeQueueIdx].x - kp[baseQueueIdx].x, y: kp[pointeQueueIdx].y - kp[baseQueueIdx].y }
    const tailLen = Math.hypot(tailDir.x, tailDir.y)
    const tailPerp = tailLen > 0 ? { x: -tailDir.y / tailLen, y: tailDir.x / tailLen } : { x: 0, y: 1 }
    const tailBaseOsc = params.bodySway * 1.0 * Math.sin(2 * Math.PI * cyclePhase)
    const tailMidOsc = params.bodySway * 1.5 * Math.sin(2 * Math.PI * cyclePhase - Math.PI / 3)
    const tailTipOsc = params.bodySway * 2.0 * Math.sin(2 * Math.PI * cyclePhase - 2 * Math.PI / 3)
    currentKP[baseQueueIdx] = addOffset(applyBody(kp[baseQueueIdx]), tailPerp.x * tailBaseOsc, tailPerp.y * tailBaseOsc)
    currentKP[milieuQueueIdx] = addOffset(applyBody(kp[milieuQueueIdx]), tailPerp.x * tailMidOsc, tailPerp.y * tailMidOsc)
    currentKP[pointeQueueIdx] = addOffset(applyBody(kp[pointeQueueIdx]), tailPerp.x * tailTipOsc, tailPerp.y * tailTipOsc)

    // ── Build current sub-bones + affine matrices ──
    const currentSubBones: WalkSubBone[] = []
    for (const leg of skeleton.legs) {
      currentSubBones.push({ restHead: currentKP[leg.baseIndex], restTail: currentKP[leg.kneeIndex] })
      currentSubBones.push({ restHead: currentKP[leg.kneeIndex], restTail: currentKP[leg.footIndex] })
    }
    const currFrontMid = midpoint(currentKP[skeleton.legs[0].baseIndex], currentKP[skeleton.legs[1].baseIndex])
    const currBackMid = midpoint(currentKP[skeleton.legs[2].baseIndex], currentKP[skeleton.legs[3].baseIndex])
    currentSubBones.push({ restHead: currFrontMid, restTail: currBackMid })
    currentSubBones.push({ restHead: currentKP[baseCouIdx], restTail: currentKP[baseTeteIdx] })
    currentSubBones.push({ restHead: currentKP[baseTeteIdx], restTail: currentKP[sommetTeteIdx] })
    currentSubBones.push({ restHead: currentKP[baseQueueIdx], restTail: currentKP[milieuQueueIdx] })
    currentSubBones.push({ restHead: currentKP[milieuQueueIdx], restTail: currentKP[pointeQueueIdx] })

    const matrices: AffineMatrix[] = restSubBones.map((rest, i) => {
      const curr = currentSubBones[i]
      return boneLocalMatrix(computeBoneTransform(rest.restHead, rest.restTail, curr.restHead, curr.restTail))
    })

    // ── Per-zone LBS (each zone has its own independent points) ──
    for (const zone of separation.zones) {
      const { restPts, weights } = zoneData[zone.id]
      zoneFrames[zone.id][f] = skinVerticesSubBones(restPts, weights, matrices)
    }

    // ── Body LBS ──
    bodyFrames[f] = skinVerticesSubBones(bodyRestPts, bodyWeights, matrices)

    if (onProgress && f % 5 === 0) onProgress(f, totalFrames)
  }

  if (onProgress) onProgress(totalFrames, totalFrames)
  return { zoneFrames, bodyFrames }
}
