import { useRef, useEffect, useState, useCallback } from 'react'
import { loadOpenCV } from '../../utils/opencvLoader'
import { detectMarkers, areMarkersStable, type DetectedMarkers } from '../../utils/markerDetector'

interface Props {
  onCapture: (canvas: HTMLCanvasElement, markers: DetectedMarkers) => void
}

export default function CameraView({ onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'detecting' | 'stable' | 'error'>('loading')
  const [errorMsg, setErrorMsg] = useState('')
  const cvRef = useRef<any>(null)
  const stableCountRef = useRef(0)
  const lastMarkersRef = useRef<DetectedMarkers | null>(null)
  const animRef = useRef(0)
  const frameCountRef = useRef(0)

  const STABLE_FRAMES_NEEDED = 15 // ~0.5s at 30fps processing every other frame

  // Initialize camera and OpenCV
  useEffect(() => {
    let stream: MediaStream | null = null

    async function init() {
      try {
        // Load OpenCV
        cvRef.current = await loadOpenCV()

        // Get camera
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        })

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
          setStatus('ready')
        }
      } catch (err) {
        console.error('Camera/OpenCV init failed:', err)
        setErrorMsg(err instanceof Error ? err.message : 'Erreur initialisation')
        setStatus('error')
      }
    }

    init()

    return () => {
      if (stream) {
        stream.getTracks().forEach(t => t.stop())
      }
      cancelAnimationFrame(animRef.current)
    }
  }, [])

  // Detection loop
  const detect = useCallback(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    const cv = cvRef.current
    if (!video || !canvas || !overlay || !cv || video.readyState < 2) {
      animRef.current = requestAnimationFrame(detect)
      return
    }

    frameCountRef.current++
    // Process every 3rd frame to save CPU
    if (frameCountRef.current % 3 !== 0) {
      animRef.current = requestAnimationFrame(detect)
      return
    }

    // Draw video frame to canvas
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    // Detect markers
    const frame = cv.imread(canvas)
    const markers = detectMarkers(cv, frame)
    frame.delete()

    // Draw overlay
    overlay.width = video.videoWidth
    overlay.height = video.videoHeight
    const oCtx = overlay.getContext('2d')!
    oCtx.clearRect(0, 0, overlay.width, overlay.height)

    if (markers) {
      setStatus('detecting')

      // Draw detected corners
      const corners = [markers.topLeft, markers.topRight, markers.bottomLeft, markers.bottomRight]
      oCtx.strokeStyle = '#22c55e'
      oCtx.lineWidth = 3

      // Draw bounding quad
      oCtx.beginPath()
      oCtx.moveTo(markers.topLeft.x, markers.topLeft.y)
      oCtx.lineTo(markers.topRight.x, markers.topRight.y)
      oCtx.lineTo(markers.bottomRight.x, markers.bottomRight.y)
      oCtx.lineTo(markers.bottomLeft.x, markers.bottomLeft.y)
      oCtx.closePath()
      oCtx.stroke()

      // Draw corner dots
      for (const c of corners) {
        oCtx.fillStyle = '#22c55e'
        oCtx.beginPath()
        oCtx.arc(c.x, c.y, 8, 0, Math.PI * 2)
        oCtx.fill()
      }

      // Check stability
      if (lastMarkersRef.current && areMarkersStable(lastMarkersRef.current, markers)) {
        stableCountRef.current++
        if (stableCountRef.current >= STABLE_FRAMES_NEEDED) {
          setStatus('stable')
          // Auto-capture
          onCapture(canvas, markers)
          return // Stop detection loop
        }
      } else {
        stableCountRef.current = 0
      }
      lastMarkersRef.current = markers
    } else {
      setStatus('ready')
      stableCountRef.current = 0
      lastMarkersRef.current = null
    }

    animRef.current = requestAnimationFrame(detect)
  }, [onCapture])

  // Start detection when ready
  useEffect(() => {
    if (status === 'ready' || status === 'detecting') {
      animRef.current = requestAnimationFrame(detect)
      return () => cancelAnimationFrame(animRef.current)
    }
  }, [status, detect])

  function handleManualCapture() {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0)

    // Try to detect markers one more time
    const cv = cvRef.current
    if (cv) {
      const frame = cv.imread(canvas)
      const markers = detectMarkers(cv, frame)
      frame.delete()
      if (markers) {
        onCapture(canvas, markers)
        return
      }
    }

    alert('Markers non détectés. Assurez-vous que les 4 coins sont visibles.')
  }

  if (status === 'error') {
    return (
      <div className="camera-error">
        <p>Impossible d'accéder à la caméra</p>
        <p style={{ fontSize: '0.875rem', color: '#888' }}>{errorMsg}</p>
      </div>
    )
  }

  return (
    <div className="camera-view">
      <div className="camera-container">
        <video ref={videoRef} playsInline muted />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <canvas ref={overlayRef} className="camera-overlay" />

        <div className="camera-status">
          {status === 'loading' && 'Chargement caméra et OpenCV...'}
          {status === 'ready' && 'Placez le coloriage dans le cadre'}
          {status === 'detecting' && `Markers détectés — stabilisation (${Math.round((stableCountRef.current / STABLE_FRAMES_NEEDED) * 100)}%)`}
          {status === 'stable' && 'Capture !'}
        </div>
      </div>

      <button className="manual-capture-btn" onClick={handleManualCapture}>
        Capturer manuellement
      </button>
    </div>
  )
}

// Re-export type for convenience
export type { DetectedMarkers } from '../../utils/markerDetector'
