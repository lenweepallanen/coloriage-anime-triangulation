import { useRef, useState, useEffect, useCallback } from 'react'
import { loadOpenCVWorker, detectFrame, setDetectCallback } from '../../utils/perspectiveCorrection'
import type { Point2D } from '../../types/project'

// Seuils qualité image
const BRIGHTNESS_MIN = 80
const BRIGHTNESS_MAX = 220
const CONTRAST_MIN = 25
const GLARE_MAX = 0.05
const SHARPNESS_MIN = 4

type QualityIssue = 'tooDark' | 'tooBright' | 'glare' | 'blurry' | 'lowContrast'

function analyzeImageQuality(imageData: ImageData) {
  const { data, width, height } = imageData

  const margin = 0.2
  const x0 = Math.round(width * margin)
  const y0 = Math.round(height * margin)
  const x1 = Math.round(width * (1 - margin))
  const y1 = Math.round(height * (1 - margin))

  let sumLum = 0
  let sumLum2 = 0
  let saturatedCount = 0
  let gradientEnergy = 0
  let pixelCount = 0

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]
      const lum = 0.299 * r + 0.587 * g + 0.114 * b

      sumLum += lum
      sumLum2 += lum * lum

      if (r > 245 && g > 245 && b > 245) saturatedCount++

      if (x < x1 - 1) {
        const j = (y * width + x + 1) * 4
        const lumNext = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
        const diff = lum - lumNext
        gradientEnergy += diff * diff
      }

      pixelCount++
    }
  }

  const brightness = sumLum / pixelCount
  const contrast = Math.sqrt(sumLum2 / pixelCount - brightness * brightness)
  const glareRatio = saturatedCount / pixelCount
  const sharpness = Math.sqrt(gradientEnergy / pixelCount)

  const issues: QualityIssue[] = []
  if (brightness < BRIGHTNESS_MIN) issues.push('tooDark')
  if (brightness > BRIGHTNESS_MAX) issues.push('tooBright')
  if (glareRatio > GLARE_MAX) issues.push('glare')
  if (sharpness < SHARPNESS_MIN) issues.push('blurry')
  if (contrast < CONTRAST_MIN && issues.length === 0) issues.push('lowContrast')

  return { brightness, contrast, glareRatio, sharpness, issues }
}

const ISSUE_MESSAGES: Record<QualityIssue, string> = {
  tooDark: 'Eclairez mieux — image trop sombre',
  tooBright: 'Trop de lumiere — eloignez la source',
  glare: 'Reflet detecte — inclinez le telephone',
  blurry: 'Image floue — stabilisez le telephone',
  lowContrast: 'Coins peu visibles — ameliorez l\'eclairage',
}

interface Props {
  onCapture: (blob: Blob, corners: Point2D[] | null) => void
}

