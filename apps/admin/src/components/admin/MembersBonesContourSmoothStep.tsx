import { useState, useEffect, useRef, useMemo } from 'react'
import type { ProjectStepView, Point2D, RLEMask, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { rleToContour, smoothPolygonGaussian, bridgeContourAtLegs, temporalSmoothContours } from '../../utils/sam2Contour'
import { decodeRLEMinusRLEs } from '../../utils/rleMask'
import { detectValidFrames, countInvalidFrames, DEFAULT_MIN_AREA_FRACTION } from '../../utils/sam2ValidFrames'
import { flowMaskToContour } from '../../utils/perspectiveCorrection'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const VIDEO_FPS = 24
const DEFAULT_SIGMA = 3
const BODY_ZONE_ID = 'body'
const isLegZoneId = (id: string) => id.startsWith('leg-')

/**
 * Étape 3 du pipeline members-bones : extraction des contours depuis les masques SAM 2 RLE
 * et lissage gaussien 1D. Stocke `mesh.sam2Contours: Record<zoneId, Point2D[][]>` qui sera
 * consommé par les étapes suivantes (P0, anchors, subdivision, tracking).
 *
 * Les contours sont en pixels VIDÉO (mêmes dimensions que les masques RLE).
 */
export default function MembersBonesContourSmoothStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const masks = mesh?.sam2MasksRLE ?? null
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0

  // Number of frames inferred from the first zone of masks
  const totalFrames = useMemo(() => {
    if (!masks) return 0
    const first = Object.values(masks)[0]
    return first?.length ?? 0
  }, [masks])

  // ----- State -----
  const [sigma, setSigma] = useState<number>(() => mesh?.sam2ContourSmoothSigma ?? DEFAULT_SIGMA)
  const [bridgeThreshold, setBridgeThreshold] = useState(8)
  const [minAreaPct, setMinAreaPct] = useState<number>(() =>
    (mesh?.sam2ZoneMinAreaFraction ?? DEFAULT_MIN_AREA_FRACTION) * 100
  )
  const [contours, setContours] = useState<Record<string, Point2D[][]> | null>(() => mesh?.sam2Contours ?? null)
  const validFrames = useMemo(() => {
    if (!masks) return null
    return detectValidFrames(masks, minAreaPct / 100)
  }, [masks, minAreaPct])
  const invalidCounts = useMemo(() => (validFrames ? countInvalidFrames(validFrames) : {}), [validFrames])
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [saving, setSaving] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)

  // ----- Video element + canvas -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)

  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  // Load video + seek to frame 0
  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      video.currentTime = 0
      video.onseeked = () => {
        videoRef.current = video
        setVideoSize({ w: video.videoWidth, h: video.videoHeight })
        setVideoReady(true)
      }
    }
    video.load()
    return () => {
      video.pause()
      URL.revokeObjectURL(url)
      videoRef.current = null
      fittedRef.current = false
    }
  }, [project.videoBlob])

  // Fit canvas
  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Seek video to currentFrame
  useEffect(() => {
    if (!videoReady) return
    const video = videoRef.current
    if (!video) return
    video.currentTime = currentFrame / VIDEO_FPS
  }, [currentFrame, videoReady])

  // Reset frame to 0 when contours change. React official pattern:
  // store previous value in state, compare during render, setState during render is safe.
  const [prevContours, setPrevContours] = useState<Record<string, Point2D[][]> | null>(contours)
  if (prevContours !== contours) {
    setPrevContours(contours)
    setCurrentFrame(0)
  }

  // Draw loop
  useEffect(() => {
    let running = true
    let rafId = 0
    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video || !videoReady) {
        rafId = requestAnimationFrame(draw)
        return
      }
      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr
      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)

      // Draw current video frame
      ctx.drawImage(video, 0, 0)

      // Draw smoothed contours of each zone (if computed)
      if (contours && sam2W > 0 && sam2H > 0) {
        const sx = videoSize.w / sam2W
        const sy = videoSize.h / sam2H
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        for (const z of zones) {
          const polys = contours[z.id]
          if (!polys || polys.length === 0) continue
          const poly = polys[safeFrame]
          if (!poly || poly.length < 2) continue
          const isInvalid = validFrames?.[z.id]?.[safeFrame] === false
          ctx.strokeStyle = z.color
          ctx.lineWidth = 2 / t.scale
          ctx.setLineDash(isInvalid ? [8 / t.scale, 6 / t.scale] : [])
          ctx.beginPath()
          ctx.moveTo(poly[0].x * sx, poly[0].y * sy)
          for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(poly[i].x * sx, poly[i].y * sy)
          }
          ctx.closePath()
          ctx.stroke()
          ctx.setLineDash([])
        }
      }

      ctx.restore()

      // Invalid-frame overlay (CSS coords, on top of transform)
      if (validFrames) {
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        const invalidZones = zones.filter(z => validFrames[z.id]?.[safeFrame] === false)
        if (invalidZones.length > 0) {
          ctx.save()
          ctx.strokeStyle = '#ef4444'
          ctx.lineWidth = 6
          ctx.setLineDash([12, 8])
          ctx.strokeRect(3, 3, cssW - 6, cssH - 6)
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(239, 68, 68, 0.92)'
          ctx.fillRect(0, 0, cssW, 28)
          ctx.fillStyle = '#fff'
          ctx.font = 'bold 13px sans-serif'
          ctx.textBaseline = 'middle'
          const label = `Frame ${safeFrame} invalide — zones perdues : ${invalidZones.map(z => z.id).join(', ')}`
          ctx.fillText(label, 10, 14)
          ctx.restore()
        }
      }

      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, contours, currentFrame, transformRef, zones, sam2W, sam2H, videoSize, totalFrames, validFrames])

  // ----- Compute contours for all zones × all frames -----
  async function handleCompute() {
    if (!masks) return
    setComputing(true)
    const zoneIds = zones.map(z => z.id)
    const legZoneIds = zoneIds.filter(isLegZoneId)
    const total = zoneIds.length * totalFrames
    setProgress({ current: 0, total })

    const newContours: Record<string, Point2D[][]> = {}
    let done = 0
    try {
      // Compute leg contours FIRST (body needs them for bridging)
      const nonBodyIds = zoneIds.filter(z => z !== BODY_ZONE_ID)
      for (const zid of nonBodyIds) {
        const zoneMasks = masks[zid]
        if (!zoneMasks) {
          newContours[zid] = []
          continue
        }
        const polys: Point2D[][] = new Array(zoneMasks.length)
        for (let f = 0; f < zoneMasks.length; f++) {
          const raw = await rleToContour(zoneMasks[f])
          polys[f] = raw.length > 0 ? smoothPolygonGaussian(raw, sigma) : []
          done++
          if (done % 5 === 0 || done === total) {
            setProgress({ current: done, total })
            await new Promise(r => setTimeout(r, 0))
          }
        }
        newContours[zid] = polys
      }

      // Now compute body contour with mask subtraction + bridge at leg contours
      const bodyMasks = masks[BODY_ZONE_ID]
      if (bodyMasks && legZoneIds.length > 0) {
        const polys: Point2D[][] = new Array(bodyMasks.length)
        for (let f = 0; f < bodyMasks.length; f++) {
          const rle: RLEMask = bodyMasks[f]
          // Subtract leg masks from body
          const legRles = legZoneIds
            .map(lid => masks[lid]?.[f])
            .filter((r): r is RLEMask => !!r)
          const [h, w] = rle.size
          const subtractedMask = decodeRLEMinusRLEs(rle, legRles)
          let raw = await flowMaskToContour(subtractedMask, w, h)
          // Bridge: skip portions of body contour that run along leg contours
          if (raw.length > 0) {
            const legContoursForFrame = legZoneIds
              .map(lid => newContours[lid]?.[f])
              .filter((c): c is Point2D[] => !!c && c.length > 0)
            if (legContoursForFrame.length > 0) {
              raw = bridgeContourAtLegs(raw, legContoursForFrame, bridgeThreshold)
            }
          }
          polys[f] = raw.length > 0 ? smoothPolygonGaussian(raw, sigma) : []
          done++
          if (done % 5 === 0 || done === total) {
            setProgress({ current: done, total })
            await new Promise(r => setTimeout(r, 0))
          }
        }
        // Temporal smoothing to eliminate frame-to-frame bridge jitter
        newContours[BODY_ZONE_ID] = temporalSmoothContours(polys)
      } else if (bodyMasks) {
        // No legs — compute body normally
        const polys: Point2D[][] = new Array(bodyMasks.length)
        for (let f = 0; f < bodyMasks.length; f++) {
          const raw = await rleToContour(bodyMasks[f])
          polys[f] = raw.length > 0 ? smoothPolygonGaussian(raw, sigma) : []
          done++
          if (done % 5 === 0 || done === total) {
            setProgress({ current: done, total })
            await new Promise(r => setTimeout(r, 0))
          }
        }
        newContours[BODY_ZONE_ID] = polys
      }

      setContours(newContours)
    } catch (err) {
      console.error('[smooth] failed:', err)
      alert('Erreur calcul contours : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
    setProgress({ current: 0, total: 0 })
  }

  // ----- Save -----
  async function handleSave() {
    if (!mesh || !contours) return
    setSaving(true)
    try {
      const updated = {
        ...mesh,
        sam2Contours: contours,
        sam2ContourSmoothSigma: sigma,
        sam2ContoursValidated: true,
        sam2ZoneValidFrames: validFrames,
        sam2ZoneMinAreaFraction: minAreaPct / 100,
        // invalidate downstream zones
        sam2ContourOrigins: undefined,
        sam2ContourOriginFrames: null,
        sam2ContourOriginTrackingValidated: false,
        sam2ContourAnchors: undefined,
        sam2ContourSubdivisionPoints: undefined,
        sam2ContourSubdivisionParams: undefined,
        sam2ContourSubdivisionValidated: false,
        sam2ContourAnchorFrames: null,
        sam2ContourSubdivisionFrames: null,
        sam2ContourAnchorTrackingValidated: false,
      }
      await onSave({ ...project, mesh: updated }, ['sam2Contours'])
    } catch (err) {
      console.error('[smooth] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  }
  if (!masks || !mesh?.sam2Validated) {
    return <div className="placeholder">Calculez d'abord les masques SAM 2 (étape 2).</div>
  }
  if (totalFrames === 0) {
    return <div className="placeholder">Aucune frame de masque disponible.</div>
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Lissage gaussien</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.85rem' }}>σ :</span>
          <input
            type="range"
            min={1}
            max={10}
            step={0.5}
            value={sigma}
            onChange={(e) => setSigma(parseFloat(e.target.value))}
            disabled={computing}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: '0.85rem', minWidth: 28, textAlign: 'right' }}>{sigma.toFixed(1)}</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.85rem' }}>Bridge :</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={bridgeThreshold}
            onChange={(e) => setBridgeThreshold(parseInt(e.target.value))}
            disabled={computing}
            style={{ width: 100 }}
          />
          <span style={{ fontSize: '0.85rem', minWidth: 28, textAlign: 'right' }}>{bridgeThreshold}px</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.85rem' }}>Aire min :</span>
          <input
            type="range"
            min={0.1}
            max={5}
            step={0.1}
            value={minAreaPct}
            onChange={(e) => setMinAreaPct(parseFloat(e.target.value))}
            disabled={computing}
            style={{ width: 100 }}
          />
          <span style={{ fontSize: '0.85rem', minWidth: 36, textAlign: 'right' }}>{minAreaPct.toFixed(1)}%</span>
        </label>

        <button
          className="btn-primary"
          onClick={handleCompute}
          disabled={computing}
        >
          {computing
            ? `Calcul ${progress.current}/${progress.total}`
            : (contours ? 'Recalculer contours' : 'Calculer contours lissés')}
        </button>

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || computing || !contours}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>

        <span className="toolbar-info">
          {zones.length} zones × {totalFrames} frames
          {contours ? ' | ✓ Contours calculés' : ''}
        </span>
      </div>

      {validFrames && Object.values(invalidCounts).some(n => n > 0) && (
        <div style={{ padding: '4px 16px', fontSize: '0.8rem', color: '#f59e0b' }}>
          ⚠ Frames invalides détectées (zone occultée) :{' '}
          {Object.entries(invalidCounts)
            .filter(([, n]) => n > 0)
            .map(([z, n]) => `${z}: ${n}`)
            .join(' · ')}
          {' '}— les positions seront interpolées au tracking V3.
        </div>
      )}

      <div className="triangulation-help">
        <span>
          Le lissage gaussien réduit le bruit pixel-par-pixel des masques SAM 2. Augmentez σ pour
          un contour plus doux (perd des détails fins), diminuez pour préserver les détails (garde le bruit).
          Recalculer après chaque changement de σ. La zone body est automatiquement nettoyée :
          les masques des pattes sont soustraits du masque body avant extraction du contour.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas ref={canvasRef} />
      </div>

      {contours && totalFrames > 0 && (
        <>
          <div style={{
            padding: '6px 16px',
            fontSize: '0.8rem',
            color: 'var(--color-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ fontWeight: 'bold', color: 'var(--color-text)' }}>Preview contours lissés</span>
            <span>Frame {currentFrame + 1} / {totalFrames}</span>
          </div>
          {validFrames && (
            <div style={{ padding: '0 16px 4px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {zones.map(z => {
                const v = validFrames[z.id]
                if (!v || v.length === 0) return null
                const invalidCount = v.filter(b => !b).length
                return (
                  <div key={z.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.7rem' }}>
                    <span style={{ width: 70, color: z.color, fontWeight: 'bold' }}>{z.id}</span>
                    <div
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        const f = Math.round(((e.clientX - rect.left) / rect.width) * (v.length - 1))
                        setCurrentFrame(Math.max(0, Math.min(v.length - 1, f)))
                      }}
                      style={{
                        position: 'relative',
                        flex: 1,
                        height: 10,
                        background: '#2a2a2a',
                        borderRadius: 2,
                        cursor: 'pointer',
                        overflow: 'hidden',
                      }}
                      title={`${invalidCount} frame${invalidCount !== 1 ? 's' : ''} invalide${invalidCount !== 1 ? 's' : ''}`}
                    >
                      {v.map((ok, i) => ok ? null : (
                        <div
                          key={i}
                          style={{
                            position: 'absolute',
                            left: `${(i / v.length) * 100}%`,
                            width: `${Math.max(100 / v.length, 0.5)}%`,
                            top: 0,
                            bottom: 0,
                            background: '#ef4444',
                          }}
                        />
                      ))}
                      {/* Cursor */}
                      <div style={{
                        position: 'absolute',
                        left: `${(currentFrame / Math.max(v.length - 1, 1)) * 100}%`,
                        top: -1,
                        bottom: -1,
                        width: 2,
                        background: '#fff',
                        transform: 'translateX(-1px)',
                      }} />
                    </div>
                    <span style={{ width: 50, textAlign: 'right', color: invalidCount > 0 ? '#ef4444' : 'var(--color-muted)' }}>
                      {invalidCount > 0 ? `${invalidCount} ✗` : 'ok'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          <FrameNavigator
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            editedFrames={EMPTY_SET}
            onNavigate={setCurrentFrame}
          />
        </>
      )}
    </div>
  )
}

const EMPTY_SET: Set<number> = new Set()
