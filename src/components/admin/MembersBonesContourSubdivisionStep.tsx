import { useState, useEffect, useRef, useMemo } from 'react'
import type { ProjectStepView, Point2D, CurvilinearParam, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { reorderContourFromOrigin, subdivideContour } from '../../utils/curvilinearContour'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const DEFAULT_PER_SEGMENT = 3

/**
 * Étape 7 du pipeline members-bones : placement des points de subdivision entre les
 * anchors caractéristiques de chaque zone (à frame 0). Compteur par segment et global.
 * Calcul statique uniquement — la position par frame sera calculée à l'étape 8.
 *
 * Stocke `mesh.sam2ContourSubdivisionPoints: Record<zoneId, Point2D[]>`
 * et `mesh.sam2ContourSubdivisionParams: Record<zoneId, CurvilinearParam[]>` (en mask coords).
 */
export default function MembersBonesContourSubdivisionStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0
  const anchorsAll = useMemo(() => mesh?.sam2ContourAnchors ?? {}, [mesh?.sam2ContourAnchors])

  // ----- Video element + canvas (declared first so subdivision useMemo can read videoSize) -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  // ----- State -----
  const [activeZoneId, setActiveZoneId] = useState<string>(() => zones[0]?.id ?? '')
  // counts[zoneId] = number[] per segment
  // Segments: P0→1, 1→2, ..., n→P0 (anchors.length segments for anchors.length anchors, cyclic)
  const [counts, setCounts] = useState<Record<string, number[]>>(() => {
    const init: Record<string, number[]> = {}
    for (const z of zones) {
      const anchors = anchorsAll[z.id] ?? []
      const numSegments = Math.max(0, anchors.length)
      init[z.id] = new Array(numSegments).fill(DEFAULT_PER_SEGMENT)
    }
    return init
  })
  const [saving, setSaving] = useState(false)

  // Active zone's data
  const activeZone = zones.find(z => z.id === activeZoneId)
  const activeContour: Point2D[] = useMemo(() => {
    if (!contoursAll) return []
    const polys = contoursAll[activeZoneId]
    return polys?.[0] ?? []
  }, [contoursAll, activeZoneId])
  const activeAnchors: Point2D[] = useMemo(() => anchorsAll[activeZoneId] ?? [], [anchorsAll, activeZoneId])  // [P0, 1, 2, ..., n]

  // Compute the subdivision (mask coords) and convert to video coords for display.
  // Segments: P0→1, 1→2, ..., n→P0 (cyclic)
  const { subdivPointsVideo } = useMemo(() => {
    const result = { subdivPointsVideo: [] as Point2D[] }
    if (activeContour.length < 2 || activeAnchors.length < 2) return result
    if (sam2W === 0 || sam2H === 0) return result
    if (videoSize.w === 0 || videoSize.h === 0) return result

    // Reorder the contour from P0 (first anchor in video coords → mask coords)
    const p0Video = activeAnchors[0]
    const p0Mask: Point2D = {
      x: (p0Video.x / videoSize.w) * sam2W,
      y: (p0Video.y / videoSize.h) * sam2H,
    }
    const reordered = reorderContourFromOrigin(activeContour, p0Mask)

    // Convert ALL anchors to mask coords
    const anchorsMask = activeAnchors.map(a => ({
      x: (a.x / videoSize.w) * sam2W,
      y: (a.y / videoSize.h) * sam2H,
    }))

    // Counts per segment for active zone
    const segCounts = counts[activeZoneId] ?? []
    const normalizedCounts = anchorsMask.map((_, i) => segCounts[i] ?? DEFAULT_PER_SEGMENT)

    const { points } = subdivideContour(reordered, anchorsMask, normalizedCounts)

    // Convert mask coords back to video coords
    result.subdivPointsVideo = points.map(p => ({
      x: (p.x / sam2W) * videoSize.w,
      y: (p.y / sam2H) * videoSize.h,
    }))
    return result
  }, [activeContour, activeAnchors, counts, activeZoneId, sam2W, sam2H, videoSize])

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

      // Draw active zone's contour
      if (activeContour.length > 1 && activeZone) {
        const sx = videoSize.w / sam2W
        const sy = videoSize.h / sam2H
        ctx.strokeStyle = activeZone.color
        ctx.lineWidth = 2 / t.scale
        ctx.beginPath()
        for (let i = 0; i < activeContour.length; i++) {
          const v = { x: activeContour[i].x * sx, y: activeContour[i].y * sy }
          if (i === 0) ctx.moveTo(v.x, v.y)
          else ctx.lineTo(v.x, v.y)
        }
        ctx.closePath()
        ctx.stroke()
      }

      // Draw anchors (red, numbered) in video coords
      ctx.fillStyle = '#ef4444'
      ctx.strokeStyle = '#fff'
      const labelSize = Math.max(9, 11 / t.scale)
      ctx.font = `bold ${labelSize}px sans-serif`
      const ar = 6 / t.scale
      // P0 (smaller, pink)
      if (activeAnchors.length > 0) {
        const p0 = activeAnchors[0]
        ctx.fillStyle = '#ec4899'
        ctx.beginPath()
        ctx.arc(p0.x, p0.y, ar * 0.7, 0, Math.PI * 2)
        ctx.fill()
        ctx.lineWidth = 1.5 / t.scale
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.fillText('P0', p0.x + ar + 2 / t.scale, p0.y - ar)
      }
      // Non-P0 anchors (numbered 1..n)
      ctx.fillStyle = '#ef4444'
      for (let i = 1; i < activeAnchors.length; i++) {
        const p = activeAnchors[i]
        ctx.beginPath()
        ctx.arc(p.x, p.y, ar, 0, Math.PI * 2)
        ctx.fill()
        ctx.lineWidth = 1.5 / t.scale
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.fillText(String(i), p.x + ar + 2 / t.scale, p.y - ar)
        ctx.fillStyle = '#ef4444'
      }

      // Draw subdivision points (green) in video coords
      ctx.fillStyle = '#22c55e'
      ctx.strokeStyle = '#fff'
      const sr = 4 / t.scale
      for (const p of subdivPointsVideo) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, sr, 0, Math.PI * 2)
        ctx.fill()
        ctx.lineWidth = 1 / t.scale
        ctx.stroke()
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, activeContour, activeAnchors, activeZone, subdivPointsVideo, transformRef, sam2W, sam2H, videoSize])

  // ----- Counters -----
  function adjustSegment(segIdx: number, delta: number) {
    setCounts(prev => {
      const list = [...(prev[activeZoneId] ?? [])]
      list[segIdx] = Math.max(0, (list[segIdx] ?? DEFAULT_PER_SEGMENT) + delta)
      return { ...prev, [activeZoneId]: list }
    })
  }

  function adjustGlobal(delta: number) {
    setCounts(prev => {
      const list = (prev[activeZoneId] ?? []).map(c => Math.max(0, c + delta))
      return { ...prev, [activeZoneId]: list }
    })
  }

  // ----- Save -----
  async function handleSave() {
    if (!mesh) return
    if (zones.length === 0) return

    // Compute subdivision for ALL zones
    const allPoints: Record<string, Point2D[]> = {}
    const allParams: Record<string, CurvilinearParam[]> = {}
    for (const z of zones) {
      const polys = contoursAll?.[z.id]
      if (!polys || polys.length === 0) continue
      const contour0 = polys[0]
      const anchors = anchorsAll[z.id] ?? []
      if (contour0.length < 2 || anchors.length < 2) continue

      // Reorder contour from P0
      const p0Video = anchors[0]
      const p0Mask: Point2D = {
        x: (p0Video.x / videoSize.w) * sam2W,
        y: (p0Video.y / videoSize.h) * sam2H,
      }
      const reordered = reorderContourFromOrigin(contour0, p0Mask)
      const anchorsMask = anchors.map(a => ({
        x: (a.x / videoSize.w) * sam2W,
        y: (a.y / videoSize.h) * sam2H,
      }))
      const segCounts = counts[z.id] ?? []
      const normalized = anchorsMask.map((_, i) => segCounts[i] ?? DEFAULT_PER_SEGMENT)
      const { points, params } = subdivideContour(reordered, anchorsMask, normalized)
      allPoints[z.id] = points
      allParams[z.id] = params
    }

    setSaving(true)
    try {
      const updated = {
        ...mesh,
        sam2ContourSubdivisionPoints: allPoints,
        sam2ContourSubdivisionParams: allParams,
        sam2ContourSubdivisionValidated: true,
        // invalidate downstream tracking
        sam2ContourAnchorFrames: null,
        sam2ContourSubdivisionFrames: null,
        sam2ContourAnchorTrackingValidated: false,
      }
      await onSave({ ...project, mesh: updated })
    } catch (err) {
      console.error('[subdivision] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!project.videoBlob) return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContourAnchors || Object.keys(mesh.sam2ContourAnchors).length === 0) {
    return <div className="placeholder">Définissez d'abord les anchors par zone (étape précédente).</div>
  }

  const segCounts = counts[activeZoneId] ?? []
  const segTotal = segCounts.reduce((a, b) => a + b, 0)
  const filledZones = zones.filter(z => (anchorsAll[z.id]?.length ?? 0) >= 2).length

  return (
    <div className="triangulation-step">
      {/* Zone selector */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold', marginRight: 4 }}>Zone active :</span>
        {zones.map(z => {
          const isActive = z.id === activeZoneId
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
              {z.label}
            </button>
          )
        })}
      </div>

      {/* Global counter + actions */}
      <div className="triangulation-toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem' }}>Global :</span>
        <button onClick={() => adjustGlobal(-1)} disabled={segCounts.every(c => c === 0)}>−</button>
        <span style={{ minWidth: 30, textAlign: 'center', fontSize: '0.85rem' }}>{segTotal}</span>
        <button onClick={() => adjustGlobal(1)}>+</button>

        <span className="toolbar-separator" />

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || filledZones < zones.length}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>
      </div>

      {/* Per-segment counters: P0→1, 1→2, ..., n→P0 */}
      {activeAnchors.length >= 2 && (
        <div className="triangulation-toolbar" style={{ gap: 6, flexWrap: 'wrap', fontSize: '0.8rem' }}>
          <span>Par segment :</span>
          {activeAnchors.map((_: Point2D, i: number) => {
            const from = i === 0 ? 'P0' : String(i)
            const to = i === activeAnchors.length - 1 ? 'P0' : String(i + 1)
            return (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <span style={{ color: 'var(--color-muted)' }}>[{from}→{to}]</span>
                <button onClick={() => adjustSegment(i, -1)} style={{ padding: '0 6px' }}>−</button>
                <span style={{ minWidth: 16, textAlign: 'center' }}>{segCounts[i] ?? DEFAULT_PER_SEGMENT}</span>
                <button onClick={() => adjustSegment(i, 1)} style={{ padding: '0 6px' }}>+</button>
              </span>
            )
          })}
        </div>
      )}

      <div className="triangulation-help">
        <span>
          Subdivisez le contour de chaque zone entre les anchors. Les points (verts) sont calculés
          uniformément en arc-length. Les positions par frame seront calculées à l'étape suivante.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
