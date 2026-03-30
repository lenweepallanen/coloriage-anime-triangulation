import { useState, useEffect, useCallback, useRef } from 'react'
import type { ProjectStepView, Point2D, MeshData } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const POINT_RADIUS = 9
const HIT_RADIUS = 14
const GHOST_RADIUS = 7

export default function ContourOriginStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [origin, setOrigin] = useState<Point2D | null>(
    () => project.mesh?.contourOrigin ?? null
  )
  const [cannyContour, setCannyContour] = useState<Point2D[] | null>(null)
  const [loadingCanny, setLoadingCanny] = useState(false)
  const contourIndexRef = useRef<ContourSpatialIndex | null>(null)

  const [ghostPoint, setGhostPoint] = useState<Point2D | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const draggingRef = useRef(false)
  const hasDraggedRef = useRef(false)

  const cannyParams = project.mesh?.cannyParams

  const {
    transformRef, screenToImage, fitToCanvas, isPanning, spaceDown
  } = useCanvasInteraction(canvasRef)

  // Load Canny contour on image
  useEffect(() => {
    if (!project.originalImageBlob || !cannyParams) return
    let cancelled = false
    setLoadingCanny(true)

    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.onload = async () => {
      imageRef.current = img
      fitToCanvas(img.naturalWidth, img.naturalHeight)

      try {
        await loadOpenCVWorker()
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

        const contourPts = await flowCannyContour(
          imageData,
          cannyParams.lowThreshold,
          cannyParams.highThreshold,
          cannyParams.blurSize
        )

        if (!cancelled && contourPts && contourPts.length > 0) {
          setCannyContour(contourPts)
          contourIndexRef.current = new ContourSpatialIndex(contourPts, 8)
        }
      } catch (err) {
        console.error('Canny detection failed:', err)
      }
      if (!cancelled) setLoadingCanny(false)
    }
    img.onerror = () => {
      if (!cancelled) setLoadingCanny(false)
      URL.revokeObjectURL(url)
    }
    img.src = url

    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
    }
  }, [project.originalImageBlob, cannyParams, fitToCanvas])

  const SNAP_RADIUS = 30 // max snap distance in image pixels

  const snapPoint = useCallback((p: Point2D): Point2D => {
    if (!contourIndexRef.current) return p
    const result = contourIndexRef.current.nearest(p, SNAP_RADIUS)
    return result ? result.point : p
  }, [])

  // ─── Canvas rendering ────────────────────────────────────────────

  const animFrameRef = useRef<number>(0)

  const drawScene = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr

    const ctx = canvas.getContext('2d')!
    const t = transformRef.current
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    // Image
    ctx.save()
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(t.scale, t.scale)
    ctx.drawImage(img, 0, 0)

    // Canny overlay
    if (cannyContour) {
      ctx.fillStyle = 'rgba(255, 220, 0, 0.4)'
      for (const p of cannyContour) {
        ctx.fillRect(p.x - 0.5, p.y - 0.5, 1, 1)
      }
    }

    const r = POINT_RADIUS / t.scale

    // Origin point
    if (origin) {
      ctx.beginPath()
      ctx.arc(origin.x, origin.y, r, 0, Math.PI * 2)
      ctx.fillStyle = '#ec4899'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2 / t.scale
      ctx.stroke()

      // Label "P0"
      ctx.font = `bold ${Math.max(12, 14 / t.scale)}px sans-serif`
      ctx.fillStyle = '#fff'
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'
      ctx.lineWidth = 3 / t.scale
      ctx.strokeText('P0', origin.x + r * 1.5, origin.y - r * 0.5)
      ctx.fillText('P0', origin.x + r * 1.5, origin.y - r * 0.5)
    }

    // Ghost point
    if (ghostPoint && !draggingRef.current) {
      const gr = GHOST_RADIUS / t.scale
      ctx.beginPath()
      ctx.arc(ghostPoint.x, ghostPoint.y, gr, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(236, 72, 153, 0.4)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(236, 72, 153, 0.8)'
      ctx.lineWidth = 1.5 / t.scale
      ctx.stroke()
    }

    ctx.restore()
  }, [cannyContour, origin, ghostPoint, transformRef])

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

  // ─── Mouse interactions ──────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || isPanning.current || spaceDown.current) return
    const imgPt = screenToImage(e.clientX, e.clientY)

    // Check hit on existing origin
    if (origin) {
      const hr = HIT_RADIUS / transformRef.current.scale
      const dx = imgPt.x - origin.x
      const dy = imgPt.y - origin.y
      if (dx * dx + dy * dy <= hr * hr) {
        draggingRef.current = true
        hasDraggedRef.current = false
        return
      }
    }
  }, [origin, isPanning, spaceDown, screenToImage, transformRef])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning.current || spaceDown.current) {
      setGhostPoint(null)
      return
    }
    const imgPt = screenToImage(e.clientX, e.clientY)
    const snapped = snapPoint(imgPt)

    if (draggingRef.current) {
      hasDraggedRef.current = true
      setOrigin(snapped)
    } else {
      setGhostPoint(snapped)
    }
  }, [screenToImage, snapPoint, isPanning, spaceDown])

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return

    if (draggingRef.current) {
      draggingRef.current = false
      return
    }

    if (isPanning.current || spaceDown.current) return

    // Place or move origin
    const imgPt = screenToImage(e.clientX, e.clientY)
    const snapped = snapPoint(imgPt)
    setOrigin(snapped)
  }, [isPanning, spaceDown, screenToImage, snapPoint])

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    if (!origin) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const hr = HIT_RADIUS / transformRef.current.scale
    const dx = imgPt.x - origin.x
    const dy = imgPt.y - origin.y
    if (dx * dx + dy * dy <= hr * hr) {
      setOrigin(null)
    }
  }, [origin, screenToImage, transformRef])

  // ─── Save ────────────────────────────────────────────────────────

  async function handleSave() {
    if (!origin) return
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
        contourCannyFrames: null,
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

      const updatedMesh: MeshData = {
        ...baseMesh,
        contourOrigin: origin,
        // Reset downstream
        contourOriginKeyframes: [],
        contourOriginFrames: null,
        contourOriginTrackingValidated: false,
        contourAnchors: [],
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionPoints: [],
        contourSubdivisionParams: [],
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
        anchorPoints: [],
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

      await onSave({ ...project, mesh: updatedMesh })
    } catch (err) {
      console.error('Save failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ─── Render ──────────────────────────────────────────────────────

  if (!cannyParams) {
    return (
      <div className="placeholder">
        Validez d'abord les paramètres Canny (étape 2).
      </div>
    )
  }

  if (!project.originalImageBlob) {
    return (
      <div className="placeholder">
        Importez d'abord une image (étape 1).
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        <button
          onClick={handleSave}
          disabled={saving || !origin}
          style={{ background: origin ? '#22c55e' : undefined, color: origin ? 'white' : undefined }}
        >
          {saving ? 'Sauvegarde...' : 'Sauvegarder Point 0'}
        </button>
        <button
          onClick={() => setOrigin(null)}
          disabled={!origin}
          className="btn-danger"
        >
          Effacer
        </button>
        <span className="toolbar-info">
          {loadingCanny ? 'Détection Canny...' :
           cannyContour ? `Contour: ${cannyContour.length} px` : 'Pas de contour'}
          {origin ? ' | Point 0 placé' : ' | Cliquez pour placer le Point 0'}
        </span>
      </div>

      <div className="triangulation-help">
        Clic gauche = placer/déplacer le Point 0 (origine curviligne) | Clic droit = supprimer
      </div>

      <canvas
        ref={canvasRef}
        className="triangulation-canvas"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onContextMenu={handleContextMenu}
        onMouseLeave={() => setGhostPoint(null)}
        style={{ cursor: spaceDown.current ? 'grab' : 'crosshair' }}
      />
    </div>
  )
}