export default function CameraView({ onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [isCameraActive, setIsCameraActive] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matchedCount, setMatchedCount] = useState(0)
  const [allStable, setAllStable] = useState(false)
  const [qualityIssue, setQualityIssue] = useState<QualityIssue | null>(null)
  const [autoCapturing, setAutoCapturing] = useState(false)
  const [showFlash, setShowFlash] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [opencvLoading, setOpencvLoading] = useState(true)

  const matchedGuidesRef = useRef([false, false, false, false])
  const stableFramesRef = useRef(0)
  const detectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const downscaleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const downscaleDimsRef = useRef({ w: 0, h: 0 })
  const lastDetectedCornersRef = useRef<Point2D[] | null>(null)
  const qualityRef = useRef<{ issues: QualityIssue[] }>({ issues: [] })
  const autoCaptureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const capturePhotoRef = useRef<(() => void) | null>(null)

  const MATCH_THRESHOLD = 0.30

  const getSquareCrop = useCallback((video: HTMLVideoElement) => {
    const vw = video.videoWidth
    const vh = video.videoHeight
    const size = Math.min(vw, vh)
    return { sx: (vw - size) / 2, sy: (vh - size) / 2, size }
  }, [])

  const getGuidePositions = useCallback((side: number) => {
    const margin = side * 0.10
    return [
      { x: margin, y: margin },
      { x: side - margin, y: margin },
      { x: side - margin, y: side - margin },
      { x: margin, y: side - margin },
    ]
  }, [])

  const startCamera = async () => {
    try {
      // Start loading OpenCV worker in parallel
      loadOpenCVWorker().catch(err => {
        console.warn('OpenCV worker load failed:', err)
      })

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 3840 },
          height: { ideal: 2160 }
        }
      })
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
        setStream(mediaStream)
        setIsCameraActive(true)
        setError(null)

        const track = mediaStream.getVideoTracks()[0]
        if (track) {
          const caps = (track as any).getCapabilities?.()
          if (caps?.torch) {
            setTorchSupported(true)
          }
        }
      }
    } catch (err) {
      console.error('Erreur acces camera:', err)
      setError('Impossible d\'acceder a la camera. Verifiez les permissions.')
    }
  }

  const stopCamera = useCallback(() => {
    if (detectionTimerRef.current) {
      clearTimeout(detectionTimerRef.current)
      detectionTimerRef.current = null
    }
    if (autoCaptureTimerRef.current) {
      clearTimeout(autoCaptureTimerRef.current)
      autoCaptureTimerRef.current = null
    }
    setDetectCallback(null)
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
    }
    setStream(null)
    setIsCameraActive(false)
    setMatchedCount(0)
    setAllStable(false)
    setQualityIssue(null)
    setAutoCapturing(false)
    setTorchOn(false)
    setTorchSupported(false)
    matchedGuidesRef.current = [false, false, false, false]
    stableFramesRef.current = 0
    qualityRef.current = { issues: [] }
  }, [stream])

  const toggleTorch = useCallback(async () => {
    if (!stream) return
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const newVal = !torchOn
    try {
      await (track as any).applyConstraints({ advanced: [{ torch: newVal }] })
      setTorchOn(newVal)
    } catch (err: any) {
      console.warn('Torch toggle failed:', err.message)
    }
  }, [stream, torchOn])

  const handleImportImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const img = new Image()
    img.onload = () => {
      const size = Math.min(img.width, img.height)
      const sx = (img.width - size) / 2
      const sy = (img.height - size) / 2

      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size)

      canvas.toBlob((blob) => {
        if (blob) {
          onCapture(blob, null)
        } else {
          setError('Erreur lors de l\'import. Veuillez reessayer.')
        }
      }, 'image/jpeg', 0.95)

      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(file)
  }, [onCapture])

  const drawCornerGuide = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number, cornerIndex: number, matched: boolean, armLen: number) => {
    ctx.strokeStyle = matched ? '#00FF00' : 'rgba(255, 255, 255, 0.6)'
    ctx.lineWidth = matched ? 5 : 3
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    if (matched) {
      ctx.shadowColor = 'rgba(0, 255, 0, 0.6)'
      ctx.shadowBlur = 12
    }

    ctx.beginPath()
    switch (cornerIndex) {
      case 0: // TL
        ctx.moveTo(x + armLen, y)
        ctx.lineTo(x, y)
        ctx.lineTo(x, y + armLen)
        break
      case 1: // TR
        ctx.moveTo(x - armLen, y)
        ctx.lineTo(x, y)
        ctx.lineTo(x, y + armLen)
        break
      case 2: // BR
        ctx.moveTo(x - armLen, y)
        ctx.lineTo(x, y)
        ctx.lineTo(x, y - armLen)
        break
      case 3: // BL
        ctx.moveTo(x + armLen, y)
        ctx.lineTo(x, y)
        ctx.lineTo(x, y - armLen)
        break
    }
    ctx.stroke()
    ctx.shadowBlur = 0
    ctx.shadowColor = 'transparent'

    if (matched) {
      ctx.beginPath()
      ctx.arc(x, y, 5, 0, Math.PI * 2)
      ctx.fillStyle = '#00FF00'
      ctx.fill()
    }
  }, [])

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const side = Math.round(rect.width)
    if (canvas.width !== side || canvas.height !== side) {
      canvas.width = side
      canvas.height = side
    }

    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, side, side)

    const guides = getGuidePositions(side)
    const matched = matchedGuidesRef.current
    const armLen = side * 0.07

    guides.forEach((pos, i) => {
      drawCornerGuide(ctx, pos.x, pos.y, i, matched[i], armLen)
    })

    if (matched.every(m => m)) {
      ctx.strokeStyle = 'rgba(0, 255, 0, 0.25)'
      ctx.lineWidth = 2
      ctx.setLineDash([8, 6])
      ctx.beginPath()
      ctx.moveTo(guides[0].x, guides[0].y)
      for (let i = 1; i < 4; i++) ctx.lineTo(guides[i].x, guides[i].y)
      ctx.closePath()
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [getGuidePositions, drawCornerGuide])

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !captureCanvasRef.current) return

    setShowFlash(true)
    setTimeout(() => setShowFlash(false), 200)

    if (autoCaptureTimerRef.current) {
      clearTimeout(autoCaptureTimerRef.current)
      autoCaptureTimerRef.current = null
    }
    if (detectionTimerRef.current) {
      clearTimeout(detectionTimerRef.current)
      detectionTimerRef.current = null
    }
    setDetectCallback(null)

    const video = videoRef.current
    const { sx, sy, size } = getSquareCrop(video)

    const canvas = captureCanvasRef.current
    canvas.width = size
    canvas.height = size

    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size)

    let scaledCorners: Point2D[] | null = null
    const corners = lastDetectedCornersRef.current
    const { w: downW } = downscaleDimsRef.current
    if (corners && corners.length === 4 && downW > 0) {
      const scaleFactor = size / downW
      scaledCorners = corners.map(c => ({
        x: Math.round(c.x * scaleFactor),
        y: Math.round(c.y * scaleFactor),
      }))
    }

    canvas.toBlob((blob) => {
      if (blob) {
        onCapture(blob, scaledCorners)
        stopCamera()
      } else {
        setError('Erreur lors de la capture. Veuillez reessayer.')
      }
    }, 'image/jpeg', 0.95)
  }, [getSquareCrop, onCapture, stopCamera])

  // Keep ref in sync for auto-capture timer
  capturePhotoRef.current = capturePhoto

  useEffect(() => {
    if (!isCameraActive) return

    if (!downscaleCanvasRef.current) {
      downscaleCanvasRef.current = document.createElement('canvas')
    }

    setDetectCallback((corners) => {
      if (opencvLoading) setOpencvLoading(false)

      const { w: downW, h: downH } = downscaleDimsRef.current
      if (downW === 0 || downH === 0) return

      const guides = getGuidePositions(downW)
      const guideDiag = Math.sqrt(
        (guides[2].x - guides[0].x) ** 2 + (guides[2].y - guides[0].y) ** 2
      )
      const threshold = guideDiag * MATCH_THRESHOLD

      const newMatched = [false, false, false, false]

      if (corners && corners.length === 4) {
        lastDetectedCornersRef.current = corners

        const usedCorners = new Set<number>()
        const guideOrder = [0, 1, 2, 3]
          .map(g => {
            let bestDist = Infinity
            for (let c = 0; c < corners.length; c++) {
              const dx = corners[c].x - guides[g].x
              const dy = corners[c].y - guides[g].y
              bestDist = Math.min(bestDist, Math.sqrt(dx * dx + dy * dy))
            }
            return { g, bestDist }
          })
          .sort((a, b) => a.bestDist - b.bestDist)
          .map(e => e.g)

        for (const g of guideOrder) {
          let bestDist = Infinity
          let bestC = -1
          for (let c = 0; c < corners.length; c++) {
            if (usedCorners.has(c)) continue
            const dx = corners[c].x - guides[g].x
            const dy = corners[c].y - guides[g].y
            const dist = Math.sqrt(dx * dx + dy * dy)
            if (dist < bestDist) { bestDist = dist; bestC = c }
          }
          if (bestC >= 0 && bestDist < threshold) {
            newMatched[g] = true
            usedCorners.add(bestC)
          }
        }
      }

      matchedGuidesRef.current = newMatched
      const count = newMatched.filter(m => m).length
      setMatchedCount(count)

      if (count === 4) {
        stableFramesRef.current++
        if (stableFramesRef.current >= 6) {
          setAllStable(true)
        }
      } else {
        stableFramesRef.current = 0
        setAllStable(false)
      }

      const qi = qualityRef.current
      if (qi.issues.length > 0) {
        setQualityIssue(qi.issues[0])
      } else {
        setQualityIssue(null)
      }

      const readyForAutoCapture = stableFramesRef.current >= 6 && qi.issues.length === 0
      if (readyForAutoCapture && !autoCaptureTimerRef.current) {
        setAutoCapturing(true)
        autoCaptureTimerRef.current = setTimeout(() => {
          autoCaptureTimerRef.current = null
          capturePhotoRef.current?.()
        }, 1000)
      } else if (!readyForAutoCapture && autoCaptureTimerRef.current) {
        clearTimeout(autoCaptureTimerRef.current)
        autoCaptureTimerRef.current = null
        setAutoCapturing(false)
      }

      drawOverlay()

      if (isCameraActive) {
        detectionTimerRef.current = setTimeout(runDetection, 200)
      }
    })

    function runDetection() {
      const video = videoRef.current
      if (!video || video.readyState < 2) {
        detectionTimerRef.current = setTimeout(runDetection, 500)
        return
      }

      const { sx, sy, size } = getSquareCrop(video)
      const maxW = 640
      const scale = Math.min(1, maxW / size)
      const side = Math.round(size * scale)

      const c = downscaleCanvasRef.current!
      c.width = side
      c.height = side
      downscaleDimsRef.current = { w: side, h: side }

      const ctx = c.getContext('2d')!
      ctx.drawImage(video, sx, sy, size, size, 0, 0, side, side)
      const imageData = ctx.getImageData(0, 0, side, side)

      const qa = analyzeImageQuality(imageData)
      qualityRef.current = qa

      const posted = detectFrame(imageData)
      if (!posted) {
        detectionTimerRef.current = setTimeout(runDetection, 500)
      }
    }

    runDetection()

    return () => {
      if (detectionTimerRef.current) {
        clearTimeout(detectionTimerRef.current)
        detectionTimerRef.current = null
      }
      if (autoCaptureTimerRef.current) {
        clearTimeout(autoCaptureTimerRef.current)
        autoCaptureTimerRef.current = null
      }
      setDetectCallback(null)
    }
  }, [isCameraActive, drawOverlay, getGuidePositions, getSquareCrop, opencvLoading])

  const getStatusText = () => {
    if (opencvLoading) return 'Chargement de la detection...'
    if (autoCapturing) return 'Photo automatique...'
    if (allStable && !qualityIssue) return 'Parfait !'

    if (qualityIssue === 'tooDark' || qualityIssue === 'tooBright' || qualityIssue === 'glare') {
      return ISSUE_MESSAGES[qualityIssue]
    }

    if (allStable && qualityIssue) {
      return `Coins OK — ${ISSUE_MESSAGES[qualityIssue]}`
    }
    if (matchedCount > 0) {
      const suffix = qualityIssue ? ` — ${ISSUE_MESSAGES[qualityIssue]}` : ''
      return `${matchedCount}/4 coins alignes...${suffix}`
    }

    if (qualityIssue) return ISSUE_MESSAGES[qualityIssue]
    return 'Alignez les coins du coloriage avec les guides'
  }

  const getStatusClass = () => {
    if (autoCapturing) return 'camera-status-bar--success'
    if (allStable && !qualityIssue) return 'camera-status-bar--success'
    if (qualityIssue === 'tooDark' || qualityIssue === 'tooBright' || qualityIssue === 'glare') {
      return 'camera-status-bar--error'
    }
    if (qualityIssue === 'blurry' || qualityIssue === 'lowContrast') return 'camera-status-bar--warning'
    if (matchedCount > 0) return 'camera-status-bar--warning'
    return 'camera-status-bar--default'
  }

  return (
    <div className="camera-capture">
      <div className="camera-square">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="camera-video"
        />

        {isCameraActive && (
          <canvas ref={overlayRef} className="camera-guide-overlay" />
        )}

        {isCameraActive && (
          <div className={`camera-status-bar ${getStatusClass()}`}>
            {(allStable && !qualityIssue) && <span style={{ marginRight: 4 }}>&#10003;</span>}
            {getStatusText()}
          </div>
        )}

        {showFlash && <div className="camera-flash" />}

        {autoCapturing && (
          <div className="camera-progress-bar">
            <div className="camera-progress-fill" />
          </div>
        )}
      </div>

      <canvas ref={captureCanvasRef} style={{ display: 'none' }} />

      {error && <div className="camera-error-box">{error}</div>}

      <div className="camera-buttons">
        {!isCameraActive ? (
          <>
            <div className="camera-buttons-row">
              <button onClick={startCamera} className="btn-start-camera">
                Demarrer la camera
              </button>
              <button onClick={() => fileInputRef.current?.click()} className="btn-import">
                Importer une image
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImportImage}
              style={{ display: 'none' }}
            />
            <div className="camera-tips">
              <p className="camera-tips-title">Conseils pour une bonne photo :</p>
              <p>Posez le coloriage a plat sur une table</p>
              <p>Eclairage naturel, evitez les spots directs</p>
              <p>Evitez les ombres et les reflets</p>
              <p>Tenez le telephone au-dessus, parallele au papier</p>
            </div>
          </>
        ) : (
          <div className="camera-buttons-row">
            {torchSupported && (
              <button
                onClick={toggleTorch}
                className={torchOn ? 'btn-torch btn-torch--on' : 'btn-torch'}
              >
                {torchOn ? 'Flash ON' : 'Flash'}
              </button>
            )}
            <button
              onClick={capturePhoto}
              className={allStable && !qualityIssue ? 'btn-capture btn-capture--ready' : 'btn-capture'}
            >
              {allStable && !qualityIssue ? 'Capturer !' : 'Prendre la photo'}
            </button>
            <button onClick={stopCamera} className="btn-cancel">
              Annuler
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
