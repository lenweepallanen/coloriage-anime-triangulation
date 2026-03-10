import type { Point2D, KeyframeData } from '../types/project'

/**
 * Linearly interpolate between two points.
 */
function lerp(a: Point2D, b: Point2D, t: number): Point2D {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }
}

/**
 * Propagate anchor positions across all frames using linear interpolation
 * between keyframes.
 *
 * Keyframes must be sorted by frameIndex and include frame 0 and the last frame.
 * Returns Point2D[][] indexed by frame, each containing all anchor positions.
 */
export function propagateKeyframes(
  keyframes: KeyframeData[],
  totalFrames: number
): Point2D[][] {
  if (keyframes.length === 0 || totalFrames === 0) return []

  const sorted = [...keyframes].sort((a, b) => a.frameIndex - b.frameIndex)
  const numAnchors = sorted[0].anchorPositions.length
  const result: Point2D[][] = new Array(totalFrames)

  // For each pair of consecutive keyframes, interpolate
  for (let k = 0; k < sorted.length - 1; k++) {
    const kf1 = sorted[k]
    const kf2 = sorted[k + 1]
    const span = kf2.frameIndex - kf1.frameIndex

    for (let f = kf1.frameIndex; f <= kf2.frameIndex; f++) {
      const t = span === 0 ? 0 : (f - kf1.frameIndex) / span
      const positions: Point2D[] = new Array(numAnchors)
      for (let i = 0; i < numAnchors; i++) {
        positions[i] = lerp(kf1.anchorPositions[i], kf2.anchorPositions[i], t)
      }
      result[f] = positions
    }
  }

  // Fill frames before first keyframe (hold first keyframe position)
  const firstKf = sorted[0]
  for (let f = 0; f < firstKf.frameIndex; f++) {
    result[f] = [...firstKf.anchorPositions]
  }

  // Fill frames after last keyframe (hold last keyframe position)
  const lastKf = sorted[sorted.length - 1]
  for (let f = lastKf.frameIndex + 1; f < totalFrames; f++) {
    result[f] = [...lastKf.anchorPositions]
  }

  return result
}

/**
 * Extract keyframes from full per-frame anchor tracking at regular intervals.
 * Always includes first and last frame.
 */
export function extractKeyframes(
  allFrameAnchors: Point2D[][],
  interval: number
): KeyframeData[] {
  if (allFrameAnchors.length === 0) return []

  const keyframes: KeyframeData[] = []
  const lastFrame = allFrameAnchors.length - 1

  for (let f = 0; f <= lastFrame; f += interval) {
    keyframes.push({
      frameIndex: f,
      anchorPositions: allFrameAnchors[f],
    })
  }

  // Always include last frame
  if (keyframes[keyframes.length - 1].frameIndex !== lastFrame) {
    keyframes.push({
      frameIndex: lastFrame,
      anchorPositions: allFrameAnchors[lastFrame],
    })
  }

  return keyframes
}
