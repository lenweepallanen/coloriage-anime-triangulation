import { useState, useRef, useCallback, useEffect } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { orderContourPixels, computeArcLengths, interpolateAtArcLength, reorderContourFromOrigin } from '../../utils/curvilinearContour'
import { trackCurvatureExtrema, type CSSCandidate } from '../../utils/curvatureScaleSpace'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

type Phase = 'ready' | 'computing' | 'preview' | 'validated'

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = URL.createObjectURL(blob)
  })
}

export default function ContourTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh

  const initialPhase: Phase = mesh?.contourAnchorTrackingValidated ? 'validated' : 'ready'
  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [progress, setProgress] = useState('')
  const [saving, setSaving] = useState(false)

  // Preview state
  const [previewFrame, setPreviewFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const animRef = useRef<number>(0)

  // Computation results
  const computedFramesRef = useRef<Point2D[][] | null>(null)
  const rawFramesRef = useRef<Point2D[][] | null>(null)
  const lostFlagsRef = useRef<boolean[][] | null>(null)
  const cannyFramesRef = useRef<Point2D[][] | null>(null)
  const totalFramesRef = useRef(0)
  const imageDimsRef = useRef<{ w: number; h: number } | null>(null)
  const lastModeRef = useRef<boolean>(false) // true = step-by-step

  // Drag state
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hasEdited, setHasEdited] = useState(false)
  const [propagating, setPropagating] = useState(false)

  // Extrema tracking constants
  const N_EXTREMA = 20
  const SNAP_THRESHOLD = 15   // px: distance max gris↔extremum pour snap
  const LOST_THRESHOLD = 40   // px: au-delà → point perdu

  // ─── Prerequisites ──────────────────────────────────────────────
  const hasAnchors = (mesh?.contourAnchors?.length ?? 0) >= 3
  const hasCanny = !!mesh?.cannyParams
  const hasOrigin = !!mesh?.contourOriginFrames
  const hasVideo = !!project.videoBlob
  const hasImage = !!project.originalImageBlob
  const ready = hasAnchors && hasCanny && hasOrigin && hasVideo && hasImage

  // ─── Compute (shared logic) ─────────────────────────────────────
  const runCompute = useCallback(async (stepByStep: boolean) => {
    if (!ready || !mesh) return
    setPhase('computing')
    setProgress(`Initialisation... (mode ${stepByStep ? 'proche en proche' : 'fixe'})`)

    try {
      const contourAnchors = mesh.contourAnchors
      const originFrames = mesh.contourOriginFrames!
      const cannyParams = mesh.cannyParams!

      await loadOpenCVWorker()

      // 1. Get image dimensions
      const img = await loadImage(project.originalImageBlob!)
      const iw = img.naturalWidth, ih = img.naturalHeight
      URL.revokeObjectURL(img.src)
      imageDimsRef.current = { w: iw, h: ih }

      // 2. Detect Canny on original image -> compute reference arc-lengths
      const canvas0 = document.createElement('canvas')
      canvas0.width = iw; canvas0.height = ih
      const ctx0 = canvas0.getContext('2d')!
      ctx0.drawImage(img, 0, 0)
      const imgData0 = ctx0.getImageData(0, 0, iw, ih)
      const cannyPts0 = await flowCannyContour(imgData0, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)
      if (!cannyPts0 || cannyPts0.length < 10) {
        setProgress('Erreur: contour Canny non détecté sur l\'image originale')
        setPhase('ready')
        return
      }

      let ordered0 = orderContourPixels(cannyPts0)
      if (mesh.contourOrigin) {
        ordered0 = reorderContourFromOrigin(ordered0, mesh.contourOrigin)
      }
      const arcLengths0 = computeArcLengths(ordered0)
      const totalLen0 = arcLengths0[arcLengths0.length - 1] || 1

      // Compute normalized s for each anchor at frame 0
      const anchorS: number[] = contourAnchors.map(anchor => {
        let bestIdx = 0, bestDist = Infinity
        for (let i = 0; i < ordered0.length; i++) {
          const d = Math.hypot(ordered0[i].x - anchor.x, ordered0[i].y - anchor.y)
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        return arcLengths0[bestIdx] / totalLen0
      })

      // 2b. Detect curvature extrema on frame 0 + associate each anchor
      const extrema0Result = trackCurvatureExtrema(ordered0, N_EXTREMA, null)
      let previousExtrema: CSSCandidate[] = extrema0Result.extrema

      // For each anchor, find the closest extremum → anchorExtremumIdx[a]
      const anchorExtremumIdx: number[] = contourAnchors.map(anchor => {
        let bestIdx = 0, bestDist = Infinity
        for (let i = 0; i < previousExtrema.length; i++) {
          const d = Math.hypot(previousExtrema[i].position.x - anchor.x, previousExtrema[i].position.y - anchor.y)
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        return bestIdx
      })

      // 3. Create video, get total frames
      const url = URL.createObjectURL(project.videoBlob!)
      const video = document.createElement('video')
      video.src = url
      video.muted = true
      video.preload = 'auto'
      await new Promise<void>(r => { video.onloadeddata = () => r(); video.load() })
      const vw = video.videoWidth, vh = video.videoHeight
      const totalFrames = Math.floor(video.duration * 24)

      // 4. Allocate result arrays
      const allFrames: Point2D[][] = []
      const allRawFrames: Point2D[][] = []
      const allLostFlags: boolean[][] = []
      const allCannyFrames: Point2D[][] = []

      // Frame 0 = original anchor positions (no lost)
      allFrames.push([...contourAnchors])
      allRawFrames.push([...contourAnchors])
      allLostFlags.push(contourAnchors.map(() => false))
      allCannyFrames.push(ordered0)

      const vCanvas = document.createElement('canvas')
      vCanvas.width = vw; vCanvas.height = vh
      const vCtx = vCanvas.getContext('2d')!

      // 5. Process each frame
      for (let f = 1; f < totalFrames; f++) {
        if (f % 5 === 0 || f === 1) {
          setProgress(`Frame ${f}/${totalFrames}`)
          await new Promise(r => setTimeout(r, 0))
        }

        // Seek
        video.currentTime = f / 24
        await new Promise<void>(r => { video.onseeked = () => r() })

        // Draw frame
        vCtx.drawImage(video, 0, 0)
        const imageData = vCtx.getImageData(0, 0, vw, vh)

        // Detect Canny
        const cannyPts = await flowCannyContour(imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)

        if (!cannyPts || cannyPts.length < 10) {
          allFrames.push([...allFrames[f - 1]])
          allRawFrames.push([...allRawFrames[f - 1]])
          allLostFlags.push(contourAnchors.map(() => true))
          allCannyFrames.push([])
          continue
        }

        // Scale Canny points from video coords to image coords
        const imgCanny = cannyPts.map(p => ({ x: (p.x / vw) * iw, y: (p.y / vh) * ih }))

        // Order and reorder from P0
        let ordered = orderContourPixels(imgCanny)
        const p0Frame = originFrames[f]?.[0]
        if (p0Frame) {
          ordered = reorderContourFromOrigin(ordered, p0Frame)
        }
        const arcLengths = computeArcLengths(ordered)
        const totalLen = arcLengths[arcLengths.length - 1] || 1
        allCannyFrames.push(ordered)

        // Detect & track curvature extrema for this frame
        const extremaResult = trackCurvatureExtrema(ordered, N_EXTREMA, previousExtrema)
        previousExtrema = extremaResult.extrema

        // Place each anchor at its s coordinate, then snap to tracked extremum
        const rawPositions: Point2D[] = []
        const adjustedPositions: Point2D[] = []
        const frameLostFlags: boolean[] = []

        for (let a = 0; a < contourAnchors.length; a++) {
          if (a === 0 && p0Frame) {
            // Anchor 0 = P0, use tracked position directly
            rawPositions.push(p0Frame)
            adjustedPositions.push(p0Frame)
            frameLostFlags.push(false)
            // Step-by-step: update s from P0 position
            if (stepByStep) {
              let bestIdx = 0, bestDist = Infinity
              for (let i = 0; i < ordered.length; i++) {
                const d = Math.hypot(ordered[i].x - p0Frame.x, ordered[i].y - p0Frame.y)
                if (d < bestDist) { bestDist = d; bestIdx = i }
              }
              anchorS[a] = arcLengths[bestIdx] / totalLen
            }
            continue
          }

          const rawPos = interpolateAtArcLength(ordered, arcLengths, anchorS[a])
          rawPositions.push(rawPos)

          // Find this anchor's tracked extremum
          const extIdx = anchorExtremumIdx[a]
          const trackedExtremum = extremaResult.extrema[extIdx]

          if (trackedExtremum) {
            const dist = Math.hypot(rawPos.x - trackedExtremum.position.x, rawPos.y - trackedExtremum.position.y)

            if (dist <= SNAP_THRESHOLD) {
              // Close enough → snap to extremum
              adjustedPositions.push(trackedExtremum.position)
              frameLostFlags.push(false)
              // Step-by-step: update s from snapped position
              if (stepByStep) {
                anchorS[a] = trackedExtremum.arcLengthNorm
              }
            } else if (dist <= LOST_THRESHOLD) {
              // Partial snap (blend between raw and extremum)
              const t = (dist - SNAP_THRESHOLD) / (LOST_THRESHOLD - SNAP_THRESHOLD)
              const blended = {
                x: trackedExtremum.position.x * (1 - t) + rawPos.x * t,
                y: trackedExtremum.position.y * (1 - t) + rawPos.y * t,
              }
              adjustedPositions.push(blended)
              frameLostFlags.push(false)
              // Step-by-step: update s from blended position
              if (stepByStep) {
                let bestIdx = 0, bestDist = Infinity
                for (let i = 0; i < ordered.length; i++) {
                  const d = Math.hypot(ordered[i].x - blended.x, ordered[i].y - blended.y)
                  if (d < bestDist) { bestDist = d; bestIdx = i }
                }
                anchorS[a] = arcLengths[bestIdx] / totalLen
              }
            } else {
              // Too far → lost, fallback to raw position
              adjustedPositions.push(rawPos)
              frameLostFlags.push(true)
              // Step-by-step: still update s from raw position (keep tracking)
              if (stepByStep) {
                // Don't update s when lost — keep last good s to avoid cascading drift
              }
            }
          } else {
            // No extremum found → fallback
            adjustedPositions.push(rawPos)
            frameLostFlags.push(true)
          }
        }

        allFrames.push(adjustedPositions)
        allRawFrames.push(rawPositions)
        allLostFlags.push(frameLostFlags)
      }

      URL.revokeObjectURL(url)

      // Store results
      computedFramesRef.current = allFrames
      rawFramesRef.current = allRawFrames
      lostFlagsRef.current = allLostFlags
      cannyFramesRef.current = allCannyFrames
      totalFramesRef.current = totalFrames

      // Log lost stats
      const lostCounts = contourAnchors.map((_, a) =>
        allLostFlags.reduce((sum, flags) => sum + (flags[a] ? 1 : 0), 0)
      )
      console.log(`Extrema tracking (${stepByStep ? 'step-by-step' : 'fixed-s'}) — lost frames per anchor:`, lostCounts)

      // Create video element for preview
      const previewUrl = URL.createObjectURL(project.videoBlob!)
      const previewVideo = document.createElement('video')
      previewVideo.src = previewUrl
      previewVideo.muted = true
      previewVideo.preload = 'auto'
      await new Promise<void>(r => { previewVideo.onloadeddata = () => r(); previewVideo.load() })
      videoRef.current = previewVideo

      lastModeRef.current = stepByStep
      setHasEdited(false)
      setPreviewFrame(0)
      setPhase('preview')
      setProgress('')
    } catch (err) {
      console.error('Contour tracking failed:', err)
      setProgress(`Erreur: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('ready')
    }
  }, [ready, mesh, project])

  const handleCompute = useCallback(() => runCompute(false), [runCompute])
  const handleComputeStepByStep = useCallback(() => runCompute(true), [runCompute])

  // ─── Preview rendering ──────────────────────────────────────────
  const drawPreview = useCallback(async (frame: number) => {
    const canvas = canvasRef.current
    const video = videoRef.current
    const computed = computedFramesRef.current
    const raw = rawFramesRef.current
    const imgDims = imageDimsRef.current
    if (!canvas || !video || !computed || !raw || !imgDims) return

    const ctx = canvas.getContext('2d')!

    // Seek video
    video.currentTime = frame / 24
    await new Promise<void>(r => { video.onseeked = () => r() })

    // Fit canvas to container
    const maxW = canvas.parentElement?.clientWidth ?? 800
    const vw = video.videoWidth, vh = video.videoHeight
    const displayScale = Math.min(maxW / vw, 600 / vh, 1)
    canvas.width = Math.round(vw * displayScale)
    canvas.height = Math.round(vh * displayScale)

    // Draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const frameData = computed[frame]
    const rawData = raw[frame]
    const lostFlags = lostFlagsRef.current?.[frame]
    const cannyPts = cannyFramesRef.current?.[frame]
    if (!frameData || !rawData) return

    // Anchors are in image coords → scale to canvas coords
    const scaleX = canvas.width / imgDims.w
    const scaleY = canvas.height / imgDims.h

    // Draw Canny contour (yellow pixels)
    if (cannyPts && cannyPts.length > 0) {
      ctx.fillStyle = 'rgba(255, 255, 0, 0.5)'
      for (let i = 0; i < cannyPts.length; i++) {
        const px = cannyPts[i].x * scaleX
        const py = cannyPts[i].y * scaleY
        ctx.fillRect(px - 0.5, py - 0.5, 1.5, 1.5)
      }
    }

    // Draw polygon connecting adjusted positions (blue)
    if (frameData.length >= 3) {
      ctx.beginPath()
      ctx.moveTo(frameData[0].x * scaleX, frameData[0].y * scaleY)
      for (let i = 1; i < frameData.length; i++) {
        ctx.lineTo(frameData[i].x * scaleX, frameData[i].y * scaleY)
      }
      ctx.closePath()
      ctx.strokeStyle = 'rgba(80, 140, 255, 0.7)'
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Draw raw s-positions (gray, faded, smaller)
    for (let i = 0; i < rawData.length; i++) {
      const rx = rawData[i].x * scaleX
      const ry = rawData[i].y * scaleY
      ctx.beginPath()
      ctx.arc(rx, ry, 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(180, 180, 180, 0.5)'
      ctx.fill()
      ctx.fillStyle = 'rgba(180, 180, 180, 0.7)'
      ctx.font = 'bold 9px sans-serif'
      ctx.fillText(`${i}`, rx + 6, ry - 3)
    }

    // Draw adjusted positions: green = snapped, orange = lost
    for (let i = 0; i < frameData.length; i++) {
      const cx = frameData[i].x * scaleX
      const cy = frameData[i].y * scaleY
      const isLost = lostFlags?.[i] ?? false

      ctx.beginPath()
      ctx.arc(cx, cy, 6, 0, Math.PI * 2)
      ctx.fillStyle = isLost ? 'rgba(255, 160, 0, 0.9)' : 'rgba(50, 220, 50, 0.9)'
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Label
      ctx.fillStyle = 'white'
      ctx.font = 'bold 10px sans-serif'
      ctx.fillText(`${i}${isLost ? '?' : ''}`, cx + 8, cy - 4)
    }
  }, [])

  // Draw on frame change
  useEffect(() => {
    if (phase === 'preview') {
      drawPreview(previewFrame)
    }
  }, [phase, previewFrame, drawPreview])

  // ─── Drag interaction ─────────────────────────────────────────
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const computed = computedFramesRef.current
    const imgDims = imageDimsRef.current
    if (!canvas || !computed || !imgDims || playing) return

    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const scaleX = canvas.width / imgDims.w
    const scaleY = canvas.height / imgDims.h

    const frameData = computed[previewFrame]
    if (!frameData) return

    // Find closest point within 15px canvas distance
    let bestIdx = -1, bestDist = 15
    for (let i = 0; i < frameData.length; i++) {
      const px = frameData[i].x * scaleX
      const py = frameData[i].y * scaleY
      const d = Math.hypot(cx - px, cy - py)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }

    if (bestIdx >= 0) {
      setDraggingIdx(bestIdx)
    }
  }, [previewFrame, playing])

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draggingIdx === null) return
    const canvas = canvasRef.current
    const computed = computedFramesRef.current
    const imgDims = imageDimsRef.current
    if (!canvas || !computed || !imgDims) return

    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const scaleX = canvas.width / imgDims.w
    const scaleY = canvas.height / imgDims.h

    // Update position in image coords
    computed[previewFrame][draggingIdx] = {
      x: cx / scaleX,
      y: cy / scaleY,
    }
    // Also clear lost flag for this point
    if (lostFlagsRef.current?.[previewFrame]) {
      lostFlagsRef.current[previewFrame][draggingIdx] = false
    }
    setHasEdited(true)
    drawPreview(previewFrame)
  }, [draggingIdx, previewFrame, drawPreview])

  const handleCanvasMouseUp = useCallback(() => {
    setDraggingIdx(null)
  }, [])

  // ─── Propagate forward ────────────────────────────────────────
  const handlePropagate = useCallback(async () => {
    if (!mesh || !computedFramesRef.current || !lostFlagsRef.current || !rawFramesRef.current) return
    const startFrame = previewFrame
    const totalFrames = totalFramesRef.current
    if (startFrame >= totalFrames - 1) return

    const stepByStep = lastModeRef.current
    setPropagating(true)
    setPlaying(false)
    setProgress(`Propagation depuis frame ${startFrame + 1}...`)

    try {
      const contourAnchors = mesh.contourAnchors
      const originFrames = mesh.contourOriginFrames!
      const cannyParams = mesh.cannyParams!
      const imgDims = imageDimsRef.current!
      const iw = imgDims.w, ih = imgDims.h

      // Edited positions at startFrame
      const editedPositions = computedFramesRef.current[startFrame]

      await loadOpenCVWorker()

      // Create video for seeking
      const url = URL.createObjectURL(project.videoBlob!)
      const video = document.createElement('video')
      video.src = url
      video.muted = true
      video.preload = 'auto'
      await new Promise<void>(r => { video.onloadeddata = () => r(); video.load() })
      const vw = video.videoWidth, vh = video.videoHeight

      const vCanvas = document.createElement('canvas')
      vCanvas.width = vw; vCanvas.height = vh
      const vCtx = vCanvas.getContext('2d')!

      // Detect Canny at startFrame to get contour + extrema state
      video.currentTime = startFrame / 24
      await new Promise<void>(r => { video.onseeked = () => r() })
      vCtx.drawImage(video, 0, 0)
      const startImageData = vCtx.getImageData(0, 0, vw, vh)
      const startCannyPts = await flowCannyContour(startImageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)

      // Compute anchorS from edited positions on startFrame's contour
      const anchorS: number[] = new Array(contourAnchors.length).fill(0)
      let previousExtrema: CSSCandidate[] | null = null

      if (startCannyPts && startCannyPts.length >= 10) {
        const imgCanny = startCannyPts.map(p => ({ x: (p.x / vw) * iw, y: (p.y / vh) * ih }))
        let ordered = orderContourPixels(imgCanny)
        const p0Frame = originFrames[startFrame]?.[0]
        if (p0Frame) ordered = reorderContourFromOrigin(ordered, p0Frame)
        const arcLengths = computeArcLengths(ordered)
        const totalLen = arcLengths[arcLengths.length - 1] || 1

        // Compute anchorS from edited positions
        for (let a = 0; a < contourAnchors.length; a++) {
          const pos = editedPositions[a]
          let bestIdx = 0, bestDist = Infinity
          for (let i = 0; i < ordered.length; i++) {
            const d = Math.hypot(ordered[i].x - pos.x, ordered[i].y - pos.y)
            if (d < bestDist) { bestDist = d; bestIdx = i }
          }
          anchorS[a] = arcLengths[bestIdx] / totalLen
        }

        // Detect extrema at startFrame
        const extremaResult = trackCurvatureExtrema(ordered, N_EXTREMA, null)
        previousExtrema = extremaResult.extrema
      }

      // Re-associate anchors to extrema from edited positions
      const anchorExtremumIdx: number[] = editedPositions.map(pos => {
        if (!previousExtrema) return 0
        let bestIdx = 0, bestDist = Infinity
        for (let i = 0; i < previousExtrema.length; i++) {
          const d = Math.hypot(previousExtrema[i].position.x - pos.x, previousExtrema[i].position.y - pos.y)
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        return bestIdx
      })

      // Process frames from startFrame+1 to end
      for (let f = startFrame + 1; f < totalFrames; f++) {
        if (f % 5 === 0) {
          setProgress(`Propagation frame ${f}/${totalFrames}`)
          await new Promise(r => setTimeout(r, 0))
        }

        video.currentTime = f / 24
        await new Promise<void>(r => { video.onseeked = () => r() })
        vCtx.drawImage(video, 0, 0)
        const imageData = vCtx.getImageData(0, 0, vw, vh)

        const cannyPts = await flowCannyContour(imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)

        if (!cannyPts || cannyPts.length < 10) {
          computedFramesRef.current[f] = [...computedFramesRef.current[f - 1]]
          rawFramesRef.current[f] = [...rawFramesRef.current[f - 1]]
          lostFlagsRef.current[f] = contourAnchors.map(() => true)
          if (cannyFramesRef.current) cannyFramesRef.current[f] = []
          continue
        }

        const imgCanny = cannyPts.map(p => ({ x: (p.x / vw) * iw, y: (p.y / vh) * ih }))
        let ordered = orderContourPixels(imgCanny)
        const p0Frame = originFrames[f]?.[0]
        if (p0Frame) ordered = reorderContourFromOrigin(ordered, p0Frame)
        const arcLengths = computeArcLengths(ordered)
        const totalLen = arcLengths[arcLengths.length - 1] || 1
        if (cannyFramesRef.current) cannyFramesRef.current[f] = ordered

        const extremaResult = trackCurvatureExtrema(ordered, N_EXTREMA, previousExtrema)
        previousExtrema = extremaResult.extrema

        const rawPositions: Point2D[] = []
        const adjustedPositions: Point2D[] = []
        const frameLostFlags: boolean[] = []

        for (let a = 0; a < contourAnchors.length; a++) {
          if (a === 0 && p0Frame) {
            rawPositions.push(p0Frame)
            adjustedPositions.push(p0Frame)
            frameLostFlags.push(false)
            if (stepByStep) {
              let bestIdx = 0, bestDist = Infinity
              for (let i = 0; i < ordered.length; i++) {
                const d = Math.hypot(ordered[i].x - p0Frame.x, ordered[i].y - p0Frame.y)
                if (d < bestDist) { bestDist = d; bestIdx = i }
              }
              anchorS[a] = arcLengths[bestIdx] / totalLen
            }
            continue
          }

          const rawPos = interpolateAtArcLength(ordered, arcLengths, anchorS[a])
          rawPositions.push(rawPos)

          const extIdx = anchorExtremumIdx[a]
          const trackedExtremum = extremaResult.extrema[extIdx]

          if (trackedExtremum) {
            const dist = Math.hypot(rawPos.x - trackedExtremum.position.x, rawPos.y - trackedExtremum.position.y)

            if (dist <= SNAP_THRESHOLD) {
              adjustedPositions.push(trackedExtremum.position)
              frameLostFlags.push(false)
              if (stepByStep) anchorS[a] = trackedExtremum.arcLengthNorm
            } else if (dist <= LOST_THRESHOLD) {
              const t = (dist - SNAP_THRESHOLD) / (LOST_THRESHOLD - SNAP_THRESHOLD)
              const blended = {
                x: trackedExtremum.position.x * (1 - t) + rawPos.x * t,
                y: trackedExtremum.position.y * (1 - t) + rawPos.y * t,
              }
              adjustedPositions.push(blended)
              frameLostFlags.push(false)
              if (stepByStep) {
                let bestIdx = 0, bestDist = Infinity
                for (let i = 0; i < ordered.length; i++) {
                  const d = Math.hypot(ordered[i].x - blended.x, ordered[i].y - blended.y)
                  if (d < bestDist) { bestDist = d; bestIdx = i }
                }
                anchorS[a] = arcLengths[bestIdx] / totalLen
              }
            } else {
              adjustedPositions.push(rawPos)
              frameLostFlags.push(true)
            }
          } else {
            adjustedPositions.push(rawPos)
            frameLostFlags.push(true)
          }
        }

        computedFramesRef.current[f] = adjustedPositions
        rawFramesRef.current[f] = rawPositions
        lostFlagsRef.current[f] = frameLostFlags
      }

      URL.revokeObjectURL(url)

      // Log stats
      const lostCounts = contourAnchors.map((_, a) =>
        lostFlagsRef.current!.slice(startFrame).reduce((sum, flags) => sum + (flags[a] ? 1 : 0), 0)
      )
      console.log(`Propagation from frame ${startFrame} — lost frames per anchor:`, lostCounts)

      setHasEdited(false)
      setProgress('')
      drawPreview(previewFrame)
    } catch (err) {
      console.error('Propagation failed:', err)
      setProgress(`Erreur propagation: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPropagating(false)
    }
  }, [mesh, project, previewFrame, drawPreview])

  // ─── Playback ───────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || phase !== 'preview') return

    let lastTime = 0
    const step = (time: number) => {
      if (time - lastTime >= 1000 / 24) {
        lastTime = time
        setPreviewFrame(f => {
          const next = f + 1
          if (next >= totalFramesRef.current) {
            setPlaying(false)
            return 0
          }
          return next
        })
      }
      animRef.current = requestAnimationFrame(step)
    }
    animRef.current = requestAnimationFrame(step)

    return () => cancelAnimationFrame(animRef.current)
  }, [playing, phase])

  // ─── Validate ───────────────────────────────────────────────────
  const handleValidate = useCallback(async () => {
    if (!computedFramesRef.current || !mesh) return
    setSaving(true)

    try {
      const updatedMesh: MeshData = {
        ...mesh,
        contourAnchorKeyframes: [],
        contourAnchorFrames: computedFramesRef.current,
        contourAnchorTrackingValidated: true,
        // Reset downstream
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        anchorFrames: null,
        anchorTrackingValidated: false,
        videoFramesMesh: null,
        topologyLocked: false,
      }

      await onSave(
        { ...project, mesh: updatedMesh },
        ['contourAnchorKeyframes', 'contourAnchorFrames']
      )
      setPhase('validated')
    } catch (err) {
      console.error('Save failed:', err)
    } finally {
      setSaving(false)
    }
  }, [mesh, project, onSave])

  // ─── Reset ──────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    computedFramesRef.current = null
    rawFramesRef.current = null
    lostFlagsRef.current = null
    cannyFramesRef.current = null
    totalFramesRef.current = 0
    setPlaying(false)
    setPreviewFrame(0)

    if (videoRef.current) {
      URL.revokeObjectURL(videoRef.current.src)
      videoRef.current = null
    }

    if (mesh?.contourAnchorTrackingValidated) {
      setSaving(true)
      try {
        const updatedMesh: MeshData = {
          ...mesh,
          contourAnchorKeyframes: [],
          contourAnchorFrames: null,
          contourAnchorTrackingValidated: false,
          contourSubdivisionFrames: null,
          contourSubdivisionValidated: false,
          anchorFrames: null,
          anchorTrackingValidated: false,
          videoFramesMesh: null,
          topologyLocked: false,
        }
        await onSave(
          { ...project, mesh: updatedMesh },
          ['contourAnchorKeyframes', 'contourAnchorFrames']
        )
      } finally {
        setSaving(false)
      }
    }

    setPhase('ready')
  }, [mesh, project, onSave])

  // ─── Cleanup ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        URL.revokeObjectURL(videoRef.current.src)
      }
      cancelAnimationFrame(animRef.current)
    }
  }, [])

  // ─── Render ─────────────────────────────────────────────────────
  if (!ready) {
    return (
      <div className="triangulation-step">
        <h3>Etape 5 — Tracking contour (curviligne)</h3>
        <div className="step-placeholder">
          {!hasAnchors && <p>Placez au moins 3 anchors contour (etape 3).</p>}
          {!hasCanny && <p>Validez les parametres Canny (etape 2).</p>}
          {!hasOrigin && <p>Trackez le point origine P0 (etape 4).</p>}
          {!hasVideo && <p>Importez une video (etape 1).</p>}
          {!hasImage && <p>Importez une image (etape 1).</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      <h3>Etape 5 — Tracking contour (curviligne)</h3>
      <p className="step-description">
        Placement deterministe des anchors par coordonnee curviligne normalisee
        sur le contour Canny, avec tracking des extrema de courbure frame par frame.
      </p>

      {/* ── Ready ─────────────────────────────────────── */}
      {phase === 'ready' && (
        <div className="step-actions">
          <p>{mesh!.contourAnchors.length} anchors contour a tracker.</p>
          <button className="btn-primary" onClick={handleCompute}>
            Tracking contour (s fixe)
          </button>
          <button className="btn-primary" onClick={handleComputeStepByStep} style={{ marginLeft: 8 }}>
            Tracking contour (proche en proche)
          </button>
        </div>
      )}

      {/* ── Computing ─────────────────────────────────── */}
      {phase === 'computing' && (
        <div className="step-progress">
          <div className="progress-bar">
            <div className="progress-bar-inner" style={{ width: '100%' }} />
          </div>
          <p>{progress}</p>
        </div>
      )}

      {/* ── Preview ───────────────────────────────────── */}
      {phase === 'preview' && (
        <div className="step-preview">
          <div className="preview-controls">
            <button
              className="btn-secondary"
              onClick={() => setPlaying(p => !p)}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              className="btn-secondary"
              onClick={() => { setPlaying(false); setPreviewFrame(0) }}
            >
              Debut
            </button>
            <span className="frame-label">
              Frame {previewFrame + 1} / {totalFramesRef.current}
            </span>
          </div>

          <input
            type="range"
            min={0}
            max={totalFramesRef.current - 1}
            value={previewFrame}
            onChange={e => {
              setPlaying(false)
              setPreviewFrame(Number(e.target.value))
            }}
            style={{ width: '100%', margin: '8px 0' }}
          />

          <canvas
            ref={canvasRef}
            style={{ maxWidth: '100%', background: '#111', cursor: draggingIdx !== null ? 'grabbing' : 'default' }}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
          />

          <div className="preview-legend" style={{ fontSize: '0.85em', marginTop: 8, color: '#aaa' }}>
            <span style={{ color: 'rgba(255,255,0,0.6)' }}>● Jaune</span> = contour Canny
            {' | '}
            <span style={{ color: 'rgba(80,140,255,0.8)' }}>— Bleu</span> = polygone anchors
            {' | '}
            <span style={{ color: 'rgba(180,180,180,0.8)' }}>● Gris</span> = position brute (s)
            {' | '}
            <span style={{ color: 'rgba(50,220,50,0.9)' }}>● Vert</span> = snap extremum
            {' | '}
            <span style={{ color: 'rgba(255,160,0,0.9)' }}>● Orange</span> = perdu
            <br />
            Glissez un point pour le repositionner, puis cliquez "Propager avant".
          </div>

          {/* Propagate button */}
          <div style={{ marginTop: 12 }}>
            <button
              className="btn-secondary"
              onClick={handlePropagate}
              disabled={propagating || playing}
              style={{ marginRight: 8 }}
            >
              {propagating ? 'Propagation...' : `Propager avant (depuis frame ${previewFrame + 1})`}
            </button>
            {hasEdited && <span style={{ color: '#ffa000', fontSize: '0.85em' }}>Points edites — propager pour appliquer</span>}
            {propagating && <p style={{ marginTop: 4, fontSize: '0.85em', color: '#aaa' }}>{progress}</p>}
          </div>

          <div className="step-actions" style={{ marginTop: 16 }}>
            <button
              className="btn-primary"
              onClick={handleValidate}
              disabled={saving || propagating}
            >
              {saving ? 'Sauvegarde...' : 'Valider le tracking'}
            </button>
            <button
              className="btn-secondary"
              onClick={handleReset}
              disabled={saving || propagating}
            >
              Reinitialiser
            </button>
          </div>
        </div>
      )}

      {/* ── Validated ─────────────────────────────────── */}
      {phase === 'validated' && (
        <div className="step-validated">
          <p className="validated-badge">
            Tracking contour valide ({mesh!.contourAnchors.length} anchors,{' '}
            {mesh!.contourAnchorFrames?.length ?? '?'} frames)
          </p>
          <button
            className="btn-secondary"
            onClick={handleReset}
            disabled={saving}
          >
            {saving ? 'Sauvegarde...' : 'Reinitialiser'}
          </button>
        </div>
      )}
    </div>
  )
}
