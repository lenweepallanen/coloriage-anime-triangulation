/**
 * Coordonnées curvilignes sur contour Canny.
 *
 * Place des points intermédiaires entre les anchor points caractéristiques
 * en utilisant le contour Canny détecté à chaque frame.
 */

import type { Point2D, CurvilinearParam, CannyParams } from '../types/project'
import { ContourSpatialIndex } from './contourSpatialIndex'
import { flowCannyContour } from './perspectiveCorrection'

// ─── Contour path extraction ───────────────────────────────────────

/**
 * Ordonne les pixels du contour Canny en un chemin continu (chaîne).
 * Utilise un parcours glouton : à chaque étape, on prend le voisin le plus proche
 * non encore visité. Retourne le chemin le plus long trouvé.
 */
export function orderContourPixels(pixels: Point2D[]): Point2D[] {
  if (pixels.length <= 2) return [...pixels]

  const key = (p: Point2D) => `${Math.round(p.x)},${Math.round(p.y)}`

  // Start from first pixel
  let bestPath: Point2D[] = []

  // Try a few starting points to find the best chain
  const starts = [0, Math.floor(pixels.length / 4), Math.floor(pixels.length / 2)]

  for (const startIdx of starts) {
    const path: Point2D[] = []
    const vis = new Set<string>()
    let current = pixels[startIdx]
    vis.add(key(current))
    path.push(current)

    while (true) {
      // Search for nearest unvisited neighbor within 3px
      let bestNeighbor: Point2D | null = null
      let bestDist = Infinity

      // Search in expanding radius for nearest unvisited neighbor
      for (let radius = 1.5; radius <= 4; radius += 0.5) {
        const candidates = findNearbyPixels(pixels, current, radius, vis, key)
        for (const c of candidates) {
          const d = Math.hypot(c.x - current.x, c.y - current.y)
          if (d < bestDist) {
            bestDist = d
            bestNeighbor = c
          }
        }
        if (bestNeighbor) break
      }

      if (!bestNeighbor) break
      vis.add(key(bestNeighbor))
      path.push(bestNeighbor)
      current = bestNeighbor
    }

    if (path.length > bestPath.length) {
      bestPath = path
    }
  }

  return bestPath
}

function findNearbyPixels(
  pixels: Point2D[],
  center: Point2D,
  radius: number,
  visited: Set<string>,
  keyFn: (p: Point2D) => string
): Point2D[] {
  const result: Point2D[] = []
  const r2 = radius * radius
  for (const p of pixels) {
    if (visited.has(keyFn(p))) continue
    const dx = p.x - center.x
    const dy = p.y - center.y
    if (dx * dx + dy * dy <= r2) {
      result.push(p)
    }
  }
  return result
}

// ─── Contour arc-length parameterization ───────────────────────────

/**
 * Calcule les distances cumulées le long d'un chemin (arc-length).
 */
export function computeArcLengths(path: Point2D[]): number[] {
  const lengths = [0]
  for (let i = 1; i < path.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(
      path[i].x - path[i - 1].x,
      path[i].y - path[i - 1].y
    ))
  }
  return lengths
}

/**
 * Interpole un point à la position curviligne t ∈ [0,1] le long d'un chemin.
 */
export function interpolateAtArcLength(
  path: Point2D[],
  arcLengths: number[],
  t: number
): Point2D {
  if (path.length === 0) return { x: 0, y: 0 }
  if (path.length === 1 || t <= 0) return { ...path[0] }
  if (t >= 1) return { ...path[path.length - 1] }

  const totalLength = arcLengths[arcLengths.length - 1]
  const targetLength = t * totalLength

  // Binary search for the segment containing targetLength
  let lo = 0, hi = arcLengths.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (arcLengths[mid] <= targetLength) lo = mid
    else hi = mid
  }

  const segLength = arcLengths[hi] - arcLengths[lo]
  if (segLength < 1e-10) return { ...path[lo] }

  const segT = (targetLength - arcLengths[lo]) / segLength
  return {
    x: path[lo].x + segT * (path[hi].x - path[lo].x),
    y: path[lo].y + segT * (path[hi].y - path[lo].y),
  }
}

