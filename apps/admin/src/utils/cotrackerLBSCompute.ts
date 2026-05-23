/**
 * CoTracker bones — LBS compute with multiple modes.
 *
 * Modes :
 *  - 'lbs-arap'         : contour pinné aux positions LBS, ARAP-solve pour l'intérieur
 *  - 'lbs-contour-arap' : ARAP 1D sur contour (cibles douces LBS) puis ARAP body
 *
 * Toujours produit :
 *  - walkBodyFrames / walkZoneFrames
 *  - cotrackerBodyJointFrames / cotrackerLegBoneFrames (positions joints brutes vidéo)
 */

import type {
  Project, Animation, Point2D, CoTrackerLBSParams,
} from '../types/project'
import { computeJawOpennessFrames } from './cotrackerJawCompute'
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
import { precomputeContourArap, solveContourArapFrame, type ContourArapSystem } from './contourArap'

const WEIGHT_THRESHOLD = 0.01

/** Construit l'adjacence one-ring d'un mesh depuis sa liste de triangles. */
function buildVertexAdjacency(
  numVertices: number,
  triangles: [number, number, number][],
): number[][] {
  const sets: Set<number>[] = Array.from({ length: numVertices }, () => new Set<number>())
  for (const [a, b, c] of triangles) {
    sets[a].add(b); sets[a].add(c)
    sets[b].add(a); sets[b].add(c)
    sets[c].add(a); sets[c].add(b)
  }
  return sets.map(s => Array.from(s))
}

/**
 * Lissage Laplacien des weights sur le graphe du mesh.
 *
 *   weights[i][j] ← (1-α)·weights[i][j] + α·moyenne(weights[v][j] pour v voisin)
 *
 * Itéré k fois. Renormalise chaque vertex (Σ_j = 1) après chaque passe.
 * Diffuse les transitions brusques entre bones sur plusieurs vertices voisins.
 */
function smoothWeightsLaplacian(
  weights: number[][],
  triangles: [number, number, number][],
  iterations: number,
  alpha: number,
): number[][] {
  if (iterations <= 0 || alpha <= 0 || weights.length === 0) return weights
  const numV = weights.length
  const numB = weights[0].length
  const adj = buildVertexAdjacency(numV, triangles)
  let cur = weights.map(w => w.slice())
  for (let iter = 0; iter < iterations; iter++) {
    const next: number[][] = new Array(numV)
    for (let i = 0; i < numV; i++) {
      const neighbors = adj[i]
      const n = neighbors.length
      const row = cur[i]
      const nrow = new Array<number>(numB)
      if (n === 0) {
        for (let j = 0; j < numB; j++) nrow[j] = row[j]
      } else {
        for (let j = 0; j < numB; j++) {
          let sum = 0
          for (let k = 0; k < n; k++) sum += cur[neighbors[k]][j]
          nrow[j] = (1 - alpha) * row[j] + alpha * (sum / n)
        }
        let s = 0
        for (let j = 0; j < numB; j++) s += nrow[j]
        if (s > 0) for (let j = 0; j < numB; j++) nrow[j] /= s
      }
      next[i] = nrow
    }
    cur = next
  }
  return cur
}

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

/**
 * Post-pass préservation d'aire **lissée spatialement**.
 *
 * Chaque vertex calcule son facteur de "déficit d'aire" (sqrt du rapport entre
 * aire de repos et aire courante moyenne des triangles incidents). Ce champ
 * scalaire est lissé sur le mesh (1 passe Laplacienne), puis chaque vertex
 * s'écarte/se rapproche de la moyenne de ses voisins proportionnellement à son
 * scale local. Comme les voisins ont des scales proches après lissage, ils se
 * déplacent ensemble → pas de triangles dégénérés.
 *
 * Pour 1 itération avec `strength`=1 et un seul triangle, c'est ≈ équivalent à
 * scaler le triangle pour retrouver son aire. Plusieurs itérations convergent
 * vers la pleine préservation à l'échelle de la zone.
 */
