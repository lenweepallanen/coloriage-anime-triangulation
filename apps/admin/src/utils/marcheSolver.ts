/**
 * Marche Solver — Procedural walk on a CoTracker-style skeleton.
 *
 * Inputs : an inherited `CoTrackerSkeleton` (bodyChain + legs), the rest
 * positions of every joint (image coords), the project triangulation
 * (bodyPoints/Triangles + zonePoints/Triangles), the list of leg IDs that
 * participate in the gait cycle, and `WalkParams` sliders.
 *
 * Outputs : `walkBodyFrames` + `walkZoneFrames`, in the same shape consumed
 * by `zoneMeshRenderer` for the legacy walk and members-bones-v3 animations.
 *
 * The skeleton's joint count is flexible — body chain has N≥2 joints, each
 * leg has 2..N joints between hip and foot. Sub-bones are formed between
 * consecutive joints. LBS is computed per zone with weights restricted to
 * the bones that belong to that zone.
 */

import type {
  Point2D, WalkParams, CoTrackerSkeleton, ProjectTriangulation,
} from '../types/project'
import {
  solveElbowIK, computeBoneTransform, boneLocalMatrix, skinVerticesSubBones,
  pointToSegmentDistanceSq, type AffineMatrix,
} from './boneSolver'

const FPS = 24
const CYCLES_PER_ANIM = 4
const STANCE_RATIO = 0.6
const WEIGHT_EPSILON = 1.0
const WEIGHT_THRESHOLD = 0.01

interface SubBone {
  restHead: Point2D
  restTail: Point2D
}

export interface MarcheLegRest {
  hip: Point2D
  joints: Point2D[]   // 0..N intermediate joints (typically 1 = knee)
  foot: Point2D
}

export interface MarcheSolverInput {
  skeleton: CoTrackerSkeleton
  bodyJointRest: Point2D[]                              // image coords
  legRest: Record<string, MarcheLegRest>                // image coords, keyed by leg.id
  gaitLegIds: string[]                                  // subset of skeleton.legs[].id
  params: WalkParams
  triangulation: ProjectTriangulation
  /** Phase offset par leg.id (0..1). Override pour gait ET non-gait. */
  legPhases?: Record<string, number>
}

export interface MarcheSolverOutput {
  bodyFrames: Point2D[][]                               // image coords
  zoneFrames: Record<string, Point2D[][]>               // by zoneId
}

interface SubBoneIndex {
  // Body sub-bones occupy indices [0, nBody)
  // Each leg uses its own contiguous range; bones for leg id L = [legStart[L], legStart[L]+legCount[L])
  nBody: number
  legStart: Record<string, number>
  legCount: Record<string, number>
  total: number
}

function buildRestSubBones(input: MarcheSolverInput): { subBones: SubBone[]; idx: SubBoneIndex } {
  const subBones: SubBone[] = []
  const idx: SubBoneIndex = { nBody: 0, legStart: {}, legCount: {}, total: 0 }

  // Body: consecutive joints
  const body = input.bodyJointRest
  for (let i = 0; i < body.length - 1; i++) {
    subBones.push({ restHead: body[i], restTail: body[i + 1] })
  }
  idx.nBody = Math.max(0, body.length - 1)

  // Legs
  for (const leg of input.skeleton.legs) {
    const rest = input.legRest[leg.id]
    if (!rest) {
      idx.legStart[leg.id] = subBones.length
      idx.legCount[leg.id] = 0
      continue
    }
    const chain = [rest.hip, ...rest.joints, rest.foot]
    idx.legStart[leg.id] = subBones.length
    for (let i = 0; i < chain.length - 1; i++) {
      subBones.push({ restHead: chain[i], restTail: chain[i + 1] })
    }
    idx.legCount[leg.id] = chain.length - 1
  }

  idx.total = subBones.length
  return { subBones, idx }
}

// ─── Per-zone restricted weights ──────────────────────────────────────

