import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, MeshData, CurvilinearParam } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'
import {
  orderContourPixels,
  subdivideContour,
} from '../../utils/curvilinearContour'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

const ANCHOR_RADIUS = 7
const SUB_RADIUS = 5

export default function ContourSubdivisionStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const contourAnchors = mesh?.contourAnchors ?? []
  const cannyParams = mesh?.cannyParams
  const numSegments = contourAnchors.length

  // Infer initial per-segment counts from saved data
  function inferInitialCounts(): number[] {
    const params = mesh?.contourSubdivisionParams ?? []
    if (params.length > 0) {
      const counts = new Array(numSegments).fill(0)
      for (const p of params) {
        if (p.segmentIndex < numSegments) counts[p.segmentIndex]++
      }
      return counts
    }
    return new Array(numSegments).fill(3)
  }

  const [countsPerSegment, setCountsPerSegment] = useState<number[]>(inferInitialCounts)
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null)
  const [subdivisionPoints, setSubdivisionPoints] = useState<Point2D[]>(
    mesh?.contourSubdivisionPoints ?? []
  )
  const [subdivisionParams, setSubdivisionParams] = useState<CurvilinearParam[]>(
    mesh?.contourSubdivisionParams ?? []
  )
  const [orderedContour, setOrderedContour] = useState<Point2D[] | null>(null)
  const [cannyPixels, setCannyPixels] = useState<Point2D[] | null>(null)
  const [loadingContour, setLoadingContour] = useState(false)
  const [saving, setSaving] = useState(false)

  // Canvas + image
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  const {
    transformRef,
    fitToCanvas,
  } = useCanvasInteraction(canvasRef)

  // Load image
  useEffect(() => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.onload = () => {
      imageRef.current = img
      fitToCanvas(img.naturalWidth, img.naturalHeight)
    }
    img.src = url
    return () => {
      URL.revokeObjectURL(url)
      imageRef.current = null
    }
  }, [project.originalImageBlob, fitToCanvas])

  // Detect and order Canny contour on image
  useEffect(() => {
    if (!project.originalImageBlob || !cannyParams) return
    let cancelled = false

    async function detect() {
      setLoadingContour(true)
      try {
        await loadOpenCVWorker()
        const img = new Image()
        const url = URL.createObjectURL(project.originalImageBlob!)
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = reject
          img.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        URL.revokeObjectURL(url)

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const contourPts = await flowCannyContour(
          imageData,
          cannyParams!.lowThreshold,
          cannyParams!.highThreshold,
          cannyParams!.blurSize
        )

        if (cancelled) return
        if (contourPts && contourPts.length > 0) {
          setCannyPixels(contourPts)
          const ordered = orderContourPixels(contourPts)
          setOrderedContour(ordered)
        }
      } catch (err) {
        console.error('Failed to detect contour:', err)
      } finally {
        if (!cancelled) setLoadingContour(false)
      }
    }

    detect()
    return () => { cancelled = true }
  }, [project.originalImageBlob, cannyParams])

  // Regenerate subdivision when counts change or contour is ready
  useEffect(() => {
    if (!orderedContour || contourAnchors.length < 3) return
    const { points, params } = subdivideContour(orderedContour, contourAnchors, countsPerSegment)
    setSubdivisionPoints(points)
    setSubdivisionParams(params)
  }, [orderedContour, contourAnchors, countsPerSegment])

  // Update a single segment count
  const setSegmentCount = useCallback((segIndex: number, delta: number) => {
    setCountsPerSegment(prev => {
      const next = [...prev]
      next[segIndex] = Math.max(0, (next[segIndex] ?? 0) + delta)
      return next
    })
  }, [])

  // Apply delta to all segments
  const adjustAll = useCallback((delta: number) => {
    setCountsPerSegment(prev => prev.map(c => Math.max(0, c + delta)))
  }, [])

  // ─── Canvas draw ─────────────────────────────────────────────────
  const drawScene = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    const t = transformRef.current

    // Draw image
    if (img) {
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)
      ctx.drawImage(img, 0, 0)
      ctx.restore()
    }

    // Draw Canny contour as thin overlay
    if (cannyPixels && cannyPixels.length > 0) {
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)
      ctx.fillStyle = 'rgba(255, 220, 50, 0.35)'
      const pixSize = Math.max(1, 1 / t.scale)
      for (const p of cannyPixels) {
        ctx.fillRect(p.x - pixSize / 2, p.y - pixSize / 2, pixSize, pixSize)
      }
      ctx.restore()
    }

    // Build full ordered contour for polygon drawing
    const fullContour = buildOrderedContour(contourAnchors, subdivisionPoints, subdivisionParams)

    // Draw polygon segments — highlight selected segment
    if (fullContour.length >= 3) {
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)

      // Draw all segments
      for (let seg = 0; seg < numSegments; seg++) {
        const segPoints = getSegmentPoints(seg, contourAnchors, subdivisionPoints, subdivisionParams)
        if (segPoints.length < 2) continue

        const isSelected = selectedSegment === seg
        ctx.beginPath()
        ctx.moveTo(segPoints[0].x, segPoints[0].y)
        for (let i = 1; i < segPoints.length; i++) {
          ctx.lineTo(segPoints[i].x, segPoints[i].y)
        }
        ctx.strokeStyle = isSelected ? 'rgba(34, 197, 94, 0.9)' : 'rgba(59, 130, 246, 0.6)'
        ctx.lineWidth = (isSelected ? 3 : 2) / t.scale
        ctx.stroke()
      }

      ctx.restore()
    }

    // Draw subdivision points — color by segment
    for (let j = 0; j < subdivisionPoints.length; j++) {
      const p = subdivisionPoints[j]
      const segIdx = subdivisionParams[j]?.segmentIndex
      const isSelected = selectedSegment === segIdx
      const sx = p.x * t.scale + t.offsetX
      const sy = p.y * t.scale + t.offsetY
      ctx.beginPath()
      ctx.arc(sx, sy, isSelected ? SUB_RADIUS + 1 : SUB_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = isSelected ? '#22c55e' : '#86efac'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Draw anchor points (red, with numbers)
    for (let i = 0; i < contourAnchors.length; i++) {
      const sx = contourAnchors[i].x * t.scale + t.offsetX
      const sy = contourAnchors[i].y * t.scale + t.offsetY
      ctx.beginPath()
      ctx.arc(sx, sy, ANCHOR_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = '#ef4444'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      // Number label
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      const label = `${i + 1}`
      const textW = ctx.measureText(label).width + 6
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      ctx.fillRect(sx - textW / 2, sy - ANCHOR_RADIUS - 18, textW, 16)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, sx, sy - ANCHOR_RADIUS - 4)
    }
  }, [cannyPixels, contourAnchors, subdivisionPoints, subdivisionParams, selectedSegment, numSegments, transformRef])

  // Animation loop
  useEffect(() => {
    let running = true
    function loop() {
      if (!running) return
      drawScene()
      animFrameRef.current = requestAnimationFrame(loop)
    }
    loop()
    return () => {
      running = false
      cancelAnimationFrame(animFrameRef.current)
    }
  }, [drawScene])

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => {
      const img = imageRef.current
      if (img) fitToCanvas(img.naturalWidth, img.naturalHeight)
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [fitToCanvas])

  // ─── Save ────────────────────────────────────────────────────────
  async function handleSave() {
    if (!mesh) return
    setSaving(true)
    try {
      const updatedMesh: MeshData = {
        ...mesh,
        contourSubdivisionPoints: subdivisionPoints,
        contourSubdivisionParams: subdivisionParams,
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
      }
      await onSave({ ...project, mesh: updatedMesh })
    } catch (err) {
      console.error('Save failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // Prerequisites
  if (!cannyParams) {
    return <div className="placeholder">Validez d&apos;abord les param&egrave;tres Canny (&eacute;tape 2).</div>
  }
  if (contourAnchors.length < 3) {
    return <div className="placeholder">Placez d&apos;abord au moins 3 anchors contour (&eacute;tape 3).</div>
  }

  const totalPoints = countsPerSegment.reduce((s, c) => s + c, 0)

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        {/* Global +/- */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontWeight: 'bold' }}>Tous :</label>
          <button
            onClick={() => adjustAll(-1)}
            style={{ width: 28, height: 28, fontSize: '1rem', fontWeight: 'bold' }}
          >−</button>
          <button
            onClick={() => adjustAll(1)}
            style={{ width: 28, height: 28, fontSize: '1rem', fontWeight: 'bold' }}
          >+</button>
        </div>

        <span className="toolbar-separator" />

        <span className="toolbar-info">
          {totalPoints} points total
          {loadingContour && ' | Chargement Canny...'}
        </span>

        <span className="toolbar-separator" />

        <button onClick={handleSave} disabled={saving || !orderedContour}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder subdivision'}
        </button>
      </div>

      {/* Per-segment controls */}
      <div style={{
        padding: '6px 12px',
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
        alignItems: 'center',
        borderBottom: '1px solid #eee',
        background: '#fafafa',
      }}>
        {Array.from({ length: numSegments }, (_, i) => {
          const isSelected = selectedSegment === i
          const nextAnchor = (i + 1) % numSegments + 1
          return (
            <div
              key={i}
              onClick={() => setSelectedSegment(isSelected ? null : i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                borderRadius: 6,
                cursor: 'pointer',
                background: isSelected ? '#dcfce7' : '#f3f4f6',
                border: isSelected ? '2px solid #22c55e' : '1px solid #d1d5db',
                fontSize: '0.85rem',
              }}
            >
              <span style={{ fontWeight: 600, color: '#374151', minWidth: 36 }}>
                {i + 1}→{nextAnchor}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); setSegmentCount(i, -1) }}
                style={{ width: 22, height: 22, fontSize: '0.85rem', fontWeight: 'bold', padding: 0, lineHeight: 1 }}
              >−</button>
              <span style={{ minWidth: 16, textAlign: 'center', fontWeight: 'bold' }}>
                {countsPerSegment[i]}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); setSegmentCount(i, 1) }}
                style={{ width: 22, height: 22, fontSize: '0.85rem', fontWeight: 'bold', padding: 0, lineHeight: 1 }}
              >+</button>
            </div>
          )
        })}
      </div>

      <div className="triangulation-help">
        <span>
          Cliquez sur un segment pour le s&eacute;lectionner et le voir en surbrillance |
          + / − par segment ou global |
          Molette = zoom | Espace+glisser = pan
        </span>
      </div>

      <canvas
        ref={canvasRef}
        className="triangulation-canvas"
      />
    </div>
  )
}