function applyAreaPreservationPass(
  positions: Point2D[],
  restPositions: Point2D[],
  triangles: [number, number, number][],
  adjacency: number[][],
  strength: number,
  iterations: number,
) {
  if (strength <= 0 || iterations <= 0) return
  const n = positions.length
  const area = (a: Point2D, b: Point2D, c: Point2D) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) * 0.5

  // Pré-calcul des aires de repos (constantes pour toutes les itérations).
  const restAreas = new Float64Array(triangles.length)
  for (let t = 0; t < triangles.length; t++) {
    const [ia, ib, ic] = triangles[t]
    restAreas[t] = area(restPositions[ia], restPositions[ib], restPositions[ic])
  }

  for (let it = 0; it < iterations; it++) {
    // 1) Aires courantes
    const curAreas = new Float64Array(triangles.length)
    for (let t = 0; t < triangles.length; t++) {
      const [ia, ib, ic] = triangles[t]
      curAreas[t] = area(positions[ia], positions[ib], positions[ic])
    }
    // 2) Scale par vertex = sqrt(rest_avg / cur_avg) sur triangles incidents
    const sumRest = new Float64Array(n)
    const sumCur = new Float64Array(n)
    for (let t = 0; t < triangles.length; t++) {
      const [ia, ib, ic] = triangles[t]
      sumRest[ia] += restAreas[t]; sumCur[ia] += curAreas[t]
      sumRest[ib] += restAreas[t]; sumCur[ib] += curAreas[t]
      sumRest[ic] += restAreas[t]; sumCur[ic] += curAreas[t]
    }
    const scale = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      if (sumCur[i] > 1e-6) scale[i] = Math.sqrt(sumRest[i] / sumCur[i])
      else scale[i] = 1
    }
    // 3) Lissage Laplacien 1 passe du champ scale
    const scaleSm = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const nb = adjacency[i]
      if (nb.length === 0) { scaleSm[i] = scale[i]; continue }
      let s = scale[i]
      for (let k = 0; k < nb.length; k++) s += scale[nb[k]]
      scaleSm[i] = s / (nb.length + 1)
    }
    // 4) Déplacement par vertex : v ← c + s · (v − c), blendé par strength
    const next: Point2D[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const nb = adjacency[i]
      if (nb.length === 0) { next[i] = positions[i]; continue }
      let cx = 0, cy = 0
      for (let k = 0; k < nb.length; k++) { cx += positions[nb[k]].x; cy += positions[nb[k]].y }
      cx /= nb.length; cy /= nb.length
      const s = scaleSm[i]
      const tx = cx + s * (positions[i].x - cx)
      const ty = cy + s * (positions[i].y - cy)
      next[i] = {
        x: (1 - strength) * positions[i].x + strength * tx,
        y: (1 - strength) * positions[i].y + strength * ty,
      }
    }
    for (let i = 0; i < n; i++) positions[i] = next[i]
  }
}

export interface LBSComputeResult {
  walkBodyFrames: Point2D[][]
  walkZoneFrames: Record<string, Point2D[][]>
  cotrackerBodyJointFrames: Point2D[][]
  cotrackerLegBoneFrames: Record<string, { chain: Point2D[][] }>
  cotrackerJawOpennessFrames: number[] | null
}

/** Override bone frames already resolved in image coords (no cotrackerFrames needed). */
export interface LBSBoneFramesOverride {
  /** Body joints rest pose (image coords, frame 0). */
  restBodyJointsImg: Point2D[]
  /** Leg rest chain per zoneId (image coords). chain[0]=hip, last=foot. */
  restLegChainsImg: Record<string, Point2D[]>
  /** Per-frame body joints in image coords. Indexing: [jointIdx][frame]. */
  bodyJointFramesImg: Point2D[][]
  /** Per-frame leg chains per zoneId, image coords. [zoneId][jointIdx][frame]. */
  legChainFramesImg: Record<string, Point2D[][]>
  totalFrames: number
}

