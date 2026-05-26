/**
 * ProjectTriangHiddenFaceStep — Step 3 of project-level triangulation pipeline.
 *
 * Define hidden face zones for body behind limbs and limb extension behind body.
 * Same concept as WalkHiddenFaceStep but operates on ProjectTriangulation data
 * (SAM2 zones) instead of WalkLimbSeparation.
 *
 * Two modes:
 * - "body" (Face cachee body): body area hidden behind a limb → inpainted body texture
 * - "limb" (Face cachee jambe): limb extension hidden behind body → extruded limb texture
 *
 * Body mode: selects 2 body boundary vertices (A,B), bridge points, Delaunay → bodyTriangles
 * Limb mode: selects 2 zone boundary vertices (A,B), bridge points, Delaunay → zoneTriangles
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { Project, Point2D, HiddenFaceZone, HiddenFaceLimbZone } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import {
  findBoundaryEdges, walkBoundaryPath, triangulateHiddenFace, triangulateHiddenFaceLimb,
} from '../../utils/limbSeparation'

const POINT_RADIUS = 4
const HIT_RADIUS = 10

type HiddenFaceMode = 'body' | 'limb'
type EditPhase = 'select-a' | 'select-b' | 'bridge' | 'done'

interface HiddenFaceState {
  vertexA: number | null
  vertexB: number | null
  bridgePoints: Point2D[]
  bodyTriangleIndices: number[]
  generated: boolean
}

interface HiddenFaceLimbState {
  zoneVertexA: number | null
  zoneVertexB: number | null
  bridgePoints: Point2D[]
  zoneTriangleIndices: number[]
  generated: boolean
}

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function ProjectTriangHiddenFaceStep({ project, onSave }: Props) {
  const pt = project.projectTriangulation
  if (!pt || !pt.step2Validated) {
    return (
      <div style={{ padding: 20, color: '#f59e0b' }}>
        Validez d'abord le maillage par zone (etape 2).
      </div>
    )
  }

  return <HiddenFaceEditor project={project} onSave={onSave} />
}

/** Inner component rendered only when step2 is validated. */
function HiddenFaceEditor({ project, onSave }: Props) {
  const pt = project.projectTriangulation!

  // Zones membres (toutes sauf body)
  const legZones = useMemo(() => pt.zones.filter(z => z.id !== 'body'), [pt.zones])

  // Baselines body + zones (maillages avant fusion des faces cachées). Fallback :
  // pour les projets legacy sans baseline, on retombe sur les meshes actuels (= déjà
  // pollués si step3 était validé) → reset équivaut à no-op (comportement historique).
  const bodyBaselinePoints = pt.bodyPointsBaseline ?? pt.bodyPoints
  const bodyBaselineTriangles = pt.bodyTrianglesBaseline ?? pt.bodyTriangles
  const zoneBaselinePoints = pt.zonePointsBaseline ?? pt.zonePoints
  const zoneBaselineTriangles = pt.zoneTrianglesBaseline ?? pt.zoneTriangles

  const [mode, setMode] = useState<HiddenFaceMode>('body')

  // ─── Body mode state ───────────────────────────────────────────────
  const [hiddenFaces, setHiddenFaces] = useState<Record<string, HiddenFaceState>>(() => {
    const init: Record<string, HiddenFaceState> = {}
    for (const hfz of pt.hiddenFaceZones) {
      init[hfz.limbZoneId] = {
        vertexA: hfz.bodyVertexA,
        vertexB: hfz.bodyVertexB,
        bridgePoints: [...hfz.bridgePoints],
        bodyTriangleIndices: [...hfz.bodyTriangleIndices],
        generated: hfz.bodyTriangleIndices.length > 0,
      }
    }
    return init
  })
  const [workBodyPoints, setWorkBodyPoints] = useState<Point2D[]>(() => [...pt.bodyPoints])
  const [workBodyTriangles, setWorkBodyTriangles] = useState<[number, number, number][]>(() => [...pt.bodyTriangles])

  // ─── Limb mode state ───────────────────────────────────────────────
  const [limbHiddenFaces, setLimbHiddenFaces] = useState<Record<string, HiddenFaceLimbState>>(() => {
    const init: Record<string, HiddenFaceLimbState> = {}
    for (const hfl of pt.hiddenFaceLimbZones) {
      init[hfl.limbZoneId] = {
        zoneVertexA: hfl.zoneVertexA,
        zoneVertexB: hfl.zoneVertexB,
        bridgePoints: [...hfl.bridgePoints],
        zoneTriangleIndices: [...hfl.zoneTriangleIndices],
        generated: hfl.zoneTriangleIndices.length > 0,
      }
    }
    return init
  })
  const [workZonePoints, setWorkZonePoints] = useState<Record<string, Point2D[]>>(() => {
    const init: Record<string, Point2D[]> = {}
    for (const zone of legZones) {
      init[zone.id] = [...(pt.zonePoints[zone.id] ?? [])]
    }
    return init
  })
  const [workZoneTriangles, setWorkZoneTriangles] = useState<Record<string, [number, number, number][]>>(() => {
    const init: Record<string, [number, number, number][]> = {}
    for (const zone of legZones) {
      init[zone.id] = [...(pt.zoneTriangles[zone.id] ?? [])]
    }
    return init
  })

  // ─── Common state ──────────────────────────────────────────────────
  const [activeLimbId, setActiveLimbId] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  // ─── Undo history ─────────────────────────────────────────────────
  type HFSnapshot = {
    mode: HiddenFaceMode
    activeLimbId: string | null
    hiddenFaces: Record<string, HiddenFaceState>
    workBodyPoints: Point2D[]
    workBodyTriangles: [number, number, number][]
    limbHiddenFaces: Record<string, HiddenFaceLimbState>
    workZonePoints: Record<string, Point2D[]>
    workZoneTriangles: Record<string, [number, number, number][]>
  }
  const HISTORY_LIMIT = 50
  const [history, setHistory] = useState<HFSnapshot[]>([])
  const pushHistory = useCallback(() => {
    setHistory(prev => {
      const snap: HFSnapshot = {
        mode,
        activeLimbId,
        hiddenFaces: structuredClone(hiddenFaces),
        workBodyPoints: workBodyPoints.map(p => ({ ...p })),
        workBodyTriangles: workBodyTriangles.map(t => [...t] as [number, number, number]),
        limbHiddenFaces: structuredClone(limbHiddenFaces),
        workZonePoints: structuredClone(workZonePoints),
        workZoneTriangles: structuredClone(workZoneTriangles),
      }
      const next = [...prev, snap]
      if (next.length > HISTORY_LIMIT) next.shift()
      return next
    })
  }, [mode, activeLimbId, hiddenFaces, workBodyPoints, workBodyTriangles, limbHiddenFaces, workZonePoints, workZoneTriangles])
  const undo = useCallback(() => {
    setHistory(prev => {
      if (prev.length === 0) return prev
      const s = prev[prev.length - 1]
      setMode(s.mode)
      setActiveLimbId(s.activeLimbId)
      setHiddenFaces(s.hiddenFaces)
      setWorkBodyPoints(s.workBodyPoints)
      setWorkBodyTriangles(s.workBodyTriangles)
      setLimbHiddenFaces(s.limbHiddenFaces)
      setWorkZonePoints(s.workZonePoints)
      setWorkZoneTriangles(s.workZoneTriangles)
      return prev.slice(0, -1)
    })
  }, [])
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.shiftKey) return
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return
      e.preventDefault()
      undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo])

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  // ─── Derived state ─────────────────────────────────────────────────

  const activeBodyHF = (mode === 'body' && activeLimbId) ? hiddenFaces[activeLimbId] : null
  const bodyEditPhase: EditPhase = !activeBodyHF ? 'select-a'
    : activeBodyHF.vertexA === null ? 'select-a'
    : activeBodyHF.vertexB === null ? 'select-b'
    : activeBodyHF.generated ? 'done'
    : 'bridge'

  const activeLimbHF = (mode === 'limb' && activeLimbId) ? limbHiddenFaces[activeLimbId] : null
  const limbEditPhase: EditPhase = !activeLimbHF ? 'select-a'
    : activeLimbHF.zoneVertexA === null ? 'select-a'
    : activeLimbHF.zoneVertexB === null ? 'select-b'
    : activeLimbHF.generated ? 'done'
    : 'bridge'

  const editPhase = mode === 'body' ? bodyEditPhase : limbEditPhase

  // Body boundary edges
  const bodyBoundaryEdges = useMemo(() => findBoundaryEdges(workBodyTriangles), [workBodyTriangles])
  const bodyBoundaryVertexSet = useMemo(() => {
    const set = new Set<number>()
    for (const [a, b] of bodyBoundaryEdges) { set.add(a); set.add(b) }
    return set
  }, [bodyBoundaryEdges])

  // Limb boundary edges (for active limb)
  const activeLimbTriangles: [number, number, number][] = (activeLimbId ? workZoneTriangles[activeLimbId] : null) ?? []
  const limbBoundaryEdges = useMemo(() => findBoundaryEdges(activeLimbTriangles), [activeLimbTriangles])
  const limbBoundaryVertexSet = useMemo(() => {
    const set = new Set<number>()
    for (const [a, b] of limbBoundaryEdges) { set.add(a); set.add(b) }
    return set
  }, [limbBoundaryEdges])

  // Boundary path preview
  const boundaryPath = useMemo(() => {
    if (mode === 'body') {
      if (!activeBodyHF || activeBodyHF.vertexA === null || activeBodyHF.vertexB === null) return null
      return walkBoundaryPath(bodyBoundaryEdges, activeBodyHF.vertexB, activeBodyHF.vertexA)
    } else {
      if (!activeLimbHF || activeLimbHF.zoneVertexA === null || activeLimbHF.zoneVertexB === null) return null
      return walkBoundaryPath(limbBoundaryEdges, activeLimbHF.zoneVertexB, activeLimbHF.zoneVertexA)
    }
  }, [mode, activeBodyHF, activeLimbHF, bodyBoundaryEdges, limbBoundaryEdges])

  // ─── Image loading ─────────────────────────────────────────────────
  useEffect(() => {
    const blob = project.originalImageBlob ?? project.projectTriangulation?.referenceImageBlob
    if (!blob) return
    const url = URL.createObjectURL(blob)
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
  }, [project.originalImageBlob, project.projectTriangulation?.referenceImageBlob])

  // ─── Draw ──────────────────────────────────────────────────────────

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

    const pr = POINT_RADIUS / t.scale

    if (mode === 'body') {
      drawBodyMode(ctx, t, pr)
    } else {
      drawLimbMode(ctx, t, pr)
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, workBodyPoints, workBodyTriangles, hiddenFaces, workZonePoints, workZoneTriangles,
      limbHiddenFaces, activeLimbId, editPhase, boundaryPath, bodyBoundaryVertexSet,
      limbBoundaryVertexSet, transformRef, imageLoaded])

  function drawBodyMode(ctx: CanvasRenderingContext2D, t: { scale: number }, pr: number) {
    // Body wireframe — bleu translucide pour visualiser les zones manquantes à combler
    ctx.fillStyle = 'rgba(59, 130, 246, 0.12)'
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.55)'
    ctx.lineWidth = 0.8 / t.scale
    for (const [a, b, c] of workBodyTriangles) {
      const pa = workBodyPoints[a], pb = workBodyPoints[b], pc = workBodyPoints[c]
      if (!pa || !pb || !pc) continue
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }

    // Draw hidden face triangles for all limbs (selected = bleu translucide, autres = couleur zone)
    for (const zone of legZones) {
      const hf = hiddenFaces[zone.id]
      if (!hf || hf.bodyTriangleIndices.length === 0) continue
      const isActive = zone.id === activeLimbId
      if (isActive) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.45)'   // bleu translucide
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'
        ctx.lineWidth = 1.5 / t.scale
      } else {
        ctx.fillStyle = hexToRgba(zone.color, 0.18)
        ctx.strokeStyle = hexToRgba(zone.color, 0.45)
        ctx.lineWidth = 0.8 / t.scale
      }
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

    // Draw active editing state
    if (activeLimbId && activeBodyHF) {
      const zone = legZones.find(z => z.id === activeLimbId)
      const color = zone?.color ?? '#f59e0b'

      // Boundary vertices (during select-a / select-b)
      if (bodyEditPhase === 'select-a' || bodyEditPhase === 'select-b') {
        for (const idx of bodyBoundaryVertexSet) {
          const p = workBodyPoints[idx]
          if (!p) continue
          const isA = idx === activeBodyHF.vertexA
          ctx.fillStyle = isA ? '#f59e0b' : 'rgba(255,255,255,0.4)'
          ctx.strokeStyle = isA ? '#fff' : 'rgba(255,255,255,0.2)'
          ctx.lineWidth = 1 / t.scale
          ctx.beginPath(); ctx.arc(p.x, p.y, pr * (isA ? 1.5 : 0.7), 0, Math.PI * 2)
          ctx.fill(); ctx.stroke()
        }
      }

      // Vertex A marker
      if (activeBodyHF.vertexA !== null) {
        const pa = workBodyPoints[activeBodyHF.vertexA]
        if (pa) {
          ctx.fillStyle = '#f59e0b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('A', pa.x + pr * 2.5, pa.y - pr)
        }
      }

      // Vertex B marker
      if (activeBodyHF.vertexB !== null) {
        const pb = workBodyPoints[activeBodyHF.vertexB]
        if (pb) {
          ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pb.x, pb.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('B', pb.x + pr * 2.5, pb.y - pr)
        }
      }

      // Bridge points + boundary path
      drawBridgePoints(ctx, t, pr, activeBodyHF.bridgePoints, color,
        activeBodyHF.vertexA !== null ? workBodyPoints[activeBodyHF.vertexA] : null,
        activeBodyHF.vertexB !== null ? workBodyPoints[activeBodyHF.vertexB] : null)

      if (boundaryPath && boundaryPath.length > 1 && bodyEditPhase === 'bridge') {
        drawBoundaryPathPreview(ctx, t, boundaryPath, workBodyPoints)
      }
    }
  }

  function drawLimbMode(ctx: CanvasRenderingContext2D, t: { scale: number }, pr: number) {
    if (!activeLimbId) return

    const pts = workZonePoints[activeLimbId] ?? []
    const tris = workZoneTriangles[activeLimbId] ?? []

    // Draw zone triangles (faded)
    ctx.fillStyle = 'rgba(136,136,136,0.08)'
    ctx.strokeStyle = 'rgba(136,136,136,0.2)'
    ctx.lineWidth = 0.5 / t.scale
    for (const [a, b, c] of tris) {
      const pa = pts[a], pb = pts[b], pc = pts[c]
      if (!pa || !pb || !pc) continue
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
      ctx.closePath(); ctx.fill(); ctx.stroke()
    }

    // Draw extension triangles — bleu translucide (zone active)
    const hfl = limbHiddenFaces[activeLimbId]
    if (hfl && hfl.zoneTriangleIndices.length > 0) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.45)'
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'
      ctx.lineWidth = 1.5 / t.scale
      for (const ti of hfl.zoneTriangleIndices) {
        const tri = tris[ti]
        if (!tri) continue
        const [a, b, c] = tri
        const pa = pts[a], pb = pts[b], pc = pts[c]
        if (!pa || !pb || !pc) continue
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
        ctx.closePath(); ctx.fill(); ctx.stroke()
      }
    }

    // Draw editing state
    if (activeLimbHF) {
      const zone = legZones.find(z => z.id === activeLimbId)
      const color = zone?.color ?? '#f59e0b'

      // Boundary vertices
      if (limbEditPhase === 'select-a' || limbEditPhase === 'select-b') {
        for (const idx of limbBoundaryVertexSet) {
          const p = pts[idx]
          if (!p) continue
          const isA = idx === activeLimbHF.zoneVertexA
          ctx.fillStyle = isA ? '#f59e0b' : 'rgba(255,255,255,0.4)'
          ctx.strokeStyle = isA ? '#fff' : 'rgba(255,255,255,0.2)'
          ctx.lineWidth = 1 / t.scale
          ctx.beginPath(); ctx.arc(p.x, p.y, pr * (isA ? 1.5 : 0.7), 0, Math.PI * 2)
          ctx.fill(); ctx.stroke()
        }
      }

      // Vertex A marker
      if (activeLimbHF.zoneVertexA !== null) {
        const pa = pts[activeLimbHF.zoneVertexA]
        if (pa) {
          ctx.fillStyle = '#f59e0b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('A', pa.x + pr * 2.5, pa.y - pr)
        }
      }

      // Vertex B marker
      if (activeLimbHF.zoneVertexB !== null) {
        const pb = pts[activeLimbHF.zoneVertexB]
        if (pb) {
          ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pb.x, pb.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('B', pb.x + pr * 2.5, pb.y - pr)
        }
      }

      // Bridge points + boundary path
      drawBridgePoints(ctx, t, pr, activeLimbHF.bridgePoints, color,
        activeLimbHF.zoneVertexA !== null ? pts[activeLimbHF.zoneVertexA] : null,
        activeLimbHF.zoneVertexB !== null ? pts[activeLimbHF.zoneVertexB] : null)

      if (boundaryPath && boundaryPath.length > 1 && limbEditPhase === 'bridge') {
        drawBoundaryPathPreview(ctx, t, boundaryPath, pts)
      }
    }
  }

  function drawBridgePoints(ctx: CanvasRenderingContext2D, t: { scale: number }, pr: number,
    bridgePoints: Point2D[], color: string, ptA: Point2D | null, ptB: Point2D | null) {
    if (bridgePoints.length > 0) {
      ctx.strokeStyle = hexToRgba(color, 0.8)
      ctx.lineWidth = 1.5 / t.scale
      ctx.beginPath()
      if (ptA) ctx.moveTo(ptA.x, ptA.y)
      for (const bp of bridgePoints) ctx.lineTo(bp.x, bp.y)
      if (ptB) ctx.lineTo(ptB.x, ptB.y)
      ctx.stroke()

      for (const bp of bridgePoints) {
        ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / t.scale
        ctx.beginPath(); ctx.arc(bp.x, bp.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      }
    }
  }

  function drawBoundaryPathPreview(ctx: CanvasRenderingContext2D, t: { scale: number },
    path: number[], pts: Point2D[]) {
    ctx.strokeStyle = 'rgba(136,182,212,0.5)'
    ctx.lineWidth = 2 / t.scale
    ctx.setLineDash([4 / t.scale, 4 / t.scale])
    ctx.beginPath()
    const p0 = pts[path[0]]
    if (p0) ctx.moveTo(p0.x, p0.y)
    for (let i = 1; i < path.length; i++) {
      const p = pts[path[i]]
      if (p) ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // ─── Hit test helpers ──────────────────────────────────────────────

  function hitTestBoundaryVertex(imgPt: Point2D, hitR: number): number {
    if (mode === 'body') {
      let best = -1, bestDist = hitR
      for (const idx of bodyBoundaryVertexSet) {
        const p = workBodyPoints[idx]
        if (!p) continue
        const d = Math.hypot(p.x - imgPt.x, p.y - imgPt.y)
        if (d < bestDist) { bestDist = d; best = idx }
      }
      return best
    } else {
      if (!activeLimbId) return -1
      const pts = workZonePoints[activeLimbId] ?? []
      let best = -1, bestDist = hitR
      for (const idx of limbBoundaryVertexSet) {
        const p = pts[idx]
        if (!p) continue
        const d = Math.hypot(p.x - imgPt.x, p.y - imgPt.y)
        if (d < bestDist) { bestDist = d; best = idx }
      }
      return best
    }
  }

  function hitTestBridgePoint(imgPt: Point2D, hitR: number): number {
    const bps = mode === 'body' ? activeBodyHF?.bridgePoints : activeLimbHF?.bridgePoints
    if (!bps) return -1
    let best = -1, bestDist = hitR
    for (let i = 0; i < bps.length; i++) {
      const d = Math.hypot(bps[i].x - imgPt.x, bps[i].y - imgPt.y)
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  }

  // ─── Toggle hidden face per zone ───────────────────────────────────

  function toggleBodyHiddenFace(limbId: string) {
    pushHistory()
    if (hiddenFaces[limbId]) {
      const hf = hiddenFaces[limbId]
      if (hf.generated && hf.bodyTriangleIndices.length > 0) {
        // Reset body to base state (before any hidden face merges) — depuis baseline.
        setWorkBodyPoints([...bodyBaselinePoints])
        setWorkBodyTriangles([...bodyBaselineTriangles])
        setHiddenFaces(prev => {
          const copy = { ...prev }
          delete copy[limbId]
          for (const key of Object.keys(copy)) {
            copy[key] = { ...copy[key], generated: false, bodyTriangleIndices: [] }
          }
          return copy
        })
      } else {
        setHiddenFaces(prev => { const copy = { ...prev }; delete copy[limbId]; return copy })
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

  function toggleLimbHiddenFace(limbId: string) {
    pushHistory()
    if (limbHiddenFaces[limbId]) {
      const hfl = limbHiddenFaces[limbId]
      if (hfl.generated && hfl.zoneTriangleIndices.length > 0) {
        setWorkZonePoints(prev => ({
          ...prev,
          [limbId]: [...(zoneBaselinePoints[limbId] ?? pt.zonePoints[limbId] ?? [])],
        }))
        setWorkZoneTriangles(prev => ({
          ...prev,
          [limbId]: [...(zoneBaselineTriangles[limbId] ?? pt.zoneTriangles[limbId] ?? [])],
        }))
      }
      setLimbHiddenFaces(prev => { const copy = { ...prev }; delete copy[limbId]; return copy })
      if (activeLimbId === limbId) setActiveLimbId(null)
    } else {
      setLimbHiddenFaces(prev => ({
        ...prev,
        [limbId]: { zoneVertexA: null, zoneVertexB: null, bridgePoints: [], zoneTriangleIndices: [], generated: false },
      }))
      setActiveLimbId(limbId)
    }
  }

  // ─── Generate triangulation ────────────────────────────────────────

  function handleGenerate() {
    if (!activeLimbId) return
    pushHistory()
    if (mode === 'body') {
      if (!activeBodyHF || activeBodyHF.vertexA === null || activeBodyHF.vertexB === null) return
      const result = triangulateHiddenFace(
        workBodyPoints, workBodyTriangles,
        activeBodyHF.vertexA, activeBodyHF.vertexB,
        activeBodyHF.bridgePoints,
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
    } else {
      if (!activeLimbHF || activeLimbHF.zoneVertexA === null || activeLimbHF.zoneVertexB === null) return
      const zonePts = workZonePoints[activeLimbId] ?? []
      const zoneTris = workZoneTriangles[activeLimbId] ?? []
      const result = triangulateHiddenFaceLimb(
        zonePts, zoneTris,
        activeLimbHF.zoneVertexA, activeLimbHF.zoneVertexB,
        activeLimbHF.bridgePoints,
      )
      setWorkZonePoints(prev => ({ ...prev, [activeLimbId]: result.updatedZonePoints }))
      setWorkZoneTriangles(prev => ({ ...prev, [activeLimbId]: result.updatedZoneTriangles }))
      setLimbHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: {
          ...prev[activeLimbId],
          zoneTriangleIndices: result.hiddenFaceLimbTriangleIndices,
          generated: true,
        },
      }))
    }
  }

  // ─── Mouse handlers ────────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button === 2) { handleContextMenu(e); return }
    if (e.button !== 0 || spaceDown.current || isPanning.current) return
    if (!activeLimbId) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    if (editPhase === 'select-a') {
      const idx = hitTestBoundaryVertex(imgPt, hitR)
      if (idx >= 0) {
        pushHistory()
        if (mode === 'body') {
          setHiddenFaces(prev => ({ ...prev, [activeLimbId]: { ...prev[activeLimbId], vertexA: idx } }))
        } else {
          setLimbHiddenFaces(prev => ({ ...prev, [activeLimbId]: { ...prev[activeLimbId], zoneVertexA: idx } }))
        }
      }
      return
    }

    if (editPhase === 'select-b') {
      const idx = hitTestBoundaryVertex(imgPt, hitR)
      const vertA = mode === 'body' ? activeBodyHF?.vertexA : activeLimbHF?.zoneVertexA
      if (idx >= 0 && idx !== vertA) {
        pushHistory()
        if (mode === 'body') {
          setHiddenFaces(prev => ({ ...prev, [activeLimbId]: { ...prev[activeLimbId], vertexB: idx } }))
        } else {
          setLimbHiddenFaces(prev => ({ ...prev, [activeLimbId]: { ...prev[activeLimbId], zoneVertexB: idx } }))
        }
      }
      return
    }

    if (editPhase === 'bridge') {
      const bpIdx = hitTestBridgePoint(imgPt, hitR)
      if (bpIdx >= 0) {
        pushHistory()
        setDragIdx(bpIdx)
        return
      }
      // Add new bridge point
      pushHistory()
      if (mode === 'body') {
        setHiddenFaces(prev => ({
          ...prev,
          [activeLimbId]: { ...prev[activeLimbId], bridgePoints: [...prev[activeLimbId].bridgePoints, imgPt] },
        }))
      } else {
        setLimbHiddenFaces(prev => ({
          ...prev,
          [activeLimbId]: { ...prev[activeLimbId], bridgePoints: [...prev[activeLimbId].bridgePoints, imgPt] },
        }))
      }
      return
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (dragIdx === null || !activeLimbId) return
    const imgPt = screenToImage(e.clientX, e.clientY)

    if (mode === 'body') {
      setHiddenFaces(prev => {
        const hf = prev[activeLimbId]
        if (!hf) return prev
        const pts = [...hf.bridgePoints]; pts[dragIdx] = imgPt
        return { ...prev, [activeLimbId]: { ...hf, bridgePoints: pts } }
      })
    } else {
      setLimbHiddenFaces(prev => {
        const hfl = prev[activeLimbId]
        if (!hfl) return prev
        const pts = [...hfl.bridgePoints]; pts[dragIdx] = imgPt
        return { ...prev, [activeLimbId]: { ...hfl, bridgePoints: pts } }
      })
    }
  }

  function handleMouseUp() { setDragIdx(null) }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (!activeLimbId || editPhase !== 'bridge') return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    const bpIdx = hitTestBridgePoint(imgPt, hitR)
    if (bpIdx >= 0) {
      pushHistory()
      if (mode === 'body') {
        setHiddenFaces(prev => {
          const hf = prev[activeLimbId]
          if (!hf) return prev
          const pts = [...hf.bridgePoints]; pts.splice(bpIdx, 1)
          return { ...prev, [activeLimbId]: { ...hf, bridgePoints: pts } }
        })
      } else {
        setLimbHiddenFaces(prev => {
          const hfl = prev[activeLimbId]
          if (!hfl) return prev
          const pts = [...hfl.bridgePoints]; pts.splice(bpIdx, 1)
          return { ...prev, [activeLimbId]: { ...hfl, bridgePoints: pts } }
        })
      }
    }
  }

  // ─── Reset ─────────────────────────────────────────────────────────

  function handleReset() {
    if (!activeLimbId) return
    pushHistory()
    if (mode === 'body') {
      // Reset body au baseline (avant toute fusion HF) et invalide toutes les body HF.
      setWorkBodyPoints([...bodyBaselinePoints])
      setWorkBodyTriangles([...bodyBaselineTriangles])
      setHiddenFaces(prev => {
        const copy = { ...prev }
        copy[activeLimbId] = { vertexA: null, vertexB: null, bridgePoints: [], bodyTriangleIndices: [], generated: false }
        for (const key of Object.keys(copy)) {
          if (key !== activeLimbId) {
            copy[key] = { ...copy[key], generated: false, bodyTriangleIndices: [] }
          }
        }
        return copy
      })
    } else {
      setLimbHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: { zoneVertexA: null, zoneVertexB: null, bridgePoints: [], zoneTriangleIndices: [], generated: false },
      }))
      setWorkZonePoints(prev => ({
        ...prev,
        [activeLimbId]: [...(zoneBaselinePoints[activeLimbId] ?? pt.zonePoints[activeLimbId] ?? [])],
      }))
      setWorkZoneTriangles(prev => ({
        ...prev,
        [activeLimbId]: [...(zoneBaselineTriangles[activeLimbId] ?? pt.zoneTriangles[activeLimbId] ?? [])],
      }))
    }
  }

  // ─── Save ──────────────────────────────────────────────────────────

  async function handleSave() {
    setSaving(true)
    try {
      // Build body hidden face zones
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

      // Build limb hidden face zones
      const hiddenFaceLimbZones: HiddenFaceLimbZone[] = []
      for (const [limbZoneId, hfl] of Object.entries(limbHiddenFaces)) {
        if (hfl.zoneVertexA !== null && hfl.zoneVertexB !== null && hfl.zoneTriangleIndices.length > 0) {
          hiddenFaceLimbZones.push({
            limbZoneId,
            zoneVertexA: hfl.zoneVertexA,
            zoneVertexB: hfl.zoneVertexB,
            bridgePoints: hfl.bridgePoints,
            zoneTriangleIndices: hfl.zoneTriangleIndices,
          })
        }
      }

      const updatedPT = {
        ...pt,
        bodyPoints: workBodyPoints,
        bodyTriangles: workBodyTriangles,
        zonePoints: { ...pt.zonePoints, ...workZonePoints },
        zoneTriangles: { ...pt.zoneTriangles, ...workZoneTriangles },
        hiddenFaceZones,
        hiddenFaceLimbZones,
        step3Validated: true,
      }

      await onSave({ ...project, projectTriangulation: updatedPT })
    } catch (err) {
      console.error('[ProjectTriangHiddenFace] save failed:', err)
    }
    setSaving(false)
  }

  // ─── Render ────────────────────────────────────────────────────────

  const currentFaces = mode === 'body' ? hiddenFaces : limbHiddenFaces
  const enabledCount = Object.keys(currentFaces).length
  const generatedCount = mode === 'body'
    ? Object.values(hiddenFaces).filter(hf => hf.generated).length
    : Object.values(limbHiddenFaces).filter(hfl => hfl.generated).length

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', flex: 1, minHeight: 0, display: 'block', borderRadius: 8 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
        />
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13 }}>
          {!activeLimbId
            ? 'Activez une face cachee pour une patte.'
            : editPhase === 'select-a'
              ? mode === 'body'
                ? 'Cliquez sur un sommet du contour body (point A).'
                : 'Cliquez sur un sommet du contour de la patte (point A).'
              : editPhase === 'select-b'
                ? mode === 'body'
                  ? 'Cliquez sur un 2e sommet du contour body (point B).'
                  : 'Cliquez sur un 2e sommet du contour de la patte (point B).'
                : editPhase === 'bridge'
                  ? 'Placez des points entre A et B. Drag = deplacer. Clic droit = supprimer. Puis "Generer".'
                  : 'Triangulation generee. Vous pouvez valider ou reinitialiser.'}
        </div>
      </div>

      <div style={{ width: 260, flexShrink: 0, overflowY: 'auto' }}>
        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
          <button
            className={`btn-sm ${mode === 'body' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { pushHistory(); setMode('body'); setActiveLimbId(null) }}
            style={{ flex: 1, fontSize: 11 }}
          >
            Face cachee body
          </button>
          <button
            className={`btn-sm ${mode === 'limb' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { pushHistory(); setMode('limb'); setActiveLimbId(null) }}
            style={{ flex: 1, fontSize: 11 }}
          >
            Face cachee jambe
          </button>
        </div>

        <button
          className="btn-sm btn-ghost"
          onClick={undo}
          disabled={history.length === 0}
          title="Annuler (Ctrl/Cmd+Z)"
          style={{ width: '100%', fontSize: 11, marginBottom: 8, opacity: history.length === 0 ? 0.4 : 1 }}
        >
          ↶ Annuler
        </button>

        <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 12 }}>
          {mode === 'body'
            ? 'Maillage derriere chaque patte (corps cache par la patte).'
            : 'Extension de la patte (partie cachee derriere le corps).'}
        </div>

        {legZones.map(zone => {
          const isEnabled = mode === 'body' ? !!hiddenFaces[zone.id] : !!limbHiddenFaces[zone.id]
          const isActive = zone.id === activeLimbId
          const hf = mode === 'body' ? hiddenFaces[zone.id] : null
          const hfl = mode === 'limb' ? limbHiddenFaces[zone.id] : null
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
                    onClick={(e) => {
                      e.stopPropagation()
                      if (mode === 'body') toggleBodyHiddenFace(zone.id)
                      else toggleLimbHiddenFace(zone.id)
                    }}
                    style={{ fontSize: 10, padding: '2px 6px' }}
                  >
                    {isEnabled ? 'X' : '+ Activer'}
                  </button>
                </div>
                {mode === 'body' && hf && (
                  <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                    {hf.generated
                      ? `${hf.bodyTriangleIndices.length} triangles generes`
                      : hf.vertexA !== null && hf.vertexB !== null
                        ? `A=${hf.vertexA} B=${hf.vertexB} · ${hf.bridgePoints.length} pts bridge`
                        : hf.vertexA !== null ? 'Point A selectionne, cliquez B...' : 'Selectionnez le point A...'}
                  </div>
                )}
                {mode === 'limb' && hfl && (
                  <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                    {hfl.generated
                      ? `${hfl.zoneTriangleIndices.length} triangles generes`
                      : hfl.zoneVertexA !== null && hfl.zoneVertexB !== null
                        ? `A=${hfl.zoneVertexA} B=${hfl.zoneVertexB} · ${hfl.bridgePoints.length} pts bridge`
                        : hfl.zoneVertexA !== null ? 'Point A selectionne, cliquez B...' : 'Selectionnez le point A...'}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {/* Action buttons for active face */}
        {activeLimbId && (activeBodyHF || activeLimbHF) && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {editPhase === 'bridge' && (
              <button
                className="btn-sm btn-secondary"
                onClick={handleGenerate}
                style={{ width: '100%', fontSize: 12 }}
              >
                Generer la triangulation
              </button>
            )}
            {(editPhase !== 'select-a' || (mode === 'body' ? activeBodyHF?.generated : activeLimbHF?.generated)) && (
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
            ? 'Aucune face cachee. Activez une patte pour definir.'
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
