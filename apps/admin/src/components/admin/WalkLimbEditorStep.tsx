/**
 * WalkLimbEditorStep — Draw closed Bezier curves around each limb.
 *
 * Interaction:
 * - Click to place vertices (polyline / corner mode)
 * - Double-click a vertex to toggle smooth mode (shows Bezier handles)
 * - Drag anchors to move, drag handles to curve
 * - Right-click to delete a vertex
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { Project, Animation, BezierNode, WalkLimbZone } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { flattenClosedBezier, nearestOnCubicBezier, splitCubicBezier } from '../../utils/bezierUtils'
import { separateLimbs } from '../../utils/limbSeparation'
import { pointInPolygon } from '../../utils/geometry'

const POINT_RADIUS = 5
const HANDLE_RADIUS = 4
const HIT_RADIUS = 12
const DEFAULT_HANDLE_DISTANCE = 30

const DEFAULT_ZONES: Omit<WalkLimbZone, 'id' | 'bezierNodes'>[] = [
  { label: 'Patte AV gauche', color: '#3b82f6', zOrder: 1, legIndex: 0 },
  { label: 'Patte AV droite', color: '#22c55e', zOrder: -1, legIndex: 1 },
  { label: 'Patte AR gauche', color: '#f59e0b', zOrder: 2, legIndex: 2 },
  { label: 'Patte AR droite', color: '#ef4444', zOrder: -2, legIndex: 3 },
]

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

type DragTarget =
  | { type: 'anchor'; zoneIdx: number; nodeIdx: number }
  | { type: 'handleIn'; zoneIdx: number; nodeIdx: number }
  | { type: 'handleOut'; zoneIdx: number; nodeIdx: number }

export default function WalkLimbEditorStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const restAnim = project.animations.find(a => a.type === 'rest')
  const restMesh = restAnim?.mesh

  const [zones, setZones] = useState<WalkLimbZone[]>(() => {
    if (mesh?.walkLimbSeparation?.zones?.length === 4) {
      return mesh.walkLimbSeparation.zones
    }
    return DEFAULT_ZONES.map(z => ({
      ...z,
      id: crypto.randomUUID(),
      bezierNodes: [],
    }))
  })

  const [activeZoneIdx, setActiveZoneIdx] = useState(0)
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null)
  const [saving, setSaving] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  const restAllPoints = useMemo(() => {
    if (!restMesh?.topologyLocked) return []
    return [
      ...(restMesh.contourAnchors || []),
      ...(restMesh.contourSubdivisionPoints || []),
      ...(restMesh.anchorPoints || []),
      ...(restMesh.internalPoints || []),
    ]
  }, [restMesh])

  // Load image + re-fit on resize/remount
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImageLoaded(true)
      requestAnimationFrame(() => fitToCanvas(img.width, img.height))
    }
    img.src = url

    // Re-fit when canvas becomes visible or resizes (handles step switching)
    const canvas = canvasRef.current
    let ro: ResizeObserver | null = null
    if (canvas) {
      ro = new ResizeObserver(() => {
        if (imageRef.current && canvas.clientWidth > 0) {
          fitToCanvas(imageRef.current.naturalWidth, imageRef.current.naturalHeight)
        }
      })
      ro.observe(canvas)
    }

    return () => {
      imageRef.current = null
      setImageLoaded(false)
      URL.revokeObjectURL(url)
      ro?.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob])

  // ─── Helpers to update zones immutably ──────────────────────────────

  function updateZoneNodes(zoneIdx: number, updater: (nodes: BezierNode[]) => BezierNode[]) {
    setZones(prev => {
      const next = [...prev]
      next[zoneIdx] = { ...next[zoneIdx], bezierNodes: updater([...next[zoneIdx].bezierNodes]) }
      return next
    })
  }

  // ─── Draw loop ──────────────────────────────────────────────────────

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

    // Image
    ctx.drawImage(img, 0, 0)

    // Draw triangulation wireframe
    if (restMesh?.triangles && restAllPoints.length > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
      ctx.lineWidth = 0.5 / t.scale
      for (const [a, b, c] of restMesh.triangles) {
        if (a >= restAllPoints.length || b >= restAllPoints.length || c >= restAllPoints.length) continue
        ctx.beginPath()
        ctx.moveTo(restAllPoints[a].x, restAllPoints[a].y)
        ctx.lineTo(restAllPoints[b].x, restAllPoints[b].y)
        ctx.lineTo(restAllPoints[c].x, restAllPoints[c].y)
        ctx.closePath()
        ctx.stroke()
      }
    }

    // Draw zone fills (non-active first)
    for (let zi = 0; zi < zones.length; zi++) {
      if (zi === activeZoneIdx) continue
      drawZoneFill(ctx, zones[zi], 0.12)
    }
    drawZoneFill(ctx, zones[activeZoneIdx], 0.25)

    // Color assigned triangles
    if (restMesh?.triangles && restAllPoints.length > 0) {
      for (let zi = 0; zi < zones.length; zi++) {
        const zone = zones[zi]
        if (zone.bezierNodes.length < 3) continue
        const polygon = flattenClosedBezier(zone.bezierNodes, 20)
        ctx.fillStyle = hexToRgba(zone.color, zi === activeZoneIdx ? 0.2 : 0.1)
        for (const [a, b, c] of restMesh.triangles) {
          if (a >= restAllPoints.length || b >= restAllPoints.length || c >= restAllPoints.length) continue
          const cent = {
            x: (restAllPoints[a].x + restAllPoints[b].x + restAllPoints[c].x) / 3,
            y: (restAllPoints[a].y + restAllPoints[b].y + restAllPoints[c].y) / 3,
          }
          if (pointInPolygon(cent, polygon)) {
            ctx.beginPath()
            ctx.moveTo(restAllPoints[a].x, restAllPoints[a].y)
            ctx.lineTo(restAllPoints[b].x, restAllPoints[b].y)
            ctx.lineTo(restAllPoints[c].x, restAllPoints[c].y)
            ctx.closePath()
            ctx.fill()
          }
        }
      }
    }

    // Draw curves and control points
    for (let zi = 0; zi < zones.length; zi++) {
      const zone = zones[zi]
      const isActive = zi === activeZoneIdx
      drawCurve(ctx, zone, t.scale, isActive)
      if (isActive) {
        drawNodes(ctx, zone, t.scale)
      }
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, activeZoneIdx, restMesh, restAllPoints, transformRef, imageLoaded])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // ─── Mouse handlers ─────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button === 2) { handleContextMenu(e); return }
    if (e.button !== 0 || spaceDown.current || isPanning.current) return
    const canvas = canvasRef.current
    if (!canvas) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    const zone = zones[activeZoneIdx]

    // Check hit on handles of smooth nodes (only smooth nodes show handles)
    for (let ni = 0; ni < zone.bezierNodes.length; ni++) {
      const node = zone.bezierNodes[ni]
      if (!node.smooth) continue
      if (Math.hypot(node.handleIn.x - imgPt.x, node.handleIn.y - imgPt.y) < hitR) {
        setDragTarget({ type: 'handleIn', zoneIdx: activeZoneIdx, nodeIdx: ni })
        return
      }
      if (Math.hypot(node.handleOut.x - imgPt.x, node.handleOut.y - imgPt.y) < hitR) {
        setDragTarget({ type: 'handleOut', zoneIdx: activeZoneIdx, nodeIdx: ni })
        return
      }
    }

    // Check hit on anchors
    for (let ni = 0; ni < zone.bezierNodes.length; ni++) {
      const node = zone.bezierNodes[ni]
      if (Math.hypot(node.anchor.x - imgPt.x, node.anchor.y - imgPt.y) < hitR) {
        setDragTarget({ type: 'anchor', zoneIdx: activeZoneIdx, nodeIdx: ni })
        return
      }
    }

    // Check hit on a curve segment (insert point on segment)
    if (zone.bezierNodes.length >= 2) {
      const n = zone.bezierNodes.length
      let bestDist = Infinity
      let bestSeg = -1
      let bestT = 0
      const segHitR = 8 / t.scale

      for (let i = 0; i < n; i++) {
        const curr = zone.bezierNodes[i]
        const next = zone.bezierNodes[(i + 1) % n]
        const result = nearestOnCubicBezier(
          curr.anchor, curr.handleOut, next.handleIn, next.anchor, imgPt
        )
        if (result.dist < bestDist) {
          bestDist = result.dist
          bestSeg = i
          bestT = result.t
        }
      }

      if (bestDist < segHitR && bestSeg >= 0) {
        // Split the Bezier segment at bestT using De Casteljau
        const curr = zone.bezierNodes[bestSeg]
        const next = zone.bezierNodes[(bestSeg + 1) % zone.bezierNodes.length]
        const { left, right } = splitCubicBezier(
          curr.anchor, curr.handleOut, next.handleIn, next.anchor, bestT
        )

        // New node at the split point (corner by default)
        const splitPt = left[3] // = right[0] = the split point
        const newNode: BezierNode = {
          anchor: splitPt,
          handleIn: { ...splitPt },
          handleOut: { ...splitPt },
          smooth: false,
        }

        updateZoneNodes(activeZoneIdx, nodes => {
          const updated = [...nodes]
          // Update curr's handleOut to left[1]
          updated[bestSeg] = { ...updated[bestSeg], handleOut: updated[bestSeg].smooth ? left[1] : { ...updated[bestSeg].anchor } }
          // Update next's handleIn to right[2]
          const nextIdx = (bestSeg + 1) % updated.length
          updated[nextIdx] = { ...updated[nextIdx], handleIn: updated[nextIdx].smooth ? right[2] : { ...updated[nextIdx].anchor } }
          // Insert new node after bestSeg
          updated.splice(bestSeg + 1, 0, newNode)
          return updated
        })
        return
      }
    }

    // Not hitting anything → place a new corner node at end
    const newNode: BezierNode = {
      anchor: imgPt,
      handleIn: { ...imgPt },
      handleOut: { ...imgPt },
      smooth: false,
    }

    updateZoneNodes(activeZoneIdx, nodes => [...nodes, newNode])
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragTarget) return
    const imgPt = screenToImage(e.clientX, e.clientY)

    updateZoneNodes(dragTarget.zoneIdx, nodes => {
      const node = { ...nodes[dragTarget.nodeIdx] }

      if (dragTarget.type === 'anchor') {
        const dx = imgPt.x - node.anchor.x
        const dy = imgPt.y - node.anchor.y
        node.anchor = imgPt
        node.handleIn = { x: node.handleIn.x + dx, y: node.handleIn.y + dy }
        node.handleOut = { x: node.handleOut.x + dx, y: node.handleOut.y + dy }
      } else if (dragTarget.type === 'handleIn') {
        node.handleIn = imgPt
        // Mirror handleOut
        const dx = imgPt.x - node.anchor.x
        const dy = imgPt.y - node.anchor.y
        const outDist = Math.hypot(node.handleOut.x - node.anchor.x, node.handleOut.y - node.anchor.y)
        const len = Math.hypot(dx, dy) || 1
        node.handleOut = {
          x: node.anchor.x - (dx / len) * outDist,
          y: node.anchor.y - (dy / len) * outDist,
        }
      } else if (dragTarget.type === 'handleOut') {
        node.handleOut = imgPt
        // Mirror handleIn
        const dx = imgPt.x - node.anchor.x
        const dy = imgPt.y - node.anchor.y
        const inDist = Math.hypot(node.handleIn.x - node.anchor.x, node.handleIn.y - node.anchor.y)
        const len = Math.hypot(dx, dy) || 1
        node.handleIn = {
          x: node.anchor.x - (dx / len) * inDist,
          y: node.anchor.y - (dy / len) * inDist,
        }
      }

      nodes[dragTarget.nodeIdx] = node
      return nodes
    })
  }

  function handleMouseUp() {
    setDragTarget(null)
  }

  function handleDoubleClick(e: React.MouseEvent) {
    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    const zone = zones[activeZoneIdx]
    for (let ni = 0; ni < zone.bezierNodes.length; ni++) {
      const node = zone.bezierNodes[ni]
      if (Math.hypot(node.anchor.x - imgPt.x, node.anchor.y - imgPt.y) < hitR) {
        // Toggle smooth
        updateZoneNodes(activeZoneIdx, nodes => {
          const n = { ...nodes[ni] }
          n.smooth = !n.smooth
          if (n.smooth) {
            // Initialize handles from neighbors
            const prev = nodes[(ni - 1 + nodes.length) % nodes.length]
            const next = nodes[(ni + 1) % nodes.length]
            const dx = next.anchor.x - prev.anchor.x
            const dy = next.anchor.y - prev.anchor.y
            const len = Math.hypot(dx, dy) || 1
            const dist = DEFAULT_HANDLE_DISTANCE / t.scale
            const nx = dx / len, ny = dy / len
            n.handleIn = { x: n.anchor.x - nx * dist, y: n.anchor.y - ny * dist }
            n.handleOut = { x: n.anchor.x + nx * dist, y: n.anchor.y + ny * dist }
          } else {
            // Collapse handles onto anchor
            n.handleIn = { ...n.anchor }
            n.handleOut = { ...n.anchor }
          }
          nodes[ni] = n
          return nodes
        })
        return
      }
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    const zone = zones[activeZoneIdx]
    for (let ni = 0; ni < zone.bezierNodes.length; ni++) {
      const node = zone.bezierNodes[ni]
      if (Math.hypot(node.anchor.x - imgPt.x, node.anchor.y - imgPt.y) < hitR) {
        updateZoneNodes(activeZoneIdx, nodes => nodes.filter((_, i) => i !== ni))
        return
      }
    }
  }

  // ─── Zone z-order / clear ───────────────────────────────────────────

  function moveZOrder(zoneIdx: number, delta: number) {
    setZones(prev => {
      const next = [...prev]
      next[zoneIdx] = { ...next[zoneIdx], zOrder: next[zoneIdx].zOrder + delta }
      return next
    })
  }

  function clearZone(zoneIdx: number) {
    updateZoneNodes(zoneIdx, () => [])
  }

  // ─── Validation ─────────────────────────────────────────────────────

  const allZonesDefined = zones.every(z => z.bezierNodes.length >= 3)

  async function handleValidate() {
    console.log('[WalkLimb] handleValidate', {
      allZonesDefined,
      hasMesh: !!mesh,
      restTrianglesLen: restMesh?.triangles?.length,
      restAllPointsLen: restAllPoints.length,
      zoneCounts: zones.map(z => z.bezierNodes.length),
    })
    if (!allZonesDefined || !mesh || !restMesh?.triangles?.length || restAllPoints.length === 0) {
      console.log('[WalkLimb] early return')
      return
    }

    setSaving(true)
    try {
      const separation = separateLimbs(restAllPoints, restMesh.triangles, zones, 3)

      const updatedMesh = {
        ...mesh,
        walkLimbSeparation: separation,
        walkLimbSeparationValidated: true,
        walkSkeletonValidated: false,
        walkBodyValidated: false,
        walkParamsValidated: false,
        videoFramesMesh: null,
        walkZoneFrames: null,
        walkBodyFrames: null,
      }

      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave({ ...project, animations: updatedAnims })
    } catch (err) {
      console.error('[WalkLimb] save failed:', err)
    }
    setSaving(false)
  }

  // ─── Render ─────────────────────────────────────────────────────────

  if (!restMesh?.topologyLocked) {
    return (
      <div style={{ padding: 20, color: '#f59e0b' }}>
        La rest animation doit avoir une triangulation verrouillée avant de définir les zones de membres.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 500, display: 'block', borderRadius: 8 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
        />
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13 }}>
          Clic = ajouter un sommet. Double-clic sur un sommet = activer/desactiver les poignees courbes.
          Drag = deplacer. Clic droit = supprimer. Espace + drag = pan, Molette = zoom.
        </div>
      </div>

      {/* Side panel */}
      <div style={{ width: 280, flexShrink: 0, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Zones de membres</h3>

        {zones.map((zone, zi) => {
          const isActive = zi === activeZoneIdx
          const nodeCount = zone.bezierNodes.length
          const defined = nodeCount >= 3

          return (
            <div
              key={zone.id}
              onClick={() => setActiveZoneIdx(zi)}
              style={{
                padding: '10px 12px', marginBottom: 8, borderRadius: 8,
                border: isActive ? `2px solid ${zone.color}` : '2px solid #374151',
                background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 12, height: 12, borderRadius: '50%', background: zone.color, flexShrink: 0 }} />
                <span style={{ fontWeight: 600, fontSize: 14, color: '#e5e7eb', flex: 1 }}>{zone.label}</span>
                {defined && <span style={{ color: '#22c55e', fontSize: 12 }}>✓</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9ca3af' }}>
                <span>{nodeCount} pts</span>
                <span style={{ margin: '0 4px' }}>·</span>
                <span>z: {zone.zOrder}</span>
                <button onClick={(e) => { e.stopPropagation(); moveZOrder(zi, 1) }}
                  style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: '0 2px', fontSize: 14 }}
                  title="Augmenter z-order">▲</button>
                <button onClick={(e) => { e.stopPropagation(); moveZOrder(zi, -1) }}
                  style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', padding: '0 2px', fontSize: 14 }}
                  title="Diminuer z-order">▼</button>
                <span style={{ flex: 1 }} />
                {nodeCount > 0 && (
                  <button onClick={(e) => { e.stopPropagation(); clearZone(zi) }}
                    style={{ background: 'none', border: '1px solid #ef4444', color: '#ef4444', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>
                    Effacer
                  </button>
                )}
              </div>
            </div>
          )
        })}

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          Dessinez une courbe fermee autour de chaque membre (min 3 points).
          Double-clic sur un sommet pour lisser la courbe.
        </div>

        {!mesh && (
          <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>
            Le mesh de cette animation est vide. Recreez l'animation walk.
          </div>
        )}
        {mesh && restAllPoints.length === 0 && (
          <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 8 }}>
            La rest animation n'a pas de triangulation verrouillee.
          </div>
        )}

        <button
          className="btn-primary"
          onClick={handleValidate}
          disabled={!allZonesDefined || saving || !mesh || restAllPoints.length === 0}
          style={{ width: '100%' }}
        >
          {saving ? 'Calcul en cours...' : allZonesDefined ? 'Valider les zones' : `Definir les 4 zones (${zones.filter(z => z.bezierNodes.length >= 3).length}/4)`}
        </button>
      </div>
    </div>
  )
}

