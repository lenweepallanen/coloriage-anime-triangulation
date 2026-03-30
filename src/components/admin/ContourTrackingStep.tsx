import { useState, useRef, useCallback, useEffect } from 'react'
import type { ProjectStepView, Point2D, MeshData, CurvilinearParam } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { computeArcLengths, interpolateAtArcLength, reorderContourFromOrigin, computeAllSubdivisionFrames, signedArea, ensureConsistentOrientation } from '../../utils/curvilinearContour'
import { detectGlobalCurvatureExtrema, type CSSCandidate } from '../../utils/curvatureScaleSpace'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
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

// Build ordered contour: interleave anchors + subdivision points
function buildOrderedContour(
  anchors: Point2D[],
  subdivPoints: Point2D[],
  params: CurvilinearParam[]
): Point2D[] {
  const ordered: Point2D[] = []
  const numAnchors = anchors.length
  for (let i = 0; i < numAnchors; i++) {
    ordered.push(anchors[i])
    const segPoints: { t: number; point: Point2D }[] = []
    for (let j = 0; j < params.length; j++) {
      if (params[j].segmentIndex === i) {
        segPoints.push({ t: params[j].t, point: subdivPoints[j] })
      }
    }
    segPoints.sort((a, b) => a.t - b.t)
    for (const sp of segPoints) {
      ordered.push(sp.point)
    }
  }
  return ordered
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

  // Full contour preview state
  const [showFullContour, setShowFullContour] = useState(false)
  const [computingSubdiv, setComputingSubdiv] = useState(false)
  const subdivFramesRef = useRef<Point2D[][] | null>(null)

  // Drag state
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [hasEdited, setHasEdited] = useState(false)
  const editedIndicesRef = useRef<Set<number>>(new Set())
  const [propagating, setPropagating] = useState(false)

  // Snap extremum courbure
  const [snapExtrema, setSnapExtrema] = useState(false)
  const extremaCacheRef = useRef<Map<number, CSSCandidate[]>>(new Map())

  // Contour animation preview (validated phase)
  const [contourAnimActive, setContourAnimActive] = useState(false)
  const [contourAnimComputing, setContourAnimComputing] = useState(false)
  const [contourAnimFrame, setContourAnimFrame] = useState(0)
  const [contourAnimPlaying, setContourAnimPlaying] = useState(false)
  const contourAnimCanvasRef = useRef<HTMLCanvasElement>(null)
  const contourAnimVideoRef = useRef<HTMLVideoElement | null>(null)
  const contourAnimSubdivRef = useRef<Point2D[][] | null>(null)
  const contourAnimDimsRef = useRef<{ w: number; h: number } | null>(null)
  const contourAnimTotalRef = useRef(0)
  const contourAnimAnimRef = useRef<number>(0)

  // Extrema tracking constants
  const N_EXTREMA = 20

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
    extremaCacheRef.current.clear()
    setPhase('computing')
    setProgress(`Initialisation... (mode ${stepByStep ? 'proche en proche' : 'fixe'})`)

    try {
      const contourAnchors = mesh.contourAnchors
      const originFrames = mesh.contourOriginFrames!
      const cannyParams = mesh.cannyParams!

      // Check for cached Canny contours from step 6
      const cachedCanny = mesh.contourCannyFrames
      const useCache = !!(cachedCanny && cachedCanny.length > 0)

      if (!useCache) {
        await loadOpenCVWorker()
      }

      // 1. Get image dimensions
      const img = await loadImage(project.originalImageBlob!)
      const iw = img.naturalWidth, ih = img.naturalHeight
      imageDimsRef.current = { w: iw, h: ih }

      // 2. Get ordered contour for frame 0
      let ordered0: Point2D[]
      if (useCache && cachedCanny[0] && cachedCanny[0].length > 0) {
        ordered0 = cachedCanny[0]
      } else {
        const canvas0 = document.createElement('canvas')
        canvas0.width = iw; canvas0.height = ih
        const ctx0 = canvas0.getContext('2d')!
        ctx0.drawImage(img, 0, 0)
        const imgData0 = ctx0.getImageData(0, 0, iw, ih)
        const cannyPts0 = await flowCannyContour(imgData0, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)
        if (!cannyPts0 || cannyPts0.length < 10) {
          setProgress('Erreur: contour Canny non détecté sur l\'image originale')
          setPhase('ready')
          URL.revokeObjectURL(img.src)
          return
        }
        // cannyPts0 are already ordered by OpenCV's findContours
        ordered0 = cannyPts0
        if (mesh.contourOrigin) {
          ordered0 = reorderContourFromOrigin(ordered0, mesh.contourOrigin)
        }
      }
      URL.revokeObjectURL(img.src)

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

      // 2b. No longer needed: extrema are detected per-frame and matched by arc-length

      // 3. Get total frames
      let totalFrames: number
      let video: HTMLVideoElement | null = null
      let vCanvas: HTMLCanvasElement | null = null
      let vCtx: CanvasRenderingContext2D | null = null
      let vw = 0, vh = 0
      let url = ''

      if (useCache) {
        totalFrames = cachedCanny.length
        setProgress(`Mode cache: ${totalFrames} frames (skip Canny)`)
      } else {
        url = URL.createObjectURL(project.videoBlob!)
        video = document.createElement('video')
        video.src = url
        video.muted = true
        video.preload = 'auto'
        await new Promise<void>(r => { video!.onloadeddata = () => r(); video!.load() })
        vw = video.videoWidth; vh = video.videoHeight
        totalFrames = Math.floor(video.duration * 24)
        vCanvas = document.createElement('canvas')
        vCanvas.width = vw; vCanvas.height = vh
        vCtx = vCanvas.getContext('2d')!
      }

      // Reference orientation from frame 0
      const referenceOrientation = signedArea(ordered0)

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

      const t0 = performance.now()

      // 5. Process each frame
      for (let f = 1; f < totalFrames; f++) {
        if (f % 5 === 0 || f === 1) {
          setProgress(useCache
            ? `Frame ${f}/${totalFrames} (cache)`
            : `Frame ${f}/${totalFrames}`)
          await new Promise(r => setTimeout(r, 0))
        }

        let ordered: Point2D[] | null = null

        if (useCache) {
          // Use cached ordered contour
          ordered = cachedCanny[f]
        } else {
          // Seek + detect Canny
          video!.currentTime = f / 24
          await new Promise<void>(r => { video!.onseeked = () => r() })
          vCtx!.drawImage(video!, 0, 0)
          const imageData = vCtx!.getImageData(0, 0, vw, vh)
          const cannyPts = await flowCannyContour(imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)

          if (cannyPts && cannyPts.length >= 10) {
            // cannyPts already ordered by OpenCV's findContours — just scale
            ordered = cannyPts.map(p => ({ x: (p.x / vw) * iw, y: (p.y / vh) * ih }))
            const p0Frame = originFrames[f]?.[0]
            if (p0Frame) {
              ordered = reorderContourFromOrigin(ordered, p0Frame)
            }
            ordered = ensureConsistentOrientation(ordered, referenceOrientation)
          }
        }

        if (!ordered || ordered.length < 10) {
          allFrames.push([...allFrames[f - 1]])
          allRawFrames.push([...allRawFrames[f - 1]])
          allLostFlags.push(contourAnchors.map(() => true))
          allCannyFrames.push([])
          continue
        }

        const arcLengths = computeArcLengths(ordered)
        const totalLen = arcLengths[arcLengths.length - 1] || 1
        allCannyFrames.push(ordered)

        // Build spatial index for O(1) nearest-neighbor lookups
        const contourIdx = new ContourSpatialIndex(ordered)
        const p0Frame = originFrames[f]?.[0]

        // Detect global curvature extrema for this frame
        const frameExtrema = detectGlobalCurvatureExtrema(ordered, N_EXTREMA)

        // Place each anchor, then snap to nearest extremum by arc-length
        const rawPositions: Point2D[] = []
        const adjustedPositions: Point2D[] = []
        const frameLostFlags: boolean[] = []

        for (let a = 0; a < contourAnchors.length; a++) {
          if (a === 0 && p0Frame) {
            rawPositions.push(p0Frame)
            adjustedPositions.push(p0Frame)
            frameLostFlags.push(false)
            if (stepByStep) {
              const snap = contourIdx.nearestWithIndex(p0Frame, 50)
              if (snap) anchorS[a] = arcLengths[snap.index] / totalLen
            }
            continue
          }

          const rawPos = interpolateAtArcLength(ordered, arcLengths, anchorS[a])
          rawPositions.push(rawPos)

          // Snap to nearest global extremum by arc-length (circular distance)
          if (frameExtrema.length > 0) {
            let bestExt = frameExtrema[0]
            let bestArcDist = Infinity
            for (const ext of frameExtrema) {
              let d = Math.abs(ext.arcLengthNorm - anchorS[a])
              if (d > 0.5) d = 1 - d
              if (d < bestArcDist) { bestArcDist = d; bestExt = ext }
            }
            adjustedPositions.push(bestExt.position)
            frameLostFlags.push(false)
            if (stepByStep) {
              anchorS[a] = bestExt.arcLengthNorm
            }
          } else {
            adjustedPositions.push(rawPos)
            frameLostFlags.push(true)
          }
        }

        // Re-snap all non-lost points onto nearest Canny pixel
        for (let a = 0; a < adjustedPositions.length; a++) {
          if (frameLostFlags[a]) continue
          const snap = contourIdx.nearestWithIndex(adjustedPositions[a], 50)
          if (snap) {
            adjustedPositions[a] = snap.point
            if (stepByStep) {
              anchorS[a] = arcLengths[snap.index] / totalLen
            }
          }
        }

        allFrames.push(adjustedPositions)
        allRawFrames.push(rawPositions)
        allLostFlags.push(frameLostFlags)
      }

      if (url) URL.revokeObjectURL(url)

      console.log(`[ContourTracking] ${totalFrames} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s (${useCache ? 'cached' : 'live Canny'})`)

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
      editedIndicesRef.current.clear()
      setPreviewFrame(0)
      setPhase('preview')
      setProgress('')
    } catch (err) {
      console.error('Contour tracking failed:', err)
      setProgress(`Erreur: ${err instanceof Error ? err.message : String(err)}`)
      setPhase('ready')
    }
  }, [ready, mesh, project])

  const handleComputeStepByStep = useCallback(() => runCompute(true), [runCompute])

  // ─── Extrema cache helper ────────────────────────────────────────
  const getExtremaForFrame = useCallback((frame: number): CSSCandidate[] => {
    const cache = extremaCacheRef.current
    if (cache.has(frame)) return cache.get(frame)!
    const cannyPts = cannyFramesRef.current?.[frame]
    if (!cannyPts || cannyPts.length < 10) return []
    const extrema = detectGlobalCurvatureExtrema(cannyPts, N_EXTREMA)
    cache.set(frame, extrema)
    return extrema
  }, [])

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

    // Draw curvature extrema (perpendicular ticks) when snap mode is active
    if (snapExtrema && cannyPts && cannyPts.length > 10) {
      const extrema = getExtremaForFrame(frame)
      ctx.strokeStyle = 'rgba(255, 0, 255, 0.9)'
      ctx.lineWidth = 2
      const halfLen = 12 // half-length of tick in canvas px
      for (let ei = 0; ei < extrema.length; ei++) {
        const ext = extrema[ei]
        // Find nearest contour pixel index to compute local tangent
        const ep = ext.position
        let bestIdx = 0, bestDist = Infinity
        for (let i = 0; i < cannyPts.length; i++) {
          const d = Math.hypot(cannyPts[i].x - ep.x, cannyPts[i].y - ep.y)
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        // Tangent from neighbors (wrap for closed contour)
        const n = cannyPts.length
        const prev = cannyPts[(bestIdx - 3 + n) % n]
        const next = cannyPts[(bestIdx + 3) % n]
        let tx = (next.x - prev.x) * scaleX
        let ty = (next.y - prev.y) * scaleY
        const tLen = Math.hypot(tx, ty)
        if (tLen < 0.01) continue
        // Perpendicular = (-ty, tx) normalized
        const nx = -ty / tLen
        const ny = tx / tLen
        const ex = ep.x * scaleX
        const ey = ep.y * scaleY
        ctx.beginPath()
        ctx.moveTo(ex - nx * halfLen, ey - ny * halfLen)
        ctx.lineTo(ex + nx * halfLen, ey + ny * halfLen)
        ctx.stroke()

        // Label: rank by |κ| (1 = strongest), in line with the tick
        const label = `${ei + 1}`
        ctx.fillStyle = 'rgba(255, 0, 255, 0.9)'
        ctx.font = 'bold 11px sans-serif'
        const labelOffset = halfLen + 4
        const lx = ex + nx * labelOffset
        const ly = ey + ny * labelOffset
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, lx, ly)
        ctx.textAlign = 'start'
        ctx.textBaseline = 'alphabetic'
      }
    }

    // Full contour mode: draw ordered polygon (anchors + subdivision)
    const subdivData = subdivFramesRef.current
    const subdivParams = mesh?.contourSubdivisionParams
    if (showFullContour && subdivData && subdivData[frame] && subdivParams) {
      const subdivPts = subdivData[frame]
      const orderedContour = buildOrderedContour(frameData, subdivPts, subdivParams)

      // Draw full contour polygon (yellow)
      if (orderedContour.length >= 3) {
        ctx.beginPath()
        ctx.moveTo(orderedContour[0].x * scaleX, orderedContour[0].y * scaleY)
        for (let i = 1; i < orderedContour.length; i++) {
          ctx.lineTo(orderedContour[i].x * scaleX, orderedContour[i].y * scaleY)
        }
        ctx.closePath()
        ctx.strokeStyle = 'rgba(255, 220, 50, 0.8)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Draw subdivision points (green, smaller)
      for (let i = 0; i < subdivPts.length; i++) {
        const sx = subdivPts[i].x * scaleX
        const sy = subdivPts[i].y * scaleY
        ctx.beginPath()
        ctx.arc(sx, sy, 4, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(50, 200, 50, 0.8)'
        ctx.fill()
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 1
        ctx.stroke()
      }

      // Draw anchor points (red, larger)
      for (let i = 0; i < frameData.length; i++) {
        const cx = frameData[i].x * scaleX
        const cy = frameData[i].y * scaleY
        const isLost = lostFlags?.[i] ?? false

        ctx.beginPath()
        ctx.arc(cx, cy, 6, 0, Math.PI * 2)
        ctx.fillStyle = isLost ? 'rgba(255, 160, 0, 0.9)' : 'rgba(220, 50, 50, 0.9)'
        ctx.fill()
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 1.5
        ctx.stroke()

        ctx.fillStyle = 'white'
        ctx.font = 'bold 10px sans-serif'
        ctx.fillText(`A${i}`, cx + 8, cy - 4)
      }
    } else {
      // Anchors-only mode (original behavior)

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

        ctx.fillStyle = 'white'
        ctx.font = 'bold 10px sans-serif'
        ctx.fillText(`${i}${isLost ? '?' : ''}`, cx + 8, cy - 4)
      }
    }
  }, [showFullContour, mesh, snapExtrema, getExtremaForFrame])

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

    // Update position in image coords, snapped to nearest Canny pixel or extremum
    const imgX = cx / scaleX
    const imgY = cy / scaleY

    if (snapExtrema) {
      // Snap to nearest curvature extremum
      const extrema = getExtremaForFrame(previewFrame)
      let bestDist = 50
      let bestPoint: Point2D | null = null
      for (const ext of extrema) {
        const d = Math.hypot(imgX - ext.position.x, imgY - ext.position.y)
        if (d < bestDist) { bestDist = d; bestPoint = ext.position }
      }
      computed[previewFrame][draggingIdx] = bestPoint ? { ...bestPoint } : { x: imgX, y: imgY }
    } else {
      const cannyPts = cannyFramesRef.current?.[previewFrame]
      if (cannyPts && cannyPts.length > 0) {
        // Snap: find nearest Canny pixel using spatial index
        const dragIdx = new ContourSpatialIndex(cannyPts)
        const snap = dragIdx.nearest({ x: imgX, y: imgY }, 50)
        if (snap) {
          computed[previewFrame][draggingIdx] = { ...snap.point }
        } else {
          computed[previewFrame][draggingIdx] = { x: imgX, y: imgY }
        }
      } else {
        computed[previewFrame][draggingIdx] = { x: imgX, y: imgY }
      }
    }

    // Also clear lost flag for this point
    if (lostFlagsRef.current?.[previewFrame]) {
      lostFlagsRef.current[previewFrame][draggingIdx] = false
    }
    setHasEdited(true)
    editedIndicesRef.current.add(draggingIdx)
    drawPreview(previewFrame)
  }, [draggingIdx, previewFrame, drawPreview, snapExtrema, getExtremaForFrame])

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
    const editedIndices = new Set(editedIndicesRef.current)
    const contourAnchors = mesh.contourAnchors
    const selectiveMode = editedIndices.size > 0 && editedIndices.size < contourAnchors.length

    setPropagating(true)
    setPlaying(false)
    setShowFullContour(false)
    subdivFramesRef.current = null

    const editedList = [...editedIndices]
    setProgress(selectiveMode
      ? `Propagation selective (point${editedList.length > 1 ? 's' : ''} ${editedList.join(', ')}) depuis frame ${startFrame + 1}...`
      : `Propagation depuis frame ${startFrame + 1}...`)

    try {
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

      if (startCannyPts && startCannyPts.length >= 10) {
        // startCannyPts already ordered by OpenCV — just scale
        let ordered = startCannyPts.map(p => ({ x: (p.x / vw) * iw, y: (p.y / vh) * ih }))
        const p0Frame = originFrames[startFrame]?.[0]
        if (p0Frame) ordered = reorderContourFromOrigin(ordered, p0Frame)
        const arcLengths = computeArcLengths(ordered)
        const totalLen = arcLengths[arcLengths.length - 1] || 1

        // Compute anchorS from positions using spatial index
        const startContourIdx = new ContourSpatialIndex(ordered)
        for (let a = 0; a < contourAnchors.length; a++) {
          const snap = startContourIdx.nearestWithIndex(editedPositions[a], 50)
          if (snap) anchorS[a] = arcLengths[snap.index] / totalLen
        }

      }

      // Process frames from startFrame+1 to end
      for (let f = startFrame + 1; f < totalFrames; f++) {
        if (f % 5 === 0) {
          setProgress(selectiveMode
            ? `Propagation selective (point${editedList.length > 1 ? 's' : ''} ${editedList.join(', ')}) frame ${f}/${totalFrames}`
            : `Propagation frame ${f}/${totalFrames}`)
          await new Promise(r => setTimeout(r, 0))
        }

        video.currentTime = f / 24
        await new Promise<void>(r => { video.onseeked = () => r() })
        vCtx.drawImage(video, 0, 0)
        const imageData = vCtx.getImageData(0, 0, vw, vh)

        const cannyPts = await flowCannyContour(imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize)

        if (!cannyPts || cannyPts.length < 10) {
          if (selectiveMode) {
            // Only overwrite edited anchors with previous frame fallback
            for (const a of editedIndices) {
              computedFramesRef.current[f][a] = { ...computedFramesRef.current[f - 1][a] }
              rawFramesRef.current![f][a] = { ...rawFramesRef.current![f - 1][a] }
              lostFlagsRef.current[f][a] = true
            }
          } else {
            computedFramesRef.current[f] = [...computedFramesRef.current[f - 1]]
            rawFramesRef.current![f] = [...rawFramesRef.current![f - 1]]
            lostFlagsRef.current[f] = contourAnchors.map(() => true)
          }
          if (cannyFramesRef.current) cannyFramesRef.current[f] = []
          continue
        }

        // cannyPts already ordered by OpenCV — just scale
        let ordered = cannyPts.map(p => ({ x: (p.x / vw) * iw, y: (p.y / vh) * ih }))
        const p0Frame = originFrames[f]?.[0]
        if (p0Frame) ordered = reorderContourFromOrigin(ordered, p0Frame)
        const arcLengths = computeArcLengths(ordered)
        const totalLen = arcLengths[arcLengths.length - 1] || 1
        if (cannyFramesRef.current) cannyFramesRef.current[f] = ordered

        // Build spatial index for O(1) nearest-neighbor lookups
        const contourIdx = new ContourSpatialIndex(ordered)

        // Detect global curvature extrema for this frame
        const frameExtrema = detectGlobalCurvatureExtrema(ordered, N_EXTREMA)

        // Initialize arrays from existing data (selective) or empty (full)
        const rawPositions: Point2D[] = selectiveMode
          ? [...(rawFramesRef.current![f] ?? rawFramesRef.current![f - 1])]
          : new Array(contourAnchors.length)
        const adjustedPositions: Point2D[] = selectiveMode
          ? [...(computedFramesRef.current[f] ?? computedFramesRef.current[f - 1])]
          : new Array(contourAnchors.length)
        const frameLostFlags: boolean[] = selectiveMode
          ? [...(lostFlagsRef.current[f] ?? contourAnchors.map(() => false))]
          : new Array(contourAnchors.length)

        for (let a = 0; a < contourAnchors.length; a++) {
          // Skip non-edited anchors in selective mode
          if (selectiveMode && !editedIndices.has(a)) {
            if (stepByStep) {
              const snap = contourIdx.nearestWithIndex(adjustedPositions[a], 50)
              if (snap) anchorS[a] = arcLengths[snap.index] / totalLen
            }
            continue
          }

          if (a === 0 && p0Frame) {
            rawPositions[a] = p0Frame
            adjustedPositions[a] = p0Frame
            frameLostFlags[a] = false
            if (stepByStep) {
              const snap = contourIdx.nearestWithIndex(p0Frame, 50)
              if (snap) anchorS[a] = arcLengths[snap.index] / totalLen
            }
            continue
          }

          const rawPos = interpolateAtArcLength(ordered, arcLengths, anchorS[a])
          rawPositions[a] = rawPos

          // Snap to nearest global extremum by arc-length
          if (frameExtrema.length > 0) {
            let bestExt = frameExtrema[0]
            let bestArcDist = Infinity
            for (const ext of frameExtrema) {
              let d = Math.abs(ext.arcLengthNorm - anchorS[a])
              if (d > 0.5) d = 1 - d
              if (d < bestArcDist) { bestArcDist = d; bestExt = ext }
            }
            adjustedPositions[a] = bestExt.position
            frameLostFlags[a] = false
            if (stepByStep) {
              anchorS[a] = bestExt.arcLengthNorm
            }
          } else {
            adjustedPositions[a] = rawPos
            frameLostFlags[a] = true
          }
        }

        // Re-snap non-lost points onto nearest Canny pixel
        for (let a = 0; a < adjustedPositions.length; a++) {
          if (frameLostFlags[a]) continue
          if (selectiveMode && !editedIndices.has(a)) continue
          const snap = contourIdx.nearestWithIndex(adjustedPositions[a], 50)
          if (snap) {
            adjustedPositions[a] = snap.point
            if (stepByStep) {
              anchorS[a] = arcLengths[snap.index] / totalLen
            }
          }
        }

        computedFramesRef.current[f] = adjustedPositions
        rawFramesRef.current![f] = rawPositions
        lostFlagsRef.current[f] = frameLostFlags
      }

      URL.revokeObjectURL(url)

      // Log stats
      const lostCounts = contourAnchors.map((_, a) =>
        lostFlagsRef.current!.slice(startFrame).reduce((sum, flags) => sum + (flags[a] ? 1 : 0), 0)
      )
      console.log(`Propagation${selectiveMode ? ` selective (points ${editedList.join(', ')})` : ''} from frame ${startFrame} — lost frames per anchor:`, lostCounts)

      setHasEdited(false)
      editedIndicesRef.current.clear()
      setProgress('')
      drawPreview(previewFrame)
    } catch (err) {
      console.error('Propagation failed:', err)
      setProgress(`Erreur propagation: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPropagating(false)
    }
  }, [mesh, project, previewFrame, drawPreview])

  // ─── Full contour preview (anchors + subdivision) ──────────────
  const handleComputeFullContour = useCallback(async () => {
    if (!mesh || !computedFramesRef.current || !project.videoBlob || !project.originalImageBlob) return
    const params = mesh.contourSubdivisionParams
    if (!params || params.length === 0 || !mesh.cannyParams) return

    setComputingSubdiv(true)
    setProgress('Calcul subdivision contour...')

    try {
      // Ensure image dimensions are available
      let imgDims = imageDimsRef.current
      if (!imgDims) {
        const img = await loadImage(project.originalImageBlob)
        imgDims = { w: img.naturalWidth, h: img.naturalHeight }
        imageDimsRef.current = imgDims
        URL.revokeObjectURL(img.src)
      }

      await loadOpenCVWorker()
      const subdivResult = await computeAllSubdivisionFrames(
        project.videoBlob,
        computedFramesRef.current,
        params,
        mesh.cannyParams,
        imgDims.w,
        imgDims.h,
        (p) => setProgress(`Subdivision frame ${p.frame}/${p.total}`),
        mesh.contourOriginFrames,
        cannyFramesRef.current
      )
      subdivFramesRef.current = subdivResult.subdivisionFrames
      setShowFullContour(true)
      setProgress('')
    } catch (err) {
      console.error('Subdivision computation failed:', err)
      setProgress(`Erreur subdivision: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setComputingSubdiv(false)
    }
  }, [mesh, project])

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
        // Save Canny cache for downstream reuse
        contourCannyFrames: cannyFramesRef.current,
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
    subdivFramesRef.current = null
    totalFramesRef.current = 0
    setPlaying(false)
    setPreviewFrame(0)
    setShowFullContour(false)
    editedIndicesRef.current.clear()
    extremaCacheRef.current.clear()

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

  // ─── Re-edit (validated → preview without reset) ────────────────
  const handleReEdit = useCallback(async () => {
    if (!mesh?.contourAnchorFrames || !project.videoBlob || !project.originalImageBlob) return
    setSaving(true)
    setProgress('Chargement pour réédition...')

    try {
      // Load image dimensions
      const img = await loadImage(project.originalImageBlob)
      imageDimsRef.current = { w: img.naturalWidth, h: img.naturalHeight }
      URL.revokeObjectURL(img.src)

      // Reload saved frames into refs
      const frames = mesh.contourAnchorFrames
      computedFramesRef.current = frames.map(f => [...f])
      rawFramesRef.current = frames.map(f => [...f])
      lostFlagsRef.current = frames.map(f => f.map(() => false))
      totalFramesRef.current = frames.length

      // Load cached Canny contours if available
      cannyFramesRef.current = mesh.contourCannyFrames ?? frames.map(() => [])

      // Subdivision data not loaded (will be recomputed on demand)
      subdivFramesRef.current = null
      setShowFullContour(false)

      // Create video for preview
      const previewUrl = URL.createObjectURL(project.videoBlob)
      const previewVideo = document.createElement('video')
      previewVideo.src = previewUrl
      previewVideo.muted = true
      previewVideo.preload = 'auto'
      await new Promise<void>(r => { previewVideo.onloadeddata = () => r(); previewVideo.load() })
      videoRef.current = previewVideo

      // Stop contour anim if active
      if (contourAnimVideoRef.current) {
        URL.revokeObjectURL(contourAnimVideoRef.current.src)
        contourAnimVideoRef.current = null
      }
      setContourAnimActive(false)
      setContourAnimPlaying(false)

      setHasEdited(false)
      editedIndicesRef.current.clear()
      setPreviewFrame(0)
      setPhase('preview')
      setProgress('')
    } catch (err) {
      console.error('Re-edit load failed:', err)
      setProgress(`Erreur: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [mesh, project])

  // ─── Contour Animation Preview (validated phase) ────────────────
  const handleStartContourAnim = useCallback(async () => {
    if (!mesh?.contourAnchorFrames || !project.videoBlob || !project.originalImageBlob) return
    setContourAnimComputing(true)
    setProgress('Chargement video + image...')

    try {
      // Load image dimensions
      const img = await loadImage(project.originalImageBlob)
      const imgDims = { w: img.naturalWidth, h: img.naturalHeight }
      contourAnimDimsRef.current = imgDims
      URL.revokeObjectURL(img.src)

      // Load video
      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.src = URL.createObjectURL(project.videoBlob)
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error('Video load failed'))
      })
      contourAnimVideoRef.current = video
      contourAnimTotalRef.current = Math.round(video.duration * 24)

      // Compute subdivision frames if needed
      const params = mesh.contourSubdivisionParams
      if (params && params.length > 0 && mesh.cannyParams) {
        setProgress('Calcul subdivision contour...')
        await loadOpenCVWorker()
        const subdivResult = await computeAllSubdivisionFrames(
          project.videoBlob,
          mesh.contourAnchorFrames,
          params,
          mesh.cannyParams,
          imgDims.w,
          imgDims.h,
          (p) => setProgress(`Subdivision frame ${p.frame}/${p.total}`),
          mesh.contourOriginFrames,
          mesh.contourCannyFrames
        )
        contourAnimSubdivRef.current = subdivResult.subdivisionFrames
      }

      setContourAnimFrame(0)
      setContourAnimActive(true)
      setProgress('')
    } catch (err) {
      console.error('Contour anim preview failed:', err)
      setProgress(`Erreur: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setContourAnimComputing(false)
    }
  }, [mesh, project])

  const drawContourAnimFrame = useCallback(async (frame: number) => {
    const canvas = contourAnimCanvasRef.current
    const video = contourAnimVideoRef.current
    const imgDims = contourAnimDimsRef.current
    const anchorFrames = mesh?.contourAnchorFrames
    if (!canvas || !video || !imgDims || !anchorFrames) return

    const ctx = canvas.getContext('2d')!

    // Seek video
    video.currentTime = frame / 24
    await new Promise<void>(r => { video.onseeked = () => r() })

    // Fit canvas
    const maxW = canvas.parentElement?.clientWidth ?? 800
    const vw = video.videoWidth, vh = video.videoHeight
    const displayScale = Math.min(maxW / vw, 600 / vh, 1)
    canvas.width = Math.round(vw * displayScale)
    canvas.height = Math.round(vh * displayScale)

    // Draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const frameData = anchorFrames[frame]
    if (!frameData) return

    const scaleX = canvas.width / imgDims.w
    const scaleY = canvas.height / imgDims.h

    const subdivData = contourAnimSubdivRef.current
    const subdivParams = mesh?.contourSubdivisionParams

    if (subdivData && subdivData[frame] && subdivParams) {
      const subdivPts = subdivData[frame]
      const orderedContour = buildOrderedContour(frameData, subdivPts, subdivParams)

      // Draw full contour polygon (yellow)
      if (orderedContour.length >= 3) {
        ctx.beginPath()
        ctx.moveTo(orderedContour[0].x * scaleX, orderedContour[0].y * scaleY)
        for (let i = 1; i < orderedContour.length; i++) {
          ctx.lineTo(orderedContour[i].x * scaleX, orderedContour[i].y * scaleY)
        }
        ctx.closePath()
        ctx.strokeStyle = 'rgba(255, 220, 50, 0.8)'
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Draw subdivision points (green)
      for (let i = 0; i < subdivPts.length; i++) {
        const sx = subdivPts[i].x * scaleX
        const sy = subdivPts[i].y * scaleY
        ctx.beginPath()
        ctx.arc(sx, sy, 4, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(50, 200, 50, 0.8)'
        ctx.fill()
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    } else {
      // Anchors-only polygon (blue)
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
    }

    // Draw anchor points (red)
    for (let i = 0; i < frameData.length; i++) {
      const cx = frameData[i].x * scaleX
      const cy = frameData[i].y * scaleY
      ctx.beginPath()
      ctx.arc(cx, cy, 6, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(220, 50, 50, 0.9)'
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.fillStyle = 'white'
      ctx.font = 'bold 10px sans-serif'
      ctx.fillText(`A${i}`, cx + 8, cy - 4)
    }
  }, [mesh])

  // Draw contour anim on frame change
  useEffect(() => {
    if (contourAnimActive && phase === 'validated') {
      drawContourAnimFrame(contourAnimFrame)
    }
  }, [contourAnimActive, contourAnimFrame, phase, drawContourAnimFrame])

  // Playback loop for contour animation
  useEffect(() => {
    if (!contourAnimPlaying || phase !== 'validated') return

    let lastTime = 0
    const step = (time: number) => {
      if (time - lastTime >= 1000 / 24) {
        lastTime = time
        setContourAnimFrame(f => {
          const next = f + 1
          if (next >= contourAnimTotalRef.current) {
            setContourAnimPlaying(false)
            return 0
          }
          return next
        })
      }
      contourAnimAnimRef.current = requestAnimationFrame(step)
    }
    contourAnimAnimRef.current = requestAnimationFrame(step)

    return () => cancelAnimationFrame(contourAnimAnimRef.current)
  }, [contourAnimPlaying, phase])

  const handleStopContourAnim = useCallback(() => {
    setContourAnimPlaying(false)
    setContourAnimActive(false)
    setContourAnimFrame(0)
    if (contourAnimVideoRef.current) {
      URL.revokeObjectURL(contourAnimVideoRef.current.src)
      contourAnimVideoRef.current = null
    }
    contourAnimSubdivRef.current = null
  }, [])

  // ─── Cleanup ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (videoRef.current) {
        URL.revokeObjectURL(videoRef.current.src)
      }
      cancelAnimationFrame(animRef.current)
      if (contourAnimVideoRef.current) {
        URL.revokeObjectURL(contourAnimVideoRef.current.src)
      }
      cancelAnimationFrame(contourAnimAnimRef.current)
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
          <p>{mesh!.contourAnchors.length} anchors contour à tracker.</p>
          <button className="btn-primary" onClick={handleComputeStepByStep}>
            Tracking Contour
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
            <label style={{ marginLeft: 16, fontSize: '0.85em', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={snapExtrema}
                onChange={e => setSnapExtrema(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              Snap extremum courbure
            </label>
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
            style={{ maxWidth: '100%', background: 'var(--color-bg)', cursor: draggingIdx !== null ? 'grabbing' : 'default' }}
            onMouseDown={handleCanvasMouseDown}
            onMouseMove={handleCanvasMouseMove}
            onMouseUp={handleCanvasMouseUp}
            onMouseLeave={handleCanvasMouseUp}
          />

          <div className="preview-legend" style={{ fontSize: '0.85em', marginTop: 8, color: 'var(--color-text-secondary)' }}>
            {showFullContour ? (
              <>
                <span style={{ color: 'rgba(255,255,0,0.6)' }}>● Jaune</span> = contour Canny
                {' | '}
                <span style={{ color: 'rgba(255,220,50,0.8)' }}>— Jaune</span> = polygone complet
                {' | '}
                <span style={{ color: 'rgba(220,50,50,0.9)' }}>● Rouge</span> = anchors
                {' | '}
                <span style={{ color: 'rgba(50,200,50,0.8)' }}>● Vert</span> = subdivision
              </>
            ) : (
              <>
                <span style={{ color: 'rgba(255,255,0,0.6)' }}>● Jaune</span> = contour Canny
                {' | '}
                <span style={{ color: 'rgba(80,140,255,0.8)' }}>— Bleu</span> = polygone anchors
                {' | '}
                <span style={{ color: 'rgba(180,180,180,0.8)' }}>● Gris</span> = position brute (s)
                {' | '}
                <span style={{ color: 'rgba(50,220,50,0.9)' }}>● Vert</span> = snap extremum
                {' | '}
                <span style={{ color: 'rgba(255,160,0,0.9)' }}>● Orange</span> = perdu
                {snapExtrema && (
                  <>
                    {' | '}
                    <span style={{ color: 'rgba(255, 0, 255, 0.9)' }}>| Magenta</span> = extrema courbure
                  </>
                )}
                <br />
                Glissez un point pour le repositionner, puis cliquez "Propager avant".
              </>
            )}
          </div>

          {/* Edit actions */}
          <div style={{ marginTop: 12 }}>
            {hasEdited && !showFullContour && (
              <button
                className="btn-secondary"
                onClick={() => {
                  editedIndicesRef.current.clear()
                  setHasEdited(false)
                }}
                disabled={propagating || playing}
                style={{ marginRight: 8 }}
              >
                Appliquer edits (frame courante)
              </button>
            )}
            <button
              className="btn-secondary"
              onClick={handlePropagate}
              disabled={propagating || playing || showFullContour}
              style={{ marginRight: 8 }}
            >
              {propagating ? 'Propagation...' : `Propager avant (depuis frame ${previewFrame + 1})`}
            </button>
            {hasEdited && !showFullContour && (
              <span style={{ color: '#ffa000', fontSize: '0.85em' }}>
                {editedIndicesRef.current.size > 0
                  ? `Point${editedIndicesRef.current.size > 1 ? 's' : ''} ${[...editedIndicesRef.current].join(', ')} edite${editedIndicesRef.current.size > 1 ? 's' : ''}`
                  : 'Points edites'}
              </span>
            )}
            {propagating && <p style={{ marginTop: 4, fontSize: '0.85em', color: 'var(--color-text-secondary)' }}>{progress}</p>}
          </div>

          {/* Full contour preview */}
          {mesh?.contourSubdivisionParams && mesh.contourSubdivisionParams.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {!showFullContour ? (
                <button
                  className="btn-secondary"
                  onClick={handleComputeFullContour}
                  disabled={computingSubdiv || propagating || playing}
                >
                  {computingSubdiv ? 'Calcul subdivision...' : 'Preview contour complet'}
                </button>
              ) : (
                <button
                  className="btn-secondary"
                  onClick={() => setShowFullContour(false)}
                >
                  Preview anchors seuls
                </button>
              )}
              {computingSubdiv && <p style={{ marginTop: 4, fontSize: '0.85em', color: 'var(--color-text-secondary)' }}>{progress}</p>}
            </div>
          )}

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

          {/* Contour animation preview */}
          {!contourAnimActive ? (
            <button
              className="btn-secondary"
              onClick={handleStartContourAnim}
              disabled={saving || contourAnimComputing}
              style={{ marginTop: 8 }}
            >
              {contourAnimComputing ? 'Chargement...' : 'Preview Animation Contour'}
            </button>
          ) : (
            <div style={{ marginTop: 12 }}>
              <div className="step-actions" style={{ marginBottom: 8 }}>
                <button className="btn-secondary" onClick={() => setContourAnimPlaying(!contourAnimPlaying)}>
                  {contourAnimPlaying ? 'Pause' : 'Play'}
                </button>
                <button className="btn-secondary" onClick={() => { setContourAnimPlaying(false); setContourAnimFrame(0) }}>
                  Debut
                </button>
                <button className="btn-secondary" onClick={handleStopContourAnim}>
                  Fermer
                </button>
              </div>
              <input
                type="range"
                min={0}
                max={contourAnimTotalRef.current - 1}
                value={contourAnimFrame}
                onChange={e => { setContourAnimPlaying(false); setContourAnimFrame(Number(e.target.value)) }}
                style={{ width: '100%' }}
              />
              <p style={{ fontSize: '0.85em', color: 'var(--color-text-secondary)', margin: '4px 0' }}>
                Frame {contourAnimFrame + 1} / {contourAnimTotalRef.current}
              </p>
              <canvas ref={contourAnimCanvasRef} style={{ width: '100%', border: '1px solid #444', borderRadius: 4 }} />
            </div>
          )}
          {contourAnimComputing && <p style={{ marginTop: 4, fontSize: '0.85em', color: 'var(--color-text-secondary)' }}>{progress}</p>}

          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button
              className="btn-primary"
              onClick={handleReEdit}
              disabled={saving || contourAnimComputing}
            >
              {saving ? 'Chargement...' : 'Reediter frame par frame'}
            </button>
            <button
              className="btn-secondary"
              onClick={handleReset}
              disabled={saving || contourAnimComputing}
            >
              Reinitialiser depuis zero
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
