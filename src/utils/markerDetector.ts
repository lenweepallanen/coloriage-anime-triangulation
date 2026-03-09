import type { Point2D } from '../types/project'

interface DetectedMarkers {
  topLeft: Point2D
  topRight: Point2D
  bottomLeft: Point2D
  bottomRight: Point2D
}

/**
 * Detect L-shaped markers in a video frame using OpenCV.
 * Returns 4 corner positions or null if not all markers are found.
 */
export function detectMarkers(cv: any, frame: any): DetectedMarkers | null {
  const gray = new cv.Mat()
  const binary = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    // Convert to grayscale
    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY)

    // Adaptive threshold to isolate dark markers
    cv.adaptiveThreshold(
      gray, binary, 255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      11, 2
    )

    // Find contours
    cv.findContours(
      binary, contours, hierarchy,
      cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE
    )

    const candidates: { center: Point2D; area: number; contour: any }[] = []
    const frameArea = frame.rows * frame.cols
    const minArea = frameArea * 0.0005 // Min 0.05% of frame
    const maxArea = frameArea * 0.02   // Max 2% of frame

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)

      if (area < minArea || area > maxArea) continue

      // Approximate polygon
      const approx = new cv.Mat()
      const epsilon = 0.04 * cv.arcLength(contour, true)
      cv.approxPolyDP(contour, approx, epsilon, true)

      // L-shapes approximate to 6 vertices
      if (approx.rows >= 5 && approx.rows <= 8) {
        const moments = cv.moments(contour)
        if (moments.m00 > 0) {
          candidates.push({
            center: {
              x: moments.m10 / moments.m00,
              y: moments.m01 / moments.m00,
            },
            area,
            contour,
          })
        }
      }

      approx.delete()
    }

    // Need at least 4 candidates
    if (candidates.length < 4) return null

    // Sort by area and take top candidates (most consistent sizes)
    candidates.sort((a, b) => b.area - a.area)
    const topCandidates = candidates.slice(0, Math.min(8, candidates.length))

    // Classify into corners based on position in frame
    const frameCenterX = frame.cols / 2
    const frameCenterY = frame.rows / 2

    let tl: Point2D | null = null
    let tr: Point2D | null = null
    let bl: Point2D | null = null
    let br: Point2D | null = null

    // Find the candidate closest to each corner
    for (const cand of topCandidates) {
      const { x, y } = cand.center
      if (x < frameCenterX && y < frameCenterY) {
        if (!tl || (x + y < tl.x + tl.y)) tl = cand.center
      } else if (x >= frameCenterX && y < frameCenterY) {
        if (!tr || (x - y > (tr.x - tr.y))) tr = cand.center
      } else if (x < frameCenterX && y >= frameCenterY) {
        if (!bl || (y - x > (bl.y - bl.x))) bl = cand.center
      } else {
        if (!br || (x + y > br.x + br.y)) br = cand.center
      }
    }

    if (!tl || !tr || !bl || !br) return null

    return { topLeft: tl, topRight: tr, bottomLeft: bl, bottomRight: br }
  } finally {
    gray.delete()
    binary.delete()
    contours.delete()
    hierarchy.delete()
  }
}

/**
 * Check if markers are stable across frames (low movement).
 */
export function areMarkersStable(
  prev: DetectedMarkers,
  curr: DetectedMarkers,
  threshold: number = 5
): boolean {
  const corners: (keyof DetectedMarkers)[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']
  return corners.every(corner => {
    const dx = prev[corner].x - curr[corner].x
    const dy = prev[corner].y - curr[corner].y
    return Math.sqrt(dx * dx + dy * dy) < threshold
  })
}
