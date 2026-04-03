/**
 * WalkHiddenFaceStep — Define hidden face zones behind limbs.
 *
 * For each limb, the admin:
 * 1. Selects 2 vertices on the body mesh boundary (A and B)
 * 2. Places bridge points between A and B to form the inner contour
 * 3. Clicks "Générer" → Delaunay fills the closed polygon (bridge + body boundary)
 * 4. New triangles are merged into bodyPoints/bodyTriangles
 *
 * The hidden face triangles share vertices with the body mesh,
 * so they animate identically via bodyFrames.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { Project, Animation, Point2D, HiddenFaceZone, WalkLimbSeparation } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import {
  findBoundaryEdges, walkBoundaryPath, triangulateHiddenFace,
} from '../../utils/limbSeparation'

const POINT_RADIUS = 4
const HIT_RADIUS = 10

type EditPhase = 'select-a' | 'select-b' | 'bridge' | 'done'

interface HiddenFaceState {
  vertexA: number | null
  vertexB: number | null
  bridgePoints: Point2D[]
  bodyTriangleIndices: number[]  // after triangulation
  generated: boolean
}

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function WalkHiddenFaceStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const separation = mesh?.walkLimbSeparation

  const bodyPoints = separation?.bodyPoints ?? []
  const bodyTriangles = separation?.bodyTriangles ?? []

  // Per-limb hidden face state
  const [hiddenFaces, setHiddenFaces] = useState<Record<string, HiddenFaceState>>(() => {
    const init: Record<string, HiddenFaceState> = {}
    if (separation?.hiddenFaceZones) {
      for (const hfz of separation.hiddenFaceZones) {
        init[hfz.limbZoneId] = {
          vertexA: hfz.bodyVertexA,
          vertexB: hfz.bodyVertexB,
          bridgePoints: [...hfz.bridgePoints],
          bodyTriangleIndices: [...hfz.bodyTriangleIndices],
          generated: hfz.bodyTriangleIndices.length > 0,
        }
      }
    }
    return init
  })

  // Working copy of body mesh (grows as hidden faces are generated)
  const [workBodyPoints, setWorkBodyPoints] = useState<Point2D[]>(() => [...bodyPoints])
  const [workBodyTriangles, setWorkBodyTriangles] = useState<[number, number, number][]>(() => [...bodyTriangles])

  const [activeLimbId, setActiveLimbId] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  const activeHF = activeLimbId ? hiddenFaces[activeLimbId] : null

  const editPhase: EditPhase = !activeHF ? 'select-a'
    : activeHF.vertexA === null ? 'select-a'
    : activeHF.vertexB === null ? 'select-b'
    : activeHF.generated ? 'done'
    : 'bridge'

  // Boundary edges of body mesh (for vertex selection + path walking)
  const boundaryEdges = useMemo(() => findBoundaryEdges(workBodyTriangles), [workBodyTriangles])
  const boundaryVertexSet = useMemo(() => {
    const set = new Set<number>()
    for (const [a, b] of boundaryEdges) { set.add(a); set.add(b) }
    return set
  }, [boundaryEdges])

  // Boundary path preview (B → A along body boundary)
  const boundaryPath = useMemo(() => {
    if (!activeHF || activeHF.vertexA === null || activeHF.vertexB === null) return null
    return walkBoundaryPath(boundaryEdges, activeHF.vertexB, activeHF.vertexA)
  }, [activeHF, boundaryEdges])

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

    if (!separation) { ctx.restore(); animFrameRef.current = requestAnimationFrame(draw); return }

    const pr = POINT_RADIUS / t.scale

    // Draw body triangles (faded)
    ctx.fillStyle = 'rgba(136,136,136,0.08)'
    ctx.strokeStyle = 'rgba(136,136,136,0.2)'
    ctx.lineWidth = 0.5 / t.scale
    for (const [a, b, c] of workBodyTriangles) {
      const pa = workBodyPoints[a], pb = workBodyPoints[b], pc = workBodyPoints[c]
      if (!pa || !pb || !pc) continue
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }

    // Draw hidden face triangles for all limbs (colored)
    for (const zone of separation.zones) {
      const hf = hiddenFaces[zone.id]
      if (!hf || hf.bodyTriangleIndices.length === 0) continue
      const isActive = zone.id === activeLimbId
      ctx.fillStyle = hexToRgba(zone.color, isActive ? 0.25 : 0.12)
      ctx.strokeStyle = hexToRgba(zone.color, isActive ? 0.7 : 0.35)
      ctx.lineWidth = (isActive ? 1.5 : 0.8) / t.scale
      for (const ti of hf.bodyTriangleIndices) {
        const tri = workBodyTriangles[ti]
        if (!tri) continue
        const [a, b, c] = tri
        const pa = workBodyPoints[a], pb = workBodyPoints[b], pc = workBodyPoints[c]
        if (!pa || !pb || !pc) continue
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
        ctx.closePath(); ctx.fill(); ctx.stroke()
      }
    }

    // Draw active hidden face editing state
    if (activeLimbId && activeHF) {
      const zone = separation.zones.find(z => z.id === activeLimbId)
      const color = zone?.color ?? '#f59e0b'

      // Draw boundary vertices as selectable (during select-a / select-b phases)
      if (editPhase === 'select-a' || editPhase === 'select-b') {
        for (const idx of boundaryVertexSet) {
          const p = workBodyPoints[idx]
          if (!p) continue
          const isA = idx === activeHF.vertexA
          ctx.fillStyle = isA ? '#f59e0b' : 'rgba(255,255,255,0.4)'
          ctx.strokeStyle = isA ? '#fff' : 'rgba(255,255,255,0.2)'
          ctx.lineWidth = 1 / t.scale
          ctx.beginPath(); ctx.arc(p.x, p.y, pr * (isA ? 1.5 : 0.7), 0, Math.PI * 2)
          ctx.fill(); ctx.stroke()
        }
      }

      // Draw vertex A marker
      if (activeHF.vertexA !== null) {
        const pa = workBodyPoints[activeHF.vertexA]
        if (pa) {
          ctx.fillStyle = '#f59e0b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('A', pa.x + pr * 2.5, pa.y - pr)
        }
      }

      // Draw vertex B marker
      if (activeHF.vertexB !== null) {
        const pb = workBodyPoints[activeHF.vertexB]
        if (pb) {
          ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pb.x, pb.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('B', pb.x + pr * 2.5, pb.y - pr)
        }
      }

      // Draw bridge points
      if (activeHF.bridgePoints.length > 0) {
        ctx.strokeStyle = hexToRgba(color, 0.8)
        ctx.lineWidth = 1.5 / t.scale
        ctx.beginPath()
        if (activeHF.vertexA !== null) {
          const pa = workBodyPoints[activeHF.vertexA]
          if (pa) ctx.moveTo(pa.x, pa.y)
        }
        for (const bp of activeHF.bridgePoints) ctx.lineTo(bp.x, bp.y)
        if (activeHF.vertexB !== null) {
          const pb = workBodyPoints[activeHF.vertexB]
          if (pb) ctx.lineTo(pb.x, pb.y)
        }
        ctx.stroke()

        for (let i = 0; i < activeHF.bridgePoints.length; i++) {
          const bp = activeHF.bridgePoints[i]
          ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath(); ctx.arc(bp.x, bp.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        }
      }

      // Draw boundary path preview (B → A along body boundary)
      if (boundaryPath && boundaryPath.length > 1 && editPhase === 'bridge') {
        ctx.strokeStyle = 'rgba(136,182,212,0.5)'
        ctx.lineWidth = 2 / t.scale
        ctx.setLineDash([4 / t.scale, 4 / t.scale])
        ctx.beginPath()
        const p0 = workBodyPoints[boundaryPath[0]]
        if (p0) ctx.moveTo(p0.x, p0.y)
        for (let i = 1; i < boundaryPath.length; i++) {
          const p = workBodyPoints[boundaryPath[i]]
          if (p) ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [separation, workBodyPoints, workBodyTriangles, hiddenFaces, activeLimbId, editPhase, boundaryPath, boundaryVertexSet, transformRef, imageLoaded])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // ─── Helpers ────────────────────────────────────────────────────────

  function hitTestBoundaryVertex(imgPt: Point2D, hitR: number): number {
    let best = -1, bestDist = hitR
    for (const idx of boundaryVertexSet) {
      const p = workBodyPoints[idx]
      if (!p) continue
      const d = Math.hypot(p.x - imgPt.x, p.y - imgPt.y)
      if (d < bestDist) { bestDist = d; best = idx }
    }
    return best
  }

  function hitTestBridgePoint(imgPt: Point2D, hitR: number): number {
    if (!activeHF) return -1
    let best = -1, bestDist = hitR
    for (let i = 0; i < activeHF.bridgePoints.length; i++) {
      const d = Math.hypot(activeHF.bridgePoints[i].x - imgPt.x, activeHF.bridgePoints[i].y - imgPt.y)
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  }

  // ─── Toggle hidden face ────────────────────────────────────────────

  function toggleHiddenFace(limbId: string) {
    if (hiddenFaces[limbId]) {
      // Remove — also need to remove generated triangles from body
      const hf = hiddenFaces[limbId]
      if (hf.generated && hf.bodyTriangleIndices.length > 0) {
        // Remove triangles and points added by this hidden face
        // For simplicity, just reset body to original separation state
        setWorkBodyPoints([...(separation?.bodyPoints ?? [])])
        setWorkBodyTriangles([...(separation?.bodyTriangles ?? [])])
        // Also reset all other hidden faces that were generated
        setHiddenFaces(prev => {
          const copy = { ...prev }
          delete copy[limbId]
          // Reset all others' generated state since body was reset
          for (const key of Object.keys(copy)) {
            copy[key] = { ...copy[key], generated: false, bodyTriangleIndices: [] }
          }
          return copy
        })
      } else {
        setHiddenFaces(prev => {
          const copy = { ...prev }
          delete copy[limbId]
          return copy
        })
      }
      if (activeLimbId === limbId) setActiveLimbId(null)
    } else {
      setHiddenFaces(prev => ({
        ...prev,
        [limbId]: { vertexA: null, vertexB: null, bridgePoints: [], bodyTriangleIndices: [], generated: false },
      }))
      setActiveLimbId(limbId)
    }
  }

  // ─── Generate triangulation ────────────────────────────────────────

  function handleGenerate() {
    if (!activeLimbId || !activeHF) return
    if (activeHF.vertexA === null || activeHF.vertexB === null) return

    const result = triangulateHiddenFace(
      workBodyPoints, workBodyTriangles,
      activeHF.vertexA, activeHF.vertexB,
      activeHF.bridgePoints,
    )

    setWorkBodyPoints(result.updatedBodyPoints)
    setWorkBodyTriangles(result.updatedBodyTriangles)
    setHiddenFaces(prev => ({
      ...prev,
      [activeLimbId]: {
        ...prev[activeLimbId],
        bodyTriangleIndices: result.hiddenFaceTriangleIndices,
        generated: true,
      },
    }))
  }

  // ─── Mouse handlers ─────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button === 2) { handleContextMenu(e); return }
    if (e.button !== 0 || spaceDown.current || isPanning.current) return
    if (!activeLimbId || !activeHF) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    if (editPhase === 'select-a') {
      const idx = hitTestBoundaryVertex(imgPt, hitR)
      if (idx >= 0) {
        setHiddenFaces(prev => ({
          ...prev,
          [activeLimbId]: { ...prev[activeLimbId], vertexA: idx },
        }))
      }
      return
    }

    if (editPhase === 'select-b') {
      const idx = hitTestBoundaryVertex(imgPt, hitR)
      if (idx >= 0 && idx !== activeHF.vertexA) {
        setHiddenFaces(prev => ({
          ...prev,
          [activeLimbId]: { ...prev[activeLimbId], vertexB: idx },
        }))
      }
      return
    }

    if (editPhase === 'bridge') {
      // Try to drag existing bridge point
      const bpIdx = hitTestBridgePoint(imgPt, hitR)
      if (bpIdx >= 0) {
        setDragIdx(bpIdx)
        return
      }
      // Add new bridge point
      setHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: {
          ...prev[activeLimbId],
          bridgePoints: [...prev[activeLimbId].bridgePoints, imgPt],
        },
      }))
      return
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (dragIdx === null || !activeLimbId) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    setHiddenFaces(prev => {
      const hf = prev[activeLimbId]
      if (!hf) return prev
      const pts = [...hf.bridgePoints]
      pts[dragIdx] = imgPt
      return { ...prev, [activeLimbId]: { ...hf, bridgePoints: pts } }
    })
  }

  function handleMouseUp() { setDragIdx(null) }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (!activeLimbId || !activeHF || editPhase !== 'bridge') return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    const bpIdx = hitTestBridgePoint(imgPt, hitR)
    if (bpIdx >= 0) {
      setHiddenFaces(prev => {
        const hf = prev[activeLimbId]
        if (!hf) return prev
        const pts = [...hf.bridgePoints]
        pts.splice(bpIdx, 1)
        return { ...prev, [activeLimbId]: { ...hf, bridgePoints: pts } }
      })
    }
  }

  // ─── Reset ─────────────────────────────────────────────────────────

  function handleReset() {
    if (!activeLimbId) return
    setHiddenFaces(prev => ({
      ...prev,
      [activeLimbId]: { vertexA: null, vertexB: null, bridgePoints: [], bodyTriangleIndices: [], generated: false },
    }))
    // Reset body to original + regenerate other faces
    setWorkBodyPoints([...(separation?.bodyPoints ?? [])])
    setWorkBodyTriangles([...(separation?.bodyTriangles ?? [])])
    // Reset all generated faces
    setHiddenFaces(prev => {
      const copy = { ...prev }
      for (const key of Object.keys(copy)) {
        if (key !== activeLimbId) {
          copy[key] = { ...copy[key], generated: false, bodyTriangleIndices: [] }
        }
      }
      return copy
    })
  }

  // ─── Save ───────────────────────────────────────────────────────────

  async function handleSave() {
    if (!mesh || !separation) return
    setSaving(true)
    try {
      const hiddenFaceZones: HiddenFaceZone[] = []
      for (const [limbZoneId, hf] of Object.entries(hiddenFaces)) {
        if (hf.vertexA !== null && hf.vertexB !== null && hf.bodyTriangleIndices.length > 0) {
          hiddenFaceZones.push({
            limbZoneId,
            bodyVertexA: hf.vertexA,
            bodyVertexB: hf.vertexB,
            bridgePoints: hf.bridgePoints,
            bodyTriangleIndices: hf.bodyTriangleIndices,
          })
        }
      }

      const updatedSeparation: WalkLimbSeparation = {
        ...separation,
        bodyPoints: workBodyPoints,
        bodyTriangles: workBodyTriangles,
        hiddenFaceZones: hiddenFaceZones.length > 0 ? hiddenFaceZones : undefined,
      }

      const updatedMesh = {
        ...mesh,
        walkLimbSeparation: updatedSeparation,
        walkHiddenFaceValidated: true,
        videoFramesMesh: null,
        walkZoneFrames: null,
        walkBodyFrames: null,
      }

      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave({ ...project, animations: updatedAnims })
    } catch (err) {
      console.error('[WalkHiddenFace] save failed:', err)
    }
    setSaving(false)
  }

  // ─── Render ─────────────────────────────────────────────────────────

  if (!separation) {
    return (
      <div style={{ padding: 20, color: '#f59e0b' }}>
        Validez d'abord les zones de membres et le maillage (etapes precedentes).
      </div>
    )
  }

  const enabledCount = Object.keys(hiddenFaces).length
  const generatedCount = Object.values(hiddenFaces).filter(hf => hf.generated).length

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
          {!activeLimbId
            ? 'Activez une face cachee pour une patte.'
            : editPhase === 'select-a'
              ? 'Cliquez sur un sommet du contour body (point A).'
              : editPhase === 'select-b'
                ? 'Cliquez sur un 2e sommet du contour body (point B).'
                : editPhase === 'bridge'
                  ? 'Placez des points entre A et B. Drag = deplacer. Clic droit = supprimer. Puis "Generer".'
                  : 'Triangulation generee. Vous pouvez valider ou reinitialiser.'}
        </div>
      </div>

      <div style={{ width: 260, flexShrink: 0, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Face cachee</h3>
        <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 12 }}>
          Definissez un maillage derriere chaque patte pour combler les trous.
        </div>

        {separation.zones.map(zone => {
          const isEnabled = !!hiddenFaces[zone.id]
          const isActive = zone.id === activeLimbId
          const hf = hiddenFaces[zone.id]
          return (
            <div key={zone.id} style={{ marginBottom: 6 }}>
              <div
                onClick={() => {
                  if (isEnabled) setActiveLimbId(isActive ? null : zone.id)
                }}
                style={{
                  padding: '8px 10px', borderRadius: 6,
                  border: isActive ? `2px solid ${zone.color}` : '1px solid #374151',
                  background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                  cursor: isEnabled ? 'pointer' : 'default', fontSize: 13,
                  opacity: isEnabled ? 1 : 0.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: zone.color, flexShrink: 0 }} />
                  <span style={{ color: '#e5e7eb', fontWeight: 500, flex: 1 }}>{zone.label}</span>
                  <button
                    className={`btn-sm ${isEnabled ? 'btn-ghost' : 'btn-secondary'}`}
                    onClick={(e) => { e.stopPropagation(); toggleHiddenFace(zone.id) }}
                    style={{ fontSize: 10, padding: '2px 6px' }}
                  >
                    {isEnabled ? '✕' : '+ Activer'}
                  </button>
                </div>
                {isEnabled && hf && (
                  <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                    {hf.generated
                      ? `${hf.bodyTriangleIndices.length} triangles generes`
                      : hf.vertexA !== null && hf.vertexB !== null
                        ? `A=${hf.vertexA} B=${hf.vertexB} · ${hf.bridgePoints.length} pts bridge`
                        : hf.vertexA !== null
                          ? 'Point A selectionne, cliquez B...'
                          : 'Selectionnez le point A...'}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* Action buttons for active face */}
        {activeLimbId && activeHF && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {editPhase === 'bridge' && activeHF.bridgePoints.length >= 0 && (
              <button
                className="btn-sm btn-secondary"
                onClick={handleGenerate}
                style={{ width: '100%', fontSize: 12 }}
              >
                Generer la triangulation
              </button>
            )}
            {(editPhase !== 'select-a' || activeHF.generated) && (
              <button
                className="btn-sm btn-ghost"
                onClick={handleReset}
                style={{ width: '100%', fontSize: 11, color: '#f87171' }}
              >
                Reinitialiser
              </button>
            )}
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '12px 0' }} />

        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
          {enabledCount === 0
            ? 'Aucune face cachee. Activez une patte.'
            : `${enabledCount} zone(s) · ${generatedCount} generee(s)`}
        </div>

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider les faces cachees'}
        </button>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
