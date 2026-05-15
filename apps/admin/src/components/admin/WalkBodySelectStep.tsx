import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y)
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y)
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y)
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
  return !(hasNeg && hasPos)
}

function triCentroid(a: Point2D, b: Point2D, c: Point2D): Point2D {
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 }
}

function pointInRect(p: Point2D, r1: Point2D, r2: Point2D): boolean {
  const minX = Math.min(r1.x, r2.x), maxX = Math.max(r1.x, r2.x)
  const minY = Math.min(r1.y, r2.y), maxY = Math.max(r1.y, r2.y)
  return p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY
}

export default function WalkBodySelectStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const restAnim = project.animations.find(a => a.type === 'rest')
  const restMesh = restAnim?.mesh

  const [selectedTriangles, setSelectedTriangles] = useState<Set<number>>(() => {
    return new Set(mesh?.walkBodyTriangles ?? [])
  })
  const [isRectSelecting, setIsRectSelecting] = useState(false)
  const [rectStart, setRectStart] = useState<Point2D | null>(null)
  const [rectEnd, setRectEnd] = useState<Point2D | null>(null)
  const [saving, setSaving] = useState(false)
  const paintingRef = useRef(false)
  const movedRef = useRef(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  // Get all points from rest mesh
  const allPoints: Point2D[] = restMesh ? [
    ...(restMesh.contourAnchors || []),
    ...(restMesh.contourSubdivisionPoints || []),
    ...(restMesh.anchorPoints || []),
    ...(restMesh.internalPoints || []),
  ] : []
  const triangles = restMesh?.triangles ?? []

  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      requestAnimationFrame(() => fitToCanvas(img.width, img.height))
    }
    img.src = url
    const canvas = canvasRef.current
    let ro: ResizeObserver | null = null
    if (canvas) {
      ro = new ResizeObserver(() => {
        if (imageRef.current && canvas.clientWidth > 0)
          fitToCanvas(imageRef.current.naturalWidth, imageRef.current.naturalHeight)
      })
      ro.observe(canvas)
    }
    return () => {
      imageRef.current = null
      URL.revokeObjectURL(url)
      ro?.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const img = imageRef.current
    if (!canvas || !ctx || !img) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const t = transformRef.current
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.fillStyle = '#1a1b2e'
    ctx.fillRect(0, 0, rect.width, rect.height)

    ctx.save()
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(t.scale, t.scale)

    ctx.drawImage(img, 0, 0)

    // Draw triangles
    for (let i = 0; i < triangles.length; i++) {
      const [ai, bi, ci] = triangles[i]
      if (ai >= allPoints.length || bi >= allPoints.length || ci >= allPoints.length) continue
      const a = allPoints[ai], b = allPoints[bi], c = allPoints[ci]

      const isSelected = selectedTriangles.has(i)

      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(c.x, c.y)
      ctx.closePath()

      if (isSelected) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.35)'
        ctx.fill()
      }

      ctx.strokeStyle = isSelected ? 'rgba(59, 130, 246, 0.7)' : 'rgba(255, 255, 255, 0.2)'
      ctx.lineWidth = 1 / t.scale
      ctx.stroke()
    }

    // Draw walk bones overlay if skeleton defined
    if (mesh?.walkSkeleton) {
      const kp = mesh.walkSkeleton.keyPoints
      ctx.strokeStyle = 'rgba(224, 86, 253, 0.6)'
      ctx.lineWidth = 2 / t.scale
      const boneSegs: [number, number][] = [
        [0,1],[1,2],[3,4],[4,5],[6,7],[7,8],[9,10],[10,11],
        [12,13],[13,14],[15,16],[16,17],
      ]
      for (const [hi, ti] of boneSegs) {
        if (hi < kp.length && ti < kp.length) {
          ctx.beginPath()
          ctx.moveTo(kp[hi].x, kp[hi].y)
          ctx.lineTo(kp[ti].x, kp[ti].y)
          ctx.stroke()
        }
      }
    }

    // Draw rectangle selection
    if (isRectSelecting && rectStart && rectEnd) {
      const rx = Math.min(rectStart.x, rectEnd.x)
      const ry = Math.min(rectStart.y, rectEnd.y)
      const rw = Math.abs(rectEnd.x - rectStart.x)
      const rh = Math.abs(rectEnd.y - rectStart.y)
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)'
      ctx.lineWidth = 1.5 / t.scale
      ctx.setLineDash([6 / t.scale, 4 / t.scale])
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'
      ctx.fillRect(rx, ry, rw, rh)
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  }, [selectedTriangles, triangles, allPoints, mesh?.walkSkeleton, isRectSelecting, rectStart, rectEnd, transformRef])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  function findTriangleAt(imgPt: Point2D): number {
    for (let i = 0; i < triangles.length; i++) {
      const [ai, bi, ci] = triangles[i]
      if (ai >= allPoints.length || bi >= allPoints.length || ci >= allPoints.length) continue
      if (pointInTriangle(imgPt, allPoints[ai], allPoints[bi], allPoints[ci])) return i
    }
    return -1
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || spaceDown.current || isPanning.current) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const triIdx = findTriangleAt(imgPt)

    movedRef.current = false

    if (triIdx >= 0) {
      // Click on a triangle → toggle
      paintingRef.current = false
      setSelectedTriangles(prev => {
        const next = new Set(prev)
        if (next.has(triIdx)) next.delete(triIdx)
        else next.add(triIdx)
        return next
      })
    } else {
      // Click on empty space → start rectangle selection
      setIsRectSelecting(true)
      setRectStart(imgPt)
      setRectEnd(imgPt)
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const imgPt = screenToImage(e.clientX, e.clientY)
    movedRef.current = true

    if (isRectSelecting) {
      setRectEnd(imgPt)
      return
    }
  }

  function handleMouseUp() {
    if (isRectSelecting && rectStart && rectEnd) {
      // Toggle all triangles whose centroid is inside the rectangle
      const newSelected = new Set(selectedTriangles)
      for (let i = 0; i < triangles.length; i++) {
        const [ai, bi, ci] = triangles[i]
        if (ai >= allPoints.length || bi >= allPoints.length || ci >= allPoints.length) continue
        const c = triCentroid(allPoints[ai], allPoints[bi], allPoints[ci])
        if (pointInRect(c, rectStart, rectEnd)) {
          if (newSelected.has(i)) newSelected.delete(i)
          else newSelected.add(i)
        }
      }
      setSelectedTriangles(newSelected)
      setIsRectSelecting(false)
      setRectStart(null)
      setRectEnd(null)
    }
    paintingRef.current = false
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    const imgPt = screenToImage(e.clientX, e.clientY)
    const triIdx = findTriangleAt(imgPt)
    if (triIdx >= 0) {
      setSelectedTriangles(prev => {
        const next = new Set(prev)
        next.delete(triIdx)
        return next
      })
    }
  }

  async function handleValidate() {
    if (!mesh) return
    const updatedMesh = {
      ...mesh,
      walkBodyTriangles: Array.from(selectedTriangles),
      walkBodyValidated: true,
      videoFramesMesh: null,
    }
    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, mesh: updatedMesh } : a
    )
    setSaving(true)
    await onSave({ ...project, animations: updatedAnims })
    setSaving(false)
  }

  function handleSelectAll() {
    setSelectedTriangles(new Set(triangles.map((_, i) => i)))
  }

  function handleClear() {
    setSelectedTriangles(new Set())
  }

  if (!restMesh?.topologyLocked) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>La triangulation rest doit être verrouillée.</div>
  }

  if (!mesh?.walkSkeletonValidated) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>Validez d'abord le squelette de marche (étape précédente).</div>
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 500, display: 'block', borderRadius: 8 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onContextMenu={handleContextMenu}
        />
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13 }}>
          Clic = toggle triangle, Drag sur triangle = peindre, Drag dans le vide = sélection rectangle, Clic droit = retirer.
        </div>
      </div>

      <div style={{ width: 240, flexShrink: 0 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>
          Triangles corps
        </h3>
        <p style={{ color: '#9ca3af', fontSize: 13, margin: '0 0 12px' }}>
          Sélectionnez les triangles du torse/corps de l'animal.
          Ces triangles bougeront en bloc avec le mouvement du corps.
        </p>
        <div style={{ fontSize: 14, color: '#e5e7eb', marginBottom: 12 }}>
          {selectedTriangles.size} / {triangles.length} triangles
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button className="btn-sm btn-secondary" onClick={handleSelectAll}>Tout</button>
          <button className="btn-sm btn-secondary" onClick={handleClear}>Aucun</button>
        </div>

        <button
          className="btn-primary"
          onClick={handleValidate}
          disabled={selectedTriangles.size === 0 || saving}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider la sélection'}
        </button>
      </div>
    </div>
  )
}
