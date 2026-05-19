import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminContext } from './AdminLayout'
import {
  DEFAULT_PROJECT_EYES,
  getGeometryOwner,
  type BezierNode,
  type EyeRegion,
  type Point2D,
  type Project,
  type ProjectEyes,
} from '../../types/project'
import { getEyeBodyMeshData } from '../../utils/eyeBlinkOverlay'
import { computeAllBarycentrics } from '../../utils/barycentricUtils'
import {
  flattenClosedBezier,
  nearestOnCubicBezier,
  splitCubicBezier,
} from '../../utils/bezierUtils'

// ─── Helpers ───────────────────────────────────────────────────────────

function ensureEyes(p: Project): ProjectEyes {
  return p.projectEyes ?? { ...DEFAULT_PROJECT_EYES, regions: [] }
}

function makeEllipseNodes(cx: number, cy: number, rx: number, ry: number): BezierNode[] {
  const k = 0.5522847498307936
  const kx = rx * k, ky = ry * k
  return [
    { anchor: { x: cx + rx, y: cy }, handleIn: { x: cx + rx, y: cy - ky }, handleOut: { x: cx + rx, y: cy + ky }, smooth: true },
    { anchor: { x: cx, y: cy + ry }, handleIn: { x: cx + kx, y: cy + ry }, handleOut: { x: cx - kx, y: cy + ry }, smooth: true },
    { anchor: { x: cx - rx, y: cy }, handleIn: { x: cx - rx, y: cy + ky }, handleOut: { x: cx - rx, y: cy - ky }, smooth: true },
    { anchor: { x: cx, y: cy - ry }, handleIn: { x: cx - kx, y: cy - ry }, handleOut: { x: cx + kx, y: cy - ry }, smooth: true },
  ]
}

function polygonToCornerNodes(poly: Point2D[]): BezierNode[] {
  return poly.map(p => ({ anchor: { ...p }, handleIn: { ...p }, handleOut: { ...p }, smooth: false }))
}

function hydrateNodes(eye: EyeRegion): BezierNode[] {
  if (eye.bezierNodes && eye.bezierNodes.length >= 3) {
    return eye.bezierNodes.map(n => ({
      anchor: { ...n.anchor }, handleIn: { ...n.handleIn }, handleOut: { ...n.handleOut }, smooth: n.smooth,
    }))
  }
  const poly = eye.contourPoints ?? []
  if (poly.length < 3) return makeEllipseNodes(eye.seed?.x ?? 0, eye.seed?.y ?? 0, 30, 20)
  const target = Math.min(12, poly.length)
  const step = poly.length / target
  const sampled: Point2D[] = []
  for (let i = 0; i < target; i++) sampled.push(poly[Math.floor(i * step)])
  return polygonToCornerNodes(sampled)
}

