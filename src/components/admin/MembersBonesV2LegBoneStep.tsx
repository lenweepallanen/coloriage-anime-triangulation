/**
 * MembersBonesV2LegBoneStep — Step 12 "Bones Pattes" for members-bones-v2 animations.
 *
 * Handles ONLY the leg bones (pattes) part of the skeleton editor.
 * The body chain is read-only (defined in step 10, validated in sam2BodyBonesValidated).
 * Body animation must be computed first (walkBodyFrames != null).
 *
 * New feature: hip attachment to a body vertex (alternative to anchor-based hip).
 * When hipBodyVertexIndex is set, the hip position comes from walkBodyFrames[frame][index]
 * instead of being resolved via Sam2BoneEndpointRef.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type {
  Project, Animation, Point2D, SAM2Zone,
  Sam2Skeleton, Sam2LegBone, Sam2BoneEndpointRef, ElbowMode,
} from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { resolveBodyChain, resolveSkeletonFrame, computeLegRestPose, getHipBodyVertexRefs } from '../../utils/sam2BoneSolver'
import type { LegRestPose, Sam2SkeletonFrame } from '../../utils/sam2BoneSolver'
import { getMembersBonesBodyMesh } from '../../utils/membersBonesBodyMesh'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

const VIDEO_FPS = 24
const BONE_COLORS = [
  '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]

function getBoneColor(index: number): string {
  return BONE_COLORS[index % BONE_COLORS.length]
}

function makeDefaultRef(zoneId: string): Sam2BoneEndpointRef {
  return { zoneId, anchorIndexA: 0, anchorIndexB: 0, t: 0 }
}

// ─── Endpoint ref editor ────────────────────────────────────────────────
function EndpointRefEditor({
  label, value: epRef, onChange, zones, sam2ContourAnchors,
}: {
  label: string
  value: Sam2BoneEndpointRef
  onChange: (updates: Partial<Sam2BoneEndpointRef>) => void
  zones: SAM2Zone[]
  sam2ContourAnchors: Record<string, Point2D[]>
}) {
  const zoneAnchors = sam2ContourAnchors[epRef.zoneId] ?? []
  return (
    <div style={{ marginBottom: 4, fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={epRef.zoneId}
          onChange={e => onChange({ zoneId: e.target.value, anchorIndexA: 0, anchorIndexB: 0 })}
          style={{ width: 80, fontSize: 11 }}
        >
          {zones.map(z => (
            <option key={z.id} value={z.id}>{z.label}</option>
          ))}
        </select>
        <label style={{ fontSize: 11 }}>A:
          <select
            value={epRef.anchorIndexA}
            onChange={e => onChange({ anchorIndexA: Number(e.target.value) })}
            style={{ width: 45, fontSize: 11, marginLeft: 2 }}
          >
            {zoneAnchors.map((_, i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 11 }}>B:
          <select
            value={epRef.anchorIndexB}
            onChange={e => onChange({ anchorIndexB: Number(e.target.value) })}
            style={{ width: 45, fontSize: 11, marginLeft: 2 }}
          >
            {zoneAnchors.map((_, i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
        <label style={{ fontSize: 11 }}>t:
          <input
            type="number" step={0.05} value={epRef.t}
            onChange={e => onChange({ t: Number(e.target.value) })}
            style={{ width: 60, fontSize: 11, marginLeft: 2 }}
          />
        </label>
        <span style={{ fontSize: 10, color: '#888' }}>0=A, 1=B</span>
      </div>
    </div>
  )
}

const EMPTY_SET = new Set<number>()

type EditMode = 'select' | 'place-hip' | 'place-foot' | 'place-knee' | 'place-hip-vertex'

export default function MembersBonesV2LegBoneStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null

  const anchorFrames = useMemo(() => mesh?.sam2ContourAnchorFrames ?? {}, [mesh?.sam2ContourAnchorFrames])

  // Frame 0 anchors par zone, en VIDEO coords. V2 : mesh.sam2ContourAnchors (déjà video coords).
  // V3 : pas de sam2ContourAnchors → fallback sur sam2ContourAnchorFrames[zone][0] (anchors trackés frame 0).
  const sam2ContourAnchors = useMemo<Record<string, Point2D[]>>(() => {
    const v2 = mesh?.sam2ContourAnchors
    if (v2 && Object.keys(v2).length > 0) return v2
    const result: Record<string, Point2D[]> = {}
    const af = mesh?.sam2ContourAnchorFrames
    if (af) {
      for (const zoneId of Object.keys(af)) {
        const frame0 = af[zoneId]?.[0]
        if (frame0 && frame0.length > 0) result[zoneId] = frame0
      }
    }
    return result
  }, [mesh?.sam2ContourAnchors, mesh?.sam2ContourAnchorFrames])

  const totalFrames = useMemo(() => {
    if (!contoursAll) return 0
    const first = Object.values(contoursAll)[0]
    return first?.length ?? 0
  }, [contoursAll])

  // Image (project image) — used as high-res background option
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const imageRef = useRef<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = url
    return () => { URL.revokeObjectURL(url); imageRef.current = null }
  }, [project.originalImageBlob])

  // Body mesh : V2 reads from projectTriangulation, V3 from sam2 + v3 internals
  const bodyMesh = useMemo(() => {
    if (imgSize.w === 0) return null
    return getMembersBonesBodyMesh(project, animation, imgSize.w, imgSize.h)
  }, [project, animation, imgSize])
  const bodyPoints = bodyMesh?.bodyPoints ?? null
  const bodyTriangles = bodyMesh?.bodyTriangles ?? null
  // Prefer smoothed body frames for display and hip-vertex picking (propagates through to leg compute)
  const walkBodyFrames = mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null

  // Video dimensions from mesh
  const vidW = mesh?.sam2VideoWidth ?? 1
  const vidH = mesh?.sam2VideoHeight ?? 1

  // Coordinate conversion helpers (canvas is in VIDEO space)
  const imgToVid = useCallback((p: Point2D): Point2D => ({
    x: p.x * (vidW / Math.max(1, imgSize.w)),
    y: p.y * (vidH / Math.max(1, imgSize.h)),
  }), [vidW, vidH, imgSize])

  const vidToImg = useCallback((p: Point2D): Point2D => ({
    x: p.x * (Math.max(1, imgSize.w) / vidW),
    y: p.y * (Math.max(1, imgSize.h) / vidH),
  }), [vidW, vidH, imgSize])

  // Body vertex positions in VIDEO coords for current frame (for display + skeleton resolver)
  const bodyVerticesVidForFrame = useCallback((frame: number): Point2D[] | null => {
    if (!walkBodyFrames || frame >= walkBodyFrames.length) return null
    return walkBodyFrames[frame].map(imgToVid)
  }, [walkBodyFrames, imgToVid])

  // ----- Skeleton state (legs only, body chain read-only) -----
  const [skeleton, setSkeleton] = useState<Sam2Skeleton>(() => {
    const existing = mesh?.sam2Skeleton
    if (existing) return existing
    return { bodyChain: [], legs: [] }
  })
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<EditMode>('select')

  // The leg whose hip/foot/knee we're placing
  const placingLegIdRef = useRef<string | null>(null)

  // Drag state (ref to avoid re-render storms during drag)
  const draggingRef = useRef<{ type: 'knee' | 'hip-vertex'; legId: string } | null>(null)
  const didDragRef = useRef(false)

  // ----- Visibility toggles -----
  const [showImage, setShowImage] = useState(true)
  const [showVideo, setShowVideo] = useState(false)
  const [showMasks, setShowMasks] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showAnchors, setShowAnchors] = useState(true)
  const [showBody, setShowBody] = useState(true)

  // ----- Playback -----
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)

  // ----- Phase -----
  const isValidated = mesh?.sam2BonesValidated === true
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)

  // ----- Video element + canvas -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)

  // ----- Previous skeleton frame for IK continuity -----
  const prevSkeletonFrameRef = useRef<Sam2SkeletonFrame | null>(null)

  // ----- Leg rest poses (memoized) -----
  const legRestPoses = useMemo<LegRestPose[]>(() => {
    if (!skeleton.legs.length || !Object.keys(anchorFrames).length) return []
    // For legs with hipBodyVertexIndex, provide body frame 0 in VIDEO coords
    const bodyF0Vid = bodyVerticesVidForFrame(0)
    return skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames, bodyF0Vid))
  }, [skeleton.legs, anchorFrames, bodyVerticesVidForFrame])

  // ----- Combined anchor list for cross-zone snap -----
  const allAnchorsWithZone = useMemo(() => {
    const result: { zoneId: string; idx: number; pos: Point2D }[] = []
    for (const z of zones) {
      const anchors = sam2ContourAnchors[z.id] ?? []
      anchors.forEach((p, i) => result.push({ zoneId: z.id, idx: i, pos: p }))
    }
    return result
  }, [zones, sam2ContourAnchors])

  // ─── Video loading ────────────────────────────────────────────────────

  useEffect(() => {
    if (!animation.videoBlob) return
    const url = URL.createObjectURL(animation.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    const onReady = () => {
      videoRef.current = video
      setVideoSize({ w: video.videoWidth, h: video.videoHeight })
      setVideoReady(true)
    }
    video.onloadeddata = () => {
      video.currentTime = 0
      video.onseeked = onReady
      setTimeout(() => { if (!videoRef.current) onReady() }, 200)
    }
    video.load()
    return () => {
      video.pause()
      URL.revokeObjectURL(url)
      videoRef.current = null
      fittedRef.current = false
      setVideoReady(false)
    }
  }, [animation.videoBlob])

  useEffect(() => {
    // Fit canvas to SAM 2 video dims (canonical data coord space) — pas videoSize qui peut différer.
    if (!videoReady || fittedRef.current) return
    if (vidW <= 1 || vidH <= 1) return
    fitToCanvas(vidW, vidH)
    fittedRef.current = true
  }, [videoReady, vidW, vidH, fitToCanvas])

  // ─── Canvas resize ────────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Video seek on frame change ───────────────────────────────────────

  useEffect(() => {
    if (!videoReady) return
    const video = videoRef.current
    if (!video) return
    video.currentTime = currentFrame / VIDEO_FPS
  }, [currentFrame, videoReady])

  // ─── Playback interval ────────────────────────────────────────────────

  useEffect(() => {
    playingRef.current = playing
    if (!playing) return
    const interval = setInterval(() => {
      if (!playingRef.current) return
      setCurrentFrame(f => (f + 1) % Math.max(1, totalFrames))
    }, 1000 / VIDEO_FPS)
    return () => clearInterval(interval)
  }, [playing, totalFrames])

  // ─── Click-to-endpoint snap ───────────────────────────────────────────

  const clickToEndpointRef = useCallback((imgPos: Point2D): Sam2BoneEndpointRef | null => {
    if (allAnchorsWithZone.length < 2) return null
    const sorted = [...allAnchorsWithZone].sort((a, b) => {
      const da = (a.pos.x - imgPos.x) ** 2 + (a.pos.y - imgPos.y) ** 2
      const db = (b.pos.x - imgPos.x) ** 2 + (b.pos.y - imgPos.y) ** 2
      return da - db
    })
    const nearest = sorted[0]
    const second = sorted[1]

    if (nearest.zoneId !== second.zoneId) {
      return {
        zoneId: nearest.zoneId,
        anchorIndexA: nearest.idx,
        anchorIndexB: nearest.idx,
        t: 0,
      }
    }

    const a = nearest.pos
    const b = second.pos
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq < 1) {
      return {
        zoneId: nearest.zoneId,
        anchorIndexA: nearest.idx,
        anchorIndexB: nearest.idx,
        t: 0,
      }
    }
    const t = Math.max(0, Math.min(1, ((imgPos.x - a.x) * dx + (imgPos.y - a.y) * dy) / lenSq))

    return {
      zoneId: nearest.zoneId,
      anchorIndexA: nearest.idx,
      anchorIndexB: second.idx,
      t: Math.round(t * 100) / 100,
    }
  }, [allAnchorsWithZone])

  // ─── Find nearest body vertex (IMAGE coords) ─────────────────────────

  const findNearestBodyVertex = useCallback((imgPos: Point2D, frame: number): number | null => {
    // Use the ANIMATED positions at the current frame (what the user actually sees).
    // Fallback to rest bodyPoints if walkBodyFrames not yet populated for this frame.
    const pts = walkBodyFrames && frame < walkBodyFrames.length ? walkBodyFrames[frame] : bodyPoints
    if (!pts || pts.length === 0) return null
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - imgPos.x
      const dy = pts[i].y - imgPos.y
      const d = dx * dx + dy * dy
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    }
    return bestIdx
  }, [walkBodyFrames, bodyPoints])

  // ─── Knee drag (mousedown / mousemove / mouseup) ─────────────────────

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (isPanning.current || spaceDown.current) return
    if (e.button !== 0) return
    if (isValidated || !Object.keys(anchorFrames).length || totalFrames === 0) return

    const vidPos = screenToImage(e.clientX, e.clientY)
    const threshold = 10 / transformRef.current.scale

    // Resolve skeleton at current frame to get knee positions
    const bodyVidF = bodyVerticesVidForFrame(currentFrame)
    const frame = resolveSkeletonFrame(skeleton, anchorFrames, currentFrame, legRestPoses, null, bodyVidF)

    // Check hip-vertex drag: grab the FIRST vertex of the hip barycentre when present
    if (walkBodyFrames && walkBodyFrames[currentFrame]) {
      const bpts = walkBodyFrames[currentFrame]
      for (let i = 0; i < skeleton.legs.length; i++) {
        const leg = skeleton.legs[i]
        const refs = getHipBodyVertexRefs(leg)
        if (!refs || refs.indices.length === 0) continue
        const idx0 = refs.indices[0]
        if (idx0 >= bpts.length) continue
        const vp = imgToVid(bpts[idx0])
        if (Math.hypot(vidPos.x - vp.x, vidPos.y - vp.y) < threshold * 1.5) {
          draggingRef.current = { type: 'hip-vertex', legId: leg.id }
          didDragRef.current = false
          setSelectedLegId(leg.id)
          e.preventDefault()
          return
        }
      }
    }

    // Check knee drag
    for (let i = 0; i < frame.legs.length; i++) {
      const knee = frame.legs[i].knee
      if (Math.hypot(vidPos.x - knee.x, vidPos.y - knee.y) < threshold) {
        draggingRef.current = { type: 'knee', legId: skeleton.legs[i].id }
        didDragRef.current = false
        setSelectedLegId(skeleton.legs[i].id)
        e.preventDefault()
        return
      }
    }
  }, [isValidated, screenToImage, transformRef, skeleton, anchorFrames, totalFrames, legRestPoses, currentFrame, bodyVerticesVidForFrame, walkBodyFrames, imgToVid, isPanning, spaceDown])

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = draggingRef.current
    if (!drag) return
    didDragRef.current = true
    const vidPos = screenToImage(e.clientX, e.clientY)
    const legId = drag.legId
    if (drag.type === 'knee') {
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => l.id === legId ? { ...l, kneeRestPos: vidPos } : l),
      }))
    } else if (drag.type === 'hip-vertex') {
      const imgPos = vidToImg(vidPos)
      const vertexIdx = findNearestBodyVertex(imgPos, currentFrame)
      if (vertexIdx == null) return
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => l.id === legId ? {
          ...l,
          hipMode: 'body-vertex' as const,
          hipBodyVertexIndex: vertexIdx,
          hipBodyVertexIndices: null,
          hipBodyVertexWeights: null,
        } : l),
      }))
    }
  }, [screenToImage, vidToImg, findNearestBodyVertex, currentFrame])

  const handleCanvasMouseUp = useCallback(() => {
    draggingRef.current = null
  }, [])

  // ─── Canvas click handler ─────────────────────────────────────────────

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning.current || spaceDown.current) return
    if (didDragRef.current) { didDragRef.current = false; return }
    if (editMode === 'select') return

    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cssX = e.clientX - rect.left
    const cssY = e.clientY - rect.top
    // screenToImage returns video coords (canvas is in video space)
    const vidPos = screenToImage(cssX, cssY)

    if (editMode === 'place-hip' || editMode === 'place-foot') {
      const ref = clickToEndpointRef(vidPos)
      if (!ref) return
      const legId = placingLegIdRef.current
      if (!legId) return
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => {
          if (l.id !== legId) return l
          if (editMode === 'place-hip') {
            return {
              ...l, hip: ref,
              hipMode: 'anchor' as const,
              hipBodyVertexIndex: null,
              hipBodyVertexIndices: null,
              hipBodyVertexWeights: null,
            }
          }
          return { ...l, foot: ref }
        }),
      }))
      setEditMode('select')
    }

    if (editMode === 'place-knee') {
      const legId = placingLegIdRef.current
      if (!legId) return
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => l.id === legId ? { ...l, kneeRestPos: vidPos } : l),
      }))
      setEditMode('select')
    }

    if (editMode === 'place-hip-vertex') {
      const legId = placingLegIdRef.current
      if (!legId) return
      const imgPos = vidToImg(vidPos)
      const vertexIdx = findNearestBodyVertex(imgPos, currentFrame)
      if (vertexIdx == null) return
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => l.id === legId ? {
          ...l,
          hipMode: 'body-vertex' as const,
          hipBodyVertexIndex: vertexIdx,
          hipBodyVertexIndices: null,
          hipBodyVertexWeights: null,
        } : l),
      }))
      setEditMode('select')
    }
  }, [editMode, screenToImage, clickToEndpointRef, vidToImg, findNearestBodyVertex, currentFrame, isPanning, spaceDown])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
  }, [])

  // ─── Draw loop ────────────────────────────────────────────────────────

  useEffect(() => {
    let running = true
    let rafId = 0
    function draw() {
      if (!running) return
      // Toujours rescheduler en début pour que toute exception interne ne tue pas la rAF chain.
      rafId = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return
      if (canvas.width === 0 || canvas.height === 0) return
      try {
        drawFrame(canvas)
      } catch (err) {
        console.error('[V3-LegBone] draw error:', err)
      }
    }
    function drawFrame(canvas: HTMLCanvasElement) {
      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr
      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)

      // 1a. Image projet (haute res) — bypass canvas transform pour rendu net
      // L'image est rendue directement en pixels canvas pour éviter le downsampling
      // que ferait drawImage si la dest était dans l'espace transformé video coords.
      const img = imageRef.current
      const dw = vidW * t.scale
      const dh = vidH * t.scale
      if (showImage && img && imgSize.w > 0 && dw > 0 && dh > 0) {
        ctx.save()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.drawImage(img, t.offsetX, t.offsetY, dw, dh)
        ctx.restore()
      }

      // 1b. Video frame (overlay si toggled, sinon image seule sert de fond)
      // Stretched to vidW × vidH (canonical SAM 2 coord space) pour s'aligner avec les overlays.
      const video = videoRef.current
      if (showVideo && video && videoReady && vidW > 0 && vidH > 0) {
        ctx.drawImage(video, 0, 0, vidW, vidH)
      }

      // 2. Zone contours (smoothed contours, video coords)
      if (showMasks && contoursAll) {
        const safeF = Math.max(0, Math.min(totalFrames - 1, currentFrame))
        for (const z of zones) {
          const contour = contoursAll[z.id]?.[safeF]
          if (!contour || contour.length < 3) continue
          ctx.globalAlpha = 0.25
          ctx.fillStyle = z.color
          ctx.strokeStyle = z.color
          ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath()
          ctx.moveTo(contour[0].x, contour[0].y)
          for (let i = 1; i < contour.length; i++) {
            ctx.lineTo(contour[i].x, contour[i].y)
          }
          ctx.closePath()
          ctx.fill()
          ctx.globalAlpha = 0.6
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }

      // 3. Body mesh wireframe (image coords -> video coords for display)
      if (showBody && bodyTriangles && walkBodyFrames) {
        const safeF = Math.max(0, Math.min((walkBodyFrames.length || 1) - 1, currentFrame))
        const bpts = walkBodyFrames[safeF]
        if (bpts) {
          ctx.strokeStyle = '#22c55e'
          ctx.lineWidth = 0.5 / t.scale
          ctx.globalAlpha = 0.4
          for (const [ia, ib, ic] of bodyTriangles) {
            if (ia >= bpts.length || ib >= bpts.length || ic >= bpts.length) continue
            const a = imgToVid(bpts[ia])
            const b = imgToVid(bpts[ib])
            const c = imgToVid(bpts[ic])
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.lineTo(c.x, c.y)
            ctx.closePath()
            ctx.stroke()
          }
          ctx.globalAlpha = 1

          // Body vertices as clickable dots — enlarged when placing a body-vertex hip
          const placing = editMode === 'place-hip-vertex'
          const vr = (placing ? 3 : 1.8) / t.scale
          ctx.fillStyle = placing ? '#fbbf24' : '#22c55e'
          ctx.globalAlpha = placing ? 1 : 0.7
          for (const p of bpts) {
            const v = imgToVid(p)
            ctx.beginPath()
            ctx.arc(v.x, v.y, vr, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
        }
      }

      // 4. Body chain skeleton read-only (white segments + joints)
      if (showSkeleton && skeleton.bodyChain.length >= 2) {
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        const hasFrames = Object.keys(anchorFrames).length > 0
        if (hasFrames && totalFrames > 0) {
          const bodyJoints = resolveBodyChain(skeleton.bodyChain, anchorFrames, safeFrame)
          const lineW = 2 / t.scale
          const jointR = 4 / t.scale

          // Segments
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = lineW
          ctx.globalAlpha = 0.6
          for (let i = 0; i < bodyJoints.length - 1; i++) {
            const a = bodyJoints[i]
            const b = bodyJoints[i + 1]
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
          // Joints
          for (const j of bodyJoints) {
            ctx.fillStyle = '#ffffff'
            ctx.beginPath()
            ctx.arc(j.x, j.y, jointR, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.globalAlpha = 1
        }
      }

      // 5. Leg bones
      if (showSkeleton && skeleton.legs.length > 0) {
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        const hasFrames = Object.keys(anchorFrames).length > 0
        if (hasFrames && totalFrames > 0) {
          const bodyVidF = bodyVerticesVidForFrame(safeFrame)
          const frame = resolveSkeletonFrame(skeleton, anchorFrames, safeFrame, legRestPoses, prevSkeletonFrameRef.current, bodyVidF)
          prevSkeletonFrameRef.current = frame

          const lineW = 3 / t.scale
          const jointR = 5 / t.scale

          for (let li = 0; li < frame.legs.length; li++) {
            const leg = frame.legs[li]
            const color = getBoneColor(li)
            const isSelected = skeleton.legs[li]?.id === selectedLegId

            // Hip -> Knee
            ctx.strokeStyle = color
            ctx.lineWidth = isSelected ? lineW * 1.5 : lineW
            ctx.beginPath()
            ctx.moveTo(leg.hip.x, leg.hip.y)
            ctx.lineTo(leg.knee.x, leg.knee.y)
            ctx.stroke()

            // Knee -> Foot
            ctx.beginPath()
            ctx.moveTo(leg.knee.x, leg.knee.y)
            ctx.lineTo(leg.foot.x, leg.foot.y)
            ctx.stroke()

            // Hip circle
            ctx.fillStyle = color
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.5 / t.scale
            ctx.beginPath()
            ctx.arc(leg.hip.x, leg.hip.y, jointR, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()

            // Foot diamond
            const dr = jointR * 1.2
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.moveTo(leg.foot.x, leg.foot.y - dr)
            ctx.lineTo(leg.foot.x + dr, leg.foot.y)
            ctx.lineTo(leg.foot.x, leg.foot.y + dr)
            ctx.lineTo(leg.foot.x - dr, leg.foot.y)
            ctx.closePath()
            ctx.fill()
            ctx.stroke()

            // Knee square (yellow)
            const kr = jointR * 1.1
            ctx.fillStyle = '#fbbf24'
            ctx.strokeStyle = '#fff'
            ctx.fillRect(leg.knee.x - kr, leg.knee.y - kr, kr * 2, kr * 2)
            ctx.strokeRect(leg.knee.x - kr, leg.knee.y - kr, kr * 2, kr * 2)

            // Label
            const name = skeleton.legs[li]?.name ?? ''
            if (name) {
              ctx.fillStyle = '#fff'
              ctx.font = `${11 / t.scale}px sans-serif`
              ctx.fillText(name, leg.knee.x + kr * 2, leg.knee.y)
            }

            // 6. Body vertex highlights for hip (1-3 vertices barycentre)
            const refsLi = getHipBodyVertexRefs(skeleton.legs[li])
            if (refsLi && walkBodyFrames) {
              const safeF2 = Math.max(0, Math.min((walkBodyFrames.length || 1) - 1, currentFrame))
              const bpts = walkBodyFrames[safeF2]
              if (bpts) {
                ctx.strokeStyle = color
                ctx.lineWidth = 2 / t.scale
                ctx.setLineDash([])
                for (const vIdx of refsLi.indices) {
                  if (vIdx >= bpts.length) continue
                  const vp = imgToVid(bpts[vIdx])
                  ctx.beginPath()
                  ctx.arc(vp.x, vp.y, jointR * 1.8, 0, Math.PI * 2)
                  ctx.stroke()
                }
                // Dashed ring around the resolved hip
                ctx.setLineDash([3 / t.scale, 3 / t.scale])
                ctx.beginPath()
                ctx.arc(leg.hip.x, leg.hip.y, jointR * 2.4, 0, Math.PI * 2)
                ctx.stroke()
                ctx.setLineDash([])
              }
            }
          }
        }
      }

      // 7. Anchor points (tracked frame by frame)
      if (showAnchors) {
        const safeF = Math.max(0, Math.min(totalFrames - 1, currentFrame))
        for (const z of zones) {
          const anchors = anchorFrames[z.id]?.[safeF] ?? sam2ContourAnchors[z.id]
          if (!anchors) continue
          ctx.fillStyle = z.color
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1 / t.scale
          const r = 3 / t.scale
          for (let i = 0; i < anchors.length; i++) {
            const p = anchors[i]
            ctx.beginPath()
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
            ctx.fillStyle = '#fff'
            ctx.font = `${9 / t.scale}px sans-serif`
            ctx.fillText(i === 0 ? 'P0' : `${i}`, p.x + r * 2, p.y - r)
            ctx.fillStyle = z.color
          }
        }
      }

      ctx.restore()
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [
    videoReady, showImage, showVideo, showMasks, showSkeleton, showAnchors, showBody,
    skeleton, currentFrame, totalFrames, anchorFrames, legRestPoses,
    selectedLegId, editMode,
    zones, sam2ContourAnchors, contoursAll, videoSize, transformRef,
    bodyTriangles, walkBodyFrames, imgToVid, bodyVerticesVidForFrame,
    imgSize, vidW, vidH,
  ])

  // ─── Save / Validate ──────────────────────────────────────────────────

  const handleSave = useCallback(async (validate: boolean) => {
    if (!mesh || saving) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        // V3 : pas de bodyChain (body animé par ARAP). V2 : préserver bodyChain défini en step "Bones Corps".
        sam2Skeleton: { bodyChain: mesh.sam2Skeleton?.bodyChain ?? [], legs: skeleton.legs },
        sam2BonesValidated: validate,
        // Silent downstream invalidation (V2) — leg compute + leg smoothing are stale.
        ...(validate ? {
          walkZoneFrames: null,
          walkZoneFramesSmoothed: null,
          walkZoneFramesSmoothingValidated: false,
        } : {}),
      }
      const updatedAnimations = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave({ ...project, animations: updatedAnimations })
      setLastSavedAt(Date.now())
    } finally {
      setSaving(false)
    }
  }, [mesh, saving, onSave, project, animation, skeleton])

  // ─── Skeleton editing helpers ─────────────────────────────────────────

  const addLeg = useCallback(() => {
    const usedZones = new Set(skeleton.legs.map(l => l.zoneId))
    const legZones = zones.filter(z => z.id.startsWith('leg-') && !usedZones.has(z.id))
    const zoneId = legZones[0]?.id ?? 'leg-fl'
    const newLeg: Sam2LegBone = {
      id: crypto.randomUUID(),
      zoneId,
      name: zones.find(z => z.id === zoneId)?.label ?? zoneId,
      hip: makeDefaultRef(zoneId),
      foot: makeDefaultRef(zoneId),
      kneeRestPos: { x: 0, y: 0 },
      kneeMode: 'rest',
      hipMode: 'anchor',
      hipBodyVertexIndex: null,
      hipBodyVertexIndices: null,
      hipBodyVertexWeights: null,
    }
    setSkeleton(s => ({ ...s, legs: [...s.legs, newLeg] }))
    setSelectedLegId(newLeg.id)
  }, [skeleton.legs, zones])

  const removeLeg = useCallback((id: string) => {
    setSkeleton(s => ({ ...s, legs: s.legs.filter(l => l.id !== id) }))
    if (selectedLegId === id) setSelectedLegId(null)
  }, [selectedLegId])

  const updateLeg = useCallback((id: string, updates: Partial<Sam2LegBone>) => {
    setSkeleton(s => ({
      ...s,
      legs: s.legs.map(l => l.id === id ? { ...l, ...updates } : l),
    }))
  }, [])

  const updateLegEndpoint = useCallback((legId: string, endpoint: 'hip' | 'foot', refUpdates: Partial<Sam2BoneEndpointRef>) => {
    setSkeleton(s => ({
      ...s,
      legs: s.legs.map(l => {
        if (l.id !== legId) return l
        return { ...l, [endpoint]: { ...l[endpoint], ...refUpdates } }
      }),
    }))
  }, [])

  // ─── Hip mode helpers (derived from leg fields, with override for staging the toggle) ──

  const [hipModeByLeg, setHipModeByLeg] = useState<Record<string, 'anchor' | 'body-vertex'>>({})

  const inferHipMode = useCallback((leg: Sam2LegBone): 'anchor' | 'body-vertex' => {
    if (leg.hipMode === 'body-vertex' || leg.hipMode === 'anchor') return leg.hipMode
    return getHipBodyVertexRefs(leg) ? 'body-vertex' : 'anchor'
  }, [])

  const getHipMode = useCallback((leg: Sam2LegBone): 'anchor' | 'body-vertex' => {
    return hipModeByLeg[leg.id] ?? inferHipMode(leg)
  }, [hipModeByLeg, inferHipMode])

  const setHipMode = useCallback((legId: string, mode: 'anchor' | 'body-vertex') => {
    setHipModeByLeg(m => ({ ...m, [legId]: mode }))
    if (mode === 'anchor') {
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => l.id === legId ? {
          ...l,
          hipMode: 'anchor' as const,
          hipBodyVertexIndex: null,
          hipBodyVertexIndices: null,
          hipBodyVertexWeights: null,
        } : l),
      }))
    } else {
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => l.id === legId ? { ...l, hipMode: 'body-vertex' as const } : l),
      }))
    }
  }, [])

  // ─── Validation checks ────────────────────────────────────────────────

  const validationErrors = useMemo(() => {
    const errors: string[] = []
    const legZoneIds = new Set<string>()
    for (const leg of skeleton.legs) {
      if (legZoneIds.has(leg.zoneId)) {
        errors.push(`Zone "${leg.zoneId}" utilisee par plusieurs pattes`)
      }
      legZoneIds.add(leg.zoneId)

      // Hip validation
      const hipMode = hipModeByLeg[leg.id] ?? inferHipMode(leg)
      if (hipMode === 'body-vertex') {
        const refs = getHipBodyVertexRefs(leg)
        if (!refs || refs.indices.length === 0) {
          errors.push(`Patte "${leg.name}" : aucun body vertex placé pour la hanche`)
        } else if (!bodyPoints || refs.indices.some(i => i >= bodyPoints.length)) {
          errors.push(`Patte "${leg.name}" : index body vertex hanche hors limites`)
        }
      } else {
        const hipAnchors = sam2ContourAnchors[leg.hip.zoneId]
        if (!hipAnchors) {
          errors.push(`Patte "${leg.name}" hanche : zone "${leg.hip.zoneId}" inexistante`)
        } else if (leg.hip.anchorIndexA >= hipAnchors.length || leg.hip.anchorIndexB >= hipAnchors.length) {
          errors.push(`Patte "${leg.name}" hanche : index anchor hors limites`)
        }
      }

      // Foot validation
      const footAnchors = sam2ContourAnchors[leg.foot.zoneId]
      if (!footAnchors) {
        errors.push(`Patte "${leg.name}" pied : zone "${leg.foot.zoneId}" inexistante`)
      } else if (leg.foot.anchorIndexA >= footAnchors.length || leg.foot.anchorIndexB >= footAnchors.length) {
        errors.push(`Patte "${leg.name}" pied : index anchor hors limites`)
      }

      if (leg.kneeRestPos.x === 0 && leg.kneeRestPos.y === 0) {
        errors.push(`Patte "${leg.name}" : genou non place`)
      }
    }
    return errors
  }, [skeleton, sam2ContourAnchors, bodyPoints, hipModeByLeg, inferHipMode])

  const canValidate = validationErrors.length === 0

  // ─── Render ───────────────────────────────────────────────────────────

  if (!animation.videoBlob) return <div className="placeholder">Importez d&apos;abord une video (etape 1).</div>
  // V3 : pas de "Bones Corps" — body animé par ARAP. V2 : flag sam2BodyBonesValidated requis.
  if (animation.type !== 'members-bones-v3' && !mesh?.sam2BodyBonesValidated) {
    return <div className="placeholder">Validez d&apos;abord les bones du corps (etape precedente).</div>
  }
  if (!walkBodyFrames) return <div className="placeholder">Calculez d&apos;abord l&apos;animation du corps (etape precedente).</div>

  return (
    <div className="triangulation-step">
      {/* Toolbar: toggles + actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Bones Pattes</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showImage} onChange={e => setShowImage(e.target.checked)} />
          Image
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showVideo} onChange={e => setShowVideo(e.target.checked)} />
          Video
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showMasks} onChange={e => setShowMasks(e.target.checked)} />
          Zones
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showBody} onChange={e => setShowBody(e.target.checked)} />
          Body mesh
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showSkeleton} onChange={e => setShowSkeleton(e.target.checked)} />
          Squelette
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showAnchors} onChange={e => setShowAnchors(e.target.checked)} />
          Anchors
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {lastSavedAt != null && !saving && (
            <span style={{ fontSize: 11, color: '#22c55e' }}>
              ✓ Sauvegardé à {new Date(lastSavedAt).toLocaleTimeString()}
            </span>
          )}
          {!isValidated && (
            <>
              <button
                className="btn-secondary"
                onClick={() => handleSave(false)}
                disabled={saving}
                title="Sauvegarde l'état actuel des pattes (persistant) sans valider l'étape"
              >
                {saving ? 'Sauvegarde...' : 'Sauvegarder'}
              </button>
              <button
                className="btn-primary"
                onClick={() => handleSave(true)}
                disabled={saving || !canValidate}
                title={canValidate ? 'Valide l\'étape (toutes pattes complètes)' : 'Toutes les pattes doivent être complètes pour valider'}
              >
                {saving ? 'Validation...' : 'Valider'}
              </button>
            </>
          )}
          {isValidated && (
            <button className="btn-secondary" onClick={() => handleSave(false)}>
              Reediter
            </button>
          )}
        </div>
      </div>

      {/* Canvas + floating side panel */}
      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onClick={handleCanvasClick}
          onContextMenu={handleContextMenu}
          style={{ cursor: editMode !== 'select' ? 'crosshair' : undefined }}
        />
        {/* Floating side panel overlaid on canvas */}
        <div style={{
          position: 'absolute', top: 8, left: 8, bottom: 8,
          width: 280, overflowY: 'auto',
          padding: '8px 10px',
          background: 'rgba(20, 20, 30, 0.92)',
          borderRadius: 8, border: '1px solid #444',
          fontSize: 13, zIndex: 10,
          pointerEvents: 'auto',
        }}>
          {/* Legs */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <strong>Pattes ({skeleton.legs.length}/4)</strong>
              <button
                className="btn-sm btn-secondary"
                onClick={addLeg}
                disabled={isValidated || skeleton.legs.length >= 4}
              >
                + Patte
              </button>
            </div>
            {(editMode === 'place-hip' || editMode === 'place-foot' || editMode === 'place-knee' || editMode === 'place-hip-vertex') && (
              <div style={{ color: '#fbbf24', fontSize: 11, marginBottom: 4 }}>
                {editMode === 'place-hip' && 'Cliquez sur le canvas pour placer la hanche (anchor)...'}
                {editMode === 'place-foot' && 'Cliquez sur le canvas pour placer le pied...'}
                {editMode === 'place-knee' && 'Cliquez sur le canvas pour placer le genou...'}
                {editMode === 'place-hip-vertex' && 'Cliquez sur un vertex body pour lier la hanche.'}
                <button className="btn-sm btn-ghost" onClick={() => { setEditMode('select') }} style={{ marginLeft: 4 }}>Annuler</button>
              </div>
            )}
            {skeleton.legs.map((leg) => {
              const hipMode = getHipMode(leg)
              return (
                <div
                  key={leg.id}
                  style={{
                    padding: '6px 8px', marginBottom: 4,
                    background: selectedLegId === leg.id ? '#2a2a3a' : '#1a1a2a',
                    borderRadius: 4, cursor: 'pointer',
                    border: selectedLegId === leg.id ? '1px solid #6366f1' : '1px solid transparent',
                  }}
                  onClick={() => setSelectedLegId(leg.id)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <input
                      value={leg.name}
                      onChange={e => updateLeg(leg.id, { name: e.target.value })}
                      disabled={isValidated}
                      style={{ background: 'transparent', border: 'none', color: '#fff', fontWeight: 600, fontSize: 12, width: 120 }}
                    />
                    <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); removeLeg(leg.id) }} disabled={isValidated} style={{ color: '#ef4444' }}>&times;</button>
                  </div>
                  {selectedLegId === leg.id && !isValidated && (
                    <>
                      {/* Zone selector */}
                      <div style={{ marginBottom: 4 }}>
                        <label style={{ fontSize: 11 }}>Zone :
                          <select
                            value={leg.zoneId}
                            onChange={e => {
                              const zid = e.target.value
                              updateLeg(leg.id, {
                                zoneId: zid,
                                name: zones.find(z => z.id === zid)?.label ?? zid,
                                hip: makeDefaultRef(zid),
                                foot: makeDefaultRef(zid),
                                hipBodyVertexIndex: null,
                                hipBodyVertexIndices: null,
                                hipBodyVertexWeights: null,
                                hipMode: 'anchor',
                              })
                            }}
                            style={{ marginLeft: 4, fontSize: 11 }}
                          >
                            {zones.filter(z => z.id.startsWith('leg-')).map(z => (
                              <option key={z.id} value={z.id}>{z.label}</option>
                            ))}
                          </select>
                        </label>
                      </div>

                      {/* Hip mode toggle */}
                      <div style={{ marginBottom: 4 }}>
                        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 2 }}>Hanche</div>
                        <div style={{ display: 'flex', gap: 2, marginBottom: 4 }}>
                          <button
                            className={hipMode === 'anchor' ? 'btn-sm btn-primary' : 'btn-sm btn-ghost'}
                            onClick={() => setHipMode(leg.id, 'anchor')}
                            style={{ fontSize: 10, padding: '2px 6px' }}
                          >
                            Anchor
                          </button>
                          <button
                            className={hipMode === 'body-vertex' ? 'btn-sm btn-primary' : 'btn-sm btn-ghost'}
                            onClick={() => setHipMode(leg.id, 'body-vertex')}
                            style={{ fontSize: 10, padding: '2px 6px' }}
                          >
                            Body Vertex
                          </button>
                        </div>

                        {hipMode === 'anchor' && (
                          <>
                            <EndpointRefEditor
                              label=""
                              value={leg.hip}
                              onChange={updates => updateLegEndpoint(leg.id, 'hip', updates)}
                              zones={zones}
                              sam2ContourAnchors={sam2ContourAnchors}
                            />
                            <button className="btn-sm btn-ghost" onClick={() => { placingLegIdRef.current = leg.id; setEditMode('place-hip') }}>
                              Placer hanche
                            </button>
                          </>
                        )}

                        {hipMode === 'body-vertex' && (() => {
                          const refs = getHipBodyVertexRefs(leg)
                          const idx = refs?.indices[0]
                          return (
                            <div style={{ fontSize: 11, marginBottom: 4 }}>
                              {idx != null ? (
                                <span>Vertex body : <strong>#{idx}</strong></span>
                              ) : (
                                <span style={{ color: '#888' }}>Cliquez un vertex du body mesh</span>
                              )}
                              <button
                                className="btn-sm btn-ghost"
                                onClick={() => {
                                  placingLegIdRef.current = leg.id
                                  setEditMode('place-hip-vertex')
                                }}
                                style={{ marginLeft: 4 }}
                              >
                                {idx != null ? 'Replacer' : 'Placer'}
                              </button>
                            </div>
                          )
                        })()}
                      </div>

                      {/* Foot (always anchor-based) */}
                      <EndpointRefEditor
                        label="Pied"
                        value={leg.foot}
                        onChange={updates => updateLegEndpoint(leg.id, 'foot', updates)}
                        zones={zones}
                        sam2ContourAnchors={sam2ContourAnchors}
                      />
                      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                        <button className="btn-sm btn-ghost" onClick={() => { placingLegIdRef.current = leg.id; setEditMode('place-foot') }}>
                          Placer pied
                        </button>
                      </div>

                      {/* Knee */}
                      <div style={{ marginBottom: 4 }}>
                        <button className="btn-sm btn-ghost" onClick={() => { placingLegIdRef.current = leg.id; setEditMode('place-knee') }}>
                          Placer genou
                        </button>
                        <label style={{ fontSize: 11, marginLeft: 8 }}>Mode :
                          <select
                            value={leg.kneeMode}
                            onChange={e => updateLeg(leg.id, { kneeMode: e.target.value as ElbowMode })}
                            style={{ marginLeft: 4, fontSize: 11 }}
                          >
                            <option value="rest">Rest</option>
                            <option value="centroid">Centroid</option>
                            <option value="continuity">Continuity</option>
                          </select>
                        </label>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div style={{ background: '#2a1a1a', borderRadius: 4, padding: 6, marginBottom: 8, fontSize: 11, color: '#fca5a5' }}>
              {validationErrors.map((e, i) => <div key={i}>&bull; {e}</div>)}
            </div>
          )}
        </div>{/* end floating panel */}
      </div>{/* end canvas container */}

      {/* Bottom bar: playback */}
      {totalFrames > 0 && (
        <div style={{
          padding: '6px 16px',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
        }}>
          <button className="btn-sm btn-ghost" onClick={() => setPlaying(p => !p)}>
            {playing ? '\u23F8' : '\u25B6'}
          </button>
          <FrameNavigator
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            editedFrames={EMPTY_SET}
            onNavigate={(f: number) => { setPlaying(false); setCurrentFrame(f) }}
          />
          <span style={{ color: '#888', fontSize: 11 }}>Frame {currentFrame}/{totalFrames}</span>
        </div>
      )}
    </div>
  )
}
