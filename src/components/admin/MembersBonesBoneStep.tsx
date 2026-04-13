/**
 * MembersBonesBoneStep — Step 9 for members-bones animations.
 *
 * Defines a skeleton per zone (body chain + leg IK bones) and previews
 * the animated skeleton over the video with SAM2 mask overlays.
 *
 * Body chain: connected joints, straight segments, each joint linked to 1-2 zone anchors.
 * Legs: single bone with IK knee (hip→knee→foot), reuses elbow IK from boneSolver.
 * Cross-zone: any endpoint can reference anchors from any zone.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type {
  ProjectStepView, Point2D, SAM2Zone,
  Sam2Skeleton, Sam2BodyJoint, Sam2LegBone, Sam2BoneEndpointRef, ElbowMode,
} from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import {
  resolveSkeletonFrame,
  computeLegRestPose,
} from '../../utils/sam2BoneSolver'
import type { LegRestPose, Sam2SkeletonFrame } from '../../utils/sam2BoneSolver'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
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

// ─── Endpoint ref editor (extracted to avoid re-mount on every render) ──
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

type EditMode = 'select' | 'place-joint' | 'place-hip' | 'place-foot' | 'place-knee'

export default function MembersBonesBoneStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const sam2ContourAnchors = useMemo(() => mesh?.sam2ContourAnchors ?? {}, [mesh?.sam2ContourAnchors])
  const contoursAll = mesh?.sam2Contours ?? null

  const anchorFrames = useMemo(() => mesh?.sam2ContourAnchorFrames ?? {}, [mesh?.sam2ContourAnchorFrames])

  const totalFrames = useMemo(() => {
    if (!contoursAll) return 0
    const first = Object.values(contoursAll)[0]
    return first?.length ?? 0
  }, [contoursAll])

  // ----- Skeleton state -----
  const [skeleton, setSkeleton] = useState<Sam2Skeleton>(() => {
    const existing = mesh?.sam2Skeleton
    if (existing) return existing
    return { bodyChain: [], legs: [] }
  })
  const [selectedJointId, setSelectedJointId] = useState<string | null>(null)
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<EditMode>('select')

  // The leg whose hip/foot/knee we're placing
  const placingLegIdRef = useRef<string | null>(null)

  // Drag state (ref to avoid re-render storms during drag)
  const draggingRef = useRef<{ type: 'knee'; legId: string } | null>(null)
  const didDragRef = useRef(false)

  // ----- Visibility toggles -----
  const [showVideo, setShowVideo] = useState(true)
  const [showMasks, setShowMasks] = useState(true)
  const [showSkeleton, setShowSkeleton] = useState(true)
  const [showAnchors, setShowAnchors] = useState(true)

  // ----- Playback -----
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)

  // ----- Phase -----
  const isValidated = mesh?.sam2BonesValidated === true
  const [saving, setSaving] = useState(false)

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
    return skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames))
  }, [skeleton.legs, anchorFrames])

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
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
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
      // Fallback if onseeked doesn't fire (already at time 0)
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
  }, [project.videoBlob])

  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

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
    // Initial size
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
    // Find 2 closest anchors (potentially cross-zone)
    const sorted = [...allAnchorsWithZone].sort((a, b) => {
      const da = (a.pos.x - imgPos.x) ** 2 + (a.pos.y - imgPos.y) ** 2
      const db = (b.pos.x - imgPos.x) ** 2 + (b.pos.y - imgPos.y) ** 2
      return da - db
    })
    const nearest = sorted[0]
    const second = sorted[1]

    // If the two closest are from different zones, snap to nearest anchor
    if (nearest.zoneId !== second.zoneId) {
      return {
        zoneId: nearest.zoneId,
        anchorIndexA: nearest.idx,
        anchorIndexB: nearest.idx,
        t: 0,
      }
    }

    // Both from same zone: compute barycentric t (projection onto A→B)
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

  // ─── Knee drag (mousedown / mousemove / mouseup) ─────────────────────

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (isPanning.current || spaceDown.current) return
    if (e.button !== 0) return
    if (isValidated || !Object.keys(anchorFrames).length || totalFrames === 0) return

    const imgPos = screenToImage(e.clientX, e.clientY)
    const threshold = 10 / transformRef.current.scale

    // Resolve skeleton at frame 0 to get knee positions
    const frame = resolveSkeletonFrame(skeleton, anchorFrames, 0, legRestPoses, null)

    for (let i = 0; i < frame.legs.length; i++) {
      const knee = frame.legs[i].knee
      if (Math.hypot(imgPos.x - knee.x, imgPos.y - knee.y) < threshold) {
        draggingRef.current = { type: 'knee', legId: skeleton.legs[i].id }
        didDragRef.current = false
        setSelectedLegId(skeleton.legs[i].id)
        setSelectedJointId(null)
        e.preventDefault()
        return
      }
    }
  }, [isValidated, screenToImage, transformRef, skeleton, anchorFrames, totalFrames, legRestPoses, isPanning, spaceDown])

  const handleCanvasMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return
    didDragRef.current = true
    const imgPos = screenToImage(e.clientX, e.clientY)
    if (draggingRef.current.type === 'knee') {
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l =>
          l.id === draggingRef.current!.legId ? { ...l, kneeRestPos: imgPos } : l
        ),
      }))
    }
  }, [screenToImage])

  const handleCanvasMouseUp = useCallback(() => {
    draggingRef.current = null
  }, [])

  // ─── Canvas click handler ─────────────────────────────────────────────

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning.current || spaceDown.current) return
    if (didDragRef.current) { didDragRef.current = false; return }  // skip click after drag
    if (editMode === 'select') return

    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cssX = e.clientX - rect.left
    const cssY = e.clientY - rect.top
    const imgPos = screenToImage(cssX, cssY)

    if (editMode === 'place-joint') {
      const ref = clickToEndpointRef(imgPos)
      if (!ref) return
      const newJoint: Sam2BodyJoint = {
        id: crypto.randomUUID(),
        name: `Joint ${skeleton.bodyChain.length + 1}`,
        ref,
      }
      setSkeleton(s => ({ ...s, bodyChain: [...s.bodyChain, newJoint] }))
      setSelectedJointId(newJoint.id)
      // Stay in place-joint mode — right-click to finish
    }

    if (editMode === 'place-hip' || editMode === 'place-foot') {
      const ref = clickToEndpointRef(imgPos)
      if (!ref) return
      const legId = placingLegIdRef.current
      if (!legId) return
      setSkeleton(s => ({
        ...s,
        legs: s.legs.map(l => {
          if (l.id !== legId) return l
          if (editMode === 'place-hip') return { ...l, hip: ref }
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
        legs: s.legs.map(l => l.id === legId ? { ...l, kneeRestPos: imgPos } : l),
      }))
      setEditMode('select')
    }
  }, [editMode, screenToImage, clickToEndpointRef, skeleton.bodyChain.length, isPanning, spaceDown])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    if (editMode === 'place-joint') {
      setEditMode('select')
    }
  }, [editMode])

  // ─── Draw loop ────────────────────────────────────────────────────────

  useEffect(() => {
    let running = true
    let rafId = 0
    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      if (!canvas) {
        rafId = requestAnimationFrame(draw)
        return
      }
      if (canvas.width === 0 || canvas.height === 0) {
        rafId = requestAnimationFrame(draw)
        return
      }
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

      // 1. Video frame
      const video = videoRef.current
      if (showVideo && video && videoReady) {
        ctx.drawImage(video, 0, 0)
      }

      // 2. Zone contours (smoothed contours with bridge, not SAM2 masks)
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

      // 3. Skeleton
      if (showSkeleton && skeleton.bodyChain.length >= 2) {
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        const hasFrames = Object.keys(anchorFrames).length > 0
        let frame: Sam2SkeletonFrame | null = null

        if (hasFrames && totalFrames > 0) {
          frame = resolveSkeletonFrame(skeleton, anchorFrames, safeFrame, legRestPoses, prevSkeletonFrameRef.current)
          prevSkeletonFrameRef.current = frame
        }

        if (frame) {
          const lineW = 3 / t.scale
          const jointR = 5 / t.scale

          // Body chain segments
          for (let i = 0; i < frame.bodyJoints.length - 1; i++) {
            const a = frame.bodyJoints[i]
            const b = frame.bodyJoints[i + 1]
            ctx.strokeStyle = getBoneColor(i)
            ctx.lineWidth = lineW
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }

          // Body chain joints
          for (let i = 0; i < frame.bodyJoints.length; i++) {
            const p = frame.bodyJoints[i]
            const isSelected = skeleton.bodyChain[i]?.id === selectedJointId
            ctx.fillStyle = isSelected ? '#fbbf24' : '#fff'
            ctx.strokeStyle = getBoneColor(Math.max(0, i - 1))
            ctx.lineWidth = 2 / t.scale
            ctx.beginPath()
            ctx.arc(p.x, p.y, isSelected ? jointR * 1.4 : jointR, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()

            // Label
            const name = skeleton.bodyChain[i]?.name ?? ''
            if (name) {
              ctx.fillStyle = '#fff'
              ctx.font = `${11 / t.scale}px sans-serif`
              ctx.fillText(name, p.x + jointR * 1.5, p.y - jointR)
            }
          }

          // Leg bones
          for (let li = 0; li < frame.legs.length; li++) {
            const leg = frame.legs[li]
            const color = getBoneColor(skeleton.bodyChain.length + li)
            const isSelected = skeleton.legs[li]?.id === selectedLegId

            // Hip → Knee
            ctx.strokeStyle = color
            ctx.lineWidth = isSelected ? lineW * 1.5 : lineW
            ctx.beginPath()
            ctx.moveTo(leg.hip.x, leg.hip.y)
            ctx.lineTo(leg.knee.x, leg.knee.y)
            ctx.stroke()

            // Knee → Foot
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
          }
        }
      } else if (showSkeleton && skeleton.legs.length > 0 && skeleton.bodyChain.length < 2) {
        // Draw legs even if body chain is incomplete
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        const hasFrames = Object.keys(anchorFrames).length > 0
        if (hasFrames && totalFrames > 0) {
          const frame = resolveSkeletonFrame(skeleton, anchorFrames, safeFrame, legRestPoses, prevSkeletonFrameRef.current)
          prevSkeletonFrameRef.current = frame
          const lineW = 3 / t.scale
          const jointR = 5 / t.scale
          for (let li = 0; li < frame.legs.length; li++) {
            const leg = frame.legs[li]
            const color = getBoneColor(li)
            ctx.strokeStyle = color
            ctx.lineWidth = lineW
            ctx.beginPath()
            ctx.moveTo(leg.hip.x, leg.hip.y)
            ctx.lineTo(leg.knee.x, leg.knee.y)
            ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(leg.knee.x, leg.knee.y)
            ctx.lineTo(leg.foot.x, leg.foot.y)
            ctx.stroke()
            // Knee square
            const kr = jointR * 1.1
            ctx.fillStyle = '#fbbf24'
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.5 / t.scale
            ctx.fillRect(leg.knee.x - kr, leg.knee.y - kr, kr * 2, kr * 2)
            ctx.strokeRect(leg.knee.x - kr, leg.knee.y - kr, kr * 2, kr * 2)
          }
        }
      }

      // 4. Anchor points (tracked frame by frame)
      if (showAnchors) {
        const safeF = Math.max(0, Math.min(totalFrames - 1, currentFrame))
        for (const z of zones) {
          // Use tracked positions at current frame, fallback to static frame-0
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
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [
    videoReady, showVideo, showMasks, showSkeleton, showAnchors,
    skeleton, currentFrame, totalFrames, anchorFrames, legRestPoses,
    selectedJointId, selectedLegId,
    zones, sam2ContourAnchors, contoursAll, videoSize, transformRef,
  ])

  // ─── Save / Validate ──────────────────────────────────────────────────

  const handleSave = useCallback(async (validate: boolean) => {
    if (!mesh || saving) return
    setSaving(true)
    try {
      await onSave({
        ...project,
        mesh: {
          ...mesh,
          sam2Skeleton: skeleton,
          sam2BonesValidated: validate,
        },
      })
    } finally {
      setSaving(false)
    }
  }, [mesh, saving, onSave, project, skeleton])

  // ─── Skeleton editing helpers ─────────────────────────────────────────

  const addJoint = useCallback(() => {
    setEditMode('place-joint')
  }, [])

  const removeJoint = useCallback((id: string) => {
    setSkeleton(s => ({
      ...s,
      bodyChain: s.bodyChain.filter(j => j.id !== id),
    }))
    if (selectedJointId === id) setSelectedJointId(null)
  }, [selectedJointId])

  const updateJoint = useCallback((id: string, updates: Partial<Sam2BodyJoint>) => {
    setSkeleton(s => ({
      ...s,
      bodyChain: s.bodyChain.map(j => j.id === id ? { ...j, ...updates } : j),
    }))
  }, [])

  const updateJointRef = useCallback((id: string, refUpdates: Partial<Sam2BoneEndpointRef>) => {
    setSkeleton(s => ({
      ...s,
      bodyChain: s.bodyChain.map(j =>
        j.id === id ? { ...j, ref: { ...j.ref, ...refUpdates } } : j
      ),
    }))
  }, [])

  const moveJoint = useCallback((id: string, direction: -1 | 1) => {
    setSkeleton(s => {
      const idx = s.bodyChain.findIndex(j => j.id === id)
      if (idx < 0) return s
      const newIdx = idx + direction
      if (newIdx < 0 || newIdx >= s.bodyChain.length) return s
      const chain = [...s.bodyChain]
      ;[chain[idx], chain[newIdx]] = [chain[newIdx], chain[idx]]
      return { ...s, bodyChain: chain }
    })
  }, [])

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

  // ─── Validation checks ────────────────────────────────────────────────

  const validationErrors = useMemo(() => {
    const errors: string[] = []
    if (skeleton.bodyChain.length < 2) {
      errors.push('La chaîne body doit avoir au moins 2 joints')
    }
    for (const joint of skeleton.bodyChain) {
      const anchors = sam2ContourAnchors[joint.ref.zoneId]
      if (!anchors) {
        errors.push(`Joint "${joint.name}" : zone "${joint.ref.zoneId}" inexistante`)
      } else {
        if (joint.ref.anchorIndexA >= anchors.length || joint.ref.anchorIndexB >= anchors.length) {
          errors.push(`Joint "${joint.name}" : index anchor hors limites`)
        }
      }
    }
    const legZoneIds = new Set<string>()
    for (const leg of skeleton.legs) {
      if (legZoneIds.has(leg.zoneId)) {
        errors.push(`Zone "${leg.zoneId}" utilisée par plusieurs pattes`)
      }
      legZoneIds.add(leg.zoneId)
      for (const ep of ['hip', 'foot'] as const) {
        const ref = leg[ep]
        const anchors = sam2ContourAnchors[ref.zoneId]
        if (!anchors) {
          errors.push(`Patte "${leg.name}" ${ep} : zone "${ref.zoneId}" inexistante`)
        } else if (ref.anchorIndexA >= anchors.length || ref.anchorIndexB >= anchors.length) {
          errors.push(`Patte "${leg.name}" ${ep} : index anchor hors limites`)
        }
      }
      if (leg.kneeRestPos.x === 0 && leg.kneeRestPos.y === 0) {
        errors.push(`Patte "${leg.name}" : genou non placé`)
      }
    }
    return errors
  }, [skeleton, sam2ContourAnchors])

  const canValidate = validationErrors.length === 0

  // ─── Render ───────────────────────────────────────────────────────────

  if (!project.videoBlob) return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContourAnchorTrackingValidated) return <div className="placeholder">Validez d'abord le tracking des anchors (étape précédente).</div>

  return (
    <div className="triangulation-step">
      {/* Toolbar: toggles + actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Bones par zone</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showVideo} onChange={e => setShowVideo(e.target.checked)} />
          Vidéo
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showMasks} onChange={e => setShowMasks(e.target.checked)} />
          Zones
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showSkeleton} onChange={e => setShowSkeleton(e.target.checked)} />
          Squelette
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showAnchors} onChange={e => setShowAnchors(e.target.checked)} />
          Anchors
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!isValidated && (
            <>
              <button className="btn-secondary" onClick={() => handleSave(false)} disabled={saving}>
                {saving ? 'Sauvegarde...' : 'Sauvegarder'}
              </button>
              <button className="btn-primary" onClick={() => handleSave(true)} disabled={saving || !canValidate}>
                {saving ? 'Validation...' : 'Valider'}
              </button>
            </>
          )}
          {isValidated && (
            <button className="btn-secondary" onClick={() => handleSave(false)}>
              Rééditer
            </button>
          )}
        </div>
      </div>

      {/* Canvas (must be direct child of triangulation-step for proper sizing) */}
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
          width: 260, overflowY: 'auto',
          padding: '8px 10px',
          background: 'rgba(20, 20, 30, 0.92)',
          borderRadius: 8, border: '1px solid #444',
          fontSize: 13, zIndex: 10,
          pointerEvents: 'auto',
        }}>
        {/* Body chain */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong>Colonne vertébrale ({skeleton.bodyChain.length})</strong>
            <button
              className="btn-sm btn-secondary"
              onClick={addJoint}
              disabled={isValidated}
              title="Cliquer sur le canvas pour placer"
            >
              + Joint
            </button>
          </div>
          {editMode === 'place-joint' && (
            <div style={{ color: '#fbbf24', fontSize: 11, marginBottom: 4 }}>
              Cliquez pour placer les joints — <strong>clic droit</strong> pour terminer
            </div>
          )}
          {skeleton.bodyChain.map((joint, idx) => (
            <div
              key={joint.id}
              style={{
                padding: '6px 8px', marginBottom: 4,
                background: selectedJointId === joint.id ? '#2a2a3a' : '#1a1a2a',
                borderRadius: 4, cursor: 'pointer',
                border: selectedJointId === joint.id ? '1px solid #6366f1' : '1px solid transparent',
              }}
              onClick={() => { setSelectedJointId(joint.id); setSelectedLegId(null) }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <input
                  value={joint.name}
                  onChange={e => updateJoint(joint.id, { name: e.target.value })}
                  disabled={isValidated}
                  style={{ background: 'transparent', border: 'none', color: '#fff', fontWeight: 600, fontSize: 12, width: 120 }}
                />
                <div style={{ display: 'flex', gap: 2 }}>
                  <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); moveJoint(joint.id, -1) }} disabled={idx === 0 || isValidated}>↑</button>
                  <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); moveJoint(joint.id, 1) }} disabled={idx === skeleton.bodyChain.length - 1 || isValidated}>↓</button>
                  <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); removeJoint(joint.id) }} disabled={isValidated} style={{ color: '#ef4444' }}>×</button>
                </div>
              </div>
              {selectedJointId === joint.id && !isValidated && (
                <EndpointRefEditor
                  label="Ancrage"
                  value={joint.ref}
                  onChange={updates => updateJointRef(joint.id, updates)}
                  zones={zones}
                  sam2ContourAnchors={sam2ContourAnchors}
                />
              )}
            </div>
          ))}
        </div>

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
          {(editMode === 'place-hip' || editMode === 'place-foot' || editMode === 'place-knee') && (
            <div style={{ color: '#fbbf24', fontSize: 11, marginBottom: 4 }}>
              Cliquez sur le canvas pour placer {editMode === 'place-hip' ? 'la hanche' : editMode === 'place-foot' ? 'le pied' : 'le genou'}...
              <button className="btn-sm btn-ghost" onClick={() => setEditMode('select')} style={{ marginLeft: 4 }}>Annuler</button>
            </div>
          )}
          {skeleton.legs.map((leg) => (
            <div
              key={leg.id}
              style={{
                padding: '6px 8px', marginBottom: 4,
                background: selectedLegId === leg.id ? '#2a2a3a' : '#1a1a2a',
                borderRadius: 4, cursor: 'pointer',
                border: selectedLegId === leg.id ? '1px solid #6366f1' : '1px solid transparent',
              }}
              onClick={() => { setSelectedLegId(leg.id); setSelectedJointId(null) }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <input
                  value={leg.name}
                  onChange={e => updateLeg(leg.id, { name: e.target.value })}
                  disabled={isValidated}
                  style={{ background: 'transparent', border: 'none', color: '#fff', fontWeight: 600, fontSize: 12, width: 120 }}
                />
                <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); removeLeg(leg.id) }} disabled={isValidated} style={{ color: '#ef4444' }}>×</button>
              </div>
              {selectedLegId === leg.id && !isValidated && (
                <>
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
                  <EndpointRefEditor
                    label="Hanche"
                    value={leg.hip}
                    onChange={updates => updateLegEndpoint(leg.id, 'hip', updates)}
                    zones={zones}
                    sam2ContourAnchors={sam2ContourAnchors}
                  />
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                    <button className="btn-sm btn-ghost" onClick={() => { placingLegIdRef.current = leg.id; setEditMode('place-hip') }}>
                      Placer hanche
                    </button>
                  </div>
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
          ))}
        </div>

        {/* Validation errors */}
        {validationErrors.length > 0 && (
          <div style={{ background: '#2a1a1a', borderRadius: 4, padding: 6, marginBottom: 8, fontSize: 11, color: '#fca5a5' }}>
            {validationErrors.map((e, i) => <div key={i}>• {e}</div>)}
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
            {playing ? '⏸' : '▶'}
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