// ─── Drawing helpers ──────────────────────────────────────────────────

function drawZoneFill(ctx: CanvasRenderingContext2D, zone: WalkLimbZone, alpha: number) {
  if (zone.bezierNodes.length < 3) return
  const polygon = flattenClosedBezier(zone.bezierNodes, 20)
  ctx.fillStyle = hexToRgba(zone.color, alpha)
  ctx.beginPath()
  if (polygon.length > 0) {
    ctx.moveTo(polygon[0].x, polygon[0].y)
    for (let i = 1; i < polygon.length; i++) ctx.lineTo(polygon[i].x, polygon[i].y)
    ctx.closePath()
    ctx.fill()
  }
}

/**
 * Draw the closed curve. For corner nodes the handles collapse to the anchor,
 * so bezierCurveTo draws a straight line automatically.
 */
function drawCurve(ctx: CanvasRenderingContext2D, zone: WalkLimbZone, scale: number, isActive: boolean) {
  const nodes = zone.bezierNodes
  if (nodes.length < 2) return

  ctx.strokeStyle = hexToRgba(zone.color, isActive ? 1 : 0.4)
  ctx.lineWidth = (isActive ? 2.5 : 1.5) / scale

  const n = nodes.length
  ctx.beginPath()
  ctx.moveTo(nodes[0].anchor.x, nodes[0].anchor.y)
  for (let i = 0; i < n; i++) {
    const curr = nodes[i]
    const next = nodes[(i + 1) % n]
    ctx.bezierCurveTo(
      curr.handleOut.x, curr.handleOut.y,
      next.handleIn.x, next.handleIn.y,
      next.anchor.x, next.anchor.y,
    )
  }
  ctx.stroke()
}