export async function runCoTrackerLBSCompute(
  project: Project, animation: Animation,
  params: CoTrackerLBSParams,
  onProgress?: (p: { phase: string; frame: number; total: number }) => void,
  override?: LBSBoneFramesOverride,
): Promise<LBSComputeResult> {
  const mesh = animation.mesh!
  const tri = project.projectTriangulation!
  const skeleton = mesh.cotrackerSkeleton!
  const ctFrames = override ? null : mesh.cotrackerFrames!
  const vidW = mesh.cotrackerVideoWidth ?? tri.maskWidth
  const vidH = mesh.cotrackerVideoHeight ?? tri.maskHeight
  const imgW = tri.maskWidth
  const imgH = tri.maskHeight

  let totalFrames: number
  if (override) {
    totalFrames = override.totalFrames
  } else {
    const anyTraj = Object.values(ctFrames!)[0]
    totalFrames = anyTraj?.length ?? 0
  }
  if (totalFrames === 0) throw new Error('Aucune frame trackée')

  const power = params.weightPower
  const epsilon = params.weightEpsilon
  const smoothIter = params.weightSmoothIterations ?? 0
  const smoothAlpha = params.weightSmoothAlpha ?? 0.5

  onProgress?.({ phase: 'Rest poses', frame: 0, total: totalFrames })

  // ── Body rest pose + weights ─────────────────────────────────────
  const bodyJointsF0Img = override
    ? override.restBodyJointsImg
    : resolveCoTrackerBodyChain(skeleton.bodyChain, ctFrames!, 0).map(p => videoToImage(p, imgW, imgH, vidW, vidH))
  const restBodySubBones: { head: Point2D; tail: Point2D }[] = []
  for (let i = 0; i < bodyJointsF0Img.length - 1; i++) {
    restBodySubBones.push({ head: bodyJointsF0Img[i], tail: bodyJointsF0Img[i + 1] })
  }
  if (restBodySubBones.length === 0) throw new Error('Body chain : au moins 2 joints requis')
  let bodyWeights = computeWeights(tri.bodyPoints, restBodySubBones, power, epsilon)
  if (smoothIter > 0) {
    bodyWeights = smoothWeightsLaplacian(bodyWeights, tri.bodyTriangles, smoothIter, smoothAlpha)
  }

  // ── Leg rest poses + weights ─────────────────────────────────────
  const legRestPoses: CoTrackerLegRestPose[] = override
    ? []
    : skeleton.legs.map(leg => computeCoTrackerLegRestPose(leg, ctFrames!))
  const legSubBones: Record<string, { head: Point2D; tail: Point2D }[]> = {}
  const legWeights: Record<string, number[][]> = {}
  for (let li = 0; li < skeleton.legs.length; li++) {
    const leg = skeleton.legs[li]
    const chainImg = override
      ? (override.restLegChainsImg[leg.zoneId] ?? [])
      : legRestPoses[li].chain.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
    const subs: { head: Point2D; tail: Point2D }[] = []
    for (let i = 0; i < chainImg.length - 1; i++) subs.push({ head: chainImg[i], tail: chainImg[i + 1] })
    legSubBones[leg.zoneId] = subs
    const zonePts = tri.zonePoints[leg.zoneId]
    if (zonePts && subs.length > 0) {
      let w = computeWeights(zonePts, subs, power, epsilon)
      const zoneTris = tri.zoneTriangles[leg.zoneId]
      if (smoothIter > 0 && zoneTris) {
        w = smoothWeightsLaplacian(w, zoneTris, smoothIter, smoothAlpha)
      }
      legWeights[leg.zoneId] = w
    }
  }

  // ── Pre-compute ARAP systems if needed ───────────────────────────
  type ArapSystem = ReturnType<typeof precomputeARAP>
  let bodyArap: ArapSystem | null = null
  const zoneArap: Record<string, ArapSystem> = {}
  const bodyContourLen = tri.zoneContourLength?.['body'] ?? 0
  const needsBodyArap = params.mode === 'lbs-arap' || params.mode === 'lbs-contour-arap'
  if (needsBodyArap && bodyContourLen > 1) {
    const pinned = Array.from({ length: bodyContourLen }, (_, i) => i)
    bodyArap = precomputeARAP(tri.bodyPoints, tri.bodyTriangles, pinned)
  }
  if (needsBodyArap) {
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

  // ── Pre-compute systèmes ARAP 1D contour si lbs-contour-arap ─────
  let bodyContourArap: ContourArapSystem | null = null
  const zoneContourArap: Record<string, ContourArapSystem> = {}
  if (params.mode === 'lbs-contour-arap') {
    const lambda = Math.max(1e-3, params.contourArapLambda ?? 1.0)
    if (bodyContourLen > 2) {
      bodyContourArap = precomputeContourArap(tri.bodyPoints.slice(0, bodyContourLen), lambda)
    }
    for (const leg of skeleton.legs) {
      const len = tri.zoneContourLength?.[leg.zoneId] ?? 0
      const zonePts = tri.zonePoints[leg.zoneId]
      if (len > 2 && zonePts) {
        zoneContourArap[leg.zoneId] = precomputeContourArap(zonePts.slice(0, len), lambda)
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
    let bodyJointsImg: Point2D[]
    let legChainsImg: Point2D[][]  // per leg index → chain
    if (override) {
      bodyJointsImg = override.bodyJointFramesImg.map(traj => traj[f])
      legChainsImg = skeleton.legs.map(leg => {
        const chains = override.legChainFramesImg[leg.zoneId] ?? []
        return chains.map(jointTraj => jointTraj[f])
      })
      // Store raw bone frames (in image coords — for marche, video=image)
      bodyJointsImg.forEach((p, j) => { cotrackerBodyJointFrames[j].push(p) })
      legChainsImg.forEach((chain, li) => {
        const zoneId = skeleton.legs[li].zoneId
        const store = cotrackerLegBoneFrames[zoneId].chain
        chain.forEach((p, i) => { store[i].push(p) })
      })
    } else {
      const skf = resolveCoTrackerSkeletonFrame(skeleton, ctFrames!, f, legRestPoses, prevSkeletonFrame)
      prevSkeletonFrame = skf
      skf.bodyJoints.forEach((p, j) => { cotrackerBodyJointFrames[j].push(p) })
      skf.legs.forEach((legF, li) => {
        const zoneId = skeleton.legs[li].zoneId
        const chainStore = cotrackerLegBoneFrames[zoneId].chain
        legF.chain.forEach((p, i) => { chainStore[i].push(p) })
      })
      bodyJointsImg = skf.bodyJoints.map(p => videoToImage(p, imgW, imgH, vidW, vidH))
      legChainsImg = skf.legs.map(legF => legF.chain.map(p => videoToImage(p, imgW, imgH, vidW, vidH)))
    }
    const bodyMatrices: AffineMatrix[] = []
    for (let i = 0; i < restBodySubBones.length; i++) {
      const curr = { head: bodyJointsImg[i], tail: bodyJointsImg[i + 1] }
      const rest = restBodySubBones[i]
      bodyMatrices.push(boneLocalMatrix(computeBoneTransform(rest.head, rest.tail, curr.head, curr.tail)))
    }
    walkBodyFrames[f] = skinVerticesSubBones(tri.bodyPoints, bodyWeights, bodyMatrices)

    for (let li = 0; li < skeleton.legs.length; li++) {
      const leg = skeleton.legs[li]
      const chainImg = legChainsImg[li] ?? []
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

    if (f % 5 === 0) onProgress?.({ phase: params.mode, frame: f, total: totalFrames })
  }

  // ── lbs-arap : batch solve contour-pinned (positions LBS), intérieur ARAP ──
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

  // ── lbs-contour-arap : ARAP 1D sur contour (LBS = cibles douces),
  //    puis ARAP body avec nouveau contour pinné dur. ──
  if (params.mode === 'lbs-contour-arap') {
    const cIters = Math.max(1, params.contourArapIterations ?? 2)
    const bIters = params.arapIterations ?? 3

    // Body : relax contour 1D puis ARAP body
    if (bodyContourArap && bodyContourLen > 0) {
      onProgress?.({ phase: 'Contour ARAP body', frame: 0, total: totalFrames })
      const newContourFrames: Point2D[][] = new Array(totalFrames)
      for (let f = 0; f < totalFrames; f++) {
        const lbsContour = walkBodyFrames[f].slice(0, bodyContourLen)
        newContourFrames[f] = solveContourArapFrame(bodyContourArap, lbsContour, cIters)
        // Réécrit le contour relaxé dans la frame (l'intérieur sera ré-résolu juste après)
        for (let i = 0; i < bodyContourLen; i++) walkBodyFrames[f][i] = newContourFrames[f][i]
      }
      if (bodyArap) {
        onProgress?.({ phase: 'ARAP body', frame: 0, total: totalFrames })
        const solved = batchSolveARAP(bodyArap, newContourFrames, bIters)
        for (let f = 0; f < totalFrames; f++) walkBodyFrames[f] = solved[f]
      }
    }

    // Pattes : idem par zone
    for (const leg of skeleton.legs) {
      const csys = zoneContourArap[leg.zoneId]
      const len = tri.zoneContourLength?.[leg.zoneId] ?? 0
      if (!csys || len === 0) continue
      onProgress?.({ phase: `Contour ARAP ${leg.zoneId}`, frame: 0, total: totalFrames })
      const newContourFrames: Point2D[][] = new Array(totalFrames)
      for (let f = 0; f < totalFrames; f++) {
        const lbsContour = walkZoneFrames[leg.zoneId][f].slice(0, len)
        newContourFrames[f] = solveContourArapFrame(csys, lbsContour, cIters)
        for (let i = 0; i < len; i++) walkZoneFrames[leg.zoneId][f][i] = newContourFrames[f][i]
      }
      const bsys = zoneArap[leg.zoneId]
      if (bsys) {
        onProgress?.({ phase: `ARAP ${leg.zoneId}`, frame: 0, total: totalFrames })
        const solved = batchSolveARAP(bsys, newContourFrames, bIters)
        for (let f = 0; f < totalFrames; f++) walkZoneFrames[leg.zoneId][f] = solved[f]
      }
    }
  }

  // ── Post-pass préservation d'aire lissée (toutes modes) ──
  const areaStrength = params.areaPostStrength ?? 0
  const areaIters = params.areaPostIterations ?? 3
  if (areaStrength > 0 && areaIters > 0) {
    onProgress?.({ phase: 'Area post-pass', frame: 0, total: totalFrames })
    const bodyAdj = buildVertexAdjacency(tri.bodyPoints.length, tri.bodyTriangles)
    const zoneAdj: Record<string, number[][]> = {}
    for (const leg of skeleton.legs) {
      const zonePts = tri.zonePoints[leg.zoneId]
      const zoneTris = tri.zoneTriangles[leg.zoneId]
      if (zonePts && zoneTris) zoneAdj[leg.zoneId] = buildVertexAdjacency(zonePts.length, zoneTris)
    }
    for (let f = 0; f < totalFrames; f++) {
      applyAreaPreservationPass(walkBodyFrames[f], tri.bodyPoints, tri.bodyTriangles, bodyAdj, areaStrength, areaIters)
      for (const leg of skeleton.legs) {
        const fr = walkZoneFrames[leg.zoneId][f]
        const zonePts = tri.zonePoints[leg.zoneId]
        const zoneTris = tri.zoneTriangles[leg.zoneId]
        const adj = zoneAdj[leg.zoneId]
        if (fr && zonePts && zoneTris && adj) {
          applyAreaPreservationPass(fr, zonePts, zoneTris, adj, areaStrength, areaIters)
        }
      }
    }
  }

  // ── Jaw bone openness (rotation de la zone bouche Bézier) ─────────
  let cotrackerJawOpennessFrames: number[] | null = null
  const jaw = skeleton.jaw
  const mouth = project.projectMouth
  if (jaw && mouth && !override && ctFrames) {
    const hingeRef = mouth.hingeBodyAnchor ?? mouth.hingeAnchor
    const attachZoneId = mouth.attachZoneId ?? 'body'
    // Mesh déformé par frame (coords image) pour la zone d'attache de la bouche.
    const attachDeformedFrames: Point2D[][] =
      attachZoneId === 'body' ? walkBodyFrames : (walkZoneFrames[attachZoneId] ?? [])
    const attachTriangles: [number, number, number][] =
      attachZoneId === 'body'
        ? tri.bodyTriangles
        : (tri.zoneTriangles[attachZoneId] ?? [])
    if (hingeRef && attachDeformedFrames.length > 0 && attachTriangles.length > 0) {
      // Dimensions image : utilise originalImageBlob si disponible (cohérent avec
      // MouthSection / MouthPixiPreview), sinon maskWidth.
      let jawImgW = imgW
      let jawImgH = imgH
      if (project.originalImageBlob) {
        try {
          const bmp = await createImageBitmap(project.originalImageBlob)
          jawImgW = bmp.width
          jawImgH = bmp.height
          bmp.close?.()
        } catch { /* fallback to maskWidth */ }
      }
      cotrackerJawOpennessFrames = computeJawOpennessFrames({
        jaw,
        cotrackerFrames: ctFrames,
        videoSize: { width: vidW, height: vidH },
        imageSize: { width: jawImgW, height: jawImgH },
        attachDeformedFrames,
        attachTriangles,
        hingeAnchor: hingeRef,
        scalingMaxDeg: mouth.maxOpenAngleDeg,
        capMaxDeg: jaw.maxOpenAngleDegOverride ?? undefined,
        rotationSign: mouth.rotationSign,
      })
    }
  }

  return { walkBodyFrames, walkZoneFrames, cotrackerBodyJointFrames, cotrackerLegBoneFrames, cotrackerJawOpennessFrames }
}
