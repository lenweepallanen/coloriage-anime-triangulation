import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { ProjectStepView, Point2D, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'
import { detectCurvatureExtrema, computeInitialAnchorArcLengths } from '../../utils/curvatureScaleSpace'
import { computeArcLengths, reorderContourFromOrigin } from '../../utils/curvilinearContour'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const SNAP_RADIUS = 30  // mask coords (px)

/**
 * Étape 6 du pipeline members-bones : placement des anchors caractéristiques sur le
 * contour SAM 2 lissé de chaque zone (à frame 0). Sélecteur de zone, P0 inclus
 * automatiquement comme premier anchor (pattern identique à ContourAnchorsStep
 * du pipeline rest). Auto-détection par courbure.
 *
 * Stocke `mesh.sam2ContourAnchors: Record<zoneId, Point2D[]>` où chaque liste
 * commence par P0.
 */
export default function MembersBonesContourAnchorsStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null
  const origins = mesh?.sam2ContourOrigins ?? {}
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0

  // ----- State -----
  const [activeZoneId, setActiveZoneId] = useState<string>(() => zones[0]?.id ?? '')
  const [autoCount, setAutoCount] = useState(6)
  // Per-zone "extra" anchors (not including P0). P0 is added implicitly when saving.
  const [anchorsExtra, setAnchorsExtra] = useState<Record<string, Point2D[]>>(() => {
    const init: Record<string, Point2D[]> = {}
    const stored = mesh?.sam2ContourAnchors
    if (stored) {
      for (const z of zones) {
        const arr = stored[z.id]
        if (arr && arr.length > 0) {
          init[z.id] = arr.slice(1) // remove P0 (first element)
        }
      }
    }
    return init
  })
  const [hoveredCursor, setHoveredCursor] = useState<Point2D | null>(null)
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  // Active zone's frame-0 contour (mask coords)
  const activeContour: Point2D[] = useMemo(() => {
    if (!contoursAll) return []
    const polys = contoursAll[activeZoneId]
    return polys?.[0] ?? []
  }, [contoursAll, activeZoneId])

  const activeContourIndex = useMemo(() => {
    if (activeContour.length === 0) return null
    return new ContourSpatialIndex(activeContour, 8)
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

  // ----- Coord conversions: video <-> mask -----
  const videoToMask = (p: Point2D): Point2D => ({
    x: (p.x / videoSize.w) * sam2W,
    y: (p.y / videoSize.h) * sam2H,
  })
  const maskToVideo = (p: Point2D): Point2D => ({
    x: (p.x / sam2W) * videoSize.w,
    y: (p.y / sam2H) * videoSize.h,
  })
  const snapToContour = useCallback((vp: Point2D): Point2D | null => {
    if (!activeContourIndex) return null
    const mp = videoToMask(vp)
    const hit = activeContourIndex.nearest(mp, SNAP_RADIUS)
    if (!hit) return null
    return maskToVideo(hit.point)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContourIndex, sam2W, sam2H, videoSize])

  // Hit test against current zone's anchors (video coords)
  const hitTest = useCallback((p: Point2D): number | null => {
    const list = anchorsExtra[activeZoneId] ?? []
    const hitR = 12 / transformRef.current.scale
    const hitR2 = hitR * hitR
    for (let i = list.length - 1; i >= 0; i--) {
      const dx = list[i].x - p.x
      const dy = list[i].y - p.y
      if (dx * dx + dy * dy <= hitR2) return i
    }
    return null
  }, [anchorsExtra, activeZoneId, transformRef])

  // ----- Sort anchors along contour REORDERED from P0 to keep order monotonic -----
  const sortAnchorsByContourOrder = useCallback((list: Point2D[]): Point2D[] => {
    if (activeContour.length < 2 || list.length < 2) return list
    // Reorder contour from P0 so arc-length 0 starts at P0
    const p0Video = origins[activeZoneId]
    if (!p0Video) return list
    const p0Mask: Point2D = {
      x: (p0Video.x / videoSize.w) * sam2W,
      y: (p0Video.y / videoSize.h) * sam2H,
    }
    const reordered = reorderContourFromOrigin(activeContour, p0Mask)
    const arc = computeArcLengths(reordered)
    // Convert to mask coords for arc-length comparison
    const maskList = list.map(videoToMask)
    const arcs = computeInitialAnchorArcLengths(maskList, reordered, arc)
    const indexed = list.map((p, i) => ({ p, s: arcs[i] }))
    indexed.sort((a, b) => a.s - b.s)
    return indexed.map(x => x.p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeContour, origins, activeZoneId, sam2W, sam2H, videoSize])

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

      // Draw all zone contours, prominent for active zone
      if (contoursAll && sam2W > 0 && sam2H > 0) {
        for (const z of zones) {
          const polys = contoursAll[z.id]
          if (!polys || polys.length === 0) continue
          const poly = polys[0]
          if (!poly || poly.length < 2) continue
          const isActive = z.id === activeZoneId
          ctx.strokeStyle = z.color
          ctx.globalAlpha = isActive ? 1 : 0.2
          ctx.lineWidth = (isActive ? 3 : 1) / t.scale
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

      // Draw P0 (read-only) for active zone
      const p0 = origins[activeZoneId]
      const activeZone = zones.find(z => z.id === activeZoneId)
      if (p0 && activeZone) {
        const r = 8 / t.scale
        ctx.fillStyle = activeZone.color
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 2 / t.scale
        ctx.beginPath()
        ctx.arc(p0.x, p0.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        const labelSize = Math.max(9, 12 / t.scale)
        ctx.font = `bold ${labelSize}px sans-serif`
        ctx.fillStyle = '#fff'
        ctx.fillText('P0', p0.x + r + 3 / t.scale, p0.y - r)
      }

      // Draw extra anchors of active zone (numbered, color = zone color)
      const list = anchorsExtra[activeZoneId] ?? []
      const labelSize = Math.max(9, 11 / t.scale)
      for (let i = 0; i < list.length; i++) {
        const p = list[i]
        const isDragging = draggingIdx === i
        const r = (isDragging ? 9 : 6) / t.scale
        ctx.fillStyle = isDragging ? '#22c55e' : (activeZone?.color ?? '#f59e0b')
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.5 / t.scale
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        // Label index (anchor index in [P0, ...extras] = i+1)
        ctx.font = `bold ${labelSize}px sans-serif`
        ctx.fillStyle = '#fff'
        ctx.fillText(String(i + 1), p.x + r + 2 / t.scale, p.y - r)
      }

      // Ghost cursor
      if (hoveredCursor && activeContourIndex) {
        const snapped = snapToContour(hoveredCursor)
        if (snapped) {
          const rr = 6 / t.scale
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'
          ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath()
          ctx.arc(snapped.x, snapped.y, rr, 0, Math.PI * 2)
          ctx.stroke()
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoReady, contoursAll, zones, activeZoneId, anchorsExtra, origins, hoveredCursor, draggingIdx, transformRef, sam2W, sam2H, videoSize, activeContourIndex])

  // ----- Mouse handlers -----
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (spaceDown.current || isPanning.current) return
    if (!activeContourIndex) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const idx = hitTest(imgPos)
    if (idx !== null) {
      setDraggingIdx(idx)
    } else {
      const snapped = snapToContour(imgPos)
      if (!snapped) return
      setAnchorsExtra(prev => {
        const list = [...(prev[activeZoneId] ?? []), snapped]
        return { ...prev, [activeZoneId]: sortAnchorsByContourOrder(list) }
      })
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const imgPos = screenToImage(e.clientX, e.clientY)
    setHoveredCursor(imgPos)
    if (draggingIdx !== null) {
      const snapped = snapToContour(imgPos)
      if (!snapped) return
      setAnchorsExtra(prev => {
        const list = [...(prev[activeZoneId] ?? [])]
        list[draggingIdx] = snapped
        return { ...prev, [activeZoneId]: list }
      })
    }
  }

  function handleMouseUp() {
    if (draggingIdx !== null) {
      // Re-sort after drag
      setAnchorsExtra(prev => {
        const list = prev[activeZoneId] ?? []
        return { ...prev, [activeZoneId]: sortAnchorsByContourOrder(list) }
      })
    }
    setDraggingIdx(null)
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (spaceDown.current || isPanning.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const idx = hitTest(imgPos)
    if (idx === null) return
    setAnchorsExtra(prev => {
      const list = (prev[activeZoneId] ?? []).filter((_, i) => i !== idx)
      return { ...prev, [activeZoneId]: list }
    })
  }

  // ----- Auto-detect by curvature -----
  function handleAutoDetect() {
    if (activeContour.length < 10) return
    const candidates = detectCurvatureExtrema(activeContour, autoCount)
    // Convert mask coords → video coords + filter near P0 (< 20px in mask)
    const p0Video = origins[activeZoneId]
    const p0Mask = p0Video ? videoToMask(p0Video) : null
    const filtered = candidates.filter(c => {
      if (!p0Mask) return true
      const dx = c.position.x - p0Mask.x
      const dy = c.position.y - p0Mask.y
      return Math.sqrt(dx * dx + dy * dy) > 20
    })
    const newPoints = filtered.map(c => maskToVideo(c.position))
    setAnchorsExtra(prev => ({
      ...prev,
      [activeZoneId]: sortAnchorsByContourOrder(newPoints),
    }))
  }

  // ----- Save -----
  async function handleSave() {
    if (!mesh) return
    if (zones.length === 0) return
    // Build the final stored map: each zone = [P0, ...extras]
    const result: Record<string, Point2D[]> = {}
    for (const z of zones) {
      const p0 = origins[z.id]
      if (!p0) continue
      const extras = anchorsExtra[z.id] ?? []
      result[z.id] = [p0, ...extras]
    }
    const allFilled = zones.every(z => (result[z.id]?.length ?? 0) >= 1)
    if (!allFilled) {
      alert('Toutes les zones doivent avoir P0 + au moins un anchor.')
      return
    }
    setSaving(true)
    try {
      const updated = {
        ...mesh,
        sam2ContourAnchors: result,
        // invalidate downstream
        sam2ContourSubdivisionPoints: undefined,
        sam2ContourSubdivisionParams: undefined,
        sam2ContourSubdivisionValidated: false,
        sam2ContourAnchorFrames: null,
        sam2ContourSubdivisionFrames: null,
        sam2ContourAnchorTrackingValidated: false,
      }
      await onSave({ ...project, mesh: updated })
    } catch (err) {
      console.error('[anchors] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!project.videoBlob) return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContourOriginTrackingValidated) {
    return <div className="placeholder">Validez d'abord le tracking P0 (étape précédente).</div>
  }

  const filledCount = zones.filter(z => (anchorsExtra[z.id]?.length ?? 0) >= 1).length

  return (
    <div className="triangulation-step">
      {/* Zone selector */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold', marginRight: 4 }}>Zone active :</span>
        {zones.map(z => {
          const isActive = z.id === activeZoneId
          const count = (anchorsExtra[z.id]?.length ?? 0)
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
              {z.label} ({count})
            </button>
          )
        })}
      </div>

      <div className="triangulation-toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-secondary" onClick={handleAutoDetect}>
          Auto-détecter (courbure)
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
          N pts :
          <input
            type="range"
            min={4}
            max={20}
            value={autoCount}
            onChange={(e) => setAutoCount(parseInt(e.target.value))}
            style={{ width: 100 }}
          />
          <span style={{ minWidth: 18 }}>{autoCount}</span>
        </label>
        <span className="toolbar-separator" />
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || filledCount < zones.length}
        >
          {saving ? 'Sauvegarde...' : `Valider (${filledCount}/${zones.length})`}
        </button>
        <button
          className="btn-danger"
          onClick={() => setAnchorsExtra(prev => ({ ...prev, [activeZoneId]: [] }))}
          disabled={(anchorsExtra[activeZoneId]?.length ?? 0) === 0}
        >
          Effacer zone
        </button>
      </div>

      <div className="triangulation-help">
        <span>
          Clic = ajouter (snap au contour, rayon {SNAP_RADIUS}px) | Glisser = déplacer | Clic droit = supprimer.
          P0 (cercle large) est inclus automatiquement comme premier anchor.
          Les anchors sont triés automatiquement le long du contour.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          style={{ cursor: 'crosshair' }}
        />
      </div>
    </div>
  )
}
