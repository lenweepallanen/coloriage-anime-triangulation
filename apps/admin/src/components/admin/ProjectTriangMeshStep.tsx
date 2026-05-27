/**
 * ProjectTriangMeshStep — Step 2 of the project-level triangulation pipeline.
 *
 * Per-zone curvilinear mesh editor with 4 sub-phases:
 *   1. P0          — Place origin point on smoothed SAM 2 contour (snap to curvature extrema)
 *   2. Anchors     — Place characteristic anchors (auto-detect by curvature, P0 always [0])
 *   3. Subdivision — Add subdivision points per segment (counters +/- per segment + global)
 *   4. Triangulation — Delaunay on contour [P0, subdiv0, anchor1, subdiv1, ..., anchorN, subdivN]
 *                       + auto internals (density slider) + manual points + body patch
 *
 * Save writes ALL curvilinear data + zonePoints/zoneTriangles + bodyPoints/bodyTriangles
 * + zoneContourLength (= N first indices of zonePoints are the contour, pinned by ARAP V3).
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { Project, Point2D, SAM2Zone, CurvilinearParam } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { triangulateZone, generateInternalPoints, triangulateHiddenFace, triangulateHiddenFaceLimb } from '../../utils/limbSeparation'
import type { HiddenFaceZone, HiddenFaceLimbZone } from '../../types/project'
import { pointInPolygon } from '../../utils/geometry'
import { detectCurvatureExtrema } from '../../utils/curvatureScaleSpace'
import { reorderContourFromOrigin, subdivideContour, computeArcLengths, extractPathBetweenAnchors, computeSubdivisionForFrame } from '../../utils/curvilinearContour'

type ZoneSubPhase = 'p0' | 'anchors' | 'subdivision' | 'triangulation' | 'adjust'

const POINT_RADIUS = 5
const HIT_RADIUS = 10
const DEFAULT_DENSITY = 5
const DEFAULT_ANCHOR_COUNT = 6
const DEFAULT_SEGMENT_SUBDIV = 3
const TOP_CURVATURE_CANDIDATES = 20
const P0_SNAP_RADIUS_PX = 50

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function ProjectTriangMeshStep({ project, onSave }: Props) {
  const tri = project.projectTriangulation

  // ─── Zone list (always include 'body') ────────────────────────────
  const allZones = useMemo<SAM2Zone[]>(() => {
    const zones = tri?.zones ?? []
    if (!zones.find(z => z.id === 'body')) {
      return [...zones, { id: 'body', label: 'Corps', color: '#888888' }]
    }
    return zones
  }, [tri])

  // ─── Per-zone curvilinear state ────────────────────────────────────
  const [zoneOrigins, setZoneOrigins] = useState<Record<string, Point2D>>(() => tri?.zoneOrigins ?? {})
  const [zoneOriginsValidated, setZoneOriginsValidated] = useState<Record<string, boolean>>(() => tri?.zoneOriginsValidated ?? {})
  const [zoneAnchors, setZoneAnchors] = useState<Record<string, Point2D[]>>(() => tri?.zoneAnchors ?? {})
  const [zoneAnchorsValidated, setZoneAnchorsValidated] = useState<Record<string, boolean>>(() => tri?.zoneAnchorsValidated ?? {})
  const [zoneAnchorCount, setZoneAnchorCount] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const z of allZones) init[z.id] = (tri?.zoneAnchors?.[z.id]?.length ?? DEFAULT_ANCHOR_COUNT)
    return init
  })
  const [zoneSubdivisionParams, setZoneSubdivisionParams] = useState<Record<string, CurvilinearParam[]>>(() => tri?.zoneSubdivisionParams ?? {})
  const [zoneSubdivisionPoints, setZoneSubdivisionPoints] = useState<Record<string, Point2D[]>>(() => tri?.zoneSubdivisionPoints ?? {})
  const [zoneSubdivisionValidated, setZoneSubdivisionValidated] = useState<Record<string, boolean>>(() => tri?.zoneSubdivisionValidated ?? {})
  // Manual subdivision points (added by user via shift+click on contour, after the auto subdivision)
  // Positions are stored DIRECTLY (snapped to mesh polyline), params (segIdx, t) are for ordering only.
  const [zoneManualSubdivisionParams, setZoneManualSubdivisionParams] = useState<Record<string, CurvilinearParam[]>>(() => tri?.zoneManualSubdivisionParams ?? {})
  const [zoneManualSubdivisionPoints, setZoneManualSubdivisionPoints] = useState<Record<string, Point2D[]>>(() => tri?.zoneManualSubdivisionPoints ?? {})
  // Pixel-adjust freeze flag (persisted) — when true, useEffect ne recalcule plus les subdivisions
  const [zonePixelAdjusted, setZonePixelAdjusted] = useState<Record<string, boolean>>(() => tri?.zonePixelAdjusted ?? {})
  // Per-zone, per-segment subdivision counts (segIdx → N)
  const [zoneSegmentCounts, setZoneSegmentCounts] = useState<Record<string, number[]>>(() => {
    const init: Record<string, number[]> = {}
    for (const z of allZones) {
      const params = tri?.zoneSubdivisionParams?.[z.id]
      const anchors = tri?.zoneAnchors?.[z.id]
      if (params && anchors && anchors.length > 0) {
        // Reconstruct counts from params
        const counts = new Array(anchors.length).fill(0)
        for (const p of params) {
          if (p.segmentIndex >= 0 && p.segmentIndex < counts.length) counts[p.segmentIndex]++
        }
        init[z.id] = counts
      }
    }
    return init
  })

  // ─── Per-zone density, manual internals, body patch ───────────────
  const [zoneDensity, setZoneDensity] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const z of allZones) init[z.id] = tri?.zoneDensity?.[z.id] ?? DEFAULT_DENSITY
    return init
  })
  const [manualPoints, setManualPoints] = useState<Record<string, Point2D[]>>(() => tri?.zoneManualPoints ?? {})

  // Auto points "gelés" : à la première interaction sur un point auto (drag/delete), on
  // matérialise tous les points auto courants en manuels, puis on désactive la génération
  // auto via ce flag. Permet de bouger/supprimer les points auto comme des manuels.
  const [autoFrozen, setAutoFrozen] = useState<Record<string, boolean>>({})

  // Manual triangles (mode "Relier") — indices into [...cPts, ...autoInternal, ...manualPoints]
  const [manualTriangles, setManualTriangles] = useState<Record<string, [number, number, number][]>>(() => tri?.zoneManualTriangles ?? {})
  const [bodyEditMode, setBodyEditMode] = useState<'add' | 'connect' | 'move'>('add')
  const [connectBuffer, setConnectBuffer] = useState<number[]>([]) // collected indices for current manual triangle

  // ─── Undo history (triangulation sub-phase only) ───────────────────
  type TriSnapshot = {
    manualPoints: Record<string, Point2D[]>
    manualTriangles: Record<string, [number, number, number][]>
    autoFrozen: Record<string, boolean>
    zoneDensity: Record<string, number>
    bodyEditMode: 'add' | 'connect' | 'move'
    connectBuffer: number[]
    zoneAnchors: Record<string, Point2D[]>
    zoneSubdivisionPoints: Record<string, Point2D[]>
    zoneSubdivisionParams: Record<string, CurvilinearParam[]>
    zoneManualSubdivisionParams: Record<string, CurvilinearParam[]>
    zoneManualSubdivisionPoints: Record<string, Point2D[]>
    zonePixelAdjusted: Record<string, boolean>
  }
  const HISTORY_LIMIT = 50
  const [history, setHistory] = useState<TriSnapshot[]>([])
  const pushHistory = useCallback(() => {
    setHistory(prev => {
      const snap: TriSnapshot = {
        manualPoints: structuredClone(manualPoints),
        manualTriangles: structuredClone(manualTriangles),
        autoFrozen: { ...autoFrozen },
        zoneDensity: { ...zoneDensity },
        bodyEditMode,
        connectBuffer: [...connectBuffer],
        zoneAnchors: structuredClone(zoneAnchors),
        zoneSubdivisionPoints: structuredClone(zoneSubdivisionPoints),
        zoneSubdivisionParams: structuredClone(zoneSubdivisionParams),
        zoneManualSubdivisionParams: structuredClone(zoneManualSubdivisionParams),
        zoneManualSubdivisionPoints: structuredClone(zoneManualSubdivisionPoints),
        zonePixelAdjusted: { ...zonePixelAdjusted },
      }
      const next = [...prev, snap]
      if (next.length > HISTORY_LIMIT) next.shift()
      return next
    })
  }, [manualPoints, manualTriangles, autoFrozen, zoneDensity, bodyEditMode, connectBuffer, zoneAnchors, zoneSubdivisionPoints, zoneSubdivisionParams, zonePixelAdjusted])
  const undo = useCallback(() => {
    setHistory(prev => {
      if (prev.length === 0) return prev
      const snap = prev[prev.length - 1]
      setManualPoints(snap.manualPoints)
      setManualTriangles(snap.manualTriangles)
      setAutoFrozen(snap.autoFrozen)
      setZoneDensity(snap.zoneDensity)
      setBodyEditMode(snap.bodyEditMode)
      setConnectBuffer(snap.connectBuffer)
      setZoneAnchors(snap.zoneAnchors)
      setZoneSubdivisionPoints(snap.zoneSubdivisionPoints)
      setZoneSubdivisionParams(snap.zoneSubdivisionParams)
      setZoneManualSubdivisionParams(snap.zoneManualSubdivisionParams)
      setZoneManualSubdivisionPoints(snap.zoneManualSubdivisionPoints)
      setZonePixelAdjusted(snap.zonePixelAdjusted)
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

  // ─── Z-order ──────────────────────────────────────────────────────
  const [zoneZOrder, setZoneZOrder] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (let i = 0; i < allZones.length; i++) {
      init[allZones[i].id] = allZones[i].zOrder ?? (allZones[i].id === 'body' ? 0 : i)
    }
    return init
  })

  // ─── UI state ─────────────────────────────────────────────────────
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const [activeSubPhase, setActiveSubPhase] = useState<Record<string, ZoneSubPhase>>({})
  const [activeSegment, setActiveSegment] = useState<number | null>(null) // for subdivision UI hover/select
  const [dragTarget, setDragTarget] = useState<{
    zoneId: string; type: 'anchor' | 'p0' | 'internal' | 'bodyExtra' | 'subdivision'; idx: number
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)
  // Mirror transformRef to React state so overlay buttons reposition on pan/zoom
  const [transformState, setTransformState] = useState({ scale: 1, offsetX: 0, offsetY: 0 })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Returns the currently-validated sub-phase index : 0=none, 1=p0, 2=anchors, 3=subdiv, 4=triangulation. */
  function zoneStage(zoneId: string): number {
    if (zoneSubdivisionValidated[zoneId]) return 4
    if (zoneAnchorsValidated[zoneId]) return 3
    if (zoneOriginsValidated[zoneId]) return 2
    return 1
  }

  /** Get the currently-active sub-phase (default = next-to-validate). */
  function getActiveSubPhase(zoneId: string): ZoneSubPhase {
    const explicit = activeSubPhase[zoneId]
    if (explicit) return explicit
    const stage = zoneStage(zoneId)
    if (stage <= 1) return 'p0'
    if (stage === 2) return 'anchors'
    if (stage === 3) return 'subdivision'
    return 'triangulation'
  }

  function setSubPhase(zoneId: string, phase: ZoneSubPhase) {
    setActiveSubPhase(prev => ({ ...prev, [zoneId]: phase }))
  }

  function getRefContour(zoneId: string): Point2D[] | null {
    return tri?.contours?.[zoneId] ?? null
  }

  /** Top-K curvature extrema on the SAM 2 contour. Used as snap candidates for P0/anchors. */
  function getTopExtrema(zoneId: string, k: number = TOP_CURVATURE_CANDIDATES): Point2D[] {
    const contour = getRefContour(zoneId)
    if (!contour || contour.length < 10) return []
    return detectCurvatureExtrema(contour, k).map(c => c.position)
  }

  /** Snap a point to the nearest curvature extremum within snapRadius (or unbounded if snapRadius=0). */
  function snapToExtremum(p: Point2D, candidates: Point2D[], snapRadius: number = 0): Point2D | null {
    if (candidates.length === 0) return null
    let best: Point2D | null = null
    let bestDist = snapRadius > 0 ? snapRadius : Infinity
    for (const c of candidates) {
      const d = Math.hypot(c.x - p.x, c.y - p.y)
      if (d < bestDist) { bestDist = d; best = c }
    }
    return best
  }

  /** Snap a click to the closest polyline edge of the mesh contour and derive (segIdx, t) for ordering. */
  function snapToPolyline(zoneId: string, imgPt: Point2D): { pos: Point2D; param: CurvilinearParam; dist: number } | null {
    const anchors = zoneAnchors[zoneId]
    if (!anchors || anchors.length === 0) return null
    const subParams = zoneSubdivisionParams[zoneId] ?? []
    const subPoints = zoneSubdivisionPoints[zoneId] ?? []
    const n = anchors.length
    // Group auto+manual subdivisions by segment, sorted by t (same convention as buildClosedContour)
    const bySegment: { t: number; pt: Point2D }[][] = Array.from({ length: n }, () => [])
    for (let i = 0; i < subParams.length; i++) {
      const p = subParams[i]; const pt = subPoints[i]
      if (!pt || p.segmentIndex < 0 || p.segmentIndex >= n) continue
      bySegment[p.segmentIndex].push({ t: p.t, pt })
    }
    for (const arr of bySegment) arr.sort((a, b) => a.t - b.t)
    // Build polyline + per-vertex metadata (which anchor segment it belongs to + its t)
    const polyline: Point2D[] = []
    const polyMeta: { segIdx: number; t: number }[] = []
    for (let i = 0; i < n; i++) {
      polyline.push(anchors[i])
      polyMeta.push({ segIdx: i, t: 0 })
      for (const sp of bySegment[i]) {
        polyline.push(sp.pt)
        polyMeta.push({ segIdx: i, t: sp.t })
      }
    }
    // Find closest polyline edge
    let bestDist = Infinity, bestProj: Point2D = { x: 0, y: 0 }, bestEdge = -1, bestEdgeT = 0
    for (let i = 0; i < polyline.length; i++) {
      const a = polyline[i]; const b = polyline[(i + 1) % polyline.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const et = len2 > 0 ? Math.max(0, Math.min(1, ((imgPt.x - a.x) * dx + (imgPt.y - a.y) * dy) / len2)) : 0
      const px = a.x + et * dx, py = a.y + et * dy
      const d = Math.hypot(px - imgPt.x, py - imgPt.y)
      if (d < bestDist) { bestDist = d; bestProj = { x: px, y: py }; bestEdge = i; bestEdgeT = et }
    }
    if (bestEdge < 0) return null
    // Determine (segIdx, t) by interpolating between the two adjacent contour vertices' params
    const startMeta = polyMeta[bestEdge]
    const endMeta = polyMeta[(bestEdge + 1) % polyline.length]
    const segIdx = startMeta.segIdx
    const tStart = startMeta.t
    // If next vertex is in the same segment, use its t; otherwise it's the next anchor → t=1 in the start segment
    const tEnd = endMeta.segIdx === segIdx ? endMeta.t : 1
    const t = Math.min(0.999, Math.max(0.001, tStart + bestEdgeT * (tEnd - tStart)))
    return { pos: bestProj, param: { segmentIndex: segIdx, t }, dist: bestDist }
  }

  /** Minimum distance from a point to the edges of a closed polygon. */
  function distPointToPolygon(p: Point2D, poly: Point2D[]): number {
    if (poly.length < 2) return Infinity
    let best = Infinity
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const len2 = dx * dx + dy * dy
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
      const px = a.x + t * dx, py = a.y + t * dy
      const d = Math.hypot(px - p.x, py - p.y)
      if (d < best) best = d
    }
    return best
  }

  /** Project a click onto the smoothed reference contour and return its (segmentIndex, t) + snap distance. */
  function paramFromClick(zoneId: string, imgPt: Point2D): (CurvilinearParam & { dist: number }) | null {
    const anchors = zoneAnchors[zoneId]
    const refContour = getRefContour(zoneId)
    const p0 = zoneOrigins[zoneId]
    if (!anchors?.length || !refContour || !p0) return null
    const ordered = reorderContourFromOrigin(refContour, p0)
    const n = anchors.length
    let bestSeg = -1, bestT = 0, bestDist2 = Infinity
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const path = extractPathBetweenAnchors(ordered, anchors[i], anchors[j])
      if (path.length < 2) continue
      const arcs = computeArcLengths(path)
      const total = arcs[arcs.length - 1] || 1
      for (let k = 0; k < path.length; k++) {
        const d = (path[k].x - imgPt.x) ** 2 + (path[k].y - imgPt.y) ** 2
        if (d < bestDist2) {
          bestDist2 = d
          bestSeg = i
          bestT = Math.min(0.99, Math.max(0.01, arcs[k] / total))
        }
      }
    }
    if (bestSeg < 0) return null
    return { segmentIndex: bestSeg, t: bestT, dist: Math.sqrt(bestDist2) }
  }

  /** Build the closed contour as [P0, subdiv_seg0, anchor_1, subdiv_seg1, ..., anchor_N, subdiv_segN]. */
  function buildClosedContour(zoneId: string): Point2D[] | null {
    const anchors = zoneAnchors[zoneId]
    const subParams = zoneSubdivisionParams[zoneId]
    const subPoints = zoneSubdivisionPoints[zoneId]
    if (!anchors || anchors.length === 0 || !subParams || !subPoints) return null
    const n = anchors.length
    // Group subdivision points by segmentIndex, keeping (t, point) so we can sort by t within each segment
    const bySegment: { t: number; pt: Point2D }[][] = Array.from({ length: n }, () => [])
    for (let i = 0; i < subParams.length; i++) {
      const p = subParams[i]
      const pt = subPoints[i]
      if (!pt) continue
      if (p.segmentIndex >= 0 && p.segmentIndex < n) bySegment[p.segmentIndex].push({ t: p.t, pt })
    }
    for (const arr of bySegment) arr.sort((a, b) => a.t - b.t)
    // Assemble : anchor_i then subdivisions of segment_i (which leads to anchor_{i+1})
    const out: Point2D[] = []
    for (let i = 0; i < n; i++) {
      out.push(anchors[i])
      for (const sp of bySegment[i]) out.push(sp.pt)
    }
    return out
  }

  /**
   * Build the unified pre-compact point list for a zone in the triangulation phase,
   * matching triangulateZone's internal ordering : [...cPts, ...autoInternal, ...manualPoints].
   * Manual-triangle indices are stored against this list.
   */
  function buildUnifiedPoints(zoneId: string): {
    points: Point2D[]; cPts: Point2D[]; autoCount: number
  } | null {
    const cPts = buildClosedContour(zoneId)
    if (!cPts || cPts.length < 3) return null
    const density = zoneDensity[zoneId] ?? DEFAULT_DENSITY
    const spacing = spacingForDensity(density)
    const autoInternal = autoFrozen[zoneId] ? [] : generateInternalPoints(cPts, spacing)
    const manual = manualPoints[zoneId] ?? []
    return {
      points: [...cPts, ...autoInternal, ...manual],
      cPts,
      autoCount: autoInternal.length,
    }
  }

  /**
   * Première édition d'un point auto : on rapatrie tous les points auto courants dans
   * manualPoints et on gèle la génération auto pour cette zone. Retourne le manualPoints
   * mis à jour (nécessaire pour calculer l'index du point cliqué après matérialisation).
   */
  function freezeAutoPoints(zoneId: string): Point2D[] {
    if (autoFrozen[zoneId]) return manualPoints[zoneId] ?? []
    const cPts = buildClosedContour(zoneId)
    if (!cPts) return manualPoints[zoneId] ?? []
    const density = zoneDensity[zoneId] ?? DEFAULT_DENSITY
    const spacing = spacingForDensity(density)
    const autoInternal = generateInternalPoints(cPts, spacing)
    const newManual = [...(manualPoints[zoneId] ?? []), ...autoInternal]
    setManualPoints(prev => ({ ...prev, [zoneId]: newManual }))
    setAutoFrozen(prev => ({ ...prev, [zoneId]: true }))
    return newManual
  }

  /** Hit-test against all unified points for a zone. Returns pre-compact index or -1. */
  function hitTestUnified(imgPt: Point2D, zoneId: string, hitR: number): number {
    const u = buildUnifiedPoints(zoneId)
    if (!u) return -1
    let bestIdx = -1
    let bestDist = hitR
    for (let i = 0; i < u.points.length; i++) {
      const p = u.points[i]
      const d = Math.hypot(p.x - imgPt.x, p.y - imgPt.y)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    return bestIdx
  }

  function spacingForDensity(density: number): number {
    const img = imageRef.current
    const maxDim = img ? Math.max(img.naturalWidth, img.naturalHeight) : 800
    return maxDim / (density * 3 + 5)
  }

  // ─── Load image ───────────────────────────────────────────────────

  useEffect(() => {
    const blob = project.originalImageBlob ?? tri?.referenceImageBlob
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
    let didInitialFit = false
    if (canvas) {
      ro = new ResizeObserver(() => {
        // Only auto-fit the very first time the canvas gets a real size.
        // Subsequent resizes (UI panel content changes etc.) must not reset the user's zoom/pan.
        if (didInitialFit) return
        if (imageRef.current && canvas.clientWidth > 0) {
          fitToCanvas(imageRef.current.naturalWidth, imageRef.current.naturalHeight)
          didInitialFit = true
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
  }, [project.originalImageBlob, tri?.referenceImageBlob])

  // ─── Auto-detect anchors when entering Anchors phase or count changes ──

  useEffect(() => {
    if (!activeZoneId) return
    if (getActiveSubPhase(activeZoneId) !== 'anchors') return
    if (zoneAnchorsValidated[activeZoneId]) return // don't auto-replace if already validated
    const p0 = zoneOrigins[activeZoneId]
    const refContour = getRefContour(activeZoneId)
    if (!p0 || !refContour) return
    // Only auto-fill if we don't have anchors yet (initial entry)
    if (zoneAnchors[activeZoneId]?.length) return
    const targetCount = zoneAnchorCount[activeZoneId] ?? DEFAULT_ANCHOR_COUNT
    autoDetectAnchors(activeZoneId, p0, refContour, targetCount)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeZoneId, activeSubPhase])

  function autoDetectAnchors(zoneId: string, p0: Point2D, refContour: Point2D[], targetCount: number) {
    // 1. Get top-K candidates already sorted by curvature score (NMS-spaced)
    const pool = detectCurvatureExtrema(refContour, TOP_CURVATURE_CANDIDATES)
      .filter(c => Math.hypot(c.position.x - p0.x, c.position.y - p0.y) > 20) // exclude very close to P0
    // 2. Take top-(N-1) by curvature score (the array is already score-descending)
    const selected = pool.slice(0, Math.max(0, targetCount - 1)).map(c => c.position)
    // 3. Sort the selected N-1 by arc-length on contour reordered from P0 (chain order)
    const ordered = reorderContourFromOrigin(refContour, p0)
    const arcLens = computeArcLengths(ordered)
    const totalLen = arcLens[arcLens.length - 1] || 1
    function arcLengthOf(p: Point2D): number {
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < ordered.length; i++) {
        const d = (ordered[i].x - p.x) ** 2 + (ordered[i].y - p.y) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      return arcLens[bestIdx] / totalLen
    }
    const sortedByArc = selected
      .map(p => ({ p, s: arcLengthOf(p) }))
      .sort((a, b) => a.s - b.s)
      .map(x => x.p)
    setZoneAnchors(prev => ({ ...prev, [zoneId]: [p0, ...sortedByArc] }))
  }

  // ─── Recompute subdivision points when params/anchors change ──────

  useEffect(() => {
    for (const zoneId of Object.keys(zoneAnchors)) {
      if (activeSubPhase[zoneId] === 'adjust' || zonePixelAdjusted[zoneId]) continue // freeze curvilinear recompute in pixel-adjust phase (session OR persisted)
      const anchors = zoneAnchors[zoneId]
      const refContour = getRefContour(zoneId)
      const p0 = zoneOrigins[zoneId]
      const counts = zoneSegmentCounts[zoneId]
      if (!anchors?.length || !refContour || !p0 || !counts) continue
      // Use reordered contour from P0 for stable arc-length parametrization
      const ordered = reorderContourFromOrigin(refContour, p0)
      const { points, params } = subdivideContour(ordered, anchors, counts)
      // Append manual subdivision points — positions are stored directly (snapped to polyline at click time)
      const rawManualParams = zoneManualSubdivisionParams[zoneId] ?? []
      const rawManualPts = zoneManualSubdivisionPoints[zoneId] ?? []
      const validManualParams: CurvilinearParam[] = []
      const validManualPts: Point2D[] = []
      for (let i = 0; i < rawManualParams.length; i++) {
        const p = rawManualParams[i]
        const pt = rawManualPts[i]
        if (!pt) continue
        if (p.segmentIndex < 0 || p.segmentIndex >= anchors.length) continue
        validManualParams.push(p)
        validManualPts.push(pt)
      }
      setZoneSubdivisionPoints(prev => ({ ...prev, [zoneId]: [...points, ...validManualPts] }))
      setZoneSubdivisionParams(prev => ({ ...prev, [zoneId]: [...params, ...validManualParams] }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneAnchors, zoneSegmentCounts, zoneManualSubdivisionParams, zoneManualSubdivisionPoints])

  // ─── Compute zone meshes (sub-phase 4 only) ───────────────────────

  const zoneMeshes = useMemo(() => {
    if (!tri?.contours) return null
    const result: Record<string, {
      points: Point2D[]
      triangles: [number, number, number][]
      contourCount: number
    }> = {}

    for (const z of allZones) {
      // Need to reach triangulation phase to compute mesh
      if (zoneStage(z.id) < 4) continue
      const cPts = buildClosedContour(z.id)
      if (!cPts || cPts.length < 3) continue
      const density = zoneDensity[z.id] ?? DEFAULT_DENSITY
      const spacing = spacingForDensity(density)
      const autoInternal = autoFrozen[z.id] ? [] : generateInternalPoints(cPts, spacing)
      const manual = manualPoints[z.id] ?? []
      const allInternal = [...autoInternal, ...manual]
      let triResult = triangulateZone(cPts, allInternal, cPts)

      // Trouage généralisé : toute zone est trouée par les zones de z-order STRICTEMENT supérieur.
      // Pour body, ça reproduit l'ancien comportement (body troué par les pattes z > body).
      // Pour les membres, ça permet à un membre de z-order plus haut (ex : tête) de creuser un
      // trou dans un membre de z-order plus bas (ex : aile), ce qui débloque les faces cachées
      // membre→membre dans la même UX que body→membre.
      {
        const currentZ = zoneZOrder[z.id] ?? 0
        const higherContours = allZones
          .filter(other => other.id !== z.id && zoneStage(other.id) >= 4 && (zoneZOrder[other.id] ?? 0) > currentZ)
          .map(other => buildClosedContour(other.id))
          .filter((c): c is Point2D[] => !!c && c.length >= 3)
        const filteredTris = higherContours.length > 0
          ? triResult.triangles.filter(([a, b, c]) => {
              const pa = triResult.points[a], pb = triResult.points[b], pc = triResult.points[c]
              return !higherContours.some(hc =>
                pointInPolygon(pa, hc) || pointInPolygon(pb, hc) || pointInPolygon(pc, hc)
              )
            })
          : triResult.triangles
        // Validate manual triangles : drop any referencing out-of-range indices (stale after density change)
        const manualTrisRaw = manualTriangles[z.id] ?? []
        const totalPts = triResult.points.length
        const manualTris = manualTrisRaw.filter(([a, b, c]) =>
          a >= 0 && a < totalPts && b >= 0 && b < totalPts && c >= 0 && c < totalPts
        )
        // Compact: keep contour, all manual points (admin intent), plus vertices used by surviving auto + manual triangles
        const usedSet = new Set<number>()
        for (const [a, b, c] of filteredTris) { usedSet.add(a); usedSet.add(b); usedSet.add(c) }
        for (const [a, b, c] of manualTris) { usedSet.add(a); usedSet.add(b); usedSet.add(c) }
        for (let i = 0; i < cPts.length; i++) usedSet.add(i)
        const manualOffset = cPts.length + (triResult.points.length - cPts.length - manual.length)
        for (let i = 0; i < manual.length; i++) usedSet.add(manualOffset + i)
        const usedArr = [...usedSet].sort((a, b) => a - b)
        const oldToNew = new Map<number, number>()
        const newPts: Point2D[] = []
        for (const oldIdx of usedArr) {
          oldToNew.set(oldIdx, newPts.length)
          newPts.push(triResult.points[oldIdx])
        }
        const remap = ([a, b, c]: [number, number, number]) =>
          [oldToNew.get(a)!, oldToNew.get(b)!, oldToNew.get(c)!] as [number, number, number]
        const newTris = [...filteredTris.map(remap), ...manualTris.map(remap)]
        triResult = { points: newPts, triangles: newTris }
      }

      result[z.id] = {
        points: triResult.points,
        triangles: triResult.triangles,
        contourCount: cPts.length,
      }
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allZones, zoneAnchors, zoneSubdivisionPoints, zoneSubdivisionValidated,
    zoneDensity, manualPoints, manualTriangles, autoFrozen, imageLoaded, zoneZOrder,
  ])

  // ─── Draw ─────────────────────────────────────────────────────────

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

    const contours = tri?.contours
    if (!contours) { ctx.restore(); return }

    // Draw all zone SAM 2 contours as faint reference lines
    for (const z of allZones) {
      const rawC = contours[z.id]
      if (!rawC || rawC.length < 3) continue
      ctx.strokeStyle = hexToRgba(z.color, 0.25)
      ctx.lineWidth = 1 / t.scale
      ctx.beginPath()
      ctx.moveTo(rawC[0].x, rawC[0].y)
      for (let i = 1; i < rawC.length; i++) ctx.lineTo(rawC[i].x, rawC[i].y)
      ctx.closePath()
      ctx.stroke()
    }

    // Draw zone meshes (triangulation phase)
    if (zoneMeshes) {
      for (const z of allZones) {
        const zm = zoneMeshes[z.id]
        if (!zm || zm.triangles.length === 0) continue
        const isActive = z.id === activeZoneId
        ctx.fillStyle = hexToRgba(z.color, isActive ? 0.2 : 0.06)
        ctx.strokeStyle = hexToRgba(z.color, isActive ? 0.6 : 0.2)
        ctx.lineWidth = (isActive ? 1.2 : 0.5) / t.scale
        for (const [a, b, c] of zm.triangles) {
          const pa = zm.points[a], pb = zm.points[b], pc = zm.points[c]
          if (!pa || !pb || !pc) continue
          ctx.beginPath()
          ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
          ctx.closePath(); ctx.fill(); ctx.stroke()
        }
      }
    }

    // Draw active zone detail
    if (activeZoneId) {
      const zone = allZones.find(z => z.id === activeZoneId)
      const color = zone?.color ?? '#888'
      const phase = getActiveSubPhase(activeZoneId)
      const pr = POINT_RADIUS / t.scale

      // Sub-phase P0 : top-K curvature extrema as snap candidates (orange)
      if (phase === 'p0') {
        const candidates = getTopExtrema(activeZoneId)
        ctx.fillStyle = '#fb923c'
        for (const c of candidates) {
          ctx.globalAlpha = 0.7
          ctx.beginPath(); ctx.arc(c.x, c.y, pr * 0.7, 0, Math.PI * 2); ctx.fill()
        }
        ctx.globalAlpha = 1
        // P0 itself
        const p0 = zoneOrigins[activeZoneId]
        if (p0) {
          ctx.fillStyle = '#ef4444'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
          ctx.beginPath(); ctx.arc(p0.x, p0.y, pr * 1.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        }
      }

      // Sub-phase Anchors / Subdivision / Triangulation : draw current anchors + subdivision
      if (phase === 'anchors' || phase === 'subdivision' || phase === 'triangulation' || phase === 'adjust') {
        const closedContour = buildClosedContour(activeZoneId)
        const anchors = zoneAnchors[activeZoneId] ?? []
        const subPoints = zoneSubdivisionPoints[activeZoneId] ?? []
        const subParams = zoneSubdivisionParams[activeZoneId] ?? []

        // In Anchors phase, show top-K curvature candidates as faint orange dots (placement pool)
        if (phase === 'anchors') {
          const candidates = getTopExtrema(activeZoneId)
          ctx.fillStyle = '#fb923c'
          ctx.globalAlpha = 0.35
          for (const c of candidates) {
            ctx.beginPath(); ctx.arc(c.x, c.y, pr * 0.8, 0, Math.PI * 2); ctx.fill()
          }
          ctx.globalAlpha = 1
        }

        // Closed contour line
        if (closedContour && closedContour.length >= 3) {
          ctx.strokeStyle = hexToRgba(color, 0.8)
          ctx.lineWidth = 1.8 / t.scale
          ctx.beginPath()
          ctx.moveTo(closedContour[0].x, closedContour[0].y)
          for (let i = 1; i < closedContour.length; i++) ctx.lineTo(closedContour[i].x, closedContour[i].y)
          ctx.closePath(); ctx.stroke()
        }

        // Highlight active segment in subdivision phase
        if (phase === 'subdivision' && activeSegment !== null && anchors.length > 0) {
          const a = anchors[activeSegment]
          const b = anchors[(activeSegment + 1) % anchors.length]
          if (a && b) {
            ctx.strokeStyle = '#22c55e'
            ctx.lineWidth = 3 / t.scale
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
          }
        }

        // Subdivision points (orange, well-visible in subdivision + adjust phases)
        const isSubPhase = phase === 'subdivision'
        const isAdjustPhase = phase === 'adjust'
        for (let i = 0; i < subPoints.length; i++) {
          const p = subPoints[i]
          const segIdx = subParams[i]?.segmentIndex
          const isHighlighted = isSubPhase && activeSegment !== null && segIdx === activeSegment
          if (isSubPhase || isAdjustPhase) {
            ctx.fillStyle = isHighlighted ? '#22c55e' : '#fb923c'
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.2 / t.scale
            ctx.beginPath(); ctx.arc(p.x, p.y, pr * 0.85, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          } else {
            // Phase triangulation : losange orange bien visible, contour blanc
            const dr = pr * 1.15
            ctx.fillStyle = '#fb923c'
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.4 / t.scale
            ctx.beginPath()
            ctx.moveTo(p.x, p.y - dr)
            ctx.lineTo(p.x + dr, p.y)
            ctx.lineTo(p.x, p.y + dr)
            ctx.lineTo(p.x - dr, p.y)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
          }
        }

        // Anchors (P0 = index 0, in red disc ; autres = triangle bien visible couleur zone)
        for (let i = 0; i < anchors.length; i++) {
          const a = anchors[i]
          if (i === 0) {
            ctx.fillStyle = '#ef4444'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
            ctx.beginPath(); ctx.arc(a.x, a.y, pr * 1.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          } else {
            // Triangle équilatéral pointant vers le haut, plus gros que les ronds
            const tr = pr * 1.6
            ctx.fillStyle = color
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.8 / t.scale
            ctx.beginPath()
            ctx.moveTo(a.x, a.y - tr)
            ctx.lineTo(a.x + tr * 0.866, a.y + tr * 0.5)
            ctx.lineTo(a.x - tr * 0.866, a.y + tr * 0.5)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()
          }
        }

        // Triangulation / Adjust phase : draw internal points (from zm.points) + manual points (cyan overlay)
        if (phase === 'triangulation' || phase === 'adjust') {
          const zm = zoneMeshes?.[activeZoneId]
          if (zm) {
            // Auto-internal (white)
            for (let i = zm.contourCount; i < zm.points.length; i++) {
              const p = zm.points[i]
              ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            }
            // Manual points (cyan, drawn on top)
            const manual = manualPoints[activeZoneId] ?? []
            for (const p of manual) {
              ctx.fillStyle = '#06b6d4'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath(); ctx.arc(p.x, p.y, pr * 1.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            }
          }
        }

        // ─── Triangulation : manual triangle overlay (mode Relier) ───
        if (phase === 'triangulation') {
          const u = buildUnifiedPoints(activeZoneId)
          const mtris = manualTriangles[activeZoneId] ?? []
          if (u) {
            // Filled manual triangles
            ctx.fillStyle = 'rgba(6, 182, 212, 0.18)'
            ctx.strokeStyle = '#06b6d4'
            ctx.lineWidth = 1.6 / t.scale
            for (const [a, b, c] of mtris) {
              const pa = u.points[a], pb = u.points[b], pc = u.points[c]
              if (!pa || !pb || !pc) continue
              ctx.beginPath()
              ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y); ctx.closePath()
              ctx.fill(); ctx.stroke()
            }
            // Connect buffer : highlight collected vertices + preview line
            if (bodyEditMode === 'connect' && connectBuffer.length > 0) {
              ctx.fillStyle = '#fb923c'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / t.scale
              for (const idx of connectBuffer) {
                const p = u.points[idx]
                if (!p) continue
                ctx.beginPath(); ctx.arc(p.x, p.y, pr * 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
              }
              if (connectBuffer.length === 2) {
                const p1 = u.points[connectBuffer[0]], p2 = u.points[connectBuffer[1]]
                if (p1 && p2) {
                  ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 1.8 / t.scale
                  ctx.setLineDash([4 / t.scale, 4 / t.scale])
                  ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke()
                  ctx.setLineDash([])
                }
              }
            }
          }
        }
      }
    }

    ctx.restore()
    // Sync transform state for overlay buttons repositioning
    const cur = transformRef.current
    setTransformState(prev => {
      if (cur.scale === prev.scale && cur.offsetX === prev.offsetX && cur.offsetY === prev.offsetY) return prev
      return { scale: cur.scale, offsetX: cur.offsetX, offsetY: cur.offsetY }
    })
    animFrameRef.current = requestAnimationFrame(draw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tri?.contours, zoneMeshes, allZones, activeZoneId, activeSubPhase, activeSegment,
    zoneOrigins, zoneAnchors, zoneSubdivisionPoints, zoneSubdivisionParams,
    manualPoints, manualTriangles, bodyEditMode, connectBuffer, transformRef, imageLoaded,
  ])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // ─── Mouse handlers ───────────────────────────────────────────────

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button === 2) { handleContextMenu(e); return }
    if (e.button !== 0 || spaceDown.current || isPanning.current) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const hitR = HIT_RADIUS / transformRef.current.scale

    if (activeZoneId) {
      const phase = getActiveSubPhase(activeZoneId)

      // ── P0 sub-phase : place P0 with snap to nearest curvature extremum ──
      if (phase === 'p0') {
        const candidates = getTopExtrema(activeZoneId)
        const snapRadiusPx = P0_SNAP_RADIUS_PX
        const snapped = snapToExtremum(imgPt, candidates, snapRadiusPx) ?? imgPt
        setZoneOrigins(prev => ({ ...prev, [activeZoneId]: snapped }))
        // Reset downstream
        setZoneAnchors(prev => { const cp = { ...prev }; delete cp[activeZoneId]; return cp })
        setZoneAnchorsValidated(prev => ({ ...prev, [activeZoneId]: false }))
        setZoneSubdivisionParams(prev => { const cp = { ...prev }; delete cp[activeZoneId]; return cp })
        setZoneSubdivisionPoints(prev => { const cp = { ...prev }; delete cp[activeZoneId]; return cp })
        setZoneManualSubdivisionParams(prev => { const cp = { ...prev }; delete cp[activeZoneId]; return cp })
        setZoneManualSubdivisionPoints(prev => { const cp = { ...prev }; delete cp[activeZoneId]; return cp })
        setZoneSubdivisionValidated(prev => ({ ...prev, [activeZoneId]: false }))
        setZoneSegmentCounts(prev => { const cp = { ...prev }; delete cp[activeZoneId]; return cp })
        return
      }

      // ── Anchors sub-phase : drag/add/remove ──
      if (phase === 'anchors') {
        const anchors = zoneAnchors[activeZoneId] ?? []
        // Drag existing
        for (let i = 0; i < anchors.length; i++) {
          if (Math.hypot(anchors[i].x - imgPt.x, anchors[i].y - imgPt.y) < hitR) {
            setDragTarget({ zoneId: activeZoneId, type: 'anchor', idx: i })
            return
          }
        }
        // Add anchor (snap unbounded to curvature extremum)
        const candidates = getTopExtrema(activeZoneId, 50)
        const snapped = snapToExtremum(imgPt, candidates, 0) ?? imgPt
        // Avoid duplicate of P0 or existing anchor
        if (anchors.some(a => Math.hypot(a.x - snapped.x, a.y - snapped.y) < 5)) return
        const newAnchors = sortAnchorsByArcLength([...anchors, snapped], activeZoneId)
        setZoneAnchors(prev => ({ ...prev, [activeZoneId]: newAnchors }))
        return
      }

      // ── Subdivision sub-phase : shift+click = add manual point, click = highlight segment ──
      if (phase === 'subdivision') {
        const anchors = zoneAnchors[activeZoneId] ?? []
        if (anchors.length < 2) return
        if (e.shiftKey) {
          const snap = snapToPolyline(activeZoneId, imgPt)
          if (!snap) return
          setZoneManualSubdivisionParams(prev => ({
            ...prev,
            [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.param],
          }))
          setZoneManualSubdivisionPoints(prev => ({
            ...prev,
            [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.pos],
          }))
          if (zonePixelAdjusted[activeZoneId]) {
            setZoneSubdivisionParams(prev => ({
              ...prev,
              [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.param],
            }))
            setZoneSubdivisionPoints(prev => ({
              ...prev,
              [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.pos],
            }))
          }
          return
        }
        // Find segment whose midpoint is closest to imgPt
        let bestSeg = -1, bestDist = Infinity
        for (let i = 0; i < anchors.length; i++) {
          const a = anchors[i]
          const b = anchors[(i + 1) % anchors.length]
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          const d = Math.hypot(mx - imgPt.x, my - imgPt.y)
          if (d < bestDist) { bestDist = d; bestSeg = i }
        }
        setActiveSegment(bestSeg)
        return
      }

      // ── Adjust sub-phase : drag contour points only (anchors + subdivisions). Aucune action sur les internes. ──
      if (phase === 'adjust') {
        const anchors = zoneAnchors[activeZoneId] ?? []
        for (let i = 0; i < anchors.length; i++) {
          if (Math.hypot(anchors[i].x - imgPt.x, anchors[i].y - imgPt.y) < hitR) {
            pushHistory()
            setDragTarget({ zoneId: activeZoneId, type: 'anchor', idx: i })
            return
          }
        }
        const subs = zoneSubdivisionPoints[activeZoneId] ?? []
        for (let i = 0; i < subs.length; i++) {
          if (Math.hypot(subs[i].x - imgPt.x, subs[i].y - imgPt.y) < hitR) {
            pushHistory()
            setDragTarget({ zoneId: activeZoneId, type: 'subdivision', idx: i })
            return
          }
        }
        return
      }

      // ── Triangulation sub-phase : click=add (re-Delaunay), drag=move, right-click=delete ──
      if (phase === 'triangulation') {
        const closedContour = buildClosedContour(activeZoneId)
        if (!closedContour) return
        const manual = manualPoints[activeZoneId] ?? []

        // ─── Triangulation : Relier mode = pick 3 points → manual triangle ───
        if (bodyEditMode === 'connect') {
          const idx = hitTestUnified(imgPt, activeZoneId, hitR)
          if (idx < 0) return
          pushHistory()
          const next = [...connectBuffer, idx]
          if (next.length < 3) {
            setConnectBuffer(next)
          } else {
            // Avoid degenerate / duplicate triangles
            const [a, b, c] = next
            const unique = a !== b && b !== c && a !== c
            if (unique) {
              setManualTriangles(prev => ({
                ...prev,
                [activeZoneId]: [...(prev[activeZoneId] ?? []), [a, b, c]],
              }))
            }
            setConnectBuffer([])
          }
          return
        }

        // ─── Triangulation : Move mode = drag any point (contour anchors, subdivisions, manual internals) ───
        if (bodyEditMode === 'move') {
          const anchors = zoneAnchors[activeZoneId] ?? []
          for (let i = 0; i < anchors.length; i++) {
            if (Math.hypot(anchors[i].x - imgPt.x, anchors[i].y - imgPt.y) < hitR) {
              pushHistory()
              setDragTarget({ zoneId: activeZoneId, type: 'anchor', idx: i })
              return
            }
          }
          const subs = zoneSubdivisionPoints[activeZoneId] ?? []
          for (let i = 0; i < subs.length; i++) {
            if (Math.hypot(subs[i].x - imgPt.x, subs[i].y - imgPt.y) < hitR) {
              pushHistory()
              setDragTarget({ zoneId: activeZoneId, type: 'subdivision', idx: i })
              return
            }
          }
          for (let i = manual.length - 1; i >= 0; i--) {
            if (Math.hypot(manual[i].x - imgPt.x, manual[i].y - imgPt.y) < hitR) {
              pushHistory()
              setDragTarget({ zoneId: activeZoneId, type: 'internal', idx: i })
              return
            }
          }
          return
        }

        // Try drag existing anchor (P0 inclus = idx 0)
        const anchors = zoneAnchors[activeZoneId] ?? []
        for (let i = 0; i < anchors.length; i++) {
          if (Math.hypot(anchors[i].x - imgPt.x, anchors[i].y - imgPt.y) < hitR) {
            pushHistory()
            setDragTarget({ zoneId: activeZoneId, type: 'anchor', idx: i })
            return
          }
        }
        // Try drag subdivision (free pixel)
        const subs = zoneSubdivisionPoints[activeZoneId] ?? []
        for (let i = 0; i < subs.length; i++) {
          if (Math.hypot(subs[i].x - imgPt.x, subs[i].y - imgPt.y) < hitR) {
            pushHistory()
            setDragTarget({ zoneId: activeZoneId, type: 'subdivision', idx: i })
            return
          }
        }
        // Try drag existing manual point (hit-test on position directly)
        for (let i = manual.length - 1; i >= 0; i--) {
          if (Math.hypot(manual[i].x - imgPt.x, manual[i].y - imgPt.y) < hitR) {
            pushHistory()
            setDragTarget({ zoneId: activeZoneId, type: 'internal', idx: i })
            return
          }
        }
        // Try drag auto-generated internal point (materialize on first interaction)
        if (!autoFrozen[activeZoneId]) {
          const cPts = buildClosedContour(activeZoneId)
          if (cPts) {
            const density = zoneDensity[activeZoneId] ?? DEFAULT_DENSITY
            const autoInternal = generateInternalPoints(cPts, spacingForDensity(density))
            for (let i = 0; i < autoInternal.length; i++) {
              const p = autoInternal[i]
              if (Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
                pushHistory()
                const newManual = freezeAutoPoints(activeZoneId)
                // Le point auto cliqué est désormais à l'index manual.length + i
                setDragTarget({ zoneId: activeZoneId, type: 'internal', idx: newManual.length - autoInternal.length + i })
                return
              }
            }
          }
        }
        // If click is close to a mesh contour edge → snap to polyline & add a manual subdivision point
        const contourSnapPx = 30 / transformRef.current.scale
        const snap = snapToPolyline(activeZoneId, imgPt)
        if (snap && snap.dist < contourSnapPx) {
          pushHistory()
          setZoneManualSubdivisionParams(prev => ({
            ...prev,
            [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.param],
          }))
          setZoneManualSubdivisionPoints(prev => ({
            ...prev,
            [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.pos],
          }))
          // When auto recompute is frozen, push directly into the merged arrays too
          if (zonePixelAdjusted[activeZoneId]) {
            setZoneSubdivisionParams(prev => ({
              ...prev,
              [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.param],
            }))
            setZoneSubdivisionPoints(prev => ({
              ...prev,
              [activeZoneId]: [...(prev[activeZoneId] ?? []), snap.pos],
            }))
          }
          return
        }
        // Otherwise add point if inside the zone contour
        if (pointInPolygon(imgPt, closedContour)) {
          pushHistory()
          setManualPoints(prev => ({
            ...prev,
            [activeZoneId]: [...(prev[activeZoneId] ?? []), imgPt],
          }))
          return
        }
      }
    }

    // Click outside → select zone
    const contoursMap = tri?.contours
    if (contoursMap) {
      for (const z of allZones) {
        const rawC = contoursMap[z.id]
        if (rawC && pointInPolygon(imgPt, rawC)) {
          setActiveZoneId(z.id)
          return
        }
      }
    }
    setActiveZoneId(null)
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!dragTarget) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    if (dragTarget.type === 'anchor') {
      const phase = getActiveSubPhase(dragTarget.zoneId)
      const isFreeDrag = phase === 'adjust' || phase === 'triangulation'
      let pos: Point2D = imgPt
      if (!isFreeDrag) {
        const candidates = getTopExtrema(dragTarget.zoneId, 50)
        pos = snapToExtremum(imgPt, candidates, 0) ?? imgPt
      } else {
        setZonePixelAdjusted(prev => ({ ...prev, [dragTarget.zoneId]: true }))
      }
      setZoneAnchors(prev => {
        const arr = [...(prev[dragTarget.zoneId] ?? [])]
        arr[dragTarget.idx] = pos
        return { ...prev, [dragTarget.zoneId]: arr }
      })
    } else if (dragTarget.type === 'subdivision') {
      setZonePixelAdjusted(prev => ({ ...prev, [dragTarget.zoneId]: true }))
      setZoneSubdivisionPoints(prev => {
        const arr = [...(prev[dragTarget.zoneId] ?? [])]
        arr[dragTarget.idx] = imgPt
        return { ...prev, [dragTarget.zoneId]: arr }
      })
    } else if (dragTarget.type === 'internal') {
      setManualPoints(prev => {
        const arr = [...(prev[dragTarget.zoneId] ?? [])]
        arr[dragTarget.idx] = imgPt
        return { ...prev, [dragTarget.zoneId]: arr }
      })
    }
  }

  function handleMouseUp() {
    if (dragTarget?.type === 'anchor') {
      const phase = getActiveSubPhase(dragTarget.zoneId)
      // Re-sort anchors only in the anchors-edit phase. Triangulation/adjust preserve indexing.
      if (phase !== 'adjust' && phase !== 'triangulation') {
        const zoneId = dragTarget.zoneId
        const anchors = zoneAnchors[zoneId] ?? []
        const sorted = sortAnchorsByArcLength(anchors, zoneId)
        setZoneAnchors(prev => ({ ...prev, [zoneId]: sorted }))
      }
    }
    setDragTarget(null)
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (!activeZoneId) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const hitR = HIT_RADIUS / transformRef.current.scale
    const phase = getActiveSubPhase(activeZoneId)

    // ── Subdivision / Triangulation : right-click to remove a manual subdivision point ──
    if (phase === 'subdivision' || phase === 'triangulation') {
      const manualPts = zoneManualSubdivisionPoints[activeZoneId] ?? []
      if (manualPts.length === 0) {
        if (phase === 'triangulation') {
          // fall through to other triangulation right-click handlers
        } else return
      } else {
        let hit = -1, bestD = hitR
        for (let i = 0; i < manualPts.length; i++) {
          const d = Math.hypot(manualPts[i].x - imgPt.x, manualPts[i].y - imgPt.y)
          if (d < bestD) { bestD = d; hit = i }
        }
        if (hit >= 0) {
          setZoneManualSubdivisionParams(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(hit, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          setZoneManualSubdivisionPoints(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(hit, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          // When auto recompute is frozen, also splice the merged arrays at the correct index
          if (zonePixelAdjusted[activeZoneId]) {
            const manualLen = manualPts.length
            setZoneSubdivisionParams(prev => {
              const arr = [...(prev[activeZoneId] ?? [])]
              const autoLen = arr.length - manualLen
              if (autoLen >= 0 && autoLen + hit < arr.length) arr.splice(autoLen + hit, 1)
              return { ...prev, [activeZoneId]: arr }
            })
            setZoneSubdivisionPoints(prev => {
              const arr = [...(prev[activeZoneId] ?? [])]
              const autoLen = arr.length - manualLen
              if (autoLen >= 0 && autoLen + hit < arr.length) arr.splice(autoLen + hit, 1)
              return { ...prev, [activeZoneId]: arr }
            })
          }
          return
        }
        if (phase === 'subdivision') return
      }
    }

    // ── Anchors : right-click to remove (cannot remove P0=[0]) ──
    if (phase === 'anchors') {
      const anchors = zoneAnchors[activeZoneId] ?? []
      for (let i = anchors.length - 1; i >= 1; i--) { // skip P0
        if (Math.hypot(anchors[i].x - imgPt.x, anchors[i].y - imgPt.y) < hitR) {
          const newAnchors = [...anchors]
          newAnchors.splice(i, 1)
          setZoneAnchors(prev => ({ ...prev, [activeZoneId]: newAnchors }))
          return
        }
      }
      return
    }

    // ── Triangulation : in connect mode, right-click deletes a manual triangle ──
    if (phase === 'triangulation' && bodyEditMode === 'connect') {
      const u = buildUnifiedPoints(activeZoneId)
      const mtris = manualTriangles[activeZoneId] ?? []
      if (u) {
        for (let i = mtris.length - 1; i >= 0; i--) {
          const [a, b, c] = mtris[i]
          const pa = u.points[a], pb = u.points[b], pc = u.points[c]
          if (!pa || !pb || !pc) continue
          const cx = (pa.x + pb.x + pc.x) / 3
          const cy = (pa.y + pb.y + pc.y) / 3
          if (Math.hypot(cx - imgPt.x, cy - imgPt.y) < hitR * 2) {
            pushHistory()
            setManualTriangles(prev => {
              const arr = [...(prev[activeZoneId] ?? [])]
              arr.splice(i, 1)
              return { ...prev, [activeZoneId]: arr }
            })
            return
          }
        }
      }
      // No triangle hit → cancel the in-progress chain
      if (connectBuffer.length > 0) { pushHistory(); setConnectBuffer([]) }
      return
    }

    // ── Adjust : suppression de subdivisions uniquement (contour). Anchors et internes intouchables. ──
    if (phase === 'adjust') {
      const subs = zoneSubdivisionPoints[activeZoneId] ?? []
      for (let i = subs.length - 1; i >= 0; i--) {
        const p = subs[i]
        if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
          pushHistory()
          setZoneSubdivisionPoints(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(i, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          setZoneSubdivisionParams(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(i, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          setZonePixelAdjusted(prev => ({ ...prev, [activeZoneId]: true }))
          setManualTriangles(prev => ({ ...prev, [activeZoneId]: [] }))
          return
        }
      }
      return
    }

    // ── Triangulation : delete any subdivision point (auto or manual) — freeze recompute ──
    if (phase === 'triangulation') {
      const subs = zoneSubdivisionPoints[activeZoneId] ?? []
      for (let i = subs.length - 1; i >= 0; i--) {
        const p = subs[i]
        if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
          pushHistory()
          const manualLen = (zoneManualSubdivisionPoints[activeZoneId] ?? []).length
          const autoLen = subs.length - manualLen
          // If the hit was within the manual range, also remove it from the manual arrays
          if (i >= autoLen) {
            const mi = i - autoLen
            setZoneManualSubdivisionParams(prev => {
              const arr = [...(prev[activeZoneId] ?? [])]
              arr.splice(mi, 1)
              return { ...prev, [activeZoneId]: arr }
            })
            setZoneManualSubdivisionPoints(prev => {
              const arr = [...(prev[activeZoneId] ?? [])]
              arr.splice(mi, 1)
              return { ...prev, [activeZoneId]: arr }
            })
          }
          setZoneSubdivisionPoints(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(i, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          setZoneSubdivisionParams(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(i, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          setZonePixelAdjusted(prev => ({ ...prev, [activeZoneId]: true }))
          setManualTriangles(prev => ({ ...prev, [activeZoneId]: [] }))
          return
        }
      }
      const manual = manualPoints[activeZoneId] ?? []
      for (let i = manual.length - 1; i >= 0; i--) {
        const p = manual[i]
        if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
          pushHistory()
          setManualPoints(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(i, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          // Also clear manual triangles referencing this point (indices shift)
          setManualTriangles(prev => ({ ...prev, [activeZoneId]: [] }))
          return
        }
      }
      // Try delete auto-generated internal point (materialize first, then remove)
      if (!autoFrozen[activeZoneId]) {
        const cPts = buildClosedContour(activeZoneId)
        if (cPts) {
          const density = zoneDensity[activeZoneId] ?? DEFAULT_DENSITY
          const autoInternal = generateInternalPoints(cPts, spacingForDensity(density))
          for (let i = 0; i < autoInternal.length; i++) {
            const p = autoInternal[i]
            if (Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
              pushHistory()
              const newManual = freezeAutoPoints(activeZoneId)
              const removeIdx = newManual.length - autoInternal.length + i
              setManualPoints(prev => {
                const arr = [...(prev[activeZoneId] ?? newManual)]
                arr.splice(removeIdx, 1)
                return { ...prev, [activeZoneId]: arr }
              })
              setManualTriangles(prev => ({ ...prev, [activeZoneId]: [] }))
              return
            }
          }
        }
      }
    }
  }

  // ─── Sort anchors by arc-length on contour (P0 stays at [0]) ──────

  function sortAnchorsByArcLength(anchors: Point2D[], zoneId: string): Point2D[] {
    if (anchors.length <= 1) return anchors
    const refContour = getRefContour(zoneId)
    const p0 = anchors[0]
    if (!refContour || !p0) return anchors
    const ordered = reorderContourFromOrigin(refContour, p0)
    const arcLens = computeArcLengths(ordered)
    const totalLen = arcLens[arcLens.length - 1] || 1
    function arcLengthOf(p: Point2D): number {
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < ordered.length; i++) {
        const d = (ordered[i].x - p.x) ** 2 + (ordered[i].y - p.y) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      return arcLens[bestIdx] / totalLen
    }
    const rest = anchors.slice(1)
      .map(p => ({ p, s: arcLengthOf(p) }))
      .sort((a, b) => a.s - b.s)
      .map(x => x.p)
    return [p0, ...rest]
  }

  // ─── Validation helpers ───────────────────────────────────────────

  function handleValidateP0() {
    if (!activeZoneId) return
    const p0 = zoneOrigins[activeZoneId]
    if (!p0) return
    setZoneOriginsValidated(prev => ({ ...prev, [activeZoneId]: true }))
    setSubPhase(activeZoneId, 'anchors')
  }

  function handleValidateAnchors() {
    if (!activeZoneId) return
    const anchors = zoneAnchors[activeZoneId]
    if (!anchors || anchors.length < 2) return
    setZoneAnchorsValidated(prev => ({ ...prev, [activeZoneId]: true }))
    // Initialize segment counts to default if not set
    setZoneSegmentCounts(prev => {
      if (prev[activeZoneId]?.length === anchors.length) return prev
      return { ...prev, [activeZoneId]: new Array(anchors.length).fill(DEFAULT_SEGMENT_SUBDIV) }
    })
    setSubPhase(activeZoneId, 'subdivision')
  }

  function handleValidateSubdivision() {
    if (!activeZoneId) return
    setZoneSubdivisionValidated(prev => ({ ...prev, [activeZoneId]: true }))
    setSubPhase(activeZoneId, 'triangulation')
  }

  function handleResetSubPhase(zoneId: string, phase: ZoneSubPhase) {
    // Re-editing upstream phases drops the pixel-adjust freeze so curvilinear recompute resumes
    if (phase !== 'adjust') setZonePixelAdjusted(prev => ({ ...prev, [zoneId]: false }))
    if (phase === 'p0' || phase === 'anchors') setZoneAnchorsValidated(prev => ({ ...prev, [zoneId]: false }))
    if (phase === 'p0' || phase === 'anchors' || phase === 'subdivision') {
      setZoneSubdivisionValidated(prev => ({ ...prev, [zoneId]: false }))
    }
    if (phase === 'p0') setZoneOriginsValidated(prev => ({ ...prev, [zoneId]: false }))
    setSubPhase(zoneId, phase)
  }

  function handleSegmentCountChange(zoneId: string, segIdx: number, delta: number) {
    setZoneSegmentCounts(prev => {
      const arr = [...(prev[zoneId] ?? [])]
      arr[segIdx] = Math.max(0, (arr[segIdx] ?? DEFAULT_SEGMENT_SUBDIV) + delta)
      return { ...prev, [zoneId]: arr }
    })
  }

  function handleGlobalSegmentCount(zoneId: string, delta: number) {
    setZoneSegmentCounts(prev => {
      const arr = [...(prev[zoneId] ?? [])]
      for (let i = 0; i < arr.length; i++) arr[i] = Math.max(0, (arr[i] ?? DEFAULT_SEGMENT_SUBDIV) + delta)
      return { ...prev, [zoneId]: arr }
    })
  }

  function handleDensityChange(zoneId: string, value: number) {
    pushHistory()
    setZoneDensity(prev => ({ ...prev, [zoneId]: value }))
    setManualPoints(prev => ({ ...prev, [zoneId]: [] }))
    // Auto-internal indices shift with density → manual triangles become stale
    setManualTriangles(prev => ({ ...prev, [zoneId]: [] }))
    // Density change → user veut regénérer les auto → dégèle
    setAutoFrozen(prev => ({ ...prev, [zoneId]: false }))
    setConnectBuffer([])
  }

  // ─── Save ─────────────────────────────────────────────────────────

  const allZonesReady = allZones.every(z => zoneStage(z.id) >= 4)

  async function handleSave({ validate = true }: { validate?: boolean } = {}) {
    if (!tri) return
    setSaving(true)
    try {
      const newZonePoints: Record<string, Point2D[]> = {}
      const newZoneTriangles: Record<string, [number, number, number][]> = {}
      const newZoneContourLength: Record<string, number> = {}
      for (const z of allZones) {
        const zm = zoneMeshes?.[z.id]
        if (zm) {
          newZonePoints[z.id] = zm.points
          newZoneTriangles[z.id] = zm.triangles
          newZoneContourLength[z.id] = zm.contourCount
        } else if (tri.zonePoints?.[z.id] && tri.zoneTriangles?.[z.id]) {
          // Zone non encore triangulée dans cette session : on conserve le mesh existant.
          newZonePoints[z.id] = tri.zonePoints[z.id]
          newZoneTriangles[z.id] = tri.zoneTriangles[z.id]
          newZoneContourLength[z.id] = tri.zoneContourLength?.[z.id] ?? 0
        }
      }

      const updatedZones = allZones.map(z => ({ ...z, zOrder: zoneZOrder[z.id] ?? 0 }))

      // ─── Snapshot des maillages "propres" (avant fusion des faces cachées) ──
      // Sert au step3 pour pouvoir réinitialiser une face cachée sans résidus.
      const bodyPointsBaseline = (newZonePoints['body'] ?? []).map(p => ({ ...p }))
      const bodyTrianglesBaseline = (newZoneTriangles['body'] ?? []).map(t => [...t] as [number, number, number])
      const zonePointsBaseline: Record<string, Point2D[]> = {}
      const zoneTrianglesBaseline: Record<string, [number, number, number][]> = {}
      for (const z of allZones) {
        if (z.id === 'body') continue
        zonePointsBaseline[z.id] = (newZonePoints[z.id] ?? []).map(p => ({ ...p }))
        zoneTrianglesBaseline[z.id] = (newZoneTriangles[z.id] ?? []).map(t => [...t] as [number, number, number])
      }

      // ─── Replay hidden-face triangulations on the new mesh (step3) ─────
      // bodyPoints/bodyTriangles + zonePoints[limb]/zoneTriangles[limb] are overwritten by the new mesh
      // at this point. Any prior hidden-face additions (bridge points + Delaunay triangles) are lost.
      // We re-run triangulateHiddenFace[Limb] using the persisted bridgePoints + vertexA/B remapped
      // by nearest position, so step4 keeps working without manual re-edit.
      const updatedHiddenFaceZones: HiddenFaceZone[] = []
      const updatedHiddenFaceLimbZones: HiddenFaceLimbZone[] = []
      const nearestIndex = (target: Point2D, points: Point2D[]): number => {
        let best = -1, bestD = Infinity
        for (let i = 0; i < points.length; i++) {
          const d = (points[i].x - target.x) ** 2 + (points[i].y - target.y) ** 2
          if (d < bestD) { bestD = d; best = i }
        }
        return best
      }
      if (tri.step3Validated) {
        // Body hidden faces — mutate newZonePoints['body'] / newZoneTriangles['body']
        let bodyPts = [...(newZonePoints['body'] ?? [])]
        let bodyTris = [...(newZoneTriangles['body'] ?? [])]
        const oldBodyPts = tri.bodyPoints ?? []
        for (const hfz of tri.hiddenFaceZones ?? []) {
          const oldA = oldBodyPts[hfz.bodyVertexA]
          const oldB = oldBodyPts[hfz.bodyVertexB]
          if (!oldA || !oldB) continue
          const newA = nearestIndex(oldA, bodyPts)
          const newB = nearestIndex(oldB, bodyPts)
          if (newA < 0 || newB < 0) continue
          const r = triangulateHiddenFace(bodyPts, bodyTris, newA, newB, hfz.bridgePoints)
          bodyPts = r.updatedBodyPoints
          bodyTris = r.updatedBodyTriangles
          updatedHiddenFaceZones.push({
            ...hfz,
            bodyVertexA: newA,
            bodyVertexB: newB,
            bodyTriangleIndices: r.hiddenFaceTriangleIndices,
          })
        }
        newZonePoints['body'] = bodyPts
        newZoneTriangles['body'] = bodyTris

        // Limb hidden faces — mutate per-zone
        for (const hfl of tri.hiddenFaceLimbZones ?? []) {
          const zid = hfl.limbZoneId
          const oldZonePts = tri.zonePoints?.[zid]
          if (!oldZonePts) { updatedHiddenFaceLimbZones.push(hfl); continue }
          let zPts = [...(newZonePoints[zid] ?? [])]
          let zTris = [...(newZoneTriangles[zid] ?? [])]
          const oldA = oldZonePts[hfl.zoneVertexA]
          const oldB = oldZonePts[hfl.zoneVertexB]
          if (!oldA || !oldB) { updatedHiddenFaceLimbZones.push(hfl); continue }
          const newA = nearestIndex(oldA, zPts)
          const newB = nearestIndex(oldB, zPts)
          if (newA < 0 || newB < 0) { updatedHiddenFaceLimbZones.push(hfl); continue }
          const r = triangulateHiddenFaceLimb(zPts, zTris, newA, newB, hfl.bridgePoints)
          zPts = r.updatedZonePoints
          zTris = r.updatedZoneTriangles
          newZonePoints[zid] = zPts
          newZoneTriangles[zid] = zTris
          updatedHiddenFaceLimbZones.push({
            ...hfl,
            zoneVertexA: newA,
            zoneVertexB: newB,
            zoneTriangleIndices: r.hiddenFaceLimbTriangleIndices,
          })
        }
      }

      // Topology unchanged → preserve hidden faces (step3) validation.
      // zOrder is purely cosmetic and must not invalidate downstream steps.
      const topologyUnchanged =
        tri.zonePoints && tri.zoneTriangles &&
        allZones.every(z => {
          const oldP = tri.zonePoints![z.id]
          const newP = newZonePoints[z.id]
          const oldT = tri.zoneTriangles![z.id]
          const newT = newZoneTriangles[z.id]
          if (!oldP || !newP || oldP.length !== newP.length) return false
          if (!oldT || !newT || oldT.length !== newT.length) return false
          for (let i = 0; i < oldP.length; i++) {
            if (oldP[i].x !== newP[i].x || oldP[i].y !== newP[i].y) return false
          }
          for (let i = 0; i < oldT.length; i++) {
            if (oldT[i][0] !== newT[i][0] || oldT[i][1] !== newT[i][1] || oldT[i][2] !== newT[i][2]) return false
          }
          return true
        })

      await onSave({
        ...project,
        projectTriangulation: {
          ...tri,
          zones: updatedZones,
          // Curvilinear V3
          zoneOrigins: { ...zoneOrigins },
          zoneOriginsValidated: { ...zoneOriginsValidated },
          zoneAnchors: { ...zoneAnchors },
          zoneAnchorsValidated: { ...zoneAnchorsValidated },
          zoneSubdivisionPoints: { ...zoneSubdivisionPoints },
          zoneSubdivisionParams: { ...zoneSubdivisionParams },
          zoneManualSubdivisionParams: { ...zoneManualSubdivisionParams },
          zoneManualSubdivisionPoints: { ...zoneManualSubdivisionPoints },
          zoneSubdivisionValidated: { ...zoneSubdivisionValidated },
          zonePixelAdjusted: { ...zonePixelAdjusted },
          zoneContourLength: newZoneContourLength,
          // Triangulation
          zonePoints: newZonePoints,
          zoneTriangles: newZoneTriangles,
          zoneManualPoints: { ...manualPoints },
          zoneManualTriangles: { ...manualTriangles },
          zoneDensity: { ...zoneDensity },
          bodyPoints: newZonePoints['body'] ?? [],
          bodyTriangles: newZoneTriangles['body'] ?? [],
          bodyPointsBaseline,
          bodyTrianglesBaseline,
          zonePointsBaseline,
          zoneTrianglesBaseline,
          step2Validated: validate ? true : (tri.step2Validated ?? false),
          // Hidden faces replayed in place on the new mesh : preserve step3 validation.
          ...(tri.step3Validated
            ? {
                hiddenFaceZones: updatedHiddenFaceZones,
                hiddenFaceLimbZones: updatedHiddenFaceLimbZones,
                step3Validated: true,
              }
            : { step3Validated: topologyUnchanged ? (tri.step3Validated ?? false) : false }),
        },
      })
      const now = new Date()
      setSavedAt(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`)
    } catch (err) {
      console.error('[ProjectTriangMesh] save failed:', err)
    }
    setSaving(false)
  }

  // ─── Render ───────────────────────────────────────────────────────

  if (!tri?.step1Validated) {
    return <div style={{ padding: 20, color: '#f59e0b' }}>Validez d&apos;abord les zones SAM 2 (étape précédente).</div>
  }
  if (!tri.contours || Object.keys(tri.contours).length === 0) {
    return <div style={{ padding: 20, color: '#f59e0b' }}>Aucun contour disponible. Retournez à l&apos;étape 1.</div>
  }

  const activePhase = activeZoneId ? getActiveSubPhase(activeZoneId) : null
  const activeZone = allZones.find(z => z.id === activeZoneId)
  const activeColor = activeZone?.color ?? '#888'
  const activeLabel = activeZone?.label ?? activeZoneId ?? ''
  const activeAnchors = activeZoneId ? zoneAnchors[activeZoneId] ?? [] : []
  const activeSegmentCounts = activeZoneId ? zoneSegmentCounts[activeZoneId] ?? [] : []

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%', minHeight: 0 }}>
      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', flex: 1, minHeight: 0, display: 'block', borderRadius: 8 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
        />
        {/* Floating per-segment +/- buttons (subdivision phase only) */}
        {activeZoneId && activePhase === 'subdivision' && activeAnchors.length >= 2 && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
            {activeAnchors.map((_, i) => {
              const a = activeAnchors[i]
              const b = activeAnchors[(i + 1) % activeAnchors.length]
              if (!a || !b) return null
              const mx = (a.x + b.x) / 2
              const my = (a.y + b.y) / 2
              const sx = mx * transformState.scale + transformState.offsetX
              const sy = my * transformState.scale + transformState.offsetY
              const from = i === 0 ? 'P0' : String(i)
              const to = i === activeAnchors.length - 1 ? 'P0' : String(i + 1)
              const count = activeSegmentCounts[i] ?? DEFAULT_SEGMENT_SUBDIV
              const isHighlighted = activeSegment === i
              return (
                <div
                  key={i}
                  onClick={(e) => { e.stopPropagation(); setActiveSegment(i) }}
                  style={{
                    position: 'absolute',
                    left: sx,
                    top: sy,
                    transform: 'translate(-50%, -50%)',
                    pointerEvents: 'auto',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    background: isHighlighted ? 'rgba(34,197,94,0.85)' : 'rgba(20,20,30,0.85)',
                    border: `1px solid ${isHighlighted ? '#22c55e' : 'rgba(255,255,255,0.25)'}`,
                    borderRadius: 4,
                    padding: '2px 4px',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
                  }}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSegmentCountChange(activeZoneId, i, -1) }}
                    style={{ width: 22, height: 22, fontSize: '0.85rem', fontWeight: 'bold', padding: 0, lineHeight: 1 }}
                    title={`− segment [${from}→${to}]`}
                  >−</button>
                  <span style={{
                    minWidth: 16, textAlign: 'center', fontSize: '0.8rem', fontWeight: 'bold',
                    color: '#fff',
                  }}>{count}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleSegmentCountChange(activeZoneId, i, +1) }}
                    style={{ width: 22, height: 22, fontSize: '0.85rem', fontWeight: 'bold', padding: 0, lineHeight: 1 }}
                    title={`+ segment [${from}→${to}]`}
                  >+</button>
                </div>
              )
            })}
          </div>
        )}
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13 }}>
          {!activeZoneId
            ? 'Cliquez sur une zone pour l\'éditer.'
            : activePhase === 'p0'
              ? 'Clic = placer P0 (snap sur extremum courbure orange si à moins de 50px). Espace + drag = pan.'
              : activePhase === 'anchors'
                ? 'Clic = ajouter anchor (snap courbure). Drag = déplacer (snap). Clic droit = supprimer (P0 protégé).'
                : activePhase === 'subdivision'
                  ? 'Clic sur un segment pour le surligner. Utilisez les +/- pour ajouter/retirer des points. Shift+clic sur contour = point manuel. Clic droit = supprimer manuel.'
                  : 'Drag anchor/subdivision/interne = repositionner librement (pas de snap, recalcul curviligne figé). Clic près du contour = subdivision manuelle snappée. Clic à l\'intérieur = point interne. Clic droit = supprimer.'}
        </div>
      </div>

      {/* Side panel */}
      <div style={{ width: 290, flexShrink: 0, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Maillage par zone</h3>

        {/* Zone pills + sub-phase mini stepper */}
        {allZones.map(zone => {
          const isActive = zone.id === activeZoneId
          const stage = zoneStage(zone.id)
          const subPhase = isActive ? getActiveSubPhase(zone.id) : null
          return (
            <div
              key={zone.id}
              style={{
                padding: '8px 10px', marginBottom: 6, borderRadius: 6,
                border: isActive ? `2px solid ${zone.color}` : '1px solid #374151',
                background: isActive ? 'rgba(255,255,255,0.05)' : 'transparent',
                fontSize: 13,
              }}
            >
              <div
                onClick={() => setActiveZoneId(isActive ? null : zone.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              >
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: zone.color, flexShrink: 0,
                }} />
                <span style={{ color: '#e5e7eb', fontWeight: 500 }}>{zone.label}</span>
                <span style={{
                  marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 3,
                  background: stage === 4 ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
                  color: stage === 4 ? '#22c55e' : '#f59e0b',
                }}>
                  {stage === 4 ? '✓ Triang.' : `${stage - 1}/4`}
                </span>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9ca3af' }}
                  onClick={e => e.stopPropagation()}
                >
                  z:
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={zoneZOrder[zone.id] ?? 0}
                    onChange={e => {
                      const v = parseInt(e.target.value) || 0
                      setZoneZOrder(prev => ({ ...prev, [zone.id]: v }))
                    }}
                    style={{
                      width: 32, padding: '1px 4px', fontSize: 11,
                      background: '#1e293b', color: '#e5e7eb', border: '1px solid #374151',
                      borderRadius: 3, textAlign: 'center',
                    }}
                  />
                </label>
              </div>
              {isActive && (
                <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
                  {(['p0', 'anchors', 'subdivision', 'triangulation'] as const).map((sp, i) => {
                    const isCurrent = subPhase === sp
                    const isReached = stage > i
                    return (
                      <button
                        key={sp}
                        onClick={() => setSubPhase(zone.id, sp)}
                        className={isCurrent ? 'btn-sm btn-primary' : 'btn-sm btn-ghost'}
                        style={{
                          flex: 1, fontSize: 10, padding: '2px 4px',
                          opacity: isReached ? 1 : 0.6,
                        }}
                      >
                        {{ p0: 'P0', anchors: 'Anc.', subdivision: 'Subd.', triangulation: 'Tri.', adjust: 'Ajust.' }[sp]}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '12px 0' }} />

        {/* Active sub-phase controls */}
        {activeZoneId && activePhase === 'p0' && (
          <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeColor }} />
              <span style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>P0 : {activeLabel}</span>
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
              {zoneOrigins[activeZoneId] ? 'P0 placé.' : 'Cliquez sur le contour (snap orange = extremum courbure).'}
            </div>
            <button
              className="btn-primary"
              onClick={handleValidateP0}
              disabled={!zoneOrigins[activeZoneId]}
              style={{ width: '100%' }}
            >
              Valider P0
            </button>
          </div>
        )}

        {activeZoneId && activePhase === 'anchors' && (
          <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeColor }} />
              <span style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>Anchors : {activeLabel}</span>
            </div>
            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
              Auto-détection : {zoneAnchorCount[activeZoneId] ?? DEFAULT_ANCHOR_COUNT} (P0 inclus)
            </label>
            <input
              type="range" min={2} max={20}
              value={zoneAnchorCount[activeZoneId] ?? DEFAULT_ANCHOR_COUNT}
              onChange={e => {
                const v = parseInt(e.target.value)
                setZoneAnchorCount(prev => ({ ...prev, [activeZoneId]: v }))
                const p0 = zoneOrigins[activeZoneId]
                const refC = getRefContour(activeZoneId)
                if (p0 && refC) autoDetectAnchors(activeZoneId, p0, refC, v)
              }}
              style={{ width: '100%', marginBottom: 8 }}
            />
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8 }}>
              {activeAnchors.length} anchor{activeAnchors.length > 1 ? 's' : ''} placé{activeAnchors.length > 1 ? 's' : ''}.
            </div>
            <button
              className="btn-ghost"
              onClick={() => handleResetSubPhase(activeZoneId, 'p0')}
              style={{ width: '100%', fontSize: 12, marginBottom: 6 }}
            >
              ← Re-placer P0
            </button>
            <button
              className="btn-primary"
              onClick={handleValidateAnchors}
              disabled={activeAnchors.length < 2}
              style={{ width: '100%' }}
            >
              Valider Anchors
            </button>
          </div>
        )}

        {activeZoneId && activePhase === 'subdivision' && (
          <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeColor }} />
              <span style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>Subdivision : {activeLabel}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button className="btn-sm btn-ghost" onClick={() => handleGlobalSegmentCount(activeZoneId, -1)}>− tous</button>
              <button className="btn-sm btn-ghost" onClick={() => handleGlobalSegmentCount(activeZoneId, +1)}>+ tous</button>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
              {activeAnchors.map((_, i) => (
                <div key={i}
                  onClick={() => setActiveSegment(i)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 6px', borderRadius: 4, cursor: 'pointer',
                    background: activeSegment === i ? 'rgba(34,197,94,0.15)' : 'transparent',
                    fontSize: 11, color: '#cbd5e1',
                  }}
                >
                  <span>Seg {i}→{(i + 1) % activeAnchors.length}</span>
                  <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    <button className="btn-sm btn-ghost" style={{ padding: '0 6px', fontSize: 10 }}
                      onClick={e => { e.stopPropagation(); handleSegmentCountChange(activeZoneId, i, -1) }}>−</button>
                    <span style={{ minWidth: 20, textAlign: 'center' }}>{activeSegmentCounts[i] ?? 0}</span>
                    <button className="btn-sm btn-ghost" style={{ padding: '0 6px', fontSize: 10 }}
                      onClick={e => { e.stopPropagation(); handleSegmentCountChange(activeZoneId, i, +1) }}>+</button>
                  </span>
                </div>
              ))}
            </div>
            <button
              className="btn-ghost"
              onClick={() => handleResetSubPhase(activeZoneId, 'anchors')}
              style={{ width: '100%', fontSize: 12, marginBottom: 6 }}
            >
              ← Rééditer anchors
            </button>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6, lineHeight: 1.4 }}>
              Shift+clic sur le contour : ajouter un point de subdivision manuel.<br />
              Clic droit sur un point manuel : le supprimer.
              {activeZoneId && (zoneManualSubdivisionParams[activeZoneId]?.length ?? 0) > 0 && (
                <div style={{ marginTop: 4, color: '#cbd5e1' }}>
                  {zoneManualSubdivisionParams[activeZoneId]!.length} point(s) manuel(s)
                </div>
              )}
            </div>
            <button className="btn-primary" onClick={handleValidateSubdivision} style={{ width: '100%' }}>
              Valider Subdivision
            </button>
          </div>
        )}

        {activeZoneId && activePhase === 'triangulation' && (
          <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeColor }} />
              <span style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>
                Triangulation : {activeLabel}
              </span>
              <button
                className="btn-sm btn-ghost"
                onClick={undo}
                disabled={history.length === 0}
                title="Annuler (Ctrl/Cmd+Z)"
                style={{ marginLeft: 'auto', fontSize: 11, opacity: history.length === 0 ? 0.4 : 1 }}
              >
                ↶ Annuler
              </button>
            </div>

            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
              Densité intérieure : {zoneDensity[activeZoneId] ?? DEFAULT_DENSITY}
            </label>
            <input
              type="range" min={1} max={10}
              value={zoneDensity[activeZoneId] ?? DEFAULT_DENSITY}
              onChange={e => handleDensityChange(activeZoneId, parseInt(e.target.value))}
              style={{ width: '100%', marginBottom: 10 }}
            />

            {activeZoneId && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Mode édition</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['add', 'connect', 'move'] as const).map(m => (
                    <button
                      key={m}
                      className={bodyEditMode === m ? 'btn-sm btn-primary' : 'btn-sm btn-ghost'}
                      onClick={() => { pushHistory(); setBodyEditMode(m); setConnectBuffer([]) }}
                      style={{ flex: 1, fontSize: 11 }}
                    >
                      {{ add: 'Ajouter', connect: 'Relier', move: 'Déplacer' }[m]}
                    </button>
                  ))}
                </div>
                {bodyEditMode === 'connect' && (
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6, lineHeight: 1.4 }}>
                    Cliquez 3 points (contour, auto ou manuels) pour créer un triangle. Clic droit sur un triangle cyan pour le supprimer.
                    {connectBuffer.length > 0 && <span style={{ color: '#fb923c' }}> ({connectBuffer.length}/3)</span>}
                  </div>
                )}
                {(manualTriangles[activeZoneId]?.length ?? 0) > 0 && (
                  <button
                    className="btn-sm btn-danger"
                    onClick={() => {
                      pushHistory()
                      setManualTriangles(prev => ({ ...prev, [activeZoneId]: [] }))
                      setConnectBuffer([])
                    }}
                    style={{ width: '100%', fontSize: 11, marginTop: 6 }}
                  >
                    Effacer les triangles manuels ({manualTriangles[activeZoneId]?.length})
                  </button>
                )}
              </div>
            )}

            {(manualPoints[activeZoneId]?.length ?? 0) > 0 && (
              <button
                className="btn-sm btn-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  pushHistory()
                  setManualPoints(prev => ({ ...prev, [activeZoneId]: [] }))
                  setAutoFrozen(prev => ({ ...prev, [activeZoneId]: false }))
                }}
                style={{ width: '100%', fontSize: 11, marginBottom: 6 }}
              >
                Effacer les points manuels ({manualPoints[activeZoneId]?.length ?? 0})
              </button>
            )}

            <button
              className="btn-ghost"
              onClick={() => handleResetSubPhase(activeZoneId, 'subdivision')}
              style={{ width: '100%', fontSize: 12 }}
            >
              ← Rééditer subdivision
            </button>
          </div>
        )}

        {/* Save buttons */}
        <button
          className="btn-secondary"
          onClick={() => handleSave({ validate: false })}
          disabled={saving}
          style={{ width: '100%', marginBottom: 6 }}
        >
          {saving ? 'Sauvegarde…' : 'Sauvegarder progression'}
        </button>
        <button
          className="btn-primary"
          onClick={() => handleSave({ validate: true })}
          disabled={saving || !allZonesReady}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde…' : 'Valider tout'}
        </button>
        {savedAt && (
          <div style={{ fontSize: 11, color: '#22c55e', marginTop: 6 }}>
            ✓ Sauvegardé à {savedAt}
          </div>
        )}
        {!allZonesReady && (
          <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 6 }}>
            Validation finale : P0 + Anchors + Subdivision requis pour chaque zone. La sauvegarde progression conserve l'état partiel.
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

