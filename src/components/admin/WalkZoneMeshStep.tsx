/**
 * WalkZoneMeshStep — Preview and edit the zone triangulations.
 *
 * Each limb zone has its own fresh Delaunay triangulation (from Bezier contour).
 * The body auto triangles are FIXED. User can manually add points + triangles:
 *  - Mode "Ajouter" : click = add point connected to 2 nearest vertices
 *  - Mode "Relier"  : select anchor point A, then click B, C, D → triangles [A,B,C], [A,C,D]...
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { Project, Animation, Point2D, WalkLimbSeparation } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { flattenClosedBezier } from '../../utils/bezierUtils'
import { triangulateZone, buildBodyMesh, findTwoNearest } from '../../utils/limbSeparation'

const POINT_RADIUS = 4
const HIT_RADIUS = 10

type BodyEditMode = 'add' | 'connect' | 'move'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function WalkZoneMeshStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const separation = mesh?.walkLimbSeparation

  // Per-zone extra internal points (editable)
  const [zoneInternals, setZoneInternals] = useState<Record<string, Point2D[]>>(() => {
    const init: Record<string, Point2D[]> = {}
    if (separation) {
      for (const zone of separation.zones) init[zone.id] = []
    }
    return init
  })

  // Body manual patch: extra points + manually created triangles
  const [bodyExtraPts, setBodyExtraPts] = useState<Point2D[]>(
    () => separation?.bodyExtraPoints ?? []
  )
  const [bodyManualTris, setBodyManualTris] = useState<[number, number, number][]>(
    () => separation?.bodyManualTriangles ?? []
  )
  const [bodyEditMode, setBodyEditMode] = useState<BodyEditMode>('add')

  // Connect mode state: anchor point + last connected point
  const [connectAnchor, setConnectAnchor] = useState<number | null>(null)
  const [connectLast, setConnectLast] = useState<number | null>(null)

  // Recompute zone triangulations when internals change
  const zoneMeshes = useMemo(() => {
    if (!separation) return null
    const result: Record<string, {
      points: Point2D[]
      triangles: [number, number, number][]
      contourCount: number
    }> = {}
    for (const zone of separation.zones) {
      const polygon = zone.bezierNodes.length >= 3 ? flattenClosedBezier(zone.bezierNodes, 30) : null
      if (!polygon) { result[zone.id] = { points: [], triangles: [], contourCount: 0 }; continue }
      const contourPts = sampleContourVertices(polygon, 10)
      const internals = zoneInternals[zone.id] || []
      const tri = triangulateZone(contourPts, internals, polygon)
      result[zone.id] = { points: tri.points, triangles: tri.triangles, contourCount: contourPts.length }
    }
    return result
  }, [separation, zoneInternals])

  // Build body mesh: auto FIXED + manual patch
  const bodyMesh = useMemo(() => {
    if (!separation) return null
    const autoBodyPts = separation.bodyPoints ?? []
    const autoBodyTris = separation.bodyTriangles ?? []
    return {
      ...buildBodyMesh(autoBodyPts, autoBodyTris, bodyExtraPts, bodyManualTris),
      autoCount: autoBodyPts.length,
      autoTriCount: autoBodyTris.length,
    }
  }, [separation, bodyExtraPts, bodyManualTris])

  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const [dragTarget, setDragTarget] = useState<{ zoneId: string; idx: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  // Load image
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
      setImageLoaded(false)
      URL.revokeObjectURL(url)
      ro?.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob])

  // ─── Draw ───────────────────────────────────────────────────────────

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

    if (!separation || !zoneMeshes) {
      ctx.restore()
      animFrameRef.current = requestAnimationFrame(draw)
      return
    }

    // Draw body triangles
    if (bodyMesh && bodyMesh.bodyTriangles.length > 0) {
      const isBodyActive = activeZoneId === '__body__'

      // Auto triangles — gray
      ctx.fillStyle = isBodyActive ? 'rgba(136,136,136,0.2)' : 'rgba(136,136,136,0.08)'
      ctx.strokeStyle = isBodyActive ? 'rgba(136,136,136,0.5)' : 'rgba(136,136,136,0.25)'
      ctx.lineWidth = (isBodyActive ? 1.2 : 0.6) / t.scale
      for (let ti = 0; ti < bodyMesh.autoTriCount; ti++) {
        const [a, b, c] = bodyMesh.bodyTriangles[ti]
        const pa = bodyMesh.bodyPoints[a], pb = bodyMesh.bodyPoints[b], pc = bodyMesh.bodyPoints[c]
        if (!pa || !pb || !pc) continue
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
        ctx.closePath(); ctx.fill(); ctx.stroke()
      }

      // Manual patch triangles — cyan tint
      if (bodyMesh.bodyTriangles.length > bodyMesh.autoTriCount) {
        ctx.fillStyle = isBodyActive ? 'rgba(6,182,212,0.18)' : 'rgba(6,182,212,0.08)'
        ctx.strokeStyle = isBodyActive ? 'rgba(6,182,212,0.6)' : 'rgba(6,182,212,0.3)'
        ctx.lineWidth = (isBodyActive ? 1.2 : 0.6) / t.scale
        for (let ti = bodyMesh.autoTriCount; ti < bodyMesh.bodyTriangles.length; ti++) {
          const [a, b, c] = bodyMesh.bodyTriangles[ti]
          const pa = bodyMesh.bodyPoints[a], pb = bodyMesh.bodyPoints[b], pc = bodyMesh.bodyPoints[c]
          if (!pa || !pb || !pc) continue
          ctx.beginPath()
          ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
          ctx.closePath(); ctx.fill(); ctx.stroke()
        }
      }
    }

    // Draw limb zone triangulations
    for (const zone of separation.zones) {
      const zm = zoneMeshes[zone.id]
      if (!zm || zm.triangles.length === 0) continue
      const isActive = zone.id === activeZoneId
      ctx.fillStyle = hexToRgba(zone.color, isActive ? 0.25 : 0.12)
      ctx.strokeStyle = hexToRgba(zone.color, isActive ? 0.7 : 0.35)
      ctx.lineWidth = (isActive ? 1.5 : 0.8) / t.scale
      for (const [a, b, c] of zm.triangles) {
        const pa = zm.points[a], pb = zm.points[b], pc = zm.points[c]
        if (!pa || !pb || !pc) continue
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
        ctx.closePath(); ctx.fill(); ctx.stroke()
      }
    }

    // Draw vertices for active limb zone
    if (activeZoneId && activeZoneId !== '__body__' && zoneMeshes[activeZoneId]) {
      const zm = zoneMeshes[activeZoneId]
      const zone = separation.zones.find(z => z.id === activeZoneId)
      const color = zone?.color ?? '#888'
      const pr = POINT_RADIUS / t.scale
      for (let i = 0; i < zm.points.length; i++) {
        const p = zm.points[i]
        if (i >= zm.contourCount) {
          ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        } else {
          ctx.fillStyle = hexToRgba(color, 0.5)
          ctx.beginPath(); ctx.arc(p.x, p.y, pr * 0.5, 0, Math.PI * 2); ctx.fill()
        }
      }
    }

    // Draw body vertices when active
    if (activeZoneId === '__body__' && bodyMesh) {
      const pr = POINT_RADIUS / t.scale

      // All body points — small dots (auto=gray, extra=cyan)
      for (let i = 0; i < bodyMesh.bodyPoints.length; i++) {
        const p = bodyMesh.bodyPoints[i]
        if (!p) continue
        const isExtra = i >= bodyMesh.autoCount

        if (isExtra) {
          ctx.fillStyle = '#06b6d4'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        } else {
          ctx.fillStyle = 'rgba(136,136,136,0.5)'
          ctx.beginPath(); ctx.arc(p.x, p.y, pr * 0.6, 0, Math.PI * 2); ctx.fill()
        }
      }

      // Highlight connect anchor + last
      if (bodyEditMode === 'connect' && connectAnchor !== null) {
        const pa = bodyMesh.bodyPoints[connectAnchor]
        if (pa) {
          ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.5 / t.scale
          ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 1.8, 0, Math.PI * 2); ctx.stroke()
        }
        if (connectLast !== null) {
          const pl = bodyMesh.bodyPoints[connectLast]
          if (pl) {
            ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2 / t.scale
            ctx.beginPath(); ctx.arc(pl.x, pl.y, pr * 1.5, 0, Math.PI * 2); ctx.stroke()
          }
        }
      }
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [separation, zoneMeshes, bodyMesh, activeZoneId, bodyEditMode, connectAnchor, connectLast, transformRef, imageLoaded])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // ─── Helpers ────────────────────────────────────────────────────────

  /** Find nearest body point index within hit radius, or -1. */
  function hitTestBodyPoint(imgPt: Point2D, hitR: number): number {
    if (!bodyMesh) return -1
    let best = -1, bestDist = hitR
    for (let i = 0; i < bodyMesh.bodyPoints.length; i++) {
      const p = bodyMesh.bodyPoints[i]
      if (!p) continue
      const d = Math.hypot(p.x - imgPt.x, p.y - imgPt.y)
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  }

  /** Find nearest manual triangle edge within hit radius.
   *  Returns { triIdx, edgeA, edgeB, projPt } or null. */
  function hitTestManualEdge(imgPt: Point2D, hitR: number): {
    triIdx: number; edgeA: number; edgeB: number; projPt: Point2D
  } | null {
    if (!bodyMesh) return null
    const autoTriCount = bodyMesh.autoTriCount
    let bestDist = hitR, bestResult: ReturnType<typeof hitTestManualEdge> = null
    for (let ti = autoTriCount; ti < bodyMesh.bodyTriangles.length; ti++) {
      const [a, b, c] = bodyMesh.bodyTriangles[ti]
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const pu = bodyMesh.bodyPoints[u], pv = bodyMesh.bodyPoints[v]
        if (!pu || !pv) continue
        const proj = projectOnSegment(imgPt, pu, pv)
        const d = Math.hypot(imgPt.x - proj.x, imgPt.y - proj.y)
        if (d < bestDist) {
          bestDist = d
          bestResult = { triIdx: ti, edgeA: u, edgeB: v, projPt: proj }
        }
      }
    }
    return bestResult
  }

  /** Split a manual edge: insert a new point, replace triangles sharing that edge. */
  function splitManualEdge(edgeA: number, edgeB: number, splitPt: Point2D) {
    const autoCount = (separation?.bodyPoints ?? []).length
    const newIdx = autoCount + bodyExtraPts.length
    setBodyExtraPts(prev => [...prev, splitPt])

    setBodyManualTris(prev => {
      const updated: [number, number, number][] = []
      for (const tri of prev) {
        const [a, b, c] = tri
        // Check if this triangle contains the edge (in either direction)
        const eA = edgeA, eB = edgeB
        if ((a === eA && b === eB) || (b === eA && a === eB)) {
          // Edge is a-b → split into [a, newIdx, c] + [newIdx, b, c]
          updated.push([a, newIdx, c], [newIdx, b, c])
        } else if ((b === eA && c === eB) || (c === eA && b === eB)) {
          // Edge is b-c → split into [a, b, newIdx] + [a, newIdx, c]
          updated.push([a, b, newIdx], [a, newIdx, c])
        } else if ((c === eA && a === eB) || (a === eA && c === eB)) {
          // Edge is c-a → split into [a, b, newIdx] + [b, c, newIdx]
          updated.push([a, b, newIdx], [b, c, newIdx])
        } else {
          updated.push(tri)
        }
      }
      return updated
    })
  }

  // ─── Mouse handlers ─────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button === 2) { handleContextMenu(e); return }
    if (e.button !== 0 || spaceDown.current || isPanning.current) return
    if (!zoneMeshes || !separation) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    // ── Active body ──
    if (activeZoneId === '__body__' && bodyMesh) {
      // Move mode: drag extra points only
      if (bodyEditMode === 'move') {
        for (let i = bodyExtraPts.length - 1; i >= 0; i--) {
          if (Math.hypot(bodyExtraPts[i].x - imgPt.x, bodyExtraPts[i].y - imgPt.y) < hitR) {
            setDragTarget({ zoneId: '__body__', idx: i })
            return
          }
        }
        return
      }

      // Connect mode: click on existing points to create triangles
      if (bodyEditMode === 'connect') {
        const hitIdx = hitTestBodyPoint(imgPt, hitR)
        if (hitIdx < 0) return
        if (connectAnchor === null) {
          setConnectAnchor(hitIdx); setConnectLast(null)
        } else if (connectLast === null) {
          setConnectLast(hitIdx)
        } else {
          setBodyManualTris(prev => [...prev, [connectAnchor!, connectLast!, hitIdx]])
          setConnectLast(hitIdx)
        }
        return
      }

      // Add mode: edge split or new point
      if (bodyEditMode === 'add') {
        const edgeHit = hitTestManualEdge(imgPt, hitR)
        if (edgeHit) {
          splitManualEdge(edgeHit.edgeA, edgeHit.edgeB, edgeHit.projPt)
          return
        }
        const newIdx = bodyMesh.bodyPoints.length
        const [n1, n2] = findTwoNearest(imgPt, bodyMesh.bodyPoints)
        setBodyExtraPts(prev => [...prev, imgPt])
        setBodyManualTris(prev => [...prev, [newIdx, n1, n2]])
        return
      }
    }

    // ── Active limb zone ──
    if (activeZoneId && activeZoneId !== '__body__' && zoneMeshes[activeZoneId]) {
      const zm = zoneMeshes[activeZoneId]
      const internals = zoneInternals[activeZoneId] || []
      for (let i = internals.length - 1; i >= 0; i--) {
        const p = zm.points[zm.contourCount + i]
        if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
          setDragTarget({ zoneId: activeZoneId, idx: i })
          return
        }
      }
      setZoneInternals(prev => ({
        ...prev,
        [activeZoneId]: [...(prev[activeZoneId] || []), imgPt],
      }))
      return
    }

    // ── No active zone → select ──
    for (const zone of separation.zones) {
      const zm = zoneMeshes[zone.id]
      if (!zm) continue
      for (const [a, b, c] of zm.triangles) {
        if (pointInTriangle(imgPt, zm.points[a], zm.points[b], zm.points[c])) {
          setActiveZoneId(zone.id); return
        }
      }
    }
    setActiveZoneId('__body__')
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragTarget) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    if (dragTarget.zoneId === '__body__') {
      setBodyExtraPts(prev => { const a = [...prev]; a[dragTarget.idx] = imgPt; return a })
    } else {
      setZoneInternals(prev => {
        const arr = [...(prev[dragTarget.zoneId] || [])]
        arr[dragTarget.idx] = imgPt
        return { ...prev, [dragTarget.zoneId]: arr }
      })
    }
  }

  function handleMouseUp() { setDragTarget(null) }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (!activeZoneId) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    if (activeZoneId === '__body__') {
      // Delete extra point + all its manual triangles
      for (let i = bodyExtraPts.length - 1; i >= 0; i--) {
        if (Math.hypot(bodyExtraPts[i].x - imgPt.x, bodyExtraPts[i].y - imgPt.y) < hitR) {
          const autoCount = (separation?.bodyPoints ?? []).length
          const globalIdx = autoCount + i
          setBodyExtraPts(prev => { const a = [...prev]; a.splice(i, 1); return a })
          // Remove triangles referencing this point + fix indices
          setBodyManualTris(prev => prev
            .filter(([a, b, c]) => a !== globalIdx && b !== globalIdx && c !== globalIdx)
            .map(([a, b, c]) => [
              a > globalIdx ? a - 1 : a,
              b > globalIdx ? b - 1 : b,
              c > globalIdx ? c - 1 : c,
            ] as [number, number, number])
          )
          return
        }
      }
      return
    }

    const internals = zoneInternals[activeZoneId] || []
    for (let i = internals.length - 1; i >= 0; i--) {
      if (Math.hypot(internals[i].x - imgPt.x, internals[i].y - imgPt.y) < hitR) {
        setZoneInternals(prev => {
          const arr = [...(prev[activeZoneId] || [])]
          arr.splice(i, 1)
          return { ...prev, [activeZoneId]: arr }
        })
        return
      }
    }
  }

  // ─── Save ───────────────────────────────────────────────────────────

  async function handleSave() {
    if (!mesh || !separation || !zoneMeshes) return
    setSaving(true)
    try {
      const newZonePoints: Record<string, Point2D[]> = {}
      const newZoneTriangles: Record<string, [number, number, number][]> = {}
      for (const zone of separation.zones) {
        const zm = zoneMeshes[zone.id]
        if (zm) {
          newZonePoints[zone.id] = zm.points
          newZoneTriangles[zone.id] = zm.triangles
        } else {
          newZonePoints[zone.id] = separation.zonePoints[zone.id]
          newZoneTriangles[zone.id] = separation.zoneTriangles[zone.id]
        }
      }

      const updatedSeparation: WalkLimbSeparation = {
        ...separation,
        zonePoints: newZonePoints,
        zoneTriangles: newZoneTriangles,
        bodyExtraPoints: bodyExtraPts,
        bodyManualTriangles: bodyManualTris,
        bodyPoints: bodyMesh?.bodyPoints ?? separation.bodyPoints,
        bodyTriangles: bodyMesh?.bodyTriangles ?? separation.bodyTriangles,
      }

      const updatedMesh = {
        ...mesh,
        walkLimbSeparation: updatedSeparation,
        videoFramesMesh: null,
        walkZoneFrames: null,
        walkBodyFrames: null,
      }

      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave({ ...project, animations: updatedAnims })
    } catch (err) {
      console.error('[WalkZoneMesh] save failed:', err)
    }
    setSaving(false)
  }

  // ─── Render ─────────────────────────────────────────────────────────

  if (!separation) {
    return (
      <div style={{ padding: 20, color: '#f59e0b' }}>
        Validez d'abord les zones de membres (etape precedente).
      </div>
    )
  }

  const totalInternals = Object.values(zoneInternals).reduce((s, arr) => s + arr.length, 0)
  const bodyTriCount = bodyMesh?.bodyTriangles.length ?? 0
  const bodyExtraCount = bodyExtraPts.length

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 500, display: 'block', borderRadius: 8 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
        />
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13 }}>
          {activeZoneId === '__body__'
            ? bodyEditMode === 'add'
              ? 'Clic = ajouter point (relie aux 2 plus proches) ou splitter une arete. Clic droit = supprimer.'
              : bodyEditMode === 'move'
                ? 'Drag = deplacer un sommet manuel. Clic droit = supprimer.'
                : connectAnchor === null
                  ? 'Cliquez sur un point ancre (A).'
                  : connectLast === null
                    ? `Ancre A selectionne. Cliquez un 2e point (B).`
                    : `Cliquez un point → cree triangle [A, dernier, nouveau].`
            : 'Selectionnez une zone, puis clic = ajouter un point. Drag = deplacer. Clic droit = supprimer.'}
        </div>
      </div>

      <div style={{ width: 260, flexShrink: 0, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Maillage zones</h3>

        {separation.zones.map(zone => {
          const isActive = zone.id === activeZoneId
          const zm = zoneMeshes?.[zone.id]
          const triCount = zm?.triangles.length ?? 0
          const intCount = (zoneInternals[zone.id] || []).length
          return (
            <div
              key={zone.id}
              onClick={() => setActiveZoneId(isActive ? null : zone.id)}
              style={{
                padding: '8px 10px', marginBottom: 6, borderRadius: 6,
                border: isActive ? `2px solid ${zone.color}` : '1px solid #374151',
                background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                cursor: 'pointer', fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: zone.color, flexShrink: 0 }} />
                <span style={{ color: '#e5e7eb', fontWeight: 500 }}>{zone.label}</span>
              </div>
              <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                {triCount} triangles{intCount > 0 ? ` · ${intCount} pts ajoutes` : ''}
              </div>
            </div>
          )
        })}

        {/* Body */}
        <div
          onClick={() => setActiveZoneId(activeZoneId === '__body__' ? null : '__body__')}
          style={{
            padding: '8px 10px', marginBottom: 6, borderRadius: 6,
            border: activeZoneId === '__body__' ? '2px solid #888' : '1px solid #374151',
            background: activeZoneId === '__body__' ? 'rgba(255,255,255,0.05)' : 'transparent',
            cursor: 'pointer', fontSize: 13,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#888', flexShrink: 0 }} />
            <span style={{ color: '#e5e7eb', fontWeight: 500 }}>Corps</span>
          </div>
          <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
            {bodyTriCount} triangles{bodyExtraCount > 0 ? ` · ${bodyExtraCount} pts manuels` : ''}
          </div>
        </div>

        {/* Body edit mode toggle */}
        {activeZoneId === '__body__' && (
          <div style={{ marginBottom: 8 }}>
            <div style={{
              display: 'flex', gap: 4, marginBottom: 6,
              padding: '4px', borderRadius: 6, background: 'rgba(255,255,255,0.04)',
            }}>
              {(['add', 'connect', 'move'] as const).map(mode => (
                <button
                  key={mode}
                  className={`btn-sm ${bodyEditMode === mode ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setBodyEditMode(mode)
                    setConnectAnchor(null); setConnectLast(null)
                  }}
                  style={{ flex: 1, fontSize: 11 }}
                >
                  {{ add: 'Ajouter', connect: 'Relier', move: 'Deplacer' }[mode]}
                </button>
              ))}
            </div>

            {bodyEditMode === 'connect' && connectAnchor !== null && (
              <button
                className="btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setConnectAnchor(null); setConnectLast(null)
                }}
                style={{ width: '100%', fontSize: 11, marginBottom: 4 }}
              >
                Reset ancre
              </button>
            )}

            {bodyManualTris.length > 0 && (
              <button
                className="btn-sm btn-ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  setBodyManualTris(prev => prev.slice(0, -1))
                }}
                style={{ width: '100%', fontSize: 11, color: '#f87171' }}
              >
                Annuler dernier triangle
              </button>
            )}
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '12px 0' }} />

        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          {totalInternals === 0 && bodyExtraCount === 0
            ? 'Cliquez sur une zone ou le corps pour ajouter des points.'
            : `${totalInternals + bodyExtraCount} point(s) ajoute(s). ${bodyManualTris.length} triangle(s) manuel(s).`}
        </div>

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider le maillage'}
        </button>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────

function sampleContourVertices(polygon: Point2D[], spacing: number): Point2D[] {
  if (polygon.length < 3) return [...polygon]
  let totalLen = 0
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length
    totalLen += Math.hypot(polygon[j].x - polygon[i].x, polygon[j].y - polygon[i].y)
  }
  const numPts = Math.max(8, Math.round(totalLen / spacing))
  const step = totalLen / numPts
  const result: Point2D[] = []
  let segIdx = 0, segStart = 0
  for (let i = 0; i < numPts; i++) {
    const targetDist = i * step
    while (segIdx < polygon.length) {
      const j = (segIdx + 1) % polygon.length
      const segLen = Math.hypot(polygon[j].x - polygon[segIdx].x, polygon[j].y - polygon[segIdx].y)
      if (segStart + segLen >= targetDist || segIdx === polygon.length - 1) {
        const t = segLen > 0 ? (targetDist - segStart) / segLen : 0
        result.push({
          x: polygon[segIdx].x + t * (polygon[j].x - polygon[segIdx].x),
          y: polygon[segIdx].y + t * (polygon[j].y - polygon[segIdx].y),
        })
        break
      }
      segStart += segLen
      segIdx++
    }
  }
  return result
}

function pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y)
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y)
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y)
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0)
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0)
  return !(hasNeg && hasPos)
}

function projectOnSegment(p: Point2D, a: Point2D, b: Point2D): Point2D {
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { x: a.x, y: a.y }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
