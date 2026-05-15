import { useRef, useEffect, useCallback, useState } from 'react'
import type { Point2D } from '../../types/project'
import { useCanvasInteraction } from './useCanvasInteraction'
import { drawScene, findPointAt, findNearestContourEdge } from './drawingUtils'
import type { PointType } from './drawingUtils'

export type EditorMode = 'contour' | 'internal' | 'anchor'

interface Props {
  imageUrl: string | null
  contourPoints: Point2D[]
  internalPoints: Point2D[]
  triangles: [number, number, number][]
  contourClosed: boolean
  mode: EditorMode
  onAddContourPoint: (p: Point2D) => void
  onInsertContourPoint: (afterIndex: number, p: Point2D) => void
  onCloseContour: () => void
  onAddInternalPoint: (p: Point2D) => void
  onMovePoint: (type: PointType, index: number, p: Point2D) => void
  onDeletePoint: (type: PointType, index: number) => void
  anchorPoints?: Point2D[]
  onAddAnchorPoint?: (p: Point2D) => void
  readOnlyAnchors?: boolean
  showAnchorNumbers?: boolean
  contourIndexOffset?: number
  promotedContourIndices?: Set<number>
  onTogglePromoteContour?: (index: number) => void
  nonPromotedContourPoints?: Point2D[]
}

export default function TriangulationCanvas({
  imageUrl,
  contourPoints,
  internalPoints,
  triangles,
  contourClosed,
  mode,
  onAddContourPoint,
  onInsertContourPoint,
  onCloseContour,
  onAddInternalPoint,
  onMovePoint,
  onDeletePoint,
  anchorPoints,
  onAddAnchorPoint,
  readOnlyAnchors,
  showAnchorNumbers,
  contourIndexOffset,
  promotedContourIndices,
  onTogglePromoteContour,
  nonPromotedContourPoints,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)

  const [hoveredPoint, setHoveredPoint] = useState<{
    type: PointType
    index: number
  } | null>(null)

  const dragging = useRef<{
    type: PointType
    index: number
  } | null>(null)

  const imageFitted = useRef(false)

  // Load image — uses state so React knows when it's ready
  useEffect(() => {
    if (!imageUrl) {
      setLoadedImage(null)
      return
    }
    const img = new Image()
    img.onload = () => {
      setLoadedImage(img)
    }
    img.onerror = () => {
      console.error('Failed to load image from URL:', imageUrl)
    }
    img.src = imageUrl
  }, [imageUrl])

  // Fit image when it loads or canvas resizes
  useEffect(() => {
    if (loadedImage && !imageFitted.current) {
      fitToCanvas(loadedImage.naturalWidth, loadedImage.naturalHeight)
      imageFitted.current = true
    }
  }, [loadedImage, fitToCanvas])

  // Resize canvas to container
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

      // Re-fit image on resize
      if (loadedImage) {
        fitToCanvas(loadedImage.naturalWidth, loadedImage.naturalHeight)
        imageFitted.current = true
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [fitToCanvas, loadedImage])

  // Single animation loop that always reads current state from refs/props
  useEffect(() => {
    let rafId = 0
    let running = true

    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const dpr = window.devicePixelRatio || 1
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

          drawScene(
            ctx,
            loadedImage,
            transformRef.current,
            contourPoints,
            internalPoints,
            triangles,
            contourClosed,
            hoveredPoint,
            anchorPoints,
            readOnlyAnchors,
            showAnchorNumbers,
            contourIndexOffset,
            promotedContourIndices,
            nonPromotedContourPoints
          )
        }
      }
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => {
      running = false
      cancelAnimationFrame(rafId)
    }
  }, [loadedImage, contourPoints, internalPoints, triangles, contourClosed, hoveredPoint, transformRef, anchorPoints, readOnlyAnchors, showAnchorNumbers, contourIndexOffset, promotedContourIndices, nonPromotedContourPoints])

  const hitRadius = useCallback(() => {
    return 10 / transformRef.current.scale
  }, [transformRef])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 || isPanning.current || spaceDown.current) return

      const imgPos = screenToImage(e.clientX, e.clientY)
      // Filter hit-test by current mode when contour is closed
      const filterType = contourClosed ? mode as PointType : undefined
      const hit = findPointAt(imgPos, contourPoints, internalPoints, hitRadius(), filterType, anchorPoints)

      if (hit) {
        // Don't allow dragging read-only anchors
        if (hit.type === 'anchor' && readOnlyAnchors) return

        // Shift+click on contour point → toggle promotion
        if (e.shiftKey && hit.type === 'contour' && contourClosed && onTogglePromoteContour) {
          onTogglePromoteContour(hit.index)
          return
        }

        // Click on first contour point → close the contour
        if (
          mode === 'contour' &&
          !contourClosed &&
          hit.type === 'contour' &&
          hit.index === 0 &&
          contourPoints.length >= 3
        ) {
          onCloseContour()
          return
        }
        dragging.current = hit
        return
      }

      if (mode === 'contour' && !contourClosed) {
        onAddContourPoint(imgPos)
      } else if (mode === 'contour' && contourClosed) {
        // Insert a new point on the nearest contour edge
        const edge = findNearestContourEdge(imgPos, contourPoints, Infinity)
        if (edge) {
          onInsertContourPoint(edge.afterIndex, imgPos)
        }
      } else if (mode === 'internal' && contourClosed) {
        onAddInternalPoint(imgPos)
      } else if (mode === 'anchor' && contourClosed && onAddAnchorPoint) {
        onAddAnchorPoint(imgPos)
      }
    },
    [screenToImage, contourPoints, internalPoints, mode, contourClosed, hitRadius, onAddContourPoint, onInsertContourPoint, onAddInternalPoint, onAddAnchorPoint, isPanning, anchorPoints, readOnlyAnchors, onTogglePromoteContour]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const imgPos = screenToImage(e.clientX, e.clientY)

      if (dragging.current) {
        onMovePoint(dragging.current.type, dragging.current.index, imgPos)
        return
      }

      const filterType = contourClosed ? mode as PointType : undefined
      const hit = findPointAt(imgPos, contourPoints, internalPoints, hitRadius(), filterType, anchorPoints)
      setHoveredPoint(hit)
    },
    [screenToImage, contourPoints, internalPoints, hitRadius, onMovePoint, contourClosed, mode, anchorPoints]
  )

  const handleMouseUp = useCallback(() => {
    dragging.current = null
  }, [])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (mode === 'contour' && !contourClosed && contourPoints.length >= 3) {
        e.preventDefault()
        onCloseContour()
      }
    },
    [mode, contourClosed, contourPoints.length, onCloseContour]
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const imgPos = screenToImage(e.clientX, e.clientY)
      const filterType = contourClosed ? mode as PointType : undefined
      const hit = findPointAt(imgPos, contourPoints, internalPoints, hitRadius(), filterType, anchorPoints)
      if (hit) {
        // Don't allow deleting read-only anchors
        if (hit.type === 'anchor' && readOnlyAnchors) return
        onDeletePoint(hit.type, hit.index)
      }
    },
    [screenToImage, contourPoints, internalPoints, hitRadius, onDeletePoint, contourClosed, mode, anchorPoints, readOnlyAnchors]
  )

  return (
    <div ref={containerRef} className="triangulation-canvas-container">
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        style={{ cursor: hoveredPoint ? 'grab' : 'crosshair' }}
      />
    </div>
  )
}