/**
 * Build the full contour polygon by interleaving anchors and subdivision points in order.
 */
function buildOrderedContour(
  anchors: Point2D[],
  subPoints: Point2D[],
  params: CurvilinearParam[]
): Point2D[] {
  const n = anchors.length
  const result: Point2D[] = []

  for (let i = 0; i < n; i++) {
    result.push(anchors[i])
    const segPts: { t: number; point: Point2D }[] = []
    for (let j = 0; j < params.length; j++) {
      if (params[j].segmentIndex === i) {
        segPts.push({ t: params[j].t, point: subPoints[j] })
      }
    }
    segPts.sort((a, b) => a.t - b.t)
    for (const sp of segPts) {
      result.push(sp.point)
    }
  }

  return result
}

/**
 * Get all points for a segment: [anchor_i, ...subdivision points..., anchor_{i+1}]
 */
function getSegmentPoints(
  segIndex: number,
  anchors: Point2D[],
  subPoints: Point2D[],
  params: CurvilinearParam[]
): Point2D[] {
  const result: Point2D[] = [anchors[segIndex]]
  const segPts: { t: number; point: Point2D }[] = []
  for (let j = 0; j < params.length; j++) {
    if (params[j].segmentIndex === segIndex) {
      segPts.push({ t: params[j].t, point: subPoints[j] })
    }
  }
  segPts.sort((a, b) => a.t - b.t)
  for (const sp of segPts) {
    result.push(sp.point)
  }
  result.push(anchors[(segIndex + 1) % anchors.length])
  return result
}