function computeZoneWeights(
  zoneVertexPositions: Point2D[],
  allSubBones: SubBone[],
  allowedIndices: number[],
): number[][] {
  const nVerts = zoneVertexPositions.length
  const nSub = allSubBones.length
  const weights: number[][] = new Array(nVerts)

  for (let i = 0; i < nVerts; i++) {
    const p = zoneVertexPositions[i]
    const raw = new Array<number>(nSub).fill(0)
    let sum = 0

    for (const j of allowedIndices) {
      const sb = allSubBones[j]
      const dist = Math.sqrt(pointToSegmentDistanceSq(p, sb.restHead, sb.restTail))
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

    weights[i] = raw
  }
  return weights
}

// ─── Kinematics helpers ───────────────────────────────────────────────

function addOffset(p: Point2D, dx: number, dy: number): Point2D {
  return { x: p.x + dx, y: p.y + dy }
}

function rotateAround(p: Point2D, center: Point2D, angle: number): Point2D {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - center.x
  const dy = p.y - center.y
  return { x: center.x + cos * dx - sin * dy, y: center.y + sin * dx + cos * dy }
}

function computeFootPosition(
  restFoot: Point2D, strideLength: number, footLift: number, phase: number, direction: number,
): Point2D {
  const stride = strideLength * direction
  if (phase < STANCE_RATIO) {
    const t = phase / STANCE_RATIO
    return { x: restFoot.x + stride * (0.5 - t), y: restFoot.y }
  }
  const airPhase = (phase - STANCE_RATIO) / (1 - STANCE_RATIO)
  return {
    x: restFoot.x + stride * (-0.5 + airPhase),
    y: restFoot.y - footLift * Math.sin(Math.PI * airPhase),
  }
}

// ─── Body chain animation ─────────────────────────────────────────────

interface BodyState {
  joints: Point2D[]
  center: Point2D
  bodyDy: number
}

function computeBodyState(
  bodyJointRest: Point2D[], params: WalkParams, cyclePhase: number,
): BodyState {
  const bodyDy = -params.bodySway * Math.sin(2 * Math.PI * 2 * cyclePhase)

  // Center = mean of rest joints
  let cx = 0, cy = 0
  for (const p of bodyJointRest) { cx += p.x; cy += p.y }
  const n = Math.max(1, bodyJointRest.length)
  const center: Point2D = { x: cx / n, y: cy / n + bodyDy }

  // Translate every joint vertically; apply extra perpendicular head sway on terminal joint
  const joints: Point2D[] = bodyJointRest.map(p => ({ x: p.x, y: p.y + bodyDy }))

  // Head sway on last joint : perpendicular oscillation
  if (joints.length >= 2 && (params.headSway ?? 0) > 0) {
    const tail = joints[joints.length - 1]
    const prev = joints[joints.length - 2]
    const dirX = tail.x - prev.x
    const dirY = tail.y - prev.y
    const len = Math.hypot(dirX, dirY)
    if (len > 1e-3) {
      const perpX = -dirY / len
      const perpY = dirX / len
      const amp = ((params.headSway ?? 0) / 100) * params.bodySway * 1.2
      const phase = 2 * Math.PI * cyclePhase + Math.PI / 4
      const osc = amp * Math.sin(phase)
      joints[joints.length - 1] = { x: tail.x + perpX * osc, y: tail.y + perpY * osc }
    }
  }

  return { joints, center, bodyDy }
}

/**
 * Compute a small wobble offset for a non-gait foot : perpendicular sway +
 * vertical bob, phase-offset per leg, scaled by params.secondarySway.
 * Returns a delta to add to the rest foot position.
 */
function computeSecondaryFootOffset(
  rest: MarcheLegRest, params: WalkParams, cyclePhase: number, phaseOffset: number,
): Point2D {
  const amp = ((params.secondarySway ?? 30) / 100)
  if (amp <= 0) return { x: 0, y: 0 }
  const hipFoot = { x: rest.foot.x - rest.hip.x, y: rest.foot.y - rest.hip.y }
  const len = Math.hypot(hipFoot.x, hipFoot.y) || 1
  const perpX = -hipFoot.y / len, perpY = hipFoot.x / len
  const phi = 2 * Math.PI * (cyclePhase + phaseOffset)
  const lateral = amp * params.strideLength * 0.40 * Math.sin(phi)
  const bob = amp * params.footLift * 1.00 * Math.sin(phi * 2 + Math.PI / 3)
  return { x: perpX * lateral, y: perpY * lateral - bob }
}

/** Default phase per leg : gait → preset/uniform, non-gait → staggered. */
function defaultLegPhase(leg: { id: string }, gaitLegsList: { id: string }[], isGait: boolean): number {
  if (isGait) {
    const i = gaitLegsList.findIndex(l => l.id === leg.id)
    if (i < 0) return 0
    if (gaitLegsList.length === 4) return [0, 0.5, 0.25, 0.75][i]
    return i / Math.max(1, gaitLegsList.length)
  }
  // Non-gait : staggered to avoid resonance with quadruped gait
  const idx = Math.abs(hashString(leg.id)) % 100
  return (idx * 0.0137) % 1
}
function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

// ─── Leg animation ────────────────────────────────────────────────────

interface LegRestPrecomp {
  segLens: number[]               // chain length count (= joints.length+1)
  totalLen: number
  bendSide: number                // for 2-bone IK
}

function precomputeLegRest(rest: MarcheLegRest, kneeForward: boolean): LegRestPrecomp {
  const chain = [rest.hip, ...rest.joints, rest.foot]
  const segLens: number[] = []
  for (let i = 0; i < chain.length - 1; i++) {
    segLens.push(Math.hypot(chain[i + 1].x - chain[i].x, chain[i + 1].y - chain[i].y))
  }
  const totalLen = segLens.reduce((a, b) => a + b, 0)

  // bendSide from rest cross product (hip→mid→foot)
  let bendSide = 1
  if (rest.joints.length > 0) {
    const mid = rest.joints[0]
    const cross = (mid.x - rest.hip.x) * (rest.foot.y - rest.hip.y)
                - (mid.y - rest.hip.y) * (rest.foot.x - rest.hip.x)
    bendSide = cross >= 0 ? 1 : -1
  }
  if (kneeForward) bendSide = -bendSide

  return { segLens, totalLen, bendSide }
}

/**
 * Compute current joint positions for a leg.
 * - hip = transformed rest hip (follows body)
 * - foot = transformed rest foot + gait trajectory (if in gait set)
 * - intermediate joints : 2-bone IK if 1 intermediate joint, else proportional placement
 *   along straight hip→foot line (preserves segment length ratios).
 */
function computeLegFrame(
  rest: MarcheLegRest,
  precomp: LegRestPrecomp,
  hipCurrent: Point2D,
  footCurrent: Point2D,
): Point2D[] {
  const chainLen = rest.joints.length + 2  // hip + joints + foot

  // Clamp foot so hip→foot ≤ totalLen — keeps sub-bones at fixed length.
  // When the body lifts the hip beyond the leg's reach, the foot is pulled
  // toward the hip (it "leaves the ground").
  const dx0 = footCurrent.x - hipCurrent.x
  const dy0 = footCurrent.y - hipCurrent.y
  const d0 = Math.hypot(dx0, dy0)
  const maxLen = precomp.totalLen
  if (d0 > maxLen && d0 > 0) {
    const s = maxLen / d0
    footCurrent = { x: hipCurrent.x + dx0 * s, y: hipCurrent.y + dy0 * s }
  }

  const out: Point2D[] = new Array(chainLen)
  out[0] = hipCurrent
  out[chainLen - 1] = footCurrent

  if (rest.joints.length === 0) return out

  if (rest.joints.length === 1) {
    // 2-bone IK
    const thigh = precomp.segLens[0]
    const shin = precomp.segLens[1]
    const knee = solveElbowIK(hipCurrent, footCurrent, thigh, shin, precomp.bendSide)
    out[1] = knee
    return out
  }

  // ≥2 intermediate joints : interpolate proportionally along hip→foot segment.
  // Keeps the chain order but loses bend; acceptable for generic skeletons.
  let cumul = 0
  for (let i = 1; i < chainLen - 1; i++) {
    cumul += precomp.segLens[i - 1]
    const t = cumul / Math.max(precomp.totalLen, 1e-6)
    out[i] = {
      x: hipCurrent.x + (footCurrent.x - hipCurrent.x) * t,
      y: hipCurrent.y + (footCurrent.y - hipCurrent.y) * t,
    }
  }
  return out
}

// ─── Main ─────────────────────────────────────────────────────────────

export function computeMarcheFrames(
  input: MarcheSolverInput,
  onProgress?: (frame: number, total: number) => void,
): MarcheSolverOutput {
  const { skeleton, params, triangulation, bodyJointRest, legRest, gaitLegIds, legPhases: legPhasesIn } = input
  // Aligner sur un nombre entier d'images par cycle pour un loop seamless.
  const framesPerCycle = Math.max(2, Math.round(FPS / Math.max(params.speed, 0.01)))
  const totalFrames = CYCLES_PER_ANIM * framesPerCycle

  // Build rest sub-bones + index map
  const { subBones: restSubBones, idx } = buildRestSubBones(input)

  // Body weights : restrict to body sub-bone indices
  const bodyPts = triangulation.bodyPoints ?? []
  const bodyAllowed: number[] = []
  for (let i = 0; i < idx.nBody; i++) bodyAllowed.push(i)
  const bodyWeights = computeZoneWeights(bodyPts, restSubBones, bodyAllowed)

  // Zone weights : each zone restricted to its leg sub-bones if mapped, else body bones
  const zonePoints = triangulation.zonePoints ?? {}
  const zoneAllowed: Record<string, number[]> = {}
  for (const zoneId of Object.keys(zonePoints)) {
    if (zoneId === 'body') {
      zoneAllowed[zoneId] = bodyAllowed
      continue
    }
    const leg = skeleton.legs.find(l => l.zoneId === zoneId)
    if (leg && idx.legCount[leg.id] > 0) {
      const start = idx.legStart[leg.id]
      const allowed: number[] = []
      for (let i = 0; i < idx.legCount[leg.id]; i++) allowed.push(start + i)
      zoneAllowed[zoneId] = allowed
    } else {
      zoneAllowed[zoneId] = bodyAllowed
    }
  }
  const zoneWeights: Record<string, number[][]> = {}
  for (const zoneId of Object.keys(zonePoints)) {
    zoneWeights[zoneId] = computeZoneWeights(zonePoints[zoneId], restSubBones, zoneAllowed[zoneId])
  }

  // Leg precomputations + phase per leg (gait + non-gait)
  const legPrecomps: Record<string, LegRestPrecomp> = {}
  const gaitSet = new Set(gaitLegIds)
  const gaitLegsList = skeleton.legs.filter(l => gaitSet.has(l.id) && legRest[l.id])
  const nonGaitLegsList = skeleton.legs.filter(l => !gaitSet.has(l.id) && legRest[l.id])
  const legPhase: Record<string, number> = {}
  for (const leg of skeleton.legs) {
    if (!legRest[leg.id]) continue
    const isGait = gaitSet.has(leg.id)
    legPhase[leg.id] = legPhasesIn?.[leg.id]
      ?? defaultLegPhase(leg, isGait ? gaitLegsList : nonGaitLegsList, isGait)
    const isFront = gaitLegsList.indexOf(leg) < gaitLegsList.length / 2
    const kneeForward = isFront ? !!params.kneeForwardFront : !!params.kneeForwardBack
    legPrecomps[leg.id] = precomputeLegRest(legRest[leg.id], kneeForward)
  }

  // Body center for rotation reference (used for body sway swing)
  let bcx = 0, bcy = 0
  for (const p of bodyJointRest) { bcx += p.x; bcy += p.y }
  bcx /= Math.max(1, bodyJointRest.length)
  bcy /= Math.max(1, bodyJointRest.length)
  const restBodyCenter: Point2D = { x: bcx, y: bcy }

  const bodyFrames: Point2D[][] = new Array(totalFrames)
  const zoneFrames: Record<string, Point2D[][]> = {}
  for (const zoneId of Object.keys(zonePoints)) zoneFrames[zoneId] = new Array(totalFrames)

  for (let f = 0; f < totalFrames; f++) {
    const cyclePhase = ((f / totalFrames) * CYCLES_PER_ANIM) % 1

    // Body kinematic state
    const bodyState = computeBodyState(bodyJointRest, params, cyclePhase)

    // Jump : when gait feet are aerial, lift the body. Use mean aerial sin across gait legs.
    const jumpAmp = params.jumpHeight ?? 0
    let jumpDy = 0
    if (jumpAmp > 0 && gaitLegsList.length > 0) {
      let sum = 0
      for (const leg of gaitLegsList) {
        const phase = (cyclePhase + legPhase[leg.id]) % 1
        if (phase >= STANCE_RATIO) {
          const air = (phase - STANCE_RATIO) / (1 - STANCE_RATIO)
          sum += Math.sin(Math.PI * air)
        }
      }
      jumpDy = -jumpAmp * (sum / gaitLegsList.length)
    }

    // applyBody : shift any rest point by body dy + jump dy
    const tilt = (params.bodySway / 200) * Math.sin(2 * Math.PI * cyclePhase)
    const totalBodyDy = bodyState.bodyDy + jumpDy
    const applyBody = (p: Point2D): Point2D => {
      const shifted = addOffset(p, 0, totalBodyDy)
      return rotateAround(shifted, { x: restBodyCenter.x, y: restBodyCenter.y + totalBodyDy }, tilt)
    }

    // Build current sub-bones (in the same order as restSubBones)
    const currentSubBones: SubBone[] = new Array(restSubBones.length)

    // Body sub-bones from body chain joints — add jumpDy on top of bodyState (bodyDy + headSway)
    for (let i = 0; i < idx.nBody; i++) {
      const a = { x: bodyState.joints[i].x, y: bodyState.joints[i].y + jumpDy }
      const b = { x: bodyState.joints[i + 1].x, y: bodyState.joints[i + 1].y + jumpDy }
      const center = { x: restBodyCenter.x, y: restBodyCenter.y + totalBodyDy }
      currentSubBones[i] = {
        restHead: rotateAround(a, center, tilt),
        restTail: rotateAround(b, center, tilt),
      }
    }

    // Legs
    for (const leg of skeleton.legs) {
      const rest = legRest[leg.id]
      if (!rest) continue
      const precomp = legPrecomps[leg.id]
      const start = idx.legStart[leg.id]
      const count = idx.legCount[leg.id]
      if (count === 0) continue

      const hipCurrent = applyBody(rest.hip)
      let footCurrent: Point2D
      if (gaitSet.has(leg.id)) {
        const phase = (cyclePhase + (legPhase[leg.id] ?? 0)) % 1
        // For gait : foot is grounded relative to a static foot rest (NOT applyBody),
        // so the body jumps but the foot stays planted on the ground during stance.
        const baseFoot = jumpAmp > 0 ? rest.foot : applyBody(rest.foot)
        footCurrent = computeFootPosition(baseFoot, params.strideLength, params.footLift, phase, params.direction ?? 1)
      } else {
        const moved = applyBody(rest.foot)
        const wobble = computeSecondaryFootOffset(rest, params, cyclePhase, legPhase[leg.id] ?? 0)
        footCurrent = { x: moved.x + wobble.x, y: moved.y + wobble.y }
      }

      const chain = computeLegFrame(rest, precomp, hipCurrent, footCurrent)
      for (let i = 0; i < count; i++) {
        currentSubBones[start + i] = { restHead: chain[i], restTail: chain[i + 1] }
      }
    }

    // Build affine matrices
    const matrices: AffineMatrix[] = restSubBones.map((rest, i) => {
      const curr = currentSubBones[i]
      const transform = computeBoneTransform(rest.restHead, rest.restTail, curr.restHead, curr.restTail)
      return boneLocalMatrix(transform)
    })

    // LBS body
    bodyFrames[f] = skinVerticesSubBones(bodyPts, bodyWeights, matrices)

    // LBS per zone
    for (const zoneId of Object.keys(zonePoints)) {
      zoneFrames[zoneId][f] = skinVerticesSubBones(zonePoints[zoneId], zoneWeights[zoneId], matrices)
    }

    if (onProgress && f % 4 === 0) onProgress(f, totalFrames)
  }

  if (onProgress) onProgress(totalFrames, totalFrames)
  return { bodyFrames, zoneFrames }
}

// ─── Bone joint frames only (no LBS) ─────────────────────────────────

export interface MarcheBoneFramesOutput {
  /** Body joints (image coords). Indexing : [jointIdx][frame]. */
  bodyJointFramesImg: Point2D[][]
  /** Leg chains per leg.id (image coords). [legId][jointIdx][frame]. */
  legChainFramesByLegId: Record<string, Point2D[][]>
  /** Rest body joints (image coords, frame 0). */
  restBodyJointsImg: Point2D[]
  /** Rest leg chains per leg.id (image coords). [legId] -> [hip, ...joints, foot]. */
  restLegChainsByLegId: Record<string, Point2D[]>
  totalFrames: number
}

/**
 * Same kinematics as `computeMarcheFrames` but returns only bone joint frames
 * (no LBS, no triangulation needed). The downstream LBS pipeline consumes
 * these as cotrackerBodyJointFrames + cotrackerLegBoneFrames.
 */
export function computeMarcheBoneFrames(input: Omit<MarcheSolverInput, 'triangulation'>): MarcheBoneFramesOutput {
  const { skeleton, params, bodyJointRest, legRest, gaitLegIds, legPhases: legPhasesIn } = input
  // Aligner sur un nombre entier d'images par cycle pour un loop seamless.
  const framesPerCycle = Math.max(2, Math.round(FPS / Math.max(params.speed, 0.01)))
  const totalFrames = CYCLES_PER_ANIM * framesPerCycle

  const legPrecomps: Record<string, LegRestPrecomp> = {}
  const gaitSet = new Set(gaitLegIds)
  const gaitLegsList = skeleton.legs.filter(l => gaitSet.has(l.id) && legRest[l.id])
  const nonGaitLegsList = skeleton.legs.filter(l => !gaitSet.has(l.id) && legRest[l.id])
  const legPhase: Record<string, number> = {}
  for (const leg of skeleton.legs) {
    if (!legRest[leg.id]) continue
    const isGait = gaitSet.has(leg.id)
    legPhase[leg.id] = legPhasesIn?.[leg.id]
      ?? defaultLegPhase(leg, isGait ? gaitLegsList : nonGaitLegsList, isGait)
    const isFront = gaitLegsList.indexOf(leg) < gaitLegsList.length / 2
    const kneeForward = isFront ? !!params.kneeForwardFront : !!params.kneeForwardBack
    legPrecomps[leg.id] = precomputeLegRest(legRest[leg.id], kneeForward)
  }

  // Body center
  let bcx = 0, bcy = 0
  for (const p of bodyJointRest) { bcx += p.x; bcy += p.y }
  bcx /= Math.max(1, bodyJointRest.length)
  bcy /= Math.max(1, bodyJointRest.length)
  const restBodyCenter: Point2D = { x: bcx, y: bcy }

  // Init outputs : per-joint trajectories
  const bodyJointFramesImg: Point2D[][] = bodyJointRest.map(() => new Array(totalFrames))
  const legChainFramesByLegId: Record<string, Point2D[][]> = {}
  for (const leg of skeleton.legs) {
    const rest = legRest[leg.id]
    if (!rest) continue
    const chainLen = rest.joints.length + 2
    legChainFramesByLegId[leg.id] = Array.from({ length: chainLen }, () => new Array(totalFrames))
  }

  for (let f = 0; f < totalFrames; f++) {
    const cyclePhase = ((f / totalFrames) * CYCLES_PER_ANIM) % 1
    const bodyState = computeBodyState(bodyJointRest, params, cyclePhase)
    const tilt = (params.bodySway / 200) * Math.sin(2 * Math.PI * cyclePhase)

    // Jump
    const jumpAmp = params.jumpHeight ?? 0
    let jumpDy = 0
    if (jumpAmp > 0 && gaitLegsList.length > 0) {
      let sum = 0
      for (const leg of gaitLegsList) {
        const phase = (cyclePhase + legPhase[leg.id]) % 1
        if (phase >= STANCE_RATIO) {
          const air = (phase - STANCE_RATIO) / (1 - STANCE_RATIO)
          sum += Math.sin(Math.PI * air)
        }
      }
      jumpDy = -jumpAmp * (sum / gaitLegsList.length)
    }
    const totalBodyDy = bodyState.bodyDy + jumpDy
    const center = { x: restBodyCenter.x, y: restBodyCenter.y + totalBodyDy }
    const applyBody = (p: Point2D): Point2D => {
      const shifted = addOffset(p, 0, totalBodyDy)
      return rotateAround(shifted, center, tilt)
    }

    // Body joints : add jumpDy to the bodyState (which already has bodyDy + headSway), apply tilt.
    for (let j = 0; j < bodyJointRest.length; j++) {
      const lifted = { x: bodyState.joints[j].x, y: bodyState.joints[j].y + jumpDy }
      bodyJointFramesImg[j][f] = rotateAround(lifted, center, tilt)
    }

    // Legs
    for (const leg of skeleton.legs) {
      const rest = legRest[leg.id]
      if (!rest) continue
      const precomp = legPrecomps[leg.id]
      const hipCurrent = applyBody(rest.hip)
      let footCurrent: Point2D
      if (gaitSet.has(leg.id)) {
        const phase = (cyclePhase + (legPhase[leg.id] ?? 0)) % 1
        // When jumping, the foot's stance position stays planted on the ground (rest.foot),
        // not lifted by the body. The body+hip rise via jumpDy → leg extends naturally.
        const baseFoot = jumpAmp > 0 ? rest.foot : applyBody(rest.foot)
        footCurrent = computeFootPosition(baseFoot, params.strideLength, params.footLift, phase, params.direction ?? 1)
      } else {
        const moved = applyBody(rest.foot)
        const wobble = computeSecondaryFootOffset(rest, params, cyclePhase, legPhase[leg.id] ?? 0)
        footCurrent = { x: moved.x + wobble.x, y: moved.y + wobble.y }
      }
      const chain = computeLegFrame(rest, precomp, hipCurrent, footCurrent)
      const store = legChainFramesByLegId[leg.id]
      for (let i = 0; i < chain.length; i++) store[i][f] = chain[i]
    }
  }

  // Rest poses
  const restLegChainsByLegId: Record<string, Point2D[]> = {}
  for (const leg of skeleton.legs) {
    const rest = legRest[leg.id]
    if (!rest) continue
    restLegChainsByLegId[leg.id] = [rest.hip, ...rest.joints, rest.foot]
  }

  return {
    bodyJointFramesImg,
    legChainFramesByLegId,
    restBodyJointsImg: bodyJointRest.map(p => ({ ...p })),
    restLegChainsByLegId,
    totalFrames,
  }
}

/**
 * Extract rest positions of body + legs from a parent cotracker-bones animation's
 * smoothed (or raw) bone joint frames at frame 0. Falls back to evaluating the
 * skeleton refs against the parent's cotrackerFrames[*][0] if joint frames are
 * missing. Returns positions in the PARENT's coordinate space (video coords).
 *
 * Callers are responsible for converting to image coords if needed.
 */
export function extractRestFromParentMesh(parentMesh: {
  cotrackerSkeleton?: CoTrackerSkeleton
  cotrackerBodyJointFrames?: Point2D[][] | null
  cotrackerBodyJointFramesSmoothed?: Point2D[][] | null
  cotrackerLegBoneFrames?: Record<string, { chain: Point2D[][] }> | null
  cotrackerLegBoneFramesSmoothed?: Record<string, { chain: Point2D[][] }> | null
  cotrackerFrames?: Record<string, Point2D[]> | null
}): { bodyJointRest: Point2D[]; legRest: Record<string, MarcheLegRest> } | null {
  const sk = parentMesh.cotrackerSkeleton
  if (!sk) return null

  // Body joints rest = frame 0 of body joint frames (smoothed > raw > eval refs)
  const bodyFrames = parentMesh.cotrackerBodyJointFramesSmoothed
    ?? parentMesh.cotrackerBodyJointFrames
  let bodyJointRest: Point2D[]
  if (bodyFrames && bodyFrames.length > 0) {
    bodyJointRest = bodyFrames.map(jointSeries => ({ ...(jointSeries[0] ?? { x: 0, y: 0 }) }))
  } else if (parentMesh.cotrackerFrames) {
    bodyJointRest = sk.bodyChain.map(j => evalRef(j.ref, parentMesh.cotrackerFrames!, 0))
  } else {
    return null
  }

  // Legs rest from leg bone chains frame 0
  const legFrames = parentMesh.cotrackerLegBoneFramesSmoothed
    ?? parentMesh.cotrackerLegBoneFrames
    ?? {}
  const legRest: Record<string, MarcheLegRest> = {}
  for (const leg of sk.legs) {
    const chainFrames = legFrames[leg.id]?.chain
    if (chainFrames && chainFrames.length >= 2) {
      const chain = chainFrames.map(series => ({ ...(series[0] ?? { x: 0, y: 0 }) }))
      legRest[leg.id] = {
        hip: chain[0],
        joints: chain.slice(1, -1),
        foot: chain[chain.length - 1],
      }
    } else if (parentMesh.cotrackerFrames) {
      legRest[leg.id] = {
        hip: evalRef(leg.hip, parentMesh.cotrackerFrames, 0),
        joints: leg.joints.map(j => evalRef(j, parentMesh.cotrackerFrames!, 0)),
        foot: evalRef(leg.foot, parentMesh.cotrackerFrames, 0),
      }
    }
  }

  return { bodyJointRest, legRest }
}

/**
 * Build the marche inheritance snapshot from a parent cotracker-bones animation's
 * mesh, ready to merge into a marche animation's mesh. Returns positions in IMAGE
 * coords (video→image conversion already applied).
 *
 * Returns null if the parent doesn't have a validated skeleton + bone frames.
 */
export function buildMarcheInheritSnapshot(
  parentAnimId: string,
  parentMesh: {
    cotrackerSkeleton?: CoTrackerSkeleton
    cotrackerBodyJointFrames?: Point2D[][] | null
    cotrackerBodyJointFramesSmoothed?: Point2D[][] | null
    cotrackerLegBoneFrames?: Record<string, { chain: Point2D[][] }> | null
    cotrackerLegBoneFramesSmoothed?: Record<string, { chain: Point2D[][] }> | null
    cotrackerFrames?: Record<string, Point2D[]> | null
    cotrackerVideoWidth?: number
    cotrackerVideoHeight?: number
  },
  imgW: number,
  imgH: number,
): {
  marcheParentAnimationId: string
  marcheSkeleton: CoTrackerSkeleton
  marcheBodyJointRestPositions: Point2D[]
  marcheLegRestPositions: Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }>
  marcheInheritValidated: true
} | null {
  const rest = extractRestFromParentMesh(parentMesh)
  if (!rest || !parentMesh.cotrackerSkeleton) return null

  const vidW = parentMesh.cotrackerVideoWidth ?? imgW
  const vidH = parentMesh.cotrackerVideoHeight ?? imgH
  const sx = imgW / Math.max(vidW, 1)
  const sy = imgH / Math.max(vidH, 1)
  const mapPt = (p: Point2D): Point2D => ({ x: p.x * sx, y: p.y * sy })

  const bodyJointRestPositions = rest.bodyJointRest.map(mapPt)
  const legRestPositions: Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }> = {}
  for (const [legId, lr] of Object.entries(rest.legRest)) {
    legRestPositions[legId] = {
      hip: mapPt(lr.hip),
      joints: lr.joints.map(mapPt),
      foot: mapPt(lr.foot),
    }
  }

  // La marche procédurale n'a pas de tracking cotracker pour piloter une
  // mâchoire — on strip le champ `jaw` du snapshot.
  const skeletonCopy: CoTrackerSkeleton = JSON.parse(JSON.stringify(parentMesh.cotrackerSkeleton))
  skeletonCopy.jaw = null

  return {
    marcheParentAnimationId: parentAnimId,
    marcheSkeleton: skeletonCopy,
    marcheBodyJointRestPositions: bodyJointRestPositions,
    marcheLegRestPositions: legRestPositions,
    marcheInheritValidated: true,
  }
}

function evalRef(
  ref: { pointIds: string[]; weights: number[] },
  frames: Record<string, Point2D[]>,
  frameIdx: number,
): Point2D {
  let x = 0, y = 0
  for (let i = 0; i < ref.pointIds.length; i++) {
    const series = frames[ref.pointIds[i]]
    const p = series?.[frameIdx]
    if (p) { x += (ref.weights[i] ?? 0) * p.x; y += (ref.weights[i] ?? 0) * p.y }
  }
  return { x, y }
}
