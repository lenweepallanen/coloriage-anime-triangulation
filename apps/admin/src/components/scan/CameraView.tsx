import { useRef, useState, useEffect, useCallback } from 'react'
import { playT } from '../../utils/playI18n'
import { playUi } from '../../utils/uiSound'
import Mascot from '../mascot/Mascot'
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

const issueMessage = (issue: QualityIssue): string => playT(`camera.issue.${issue}`)

interface Props {
  /** Démarre la caméra dès le montage (arrivée depuis le scanner QR : elle était déjà ouverte). */
  autoStart?: boolean
  /** Notifie le parent quand la caméra passe active/inactive (sous-titre contextuel). */
  onActiveChange?: (active: boolean) => void
  onCapture: (blob: Blob, corners: Point2D[] | null) => void
  /** Titre affiché dans la colonne droite en mode paysage (masqué en portrait, où
   *  le titre vient de la pastille .scan-page > h2). */
  title?: string
  /** VIE PRIVÉE (play) : n'autorise la capture QUE si les 4 repères sont détectés
   *  (bouton grisé sinon) et bloque l'import sans repères. Empêche de scanner une
   *  photo quelconque (mur, visage). Défaut false (admin : fallback recadrage OK). */
  requireMarkers?: boolean
}

export default function CameraView({ onCapture, title, onActiveChange, autoStart, requireMarkers = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const captureCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [isCameraActive, setIsCameraActive] = useState(false)
  useEffect(() => { onActiveChange?.(isCameraActive) }, [isCameraActive, onActiveChange])
  const [error, setError] = useState<string | null>(null)
  const [matchedCount, setMatchedCount] = useState(0)
  const [allStable, setAllStable] = useState(false)
  const [qualityIssue, setQualityIssue] = useState<QualityIssue | null>(null)
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

  // Choisit l'ID de l'objectif arrière PRINCIPAL (grand-angle), en évitant la
  // caméra « virtuelle » composite (dual/triple) qui bascule toute seule entre
  // grand-angle / ultra grand-angle / télé selon la distance de map. C'est cette
  // bascule auto (mode macro à courte distance) qui fait « sauter » l'image.
  // Les labels ne sont peuplés qu'après l'octroi de la permission caméra.
  const pickMainBackCameraId = useCallback(async (): Promise<string | null> => {
    try {
      if (!navigator.mediaDevices?.enumerateDevices) return null
      const devices = await navigator.mediaDevices.enumerateDevices()
      const videos = devices.filter(d => d.kind === 'videoinput')
      if (videos.length === 0) return null

      const labelOf = (d: MediaDeviceInfo) => (d.label || '').toLowerCase()
      const isFront = (l: string) => /front|avant|face|user|selfie/.test(l)
      const isBack = (l: string) => /back|rear|arri[èe]re|environment|world/.test(l)

      let backs = videos.filter(d => isBack(labelOf(d)))
      if (backs.length === 0) backs = videos.filter(d => !isFront(labelOf(d)))
      if (backs.length === 0) backs = videos
      if (backs.length === 1) return backs[0].deviceId

      // Pénalise les optiques non principales + les capteurs composites virtuels.
      const penalize = (l: string) =>
        /ultra|t[ée]l[ée]|telephoto|zoom|dual|triple|depth|profondeur|lidar/.test(l) ? 1 : 0
      // Bonus pour le grand-angle principal simple ("Back Camera" / "Caméra arrière").
      const prefer = (l: string) =>
        /^(back|rear) camera$|cam[ée]ra arri[èe]re/.test(l) ? -1 : 0

      const best = backs
        .map(d => ({ d, score: penalize(labelOf(d)) + prefer(labelOf(d)) }))
        .sort((a, b) => a.score - b.score)[0]
      return best?.d.deviceId || null
    } catch {
      return null
    }
  }, [])

  // Démarrage automatique immédiat (arrivée du scanner QR) — l'écran
  // « Prêt à scanner ! » n'est jamais rendu dans ce mode.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return
    autoStartedRef.current = true
    void startCamera()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart])
  const warmingUp = !!autoStart && !isCameraActive

  const startCamera = async () => {
    try {
      // Start loading OpenCV worker in parallel
      loadOpenCVWorker().catch(err => {
        console.warn('OpenCV worker load failed:', err)
      })

      const RES = { width: { ideal: 3840 }, height: { ideal: 2160 } }

      // 1. Accès initial → déclenche la permission (et peuple les labels device).
      let mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', ...RES }
      })

      // 2. Épingle l'objectif principal pour empêcher la bascule d'optique macro.
      const mainId = await pickMainBackCameraId()
      const currentId = mediaStream.getVideoTracks()[0]?.getSettings().deviceId
      if (mainId && mainId !== currentId) {
        mediaStream.getTracks().forEach(t => t.stop())
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: mainId }, ...RES }
          })
        } catch (e) {
          console.warn('Épinglage objectif principal échoué, retour caméra par défaut:', e)
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', ...RES }
          })
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream
        // iOS Safari : sans muted + play() explicite, l'autoplay d'un flux caméra
        // est bloqué → la <video> reste blanche bien que le stream tourne.
        videoRef.current.muted = true
        videoRef.current.playsInline = true
        videoRef.current.play().catch(() => { /* autoplay best-effort */ })
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
      setError(playT('camera.error'))
    }
  }

  const stopCamera = useCallback(() => {
    if (detectionTimerRef.current) {
      clearTimeout(detectionTimerRef.current)
      detectionTimerRef.current = null
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
      playUi(newVal ? 'switchOn' : 'switchOff')
    } catch (err: any) {
      console.warn('Torch toggle failed:', err.message)
    }
  }, [stream, torchOn])

  // Détection des 4 repères L sur une image statique (worker OpenCV), one-shot.
  // Utilisé pour valider un import en play. Résout `null` si non détectés / timeout.
  const detectMarkersOnImageData = useCallback((imageData: ImageData) => {
    return new Promise<Point2D[] | null>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (result: Point2D[] | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        setDetectCallback(null)
        resolve(result)
      }
      timer = setTimeout(() => finish(null), 5000)
      setDetectCallback((corners) => finish(corners && corners.length === 4 ? corners : null))
      if (!detectFrame(imageData)) finish(null)
    })
  }, [])

  const handleImportImage = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const img = new Image()
    img.onload = () => {
      void (async () => {
        try {
          if (!requireMarkers) {
            // ADMIN : recadrage carré centré (fallback historique, corners=null).
            const size = Math.min(img.width, img.height)
            const sx = (img.width - size) / 2
            const sy = (img.height - size) / 2
            const canvas = document.createElement('canvas')
            canvas.width = size
            canvas.height = size
            canvas.getContext('2d')!.drawImage(img, sx, sy, size, size, 0, 0, size, size)
            canvas.toBlob((blob) => {
              if (blob) onCapture(blob, null)
              else setError('Erreur lors de l\'import. Veuillez reessayer.')
            }, 'image/jpeg', 0.95)
            return
          }

          // PLAY (vie privée) : on n'accepte l'import QUE si les 4 repères L sont
          // détectés (une vraie page coloriée PicoPop). Une photo quelconque
          // (mur, visage) n'a pas de repères → rejet. C'est aussi le flux du
          // réviseur (importer l'image de test fournie).
          if (isCameraActive) stopCamera()
          await loadOpenCVWorker()

          // Image pleine résolution = source du warp ; les coins sont dans SON repère.
          const full = document.createElement('canvas')
          full.width = img.width
          full.height = img.height
          full.getContext('2d')!.drawImage(img, 0, 0)

          // Détection sur une version réduite (~720px), comme le flux caméra.
          const scale = 720 / Math.max(img.width, img.height)
          const dw = Math.max(1, Math.round(img.width * scale))
          const dh = Math.max(1, Math.round(img.height * scale))
          const small = document.createElement('canvas')
          small.width = dw
          small.height = dh
          const sctx = small.getContext('2d')!
          sctx.drawImage(img, 0, 0, dw, dh)
          const detected = await detectMarkersOnImageData(sctx.getImageData(0, 0, dw, dh))
          if (!detected) {
            setError(playT('camera.needMarkers'))
            return
          }
          const corners = detected.map((p) => ({
            x: Math.round(p.x / scale),
            y: Math.round(p.y / scale),
          }))
          full.toBlob((blob) => {
            if (blob) onCapture(blob, corners)
            else setError('Erreur lors de l\'import. Veuillez reessayer.')
          }, 'image/jpeg', 0.95)
        } catch {
          setError(playT('camera.needMarkers'))
        } finally {
          URL.revokeObjectURL(img.src)
        }
      })()
    }
    img.src = URL.createObjectURL(file)
  }, [onCapture, requireMarkers, isCameraActive, stopCamera, detectMarkersOnImageData])

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
  }, [getGuidePositions, drawCornerGuide])

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !captureCanvasRef.current) return

    playUi('shutter')
    setShowFlash(true)
    setTimeout(() => setShowFlash(false), 200)

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

    // VIE PRIVÉE (play) : pas de capture sans les 4 repères (garde-fou en plus du
    // bouton grisé, au cas où la stabilité serait perdue juste avant le déclic).
    if (requireMarkers && (!scaledCorners || scaledCorners.length !== 4)) {
      setError(playT('camera.needMarkers'))
      return
    }

    canvas.toBlob((blob) => {
      if (blob) {
        onCapture(blob, scaledCorners)
        stopCamera()
      } else {
        setError('Erreur lors de la capture. Veuillez reessayer.')
      }
    }, 'image/jpeg', 0.95)
  }, [getSquareCrop, onCapture, stopCamera, requireMarkers])

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
      setDetectCallback(null)
    }
  }, [isCameraActive, drawOverlay, getGuidePositions, getSquareCrop, opencvLoading])

  const getStatusText = () => {
    if (opencvLoading) return playT('camera.status.loading')
    if (allStable && !qualityIssue) return playT('camera.status.ready')

    if (qualityIssue === 'tooDark' || qualityIssue === 'tooBright' || qualityIssue === 'glare') {
      return issueMessage(qualityIssue)
    }

    if (allStable && qualityIssue) {
      return `${playT('camera.status.cornersOk')} — ${issueMessage(qualityIssue)}`
    }
    if (matchedCount > 0) {
      const suffix = qualityIssue ? ` — ${issueMessage(qualityIssue)}` : ''
      return `${matchedCount}/4 ${playT('camera.status.corners')}${suffix}`
    }

    if (qualityIssue) return issueMessage(qualityIssue)
    return playT('camera.status.align')
  }

  const getStatusClass = () => {
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
      {title && <h2 className="camera-title">{title}</h2>}
      <div className={isCameraActive || warmingUp ? 'camera-square' : 'camera-square camera-square--idle'}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="camera-video"
        />

        {isCameraActive && (
          <canvas ref={overlayRef} className="camera-guide-overlay" />
        )}


        {isCameraActive && (
          <div className={`camera-status-bar ${getStatusClass()}`}>
            {getStatusText()}
          </div>
        )}

        {!isCameraActive && !warmingUp && document.body.classList.contains('play-app') && (
          <div className="camera-idle-hero">
            <div className="camera-idle-illustration" aria-hidden="true">
              <Mascot size={120} gaze="pointer" />
              <svg className="camera-idle-cam" viewBox="0 0 64 50" fill="none">
                <rect x="3" y="13" width="58" height="32" rx="9" fill="#8b7cf0" />
                <path d="M22 13 l4 -7 h12 l4 7" fill="#8b7cf0" />
                <circle cx="32" cy="29" r="11" fill="#ffffff" />
                <circle cx="32" cy="29" r="7" fill="#ff8fae" />
                <circle cx="51" cy="21" r="2.5" fill="#ffffff" />
              </svg>
            </div>
            <p className="camera-idle-text text-preline">{playT('camera.idle.text')}</p>
            <p className="camera-idle-sub">{playT('camera.idle.sub')}</p>
            <div className="camera-tip-card">
              <span className="camera-tip-icon" aria-hidden="true">💡</span>
              <div>
                <strong>{playT('camera.tip.title')}</strong>
                <p>{playT('camera.tip.text')}</p>
              </div>
            </div>
          </div>
        )}

        {warmingUp && (
          <div className="camera-warming" aria-hidden="true">
            <span className="camera-warming-spinner" />
          </div>
        )}

        {showFlash && <div className="camera-flash" />}
      </div>

      <canvas ref={captureCanvasRef} style={{ display: 'none' }} />

      {error && <div className="camera-error-box">{error}</div>}

      <div className={isCameraActive ? 'camera-buttons camera-buttons--active-state' : 'camera-buttons camera-buttons--idle-state'}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleImportImage}
          style={{ display: 'none' }}
        />
        {!isCameraActive ? (
          warmingUp ? null : (
          <>
            <div className="camera-buttons-row">
              <span className="camera-start-wrap">
                {document.body.classList.contains('play-app') && (
                  <svg className="camera-start-arrow" viewBox="0 0 40 50" fill="none" aria-hidden="true">
                    <path d="M20 4 C12 16 28 25 20 40" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" />
                    <path d="M9 30 L20 43 L31 30" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                <button onClick={startCamera} className="btn-start-camera">
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-3px', marginRight: 8 }}>
                    <path d="M3 8.5A1.5 1.5 0 0 1 4.5 7H7l2-3h6l2 3h2.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                  {playT('camera.open')}
                </button>
              </span>
              <button onClick={() => fileInputRef.current?.click()} className="btn-import">
                {playT('camera.import')}
              </button>
            </div>
            <div className="camera-tips">
              <p className="camera-tips-title">Conseils pour une bonne photo :</p>
              <p>Posez le coloriage a plat sur une table</p>
              <p>Eclairage naturel, evitez les spots directs</p>
              <p>Evitez les ombres et les reflets</p>
              <p>Tenez le telephone au-dessus, parallele au papier</p>
            </div>
          </>
          )
        ) : (
          <div className="camera-buttons-row camera-buttons-row--active">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="btn-gallery"
              aria-label="Importer une image"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
                <circle cx="9" cy="10" r="1.6" />
                <path d="m4.5 17 4.5-4.5 3.5 3.5 3-3 4 4" />
              </svg>
            </button>
            <button
              onClick={capturePhoto}
              data-ui-sound="off"
              disabled={requireMarkers && !allStable}
              className={allStable && !qualityIssue ? 'btn-capture btn-capture--ready' : 'btn-capture'}
              aria-label="Capturer"
            >
              <span className="btn-capture-label">
                {requireMarkers && !allStable ? playT('camera.aimMarkers') : playT('camera.capture')}
              </span>
            </button>
            {torchSupported && (
              <button
                onClick={toggleTorch}
                data-ui-sound="off"
                className={torchOn ? 'btn-torch btn-torch--on' : 'btn-torch'}
                aria-label={torchOn ? 'Flash activé' : 'Flash'}
              >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" stroke="none">
                  <path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13L13 2Z" />
                </svg>
              </button>
            )}
            {!torchSupported && <span className="camera-controls-spacer" aria-hidden="true" />}
            <button onClick={stopCamera} className="btn-cancel">
              {playT('camera.cancel')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
