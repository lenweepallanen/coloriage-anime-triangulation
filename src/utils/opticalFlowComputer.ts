import type { Point2D } from '../types/project'

/**
 * Extract all frames from a video blob as ImageData.
 */
async function extractVideoFrames(
  videoBlob: Blob,
  onProgress?: (current: number, total: number) => void
): Promise<{ frames: ImageData[]; fps: number; width: number; height: number }> {
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
  const fps = 24 // Assume 24fps; could detect from video
  const totalFrames = Math.floor(duration * fps)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  const frames: ImageData[] = []

  for (let i = 0; i < totalFrames; i++) {
    const time = i / fps
    video.currentTime = time

    await new Promise<void>(resolve => {
      video.onseeked = () => resolve()
    })

    ctx.drawImage(video, 0, 0, width, height)
    frames.push(ctx.getImageData(0, 0, width, height))

    onProgress?.(i + 1, totalFrames)
  }

  URL.revokeObjectURL(url)
  return { frames, fps, width, height }
}

/**
 * Convert mesh points from image coordinates to video-normalized coordinates.
 * The mesh is defined on the original image, but we track on the video.
 * We assume the mesh coordinates map to the full video frame.
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
 * Uses Lucas-Kanade sparse optical flow via opencv.js.
 */
export async function precomputeOpticalFlow(
  cv: any,
  videoBlob: Blob,
  meshPoints: Point2D[],
  imageWidth: number,
  imageHeight: number,
  onProgress?: (stage: string, current: number, total: number) => void
): Promise<{ videoFramesMesh: Point2D[][]; fps: number }> {
  // Step 1: Extract frames
  onProgress?.('Extraction des frames', 0, 1)
  const { frames, fps, width: videoW, height: videoH } = await extractVideoFrames(
    videoBlob,
    (current, total) => onProgress?.('Extraction des frames', current, total)
  )

  if (frames.length < 2) {
    throw new Error('Video too short (need at least 2 frames)')
  }

  // Normalize mesh points to video coordinates
  const initialPoints = normalizePoints(meshPoints, imageWidth, imageHeight, videoW, videoH)

  const videoFramesMesh: Point2D[][] = [initialPoints]

  // Step 2: Track points frame by frame
  let prevGray = new cv.Mat()
  const firstFrame = cv.matFromImageData(frames[0])
  cv.cvtColor(firstFrame, prevGray, cv.COLOR_RGBA2GRAY)
  firstFrame.delete()

  let prevPts = cv.matFromArray(
    initialPoints.length, 1, cv.CV_32FC2,
    initialPoints.flatMap(p => [p.x, p.y])
  )

  const winSize = new cv.Size(21, 21)
  const maxLevel = 3
  const criteria = new cv.TermCriteria(
    cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT,
    30,
    0.01
  )

  for (let i = 1; i < frames.length; i++) {
    onProgress?.('Tracking optique', i, frames.length)

    const currFrame = cv.matFromImageData(frames[i])
    const currGray = new cv.Mat()
    cv.cvtColor(currFrame, currGray, cv.COLOR_RGBA2GRAY)
    currFrame.delete()

    const nextPts = new cv.Mat()
    const status = new cv.Mat()
    const err = new cv.Mat()

    cv.calcOpticalFlowPyrLK(
      prevGray, currGray,
      prevPts, nextPts,
      status, err,
      winSize, maxLevel, criteria
    )

    // Extract tracked points, handle lost points
    const points: Point2D[] = []
    const prevData = prevPts.data32F
    const nextData = nextPts.data32F
    const statusData = status.data

    for (let j = 0; j < initialPoints.length; j++) {
      if (statusData[j] === 1) {
        points.push({ x: nextData[j * 2], y: nextData[j * 2 + 1] })
      } else {
        // Point lost — keep previous position
        points.push({ x: prevData[j * 2], y: prevData[j * 2 + 1] })
      }
    }

    videoFramesMesh.push(points)

    // Update for next iteration
    prevGray.delete()
    prevGray = currGray
    prevPts.delete()
    prevPts = cv.matFromArray(
      points.length, 1, cv.CV_32FC2,
      points.flatMap(p => [p.x, p.y])
    )

    status.delete()
    err.delete()
    nextPts.delete()
  }

  prevGray.delete()
  prevPts.delete()

  // Normalize back to image coordinates for storage
  const normalizedFrames = videoFramesMesh.map(framePoints =>
    framePoints.map(p => ({
      x: (p.x / videoW) * imageWidth,
      y: (p.y / videoH) * imageHeight,
    }))
  )

  return { videoFramesMesh: normalizedFrames, fps }
}
