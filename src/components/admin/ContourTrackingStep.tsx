import { useState, useRef, useCallback, useEffect } from 'react'
import type { Project, Point2D, MeshData, KeyframeData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import type { TrackingConstraintParams } from '../../utils/opticalFlowComputer'
import { precomputeOpticalFlow, trackSegment } from '../../utils/opticalFlowComputer'
import { extractKeyframes, propagateKeyframes } from '../../utils/keyframePropagation'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { computeAllSubdivisionFrames } from '../../utils/curvilinearContour'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'
import KeyframeEditor from '../keyframes/KeyframeEditor'
import KeyframeTimeline from '../keyframes/KeyframeTimeline'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

type Phase = 'config' | 'tracking' | 'keyframes' | 'validated'

export default function ContourTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const contourAnchors = mesh?.contourAnchors ?? []

  const initialPhase: Phase = mesh?.contourAnchorTrackingValidated
    ? 'validated'
    : (mesh?.contourAnchorKeyframes?.length ?? 0) > 0
      ? 'keyframes'
      : 'config'

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [interval, setInterval_] = useState(mesh?.contourAnchorKeyframeInterval ?? 10)
  const [progress, setProgress] = useState('')
  const [saving, setSaving] = useState(false)
  const [propagating, setPropagating] = useState(false)

  // Constraint toggles
  const [enableAntiSaut, setEnableAntiSaut] = useState(true)
  const [enableNeighbor, setEnableNeighbor] = useState(true)
  const [enableTemporal, setEnableTemporal] = useState(false)
  const [enableContour, setEnableContour] = useState(false)
  const [enableOutlier, setEnableOutlier] = useState(false)
  const [enableSnap, setEnableSnap] = useState(true)
  const [enableCurvilinearSpring, setEnableCurvilinearSpring] = useState(false)

  // Preview animation state
  const [previewMode, setPreviewMode] = useState<'none' | 'anchors' | 'full'>('none')
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewFrame, setPreviewFrame] = useState(0)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const previewAnimRef = useRef(0)
  const [previewVideoReady, setPreviewVideoReady] = useState(false)
  const [previewComputing, setPreviewComputing] = useState(false)
  const [previewProgress, setPreviewProgress] = useState('')
  const previewContourFramesRef = useRef<Point2D[][] | null>(null)
  const [previewReady, setPreviewReady] = useState(false)

  // Raw tracking data (per-frame positions for all contour vertices)
  const rawTrackingRef = useRef<Point2D[][]>([])

  // Keyframes state
  const [keyframes, setKeyframes] = useState<KeyframeData[]>(mesh?.contourAnchorKeyframes ?? [])
  const [selectedKfIdx, setSelectedKfIdx] = useState<number | null>(null)
  const totalFramesRef = useRef(0)

  const [imageDims, setImageDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const contourIndexRef = useRef<ContourSpatialIndex | null>(null)
  const [cannyContourPoints, setCannyContourPoints] = useState<Point2D[]>([])
  const [autoSnap, setAutoSnap] = useState(true)
  const snapVideoRef = useRef<HTMLVideoElement | null>(null)
  const lastSnappedFrameRef = useRef<number>(-1)

  // Load image dimensions on mount
  useState(() => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.onload = () => {
      setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.src = url
  })

  // Create video element for Canny detection on keyframe frames
  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      snapVideoRef.current = video
    }
    video.load()
    return () => {
      URL.revokeObjectURL(url)
      snapVideoRef.current = null
    }
  }, [project.videoBlob])

  // Detect Canny on the current keyframe's video frame
  useEffect(() => {
    if (selectedKfIdx === null || keyframes.length === 0) return
    const kf = keyframes[selectedKfIdx]
    if (!kf || !mesh?.cannyParams) return
    const frameIdx = kf.frameIndex
    if (frameIdx === lastSnappedFrameRef.current) return

    let cancelled = false
    const cannyParams = mesh.cannyParams

    async function detectOnFrame() {
      const video = snapVideoRef.current
      if (!video) return

      try {
        await loadOpenCVWorker()

        // Seek to the keyframe's frame
        video.currentTime = frameIdx / 24
        await new Promise<void>((resolve) => {
          video.onseeked = () => resolve()
        })

        // Extract frame to canvas
        const vw = video.videoWidth
        const vh = video.videoHeight
        const canvas = document.createElement('canvas')
        canvas.width = vw
        canvas.height = vh
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(video, 0, 0)

        const imageData = ctx.getImageData(0, 0, vw, vh)
        const contourPts = await flowCannyContour(
          imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize
        )

        if (cancelled) return
        if (contourPts && contourPts.length > 0) {
          // Convert video coords → image coords
          const iw = imageDims.w || vw
          const ih = imageDims.h || vh
          const imgContourPts = contourPts.map(p => ({
            x: (p.x / vw) * iw,
            y: (p.y / vh) * ih,
          }))
          contourIndexRef.current = new ContourSpatialIndex(imgContourPts, 8)
          setCannyContourPoints(imgContourPts)
          lastSnappedFrameRef.current = frameIdx
        }
      } catch (err) {
        console.error('Failed to detect Canny on frame:', err)
      }
    }

    detectOnFrame()
    return () => { cancelled = true }
  }, [selectedKfIdx, keyframes, mesh?.cannyParams, imageDims])

  // Snap function for keyframe editor (uses contour of current frame)
  const handleSnapPoint = useCallback((p: Point2D): Point2D => {
    if (!contourIndexRef.current) return p
    const result = contourIndexRef.current.nearestUnbounded(p)
    return result ? result.point : p
  }, [])

  // Build constraints for tracking
  const buildConstraints = useCallback((): TrackingConstraintParams | undefined => {
    if (!enableAntiSaut && !enableNeighbor && !enableTemporal && !enableContour && !enableOutlier && !enableSnap && !enableCurvilinearSpring) {
      return undefined
    }

    // Build a simple chain adjacency for contour anchors
    const contourOrder = contourAnchors.map((_, i) => i)
    const anchorTriangles: [number, number, number][] = []
    for (let i = 0; i < contourAnchors.length - 1; i++) {
      const next = (i + 2) % contourAnchors.length
      anchorTriangles.push([i, i + 1, next])
    }

    return {
      anchorTriangles,
      contourAnchorOrder: contourOrder,
      enableAntiSaut,
      enableTemporalSmoothing: enableTemporal,
      enableContourConstraints: enableContour,
      enableOutlierDetection: enableOutlier,
      enableSnapToContour: enableSnap,
      enableCurvilinearSpring,
      cannyParams: (enableSnap || enableCurvilinearSpring) ? (mesh?.cannyParams ?? undefined) : undefined,
    }
  }, [enableAntiSaut, enableNeighbor, enableTemporal, enableContour, enableOutlier, enableSnap, enableCurvilinearSpring, contourAnchors, mesh?.cannyParams])

  // Launch tracking
  async function handleLaunchTracking() {
    if (!project.videoBlob || !mesh || contourAnchors.length === 0) return
    if (imageDims.w === 0) {
      alert('Dimensions image non chargées, réessayez.')
      return
    }

    setPhase('tracking')
    setProgress('Démarrage...')

    try {
      const constraints = buildConstraints()
      const result = await precomputeOpticalFlow(
        null,
        project.videoBlob,
        contourAnchors,
        imageDims.w,
        imageDims.h,
        (stage, current, total) => {
          setProgress(`${stage} : ${current}/${total}`)
        },
        constraints
      )

      rawTrackingRef.current = result.videoFramesMesh
      totalFramesRef.current = result.videoFramesMesh.length

      const kfs = extractKeyframes(result.videoFramesMesh, interval)
      setKeyframes(kfs)
      setSelectedKfIdx(0)
      setPhase('keyframes')
      setProgress('')
    } catch (err) {
      console.error('Contour tracking failed:', err)
      alert('Erreur tracking : ' + (err instanceof Error ? err.message : err))
      setPhase('config')
      setProgress('')
    }
  }

  // Propagate forward one step from current keyframe
  const handlePropagateForwardOne = useCallback(async () => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const currentKf = keyframes[selectedKfIdx]
      const nextKf = keyframes[selectedKfIdx + 1]
      const constraints = buildConstraints()

      const segResults = await trackSegment(
        project.videoBlob,
        currentKf.anchorPositions,
        imageDims.w,
        imageDims.h,
        currentKf.frameIndex,
        nextKf.frameIndex,
        undefined,
        constraints
      )

      for (const seg of segResults) {
        rawTrackingRef.current[seg.frameIndex] = seg.points
      }

      if (segResults.length > 0) {
        const lastSeg = segResults[segResults.length - 1]
        const newKeyframes = [...keyframes]
        newKeyframes[selectedKfIdx + 1] = {
          ...nextKf,
          anchorPositions: lastSeg.points,
        }
        setKeyframes(newKeyframes)
      }

      setSelectedKfIdx(selectedKfIdx + 1)
    } catch (err) {
      console.error('Propagation failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  // Propagate forward all from current keyframe
  const handlePropagateForwardAll = useCallback(async () => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const newKeyframes = [...keyframes]
      let currentIdx = selectedKfIdx
      const constraints = buildConstraints()

      while (currentIdx < newKeyframes.length - 1) {
        const currentKf = newKeyframes[currentIdx]
        const nextKf = newKeyframes[currentIdx + 1]

        const segResults = await trackSegment(
          project.videoBlob,
          currentKf.anchorPositions,
          imageDims.w,
          imageDims.h,
          currentKf.frameIndex,
          nextKf.frameIndex,
          undefined,
          constraints
        )

        for (const seg of segResults) {
          rawTrackingRef.current[seg.frameIndex] = seg.points
        }

        if (segResults.length > 0) {
          const lastSeg = segResults[segResults.length - 1]
          newKeyframes[currentIdx + 1] = {
            ...nextKf,
            anchorPositions: lastSeg.points,
          }
        }

        currentIdx++
      }

      setKeyframes(newKeyframes)
      setSelectedKfIdx(newKeyframes.length - 1)
    } catch (err) {
      console.error('Propagation all failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  // Bidi propagate one step
  const handlePropagateBidiOne = useCallback(async () => {
    if (selectedKfIdx === null) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const currentKf = keyframes[selectedKfIdx]
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      // Forward
      if (selectedKfIdx < keyframes.length - 1) {
        const nextKf = keyframes[selectedKfIdx + 1]
        const segResults = await trackSegment(
          project.videoBlob, currentKf.anchorPositions,
          imageDims.w, imageDims.h,
          currentKf.frameIndex, nextKf.frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[selectedKfIdx + 1] = {
            ...nextKf, anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      // Backward
      if (selectedKfIdx > 0) {
        const prevKf = keyframes[selectedKfIdx - 1]
        const segResults = await trackSegment(
          project.videoBlob, currentKf.anchorPositions,
          imageDims.w, imageDims.h,
          currentKf.frameIndex, prevKf.frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[selectedKfIdx - 1] = {
            ...prevKf, anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      setKeyframes(newKeyframes)
    } catch (err) {
      console.error('Bidi propagation failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  // Bidi propagate all
  const handlePropagateBidiAll = useCallback(async () => {
    if (selectedKfIdx === null) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      // Forward from current to end
      for (let i = selectedKfIdx; i < newKeyframes.length - 1; i++) {
        const segResults = await trackSegment(
          project.videoBlob, newKeyframes[i].anchorPositions,
          imageDims.w, imageDims.h,
          newKeyframes[i].frameIndex, newKeyframes[i + 1].frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[i + 1] = {
            ...newKeyframes[i + 1], anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      // Backward from current to start
      for (let i = selectedKfIdx; i > 0; i--) {
        const segResults = await trackSegment(
          project.videoBlob, newKeyframes[i].anchorPositions,
          imageDims.w, imageDims.h,
          newKeyframes[i].frameIndex, newKeyframes[i - 1].frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[i - 1] = {
            ...newKeyframes[i - 1], anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      setKeyframes(newKeyframes)
    } catch (err) {
      console.error('Bidi all failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  // Update keyframe positions (from editor drag)
  const handleUpdatePositions = useCallback((positions: Point2D[]) => {
    if (selectedKfIdx === null) return
    const newKeyframes = [...keyframes]
    newKeyframes[selectedKfIdx] = {
      ...newKeyframes[selectedKfIdx],
      anchorPositions: positions,
    }
    setKeyframes(newKeyframes)
  }, [selectedKfIdx, keyframes])

  // Skip keyframe without propagation
  const handleValidateOnly = useCallback(() => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    setSelectedKfIdx(selectedKfIdx + 1)
  }, [selectedKfIdx, keyframes])

  // Save & validate tracking
  async function handleSaveAndValidate() {
    if (!mesh || keyframes.length === 0) return
    setSaving(true)
    try {
      const totalFrames = totalFramesRef.current
      const contourAnchorFrames = propagateKeyframes(keyframes, totalFrames)

      const updatedMesh: MeshData = {
        ...mesh,
        contourAnchorKeyframeInterval: interval,
        contourAnchorKeyframes: keyframes,
        contourAnchorFrames,
        contourAnchorTrackingValidated: true,
        // Reset downstream
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
      }

      await onSave(
        { ...project, mesh: updatedMesh },
        ['contourAnchorKeyframes', 'contourAnchorFrames']
      )
      setPhase('validated')
    } catch (err) {
      console.error('Save failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // Preview: compute full contour (anchors + Canny subdivision) per frame
  const contourSubParams = mesh?.contourSubdivisionParams ?? []

  // Build ordered contour from anchor positions + subdivision positions for one frame
  const buildOrderedContour = useCallback((anchors: Point2D[], subdivisionPts: Point2D[]): Point2D[] => {
    const nAnchors = anchors.length
    if (nAnchors < 2) return anchors

    // Group subdivision params by segment, sorted by t
    const segSubs: number[][] = Array.from({ length: nAnchors }, () => [])
    for (let j = 0; j < contourSubParams.length; j++) {
      const { segmentIndex } = contourSubParams[j]
      if (segmentIndex < nAnchors) {
        segSubs[segmentIndex].push(j)
      }
    }
    // Sort each segment's subdivision indices by t
    for (const seg of segSubs) {
      seg.sort((a, b) => contourSubParams[a].t - contourSubParams[b].t)
    }

    const ordered: Point2D[] = []
    for (let i = 0; i < nAnchors; i++) {
      ordered.push(anchors[i])
      for (const subIdx of segSubs[i]) {
        ordered.push(subdivisionPts[subIdx] ?? anchors[i])
      }
    }
    return ordered
  }, [contourSubParams])

  // Compute preview: anchors-only (instant) or full contour (Canny subdivision)
  const handleComputePreviewAnchors = useCallback(() => {
    if (keyframes.length < 2 || totalFramesRef.current === 0) return

    setPreviewReady(false)
    setPreviewPlaying(false)
    setPreviewFrame(0)
    previewContourFramesRef.current = null

    const anchorFrames = propagateKeyframes(keyframes, totalFramesRef.current)
    previewContourFramesRef.current = anchorFrames
    setPreviewMode('anchors')
    setPreviewReady(true)
  }, [keyframes])

  const handleComputePreviewFull = useCallback(async () => {
    if (keyframes.length < 2 || totalFramesRef.current === 0) return
    if (!project.videoBlob || !mesh?.cannyParams) return

    setPreviewComputing(true)
    setPreviewReady(false)
    setPreviewPlaying(false)
    setPreviewFrame(0)
    previewContourFramesRef.current = null
    setPreviewMode('full')

    try {
      const anchorFrames = propagateKeyframes(keyframes, totalFramesRef.current)

      if (contourSubParams.length > 0) {
        setPreviewProgress('Chargement OpenCV...')
        await loadOpenCVWorker()

        setPreviewProgress('Calcul contour Canny par frame...')
        const subdivisionFrames = await computeAllSubdivisionFrames(
          project.videoBlob,
          anchorFrames,
          contourSubParams,
          mesh.cannyParams,
          (p) => setPreviewProgress(`Contour Canny : frame ${p.frame}/${p.total}`)
        )

        // Build ordered contour for each frame
        const fullContourFrames = anchorFrames.map((anchors, f) =>
          buildOrderedContour(anchors, subdivisionFrames[f] ?? [])
        )
        previewContourFramesRef.current = fullContourFrames
      } else {
        // No subdivision — just anchors
        previewContourFramesRef.current = anchorFrames
      }

      setPreviewReady(true)
    } catch (err) {
      console.error('Preview computation failed:', err)
      alert('Erreur calcul preview : ' + (err instanceof Error ? err.message : err))
    }
    setPreviewComputing(false)
    setPreviewProgress('')
  }, [keyframes, project.videoBlob, mesh?.cannyParams, contourSubParams, buildOrderedContour])

  // Setup preview video element
  useEffect(() => {
    if (previewMode === 'none' || !project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      previewVideoRef.current = video
      setPreviewVideoReady(true)
    }
    video.load()
    return () => {
      URL.revokeObjectURL(url)
      previewVideoRef.current = null
      setPreviewVideoReady(false)
    }
  }, [previewMode, project.videoBlob])

  // Preview playback loop at 24 FPS
  useEffect(() => {
    if (!previewPlaying || !previewReady) return
    const frames = previewContourFramesRef.current
    if (!frames) return
    let lastTime = performance.now()
    function tick(now: number) {
      if (now - lastTime >= 1000 / 24) {
        lastTime = now
        setPreviewFrame(f => (f + 1) % frames!.length)
      }
      previewAnimRef.current = requestAnimationFrame(tick)
    }
    previewAnimRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(previewAnimRef.current)
  }, [previewPlaying, previewReady])

  // Stop playback when preview closes
  useEffect(() => {
    if (previewMode === 'none') {
      setPreviewPlaying(false)
      setPreviewFrame(0)
    }
  }, [previewMode])

  // Invalidate preview when keyframes change
  useEffect(() => {
    if (previewReady) {
      setPreviewReady(false)
      previewContourFramesRef.current = null
      setPreviewPlaying(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyframes])

  // Draw preview frame: video + full contour overlay
  useEffect(() => {
    if (previewMode === 'none' || !previewVideoReady || !previewReady) return
    const frames = previewContourFramesRef.current
    const canvas = previewCanvasRef.current
    const video = previewVideoRef.current
    if (!frames || !canvas || !video || previewFrame >= frames.length) return

    // Ensure canvas dimensions
    const rect = canvas.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      const dpr = window.devicePixelRatio || 1
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }
    if (canvas.width === 0 || canvas.height === 0) return

    const frame = previewFrame
    const targetTime = frame / 24

    function draw() {
      const ctx = canvas!.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas!.width / dpr
      const cssH = canvas!.height / dpr
      ctx.clearRect(0, 0, cssW, cssH)

      const vw = video!.videoWidth, vh = video!.videoHeight
      const s = Math.min(cssW / vw, cssH / vh) * 0.95
      const ox = (cssW - vw * s) / 2, oy = (cssH - vh * s) / 2
      ctx.drawImage(video!, ox, oy, vw * s, vh * s)

      const imgW = imageDims.w || vw, imgH = imageDims.h || vh
      const contour = frames![frame]
      if (!contour) return

      const currentMode = previewMode

      // Draw contour polygon (closed path)
      if (contour.length >= 2) {
        ctx.strokeStyle = currentMode === 'anchors'
          ? 'rgba(255, 100, 100, 0.6)'
          : 'rgba(255, 200, 0, 0.8)'
        ctx.lineWidth = 2
        ctx.beginPath()
        for (let i = 0; i < contour.length; i++) {
          const px = (contour[i].x / imgW) * vw * s + ox
          const py = (contour[i].y / imgH) * vh * s + oy
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        ctx.closePath()
        ctx.stroke()
      }

      if (currentMode === 'anchors') {
        // Anchors-only: all points are anchors
        ctx.fillStyle = '#ff3333'
        for (let i = 0; i < contour.length; i++) {
          const px = (contour[i].x / imgW) * vw * s + ox
          const py = (contour[i].y / imgH) * vh * s + oy
          ctx.beginPath()
          ctx.arc(px, py, 5, 0, Math.PI * 2)
          ctx.fill()
        }
      } else {
        // Full mode: distinguish anchors vs subdivision
        const nAnchors = contourAnchors.length
        const anchorIndicesInContour = new Set<number>()
        let idx = 0
        for (let i = 0; i < nAnchors; i++) {
          anchorIndicesInContour.add(idx)
          idx++
          const segCount = contourSubParams.filter(p => p.segmentIndex === i).length
          idx += segCount
        }

        // Draw subdivision points (green, small)
        ctx.fillStyle = '#22c55e'
        for (let i = 0; i < contour.length; i++) {
          if (anchorIndicesInContour.has(i)) continue
          const px = (contour[i].x / imgW) * vw * s + ox
          const py = (contour[i].y / imgH) * vh * s + oy
          ctx.beginPath()
          ctx.arc(px, py, 2.5, 0, Math.PI * 2)
          ctx.fill()
        }

        // Draw anchor points (red, larger)
        ctx.fillStyle = '#ff3333'
        for (const ai of anchorIndicesInContour) {
          if (ai >= contour.length) continue
          const px = (contour[ai].x / imgW) * vw * s + ox
          const py = (contour[ai].y / imgH) * vh * s + oy
          ctx.beginPath()
          ctx.arc(px, py, 5, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Frame counter + mode label
      const modeLabel = currentMode === 'anchors' ? 'Anchors' : 'Complet'
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(8, 8, 200, 24)
      ctx.fillStyle = '#fff'
      ctx.font = '12px monospace'
      ctx.fillText(`[${modeLabel}] Frame ${frame} / ${frames!.length - 1}`, 14, 24)
    }

    const handleSeeked = () => draw()
    video.addEventListener('seeked', handleSeeked)
    video.currentTime = targetTime
    if (Math.abs(video.currentTime - targetTime) < 0.02) {
      draw()
    }
    return () => {
      video.removeEventListener('seeked', handleSeeked)
    }
  }, [previewMode, previewVideoReady, previewFrame, previewReady, imageDims])

  // Reset tracking
  function handleReset() {
    if (!confirm('Réinitialiser le tracking contour ? Les keyframes seront perdues.')) return
    setKeyframes([])
    rawTrackingRef.current = []
    setSelectedKfIdx(null)
    setPhase('config')
  }

  // Prerequisite checks
  if (!mesh?.cannyParams) {
    return <div className="placeholder">Validez d&apos;abord les paramètres Canny (étape 2).</div>
  }
  if (!mesh?.contourAnchors?.length) {
    return <div className="placeholder">Définissez d&apos;abord les anchors contour (étape 3).</div>
  }
  if (!(mesh?.contourSubdivisionPoints?.length)) {
    return <div className="placeholder">Définissez d&apos;abord la subdivision contour (étape 4).</div>
  }
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d&apos;abord une vidéo.</div>
  }

  // Validated phase
  if (phase === 'validated') {
    return (
      <div className="tracking-step">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px' }}>
          <span style={{ color: '#22c55e', fontWeight: 'bold', fontSize: '1.1rem' }}>
            Tracking contour validé
          </span>
          <span style={{ color: '#888' }}>
            {contourAnchors.length} anchors contour trackés sur {mesh.contourAnchorFrames?.length ?? '?'} frames
          </span>
          <button className="btn-danger" onClick={handleReset}>
            Recommencer
          </button>
        </div>
      </div>
    )
  }

  // Config phase
  if (phase === 'config') {
    return (
      <div className="tracking-step">
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3 style={{ margin: 0 }}>Configuration du tracking contour</h3>
          <p style={{ color: '#888', margin: 0 }}>
            {contourAnchors.length} anchors contour à tracker.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label>Intervalle keyframes :</label>
            <button onClick={() => setInterval_(Math.max(1, interval - 5))} disabled={interval <= 1}>−</button>
            <span style={{ minWidth: 30, textAlign: 'center' }}>{interval}</span>
            <button onClick={() => setInterval_(interval + 5)}>+</button>
            <span style={{ color: '#888', fontSize: '0.85rem' }}>frames</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong>Contraintes :</strong>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableAntiSaut} onChange={e => setEnableAntiSaut(e.target.checked)} />
              Anti-saut (clamp déplacement max)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableNeighbor} onChange={e => setEnableNeighbor(e.target.checked)} />
              Contrainte voisinage (consensus médiane)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableContour} onChange={e => setEnableContour(e.target.checked)} />
              Contraintes contour (stabilisation curviligne)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableTemporal} onChange={e => setEnableTemporal(e.target.checked)} />
              Lissage temporel (post-traitement)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableOutlier} onChange={e => setEnableOutlier(e.target.checked)} />
              Détection outliers (post-traitement)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: enableSnap ? 'bold' : 'normal' }}>
              <input type="checkbox" checked={enableSnap} onChange={e => setEnableSnap(e.target.checked)} />
              Snap-to-contour (Canny)
              {!mesh?.cannyParams && <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}> — validez Canny d&apos;abord</span>}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableCurvilinearSpring} onChange={e => setEnableCurvilinearSpring(e.target.checked)} />
              Répulsion ressort curviligne (Canny)
              {!mesh?.cannyParams && <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}> — validez Canny d&apos;abord</span>}
            </label>
          </div>

          <button
            onClick={handleLaunchTracking}
            style={{ background: '#2563eb', color: 'white', padding: '8px 24px', alignSelf: 'flex-start' }}
          >
            Lancer le tracking
          </button>
        </div>
      </div>
    )
  }

  // Tracking phase (in progress)
  if (phase === 'tracking') {
    return (
      <div className="tracking-step">
        <div style={{ padding: '16px', textAlign: 'center' }}>
          <h3>Tracking en cours...</h3>
          <p style={{ fontFamily: 'monospace' }}>{progress}</p>
          <div style={{ width: '100%', maxWidth: 400, margin: '0 auto', height: 4, background: '#333', borderRadius: 2 }}>
            <div style={{ width: '50%', height: '100%', background: '#2563eb', borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
        </div>
      </div>
    )
  }

  // Keyframes phase
  const selectedKf = selectedKfIdx !== null ? keyframes[selectedKfIdx] : null

  return (
    <div className="tracking-step" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <span style={{ fontWeight: 'bold' }}>
          Keyframes contour ({keyframes.length})
        </span>
        <button
          onClick={handleSaveAndValidate}
          disabled={saving}
          style={{ background: '#22c55e', color: 'white' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider le tracking contour'}
        </button>
        <button className="btn-danger" onClick={handleReset}>
          Recommencer
        </button>
        {keyframes.length >= 2 && (
          <>
            <button
              onClick={() => {
                if (previewMode === 'anchors') { setPreviewMode('none') }
                else { handleComputePreviewAnchors() }
              }}
              style={{ background: previewMode === 'anchors' ? '#f59e0b' : '#6366f1', color: 'white' }}
            >
              {previewMode === 'anchors' ? 'Fermer' : 'Preview anchors'}
            </button>
            <button
              onClick={() => {
                if (previewMode === 'full') { setPreviewMode('none') }
                else { handleComputePreviewFull() }
              }}
              disabled={previewComputing}
              style={{ background: previewMode === 'full' ? '#f59e0b' : '#8b5cf6', color: 'white' }}
            >
              {previewMode === 'full' ? 'Fermer' : 'Preview complète'}
            </button>
          </>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', marginLeft: 'auto', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={autoSnap} onChange={e => setAutoSnap(e.target.checked)} />
          Auto-snap Canny
        </label>
      </div>

      {previewMode !== 'none' && (
        <div style={{ padding: '0 16px 8px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            {previewComputing && (
              <span style={{ color: '#f59e0b', fontSize: '0.85rem', fontFamily: 'monospace' }}>
                {previewProgress || 'Calcul en cours...'}
              </span>
            )}
            {previewReady && (
              <>
                <button
                  onClick={() => setPreviewPlaying(!previewPlaying)}
                  style={{ background: previewPlaying ? '#ef4444' : '#22c55e', color: 'white', padding: '4px 12px' }}
                >
                  {previewPlaying ? 'Pause' : 'Play'}
                </button>
                <button
                  onClick={() => { setPreviewPlaying(false); setPreviewFrame(0) }}
                  style={{ padding: '4px 12px' }}
                >
                  Restart
                </button>
                <button
                  onClick={previewMode === 'anchors' ? handleComputePreviewAnchors : handleComputePreviewFull}
                  style={{ padding: '4px 12px' }}
                >
                  Recalculer
                </button>
                <span style={{ color: '#888', fontSize: '0.85rem' }}>
                  {previewMode === 'anchors' ? 'Anchors seuls' : 'Contour complet'}
                  {' — '}
                  {previewContourFramesRef.current
                    ? `${previewFrame} / ${previewContourFramesRef.current.length - 1}`
                    : ''}
                </span>
              </>
            )}
          </div>
          {previewReady && (
            <canvas
              ref={previewCanvasRef}
              style={{ width: '100%', height: 300, background: '#111', borderRadius: 4 }}
            />
          )}
        </div>
      )}

      <KeyframeTimeline
        keyframes={keyframes}
        totalFrames={totalFramesRef.current}
        selectedIndex={selectedKfIdx}
        onSelect={setSelectedKfIdx}
      />

      {selectedKf && (
        <KeyframeEditor
          videoBlob={project.videoBlob!}
          imageWidth={imageDims.w}
          imageHeight={imageDims.h}
          frameIndex={selectedKf.frameIndex}
          anchorPositions={selectedKf.anchorPositions}
          referencePositions={keyframes[0]?.anchorPositions}
          totalFrames={totalFramesRef.current}
          onUpdatePositions={handleUpdatePositions}
          onPropagateForwardOne={handlePropagateForwardOne}
          onPropagateForwardAll={handlePropagateForwardAll}
          onPropagateBidiOne={handlePropagateBidiOne}
          onPropagateBidiAll={handlePropagateBidiAll}
          onValidateOnly={handleValidateOnly}
          propagating={propagating}
          isFirstKeyframe={selectedKfIdx === 0}
          isLastKeyframe={selectedKfIdx === keyframes.length - 1}
          onSnapPoint={autoSnap ? handleSnapPoint : undefined}
          cannyContourPoints={cannyContourPoints}
        />
      )}
    </div>
  )
}
