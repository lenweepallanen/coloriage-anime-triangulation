/**
 * CoTracker bones — LBS compute with multiple modes.
 *
 * Modes :
 *  - 'lbs'      : skinning classique, weights = 1/(d+ε)^p
 *  - 'lbs-arap' : contour pinné aux positions LBS, ARAP-solve pour l'intérieur
 *  - 'lbs-area' : LBS classique + post-pass de préservation d'aire par triangle
 *
 * Toujours produit :
 *  - walkBodyFrames / walkZoneFrames
 *  - cotrackerBodyJointFrames / cotrackerLegBoneFrames (positions joints brutes vidéo)
 */

import type {
  Project, Animation, Point2D, CoTrackerLBSParams,
} from '../types/project'
import {
  resolveCoTrackerBodyChain,
  computeCoTrackerLegRestPose,
  resolveCoTrackerSkeletonFrame,
  type CoTrackerSkeletonFrame,
  type CoTrackerLegRestPose,
} from './cotrackerBoneSolver'
import {
  pointToSegmentDistanceSq,
  computeBoneTransform,
  boneLocalMatrix,
  skinVerticesSubBones,
  type AffineMatrix,
} from './boneSolver'
import { precomputeARAP, batchSolveARAP } from './arapSolver'

const WEIGHT_THRESHOLD = 0.01

function videoToImage(p: Point2D, imgW: number, imgH: number, vidW: number, vidH: number): Point2D {
  return { x: p.x * (imgW / vidW), y: p.y * (imgH / vidH) }
}

