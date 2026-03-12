import type { Point2D, CannyParams } from '../types/project'
import { flowInit, flowProcessFrame, flowCleanup, flowUpdatePoints, flowInitTemplates, flowExtractContourDense } from './perspectiveCorrection'
import type { FlowFrameOptions } from './perspectiveCorrection'
import {
  buildAnchorAdjacency,
  applyNeighborConstraints,
  applyAntiSaut,
  stabilizeContourAnchors,
  computeInitialContourSpacings,
  applyMinSeparation,
  applyTemporalSmoothing,
  detectAndCorrectOutliers,
  applySnapToContour,
  recoverLostPoints,
  applyCurvilinearSpringOnCanny,
  computeInitialCannySpacings,
  median,
} from './trackingConstraints'
import type { CurvilinearSpringOptions } from './trackingConstraints'
import type { SnapToContourOptions } from './trackingConstraints'
import { ContourSpatialIndex } from './contourSpatialIndex'
import {
  initContourTracking,
  refineContourAnchors,
  DEFAULT_CONTOUR_TRACKING_CONFIG,
} from './contourAnchorTracker'
import type { ContourTrackingConfig, ContourTrackingState } from './contourAnchorTracker'

export interface TrackingConstraintParams {
  anchorTriangles: [number, number, number][]
  contourAnchorOrder?: number[]
  enableAntiSaut?: boolean           // default true
  antiSautVmax?: number              // px, default auto (1.5% of video diagonal)
  enableTemporalSmoothing?: boolean  // default false
  temporalSmoothingWindow?: number   // default 3
  enableContourConstraints?: boolean // default false
  enableOutlierDetection?: boolean   // default false
  enableMinSeparation?: boolean      // default true (anti-agglutination)
  minSeparationRatio?: number        // fraction of median initial edge length, default 0.25
  enableContourRefinement?: boolean  // default false — hybrid LK + template + snap
  contourRefinementConfig?: Partial<Omit<ContourTrackingConfig, 'contourAnchorIndices'>>
  enableSnapToContour?: boolean      // default false — snap points onto Canny contour
  snapToContourConfig?: Partial<SnapToContourOptions>
  enableCurvilinearSpring?: boolean  // default false — spring repulsion along Canny contour
  curvilinearSpringConfig?: Partial<CurvilinearSpringOptions>
  cannyParams?: CannyParams          // Canny params for contour detection during tracking
}

