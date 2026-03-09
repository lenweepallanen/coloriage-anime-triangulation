import { useState, useEffect, useRef, useCallback } from 'react'
import type { Project, MarkerCorners, Point2D } from '../../types/project'
import { drawAllMarkers } from '../../utils/markerGenerator'

interface Props {
  project: Project
  onSave: (project: Project) => Promise<void>
}

const CORNER_NAMES = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const
type CornerName = (typeof CORNER_NAMES)[number]

const CORNER_LABELS: Record<CornerName, string> = {
  topLeft: 'Haut-gauche',
  topRight: 'Haut-droite',
  bottomLeft: 'Bas-gauche',
  bottomRight: 'Bas-droite',
}

export default function MarkerStep({ project, onSave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [markers, setMarkers] = useState<Partial<MarkerCorners>>(project.markers ?? {})
  const [placing, setPlacing] = useState<CornerName | null>(null)
  const [saving, setSaving] = useState(false)
  const scaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })

  // Load image
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      redraw()
    }
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [project.originalImageBlob])

  // Resize
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      canvas.width = width
      canvas.height = height
      redraw()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Fit image
    const padding = 20
    const scale = Math.min(
      (canvas.width - padding * 2) / img.naturalWidth,
      (canvas.height - padding * 2) / img.naturalHeight
    )
    scaleRef.current = scale
    const ox = (canvas.width - img.naturalWidth * scale) / 2
    const oy = (canvas.height - img.naturalHeight * scale) / 2
    offsetRef.current = { x: ox, y: oy }

    ctx.drawImage(img, ox, oy, img.naturalWidth * scale, img.naturalHeight * scale)

    // Draw placed markers
    const fullMarkers = markers as Record<string, Point2D | undefined>
    for (const name of CORNER_NAMES) {
      const pos = fullMarkers[name]
      if (pos) {
        const sx = pos.x * scale + ox
        const sy = pos.y * scale + oy
        // Draw marker preview
        drawAllMarkers(ctx, {
          topLeft: name === 'topLeft' ? { x: sx, y: sy } : { x: -999, y: -999 },
          topRight: name === 'topRight' ? { x: sx, y: sy } : { x: -999, y: -999 },
          bottomLeft: name === 'bottomLeft' ? { x: sx, y: sy } : { x: -999, y: -999 },
          bottomRight: name === 'bottomRight' ? { x: sx, y: sy } : { x: -999, y: -999 },
        }, { size: 30, thickness: 8 })

        // Label
        ctx.fillStyle = '#4a90d9'
        ctx.font = '12px sans-serif'
        ctx.fillText(CORNER_LABELS[name], sx + 5, sy - 5)
      }
    }

    // Highlight placing mode
    if (placing) {
      ctx.fillStyle = 'rgba(74, 144, 217, 0.1)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }, [markers, placing])

  useEffect(() => { redraw() }, [redraw])

  function handleCanvasClick(e: React.MouseEvent) {
    if (!placing) return
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top

    // Convert to image coords
    const imgX = (cx - offsetRef.current.x) / scaleRef.current
    const imgY = (cy - offsetRef.current.y) / scaleRef.current

    setMarkers(prev => ({ ...prev, [placing]: { x: imgX, y: imgY } }))
    // Auto-advance to next unplaced marker
    const currentIdx = CORNER_NAMES.indexOf(placing)
    const nextUnplaced = CORNER_NAMES.find(
      (name, i) => i > currentIdx && !(markers as Record<string, unknown>)[name]
    )
    setPlacing(nextUnplaced ?? null)
  }

  function autoPlace() {
    const img = imageRef.current
    if (!img) return
    const margin = 20
    setMarkers({
      topLeft: { x: margin, y: margin },
      topRight: { x: img.naturalWidth - margin, y: margin },
      bottomLeft: { x: margin, y: img.naturalHeight - margin },
      bottomRight: { x: img.naturalWidth - margin, y: img.naturalHeight - margin },
    })
  }

  async function handleSave() {
    if (!isComplete()) return
    setSaving(true)
    await onSave({
      ...project,
      markers: markers as MarkerCorners,
    })
    setSaving(false)
  }

  function isComplete() {
    return CORNER_NAMES.every(name => (markers as Record<string, unknown>)[name])
  }

  if (!project.originalImageBlob) {
    return <div className="placeholder">Importez d'abord une image dans l'onglet Import.</div>
  }

  return (
    <div className="marker-step">
      <div className="triangulation-toolbar">
        {CORNER_NAMES.map(name => (
          <button
            key={name}
            className={placing === name ? 'active' : ''}
            onClick={() => setPlacing(name)}
          >
            {CORNER_LABELS[name]}
            {(markers as Record<string, unknown>)[name] ? ' ✓' : ''}
          </button>
        ))}

        <span className="toolbar-separator" />

        <button onClick={autoPlace}>Placement auto</button>
        <button onClick={handleSave} disabled={saving || !isComplete()}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder markers'}
        </button>
      </div>

      <div className="triangulation-help">
        {placing ? (
          <span>Cliquez sur l'image pour placer le marker {CORNER_LABELS[placing]}</span>
        ) : (
          <span>Sélectionnez un coin à placer ou utilisez le placement automatique</span>
        )}
      </div>

      <div ref={containerRef} className="triangulation-canvas-container">
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          style={{ cursor: placing ? 'crosshair' : 'default' }}
        />
      </div>
    </div>
  )
}
