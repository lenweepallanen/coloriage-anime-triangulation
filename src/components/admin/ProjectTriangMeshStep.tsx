/**
 * ProjectTriangMeshStep — Step 2 of the project-level triangulation pipeline.
 *
 * Two-phase per-zone editing:
 *   Phase 1 (Contour): Resample SAM 2 contour → adjust count slider → drag/insert/delete → "Valider contour"
 *   Phase 2 (Triangulation): Auto internal points (density slider) + manual add/drag/delete → Delaunay
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { Project, Point2D, SAM2Zone } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { triangulateZone, generateInternalPoints, findTwoNearest } from '../../utils/limbSeparation'
import { pointInPolygon } from '../../utils/geometry'

type BodyEditMode = 'add' | 'connect' | 'move'

const POINT_RADIUS = 5
const HIT_RADIUS = 10
const DEFAULT_DENSITY = 5
const DEFAULT_CONTOUR_COUNT = 30

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

type ZonePhase = 'contour' | 'triangulation'

export default function ProjectTriangMeshStep({ project, onSave }: Props) {
  const tri = project.projectTriangulation

  // ─── Zone list ──────────────────────────────────────────────────────
  const allZones = useMemo<SAM2Zone[]>(() => {
    const zones = tri?.zones ?? []
    // Ensure body is present
    if (!zones.find(z => z.id === 'body')) {
      return [...zones, { id: 'body', label: 'Corps', color: '#888888' }]
    }
    return zones
  }, [tri])

  // ─── Per-zone contour state (Phase 1) ────────────────────────────
  const [contourCount, setContourCount] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const z of allZones) init[z.id] = tri?.zoneContourCount?.[z.id] ?? DEFAULT_CONTOUR_COUNT
    return init
  })

  const [contourPts, setContourPts] = useState<Record<string, Point2D[]>>(() => {
    return tri?.zoneContourPoints ?? {}
  })

  const [contourValidated, setContourValidated] = useState<Record<string, boolean>>(() => {
    return tri?.zoneContourValidated ?? {}
  })

  // ─── Per-zone z-order ──────────────────────────────────────────────
  const [zoneZOrder, setZoneZOrder] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (let i = 0; i < allZones.length; i++) {
      init[allZones[i].id] = allZones[i].zOrder ?? (allZones[i].id === 'body' ? 0 : i)
    }
    return init
  })

  // ─── Per-zone internal state (Phase 2) ───────────────────────────
  const [zoneDensity, setZoneDensity] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {}
    for (const z of allZones) init[z.id] = tri?.zoneDensity?.[z.id] ?? DEFAULT_DENSITY
    return init
  })

  const [manualPoints, setManualPoints] = useState<Record<string, Point2D[]>>(() => {
    // Restore manual points from saved zonePoints (points after contour count)
    const init: Record<string, Point2D[]> = {}
    for (const z of allZones) {
      const saved = tri?.zonePoints?.[z.id]
      const cCount = tri?.zoneContourCount?.[z.id] ?? 0
      if (saved && cCount > 0 && saved.length > cCount) {
        // Auto-internal points are regenerated from density, manual are at the end
        // We can't perfectly separate auto from manual on reload, so keep all extra as manual
        init[z.id] = []
      } else {
        init[z.id] = []
      }
    }
    return init
  })

  // ─── Body patch state (Ajouter / Relier / Déplacer) ───────────────
  const [bodyExtraPts, setBodyExtraPts] = useState<Point2D[]>([])
  const [bodyManualTris, setBodyManualTris] = useState<[number, number, number][]>([])
  const [bodyEditMode, setBodyEditMode] = useState<BodyEditMode>('add')
  const [connectAnchor, setConnectAnchor] = useState<number | null>(null)
  const [connectLast, setConnectLast] = useState<number | null>(null)

  const [activeZoneId, setActiveZoneId] = useState<string | null>(null)
  const [dragTarget, setDragTarget] = useState<{
    zoneId: string; type: 'contour' | 'internal' | 'bodyExtra'; idx: number
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  // ─── Helpers ──────────────────────────────────────────────────────

  function zonePhase(zoneId: string): ZonePhase {
    return contourValidated[zoneId] ? 'triangulation' : 'contour'
  }

  /** Sample a closed polygon into N evenly-spaced vertices. */
  function sampleContour(polygon: Point2D[], count: number): Point2D[] {
    if (polygon.length < 3 || count < 3) return [...polygon]
    let totalLen = 0
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length
      totalLen += Math.hypot(polygon[j].x - polygon[i].x, polygon[j].y - polygon[i].y)
    }
    const step = totalLen / count
    const result: Point2D[] = []
    let segIdx = 0, segStart = 0
    for (let i = 0; i < count; i++) {
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

  function spacingForDensity(density: number): number {
    const img = imageRef.current
    const maxDim = img ? Math.max(img.naturalWidth, img.naturalHeight) : 800
    return maxDim / (density * 3 + 5)
  }

  /** Get current contour points for a zone (validated or resampled from SAM 2). */
  function getContourPts(zoneId: string): Point2D[] {
    if (contourPts[zoneId]?.length) return contourPts[zoneId]
    const rawContour = tri?.contours?.[zoneId]
    if (!rawContour || rawContour.length < 3) return []
    return sampleContour(rawContour, contourCount[zoneId] ?? DEFAULT_CONTOUR_COUNT)
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
  }, [project.originalImageBlob, tri?.referenceImageBlob])

  // ─── Auto-resample contour when count slider changes ──────────────

  useEffect(() => {
    if (!activeZoneId || zonePhase(activeZoneId) !== 'contour') return
    const rawContour = tri?.contours?.[activeZoneId]
    if (!rawContour || rawContour.length < 3) return
    const count = contourCount[activeZoneId] ?? DEFAULT_CONTOUR_COUNT
    setContourPts(prev => ({
      ...prev,
      [activeZoneId]: sampleContour(rawContour, count),
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contourCount, activeZoneId])

  // ─── Compute zone meshes (Phase 2 zones only) ────────────────────

  const zoneMeshes = useMemo(() => {
    if (!tri?.contours) return null
    const result: Record<string, {
      points: Point2D[]
      triangles: [number, number, number][]
      contourCount: number
    }> = {}

    for (const z of allZones) {
      if (!contourValidated[z.id]) continue
      const cPts = contourPts[z.id]
      if (!cPts || cPts.length < 3) continue
      const density = zoneDensity[z.id] ?? DEFAULT_DENSITY
      const spacing = spacingForDensity(density)
      const autoInternal = generateInternalPoints(cPts, spacing)
      const manual = manualPoints[z.id] ?? []
      const allInternal = [...autoInternal, ...manual]
      let triResult = triangulateZone(cPts, allInternal, cPts)

      // Body only: remove triangles touching leg zones, compact orphan vertices,
      // then append manual patch points + triangles
      if (z.id === 'body') {
        const legContours = allZones
          .filter(lz => lz.id !== 'body' && contourValidated[lz.id] && contourPts[lz.id]?.length >= 3)
          .map(lz => contourPts[lz.id])
        if (legContours.length > 0) {
          // Filter triangles
          const filteredTris = triResult.triangles.filter(([a, b, c]) => {
            const pa = triResult.points[a], pb = triResult.points[b], pc = triResult.points[c]
            return !legContours.some(legC =>
              pointInPolygon(pa, legC) || pointInPolygon(pb, legC) || pointInPolygon(pc, legC)
            )
          })
          // Compact: keep only vertices referenced by surviving triangles
          const usedSet = new Set<number>()
          for (const [a, b, c] of filteredTris) { usedSet.add(a); usedSet.add(b); usedSet.add(c) }
          // Always keep contour points (indices 0..contourCount-1)
          for (let i = 0; i < cPts.length; i++) usedSet.add(i)
          const usedArr = [...usedSet].sort((a, b) => a - b)
          const oldToNew = new Map<number, number>()
          const newPts: Point2D[] = []
          for (const oldIdx of usedArr) {
            oldToNew.set(oldIdx, newPts.length)
            newPts.push(triResult.points[oldIdx])
          }
          const newTris = filteredTris.map(([a, b, c]) =>
            [oldToNew.get(a)!, oldToNew.get(b)!, oldToNew.get(c)!] as [number, number, number]
          )
          triResult = { points: newPts, triangles: newTris }
        }
        // Append manual patch (extra points + manual triangles)
        const allPts = [...triResult.points, ...bodyExtraPts]
        triResult = { points: allPts, triangles: [...triResult.triangles, ...bodyManualTris] }
      }

      result[z.id] = {
        points: triResult.points,
        triangles: triResult.triangles,
        contourCount: cPts.length,
      }
    }
    return result
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allZones, contourPts, contourValidated, zoneDensity, manualPoints, bodyExtraPts, bodyManualTris, imageLoaded])

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

    // Draw all zone SAM 2 contours as thin reference lines
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

    // Draw Phase 2 zone meshes (triangulation)
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
      const phase = zonePhase(activeZoneId)
      const pr = POINT_RADIUS / t.scale

      if (phase === 'contour') {
        // Phase 1: draw editable contour
        const pts = getContourPts(activeZoneId)
        if (pts.length >= 2) {
          // Contour edges
          ctx.strokeStyle = hexToRgba(color, 0.8)
          ctx.lineWidth = 2 / t.scale
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
          ctx.closePath()
          ctx.stroke()

          // Contour points
          for (const p of pts) {
            ctx.fillStyle = color
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.5 / t.scale
            ctx.beginPath()
            ctx.arc(p.x, p.y, pr, 0, Math.PI * 2)
            ctx.fill(); ctx.stroke()
          }
        }
      } else {
        // Phase 2: draw vertices
        const zm = zoneMeshes?.[activeZoneId]
        if (zm) {
          // For body: compute boundary between auto and manual
          const isBody = activeZoneId === 'body'
          const autoPointCount = isBody ? (zm.points.length - bodyExtraPts.length) : zm.points.length

          for (let i = 0; i < zm.points.length; i++) {
            const p = zm.points[i]
            if (i < zm.contourCount) {
              // Contour point (read-only)
              ctx.fillStyle = hexToRgba(color, 0.5)
              ctx.beginPath(); ctx.arc(p.x, p.y, pr * 0.5, 0, Math.PI * 2); ctx.fill()
            } else if (isBody && i >= autoPointCount) {
              // Body extra point (patch mode) — cyan
              ctx.fillStyle = '#06b6d4'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath(); ctx.arc(p.x, p.y, pr * 1.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            } else {
              // Internal point (editable)
              ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath(); ctx.arc(p.x, p.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            }
          }

          // Highlight connect anchor + last
          if (isBody && bodyEditMode === 'connect' && connectAnchor !== null) {
            const pa = zm.points[connectAnchor]
            if (pa) {
              ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.5 / t.scale
              ctx.beginPath(); ctx.arc(pa.x, pa.y, pr * 1.8, 0, Math.PI * 2); ctx.stroke()
            }
            if (connectLast !== null) {
              const pl = zm.points[connectLast]
              if (pl) {
                ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2 / t.scale
                ctx.beginPath(); ctx.arc(pl.x, pl.y, pr * 1.5, 0, Math.PI * 2); ctx.stroke()
              }
            }
          }
        }
      }
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  }, [tri?.contours, zoneMeshes, allZones, activeZoneId, contourPts, contourCount, contourValidated, bodyExtraPts, bodyEditMode, connectAnchor, connectLast, transformRef, imageLoaded])

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
      const phase = zonePhase(activeZoneId)

      if (phase === 'contour') {
        const pts = getContourPts(activeZoneId)
        // Try drag existing contour point
        for (let i = pts.length - 1; i >= 0; i--) {
          if (Math.hypot(pts[i].x - imgPt.x, pts[i].y - imgPt.y) < hitR) {
            setDragTarget({ zoneId: activeZoneId, type: 'contour', idx: i })
            return
          }
        }
        // Try insert on edge
        const insertIdx = findInsertOnEdge(pts, imgPt, hitR * 2)
        if (insertIdx >= 0) {
          const newPts = [...pts]
          newPts.splice(insertIdx + 1, 0, imgPt)
          setContourPts(prev => ({ ...prev, [activeZoneId]: newPts }))
          return
        }
      } else if (activeZoneId === 'body') {
        // Phase 2 body: Ajouter / Relier / Déplacer
        const zm = zoneMeshes?.['body']
        if (!zm) return

        if (bodyEditMode === 'move') {
          // Drag body extra points only
          for (let i = bodyExtraPts.length - 1; i >= 0; i--) {
            if (Math.hypot(bodyExtraPts[i].x - imgPt.x, bodyExtraPts[i].y - imgPt.y) < hitR) {
              setDragTarget({ zoneId: 'body', type: 'bodyExtra', idx: i })
              return
            }
          }
          return
        }

        if (bodyEditMode === 'connect') {
          // Click on any body point to build triangles
          const hitIdx = hitTestBodyPoint(zm.points, imgPt, hitR)
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

        if (bodyEditMode === 'add') {
          // Add new point connected to 2 nearest vertices
          const newIdx = zm.points.length
          const [n1, n2] = findTwoNearest(imgPt, zm.points)
          setBodyExtraPts(prev => [...prev, imgPt])
          setBodyManualTris(prev => [...prev, [newIdx, n1, n2]])
          return
        }
      } else {
        // Phase 2 leg zones: drag/add internal points
        const zm = zoneMeshes?.[activeZoneId]
        if (zm) {
          const manual = manualPoints[activeZoneId] ?? []
          const cPts = contourPts[activeZoneId] ?? []
          const density = zoneDensity[activeZoneId] ?? DEFAULT_DENSITY
          const autoCount = generateInternalPoints(cPts, spacingForDensity(density)).length
          const manualStartIdx = cPts.length + autoCount

          for (let i = manual.length - 1; i >= 0; i--) {
            const p = zm.points[manualStartIdx + i]
            if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
              setDragTarget({ zoneId: activeZoneId, type: 'internal', idx: i })
              return
            }
          }

          const cPtsZone = contourPts[activeZoneId]
          if (cPtsZone && pointInPolygon(imgPt, cPtsZone)) {
            setManualPoints(prev => ({
              ...prev,
              [activeZoneId]: [...(prev[activeZoneId] ?? []), imgPt],
            }))
            return
          }
        }
      }
    }

    // Click outside active zone → select zone
    const contours = tri?.contours
    if (contours) {
      for (const z of allZones) {
        const rawC = contours[z.id]
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
    if (dragTarget.type === 'contour') {
      setContourPts(prev => {
        const arr = [...(prev[dragTarget.zoneId] ?? [])]
        arr[dragTarget.idx] = imgPt
        return { ...prev, [dragTarget.zoneId]: arr }
      })
    } else if (dragTarget.type === 'bodyExtra') {
      setBodyExtraPts(prev => {
        const arr = [...prev]
        arr[dragTarget.idx] = imgPt
        return arr
      })
    } else {
      setManualPoints(prev => {
        const arr = [...(prev[dragTarget.zoneId] ?? [])]
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
    const hitR = HIT_RADIUS / transformRef.current.scale
    const phase = zonePhase(activeZoneId)

    if (phase === 'contour') {
      const pts = getContourPts(activeZoneId)
      if (pts.length <= 3) return // minimum 3 points
      for (let i = pts.length - 1; i >= 0; i--) {
        if (Math.hypot(pts[i].x - imgPt.x, pts[i].y - imgPt.y) < hitR) {
          const newPts = [...pts]
          newPts.splice(i, 1)
          setContourPts(prev => ({ ...prev, [activeZoneId]: newPts }))
          return
        }
      }
    } else if (activeZoneId === 'body') {
      // Phase 2 body: delete body extra points (and their triangles)
      const zm = zoneMeshes?.['body']
      if (!zm) return
      const autoPointCount = zm.points.length - bodyExtraPts.length
      for (let i = bodyExtraPts.length - 1; i >= 0; i--) {
        const globalIdx = autoPointCount + i
        const p = zm.points[globalIdx]
        if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
          // Remove point and all manual triangles referencing it
          setBodyExtraPts(prev => { const a = [...prev]; a.splice(i, 1); return a })
          setBodyManualTris(prev => {
            // Reindex: remove tris referencing globalIdx, shift down indices > globalIdx
            return prev
              .filter(([a, b, c]) => a !== globalIdx && b !== globalIdx && c !== globalIdx)
              .map(([a, b, c]) => [
                a > globalIdx ? a - 1 : a,
                b > globalIdx ? b - 1 : b,
                c > globalIdx ? c - 1 : c,
              ] as [number, number, number])
          })
          return
        }
      }
    } else {
      // Phase 2 leg zones: delete manual internal
      const zm = zoneMeshes?.[activeZoneId]
      if (!zm) return
      const manual = manualPoints[activeZoneId] ?? []
      const cPts = contourPts[activeZoneId] ?? []
      const density = zoneDensity[activeZoneId] ?? DEFAULT_DENSITY
      const autoCount = generateInternalPoints(cPts, spacingForDensity(density)).length
      const manualStartIdx = cPts.length + autoCount

      for (let i = manual.length - 1; i >= 0; i--) {
        const p = zm.points[manualStartIdx + i]
        if (p && Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
          setManualPoints(prev => {
            const arr = [...(prev[activeZoneId] ?? [])]
            arr.splice(i, 1)
            return { ...prev, [activeZoneId]: arr }
          })
          return
        }
      }
    }
  }

  // ─── Body helpers ──────────────────────────────────────────────────

  function hitTestBodyPoint(pts: Point2D[], imgPt: Point2D, hitR: number): number {
    let best = -1, bestDist = hitR
    for (let i = 0; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - imgPt.x, pts[i].y - imgPt.y)
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  }

  // ─── Validate contour → transition to Phase 2 ────────────────────

  function handleValidateContour(zoneId: string) {
    const pts = getContourPts(zoneId)
    if (pts.length < 3) return
    setContourPts(prev => ({ ...prev, [zoneId]: pts }))
    setContourValidated(prev => ({ ...prev, [zoneId]: true }))
    setManualPoints(prev => ({ ...prev, [zoneId]: [] }))
  }

  function handleResetContour(zoneId: string) {
    setContourValidated(prev => ({ ...prev, [zoneId]: false }))
    setManualPoints(prev => ({ ...prev, [zoneId]: [] }))
  }

  function handleDensityChange(zoneId: string, value: number) {
    setZoneDensity(prev => ({ ...prev, [zoneId]: value }))
    setManualPoints(prev => ({ ...prev, [zoneId]: [] }))
    // Reset body patch if body density changes (indices become invalid)
    if (zoneId === 'body') {
      setBodyExtraPts([]); setBodyManualTris([])
      setConnectAnchor(null); setConnectLast(null)
    }
  }

  // ─── Save ─────────────────────────────────────────────────────────

  const allContoursValidated = allZones.every(z => contourValidated[z.id])

  async function handleSave() {
    if (!tri || !zoneMeshes) return
    setSaving(true)
    try {
      const newZonePoints: Record<string, Point2D[]> = {}
      const newZoneTriangles: Record<string, [number, number, number][]> = {}
      for (const z of allZones) {
        const zm = zoneMeshes[z.id]
        if (zm) {
          newZonePoints[z.id] = zm.points
          newZoneTriangles[z.id] = zm.triangles
        }
      }

      // Persist z-order onto zones
      const updatedZones = allZones.map(z => ({ ...z, zOrder: zoneZOrder[z.id] ?? 0 }))

      await onSave({
        ...project,
        projectTriangulation: {
          ...tri,
          zones: updatedZones,
          zoneContourCount: { ...contourCount },
          zoneContourPoints: { ...contourPts },
          zoneContourValidated: { ...contourValidated },
          zonePoints: newZonePoints,
          zoneTriangles: newZoneTriangles,
          zoneDensity: { ...zoneDensity },
          bodyPoints: newZonePoints['body'] ?? [],
          bodyTriangles: newZoneTriangles['body'] ?? [],
          step2Validated: true,
          step3Validated: false,
        },
      })
    } catch (err) {
      console.error('[ProjectTriangMesh] save failed:', err)
    }
    setSaving(false)
  }

  // ─── Render ───────────────────────────────────────────────────────

  if (!tri?.step1Validated) {
    return <div style={{ padding: 20, color: '#f59e0b' }}>Validez d'abord les zones SAM 2 (étape précédente).</div>
  }
  if (!tri.contours || Object.keys(tri.contours).length === 0) {
    return <div style={{ padding: 20, color: '#f59e0b' }}>Aucun contour disponible. Retournez à l'étape 1.</div>
  }

  const activePhase = activeZoneId ? zonePhase(activeZoneId) : null
  const activeZone = allZones.find(z => z.id === activeZoneId)
  const activeColor = activeZone?.color ?? '#888'
  const activeLabel = activeZone?.label ?? activeZoneId ?? ''

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
          onContextMenu={handleContextMenu}
        />
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13 }}>
          {!activeZoneId
            ? 'Cliquez sur une zone pour l\'éditer.'
            : activePhase === 'contour'
              ? 'Drag = déplacer point. Clic sur arête = insérer. Clic droit = supprimer. Espace + drag = pan.'
              : activeZoneId === 'body'
                ? bodyEditMode === 'add' ? 'Clic = ajouter point relié aux 2 plus proches. Clic droit = supprimer.'
                : bodyEditMode === 'connect' ? 'Clic 1 = ancre (orange), clic 2 = dernier (vert), clic 3+ = triangle. Clic droit = supprimer.'
                : 'Drag = déplacer points manuels (cyan). Clic droit = supprimer.'
              : 'Clic = ajouter point interne. Drag = déplacer. Clic droit = supprimer.'}
        </div>
      </div>

      {/* Side panel */}
      <div style={{ width: 270, flexShrink: 0, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Maillage par zone</h3>

        {/* Zone pills */}
        {allZones.map(zone => {
          const isActive = zone.id === activeZoneId
          const phase = zonePhase(zone.id)
          const zm = zoneMeshes?.[zone.id]
          const cPts = getContourPts(zone.id)
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
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: zone.color, flexShrink: 0,
                }} />
                <span style={{ color: '#e5e7eb', fontWeight: 500 }}>{zone.label}</span>
                <span style={{
                  marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 3,
                  background: phase === 'triangulation' ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)',
                  color: phase === 'triangulation' ? '#22c55e' : '#f59e0b',
                }}>
                  {phase === 'triangulation' ? '✓ Contour' : 'Contour…'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ color: '#9ca3af', fontSize: 11, flex: 1 }}>
                  {cPts.length} pts contour
                  {zm ? ` · ${zm.triangles.length} tri` : ''}
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
                      width: 36, padding: '1px 4px', fontSize: 11,
                      background: '#1e293b', color: '#e5e7eb', border: '1px solid #374151',
                      borderRadius: 3, textAlign: 'center',
                    }}
                  />
                </label>
              </div>
            </div>
          )
        })}

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '12px 0' }} />

        {/* Active zone controls */}
        {activeZoneId && activePhase === 'contour' && (
          <div style={{ padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeColor }} />
              <span style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 500 }}>
                Contour : {activeLabel}
              </span>
            </div>

            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
              Nombre de points : {contourCount[activeZoneId] ?? DEFAULT_CONTOUR_COUNT}
            </label>
            <input
              type="range"
              min={8}
              max={120}
              value={contourCount[activeZoneId] ?? DEFAULT_CONTOUR_COUNT}
              onChange={e => {
                setContourCount(prev => ({ ...prev, [activeZoneId]: parseInt(e.target.value) }))
              }}
              style={{ width: '100%', marginBottom: 10 }}
            />

            <button
              className="btn-primary"
              onClick={() => handleValidateContour(activeZoneId)}
              style={{ width: '100%' }}
              disabled={getContourPts(activeZoneId).length < 3}
            >
              Valider contour
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
            </div>

            <label style={{ display: 'block', fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
              Densité intérieure : {zoneDensity[activeZoneId] ?? DEFAULT_DENSITY}
            </label>
            <input
              type="range"
              min={1}
              max={10}
              value={zoneDensity[activeZoneId] ?? DEFAULT_DENSITY}
              onChange={e => handleDensityChange(activeZoneId, parseInt(e.target.value))}
              style={{ width: '100%', marginBottom: 6 }}
            />
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 11, color: '#6b7280', marginBottom: 10,
            }}>
              <span>Faible</span>
              <span>Dense</span>
            </div>

            {/* Body patch mode: Ajouter / Relier / Déplacer */}
            {activeZoneId === 'body' && (
              <>
                <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 4 }}>
                  Patch body (combler les trous) :
                </div>
                <div style={{
                  display: 'flex', gap: 4, marginBottom: 8,
                  padding: 4, borderRadius: 6, background: 'rgba(255,255,255,0.04)',
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
                      {{ add: 'Ajouter', connect: 'Relier', move: 'Déplacer' }[mode]}
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
                    style={{ width: '100%', fontSize: 11, marginBottom: 6 }}
                  >
                    Annuler sélection
                  </button>
                )}
                {(bodyExtraPts.length > 0 || bodyManualTris.length > 0) && (
                  <button
                    className="btn-sm btn-danger"
                    onClick={(e) => {
                      e.stopPropagation()
                      setBodyExtraPts([]); setBodyManualTris([])
                      setConnectAnchor(null); setConnectLast(null)
                    }}
                    style={{ width: '100%', fontSize: 11, marginBottom: 6 }}
                  >
                    Effacer le patch ({bodyExtraPts.length} pts, {bodyManualTris.length} tri)
                  </button>
                )}
              </>
            )}

            <button
              className="btn-ghost"
              onClick={() => handleResetContour(activeZoneId)}
              style={{ width: '100%', fontSize: 12, marginBottom: 6 }}
            >
              ← Rééditer le contour
            </button>
          </div>
        )}

        {/* Global save */}
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !allContoursValidated}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde…' : 'Valider tout'}
        </button>
        {!allContoursValidated && (
          <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 6 }}>
            Validez le contour de chaque zone avant de pouvoir valider.
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

/** Find the contour edge closest to a point (for insert-on-edge). Returns index i such that the point should be inserted between pts[i] and pts[i+1], or -1. */
function findInsertOnEdge(pts: Point2D[], p: Point2D, maxDist: number): number {
  let bestDist = maxDist
  let bestIdx = -1
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const d = pointToSegmentDist(p, pts[i], pts[j])
    if (d < bestDist) {
      bestDist = d
      bestIdx = i
    }
  }
  return bestIdx
}

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
