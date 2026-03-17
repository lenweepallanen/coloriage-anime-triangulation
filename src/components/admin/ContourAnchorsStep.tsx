import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { orderContourPixels, computeArcLengths } from '../../utils/curvilinearContour'
import { detectCurvatureExtrema, computeInitialAnchorArcLengths, type CSSCandidate } from '../../utils/curvatureScaleSpace'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

const POINT_RADIUS = 7
const HIT_RADIUS = 12
const GHOST_RADIUS = 6
const MAX_AUTO_CANDIDATES = 20
const MIN_ANCHOR_COUNT = 4

const MIN_DIST_FROM_ORIGIN = 20 // min distance from Point 0 in image pixels

export default function ContourAnchorsStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const contourOrigin = project.mesh?.contourOrigin ?? null

  // State holds only user-placed anchors (NOT Point 0).
  // On load, strip Point 0 if it was saved as first anchor.
  const [anchors, setAnchors] = useState<Point2D[]>(() => {
    const saved = project.mesh?.contourAnchors ?? []
    if (contourOrigin && saved.length > 0) {
      const dx = saved[0].x - contourOrigin.x
      const dy = saved[0].y - contourOrigin.y
      if (dx * dx + dy * dy < 1) return saved.slice(1)
    }
    return saved
  })
  const [cannyContour, setCannyContour] = useState<Point2D[] | null>(null)
  const [loadingCanny, setLoadingCanny] = useState(false)
  const contourIndexRef = useRef<ContourSpatialIndex | null>(null)
  const orderedContourRef = useRef<Point2D[] | null>(null)
  const contourArcLengthsRef = useRef<number[] | null>(null)

  // Sort anchors by their position along the ordered contour
  const sortByContourOrder = useCallback((pts: Point2D[]): Point2D[] => {
    const ordered = orderedContourRef.current
    const arcLengths = contourArcLengthsRef.current
    if (!ordered || !arcLengths || pts.length < 2) return pts
    const norms = computeInitialAnchorArcLengths(pts, ordered, arcLengths)
    const indexed = pts.map((p, i) => ({ p, norm: norms[i] }))
    indexed.sort((a, b) => a.norm - b.norm)
    return indexed.map(x => x.p)
  }, [])

  // Anchor count mode
  const [anchorCountMode, setAnchorCountMode] = useState<number>(6)

  // CSS auto-detection
  const [cssCandidates, setCssCandidates] = useState<CSSCandidate[] | null>(null)
  const [detectingCSS, setDetectingCSS] = useState(false)

  // Ghost point (snapped position shown at cursor)
  const [ghostPoint, setGhostPoint] = useState<Point2D | null>(null)

  // Drag state
  const draggingRef = useRef<{ index: number } | null>(null)
  const hasDraggedRef = useRef(false)

  // Canvas + image
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  const cannyParams = project.mesh?.cannyParams

  const {
    transformRef,
    screenToImage,
    fitToCanvas,
    isPanning,
    spaceDown,
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

  // Detect Canny contour on the original image
  useEffect(() => {
    if (!project.originalImageBlob || !cannyParams) return
    let cancelled = false

    async function detect() {
      setLoadingCanny(true)
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
          setCannyContour(contourPts)
          contourIndexRef.current = new ContourSpatialIndex(contourPts, 8)
          const ordered = orderContourPixels(contourPts)
          orderedContourRef.current = ordered
          contourArcLengthsRef.current = computeArcLengths(ordered)
        }
      } catch (err) {
        console.error('Failed to detect Canny contour:', err)
      } finally {
        if (!cancelled) setLoadingCanny(false)
      }
    }

    detect()
    return () => { cancelled = true }
  }, [project.originalImageBlob, cannyParams])

  // Snap a point to the nearest Canny contour pixel (no distance limit)
  const snapPoint = useCallback((p: Point2D): Point2D => {
    if (!contourIndexRef.current) return p
    const result = contourIndexRef.current.nearestUnbounded(p)
    return result ? result.point : p
  }, [])

  // All curvature candidates (top 20, computed once)
  const allCandidatesRef = useRef<CSSCandidate[] | null>(null)

  // Compute all candidates once, then slice to anchorCountMode
  const handleAutoDetect = useCallback(async () => {
    if (!cannyContour || cannyContour.length < 50) return
    setDetectingCSS(true)
    try {
      const orderedPath = orderContourPixels(cannyContour)
      const allRaw = detectCurvatureExtrema(orderedPath, MAX_AUTO_CANDIDATES + 5)
      // Filter out candidates too close to Point 0
      const all = contourOrigin
        ? allRaw.filter(c => {
            const dx = c.position.x - contourOrigin.x
            const dy = c.position.y - contourOrigin.y
            return dx * dx + dy * dy > MIN_DIST_FROM_ORIGIN * MIN_DIST_FROM_ORIGIN
          }).slice(0, MAX_AUTO_CANDIDATES)
        : allRaw.slice(0, MAX_AUTO_CANDIDATES)
      allCandidatesRef.current = all
      const selected = all.slice(0, anchorCountMode)
      setCssCandidates(selected)
      const sorted = [...selected].sort((a, b) => a.arcLengthNorm - b.arcLengthNorm)
      setAnchors(sorted.map(c => c.position))
    } finally {
      setDetectingCSS(false)
    }
  }, [cannyContour, anchorCountMode])

  // When anchorCountMode changes and we already have candidates, re-slice
  useEffect(() => {
    const all = allCandidatesRef.current
    if (!all || all.length === 0) return
    const selected = all.slice(0, anchorCountMode)
    setCssCandidates(selected)
    const sorted = [...selected].sort((a, b) => a.arcLengthNorm - b.arcLengthNorm)
    setAnchors(sorted.map(c => c.position))
  }, [anchorCountMode])

  // Find anchor at image position
  const findAnchorAt = useCallback((imgPos: Point2D): number => {
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale
    for (let i = 0; i < anchors.length; i++) {
      const dx = anchors[i].x - imgPos.x
      const dy = anchors[i].y - imgPos.y
      if (dx * dx + dy * dy <= hitR * hitR) return i
    }
    return -1
  }, [anchors, transformRef])

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
    if (cannyContour && cannyContour.length > 0) {
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)
      ctx.fillStyle = 'rgba(255, 220, 50, 0.4)'
      const pixSize = Math.max(1, 1 / t.scale)
      for (const p of cannyContour) {
        ctx.fillRect(p.x - pixSize / 2, p.y - pixSize / 2, pixSize, pixSize)
      }
      ctx.restore()
    }

    // Draw lines between anchors (contour polygon), including Point 0
    const polyPts = contourOrigin ? [contourOrigin, ...anchors] : anchors
    if (polyPts.length >= 2) {
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)
      ctx.beginPath()
      ctx.moveTo(polyPts[0].x, polyPts[0].y)
      for (let i = 1; i < polyPts.length; i++) {
        ctx.lineTo(polyPts[i].x, polyPts[i].y)
      }
      if (polyPts.length >= 3) {
        ctx.closePath()
      }
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)'
      ctx.lineWidth = 2 / t.scale
      ctx.stroke()
      ctx.restore()
    }

    // Draw anchor points
    for (let i = 0; i < anchors.length; i++) {
      const sx = anchors[i].x * t.scale + t.offsetX
      const sy = anchors[i].y * t.scale + t.offsetY
      // Filled circle
      ctx.beginPath()
      ctx.arc(sx, sy, POINT_RADIUS, 0, Math.PI * 2)
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
      ctx.fillRect(sx - textW / 2, sy - POINT_RADIUS - 18, textW, 16)
      ctx.fillStyle = '#fff'
      ctx.fillText(label, sx, sy - POINT_RADIUS - 4)
    }

    // Draw Point 0 (contour origin, read-only)
    if (contourOrigin) {
      const sx = contourOrigin.x * t.scale + t.offsetX
      const sy = contourOrigin.y * t.scale + t.offsetY
      ctx.beginPath()
      ctx.arc(sx, sy, POINT_RADIUS + 1, 0, Math.PI * 2)
      ctx.fillStyle = '#ec4899'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      // Label "P0"
      ctx.font = 'bold 11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      const label = 'P0'
      const tw = ctx.measureText(label).width + 6
      ctx.fillStyle = 'rgba(0,0,0,0.7)'
      ctx.fillRect(sx - tw / 2, sy - POINT_RADIUS - 19, tw, 16)
      ctx.fillStyle = '#ec4899'
      ctx.fillText(label, sx, sy - POINT_RADIUS - 5)
    }

    // Draw CSS candidates (orange circles, intensity proportional to score)
    if (cssCandidates && cssCandidates.length > 0) {
      const maxScore = cssCandidates[0].score  // already sorted desc
      for (const candidate of cssCandidates) {
        // Skip candidates near existing anchors or Point 0
        const nearAnchor = anchors.some(a => {
          const dx = a.x - candidate.position.x
          const dy = a.y - candidate.position.y
          return dx * dx + dy * dy < (HIT_RADIUS / t.scale) * (HIT_RADIUS / t.scale) * 4
        })
        if (nearAnchor) continue
        if (contourOrigin) {
          const dx = contourOrigin.x - candidate.position.x
          const dy = contourOrigin.y - candidate.position.y
          if (dx * dx + dy * dy < MIN_DIST_FROM_ORIGIN * MIN_DIST_FROM_ORIGIN) continue
        }

        const norm = maxScore > 0 ? candidate.score / maxScore : 0.5
        const alpha = 0.3 + norm * 0.5
        const radius = (3 + norm * 5)

        const sx = candidate.position.x * t.scale + t.offsetX
        const sy = candidate.position.y * t.scale + t.offsetY
        ctx.beginPath()
        ctx.arc(sx, sy, radius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 165, 0, ${alpha})`
        ctx.fill()
        ctx.strokeStyle = `rgba(255, 200, 50, ${alpha})`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // Draw ghost point (snap preview)
    if (ghostPoint && draggingRef.current === null) {
      const sx = ghostPoint.x * t.scale + t.offsetX
      const sy = ghostPoint.y * t.scale + t.offsetY
      ctx.beginPath()
      ctx.arc(sx, sy, GHOST_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(239, 68, 68, 0.5)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [cannyContour, anchors, ghostPoint, cssCandidates, contourOrigin, transformRef])

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

  // ─── Mouse handlers ──────────────────────────────────────────────
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isPanning.current || spaceDown.current) {
      setGhostPoint(null)
      return
    }

    const imgPos = screenToImage(e.clientX, e.clientY)

    // If dragging an anchor, move it
    if (draggingRef.current !== null) {
      hasDraggedRef.current = true
      const snapped = snapPoint(imgPos)
      setAnchors(prev => {
        const next = [...prev]
        next[draggingRef.current!.index] = snapped
        return next
      })
      setGhostPoint(null)
      return
    }

    // Otherwise show ghost snap preview
    const snapped = snapPoint(imgPos)
    setGhostPoint(snapped)
  }, [screenToImage, snapPoint, isPanning, spaceDown])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isPanning.current || spaceDown.current) return
    if (e.button !== 0) return // only left click

    const imgPos = screenToImage(e.clientX, e.clientY)
    const hitIdx = findAnchorAt(imgPos)

    if (hitIdx >= 0) {
      // Start dragging
      draggingRef.current = { index: hitIdx }
      hasDraggedRef.current = false
      e.preventDefault()
    }
  }, [screenToImage, findAnchorAt, isPanning, spaceDown])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      if (draggingRef.current !== null) {
        // End drag — re-sort anchors by contour order
        draggingRef.current = null
        setAnchors(prev => sortByContourOrder(prev))
        return
      }

      if (isPanning.current || spaceDown.current) return

      // Left click on empty area → add anchor
      const imgPos = screenToImage(e.clientX, e.clientY)
      const hitIdx = findAnchorAt(imgPos)
      if (hitIdx < 0) {
        const snapped = snapPoint(imgPos)
        setAnchors(prev => sortByContourOrder([...prev, snapped]))
      }
    }
  }, [screenToImage, findAnchorAt, snapPoint, sortByContourOrder, isPanning, spaceDown])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const imgPos = screenToImage(e.clientX, e.clientY)
    const hitIdx = findAnchorAt(imgPos)
    if (hitIdx >= 0) {
      setAnchors(prev => prev.filter((_, i) => i !== hitIdx))
    }
  }, [screenToImage, findAnchorAt])

  const handleMouseLeave = useCallback(() => {
    setGhostPoint(null)
    draggingRef.current = null
  }, [])

  // ─── Save ────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true)
    try {
      const baseMesh: MeshData = project.mesh ?? {
        cannyParams: cannyParams ?? null,
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
        videoFramesMesh: null,
      }
      const mesh: MeshData = {
        ...baseMesh,
        contourAnchors: contourOrigin ? [contourOrigin, ...anchors] : anchors,
        // Reset downstream
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionPoints: [],
        contourSubdivisionParams: [],
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        topologyLocked: false,
        trackedTriangles: [],
        internalBarycentrics: [],
        videoFramesMesh: null,
      }
      await onSave({ ...project, mesh })
    } catch (err) {
      console.error('Failed to save contour anchors:', err)
      alert('Erreur lors de la sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!cannyParams) {
    return (
      <div className="placeholder">
        Validez d&apos;abord les param&egrave;tres Canny (&eacute;tape 2).
      </div>
    )
  }

  if (!project.mesh?.contourOriginTrackingValidated) {
    return (
      <div className="placeholder">
        Validez d&apos;abord le tracking du Point 0 (&eacute;tape 4).
      </div>
    )
  }

  if (!project.originalImageBlob) {
    return (
      <div className="placeholder">
        Importez d&apos;abord une image dans l&apos;onglet Import.
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        <button onClick={handleSave} disabled={saving || anchors.length < 3}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder anchors contour'}
        </button>

        <span className="toolbar-separator" />

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => setAnchorCountMode(m => Math.max(MIN_ANCHOR_COUNT, m - 1))}
            disabled={anchorCountMode <= MIN_ANCHOR_COUNT}
            style={{ width: 28, height: 28, padding: 0, fontWeight: 'bold', fontSize: '1rem' }}
          >&minus;</button>
          <span style={{ fontWeight: 'bold', fontSize: '0.85rem', minWidth: 40, textAlign: 'center' }}>
            {anchorCountMode} pts
          </span>
          <button
            onClick={() => setAnchorCountMode(m => Math.min(MAX_AUTO_CANDIDATES, m + 1))}
            disabled={anchorCountMode >= MAX_AUTO_CANDIDATES}
            style={{ width: 28, height: 28, padding: 0, fontWeight: 'bold', fontSize: '1rem' }}
          >+</button>
        </div>

        <button
          onClick={handleAutoDetect}
          disabled={!cannyContour || detectingCSS}
        >
          {detectingCSS ? 'D\u00e9tection...' : `Auto-d\u00e9tecter (${anchorCountMode} pts)`}
        </button>
        <button
          className="btn-danger"
          onClick={() => setAnchors([])}
          disabled={anchors.length === 0}
        >
          Tout effacer
        </button>

        <span className="toolbar-separator" />

        <span className="toolbar-info">
          {contourOrigin ? anchors.length + 1 : anchors.length} anchors contour (P0 + {anchors.length})
          {loadingCanny && ' (chargement Canny...)'}
          {cannyContour && ` | Canny: ${cannyContour.length} pts`}
          {!cannyContour && !loadingCanny && ' | Canny non d\u00e9tect\u00e9'}
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Clic gauche = placer un anchor (auto-snap contour Canny) |
          Glisser = d&eacute;placer (auto-snap) | Clic droit = supprimer |
          Molette = zoom | Espace+glisser = pan |
          Min 3 anchors.
        </span>
      </div>

      <canvas
        ref={canvasRef}
        className="triangulation-canvas"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: spaceDown.current ? 'grab' : 'crosshair' }}
      />
    </div>
  )
}
