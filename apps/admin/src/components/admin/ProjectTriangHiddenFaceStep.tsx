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
 * Body mode: 1 HFZ par limb-hider. Selects 2 body boundary vertices (A,B), bridge points, Delaunay → bodyTriangles
 * Limb mode: N HFL par membre (keyed by HFL id). Selects 2 zone boundary vertices (A,B), bridge points, Delaunay → zoneTriangles
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

interface HiddenFaceLimbEntry extends HiddenFaceLimbState {
  id: string
  limbZoneId: string
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

/** Reconstruit le mesh "vierge" en retirant les triangles de face cachée + les points
 *  orphelins. Les fusions HFL/HFZ n'ajoutent que des points/triangles en fin de tableau,
 *  donc retirer ces triangles et compacter restitue exactement le mesh d'avant fusion,
 *  en préservant les indices des points d'origine (utilisés par les triangles visibles). */
function stripHiddenGeometry(
  points: Point2D[],
  triangles: [number, number, number][],
  hiddenTriIndices: number[],
): { points: Point2D[]; triangles: [number, number, number][] } {
  if (hiddenTriIndices.length === 0) return { points, triangles }
  const removeSet = new Set(hiddenTriIndices)
  const kept = triangles.filter((_, i) => !removeSet.has(i))
  const used = new Set<number>()
  for (const [a, b, c] of kept) { used.add(a); used.add(b); used.add(c) }
  const usedArr = [...used].sort((a, b) => a - b)
  const remap = new Map<number, number>()
  const newPts: Point2D[] = []
  for (const old of usedArr) { remap.set(old, newPts.length); newPts.push(points[old]) }
  const newTris = kept.map(([a, b, c]) =>
    [remap.get(a)!, remap.get(b)!, remap.get(c)!] as [number, number, number])
  return { points: newPts, triangles: newTris }
}

function HiddenFaceEditor({ project, onSave }: Props) {
  const pt = project.projectTriangulation!

  const legZones = useMemo(() => pt.zones.filter(z => z.id !== 'body'), [pt.zones])

  // Baseline = mesh vierge avant fusion des faces cachées. Si la baseline persistée est
  // absente (projet legacy), on la reconstruit en retirant la géométrie des HFL/HFZ du
  // mesh fusionné courant. Indispensable pour pouvoir revenir au mesh initial à la suppression.
  const bodyBaselinePoints = useMemo(() => {
    if (pt.bodyPointsBaseline && pt.bodyTrianglesBaseline) return pt.bodyPointsBaseline
    const idx = (pt.hiddenFaceZones ?? []).flatMap(h => h.bodyTriangleIndices)
    return stripHiddenGeometry(pt.bodyPoints, pt.bodyTriangles, idx).points
  }, [pt.bodyPointsBaseline, pt.bodyTrianglesBaseline, pt.bodyPoints, pt.bodyTriangles, pt.hiddenFaceZones])
  const bodyBaselineTriangles = useMemo(() => {
    if (pt.bodyPointsBaseline && pt.bodyTrianglesBaseline) return pt.bodyTrianglesBaseline
    const idx = (pt.hiddenFaceZones ?? []).flatMap(h => h.bodyTriangleIndices)
    return stripHiddenGeometry(pt.bodyPoints, pt.bodyTriangles, idx).triangles
  }, [pt.bodyPointsBaseline, pt.bodyTrianglesBaseline, pt.bodyPoints, pt.bodyTriangles, pt.hiddenFaceZones])
  const zoneBaselinePoints = useMemo(() => {
    const out: Record<string, Point2D[]> = {}
    for (const z of legZones) {
      if (pt.zonePointsBaseline?.[z.id] && pt.zoneTrianglesBaseline?.[z.id]) {
        out[z.id] = pt.zonePointsBaseline[z.id]
      } else {
        const idx = (pt.hiddenFaceLimbZones ?? []).filter(h => h.limbZoneId === z.id).flatMap(h => h.zoneTriangleIndices)
        out[z.id] = stripHiddenGeometry(pt.zonePoints[z.id] ?? [], pt.zoneTriangles[z.id] ?? [], idx).points
      }
    }
    return out
  }, [legZones, pt.zonePointsBaseline, pt.zoneTrianglesBaseline, pt.zonePoints, pt.zoneTriangles, pt.hiddenFaceLimbZones])
  const zoneBaselineTriangles = useMemo(() => {
    const out: Record<string, [number, number, number][]> = {}
    for (const z of legZones) {
      if (pt.zonePointsBaseline?.[z.id] && pt.zoneTrianglesBaseline?.[z.id]) {
        out[z.id] = pt.zoneTrianglesBaseline[z.id]
      } else {
        const idx = (pt.hiddenFaceLimbZones ?? []).filter(h => h.limbZoneId === z.id).flatMap(h => h.zoneTriangleIndices)
        out[z.id] = stripHiddenGeometry(pt.zonePoints[z.id] ?? [], pt.zoneTriangles[z.id] ?? [], idx).triangles
      }
    }
    return out
  }, [legZones, pt.zonePointsBaseline, pt.zoneTrianglesBaseline, pt.zonePoints, pt.zoneTriangles, pt.hiddenFaceLimbZones])

  const [mode, setMode] = useState<HiddenFaceMode>('body')

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

  const [limbHiddenFaces, setLimbHiddenFaces] = useState<Record<string, HiddenFaceLimbEntry>>(() => {
    const init: Record<string, HiddenFaceLimbEntry> = {}
    for (const hfl of pt.hiddenFaceLimbZones) {
      const id = hfl.id ?? crypto.randomUUID()
      init[id] = {
        id,
        limbZoneId: hfl.limbZoneId,
        zoneVertexA: hfl.zoneVertexA,
        zoneVertexB: hfl.zoneVertexB,
        bridgePoints: [...hfl.bridgePoints],
        zoneTriangleIndices: [...hfl.zoneTriangleIndices],
        generated: hfl.zoneTriangleIndices.length > 0,
      }
    }
    return init
  })

  // Work meshes dérivés : baseline + replay de toutes les faces cachées générées.
  // Reconstruction systématique → supprimer une face cachée restitue le mesh vierge.
  const rebuilt = useMemo(() => {
    let bodyPts: Point2D[] = [...bodyBaselinePoints]
    let bodyTris: [number, number, number][] = [...bodyBaselineTriangles]
    const hfzTriIdx: Record<string, number[]> = {}
    for (const [limbId, hf] of Object.entries(hiddenFaces)) {
      if (!hf.generated || hf.vertexA === null || hf.vertexB === null) { hfzTriIdx[limbId] = []; continue }
      try {
        const r = triangulateHiddenFace(bodyPts, bodyTris, hf.vertexA, hf.vertexB, hf.bridgePoints)
        bodyPts = r.updatedBodyPoints; bodyTris = r.updatedBodyTriangles
        hfzTriIdx[limbId] = r.hiddenFaceTriangleIndices
      } catch { hfzTriIdx[limbId] = [] }
    }

    const zonePts: Record<string, Point2D[]> = {}
    const zoneTris: Record<string, [number, number, number][]> = {}
    for (const z of legZones) {
      zonePts[z.id] = [...(zoneBaselinePoints[z.id] ?? [])]
      zoneTris[z.id] = [...(zoneBaselineTriangles[z.id] ?? [])]
    }
    const hflTriIdx: Record<string, number[]> = {}
    const byZone: Record<string, HiddenFaceLimbEntry[]> = {}
    for (const e of Object.values(limbHiddenFaces)) { (byZone[e.limbZoneId] ??= []).push(e) }
    for (const [zid, entries] of Object.entries(byZone)) {
      entries.sort((a, b) => a.id.localeCompare(b.id))
      for (const e of entries) {
        if (!e.generated || e.zoneVertexA === null || e.zoneVertexB === null) { hflTriIdx[e.id] = []; continue }
        if (!zonePts[zid]) { hflTriIdx[e.id] = []; continue }
        try {
          const r = triangulateHiddenFaceLimb(zonePts[zid], zoneTris[zid], e.zoneVertexA, e.zoneVertexB, e.bridgePoints)
          zonePts[zid] = r.updatedZonePoints; zoneTris[zid] = r.updatedZoneTriangles
          hflTriIdx[e.id] = r.hiddenFaceLimbTriangleIndices
        } catch { hflTriIdx[e.id] = [] }
      }
    }
    return { bodyPts, bodyTris, zonePts, zoneTris, hfzTriIdx, hflTriIdx }
  }, [hiddenFaces, limbHiddenFaces, bodyBaselinePoints, bodyBaselineTriangles, zoneBaselinePoints, zoneBaselineTriangles, legZones])

  const workBodyPoints = rebuilt.bodyPts
  const workBodyTriangles = rebuilt.bodyTris
  const workZonePoints = rebuilt.zonePts
  const workZoneTriangles = rebuilt.zoneTris

  const [activeLimbId, setActiveLimbId] = useState<string | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  // En mode limb : limbZoneId associé à l'entrée HFL active.
  const activeLimbZoneId: string | null = mode === 'limb' && activeLimbId
    ? (limbHiddenFaces[activeLimbId]?.limbZoneId ?? null)
    : (mode === 'body' ? activeLimbId : null)

  type HFSnapshot = {
    mode: HiddenFaceMode
    activeLimbId: string | null
    hiddenFaces: Record<string, HiddenFaceState>
    limbHiddenFaces: Record<string, HiddenFaceLimbEntry>
  }
  const HISTORY_LIMIT = 50
  const [history, setHistory] = useState<HFSnapshot[]>([])
  const pushHistory = useCallback(() => {
    setHistory(prev => {
      const snap: HFSnapshot = {
        mode,
        activeLimbId,
        hiddenFaces: structuredClone(hiddenFaces),
        limbHiddenFaces: structuredClone(limbHiddenFaces),
      }
      const next = [...prev, snap]
      if (next.length > HISTORY_LIMIT) next.shift()
      return next
    })
  }, [mode, activeLimbId, hiddenFaces, limbHiddenFaces])
  const undo = useCallback(() => {
    setHistory(prev => {
      if (prev.length === 0) return prev
      const s = prev[prev.length - 1]
      setMode(s.mode)
      setActiveLimbId(s.activeLimbId)
      setHiddenFaces(s.hiddenFaces)
      setLimbHiddenFaces(s.limbHiddenFaces)
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

  const bodyBoundaryEdges = useMemo(() => findBoundaryEdges(workBodyTriangles), [workBodyTriangles])
  const bodyBoundaryVertexSet = useMemo(() => {
    const set = new Set<number>()
    for (const [a, b] of bodyBoundaryEdges) { set.add(a); set.add(b) }
    return set
  }, [bodyBoundaryEdges])

  const activeLimbTriangles: [number, number, number][] = (activeLimbZoneId ? workZoneTriangles[activeLimbZoneId] : null) ?? []
  const limbBoundaryEdges = useMemo(() => findBoundaryEdges(activeLimbTriangles), [activeLimbTriangles])
  const limbBoundaryVertexSet = useMemo(() => {
    const set = new Set<number>()
    for (const [a, b] of limbBoundaryEdges) { set.add(a); set.add(b) }
    return set
  }, [limbBoundaryEdges])

  const boundaryPath = useMemo(() => {
    if (mode === 'body') {
      if (!activeBodyHF || activeBodyHF.vertexA === null || activeBodyHF.vertexB === null) return null
      return walkBoundaryPath(bodyBoundaryEdges, activeBodyHF.vertexB, activeBodyHF.vertexA)
    } else {
      if (!activeLimbHF || activeLimbHF.zoneVertexA === null || activeLimbHF.zoneVertexB === null) return null
      return walkBoundaryPath(limbBoundaryEdges, activeLimbHF.zoneVertexB, activeLimbHF.zoneVertexA)
    }
  }, [mode, activeBodyHF, activeLimbHF, bodyBoundaryEdges, limbBoundaryEdges])

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
      limbHiddenFaces, activeLimbId, activeLimbZoneId, editPhase, boundaryPath, bodyBoundaryVertexSet,
      limbBoundaryVertexSet, transformRef, imageLoaded])

  function drawBodyMode(ctx: CanvasRenderingContext2D, t: { scale: number }, pr: number) {
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

    for (const zone of legZones) {
      const hf = hiddenFaces[zone.id]
      if (!hf || hf.bodyTriangleIndices.length === 0) continue
      const isActive = zone.id === activeLimbId
      if (isActive) {
        ctx.fillStyle = 'rgba(59, 130, 246, 0.45)'
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

    if (activeLimbId && activeBodyHF) {
      const zone = legZones.find(z => z.id === activeLimbId)
      const color = zone?.color ?? '#f59e0b'

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

      if (activeBodyHF.vertexA !== null) {
        const pa = workBodyPoints[activeBodyHF.vertexA]
        if (pa) {
          ctx.fillStyle = '#f59e0b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('A', pa.x + pr * 2.5, pa.y - pr)
        }
      }

      if (activeBodyHF.vertexB !== null) {
        const pb = workBodyPoints[activeBodyHF.vertexB]
        if (pb) {
          ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pb.x, pb.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('B', pb.x + pr * 2.5, pb.y - pr)
        }
      }

      drawBridgePoints(ctx, t, pr, activeBodyHF.bridgePoints, color,
        activeBodyHF.vertexA !== null ? workBodyPoints[activeBodyHF.vertexA] : null,
        activeBodyHF.vertexB !== null ? workBodyPoints[activeBodyHF.vertexB] : null)

      if (boundaryPath && boundaryPath.length > 1 && bodyEditPhase === 'bridge') {
        drawBoundaryPathPreview(ctx, t, boundaryPath, workBodyPoints)
      }
    }
  }

  function drawLimbMode(ctx: CanvasRenderingContext2D, t: { scale: number }, pr: number) {
    if (!activeLimbZoneId) return

    const pts = workZonePoints[activeLimbZoneId] ?? []
    const tris = workZoneTriangles[activeLimbZoneId] ?? []

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

    // Draw inactive HFL entries on the same zone in faded grey (contours only)
    for (const entry of Object.values(limbHiddenFaces)) {
      if (entry.limbZoneId !== activeLimbZoneId) continue
      if (entry.id === activeLimbId) continue
      if (entry.zoneTriangleIndices.length === 0) continue
      ctx.fillStyle = 'rgba(200,200,200,0.1)'
      ctx.strokeStyle = 'rgba(200,200,200,0.5)'
      ctx.lineWidth = 0.8 / t.scale
      for (const ti of entry.zoneTriangleIndices) {
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

    // Active HFL in blue
    if (activeLimbHF && activeLimbHF.zoneTriangleIndices.length > 0) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.45)'
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'
      ctx.lineWidth = 1.5 / t.scale
      for (const ti of activeLimbHF.zoneTriangleIndices) {
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

    if (activeLimbHF) {
      const zone = legZones.find(z => z.id === activeLimbZoneId)
      const color = zone?.color ?? '#f59e0b'

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

      if (activeLimbHF.zoneVertexA !== null) {
        const pa = pts[activeLimbHF.zoneVertexA]
        if (pa) {
          ctx.fillStyle = '#f59e0b'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('A', pa.x + pr * 2.5, pa.y - pr)
        }
      }

      if (activeLimbHF.zoneVertexB !== null) {
        const pb = pts[activeLimbHF.zoneVertexB]
        if (pb) {
          ctx.fillStyle = '#22c55e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(pb.x, pb.y, pr * 2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.fillStyle = '#fff'; ctx.font = `${10 / t.scale}px sans-serif`; ctx.fillText('B', pb.x + pr * 2.5, pb.y - pr)
        }
      }

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
      if (!activeLimbZoneId) return -1
      const pts = workZonePoints[activeLimbZoneId] ?? []
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

  function toggleBodyHiddenFace(limbId: string) {
    pushHistory()
    if (hiddenFaces[limbId]) {
      setHiddenFaces(prev => { const copy = { ...prev }; delete copy[limbId]; return copy })
      if (activeLimbId === limbId) setActiveLimbId(null)
    } else {
      setHiddenFaces(prev => ({
        ...prev,
        [limbId]: { vertexA: null, vertexB: null, bridgePoints: [], bodyTriangleIndices: [], generated: false },
      }))
      setActiveLimbId(limbId)
    }
  }

  function addLimbHiddenFace(limbZoneId: string) {
    pushHistory()
    const id = crypto.randomUUID()
    setLimbHiddenFaces(prev => ({
      ...prev,
      [id]: {
        id, limbZoneId,
        zoneVertexA: null, zoneVertexB: null, bridgePoints: [], zoneTriangleIndices: [], generated: false,
      },
    }))
    setActiveLimbId(id)
  }

  function deleteLimbHiddenFace(hflId: string) {
    pushHistory()
    setLimbHiddenFaces(prev => { const copy = { ...prev }; delete copy[hflId]; return copy })
    if (activeLimbId === hflId) setActiveLimbId(null)
  }

  function handleGenerate() {
    if (!activeLimbId) return
    pushHistory()
    if (mode === 'body') {
      if (!activeBodyHF || activeBodyHF.vertexA === null || activeBodyHF.vertexB === null) return
      setHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: { ...prev[activeLimbId], generated: true },
      }))
    } else {
      if (!activeLimbHF || activeLimbHF.zoneVertexA === null || activeLimbHF.zoneVertexB === null) return
      setLimbHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: { ...prev[activeLimbId], generated: true },
      }))
    }
  }

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

  function handleReset() {
    if (!activeLimbId) return
    pushHistory()
    if (mode === 'body') {
      setHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: { vertexA: null, vertexB: null, bridgePoints: [], bodyTriangleIndices: [], generated: false },
      }))
    } else {
      if (!activeLimbHF) return
      setLimbHiddenFaces(prev => ({
        ...prev,
        [activeLimbId]: {
          ...prev[activeLimbId],
          zoneVertexA: null, zoneVertexB: null, bridgePoints: [], zoneTriangleIndices: [], generated: false,
        },
      }))
    }
  }

