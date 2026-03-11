/**
 * Contour anchor tracking refinement.
 * Hybrid LK + template matching + snap-to-contour for anchor points on the contour.
 * Pure TypeScript logic (no Worker), operates on Point2D arrays.
 */

import type { Point2D } from '../types/project'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContourTrackingConfig {
  contourAnchorIndices: number[]  // which indices in the anchor array are contour anchors
  snapRadius: number              // px, max distance for snap-to-contour (default 8)
  snapLostFactor: number          // multiplier: distance > snapRadius * factor → lost (default 3)
  templateWeight: number          // blend weight for template match position (default 0.3)
  snapWeight: number              // blend weight for snap-to-contour position (default 0.5)
  minConfidence: number           // below this → point marked doubtful (default 0.3)
  maxLostFrames: number           // freeze after this many consecutive lost frames (default 5)
}

export const DEFAULT_CONTOUR_TRACKING_CONFIG: Omit<ContourTrackingConfig, 'contourAnchorIndices'> = {
  snapRadius: 8,
  snapLostFactor: 3,
  templateWeight: 0.3,
  snapWeight: 0.5,
  minConfidence: 0.3,
  maxLostFrames: 5,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ContourTrackingState {
  confidences: number[]        // per contour-anchor confidence [0, 1]
  lostFrameCount: number[]     // consecutive frames each point has been lost
  lastGoodPositions: Point2D[] // last position where confidence was high
}

// ---------------------------------------------------------------------------
// Contour match input (from worker template matching)
// ---------------------------------------------------------------------------

export interface ContourMatchInput {
  tmPos: Point2D
  tmScore: number
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initContourTracking(
  config: ContourTrackingConfig,
  initialPositions: Point2D[]
): ContourTrackingState {
  const n = config.contourAnchorIndices.length
  const lastGood: Point2D[] = []

  for (let i = 0; i < n; i++) {
    const idx = config.contourAnchorIndices[i]
    lastGood.push({ ...initialPositions[idx] })
  }

  return {
    confidences: new Array(n).fill(1.0),
    lostFrameCount: new Array(n).fill(0),
    lastGoodPositions: lastGood,
  }
}

// ---------------------------------------------------------------------------
// Snap-to-contour: find nearest point on dense contour polyline
// ---------------------------------------------------------------------------

function findNearestOnContour(
  point: Point2D,
  contourPolyline: Point2D[]
): { nearest: Point2D; distance: number } {
  let bestDistSq = Infinity
  let bestPoint = point

  for (let i = 0; i < contourPolyline.length; i++) {
    const cp = contourPolyline[i]
    const dx = point.x - cp.x
    const dy = point.y - cp.y
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestPoint = cp
    }
  }

  return { nearest: { ...bestPoint }, distance: Math.sqrt(bestDistSq) }
}

// ---------------------------------------------------------------------------
// Refine contour anchors (called per frame after LK)
// ---------------------------------------------------------------------------

export function refineContourAnchors(
  allPositions: Point2D[],
  contourMatches: ContourMatchInput[] | null,
  contourPolyline: Point2D[] | null,
  state: ContourTrackingState,
  config: ContourTrackingConfig
): { refined: Point2D[]; state: ContourTrackingState } {
  const refined = allPositions.map(p => ({ ...p }))
  const newState: ContourTrackingState = {
    confidences: [...state.confidences],
    lostFrameCount: [...state.lostFrameCount],
    lastGoodPositions: state.lastGoodPositions.map(p => ({ ...p })),
  }

  const { contourAnchorIndices, snapRadius, snapLostFactor, templateWeight, snapWeight, minConfidence, maxLostFrames } = config
  const maxSnapDist = snapRadius * snapLostFactor

  for (let i = 0; i < contourAnchorIndices.length; i++) {
    const idx = contourAnchorIndices[i]
    const pLK = allPositions[idx]

    // --- Template match contribution ---
    let pTM: Point2D | null = null
    let tmScore = 0
    if (contourMatches && i < contourMatches.length) {
      tmScore = contourMatches[i].tmScore
      if (tmScore > 0.5) {
        pTM = contourMatches[i].tmPos
      }
    }

    // --- Snap-to-contour contribution ---
    let pSnap: Point2D | null = null
    let snapDist = Infinity
    if (contourPolyline && contourPolyline.length > 0) {
      // Snap to nearest contour point from the fused LK+TM position
      const fusedForSnap = pTM
        ? { x: pLK.x * (1 - templateWeight) + pTM.x * templateWeight, y: pLK.y * (1 - templateWeight) + pTM.y * templateWeight }
        : pLK
      const snapResult = findNearestOnContour(fusedForSnap, contourPolyline)
      snapDist = snapResult.distance
      if (snapDist < maxSnapDist) {
        pSnap = snapResult.nearest
      }
    }

    // --- Fusion ---
    let finalX = pLK.x
    let finalY = pLK.y

    if (pTM && pSnap) {
      // All three sources available — normalize weights
      const wTM = templateWeight
      const wSnap = snapWeight
      const wLK = Math.max(0, 1 - wTM - wSnap)
      finalX = wLK * pLK.x + wTM * pTM.x + wSnap * pSnap.x
      finalY = wLK * pLK.y + wTM * pTM.y + wSnap * pSnap.y
    } else if (pTM) {
      // Template match only (no contour found or too far)
      finalX = pLK.x * (1 - templateWeight) + pTM.x * templateWeight
      finalY = pLK.y * (1 - templateWeight) + pTM.y * templateWeight
    } else if (pSnap) {
      // Snap only (no good template match)
      finalX = pLK.x * (1 - snapWeight) + pSnap.x * snapWeight
      finalY = pLK.y * (1 - snapWeight) + pSnap.y * snapWeight
    }
    // else: LK only (no template, no contour)

    // --- Confidence ---
    let confidence: number
    if (tmScore > 0.7 && snapDist < snapRadius) {
      confidence = 1.0
    } else if (tmScore > 0.5 || snapDist < snapRadius * 2) {
      confidence = 0.7
    } else {
      // Decay from previous confidence
      confidence = state.confidences[i] * 0.85
    }

    // --- Loss detection & recovery ---
    const wasLost = state.lostFrameCount[i] > 0

    if (confidence < minConfidence) {
      // Point is lost
      newState.lostFrameCount[i] = state.lostFrameCount[i] + 1

      if (newState.lostFrameCount[i] > maxLostFrames) {
        // Freeze at last good position
        finalX = state.lastGoodPositions[i].x
        finalY = state.lastGoodPositions[i].y
      } else if (pSnap && snapDist < snapRadius) {
        // Recovery: snap to contour even though confidence is low
        finalX = pSnap.x
        finalY = pSnap.y
        confidence = 0.5
        newState.lostFrameCount[i] = 0
      }
    } else {
      // Point is tracked
      newState.lostFrameCount[i] = 0
      newState.lastGoodPositions[i] = { x: finalX, y: finalY }
    }

    // Recovery from lost state via good snap
    if (wasLost && pSnap && snapDist < snapRadius) {
      finalX = pSnap.x
      finalY = pSnap.y
      confidence = 0.5
      newState.lostFrameCount[i] = 0
      newState.lastGoodPositions[i] = { x: finalX, y: finalY }
    }

    newState.confidences[i] = confidence
    refined[idx] = { x: finalX, y: finalY }
  }

  return { refined, state: newState }
}