/** Per-frame contour tracking debug data (confidences + contour polyline) */
export interface ContourTrackingDebugData {
  confidences: number[]        // per contour-anchor confidence [0,1]
  lostFrameCount: number[]     // per contour-anchor lost frame count
  contourPolyline: Point2D[] | null  // dense contour for this frame
}

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
  onProgress?: (current: number, total: number) => void,
  constraints?: TrackingConstraintParams
): Promise<{ frameIndex: number; points: Point2D[] }[]> {
  const { video, url, ctx, width: videoW, height: videoH, fps } =
    await prepareVideo(videoBlob)

  const forward = endFrame > startFrame
  const step = forward ? 1 : -1
  const numFrames = Math.abs(endFrame - startFrame)

  // Initialize with the corrected positions (convert to video coords)
  const initVideoPoints = normalizePoints(initialPoints, imageWidth, imageHeight, videoW, videoH)

  // Build adjacency if constraints enabled
  const adjacency = constraints ? buildAnchorAdjacency(constraints.anchorTriangles) : null

  // First, seek to startFrame and init the tracker
  const startFrameData = await extractFrame(video, ctx, startFrame / fps, videoW, videoH)
  await flowInit(initVideoPoints)
  const startResult = await flowProcessFrame(startFrameData) // Process startFrame to set the reference

  let prevVideoPoints = initVideoPoints
  const results: { frameIndex: number; points: Point2D[] }[] = []

  // Compute min separation distance from initial edge lengths
  let minDist = 0
  if (constraints?.enableMinSeparation !== false && adjacency) {
    const edgeLengths: number[] = []
    for (const [i, neighbors] of adjacency) {
      for (const j of neighbors) {
        if (j > i) {
          const dx = initVideoPoints[i].x - initVideoPoints[j].x
          const dy = initVideoPoints[i].y - initVideoPoints[j].y
          edgeLengths.push(Math.sqrt(dx * dx + dy * dy))
        }
      }
    }
    if (edgeLengths.length > 0) {
      minDist = median(edgeLengths) * (constraints?.minSeparationRatio ?? 0.25)
    }
  }

  // Compute initial contour spacings for curvilinear stabilization
  let initialContourSpacings: number[] = []
  if (constraints?.enableContourConstraints && constraints.contourAnchorOrder?.length) {
    initialContourSpacings = computeInitialContourSpacings(
      initVideoPoints, constraints.contourAnchorOrder
    )
  }

  // Contour refinement setup for segment tracking
  const useContourRefinement = constraints?.enableContourRefinement && constraints.contourAnchorOrder?.length
  let contourTrackingState: ContourTrackingState | null = null
  let contourTrackingConfig: ContourTrackingConfig | null = null

  if (useContourRefinement && constraints.contourAnchorOrder) {
    contourTrackingConfig = {
      ...DEFAULT_CONTOUR_TRACKING_CONFIG,
      ...constraints.contourRefinementConfig,
      contourAnchorIndices: constraints.contourAnchorOrder,
    }
    // Initialize templates from start frame
    await flowInitTemplates(contourTrackingConfig.contourAnchorIndices, 31)
    contourTrackingState = initContourTracking(contourTrackingConfig, startResult.points)
  }

  // Build flow-frame options for snap-to-contour or curvilinear spring
  const useSnap = constraints?.enableSnapToContour && constraints.cannyParams
  const useCurvilinearSpring = constraints?.enableCurvilinearSpring && constraints.contourAnchorOrder?.length && constraints.cannyParams
  const needContourExtraction = useSnap || useCurvilinearSpring
  const flowFrameOpts: FlowFrameOptions | undefined = needContourExtraction ? {
    extractContour: true,
    cannyParams: {
      low: constraints.cannyParams!.lowThreshold,
      high: constraints.cannyParams!.highThreshold,
      blur: constraints.cannyParams!.blurSize,
    },
  } : undefined

  // Compute initial Canny spacings for curvilinear spring (from start frame)
  let initialCannySpacings: number[] = []
  if (useCurvilinearSpring && constraints.contourAnchorOrder) {
    const startDenseContour = await flowExtractContourDense(startFrameData)
    if (startDenseContour && startDenseContour.length >= 3) {
      initialCannySpacings = computeInitialCannySpacings(
        initVideoPoints, constraints.contourAnchorOrder, startDenseContour
      )
    }
  }

  for (let i = 1; i <= numFrames; i++) {
    onProgress?.(i, numFrames)
    const frameIdx = startFrame + i * step
    const frameData = await extractFrame(video, ctx, frameIdx / fps, videoW, videoH)
    const frameResult = await flowProcessFrame(frameData, flowFrameOpts)
    let points = frameResult.points

    // Apply per-frame constraints in order
    if (constraints) {
      let changed = false

      // 0. Contour refinement (template match + snap-to-contour)
      if (useContourRefinement && contourTrackingState && contourTrackingConfig) {
        const contourPolyline = await flowExtractContourDense(frameData)
        const contourMatches = frameResult.contourMatches?.map(m => ({
          tmPos: m.tmPos,
          tmScore: m.tmScore,
        })) ?? null

        const refinement = refineContourAnchors(
          points, contourMatches, contourPolyline, contourTrackingState, contourTrackingConfig
        )
        points = refinement.refined
        contourTrackingState = refinement.state
        changed = true
      }

      // 1. Anti-saut
      if (constraints.enableAntiSaut !== false) {
        const vmax = constraints.antiSautVmax ?? Math.sqrt(videoW * videoW + videoH * videoH) * 0.015
        points = applyAntiSaut(points, prevVideoPoints, vmax)
        changed = true
      }

      // 2. Neighbor consensus
      if (adjacency) {
        points = applyNeighborConstraints(points, prevVideoPoints, adjacency)
        changed = true
      }

      // 3. Curvilinear contour stabilization (skipped when contour refinement is active)
      if (!useContourRefinement && constraints.enableContourConstraints && constraints.contourAnchorOrder?.length) {
        points = stabilizeContourAnchors(
          points, prevVideoPoints, constraints.contourAnchorOrder, initialContourSpacings
        )
        changed = true
      }

      // 4. Min separation (anti-agglutination)
      if (constraints.enableMinSeparation !== false && adjacency && minDist > 0) {
        points = applyMinSeparation(points, adjacency, minDist)
        changed = true
      }

      // 5. Snap-to-contour (snaps onto detected Canny contour)
      if (useSnap && frameResult.detectedContour?.length) {
        const contourIndex = new ContourSpatialIndex(frameResult.detectedContour as Point2D[])
        const snapOpts = { enabled: true, snapRadius: 12, lostRadius: 30, strengthNormal: 1.0, strengthPartial: 0.5, ...constraints.snapToContourConfig }
        const snapResult = applySnapToContour(points, contourIndex, snapOpts)
        points = snapResult.snapped
        // Recover lost points with wider radius
        if (snapResult.lostFlags.some(f => f)) {
          const recovery = recoverLostPoints(points, snapResult.lostFlags, contourIndex)
          points = recovery.recovered
        }
        changed = true
      }

      // 6. Curvilinear spring repulsion on Canny contour (after snap)
      if (useCurvilinearSpring && initialCannySpacings.length > 0 && constraints.contourAnchorOrder) {
        const denseContour = await flowExtractContourDense(frameData)
        if (denseContour && denseContour.length >= 3) {
          points = applyCurvilinearSpringOnCanny(
            points, constraints.contourAnchorOrder, denseContour,
            initialCannySpacings, constraints.curvilinearSpringConfig
          )
          changed = true
        }
      }

      if (changed) await flowUpdatePoints(points)
    }

    prevVideoPoints = points

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
  onProgress?: (stage: string, current: number, total: number) => void,
  constraints?: TrackingConstraintParams
): Promise<{ videoFramesMesh: Point2D[][]; fps: number; contourDebug?: ContourTrackingDebugData[] }> {
  onProgress?.('Préparation', 0, 1)
  const { video, url, ctx, width: videoW, height: videoH, fps, totalFrames } =
    await prepareVideo(videoBlob)

  if (totalFrames < 2) {
    URL.revokeObjectURL(url)
    throw new Error('Video too short (need at least 2 frames)')
  }

  const initialPoints = normalizePoints(meshPoints, imageWidth, imageHeight, videoW, videoH)

  // Build adjacency if constraints enabled
  const adjacency = constraints ? buildAnchorAdjacency(constraints.anchorTriangles) : null

  // Initialize optical flow in the worker
  onProgress?.('Initialisation tracking', 0, 1)
  await flowInit(initialPoints)

  let videoFramesMesh: Point2D[][] = []
  let prevVideoPoints = initialPoints

  // Compute min separation distance from initial edge lengths
  let minDist = 0
  if (constraints?.enableMinSeparation !== false && adjacency) {
    const edgeLengths: number[] = []
    for (const [i, neighbors] of adjacency) {
      for (const j of neighbors) {
        if (j > i) {
          const dx = initialPoints[i].x - initialPoints[j].x
          const dy = initialPoints[i].y - initialPoints[j].y
          edgeLengths.push(Math.sqrt(dx * dx + dy * dy))
        }
      }
    }
    if (edgeLengths.length > 0) {
      minDist = median(edgeLengths) * (constraints?.minSeparationRatio ?? 0.25)
    }
  }

  // Compute initial contour spacings for curvilinear stabilization
  let initialContourSpacings: number[] = []
  if (constraints?.enableContourConstraints && constraints.contourAnchorOrder?.length) {
    initialContourSpacings = computeInitialContourSpacings(
      initialPoints, constraints.contourAnchorOrder
    )
  }

  // Contour refinement setup
  const useContourRefinement = constraints?.enableContourRefinement && constraints.contourAnchorOrder?.length
  let contourTrackingState: ContourTrackingState | null = null
  let contourTrackingConfig: ContourTrackingConfig | null = null
  const contourDebugData: ContourTrackingDebugData[] = []

  if (useContourRefinement && constraints.contourAnchorOrder) {
    contourTrackingConfig = {
      ...DEFAULT_CONTOUR_TRACKING_CONFIG,
      ...constraints.contourRefinementConfig,
      contourAnchorIndices: constraints.contourAnchorOrder,
    }
  }

  // Build flow-frame options for snap-to-contour or curvilinear spring
  const useSnap = constraints?.enableSnapToContour && constraints.cannyParams
  const useCurvilinearSpring = constraints?.enableCurvilinearSpring && constraints.contourAnchorOrder?.length && constraints.cannyParams
  const needContourExtraction = useSnap || useCurvilinearSpring
  const flowFrameOpts: FlowFrameOptions | undefined = needContourExtraction ? {
    extractContour: true,
    cannyParams: {
      low: constraints.cannyParams!.lowThreshold,
      high: constraints.cannyParams!.highThreshold,
      blur: constraints.cannyParams!.blurSize,
    },
  } : undefined

  // Initial Canny spacings will be computed from frame 0
  let initialCannySpacings: number[] = []

  for (let i = 0; i < totalFrames; i++) {
    onProgress?.('Extraction & tracking', i + 1, totalFrames)

    const frameData = await extractFrame(video, ctx, i / fps, videoW, videoH)
    const frameResult = await flowProcessFrame(frameData, flowFrameOpts)
    let points = frameResult.points

    // Frame 0: initialize contour templates + compute initial Canny spacings
    if (i === 0) {
      if (useContourRefinement && contourTrackingConfig) {
        await flowInitTemplates(contourTrackingConfig.contourAnchorIndices, 31)
        contourTrackingState = initContourTracking(contourTrackingConfig, points)
        contourDebugData.push({
          confidences: [...contourTrackingState.confidences],
          lostFrameCount: [...contourTrackingState.lostFrameCount],
          contourPolyline: null,
        })
      }

      if (useCurvilinearSpring && constraints.contourAnchorOrder) {
        const denseContour = await flowExtractContourDense(frameData)
        if (denseContour && denseContour.length >= 3) {
          initialCannySpacings = computeInitialCannySpacings(
            points, constraints.contourAnchorOrder, denseContour
          )
        }
      }
    }

    // Apply per-frame constraints (skip frame 0 — no displacement yet)
    if (constraints && i > 0) {
      let changed = false
      const vmax = constraints.antiSautVmax ?? Math.sqrt(videoW * videoW + videoH * videoH) * 0.015

      // 0. Contour refinement (template match + snap-to-contour)
      if (useContourRefinement && contourTrackingState && contourTrackingConfig) {
        // Extract dense contour from current frame
        const contourPolyline = await flowExtractContourDense(frameData)
        const contourMatches = frameResult.contourMatches?.map(m => ({
          tmPos: m.tmPos,
          tmScore: m.tmScore,
        })) ?? null

        const refinement = refineContourAnchors(
          points, contourMatches, contourPolyline, contourTrackingState, contourTrackingConfig
        )
        points = refinement.refined
        contourTrackingState = refinement.state
        changed = true

        // Store debug data
        contourDebugData.push({
          confidences: [...contourTrackingState.confidences],
          lostFrameCount: [...contourTrackingState.lostFrameCount],
          contourPolyline,
        })
      }

      // 1. Anti-saut
      if (constraints.enableAntiSaut !== false) {
        points = applyAntiSaut(points, prevVideoPoints, vmax)
        changed = true
      }

      // 2. Neighbor consensus
      if (adjacency) {
        points = applyNeighborConstraints(points, prevVideoPoints, adjacency)
        changed = true
      }

      // 3. Curvilinear contour stabilization (skipped when contour refinement is active)
      if (!useContourRefinement && constraints.enableContourConstraints && constraints.contourAnchorOrder?.length) {
        points = stabilizeContourAnchors(
          points, prevVideoPoints, constraints.contourAnchorOrder, initialContourSpacings
        )
        changed = true
      }

      // 4. Min separation (anti-agglutination)
      if (constraints.enableMinSeparation !== false && adjacency && minDist > 0) {
        points = applyMinSeparation(points, adjacency, minDist)
        changed = true
      }

      // 5. Snap-to-contour (snaps onto detected Canny contour)
      if (useSnap && frameResult.detectedContour?.length) {
        const contourIndex = new ContourSpatialIndex(frameResult.detectedContour as Point2D[])
        const snapOpts = { enabled: true, snapRadius: 12, lostRadius: 30, strengthNormal: 1.0, strengthPartial: 0.5, ...constraints.snapToContourConfig }
        const snapResult = applySnapToContour(points, contourIndex, snapOpts)
        points = snapResult.snapped
        // Recover lost points with wider radius
        if (snapResult.lostFlags.some(f => f)) {
          const recovery = recoverLostPoints(points, snapResult.lostFlags, contourIndex)
          points = recovery.recovered
        }
        changed = true
      }

      // 6. Curvilinear spring repulsion on Canny contour (after snap)
      if (useCurvilinearSpring && initialCannySpacings.length > 0 && constraints.contourAnchorOrder) {
        const denseContour = await flowExtractContourDense(frameData)
        if (denseContour && denseContour.length >= 3) {
          points = applyCurvilinearSpringOnCanny(
            points, constraints.contourAnchorOrder, denseContour,
            initialCannySpacings, constraints.curvilinearSpringConfig
          )
          changed = true
        }
      }

      if (changed) await flowUpdatePoints(points)
    }

    prevVideoPoints = points
    videoFramesMesh.push(points)
  }

  await flowCleanup()
  URL.revokeObjectURL(url)

  // Post-processing: temporal smoothing
  if (constraints?.enableTemporalSmoothing) {
    videoFramesMesh = applyTemporalSmoothing(
      videoFramesMesh,
      constraints.temporalSmoothingWindow ?? 3
    )
  }

  // Post-processing: outlier detection & correction
  if (constraints?.enableOutlierDetection && adjacency) {
    const result = detectAndCorrectOutliers(videoFramesMesh, adjacency)
    videoFramesMesh = result.corrected
  }

  // Normalize back to image coordinates for storage
  const normalizedFrames = videoFramesMesh.map(framePoints =>
    framePoints.map(p => ({
      x: (p.x / videoW) * imageWidth,
      y: (p.y / videoH) * imageHeight,
    }))
  )

  // Normalize contour debug polylines to image coordinates
  if (contourDebugData.length > 0) {
    for (const debug of contourDebugData) {
      if (debug.contourPolyline) {
        debug.contourPolyline = debug.contourPolyline.map(p => ({
          x: (p.x / videoW) * imageWidth,
          y: (p.y / videoH) * imageHeight,
        }))
      }
    }
  }

  return {
    videoFramesMesh: normalizedFrames,
    fps,
    contourDebug: useContourRefinement ? contourDebugData : undefined,
  }
}
