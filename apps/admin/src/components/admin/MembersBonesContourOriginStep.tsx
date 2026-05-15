import { useState, useEffect, useRef, useMemo } from 'react'
import type { ProjectStepView, Point2D, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { detectCurvatureExtrema, type CSSCandidate } from '../../utils/curvatureScaleSpace'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const N_EXTREMA = 20
const SNAP_RADIUS = 50  // px in video space for snap to extremum

/**
 * Étape 4 du pipeline members-bones : placement d'un point d'origine P0 sur le contour
 * SAM 2 lissé de chaque zone (à frame 0). Sélecteur de zone active comme dans
 * MembersBonesZonesStep. Le point est snappé au pixel du contour le plus proche
 * (rayon 30 px en coords vidéo).
 */
export default function MembersBonesContourOriginStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0

  // ----- State -----
  const [activeZoneId, setActiveZoneId] = useState<string>(() => zones[0]?.id ?? '')
  const [origins, setOrigins] = useState<Record<string, Point2D>>(() => mesh?.sam2ContourOrigins ?? {})
  const [hoveredCursor, setHoveredCursor] = useState<Point2D | null>(null)
  const [saving, setSaving] = useState(false)

  // Active zone's frame-0 contour (in video / mask coords)
  const activeContour: Point2D[] = useMemo(() => {
    if (!contoursAll) return []
    const polys = contoursAll[activeZoneId]
    if (!polys || polys.length === 0) return []
    return polys[0]
  }, [contoursAll, activeZoneId])

  // Detect curvature extrema on the active zone's frame-0 contour
  const activeExtrema: CSSCandidate[] = useMemo(() => {
    if (activeContour.length < 10) return []
    return detectCurvatureExtrema(activeContour, N_EXTREMA)
  }, [activeContour])

  // ----- Video element + canvas -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)

  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)

  // Load video frame 0
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

  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

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

  // ----- Coordinate conversions -----
  // canvas image coords (which match video pixel coords) ↔ mask coords (sam2VideoWidth/Height).
  // The video on canvas is drawn at native size (videoSize.w × videoSize.h).
  // sam2Contours are in mask pixel coords → scale via (videoSize / sam2Size).
  const maskToVideo = (p: Point2D): Point2D => ({
    x: (p.x / sam2W) * videoSize.w,
    y: (p.y / sam2H) * videoSize.h,
  })

  // Snap a video-space point to the nearest curvature extremum
  const snapToExtremum = (vp: Point2D): Point2D | null => {
    if (activeExtrema.length === 0) return null
    let bestDist = SNAP_RADIUS
    let bestPt: Point2D | null = null
    for (const ext of activeExtrema) {
      const ev = maskToVideo(ext.position)
      const d = Math.hypot(vp.x - ev.x, vp.y - ev.y)
      if (d < bestDist) {
        bestDist = d
        bestPt = ev
      }
    }
    return bestPt
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

      // Draw video frame 0
      ctx.drawImage(video, 0, 0)

      // Draw all zone contours (faded), and the active one prominently
      if (contoursAll && sam2W > 0 && sam2H > 0) {
        for (const z of zones) {
          const polys = contoursAll[z.id]
          if (!polys || polys.length === 0) continue
          const poly = polys[0]
          if (!poly || poly.length < 2) continue
          const isActive = z.id === activeZoneId
          ctx.strokeStyle = z.color
          ctx.globalAlpha = isActive ? 1 : 0.25
          ctx.lineWidth = (isActive ? 3 : 1.5) / t.scale
          ctx.beginPath()
          for (let i = 0; i < poly.length; i++) {
            const v = maskToVideo(poly[i])
            if (i === 0) ctx.moveTo(v.x, v.y)
            else ctx.lineTo(v.x, v.y)
          }
          ctx.closePath()
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }

      // Draw curvature extrema on active zone (orange dots)
      if (activeExtrema.length > 0) {
        for (let ei = 0; ei < activeExtrema.length; ei++) {
          const ext = activeExtrema[ei]
          const ev = maskToVideo(ext.position)
          const er = Math.max(3, 5 / t.scale)
          const alpha = 0.4 + 0.6 * (ext.score / (activeExtrema[0].score || 1))
          ctx.globalAlpha = alpha
          ctx.fillStyle = '#f97316'
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1 / t.scale
          ctx.beginPath()
          ctx.arc(ev.x, ev.y, er, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }

      // Draw existing P0 of every zone (small dot for inactive, large for active)
      for (const z of zones) {
        const p = origins[z.id]
        if (!p) continue
        const isActive = z.id === activeZoneId
        const r = (isActive ? 8 : 5) / t.scale
        ctx.fillStyle = z.color
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2 / t.scale
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        // Label "P0"
        if (isActive) {
          const labelSize = Math.max(9, 12 / t.scale)
          ctx.font = `bold ${labelSize}px sans-serif`
          ctx.fillStyle = '#fff'
          ctx.fillText('P0', p.x + r + 3 / t.scale, p.y - r)
        }
      }

      // Ghost cursor (snapped) for active zone
      if (hoveredCursor && activeExtrema.length > 0) {
        const snapped = snapToExtremum(hoveredCursor)
        if (snapped) {
          const r = 6 / t.scale
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'
          ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath()
          ctx.arc(snapped.x, snapped.y, r, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoReady, contoursAll, zones, activeZoneId, origins, hoveredCursor, activeExtrema, sam2W, sam2H, videoSize])

  // ----- Mouse handlers -----
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (spaceDown.current || isPanning.current) return
    if (activeExtrema.length === 0 || !activeZoneId) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const snapped = snapToExtremum(imgPos)
    if (!snapped) return
    setOrigins(prev => ({ ...prev, [activeZoneId]: snapped }))
  }

  function handleMouseMove(e: React.MouseEvent) {
    const imgPos = screenToImage(e.clientX, e.clientY)
    setHoveredCursor(imgPos)
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (!activeZoneId) return
    setOrigins(prev => {
      const next = { ...prev }
      delete next[activeZoneId]
      return next
    })
  }

  // ----- Save -----
  async function handleSave() {
    if (!mesh) return
    if (zones.length === 0) return
    const allFilled = zones.every(z => origins[z.id] != null)
    if (!allFilled) {
      alert('Toutes les zones doivent avoir un P0 placé.')
      return
    }
    setSaving(true)
    try {
      const updated = {
        ...mesh,
        sam2ContourOrigins: origins,
        // invalidate downstream
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
      await onSave({ ...project, mesh: updated })
    } catch (err) {
      console.error('[origin] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  }
  if (!mesh?.sam2ContoursValidated || !contoursAll) {
    return <div className="placeholder">Calculez d'abord les contours lissés (étape précédente).</div>
  }

  const filledCount = zones.filter(z => origins[z.id] != null).length

  return (
    <div className="triangulation-step">
      {/* Zone selector */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold', marginRight: 4 }}>Zone active :</span>
        {zones.map(z => {
          const isActive = z.id === activeZoneId
          const hasP0 = origins[z.id] != null
          return (
            <button
              key={z.id}
              onClick={() => setActiveZoneId(z.id)}
              style={{
                background: isActive ? z.color : 'transparent',
                color: isActive ? '#fff' : z.color,
                border: `2px solid ${z.color}`,
                padding: '4px 10px',
                borderRadius: 4,
                fontWeight: isActive ? 'bold' : 'normal',
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              {z.label} {hasP0 ? '✓' : ''}
            </button>
          )
        })}
      </div>

      <div className="triangulation-toolbar" style={{ gap: 8 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || filledCount < zones.length}
        >
          {saving ? 'Sauvegarde...' : `Valider (${filledCount}/${zones.length})`}
        </button>
        <button
          className="btn-danger"
          onClick={() => setOrigins({})}
          disabled={Object.keys(origins).length === 0}
        >
          Tout effacer
        </button>
      </div>

      <div className="triangulation-help">
        <span>
          Sélectionnez une zone, puis cliquez sur un extremum de courbure (point orange)
          pour y placer le P0. Clic droit = supprimer. Faites les {zones.length} zones avant de valider.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onContextMenu={handleContextMenu}
          style={{ cursor: 'crosshair' }}
        />
      </div>
    </div>
  )
}