function computeWeights(
  restVertices: Point2D[],
  subBones: { head: Point2D; tail: Point2D }[],
  power: number, epsilon: number,
): number[][] {
  const out: number[][] = new Array(restVertices.length)
  for (let i = 0; i < restVertices.length; i++) {
    const p = restVertices[i]
    const raw = new Array<number>(subBones.length)
    let s = 0
    for (let j = 0; j < subBones.length; j++) {
      const d = Math.sqrt(pointToSegmentDistanceSq(p, subBones[j].head, subBones[j].tail))
      const w = 1.0 / Math.pow(d + epsilon, power)
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

/** Post-pass : pour chaque triangle, ramène l'aire vers l'aire de repos en
 *  scalant les positions autour du centroïde. Strength ∈ [0,1]. Moyenne les
 *  corrections par vertex (un vertex appartient à plusieurs triangles). */
function preserveAreaInPlace(
  positions: Point2D[],
  restPositions: Point2D[],
  triangles: [number, number, number][],
  strength: number,
) {
  if (strength <= 0) return
  // Aire signée
  const area = (a: Point2D, b: Point2D, c: Point2D) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * 0.5

  const sumX = new Float64Array(positions.length)
  const sumY = new Float64Array(positions.length)
  const count = new Uint32Array(positions.length)

  for (const [ia, ib, ic] of triangles) {
    const a = positions[ia], b = positions[ib], c = positions[ic]
    if (!a || !b || !c) continue
    const ra = restPositions[ia], rb = restPositions[ib], rc = restPositions[ic]
    const Acur = area(a, b, c)
    const Arest = area(ra, rb, rc)
    if (Acur < 1e-6 || Arest < 1e-6) continue
    const s = Math.sqrt(Arest / Acur)
    const scaleClamped = 1 + (s - 1) * strength
    const cx = (a.x + b.x + c.x) / 3
    const cy = (a.y + b.y + c.y) / 3
    for (const idx of [ia, ib, ic]) {
      const p = positions[idx]
      const nx = cx + (p.x - cx) * scaleClamped
      const ny = cy + (p.y - cy) * scaleClamped
      sumX[idx] += nx; sumY[idx] += ny; count[idx]++
    }
  }
  for (let i = 0; i < positions.length; i++) {
    if (count[i] > 0) {
      positions[i] = { x: sumX[i] / count[i], y: sumY[i] / count[i] }
    }
  }
}

export interface LBSComputeResult {
  walkBodyFrames: Point2D[][]
  walkZoneFrames: Record<string, Point2D[][]>
  cotrackerBodyJointFrames: Point2D[][]
  cotrackerLegBoneFrames: Record<string, { chain: Point2D[][] }>
}

export async function runCoTrackerLBSCompute(
  project: Project, animation: Animation,
  params: CoTrackerLBSParams,
  onProgress?: (p: { phase: string; frame: number; total: number }) => void,
): Promise<LBSComputeResult> {
  const mesh = animation.mesh!
  const tri = project.projectTriangulation!
  const skeleton = mesh.cotrackerSkeleton!
  const ctFrames = mesh.cotrackerFrames!
  const vidW = mesh.cotrackerVideoWidth!
  const vidH = mesh.cotrackerVideoHeight!
  const imgW = tri.maskWidth
  const imgH = tri.maskHeight

  const anyTraj = Object.values(ctFrames)[0]
  const totalFrames = anyTraj?.length ?? 0
  if (totalFrames === 0) throw new Error('Aucune frame trackée')

  const power = params.weightPower
  const epsilon = params.weightEpsilon

  onProgress?.({ phase: 'Rest poses', frame: 0, total: totalFrames })

  // ── Body rest pose + weights ─────────────────────────────────────
  const bodyJointsF0Vid = resolveCoTrackerBodyChain(skeleton.bodyChain, ctFrames, 0)
  const bodyJointsF0Img = bodyJointsF0Vid.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
  const restBodySubBones: { head: Point2D; tail: Point2D }[] = []
  for (let i = 0; i < bodyJointsF0Img.length - 1; i++) {
    restBodySubBones.push({ head: bodyJointsF0Img[i], tail: bodyJointsF0Img[i + 1] })
  }
  if (restBodySubBones.length === 0) throw new Error('Body chain : au moins 2 joints requis')
  const bodyWeights = computeWeights(tri.bodyPoints, restBodySubBones, power, epsilon)

  // ── Leg rest poses + weights ─────────────────────────────────────
  const legRestPoses: CoTrackerLegRestPose[] = skeleton.legs.map(leg =>
    computeCoTrackerLegRestPose(leg, ctFrames)
  )
  const legSubBones: Record<string, { head: Point2D; tail: Point2D }[]> = {}
  const legWeights: Record<string, number[][]> = {}
  for (let li = 0; li < skeleton.legs.length; li++) {
    const leg = skeleton.legs[li]
    const chainImg = legRestPoses[li].chain.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
    const subs: { head: Point2D; tail: Point2D }[] = []
    for (let i = 0; i < chainImg.length - 1; i++) subs.push({ head: chainImg[i], tail: chainImg[i + 1] })
    legSubBones[leg.zoneId] = subs
    const zonePts = tri.zonePoints[leg.zoneId]
    if (zonePts && subs.length > 0) legWeights[leg.zoneId] = computeWeights(zonePts, subs, power, epsilon)
  }

  // ── Pre-compute ARAP systems if needed ───────────────────────────
  type ArapSystem = ReturnType<typeof precomputeARAP>
  let bodyArap: ArapSystem | null = null
  const zoneArap: Record<string, ArapSystem> = {}
  const bodyContourLen = tri.zoneContourLength?.['body'] ?? 0
  if (params.mode === 'lbs-arap' && bodyContourLen > 1) {
    const pinned = Array.from({ length: bodyContourLen }, (_, i) => i)
    bodyArap = precomputeARAP(tri.bodyPoints, tri.bodyTriangles, pinned)
  }
  if (params.mode === 'lbs-arap') {
    for (const leg of skeleton.legs) {
      const len = tri.zoneContourLength?.[leg.zoneId] ?? 0
      const zonePts = tri.zonePoints[leg.zoneId]
      const zoneTris = tri.zoneTriangles[leg.zoneId]
      if (len > 1 && zonePts && zoneTris) {
        const pinned = Array.from({ length: len }, (_, i) => i)
        zoneArap[leg.zoneId] = precomputeARAP(zonePts, zoneTris, pinned)
      }
    }
  }

  // ── Per-frame LBS ─────────────────────────────────────────────────
  const walkBodyFrames: Point2D[][] = new Array(totalFrames)
  const walkZoneFrames: Record<string, Point2D[][]> = {}
  const cotrackerBodyJointFrames: Point2D[][] = []
  const cotrackerLegBoneFrames: Record<string, { chain: Point2D[][] }> = {}
  for (const leg of skeleton.legs) {
    walkZoneFrames[leg.zoneId] = new Array(totalFrames)
    const chainLen = 2 + (leg.joints?.length ?? 0)
    cotrackerLegBoneFrames[leg.zoneId] = { chain: Array.from({ length: chainLen }, () => []) }
  }
  for (let j = 0; j < skeleton.bodyChain.length; j++) cotrackerBodyJointFrames.push([])

  let prevSkeletonFrame: CoTrackerSkeletonFrame | null = null
  for (let f = 0; f < totalFrames; f++) {
    const skf = resolveCoTrackerSkeletonFrame(skeleton, ctFrames, f, legRestPoses, prevSkeletonFrame)
    prevSkeletonFrame = skf
    skf.bodyJoints.forEach((p, j) => { cotrackerBodyJointFrames[j].push(p) })
    skf.legs.forEach((legF, li) => {
      const zoneId = skeleton.legs[li].zoneId
      const chainStore = cotrackerLegBoneFrames[zoneId].chain
      legF.chain.forEach((p, i) => { chainStore[i].push(p) })
    })

    const bodyJointsImg = skf.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
    const bodyMatrices: AffineMatrix[] = []
    for (let i = 0; i < restBodySubBones.length; i++) {
      const curr = { head: bodyJointsImg[i], tail: bodyJointsImg[i + 1] }
      const rest = restBodySubBones[i]
      bodyMatrices.push(boneLocalMatrix(computeBoneTransform(rest.head, rest.tail, curr.head, curr.tail)))
    }
    walkBodyFrames[f] = skinVerticesSubBones(tri.bodyPoints, bodyWeights, bodyMatrices)

    for (let li = 0; li < skeleton.legs.length; li++) {
      const leg = skeleton.legs[li]
      const legF = skf.legs[li]
      const chainImg = legF.chain.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
      const rest = legSubBones[leg.zoneId]
      const matrices: AffineMatrix[] = []
      for (let i = 0; i < rest.length; i++) {
        matrices.push(boneLocalMatrix(computeBoneTransform(rest[i].head, rest[i].tail, chainImg[i], chainImg[i + 1])))
      }
      const zonePts = tri.zonePoints[leg.zoneId]
      const zoneW = legWeights[leg.zoneId]
      if (zonePts && zoneW && matrices.length > 0) {
        walkZoneFrames[leg.zoneId][f] = skinVerticesSubBones(zonePts, zoneW, matrices)
      }
    }

    // ── lbs-area : correction d'aire par triangle ──
    if (params.mode === 'lbs-area') {
      const s = params.areaStrength ?? 0.5
      preserveAreaInPlace(walkBodyFrames[f], tri.bodyPoints, tri.bodyTriangles, s)
      for (const leg of skeleton.legs) {
        const fr = walkZoneFrames[leg.zoneId][f]
        const zonePts = tri.zonePoints[leg.zoneId]
        const zoneTris = tri.zoneTriangles[leg.zoneId]
        if (fr && zonePts && zoneTris) preserveAreaInPlace(fr, zonePts, zoneTris, s)
      }
    }

    if (f % 5 === 0) onProgress?.({ phase: params.mode, frame: f, total: totalFrames })
  }

  // ── lbs-arap : batch solve contour-pinned, intérieur ARAP ──
  if (params.mode === 'lbs-arap') {
    const iters = params.arapIterations ?? 3
    if (bodyArap && bodyContourLen > 0) {
      onProgress?.({ phase: 'ARAP body', frame: 0, total: totalFrames })
      const pinnedFrames = walkBodyFrames.map(f => f.slice(0, bodyContourLen))
      const solved = batchSolveARAP(bodyArap, pinnedFrames, iters)
      for (let f = 0; f < totalFrames; f++) walkBodyFrames[f] = solved[f]
    }
    for (const leg of skeleton.legs) {
      const system = zoneArap[leg.zoneId]
      const len = tri.zoneContourLength?.[leg.zoneId] ?? 0
      if (!system || len === 0) continue
      onProgress?.({ phase: `ARAP ${leg.zoneId}`, frame: 0, total: totalFrames })
      const pinnedFrames = walkZoneFrames[leg.zoneId].map(f => f.slice(0, len))
      const solved = batchSolveARAP(system, pinnedFrames, iters)
      for (let f = 0; f < totalFrames; f++) walkZoneFrames[leg.zoneId][f] = solved[f]
    }
  }

  return { walkBodyFrames, walkZoneFrames, cotrackerBodyJointFrames, cotrackerLegBoneFrames }
}