/** Draw anchor points and, for smooth nodes, their handles. */
function drawNodes(ctx: CanvasRenderingContext2D, zone: WalkLimbZone, scale: number) {
  const nodes = zone.bezierNodes
  const pr = POINT_RADIUS / scale
  const hr = HANDLE_RADIUS / scale

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]

    if (node.smooth) {
      // Handle lines
      ctx.strokeStyle = 'rgba(255, 60, 60, 0.6)'
      ctx.lineWidth = 1 / scale
      ctx.beginPath()
      ctx.moveTo(node.handleIn.x, node.handleIn.y)
      ctx.lineTo(node.anchor.x, node.anchor.y)
      ctx.lineTo(node.handleOut.x, node.handleOut.y)
      ctx.stroke()

      // Handle dots
      ctx.fillStyle = '#ff3c3c'
      ctx.beginPath(); ctx.arc(node.handleIn.x, node.handleIn.y, hr, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.arc(node.handleOut.x, node.handleOut.y, hr, 0, Math.PI * 2); ctx.fill()
    }

    // Anchor: circle for smooth, square for corner
    ctx.fillStyle = zone.color
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2 / scale

    if (node.smooth) {
      ctx.beginPath()
      ctx.arc(node.anchor.x, node.anchor.y, pr, 0, Math.PI * 2)
      ctx.fill(); ctx.stroke()
    } else {
      ctx.fillRect(node.anchor.x - pr, node.anchor.y - pr, pr * 2, pr * 2)
      ctx.strokeRect(node.anchor.x - pr, node.anchor.y - pr, pr * 2, pr * 2)
    }

    // Label
    ctx.fillStyle = '#fff'
    ctx.font = `${10 / scale}px sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(String(i + 1), node.anchor.x, node.anchor.y - pr - 3 / scale)
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