// ─── Snap anchor to contour ────────────────────────────────────────

/**
 * Snap un point sur le contour Canny le plus proche.
 */
export function snapToContour(
  point: Point2D,
  contourIndex: ContourSpatialIndex,
  maxDist = 30
): Point2D {
  const nearest = contourIndex.nearest(point, maxDist)
  return nearest ? nearest.point : point
}

// ─── Find path between anchors on contour ──────────────────────────

/**
 * Trouve l'index du point le plus proche dans un chemin ordonné.
 */
function findClosestOnPath(path: Point2D[], target: Point2D): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < path.length; i++) {
    const d = Math.hypot(path[i].x - target.x, path[i].y - target.y)
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

/**
 * Extrait le sous-chemin du contour entre deux anchors.
 * Le contour est cyclique : on choisit le chemin le plus court.
 */
export function extractPathBetweenAnchors(
  orderedContour: Point2D[],
  anchorA: Point2D,
  anchorB: Point2D
): Point2D[] {
  const n = orderedContour.length
  if (n === 0) return []

  const idxA = findClosestOnPath(orderedContour, anchorA)
  const idxB = findClosestOnPath(orderedContour, anchorB)

  // Forward path: A → B
  const forward: Point2D[] = []
  let i = idxA
  while (true) {
    forward.push(orderedContour[i])
    if (i === idxB) break
    i = (i + 1) % n
    if (forward.length > n) break // safety
  }

  // Backward path: A → ... → B (the other way around)
  const backward: Point2D[] = []
  i = idxA
  while (true) {
    backward.push(orderedContour[i])
    if (i === idxB) break
    i = (i - 1 + n) % n
    if (backward.length > n) break
  }

  // Pick shorter path
  return forward.length <= backward.length ? forward : backward
}

// ─── Subdivision: place points uniformly between anchors ───────────

/**
 * Génère N points uniformément répartis entre deux anchors le long du contour Canny.
 * Retourne les points ET leurs paramètres curvilignes.
 */
export function subdivideSegment(
  path: Point2D[],
  count: number,
  segmentIndex: number
): { points: Point2D[]; params: CurvilinearParam[] } {
  if (count <= 0 || path.length < 2) return { points: [], params: [] }

  const arcLengths = computeArcLengths(path)
  const points: Point2D[] = []
  const params: CurvilinearParam[] = []

  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1)
    points.push(interpolateAtArcLength(path, arcLengths, t))
    params.push({ segmentIndex, t })
  }

  return { points, params }
}

/**
 * Génère tous les points de subdivision entre tous les anchors du contour.
 * `pointsPerSegment` = nombre de points entre chaque paire d'anchors consécutifs.
 */
export function subdivideContour(
  orderedContour: Point2D[],
  anchors: Point2D[],
  pointsPerSegment: number | number[]
): { points: Point2D[]; params: CurvilinearParam[] } {
  const allPoints: Point2D[] = []
  const allParams: CurvilinearParam[] = []
  const n = anchors.length

  for (let i = 0; i < n; i++) {
    const count = Array.isArray(pointsPerSegment) ? (pointsPerSegment[i] ?? 0) : pointsPerSegment
    const j = (i + 1) % n
    const path = extractPathBetweenAnchors(orderedContour, anchors[i], anchors[j])
    const { points, params } = subdivideSegment(path, count, i)
    allPoints.push(...points)
    allParams.push(...params)
  }

  return { points: allPoints, params: allParams }
}

// ─── Per-frame computation ─────────────────────────────────────────