function bboxOfNodes(nodes: BezierNode[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of nodes) {
    if (n.anchor.x < minX) minX = n.anchor.x
    if (n.anchor.y < minY) minY = n.anchor.y
    if (n.anchor.x > maxX) maxX = n.anchor.x
    if (n.anchor.y > maxY) maxY = n.anchor.y
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

function translateNodes(nodes: BezierNode[], dx: number, dy: number): BezierNode[] {
  return nodes.map(n => ({
    smooth: n.smooth,
    anchor: { x: n.anchor.x + dx, y: n.anchor.y + dy },
    handleIn: { x: n.handleIn.x + dx, y: n.handleIn.y + dy },
    handleOut: { x: n.handleOut.x + dx, y: n.handleOut.y + dy },
  }))
}

// ─── Types ─────────────────────────────────────────────────────────────

interface DraftEye {
  id: string
  nodes: BezierNode[]
}

type Tool = 'select' | 'ellipse'
type HandleKind = 'anchor' | 'in' | 'out' | 'move'

interface NodeDrag {
  eyeId: string
  nodeIdx: number
  kind: 'anchor' | 'in' | 'out'
  startImg: Point2D
  startNode: BezierNode
}

interface MoveDrag {
  eyeId: string
  startImg: Point2D
  startNodes: BezierNode[]
}

interface EllipseDrag {
  startImg: Point2D
  currentImg: Point2D
}

interface PanDrag {
  startScreen: Point2D
  startPan: Point2D
}

interface Viewport {
  zoom: number
  panX: number
  panY: number
}

// ─── Constantes ────────────────────────────────────────────────────────

const HIT_RADIUS_SCREEN = 8
const SEGMENT_HIT_RADIUS = 6
const MOVE_HANDLE_SCREEN = 14   // demi-côté du carré bouton en px écran
const MOVE_HANDLE_OFFSET = 10   // offset depuis le coin top-right de la bbox, en px écran
const ZOOM_MIN = 0.2
const ZOOM_MAX = 8

// ─── Composant ─────────────────────────────────────────────────────────

export default function EyesSection() {
  const { project, save } = useAdminContext()
  const owner = getGeometryOwner(project.animations)
  const mesh = owner?.mesh ?? null
  const hasTracking = !!mesh && mesh.trackedTriangles.length > 0
  const imageBlob = project.originalImageBlob

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [imageBitmap, setImageBitmap] = useState<HTMLImageElement | null>(null)
  const [baseScale, setBaseScale] = useState(1) // fit-to-container
  const [viewport, setViewport] = useState<Viewport>({ zoom: 1, panX: 0, panY: 0 })
  const blinkRafRef = useRef<number | null>(null)
  const [blinkProgress, setBlinkProgress] = useState(0)

  const persistedEyes = ensureEyes(project)
  const [draft, setDraft] = useState<DraftEye[]>([])
  const [selectedEyeId, setSelectedEyeId] = useState<string | null>(null)
  const [selectedNodeIdx, setSelectedNodeIdx] = useState<number | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const nodeDragRef = useRef<NodeDrag | null>(null)
  const moveDragRef = useRef<MoveDrag | null>(null)
  const ellipseDragRef = useRef<EllipseDrag | null>(null)
  const panDragRef = useRef<PanDrag | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)

  // Config locale (sliders) — save Firestore debounced
  const [configLocal, setConfigLocal] = useState<ProjectEyes>(persistedEyes)
  useEffect(() => { setConfigLocal(persistedEyes) }, [project.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const saveTimerRef = useRef<number | null>(null)
  const pendingSaveRef = useRef<ProjectEyes | null>(null)
  function updateConfig(patch: Partial<ProjectEyes>) {
    setConfigLocal(prev => {
      const merged = { ...prev, ...patch }
      pendingSaveRef.current = merged
      if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        const toSave = pendingSaveRef.current
        if (!toSave) return
        save({ ...project, projectEyes: toSave }).catch(() => { /* swallow */ })
      }, 250)
      return merged
    })
  }
  useEffect(() => () => { if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current) }, [])

  // Hydrate
  useEffect(() => {
    const hydrated: DraftEye[] = persistedEyes.regions.map(r => ({ id: r.id, nodes: hydrateNodes(r) }))
    setDraft(hydrated)
    setDirty(false)
    setSelectedEyeId(hydrated[0]?.id ?? null)
    setSelectedNodeIdx(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, persistedEyes.regions.length])

  // Image
  useEffect(() => {
    if (!imageBlob) { setImageBitmap(null); return }
    const url = URL.createObjectURL(imageBlob)
    const img = new Image()
    img.onload = () => setImageBitmap(img)
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [imageBlob])

  // Canvas size + fit
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageBitmap) return
    const container = containerRef.current
    const maxW = container ? container.clientWidth - 32 : 800
    const s = Math.min(1, maxW / imageBitmap.naturalWidth)
    canvas.width = Math.round(imageBitmap.naturalWidth * s)
    canvas.height = Math.round(imageBitmap.naturalHeight * s)
    setBaseScale(s)
    setViewport({ zoom: 1, panX: 0, panY: 0 })
  }, [imageBitmap])

  // Effective image→screen scale
  const k = baseScale * viewport.zoom

  // ─── Coords ──────────────────────────────────────────────────────────

  const screenToImage = useCallback((ev: { clientX: number; clientY: number }): Point2D => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    // rect peut être CSS-scalé : on convertit d'abord en coord canvas buffer.
    const bx = (ev.clientX - rect.left) * (canvas.width / rect.width)
    const by = (ev.clientY - rect.top) * (canvas.height / rect.height)
    return { x: (bx - viewport.panX) / k, y: (by - viewport.panY) / k }
  }, [k, viewport.panX, viewport.panY])

  /** Position du handle "move" d'une ellipse en coords IMAGE (centre du carré). */
  const moveHandlePos = useCallback((nodes: BezierNode[]): Point2D => {
    const bb = bboxOfNodes(nodes)
    return { x: bb.maxX + (MOVE_HANDLE_OFFSET + MOVE_HANDLE_SCREEN) / k, y: bb.minY - (MOVE_HANDLE_OFFSET + MOVE_HANDLE_SCREEN) / k }
  }, [k])

  // ─── Draw ────────────────────────────────────────────────────────────

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageBitmap) return
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(k, 0, 0, k, viewport.panX, viewport.panY)
    ctx.drawImage(imageBitmap, 0, 0, imageBitmap.naturalWidth, imageBitmap.naturalHeight)

    const lw2 = 2 / k
    const lw1 = 1 / k
    const lw15 = 1.5 / k

    for (const eye of draft) {
      const isSel = eye.id === selectedEyeId
      const nodes = eye.nodes
      if (nodes.length < 2) continue

      ctx.beginPath()
      ctx.moveTo(nodes[0].anchor.x, nodes[0].anchor.y)
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        const b = nodes[(i + 1) % nodes.length]
        ctx.bezierCurveTo(a.handleOut.x, a.handleOut.y, b.handleIn.x, b.handleIn.y, b.anchor.x, b.anchor.y)
      }
      ctx.closePath()
      ctx.fillStyle = isSel ? 'rgba(10,108,255,0.18)' : 'rgba(120,120,120,0.12)'
      ctx.strokeStyle = isSel ? '#0a6cff' : '#888'
      ctx.lineWidth = lw2
      ctx.fill()
      ctx.stroke()

      if (blinkProgress > 0.001) {
        let minY = Infinity, maxY = -Infinity
        for (const p of flattenClosedBezier(nodes, 16)) {
          if (p.y < minY) minY = p.y
          if (p.y > maxY) maxY = p.y
        }
        const half = (maxY - minY) * (blinkProgress / 2)
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(nodes[0].anchor.x, nodes[0].anchor.y)
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]
          const b = nodes[(i + 1) % nodes.length]
          ctx.bezierCurveTo(a.handleOut.x, a.handleOut.y, b.handleIn.x, b.handleIn.y, b.anchor.x, b.anchor.y)
        }
        ctx.closePath()
        ctx.clip()
        ctx.fillStyle = '#000'
        // Rectangles plein-canvas (en coord image transformée) : on inverse les bornes.
        const bigPx = (Math.max(canvas.width, canvas.height) + Math.max(viewport.panX, viewport.panY, 0)) / k + 1e4
        ctx.fillRect(-bigPx, -bigPx, 2 * bigPx, minY + half - (-bigPx))
        ctx.fillRect(-bigPx, maxY - half, 2 * bigPx, bigPx - (maxY - half))
        ctx.restore()
      }

      // Anchors + handles
      if (isSel) {
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]
          if (n.smooth) {
            ctx.strokeStyle = '#0a6cff80'
            ctx.lineWidth = lw1
            ctx.beginPath()
            ctx.moveTo(n.handleIn.x, n.handleIn.y)
            ctx.lineTo(n.anchor.x, n.anchor.y)
            ctx.lineTo(n.handleOut.x, n.handleOut.y)
            ctx.stroke()
            for (const h of [n.handleIn, n.handleOut]) {
              ctx.beginPath()
              ctx.arc(h.x, h.y, 3 / k, 0, Math.PI * 2)
              ctx.fillStyle = '#fff'
              ctx.fill()
              ctx.strokeStyle = '#0a6cff'
              ctx.lineWidth = lw15
              ctx.stroke()
            }
          }
          ctx.beginPath()
          ctx.arc(n.anchor.x, n.anchor.y, (i === selectedNodeIdx ? 6 : 4) / k, 0, Math.PI * 2)
          ctx.fillStyle = i === selectedNodeIdx ? '#ff3b3b' : '#0a6cff'
          ctx.fill()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = lw15
          ctx.stroke()
        }
      }

      // Move handle (carré ⤧ top-right) — toujours visible
      const mh = moveHandlePos(nodes)
      const half = MOVE_HANDLE_SCREEN / k
      ctx.save()
      ctx.fillStyle = isSel ? '#0a6cff' : '#666'
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = lw15
      ctx.beginPath()
      // rounded rect
      const r = 3 / k
      const x0 = mh.x - half, y0 = mh.y - half, w = half * 2, h = half * 2
      ctx.moveTo(x0 + r, y0)
      ctx.lineTo(x0 + w - r, y0)
      ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r)
      ctx.lineTo(x0 + w, y0 + h - r)
      ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h)
      ctx.lineTo(x0 + r, y0 + h)
      ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r)
      ctx.lineTo(x0, y0 + r)
      ctx.quadraticCurveTo(x0, y0, x0 + r, y0)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      // croix flèches "⤧"
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5 / k
      const arm = half * 0.55
      ctx.beginPath()
      ctx.moveTo(mh.x - arm, mh.y); ctx.lineTo(mh.x + arm, mh.y)
      ctx.moveTo(mh.x, mh.y - arm); ctx.lineTo(mh.x, mh.y + arm)
      // têtes de flèche
      const a = arm * 0.4
      ctx.moveTo(mh.x - arm, mh.y); ctx.lineTo(mh.x - arm + a, mh.y - a)
      ctx.moveTo(mh.x - arm, mh.y); ctx.lineTo(mh.x - arm + a, mh.y + a)
      ctx.moveTo(mh.x + arm, mh.y); ctx.lineTo(mh.x + arm - a, mh.y - a)
      ctx.moveTo(mh.x + arm, mh.y); ctx.lineTo(mh.x + arm - a, mh.y + a)
      ctx.moveTo(mh.x, mh.y - arm); ctx.lineTo(mh.x - a, mh.y - arm + a)
      ctx.moveTo(mh.x, mh.y - arm); ctx.lineTo(mh.x + a, mh.y - arm + a)
      ctx.moveTo(mh.x, mh.y + arm); ctx.lineTo(mh.x - a, mh.y + arm - a)
      ctx.moveTo(mh.x, mh.y + arm); ctx.lineTo(mh.x + a, mh.y + arm - a)
      ctx.stroke()
      ctx.restore()
    }

    // Ellipse drag preview
    const ed = ellipseDragRef.current
    if (ed) {
      const x1 = Math.min(ed.startImg.x, ed.currentImg.x)
      const y1 = Math.min(ed.startImg.y, ed.currentImg.y)
      const x2 = Math.max(ed.startImg.x, ed.currentImg.x)
      const y2 = Math.max(ed.startImg.y, ed.currentImg.y)
      ctx.save()
      ctx.strokeStyle = '#0a6cff'
      ctx.lineWidth = 1.5 / k
      ctx.setLineDash([6 / k, 4 / k])
      ctx.beginPath()
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }, [imageBitmap, draft, selectedEyeId, selectedNodeIdx, k, viewport.panX, viewport.panY, blinkProgress, moveHandlePos])

  useEffect(() => { redraw() }, [redraw])

  // ─── Hit testing ─────────────────────────────────────────────────────

  const hitTestMoveHandle = useCallback((imgPt: Point2D): string | null => {
    const half = MOVE_HANDLE_SCREEN / k
    // Eye sélectionné d'abord
    const order = [...draft].sort(a => a.id === selectedEyeId ? -1 : 1)
    for (const eye of order) {
      const mh = moveHandlePos(eye.nodes)
      if (Math.abs(imgPt.x - mh.x) <= half && Math.abs(imgPt.y - mh.y) <= half) return eye.id
    }
    return null
  }, [draft, selectedEyeId, k, moveHandlePos])

  const hitTestNode = useCallback((imgPt: Point2D): { eyeId: string; nodeIdx: number; kind: 'anchor' | 'in' | 'out' } | null => {
    const r = HIT_RADIUS_SCREEN / k
    const order = [...draft].sort(a => a.id === selectedEyeId ? -1 : 1)
    for (const eye of order) {
      for (let i = 0; i < eye.nodes.length; i++) {
        const n = eye.nodes[i]
        if (eye.id === selectedEyeId && n.smooth) {
          if (Math.hypot(n.handleIn.x - imgPt.x, n.handleIn.y - imgPt.y) < r) return { eyeId: eye.id, nodeIdx: i, kind: 'in' }
          if (Math.hypot(n.handleOut.x - imgPt.x, n.handleOut.y - imgPt.y) < r) return { eyeId: eye.id, nodeIdx: i, kind: 'out' }
        }
        if (Math.hypot(n.anchor.x - imgPt.x, n.anchor.y - imgPt.y) < r) return { eyeId: eye.id, nodeIdx: i, kind: 'anchor' }
      }
    }
    return null
  }, [draft, selectedEyeId, k])

  const hitTestSegment = useCallback((imgPt: Point2D): { nodeIdx: number; t: number } | null => {
    const eye = draft.find(e => e.id === selectedEyeId)
    if (!eye) return null
    const r = SEGMENT_HIT_RADIUS / k
    let best: { nodeIdx: number; t: number; dist: number } | null = null
    for (let i = 0; i < eye.nodes.length; i++) {
      const a = eye.nodes[i]
      const b = eye.nodes[(i + 1) % eye.nodes.length]
      const res = nearestOnCubicBezier(a.anchor, a.handleOut, b.handleIn, b.anchor, imgPt)
      if (res.dist < r && (!best || res.dist < best.dist)) best = { nodeIdx: i, t: res.t, dist: res.dist }
    }
    return best ? { nodeIdx: best.nodeIdx, t: best.t } : null
  }, [draft, selectedEyeId, k])

  // ─── Mutations ───────────────────────────────────────────────────────

  const mutateEye = useCallback((eyeId: string, fn: (nodes: BezierNode[]) => BezierNode[]) => {
    setDraft(prev => prev.map(e => e.id === eyeId ? { ...e, nodes: fn(e.nodes) } : e))
    setDirty(true)
  }, [])

  const insertNodeOnSegment = useCallback((eyeId: string, nodeIdx: number, t: number) => {
    mutateEye(eyeId, nodes => {
      const a = nodes[nodeIdx]
      const b = nodes[(nodeIdx + 1) % nodes.length]
      const { left, right } = splitCubicBezier(a.anchor, a.handleOut, b.handleIn, b.anchor, t)
      const newNodes = nodes.map(n => ({
        anchor: { ...n.anchor }, handleIn: { ...n.handleIn }, handleOut: { ...n.handleOut }, smooth: n.smooth,
      }))
      newNodes[nodeIdx] = { ...newNodes[nodeIdx], handleOut: left[1] }
      const bIdx = (nodeIdx + 1) % nodes.length
      newNodes[bIdx] = { ...newNodes[bIdx], handleIn: right[2] }
      newNodes.splice(nodeIdx + 1, 0, { anchor: left[3], handleIn: left[2], handleOut: right[1], smooth: true })
      return newNodes
    })
    setSelectedNodeIdx(nodeIdx + 1)
  }, [mutateEye])

  const toggleSmooth = useCallback((eyeId: string, nodeIdx: number) => {
    mutateEye(eyeId, nodes => nodes.map((n, i) => {
      if (i !== nodeIdx) return n
      if (n.smooth) return { ...n, smooth: false, handleIn: { ...n.anchor }, handleOut: { ...n.anchor } }
      const prev = nodes[(i - 1 + nodes.length) % nodes.length].anchor
      const next = nodes[(i + 1) % nodes.length].anchor
      const dx = next.x - prev.x, dy = next.y - prev.y
      const len = Math.hypot(dx, dy) || 1
      const tx = dx / len, ty = dy / len
      const dPrev = Math.hypot(n.anchor.x - prev.x, n.anchor.y - prev.y) / 3
      const dNext = Math.hypot(next.x - n.anchor.x, next.y - n.anchor.y) / 3
      return { ...n, smooth: true,
        handleIn: { x: n.anchor.x - tx * dPrev, y: n.anchor.y - ty * dPrev },
        handleOut: { x: n.anchor.x + tx * dNext, y: n.anchor.y + ty * dNext } }
    }))
  }, [mutateEye])

  const deleteSelectedNode = useCallback(() => {
    if (!selectedEyeId || selectedNodeIdx == null) return
    mutateEye(selectedEyeId, nodes => nodes.length <= 3 ? nodes : nodes.filter((_, i) => i !== selectedNodeIdx))
    setSelectedNodeIdx(null)
  }, [selectedEyeId, selectedNodeIdx, mutateEye])

  const addEllipseEye = useCallback((bbox: { x: number; y: number; w: number; h: number }) => {
    const rx = Math.max(8, bbox.w / 2)
    const ry = Math.max(6, bbox.h / 2)
    const id = crypto.randomUUID()
    setDraft(prev => [...prev, { id, nodes: makeEllipseNodes(bbox.x + bbox.w / 2, bbox.y + bbox.h / 2, rx, ry) }])
    setSelectedEyeId(id)
    setSelectedNodeIdx(null)
    setDirty(true)
    setTool('select')
  }, [])

  const deleteEye = useCallback((id: string) => {
    setDraft(prev => prev.filter(e => e.id !== id))
    if (selectedEyeId === id) { setSelectedEyeId(null); setSelectedNodeIdx(null) }
    setDirty(true)
  }, [selectedEyeId])

  // ─── Pan/Zoom ────────────────────────────────────────────────────────

  const resetView = useCallback(() => {
    setViewport({ zoom: 1, panX: 0, panY: 0 })
  }, [])

  const onWheel = useCallback((ev: React.WheelEvent<HTMLCanvasElement>) => {
    ev.preventDefault()
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const bx = (ev.clientX - rect.left) * (canvas.width / rect.width)
    const by = (ev.clientY - rect.top) * (canvas.height / rect.height)
    setViewport(v => {
      const factor = Math.exp(-ev.deltaY * 0.0015)
      const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor))
      const newK = baseScale * newZoom
      const oldK = baseScale * v.zoom
      // Anchor cursor : (bx - panX) / oldK == (bx - newPanX) / newK
      const imgX = (bx - v.panX) / oldK
      const imgY = (by - v.panY) / oldK
      return { zoom: newZoom, panX: bx - imgX * newK, panY: by - imgY * newK }
    })
  }, [baseScale])

  // wheel listener doit être non-passif pour preventDefault
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handler = (ev: WheelEvent) => {
      ev.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const bx = (ev.clientX - rect.left) * (canvas.width / rect.width)
      const by = (ev.clientY - rect.top) * (canvas.height / rect.height)
      setViewport(v => {
        const factor = Math.exp(-ev.deltaY * 0.0015)
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor))
        const newK = baseScale * newZoom
        const oldK = baseScale * v.zoom
        const imgX = (bx - v.panX) / oldK
        const imgY = (by - v.panY) / oldK
        return { zoom: newZoom, panX: bx - imgX * newK, panY: by - imgY * newK }
      })
    }
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [baseScale])

  // ─── Pointer events ──────────────────────────────────────────────────

  function onPointerDown(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!imageBitmap) return
    ;(ev.target as HTMLCanvasElement).setPointerCapture(ev.pointerId)

    // Pan : bouton du milieu OU alt+clic OU espace+clic
    const isPan = ev.button === 1 || (ev.button === 0 && (ev.altKey || spaceDown))
    if (isPan) {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const bx = (ev.clientX - rect.left) * (canvas.width / rect.width)
      const by = (ev.clientY - rect.top) * (canvas.height / rect.height)
      panDragRef.current = { startScreen: { x: bx, y: by }, startPan: { x: viewport.panX, y: viewport.panY } }
      return
    }
    if (ev.button !== 0) return

    const imgPt = screenToImage(ev)

    if (tool === 'ellipse') {
      ellipseDragRef.current = { startImg: imgPt, currentImg: imgPt }
      redraw()
      return
    }

    // Move handle (toujours prioritaire sur node hit)
    const mhEye = hitTestMoveHandle(imgPt)
    if (mhEye) {
      setSelectedEyeId(mhEye)
      setSelectedNodeIdx(null)
      const eye = draft.find(e => e.id === mhEye)!
      moveDragRef.current = {
        eyeId: mhEye,
        startImg: imgPt,
        startNodes: eye.nodes.map(n => ({
          smooth: n.smooth, anchor: { ...n.anchor }, handleIn: { ...n.handleIn }, handleOut: { ...n.handleOut },
        })),
      }
      return
    }

    const hit = hitTestNode(imgPt)
    if (hit) {
      setSelectedEyeId(hit.eyeId)
      const eye = draft.find(e => e.id === hit.eyeId)!
      setSelectedNodeIdx(hit.kind === 'anchor' ? hit.nodeIdx : null)
      nodeDragRef.current = {
        eyeId: hit.eyeId, nodeIdx: hit.nodeIdx, kind: hit.kind, startImg: imgPt,
        startNode: { ...eye.nodes[hit.nodeIdx], anchor: { ...eye.nodes[hit.nodeIdx].anchor },
          handleIn: { ...eye.nodes[hit.nodeIdx].handleIn }, handleOut: { ...eye.nodes[hit.nodeIdx].handleOut } },
      }
      return
    }

    // Sélection : œil contenant le clic
    let hitEyeId: string | null = null
    for (const eye of draft) {
      const poly = flattenClosedBezier(eye.nodes, 16)
      if (pointInPolygon(imgPt, poly)) { hitEyeId = eye.id; break }
    }
    setSelectedEyeId(hitEyeId)
    setSelectedNodeIdx(null)
  }

  function onPointerMove(ev: React.PointerEvent<HTMLCanvasElement>) {
    if (!imageBitmap) return

    // Pan
    const pd = panDragRef.current
    if (pd) {
      const canvas = canvasRef.current!
      const rect = canvas.getBoundingClientRect()
      const bx = (ev.clientX - rect.left) * (canvas.width / rect.width)
      const by = (ev.clientY - rect.top) * (canvas.height / rect.height)
      setViewport(v => ({ ...v, panX: pd.startPan.x + (bx - pd.startScreen.x), panY: pd.startPan.y + (by - pd.startScreen.y) }))
      return
    }

    const imgPt = screenToImage(ev)

    if (ellipseDragRef.current) {
      ellipseDragRef.current.currentImg = imgPt
      redraw()
      return
    }

    const md = moveDragRef.current
    if (md) {
      const dx = imgPt.x - md.startImg.x
      const dy = imgPt.y - md.startImg.y
      setDraft(prev => prev.map(e => e.id === md.eyeId ? { ...e, nodes: translateNodes(md.startNodes, dx, dy) } : e))
      setDirty(true)
      return
    }

    const d = nodeDragRef.current
    if (!d) return
    const dx = imgPt.x - d.startImg.x
    const dy = imgPt.y - d.startImg.y
    mutateEye(d.eyeId, nodes => nodes.map((n, i) => {
      if (i !== d.nodeIdx) return n
      if (d.kind === 'anchor') {
        return { ...n,
          anchor: { x: d.startNode.anchor.x + dx, y: d.startNode.anchor.y + dy },
          handleIn: { x: d.startNode.handleIn.x + dx, y: d.startNode.handleIn.y + dy },
          handleOut: { x: d.startNode.handleOut.x + dx, y: d.startNode.handleOut.y + dy } }
      }
      if (d.kind === 'in') {
        const newIn = { x: d.startNode.handleIn.x + dx, y: d.startNode.handleIn.y + dy }
        if (n.smooth) {
          const ox = n.anchor.x - newIn.x, oy = n.anchor.y - newIn.y
          return { ...n, handleIn: newIn, handleOut: { x: n.anchor.x + ox, y: n.anchor.y + oy } }
        }
        return { ...n, handleIn: newIn }
      }
      const newOut = { x: d.startNode.handleOut.x + dx, y: d.startNode.handleOut.y + dy }
      if (n.smooth) {
        const ox = n.anchor.x - newOut.x, oy = n.anchor.y - newOut.y
        return { ...n, handleOut: newOut, handleIn: { x: n.anchor.x + ox, y: n.anchor.y + oy } }
      }
      return { ...n, handleOut: newOut }
    }))
  }

  function onPointerUp() {
    if (ellipseDragRef.current) {
      const ed = ellipseDragRef.current
      ellipseDragRef.current = null
      const x = Math.min(ed.startImg.x, ed.currentImg.x)
      const y = Math.min(ed.startImg.y, ed.currentImg.y)
      const w = Math.abs(ed.currentImg.x - ed.startImg.x)
      const h = Math.abs(ed.currentImg.y - ed.startImg.y)
      if (w > 8 && h > 6) addEllipseEye({ x, y, w, h })
      else redraw()
    }
    nodeDragRef.current = null
    moveDragRef.current = null
    panDragRef.current = null
  }

  function onDoubleClick(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (!imageBitmap || tool === 'ellipse') return
    const imgPt = screenToImage(ev)
    if (hitTestMoveHandle(imgPt)) return
    const hit = hitTestNode(imgPt)
    if (hit && hit.kind === 'anchor') { toggleSmooth(hit.eyeId, hit.nodeIdx); return }
    const seg = hitTestSegment(imgPt)
    if (seg && selectedEyeId) insertNodeOnSegment(selectedEyeId, seg.nodeIdx, seg.t)
  }

  // ─── Keyboard ────────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedNodeIdx != null) {
        const tag = (ev.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        ev.preventDefault()
        deleteSelectedNode()
      }
      if (ev.key === 'Escape') { setSelectedNodeIdx(null); setTool('select') }
      if (ev.key === '0' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); resetView() }
      if (ev.code === 'Space' && !ev.repeat) {
        const tag = (ev.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        ev.preventDefault()
        setSpaceDown(true)
      }
    }
    function onKeyUp(ev: KeyboardEvent) {
      if (ev.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [selectedNodeIdx, deleteSelectedNode, resetView])

  // ─── Blink test ──────────────────────────────────────────────────────

  const testBlink = useCallback(() => {
    if (blinkRafRef.current != null) cancelAnimationFrame(blinkRafRef.current)
    const halfMs = configLocal.blinkDurationMs / 2
    const start = performance.now()
    const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    const tick = (now: number) => {
      const elapsed = now - start
      let progress = 0
      if (elapsed < halfMs) progress = ease(elapsed / halfMs)
      else if (elapsed < halfMs * 2) progress = 1 - ease((elapsed - halfMs) / halfMs)
      setBlinkProgress(progress)
      if (elapsed < halfMs * 2) blinkRafRef.current = requestAnimationFrame(tick)
      else { blinkRafRef.current = null; setBlinkProgress(0) }
    }
    blinkRafRef.current = requestAnimationFrame(tick)
  }, [configLocal.blinkDurationMs])

  useEffect(() => () => { if (blinkRafRef.current != null) cancelAnimationFrame(blinkRafRef.current) }, [])

  // ─── Validate ────────────────────────────────────────────────────────

  const buildFrame0Tracked = useMemo(() => {
    if (!mesh) return null
    const nCA = mesh.contourAnchors.length
    const nCS = mesh.contourSubdivisionPoints.length
    const nAP = mesh.anchorPoints.length
    const frames = mesh.videoFramesMesh
    return () => {
      if (frames && frames.length > 0) {
        const f0 = frames[0]
        const out: Point2D[] = []
        for (let i = 0; i < nCA; i++) out.push(f0[i])
        for (let i = 0; i < nAP; i++) out.push(f0[nCA + nCS + i])
        return out
      }
      return [...mesh.contourAnchors, ...mesh.anchorPoints]
    }
  }, [mesh])

  async function validateAll() {
    setSaving(true); setError(null)
    try {
      const bodyMesh = getEyeBodyMeshData(project)
      const trackedFrame0 = buildFrame0Tracked?.()
      const regions: EyeRegion[] = draft.map(e => {
        const contourPoints = flattenClosedBezier(e.nodes, 24)
        const bb = bboxOfNodes(e.nodes)
        const barycentricRefs = hasTracking && mesh && trackedFrame0
          ? computeAllBarycentrics(contourPoints, trackedFrame0, mesh.trackedTriangles)
          : []
        const bodyBarycentricRefs = bodyMesh
          ? computeAllBarycentrics(contourPoints, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)
          : undefined
        return { id: e.id, bezierNodes: e.nodes, contourPoints, barycentricRefs, bodyBarycentricRefs, seed: { x: bb.cx, y: bb.cy } }
      })
      const next: Project = { ...project, projectEyes: { ...ensureEyes(project), regions } }
      await save(next)
      setDirty(false)
    } catch (e) {
      setError('Échec validation : ' + (e instanceof Error ? e.message : String(e)))
    } finally { setSaving(false) }
  }


  // ─── Render ──────────────────────────────────────────────────────────

  if (!imageBlob) {
    return <div className="admin-section-disabled"><p>Importez d'abord une image de coloriage dans Paramètres.</p></div>
  }

  const selectedEye = draft.find(e => e.id === selectedEyeId) ?? null
  const selectedNode = selectedEye && selectedNodeIdx != null ? selectedEye.nodes[selectedNodeIdx] : null
  const cursor = tool === 'ellipse' ? 'crosshair' : (spaceDown ? 'grab' : (panDragRef.current ? 'grabbing' : 'default'))

  return (
    <div ref={containerRef} style={{ padding: 16 }}>
      <h2>Yeux qui clignent</h2>
      <p style={{ opacity: 0.8, fontSize: 14 }}>
        Outil <strong>Ellipse</strong> : glisser pour créer un œil. Outil <strong>Sélection</strong> : drag anchors/handles ;
        carré en haut à droite de l'œil = déplacer l'ensemble ; double-clic courbe = insérer nœud ; double-clic nœud = corner ↔ smooth ;
        Suppr = retirer. <strong>Molette</strong> = zoom, <strong>Espace + glisser</strong> (ou Alt, ou bouton du milieu) = pan.
        {hasTracking ? ' Les yeux suivront le maillage après validation.' : ' (Topologie non verrouillée.)'}
      </p>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 600px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <button className={tool === 'select' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setTool('select')}>Sélection</button>
            <button className={tool === 'ellipse' ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'} onClick={() => setTool('ellipse')}>+ Ellipse</button>
            <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>Zoom : {(viewport.zoom * 100).toFixed(0)}%</span>
            <button className="btn-secondary btn-sm" onClick={resetView}>Réinit. vue</button>
            <div style={{ flex: 1 }} />
            <button className="btn-primary btn-sm" disabled={!dirty || saving} onClick={validateAll}>
              {saving ? 'Validation…' : dirty ? 'Valider les yeux' : 'À jour'}
            </button>
          </div>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
            onContextMenu={ev => ev.preventDefault()}
            style={{ cursor, maxWidth: '100%', border: '1px solid var(--color-border,#ccc)', touchAction: 'none' }}
          />
          {error && <div style={{ marginTop: 8, color: 'var(--color-danger,#c00)' }}>{error}</div>}
          {selectedNode && (
            <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
              Nœud {selectedNodeIdx! + 1} — {selectedNode.smooth ? 'smooth' : 'corner'} (double-clic pour basculer, Suppr pour retirer)
            </div>
          )}
        </div>

        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={configLocal.blinkEnabled} onChange={e => updateConfig({ blinkEnabled: e.target.checked })} />
            <span>Activer le clignement</span>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Durée clignement (ms): <strong>{configLocal.blinkDurationMs}</strong></span>
            <input type="range" min={80} max={400} step={10} value={configLocal.blinkDurationMs}
              onChange={e => updateConfig({ blinkDurationMs: parseInt(e.target.value, 10) })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Intervalle min (ms): <strong>{configLocal.blinkIntervalMinMs}</strong></span>
            <input type="range" min={500} max={10000} step={100} value={configLocal.blinkIntervalMinMs}
              onChange={e => updateConfig({ blinkIntervalMinMs: parseInt(e.target.value, 10) })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Intervalle max (ms): <strong>{configLocal.blinkIntervalMaxMs}</strong></span>
            <input type="range" min={1000} max={15000} step={100} value={configLocal.blinkIntervalMaxMs}
              onChange={e => updateConfig({ blinkIntervalMaxMs: parseInt(e.target.value, 10) })} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Probabilité double clignement: <strong>{configLocal.doubleBlinkProbability.toFixed(2)}</strong></span>
            <input type="range" min={0} max={1} step={0.05} value={configLocal.doubleBlinkProbability}
              onChange={e => updateConfig({ doubleBlinkProbability: parseFloat(e.target.value) })} />
          </label>

          <button className="btn-primary" onClick={testBlink} disabled={draft.length === 0} style={{ marginTop: 8 }}>
            Tester le clignement
          </button>

          <div>
            <h3 style={{ margin: '8px 0' }}>Yeux ({draft.length})</h3>
            {draft.length === 0 && <div style={{ opacity: 0.6 }}>Aucun œil défini.</div>}
            {draft.map((r, i) => (
              <div key={r.id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 8px',
                  background: r.id === selectedEyeId ? 'rgba(10,108,255,0.12)' : 'transparent', borderRadius: 4, cursor: 'pointer' }}
                onClick={() => { setSelectedEyeId(r.id); setSelectedNodeIdx(null) }}>
                <span>Œil {i + 1} ({r.nodes.length} nœuds)</span>
                <button className="btn-danger btn-sm" onClick={ev => { ev.stopPropagation(); deleteEye(r.id) }}>Supprimer</button>
              </div>
            ))}
          </div>

          {dirty && <div style={{ fontSize: 12, color: '#c80', marginTop: 4 }}>Modifications non validées.</div>}
        </div>
      </div>
    </div>
  )
}

// ─── Misc geometry ─────────────────────────────────────────────────────

function pointInPolygon(pt: Point2D, poly: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    const intersect = ((yi > pt.y) !== (yj > pt.y))
      && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
