import { useState, useEffect, useRef, useCallback } from 'react'
import type { ProjectStepView, CannyParams } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const DEFAULT_PARAMS: CannyParams = {
  lowThreshold: 50,
  highThreshold: 150,
  blurSize: 5,
}

export default function CannyValidationStep({ project, onSave }: Props) {
  const [params, setParams] = useState<CannyParams>(
    project.mesh?.cannyParams ?? DEFAULT_PARAMS
  )
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [edgeCount, setEdgeCount] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const playingRef = useRef(false)
  const cannySeqRef = useRef(0) // cancellation token for async Canny calls
  const imageDimsRef = useRef<{ width: number; height: number } | null>(null)
  const fps = 24

  // Keep playingRef in sync
  useEffect(() => { playingRef.current = playing }, [playing])

  // Load image dimensions once
  useEffect(() => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.onload = () => {
      imageDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(url)
    }
    img.src = url
  }, [project.originalImageBlob])

  // Load OpenCV worker
  useEffect(() => {
    loadOpenCVWorker().catch(console.error)
  }, [])

  // Load video
  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)

    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.preload = 'auto'

    video.onloadedmetadata = () => {
      videoRef.current = video
      const total = Math.floor(video.duration * fps)
      setTotalFrames(total)
      video.currentTime = 0
    }

    // On seek completed: draw video frame, then compute Canny if not playing
    video.onseeked = () => {
      drawVideoFrame()
      if (!playingRef.current) {
        computeCannyOverlay()
      }
    }

    return () => {
      URL.revokeObjectURL(url)
      videoRef.current = null
    }
  }, [project.videoBlob])

  // Draw just the video frame onto the main canvas (instant, no async)
  function drawVideoFrame() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    const w = video.videoWidth
    const h = video.videoHeight
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h

    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)
  }

  // Compute Canny edges + draw overlay (async, with cancellation)
  const computeCannyOverlay = useCallback(async () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    if (!video || !canvas || !overlay) return

    const w = video.videoWidth
    const h = video.videoHeight
    if (overlay.width !== w) overlay.width = w
    if (overlay.height !== h) overlay.height = h

    // Get frame image data from the already-drawn canvas
    const ctx = canvas.getContext('2d')!
    const imageData = ctx.getImageData(0, 0, w, h)

    const seq = ++cannySeqRef.current
    setLoading(true)

    try {
      const contourPoints = await flowCannyContour(
        imageData,
        params.lowThreshold,
        params.highThreshold,
        params.blurSize
      )

      // Check if a newer request has been made (cancellation)
      if (seq !== cannySeqRef.current) return

      const octx = overlay.getContext('2d')!
      octx.clearRect(0, 0, w, h)

      if (contourPoints && contourPoints.length > 0) {
        setEdgeCount(contourPoints.length)
        // Draw contour as thick yellow stroke
        octx.strokeStyle = '#eeff00'
        octx.lineWidth = 5
        octx.shadowColor = '#eeff00'
        octx.shadowBlur = 4
        octx.lineJoin = 'round'
        octx.beginPath()
        octx.moveTo(contourPoints[0].x, contourPoints[0].y)
        for (let i = 1; i < contourPoints.length; i++) {
          octx.lineTo(contourPoints[i].x, contourPoints[i].y)
        }
        octx.closePath()
        octx.stroke()
        octx.shadowBlur = 0
      } else {
        setEdgeCount(0)
      }
    } catch (err) {
      console.error('Canny error:', err)
    } finally {
      if (seq === cannySeqRef.current) {
        setLoading(false)
      }
    }
  }, [params])

  // Seek to frame
  function seekToFrame(frame: number) {
    const video = videoRef.current
    if (!video) return
    const clamped = Math.max(0, Math.min(totalFrames - 1, frame))
    setCurrentFrame(clamped)
    video.currentTime = clamped / fps
  }

  // Play/pause
  useEffect(() => {
    if (!playing) {
      cancelAnimationFrame(animFrameRef.current)
      // When pausing, recompute Canny for current frame
      if (videoRef.current && totalFrames > 0) {
        computeCannyOverlay()
      }
      return
    }

    // Clear overlay during playback (Canny too slow for real-time)
    const overlay = overlayRef.current
    if (overlay) {
      const octx = overlay.getContext('2d')
      if (octx) octx.clearRect(0, 0, overlay.width, overlay.height)
    }

    let lastTime = performance.now()
    const frameInterval = 1000 / fps

    function tick(now: number) {
      const elapsed = now - lastTime
      if (elapsed >= frameInterval) {
        lastTime = now - (elapsed % frameInterval)
        setCurrentFrame(prev => {
          const next = prev + 1
          if (next >= totalFrames) {
            setPlaying(false)
            return prev
          }
          const video = videoRef.current
          if (video) video.currentTime = next / fps
          return next
        })
      }
      animFrameRef.current = requestAnimationFrame(tick)
    }

    animFrameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [playing, totalFrames, computeCannyOverlay])

  // Recompute Canny when params change (if not playing)
  useEffect(() => {
    if (!playing && videoRef.current && totalFrames > 0) {
      computeCannyOverlay()
    }
  }, [params, computeCannyOverlay, totalFrames, playing])

  async function handleValidate() {
    setSaving(true)
    try {
      const baseMesh: import('../../types/project').MeshData = project.mesh ?? {
        cannyParams: null,
        contourOrigin: null,
        contourOriginKeyframeInterval: 10,
        contourOriginKeyframes: [],
        contourOriginFrames: null,
        contourOriginTrackingValidated: false,
        contourAnchors: [],
        contourAnchorKeyframeInterval: 10,
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionPoints: [],
        contourSubdivisionParams: [],
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
        anchorPoints: [],
        anchorKeyframeInterval: 10,
        anchorKeyframes: [],
        anchorFrames: null,
        anchorTrackingValidated: false,
        internalPoints: [],
        triangles: [],
        topologyLocked: false,
        trackedTriangles: [],
        internalBarycentrics: [],
        bones: [],
        boneWeights: null,
        bonesValidated: false,
        videoFramesMesh: null,
      }
      // If shared geometry exists (from rest animation), only reset tracking data.
      // If no geometry yet (rest animation first setup), reset everything downstream.
      const hasSharedGeometry = baseMesh.contourAnchors.length > 0 || baseMesh.contourOrigin != null
      const mesh = hasSharedGeometry ? {
        ...baseMesh,
        cannyParams: params,
        // Reset only tracking data, keep shared geometry intact
        contourOriginKeyframeInterval: 10,
        contourOriginKeyframes: [],
        contourOriginFrames: null,
        contourOriginTrackingValidated: false,
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
        anchorKeyframes: [],
        anchorFrames: null,
        anchorTrackingValidated: false,
        videoFramesMesh: null,
      } : {
        ...baseMesh,
        cannyParams: params,
        // No geometry yet — reset everything downstream
        contourOrigin: null,
        contourOriginKeyframeInterval: 10,
        contourOriginKeyframes: [],
        contourOriginFrames: null,
        contourOriginTrackingValidated: false,
        contourAnchors: [],
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionPoints: [],
        contourSubdivisionParams: [],
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
      }
      await onSave({ ...project, mesh })
    } catch (err) {
      console.error('Failed to save Canny params:', err)
    }
    setSaving(false)
  }

  if (!project.videoBlob) {
    return <div className="placeholder">Importez d'abord une vidéo dans l'onglet Import.</div>
  }

  if (!project.originalImageBlob) {
    return <div className="placeholder">Importez d'abord une image dans l'onglet Import.</div>
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        <button className="btn-icon" onClick={() => setPlaying(!playing)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn-icon" onClick={() => seekToFrame(0)} disabled={playing}>
          ⏮ Début
        </button>
        <button className="btn-icon" onClick={() => seekToFrame(currentFrame - 1)} disabled={playing || currentFrame <= 0}>
          ◀ -1
        </button>
        <button className="btn-icon" onClick={() => seekToFrame(currentFrame + 1)} disabled={playing || currentFrame >= totalFrames - 1}>
          +1 ▶
        </button>

        <span className="density-label">
          Frame {currentFrame}/{totalFrames - 1}
          {loading && ' (calcul Canny...)'}
        </span>

        <span className="toolbar-separator" />

        <span className="density-label">{edgeCount.toLocaleString()} edges</span>

        <span className="toolbar-separator" />

        <button className="btn-primary" onClick={handleValidate} disabled={saving}>
          {saving ? 'Sauvegarde...' : 'Valider paramètres Canny'}
        </button>
      </div>


      {/* Frame slider */}
      <div style={{ padding: '4px 12px', background: 'var(--color-surface-2)', borderBottom: '1px solid var(--color-border)' }}>
        <input
          type="range"
          min={0}
          max={Math.max(0, totalFrames - 1)}
          value={currentFrame}
          onChange={e => seekToFrame(+e.target.value)}
          disabled={playing}
          style={{ width: '100%' }}
        />
      </div>

      {/* Video + Canny overlay */}
      <div style={{ position: 'relative', minHeight: '400px', flex: 1, overflow: 'hidden', background: 'var(--color-bg)' }}>
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            top: 0, left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
          }}
        />
        <canvas
          ref={overlayRef}
          style={{
            position: 'absolute',
            top: 0, left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  )
}