/**
 * Calcule les positions des points de subdivision pour une frame donnée.
 *
 * 1. Prend le contour Canny de la frame (orderedContour)
 * 2. Prend les positions des anchors trackés sur cette frame
 * 3. Pour chaque segment [anchor_i, anchor_{i+1}], extrait le chemin Canny
 * 4. Place chaque point à sa coordonnée curviligne t sur ce chemin
 */
export function computeSubdivisionForFrame(
  orderedContour: Point2D[],
  anchorPositions: Point2D[],
  params: CurvilinearParam[]
): Point2D[] {
  if (orderedContour.length === 0 || anchorPositions.length === 0) {
    return params.map(() => ({ x: 0, y: 0 }))
  }

  const n = anchorPositions.length

  // Pre-extract paths for each segment
  const segmentPaths: Point2D[][] = []
  const segmentArcLengths: number[][] = []

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const path = extractPathBetweenAnchors(orderedContour, anchorPositions[i], anchorPositions[j])
    segmentPaths.push(path)
    segmentArcLengths.push(computeArcLengths(path))
  }

  // Place each subdivision point
  return params.map(param => {
    const path = segmentPaths[param.segmentIndex]
    const arcLengths = segmentArcLengths[param.segmentIndex]
    if (!path || path.length < 2) {
      // Fallback: linear interpolation between anchors
      const a = anchorPositions[param.segmentIndex]
      const b = anchorPositions[(param.segmentIndex + 1) % n]
      return {
        x: a.x + param.t * (b.x - a.x),
        y: a.y + param.t * (b.y - a.y),
      }
    }
    return interpolateAtArcLength(path, arcLengths, param.t)
  })
}

// ─── Full video computation ────────────────────────────────────────

export interface ContourComputationProgress {
  frame: number
  total: number
}

/**
 * Calcule les positions de tous les points de subdivision pour toutes les frames.
 *
 * Pour chaque frame :
 * 1. Extraire le frame de la vidéo
 * 2. Détecter le contour Canny
 * 3. Ordonner les pixels du contour
 * 4. Placer les points de subdivision via coordonnées curvilignes
 */
export async function computeAllSubdivisionFrames(
  videoBlob: Blob,
  anchorFrames: Point2D[][],
  params: CurvilinearParam[],
  cannyParams: CannyParams,
  onProgress?: (p: ContourComputationProgress) => void
): Promise<Point2D[][]> {
  const fps = 24
  const totalFrames = anchorFrames.length

  // Create video element
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  const url = URL.createObjectURL(videoBlob)
  video.src = url

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video'))
  })

  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')!

  const allFrames: Point2D[][] = []

  for (let f = 0; f < totalFrames; f++) {
    // Seek to frame
    video.currentTime = f / fps
    await new Promise<void>(resolve => {
      video.onseeked = () => resolve()
    })

    // Draw frame
    ctx.drawImage(video, 0, 0)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

    // Detect Canny contour
    const contourPixels = await flowCannyContour(
      imageData,
      cannyParams.lowThreshold,
      cannyParams.highThreshold,
      cannyParams.blurSize
    )

    if (contourPixels && contourPixels.length > 0) {
      // Order the contour pixels into a chain
      const orderedContour = orderContourPixels(contourPixels)

      // Compute subdivision positions
      const positions = computeSubdivisionForFrame(
        orderedContour,
        anchorFrames[f],
        params
      )
      allFrames.push(positions)
    } else {
      // Fallback: linear interpolation between anchors
      const anchors = anchorFrames[f]
      const n = anchors.length
      const positions = params.map(param => {
        const a = anchors[param.segmentIndex]
        const b = anchors[(param.segmentIndex + 1) % n]
        return {
          x: a.x + param.t * (b.x - a.x),
          y: a.y + param.t * (b.y - a.y),
        }
      })
      allFrames.push(positions)
    }

    onProgress?.({ frame: f + 1, total: totalFrames })

    // Yield to UI every 5 frames
    if (f % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  URL.revokeObjectURL(url)
  return allFrames
}
