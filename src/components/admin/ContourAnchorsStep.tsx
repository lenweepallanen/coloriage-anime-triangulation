import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

const POINT_RADIUS = 7
const HIT_RADIUS = 12
const GHOST_RADIUS = 6

export default function ContourAnchorsStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [anchors, setAnchors] = useState<Point2D[]>(
    () => project.mesh?.contourAnchors ?? []
  )
  const [cannyContour, setCannyContour] = useState<Point2D[] | null>(null)
  const [loadingCanny, setLoadingCanny] = useState(false)
  const contourIndexRef = useRef<ContourSpatialIndex | null>(null)

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

    // Draw lines between anchors (contour polygon)
    if (anchors.length >= 2) {
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)
      ctx.beginPath()
      ctx.moveTo(anchors[0].x, anchors[0].y)
      for (let i = 1; i < anchors.length; i++) {
        ctx.lineTo(anchors[i].x, anchors[i].y)
      }
      if (anchors.length >= 3) {
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
  }, [cannyContour, anchors, ghostPoint, transformRef])

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
        // End drag
        draggingRef.current = null
        return
      }

      if (isPanning.current || spaceDown.current) return

      // Left click on empty area → add anchor
      const imgPos = screenToImage(e.clientX, e.clientY)
      const hitIdx = findAnchorAt(imgPos)
      if (hitIdx < 0) {
        const snapped = snapPoint(imgPos)
        setAnchors(prev => [...prev, snapped])
      }
    }
  }, [screenToImage, findAnchorAt, snapPoint, isPanning, spaceDown])

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
        contourAnchors: anchors,
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
        <button
          className="btn-danger"
          onClick={() => setAnchors([])}
          disabled={anchors.length === 0}
        >
          Tout effacer
        </button>

        <span className="toolbar-separator" />

        <span className="toolbar-info">
          {anchors.length} anchors contour
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
