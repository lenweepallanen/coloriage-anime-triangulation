/**
 * MembersBonesV2BodyBoneStep — Body chain (colonne vertebrale) editor
 * for members-bones-v2 animations.
 *
 * Extracted from MembersBonesBoneStep: handles ONLY the body chain,
 * no legs section. Uses `sam2BodyBonesValidated` for validation and
 * invalidates downstream (walkBodyFrames, walkZoneFrames, sam2BonesValidated).
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type {
  ProjectStepView, Point2D, SAM2Zone,
  Sam2Skeleton, Sam2BodyJoint, Sam2BoneEndpointRef,
} from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { resolveBodyChain } from '../../utils/sam2BoneSolver'
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

// ─── Endpoint ref editor ──────────────────────────────────────────────
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

type EditMode = 'select' | 'place-joint'

export default function MembersBonesV2BodyBoneStep({ project, onSave }: Props) {
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

  // ----- Skeleton state (body chain only) -----
  const [skeleton, setSkeleton] = useState<Sam2Skeleton>(() => {
    const existing = mesh?.sam2Skeleton
    if (existing) return existing
    return { bodyChain: [], legs: [] }
  })
  const [selectedJointId, setSelectedJointId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<EditMode>('select')

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
  const isValidated = mesh?.sam2BodyBonesValidated === true
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

    // Both from same zone: compute barycentric t (projection onto A->B)
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

  // ─── Canvas click handler ─────────────────────────────────────────────

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPanning.current || spaceDown.current) return
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
      // Stay in place-joint mode -- right-click to finish
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

      // 3. Body chain skeleton
      if (showSkeleton && skeleton.bodyChain.length >= 2) {
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        const hasFrames = Object.keys(anchorFrames).length > 0

        if (hasFrames && totalFrames > 0) {
          const bodyJoints = resolveBodyChain(skeleton.bodyChain, anchorFrames, safeFrame)
          const lineW = 3 / t.scale
          const jointR = 5 / t.scale

          // Body chain segments
          for (let i = 0; i < bodyJoints.length - 1; i++) {
            const a = bodyJoints[i]
            const b = bodyJoints[i + 1]
            ctx.strokeStyle = getBoneColor(i)
            ctx.lineWidth = lineW
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }

          // Body chain joints
          for (let i = 0; i < bodyJoints.length; i++) {
            const p = bodyJoints[i]
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
    skeleton, currentFrame, totalFrames, anchorFrames,
    selectedJointId,
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
          sam2BodyBonesValidated: validate,
          // Silent downstream invalidation when re-validating
          ...(validate ? {
            walkBodyFrames: null,
            walkBodyFramesSmoothed: null,
            walkBodyFramesSmoothingValidated: false,
            walkZoneFrames: null,
            walkZoneFramesSmoothed: null,
            walkZoneFramesSmoothingValidated: false,
            sam2BonesValidated: false,
          } : {}),
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
    return errors
  }, [skeleton, sam2ContourAnchors])

  const canValidate = validationErrors.length === 0

  // ─── Render ───────────────────────────────────────────────────────────

  if (!project.videoBlob) return <div className="placeholder">Importez d&apos;abord une video (etape 1).</div>
  if (!mesh?.sam2ContourAnchorTrackingValidated) return <div className="placeholder">Validez d&apos;abord le tracking des anchors (etape precedente).</div>

  return (
    <div className="triangulation-step">
      {/* Toolbar: toggles + actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Bones Corps</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showVideo} onChange={e => setShowVideo(e.target.checked)} />
          Video
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
              Reediter
            </button>
          )}
        </div>
      </div>

      {/* Canvas (must be direct child of triangulation-step for proper sizing) */}
      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
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
              <strong>Colonne vertebrale ({skeleton.bodyChain.length})</strong>
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
                onClick={() => { setSelectedJointId(joint.id) }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <input
                    value={joint.name}
                    onChange={e => updateJoint(joint.id, { name: e.target.value })}
                    disabled={isValidated}
                    style={{ background: 'transparent', border: 'none', color: '#fff', fontWeight: 600, fontSize: 12, width: 120 }}
                  />
                  <div style={{ display: 'flex', gap: 2 }}>
                    <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); moveJoint(joint.id, -1) }} disabled={idx === 0 || isValidated}>&#8593;</button>
                    <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); moveJoint(joint.id, 1) }} disabled={idx === skeleton.bodyChain.length - 1 || isValidated}>&#8595;</button>
                    <button className="btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); removeJoint(joint.id) }} disabled={isValidated} style={{ color: '#ef4444' }}>&times;</button>
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