  async function handleSave() {
    setSaving(true)
    try {
      const hiddenFaceZones: HiddenFaceZone[] = []
      for (const [limbZoneId, hf] of Object.entries(hiddenFaces)) {
        const indices = rebuilt.hfzTriIdx[limbZoneId] ?? []
        if (hf.generated && hf.vertexA !== null && hf.vertexB !== null && indices.length > 0) {
          hiddenFaceZones.push({
            limbZoneId,
            bodyVertexA: hf.vertexA,
            bodyVertexB: hf.vertexB,
            bridgePoints: hf.bridgePoints,
            bodyTriangleIndices: indices,
          })
        }
      }

      const hiddenFaceLimbZones: HiddenFaceLimbZone[] = Object.values(limbHiddenFaces)
        .filter(e => e.generated && e.zoneVertexA !== null && e.zoneVertexB !== null && (rebuilt.hflTriIdx[e.id]?.length ?? 0) > 0)
        .map(e => ({
          id: e.id,
          limbZoneId: e.limbZoneId,
          zoneVertexA: e.zoneVertexA as number,
          zoneVertexB: e.zoneVertexB as number,
          bridgePoints: e.bridgePoints,
          zoneTriangleIndices: rebuilt.hflTriIdx[e.id] ?? [],
        }))

      const updatedPT = {
        ...pt,
        bodyPoints: workBodyPoints,
        bodyTriangles: workBodyTriangles,
        zonePoints: { ...pt.zonePoints, ...workZonePoints },
        zoneTriangles: { ...pt.zoneTriangles, ...workZoneTriangles },
        bodyPointsBaseline: bodyBaselinePoints,
        bodyTrianglesBaseline: bodyBaselineTriangles,
        zonePointsBaseline: { ...pt.zonePointsBaseline, ...zoneBaselinePoints },
        zoneTrianglesBaseline: { ...pt.zoneTrianglesBaseline, ...zoneBaselineTriangles },
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

  const bodyEnabledCount = Object.keys(hiddenFaces).length
  const bodyGeneratedCount = Object.values(hiddenFaces).filter(hf => hf.generated).length
  const limbEnabledCount = Object.keys(limbHiddenFaces).length
  const limbGeneratedCount = Object.values(limbHiddenFaces).filter(hfl => hfl.generated).length
  const enabledCount = mode === 'body' ? bodyEnabledCount : limbEnabledCount
  const generatedCount = mode === 'body' ? bodyGeneratedCount : limbGeneratedCount

  // Limb mode : entrées groupées par limbZoneId, triées par id pour ordre stable.
  const limbEntriesByZone: Record<string, HiddenFaceLimbEntry[]> = {}
  if (mode === 'limb') {
    for (const zone of legZones) limbEntriesByZone[zone.id] = []
    for (const e of Object.values(limbHiddenFaces)) {
      if (!limbEntriesByZone[e.limbZoneId]) limbEntriesByZone[e.limbZoneId] = []
      limbEntriesByZone[e.limbZoneId].push(e)
    }
    for (const k of Object.keys(limbEntriesByZone)) {
      limbEntriesByZone[k].sort((a, b) => a.id.localeCompare(b.id))
    }
  }

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
            : 'Extension de la patte (partie cachee derriere le corps). Plusieurs faces cachees par membre autorisees.'}
        </div>

        {mode === 'body' && legZones.map(zone => {
          const isEnabled = !!hiddenFaces[zone.id]
          const isActive = zone.id === activeLimbId
          const hf = hiddenFaces[zone.id]
          return (
            <div key={zone.id} style={{ marginBottom: 6 }}>
              <div
                onClick={() => { if (isEnabled) setActiveLimbId(isActive ? null : zone.id) }}
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
                    onClick={(e) => { e.stopPropagation(); toggleBodyHiddenFace(zone.id) }}
                    style={{ fontSize: 10, padding: '2px 6px' }}
                  >
                    {isEnabled ? 'X' : '+ Activer'}
                  </button>
                </div>
                {hf && (
                  <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                    {hf.generated
                      ? `${hf.bodyTriangleIndices.length} triangles generes`
                      : hf.vertexA !== null && hf.vertexB !== null
                        ? `A=${hf.vertexA} B=${hf.vertexB} · ${hf.bridgePoints.length} pts bridge`
                        : hf.vertexA !== null ? 'Point A selectionne, cliquez B...' : 'Selectionnez le point A...'}
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {mode === 'limb' && legZones.map(zone => {
          const entries = limbEntriesByZone[zone.id] ?? []
          return (
            <div key={zone.id} style={{
              marginBottom: 8, padding: '8px 10px', borderRadius: 6,
              border: '1px solid #374151',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: zone.color, flexShrink: 0 }} />
                <span style={{ color: '#e5e7eb', fontWeight: 500, flex: 1, fontSize: 13 }}>{zone.label}</span>
                <span style={{ color: '#6b7280', fontSize: 11 }}>{entries.length}</span>
              </div>

              {entries.map((entry, idx) => {
                const isActive = entry.id === activeLimbId
                return (
                  <div
                    key={entry.id}
                    onClick={() => setActiveLimbId(isActive ? null : entry.id)}
                    style={{
                      padding: '6px 8px', borderRadius: 4, marginBottom: 4,
                      border: isActive ? `2px solid ${zone.color}` : '1px solid #2a2f3a',
                      background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                      cursor: 'pointer', fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: '#e5e7eb', flex: 1 }}>HFL #{idx + 1}</span>
                      <button
                        className="btn-sm btn-ghost"
                        onClick={(e) => { e.stopPropagation(); deleteLimbHiddenFace(entry.id) }}
                        style={{ fontSize: 10, padding: '2px 6px' }}
                      >
                        X
                      </button>
                    </div>
                    <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>
                      {entry.generated
                        ? `${entry.zoneTriangleIndices.length} triangles generes`
                        : entry.zoneVertexA !== null && entry.zoneVertexB !== null
                          ? `A=${entry.zoneVertexA} B=${entry.zoneVertexB} · ${entry.bridgePoints.length} pts bridge`
                          : entry.zoneVertexA !== null ? 'Point A selectionne, cliquez B...' : 'Selectionnez le point A...'}
                    </div>
                  </div>
                )
              })}

              <button
                className="btn-sm btn-secondary"
                onClick={() => addLimbHiddenFace(zone.id)}
                style={{ width: '100%', fontSize: 11, marginTop: 4 }}
              >
                + Nouvelle face cachee
              </button>
            </div>
          )
        })}

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
            ? 'Aucune face cachee.'
            : `${enabledCount} face(s) cachee(s) · ${generatedCount} generee(s)`}
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

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
