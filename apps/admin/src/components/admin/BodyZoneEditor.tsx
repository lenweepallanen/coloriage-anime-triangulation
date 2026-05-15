import { useRef, useEffect, useState, useCallback } from 'react'
import { getGeometryOwner, type Project, type Point2D, type BodyZone } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { findTriangleAtPoint } from '../../utils/bodyZoneUtils'

const ZONE_COLORS = [
  '#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#6c5ce7',
  '#a8e6cf', '#ff8a5c', '#ea8685', '#78e08f', '#e056fd',
]

interface Props {
  project: Project
  onSave: (updated: Project, hints?: UploadHint[]) => Promise<void>
}

export default function BodyZoneEditor({ project, onSave }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)

  // Source de la topologie : rest legacy si présent, sinon n'importe quelle animation
  // avec topologie verrouillée (members-bones autonomes notamment).
  const owner = getGeometryOwner(project.animations)!
  const mesh = owner.mesh!

  const allPoints: Point2D[] = [
    ...mesh.contourAnchors,
    ...mesh.contourSubdivisionPoints,
    ...mesh.anchorPoints,
    ...mesh.internalPoints,
  ]

  const [zones, setZones] = useState<BodyZone[]>(() =>
    (project.bodyZones ?? []).map(z => ({
      ...z,
      // Migrate legacy vertexIndices → triangleIndices
      triangleIndices: z.triangleIndices ?? (z as unknown as { vertexIndices?: number[] }).vertexIndices ?? [],
    }))
  )
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const [isRectSelecting, setIsRectSelecting] = useState(false)
  const rectStartRef = useRef<Point2D | null>(null)
  const rectEndRef = useRef<Point2D | null>(null)
  const [saving, setSaving] = useState(false)

  const zonesRef = useRef(zones)
  zonesRef.current = zones
  const selectedZoneIdRef = useRef(selectedZoneId)
  selectedZoneIdRef.current = selectedZoneId

  // Build triangle→zone lookup for rendering
  const buildTriZoneMap = useCallback((): Map<number, string> => {
    const map = new Map<number, string>()
    for (const z of zonesRef.current) {
      for (const ti of z.triangleIndices) map.set(ti, z.id)
    }
    return map
  }, [])

  // Load image
  useEffect(() => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.onload = () => {
      imageRef.current = img
      // Delay fitToCanvas to next frame so the canvas has its CSS dimensions
      requestAnimationFrame(() => {
        fitToCanvas(img.naturalWidth, img.naturalHeight)
        setImageLoaded(true)
      })
    }
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [project.originalImageBlob, fitToCanvas])

  // Canvas rendering
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return

    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    ctx.clearRect(0, 0, rect.width, rect.height)

    const t = transformRef.current
    ctx.save()
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(t.scale, t.scale)

    // Background image
    ctx.drawImage(img, 0, 0)

    const triZoneMap = buildTriZoneMap()
    const zoneColorMap = new Map<string, string>()
    for (const z of zonesRef.current) zoneColorMap.set(z.id, z.color)

    const selectedId = selectedZoneIdRef.current

    // Draw filled triangles colored by zone
    for (let ti = 0; ti < mesh.triangles.length; ti++) {
      const tri = mesh.triangles[ti]
      const a = allPoints[tri[0]], b = allPoints[tri[1]], c = allPoints[tri[2]]
      const zoneId = triZoneMap.get(ti)

      if (zoneId) {
        const color = zoneColorMap.get(zoneId) ?? '#888'
        const isSelected = zoneId === selectedId
        ctx.fillStyle = color + (isSelected ? '70' : '40')
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()
        ctx.fill()
      }

      // Wireframe
      ctx.strokeStyle = zoneId ? 'rgba(150,150,150,0.5)' : 'rgba(150,150,150,0.3)'
      ctx.lineWidth = 0.5 / t.scale
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.lineTo(c.x, c.y)
      ctx.closePath()
      ctx.stroke()
    }

    // Draw selection rectangle
    if (rectStartRef.current && rectEndRef.current) {
      const rs = rectStartRef.current
      const re = rectEndRef.current
      const rx = Math.min(rs.x, re.x)
      const ry = Math.min(rs.y, re.y)
      const rw = Math.abs(re.x - rs.x)
      const rh = Math.abs(re.y - rs.y)
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)'
      ctx.lineWidth = 1.5 / t.scale
      ctx.setLineDash([6 / t.scale, 4 / t.scale])
      ctx.strokeRect(rx, ry, rw, rh)
      ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'
      ctx.fillRect(rx, ry, rw, rh)
      ctx.setLineDash([])
    }

    ctx.restore()
  }, [mesh.triangles, allPoints, transformRef, buildTriZoneMap])

  // Animation loop for canvas
  useEffect(() => {
    if (!imageLoaded) return
    let running = true
    const loop = () => {
      if (!running) return
      draw()
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    return () => { running = false }
  }, [imageLoaded, draw])

  // Toggle triangle in/out of zone
  const toggleTriangle = useCallback((triIdx: number) => {
    const zoneId = selectedZoneIdRef.current
    if (!zoneId || triIdx < 0) return

    setZones(prev => prev.map(z => {
      if (z.id === zoneId) {
        if (z.triangleIndices.includes(triIdx)) {
          return { ...z, triangleIndices: z.triangleIndices.filter(ti => ti !== triIdx) }
        }
        return { ...z, triangleIndices: [...z.triangleIndices, triIdx] }
      }
      // Remove from other zones
      if (z.triangleIndices.includes(triIdx)) {
        return { ...z, triangleIndices: z.triangleIndices.filter(ti => ti !== triIdx) }
      }
      return z
    }))
  }, [])

  // Assign triangle to selected zone (paint mode — no toggle, only add)
  const paintTriangle = useCallback((triIdx: number) => {
    const zoneId = selectedZoneIdRef.current
    if (!zoneId || triIdx < 0) return

    setZones(prev => {
      const already = prev.find(z => z.id === zoneId)
      if (already?.triangleIndices.includes(triIdx)) return prev
      return prev.map(z => {
        if (z.id === zoneId) {
          if (z.triangleIndices.includes(triIdx)) return z
          return { ...z, triangleIndices: [...z.triangleIndices, triIdx] }
        }
        if (z.triangleIndices.includes(triIdx)) {
          return { ...z, triangleIndices: z.triangleIndices.filter(ti => ti !== triIdx) }
        }
        return z
      })
    })
  }, [])

  // Remove triangle from all zones
  const removeTriangle = useCallback((triIdx: number) => {
    if (triIdx < 0) return
    setZones(prev => prev.map(z =>
      z.triangleIndices.includes(triIdx)
        ? { ...z, triangleIndices: z.triangleIndices.filter(ti => ti !== triIdx) }
        : z
    ))
  }, [])

  // Assign all triangles whose centroid is in rectangle
  const assignTrianglesInRect = useCallback((start: Point2D, end: Point2D) => {
    const zoneId = selectedZoneIdRef.current
    if (!zoneId) return

    const minX = Math.min(start.x, end.x)
    const maxX = Math.max(start.x, end.x)
    const minY = Math.min(start.y, end.y)
    const maxY = Math.max(start.y, end.y)

    const insideIndices: number[] = []
    for (let i = 0; i < mesh.triangles.length; i++) {
      const tri = mesh.triangles[i]
      const a = allPoints[tri[0]], b = allPoints[tri[1]], c = allPoints[tri[2]]
      const cx = (a.x + b.x + c.x) / 3
      const cy = (a.y + b.y + c.y) / 3
      if (cx >= minX && cx <= maxX && cy >= minY && cy <= maxY) {
        insideIndices.push(i)
      }
    }
    if (insideIndices.length === 0) return

    setZones(prev => prev.map(z => {
      if (z.id === zoneId) {
        const existing = new Set(z.triangleIndices)
        for (const ti of insideIndices) existing.add(ti)
        return { ...z, triangleIndices: Array.from(existing) }
      }
      const toRemove = new Set(insideIndices)
      const filtered = z.triangleIndices.filter(ti => !toRemove.has(ti))
      return filtered.length !== z.triangleIndices.length ? { ...z, triangleIndices: filtered } : z
    }))
  }, [mesh.triangles, allPoints])

  // Canvas mouse handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (spaceDown.current || isPanning.current) return
    if (e.button === 1) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const triIdx = findTriangleAtPoint(imgPt, allPoints, mesh.triangles)

    if (e.button === 2) {
      e.preventDefault()
      removeTriangle(triIdx)
      return
    }

    if (e.button === 0) {
      if (triIdx >= 0 && selectedZoneIdRef.current) {
        toggleTriangle(triIdx)
        setIsDragging(true)
      } else if (selectedZoneIdRef.current) {
        // Click outside mesh: start rectangle selection
        rectStartRef.current = imgPt
        rectEndRef.current = imgPt
        setIsRectSelecting(true)
      }
    }
  }, [screenToImage, allPoints, mesh.triangles, toggleTriangle, removeTriangle, spaceDown, isPanning])

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (spaceDown.current) return

    if (isRectSelecting) {
      rectEndRef.current = screenToImage(e.clientX, e.clientY)
      return
    }

    if (!isDragging) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const triIdx = findTriangleAtPoint(imgPt, allPoints, mesh.triangles)
    if (triIdx >= 0 && selectedZoneIdRef.current) {
      paintTriangle(triIdx)
    }
  }, [isDragging, isRectSelecting, screenToImage, allPoints, mesh.triangles, paintTriangle, spaceDown])

  const handleMouseUp = useCallback(() => {
    if (isRectSelecting && rectStartRef.current && rectEndRef.current) {
      assignTrianglesInRect(rectStartRef.current, rectEndRef.current)
    }
    rectStartRef.current = null
    rectEndRef.current = null
    setIsRectSelecting(false)
    setIsDragging(false)
  }, [isRectSelecting, assignTrianglesInRect])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // Zone management
  const addZone = useCallback(() => {
    const newZone: BodyZone = {
      id: crypto.randomUUID(),
      label: `Zone ${zones.length + 1}`,
      color: ZONE_COLORS[zones.length % ZONE_COLORS.length],
      triangleIndices: [],
    }
    setZones(prev => [...prev, newZone])
    setSelectedZoneId(newZone.id)
  }, [zones.length])

  const deleteZone = useCallback((zoneId: string) => {
    setZones(prev => prev.filter(z => z.id !== zoneId))
    if (selectedZoneId === zoneId) setSelectedZoneId(null)
  }, [selectedZoneId])

  const updateZoneColor = useCallback((zoneId: string, color: string) => {
    setZones(prev => prev.map(z => z.id === zoneId ? { ...z, color } : z))
  }, [])

  const startEditLabel = useCallback((zone: BodyZone) => {
    setEditingLabelId(zone.id)
    setEditingLabelValue(zone.label)
  }, [])

  const finishEditLabel = useCallback(() => {
    if (!editingLabelId) return
    const trimmed = editingLabelValue.trim()
    if (trimmed) {
      setZones(prev => prev.map(z => z.id === editingLabelId ? { ...z, label: trimmed } : z))
    }
    setEditingLabelId(null)
  }, [editingLabelId, editingLabelValue])

  // Save
  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await onSave({ ...project, bodyZones: zones })
    } finally {
      setSaving(false)
    }
  }, [project, zones, onSave])

  const hasChanges = JSON.stringify(zones) !== JSON.stringify(project.bodyZones ?? [])

  const totalTriangles = zones.reduce((acc, z) => acc + z.triangleIndices.length, 0)

  if (!project.originalImageBlob) {
    return (
      <div className="admin-section-disabled">
        <p>Importez une image de coloriage dans les Paramètres pour accéder à l'éditeur de zones.</p>
      </div>
    )
  }

  return (
    <div className="body-zone-editor">
      <div className="body-zone-editor-canvas-panel">
        {!imageLoaded && <div className="body-zone-loading">Chargement de l'image...</div>}
        <canvas
          ref={canvasRef}
          className="body-zone-canvas"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onContextMenu={handleContextMenu}
        />
      </div>

      <div className="body-zone-editor-side-panel">
        <div className="body-zone-editor-header">
          <h3>Zones Corporelles</h3>
          <button className="btn-sm btn-primary" onClick={addZone}>
            + Zone
          </button>
        </div>

        <div className="body-zone-list">
          {zones.map(zone => (
            <div
              key={zone.id}
              className={`body-zone-item ${selectedZoneId === zone.id ? 'body-zone-item--selected' : ''}`}
              onClick={() => setSelectedZoneId(zone.id)}
            >
              <input
                type="color"
                value={zone.color}
                onChange={e => updateZoneColor(zone.id, e.target.value)}
                className="body-zone-color"
                onClick={e => e.stopPropagation()}
              />

              <div className="body-zone-info">
                {editingLabelId === zone.id ? (
                  <input
                    type="text"
                    value={editingLabelValue}
                    onChange={e => setEditingLabelValue(e.target.value)}
                    onBlur={finishEditLabel}
                    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') finishEditLabel() }}
                    autoFocus
                    className="body-zone-label-input"
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="body-zone-label"
                    onDoubleClick={(e) => { e.stopPropagation(); startEditLabel(zone) }}
                  >
                    {zone.label}
                  </span>
                )}
                <span className="body-zone-count">{zone.triangleIndices.length} triangles</span>
              </div>

              <button
                className="btn-icon btn-sm btn-danger"
                onClick={(e) => { e.stopPropagation(); deleteZone(zone.id) }}
                title="Supprimer"
              >
                &times;
              </button>
            </div>
          ))}
          {zones.length === 0 && (
            <div className="body-zone-empty">
              Aucune zone. Cliquez "+ Zone" pour commencer.
            </div>
          )}
        </div>

        <div className="body-zone-help">
          <small>
            Sélectionnez une zone puis cliquez sur un triangle pour l'assigner.
            Glissez pour peindre. Rectangle dans le vide pour multi-sélection. Clic droit pour retirer.
          </small>
          {totalTriangles > 0 && (
            <small style={{ display: 'block', marginTop: 4 }}>
              {totalTriangles}/{mesh.triangles.length} triangles assignés
            </small>
          )}
        </div>

        <button
          className="btn-primary body-zone-save-btn"
          onClick={handleSave}
          disabled={!hasChanges || saving}
        >
          {saving ? 'Sauvegarde...' : 'Sauvegarder'}
        </button>
      </div>
    </div>
  )
}
