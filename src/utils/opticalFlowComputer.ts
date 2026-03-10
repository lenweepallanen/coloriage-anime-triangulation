import type { Point2D } from '../types/project'
import { flowInit, flowProcessFrame, flowCleanup } from './perspectiveCorrection'

/**
 * Track a segment of frames starting from given initial positions.
 * Supports forward (startFrame < endFrame) and backward (startFrame > endFrame) tracking.
 * Returns positions for each frame in the segment (excluding startFrame, including endFrame).
 */
export async function trackSegment(
  videoBlob: Blob,
  initialPoints: Point2D[],
  imageWidth: number,
  imageHeight: number,
  startFrame: number,
  endFrame: number,
  onProgress?: (current: number, total: number) => void
): Promise<{ frameIndex: number; points: Point2D[] }[]> {
  const { video, url, ctx, width: videoW, height: videoH, fps } =
    await prepareVideo(videoBlob)

  const forward = endFrame > startFrame
  const step = forward ? 1 : -1
  const numFrames = Math.abs(endFrame - startFrame)

  // Initialize with the corrected positions (convert to video coords)
  const initVideoPoints = normalizePoints(initialPoints, imageWidth, imageHeight, videoW, videoH)

  // First, seek to startFrame and init the tracker
  const startFrameData = await extractFrame(video, ctx, startFrame / fps, videoW, videoH)
  await flowInit(initVideoPoints)
  await flowProcessFrame(startFrameData) // Process startFrame to set the reference

  const results: { frameIndex: number; points: Point2D[] }[] = []

  for (let i = 1; i <= numFrames; i++) {
    onProgress?.(i, numFrames)
    const frameIdx = startFrame + i * step
    const frameData = await extractFrame(video, ctx, frameIdx / fps, videoW, videoH)
    const points = await flowProcessFrame(frameData)

    // Convert back to image coords
    results.push({
      frameIndex: frameIdx,
      points: points.map(p => ({
        x: (p.x / videoW) * imageWidth,
        y: (p.y / videoH) * imageHeight,
      })),
    })
  }

  await flowCleanup()
  URL.revokeObjectURL(url)

  return results
}

/**
 * Prepare a video element and canvas for frame-by-frame extraction.
 */
async function prepareVideo(videoBlob: Blob) {
  const url = URL.createObjectURL(videoBlob)
  const video = document.createElement('video')
  video.muted = true
  video.src = url

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve()
    video.onerror = () => reject(new Error('Failed to load video'))
  })

  const width = video.videoWidth
  const height = video.videoHeight
  const duration = video.duration
  const fps = 24
  const totalFrames = Math.floor(duration * fps)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  return { video, url, canvas, ctx, width, height, fps, totalFrames }
}

/**
 * Seek to a specific time and return the frame as ImageData.
 */
async function extractFrame(
  video: HTMLVideoElement,
  ctx: CanvasRenderingContext2D,
  time: number,
  width: number,
  height: number
): Promise<ImageData> {
  video.currentTime = time
  await new Promise<void>(resolve => {
    video.onseeked = () => resolve()
  })
  ctx.drawImage(video, 0, 0, width, height)
  return ctx.getImageData(0, 0, width, height)
}

/**
 * Convert mesh points from image coordinates to video coordinates.
 */
function normalizePoints(
  points: Point2D[],
  imageWidth: number,
  imageHeight: number,
  videoWidth: number,
  videoHeight: number
): Point2D[] {
  return points.map(p => ({
    x: (p.x / imageWidth) * videoWidth,
    y: (p.y / imageHeight) * videoHeight,
  }))
}

/**
 * Pre-compute optical flow tracking for all mesh points across all video frames.
 * Uses Lucas-Kanade sparse optical flow via the OpenCV Web Worker.
 * Frames are extracted on the main thread (DOM) and sent to the worker for tracking.
 */
export async function precomputeOpticalFlow(
  _cv: any,
  videoBlob: Blob,
  meshPoints: Point2D[],
  imageWidth: number,
  imageHeight: number,
  onProgress?: (stage: string, current: number, total: number) => void
): Promise<{ videoFramesMesh: Point2D[][]; fps: number }> {
  onProgress?.('Préparation', 0, 1)
  const { video, url, ctx, width: videoW, height: videoH, fps, totalFrames } =
    await prepareVideo(videoBlob)

  if (totalFrames < 2) {
    URL.revokeObjectURL(url)
    throw new Error('Video too short (need at least 2 frames)')
  }

  const initialPoints = normalizePoints(meshPoints, imageWidth, imageHeight, videoW, videoH)

  // Initialize optical flow in the worker
  onProgress?.('Initialisation tracking', 0, 1)
  await flowInit(initialPoints)

  const videoFramesMesh: Point2D[][] = []

  for (let i = 0; i < totalFrames; i++) {
    onProgress?.('Extraction & tracking', i + 1, totalFrames)

    const frameData = await extractFrame(video, ctx, i / fps, videoW, videoH)
    const points = await flowProcessFrame(frameData)
    videoFramesMesh.push(points)
  }

  await flowCleanup()
  URL.revokeObjectURL(url)

  // Normalize back to image coordinates for storage
  const normalizedFrames = videoFramesMesh.map(framePoints =>
    framePoints.map(p => ({
      x: (p.x / videoW) * imageWidth,
      y: (p.y / videoH) * imageHeight,
    }))
  )

  return { videoFramesMesh: normalizedFrames, fps }
}
