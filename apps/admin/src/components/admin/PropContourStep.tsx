import { useEffect, useRef, useState, useCallback } from 'react'
import type { Project, Prop, Point2D } from '../../types/project'
import { flowCannyContour } from '../../utils/perspectiveCorrection'
import { floodFillCannyComponent } from '../../utils/cannyFloodFill'
import { pointInPolygon } from '../../utils/geometry'

interface Props {
  project: Project
  prop: Prop
  onSave: (next: Prop) => Promise<void>
}

const PART_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c']
const SNAP_RADIUS = 30  // px image
const ZOOM_MIN = 0.2
const ZOOM_MAX = 8

export default function PropContourStep({ project, prop, onSave }: Props) {
  const tri = project.projectTriangulation
  const refBlob = tri?.referenceImageBlob ?? null

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [cannyPixels, setCannyPixels] = useState<Point2D[]>([])
  const [loading, setLoading] = useState(false)
  const [showCanny, setShowCanny] = useState(true)
  const [low, setLow] = useState(50)
  const [high, setHigh] = useState(150)
  const [blur, setBlur] = useState(5)

  // Viewport pan/zoom
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [baseScale, setBaseScale] = useState(1)
  const [spaceDown, setSpaceDown] = useState(false)
  const dragRef = useRef<{ panX: number; panY: number; mx: number; my: number } | null>(null)

  // Load reference image
  useEffect(() => {
    if (!refBlob) { setImage(null); return }
    const url = URL.createObjectURL(refBlob)
    const img = new Image()
    img.onload = () => setImage(img)
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [refBlob])

  // Fit to container on image load
  useEffect(() => {
    if (!image || !containerRef.current) return
    const c = containerRef.current
    const s = Math.min(c.clientWidth / image.width, c.clientHeight / image.height) || 1
    setBaseScale(s)
    setZoom(1)
    setPan({ x: (c.clientWidth - image.width * s) / 2, y: (c.clientHeight - image.height * s) / 2 })
  }, [image])

  // Compute Canny via worker when image or params change
  const recomputeCanny = useCallback(async () => {
    if (!image) return
    setLoading(true)
    try {
      const off = document.createElement('canvas')
      off.width = image.width
      off.height = image.height
      const ctx = off.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      const imageData = ctx.getImageData(0, 0, off.width, off.height)
      const pts = await flowCannyContour(imageData, low, high, blur)
      setCannyPixels(pts ?? [])
    } finally {
      setLoading(false)
    }
  }, [image, low, high, blur])

  useEffect(() => { recomputeCanny() }, [recomputeCanny])

  // Keyboard space for pan
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); setSpaceDown(true) }
      if ((e.metaKey || e.ctrlKey) && e.key === '0') { e.preventDefault(); resetView() }
    }
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceDown(false) }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp) }
  }, [image])

  const resetView = useCallback(() => {
    if (!image || !containerRef.current) return
    const c = containerRef.current
    const s = Math.min(c.clientWidth / image.width, c.clientHeight / image.height) || 1
    setBaseScale(s)
    setZoom(1)
    setPan({ x: (c.clientWidth - image.width * s) / 2, y: (c.clientHeight - image.height * s) / 2 })
  }, [image])

  // Wheel zoom (anchored on cursor)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.001)
      setZoom(z => {
        const newZ = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor))
        const ratio = newZ / z
        setPan(p => ({ x: mx - (mx - p.x) * ratio, y: my - (my - p.y) * ratio }))
        return newZ
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  // Render
  useEffect(() => {
    const canvas = canvasRef.current
    const c = containerRef.current
    if (!canvas || !c) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = c.clientWidth * dpr
    canvas.height = c.clientHeight * dpr
    canvas.style.width = `${c.clientWidth}px`
    canvas.style.height = `${c.clientHeight}px`
    const ctx = canvas.getContext('2d')!
    ctx.save()
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, c.clientWidth, c.clientHeight)

    const k = baseScale * zoom
    ctx.setTransform(k * dpr, 0, 0, k * dpr, pan.x * dpr, pan.y * dpr)

    if (image) ctx.drawImage(image, 0, 0)

    if (showCanny && cannyPixels.length > 0) {
      ctx.fillStyle = 'rgba(255, 0, 0, 0.6)'
      const r = Math.max(0.5 / k, 0.3)
      for (const p of cannyPixels) {
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2)
      }
    }

    prop.contourParts.forEach((part, i) => {
      if (part.length === 0) return
      const color = PART_COLORS[i % PART_COLORS.length]
      ctx.beginPath()
      ctx.moveTo(part[0].x, part[0].y)
      for (let j = 1; j < part.length; j++) ctx.lineTo(part[j].x, part[j].y)
      ctx.closePath()
      ctx.fillStyle = color + '55'
      ctx.fill()
      ctx.strokeStyle = color
      ctx.lineWidth = 2 / k
      ctx.stroke()
    })

    ctx.restore()
  }, [image, cannyPixels, showCanny, prop.contourParts, pan, zoom, baseScale])

  // Pointer handlers
  function screenToImage(e: React.PointerEvent): Point2D {
    const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const k = baseScale * zoom
    return { x: (sx - pan.x) / k, y: (sy - pan.y) / k }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (spaceDown || e.button === 1 || (e.button === 0 && e.altKey)) {
      dragRef.current = { panX: pan.x, panY: pan.y, mx: e.clientX, my: e.clientY }
      ;(e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    const pt = screenToImage(e)

    // Click inside an existing part → remove it.
    for (let i = 0; i < prop.contourParts.length; i++) {
      if (pointInPolygon(pt, prop.contourParts[i])) {
        const next = prop.contourParts.filter((_, j) => j !== i)
        void onSave({ ...prop, contourParts: next })
        return
      }
    }

    // Otherwise: snap to canny + flood-fill new part.
    if (cannyPixels.length === 0) return
    const snapped = nearestCanny(pt, cannyPixels, SNAP_RADIUS)
    if (!snapped) return
    const part = floodFillCannyComponent(snapped, cannyPixels)
    if (part.length < 5) return  // bruit
    void onSave({ ...prop, contourParts: [...prop.contourParts, part] })
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return
    const d = dragRef.current
    setPan({ x: d.panX + (e.clientX - d.mx), y: d.panY + (e.clientY - d.my) })
  }
  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      ;(e.currentTarget as HTMLCanvasElement).releasePointerCapture(e.pointerId)
      dragRef.current = null
    }
  }

  if (!refBlob) {
    return (
      <div className="prop-step prop-step--contour">
        <p>Importez d’abord une <strong>image de référence</strong> dans la Triangulation projet.</p>
      </div>
    )
  }

  // Si l'accessoire provient de la Triangulation projet, l'édition du contour
  // est verrouillée — le contour se met à jour automatiquement à chaque
  // validation de l'étape Zones.
  if (prop.source === 'triangulation') {
    return (
      <div className="prop-step prop-step--contour">
        <div className="props-warning" style={{ marginBottom: 12 }}>
          Cet accessoire provient de la <strong>Triangulation projet</strong> (zone «&nbsp;{prop.name}&nbsp;»
          marquée comme accessoire). Son contour est synchronisé automatiquement.
          Pour le modifier, retournez dans l’onglet Triangulation → étape Zones, ajustez la zone, et revalidez.
        </div>
        <p className="muted">
          {prop.contourParts.length} partie{prop.contourParts.length !== 1 ? 's' : ''}.
          Continuez à l’étape <strong>Attachement</strong> puis <strong>Réglages</strong>.
        </p>
      </div>
    )
  }

  return (
    <div className="prop-step prop-step--contour">
      <div className="prop-step-controls">
        <label>
          Canny low ({low}) :
          <input type="range" min={0} max={255} value={low} onChange={e => setLow(Number(e.target.value))} />
        </label>
        <label>
          Canny high ({high}) :
          <input type="range" min={0} max={255} value={high} onChange={e => setHigh(Number(e.target.value))} />
        </label>
        <label>
          Blur ({blur}) :
          <input type="range" min={1} max={11} step={2} value={blur} onChange={e => setBlur(Number(e.target.value))} />
        </label>
        <label>
          <input type="checkbox" checked={showCanny} onChange={e => setShowCanny(e.target.checked)} />
          {' '}Afficher Canny
        </label>
        <button className="btn btn-secondary btn-sm" onClick={resetView}>Réinit. vue (Cmd/Ctrl+0)</button>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => void onSave({ ...prop, contourParts: [] })}
          disabled={prop.contourParts.length === 0}
        >
          Vider
        </button>
        <span className="muted">
          {prop.contourParts.length} partie{prop.contourParts.length !== 1 ? 's' : ''}{' '}
          {loading && '· calcul Canny…'}
        </span>
      </div>
      <p className="muted">
        Cliquez sur un trait pour ajouter une partie • cliquez dans une partie existante pour la supprimer •
        Espace+drag pour déplacer • molette pour zoomer.
      </p>
      <div
        ref={containerRef}
        className="prop-canvas-container"
        style={{
          position: 'relative',
          width: '100%',
          height: '60vh',
          minHeight: 400,
          background: '#fafafa',
          border: '1px solid var(--color-border)',
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: 'block', cursor: spaceDown ? (dragRef.current ? 'grabbing' : 'grab') : 'crosshair' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
    </div>
  )
}

function nearestCanny(target: Point2D, pixels: Point2D[], maxDist: number): Point2D | null {
  let best: Point2D | null = null
  let bestD = Infinity
  for (const p of pixels) {
    const d = Math.hypot(p.x - target.x, p.y - target.y)
    if (d < bestD) { bestD = d; best = p }
  }
  return best && bestD <= maxDist ? best : null
}
