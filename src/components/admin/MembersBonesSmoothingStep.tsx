/**
 * MembersBonesSmoothingStep — V1 "Lissage Bones" / V2 "Lissage Anchor".
 *
 * Applies temporal smoothing (Butterworth low-pass) to tracked frames with the
 * same cutoff : contour anchors (always), subdivisions (V2), P0 origins (V2).
 * V1 pipeline ignores the extra smoothed fields ; V2 compute steps consume them.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { ProjectStepView, Point2D, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { resolveSkeletonFrame, computeLegRestPose } from '../../utils/sam2BoneSolver'
import type { LegRestPose, Sam2SkeletonFrame } from '../../utils/sam2BoneSolver'
import { applyTemporalSmoothing } from '../../utils/trackingConstraints'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
  /** V2 passe true : masque le squelette (pas encore défini dans la narration du pipeline V2) */
  hideSkeleton?: boolean
}

const VIDEO_FPS = 24
const EMPTY_SET = new Set<number>()

const BONE_COLORS = [
  '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]
function getBoneColor(i: number) { return BONE_COLORS[i % BONE_COLORS.length] }

export default function MembersBonesSmoothingStep({ project, onSave, hideSkeleton = false }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const rawAnchorFrames = useMemo(() => mesh?.sam2ContourAnchorFrames ?? {}, [mesh?.sam2ContourAnchorFrames])
  const rawSubdivisionFrames = useMemo(() => mesh?.sam2ContourSubdivisionFrames ?? {}, [mesh?.sam2ContourSubdivisionFrames])
  const rawContourOriginFrames = useMemo(() => mesh?.sam2ContourOriginFrames ?? {}, [mesh?.sam2ContourOriginFrames])
  const contoursAll = mesh?.sam2Contours ?? null
  const skeleton = mesh?.sam2Skeleton ?? { bodyChain: [], legs: [] }

  const totalFrames = useMemo(() => {
    if (!contoursAll) return 0
    const first = Object.values(contoursAll)[0]
    return first?.length ?? 0
  }, [contoursAll])

  // ----- Smoothing params -----
  const [cutoffHz, setCutoffHz] = useState(() => mesh?.sam2SmoothingCutoffHz ?? 4)
  const [smoothedFrames, setSmoothedFrames] = useState<Record<string, Point2D[][]> | null>(
    () => mesh?.sam2SmoothedAnchorFrames ?? null
  )
  const [smoothedSubdivisionFrames, setSmoothedSubdivisionFrames] = useState<Record<string, Point2D[][]> | null>(
    () => mesh?.sam2SmoothedSubdivisionFrames ?? null
  )
  const [smoothedOriginFrames, setSmoothedOriginFrames] = useState<Record<string, Point2D[]> | null>(
    () => mesh?.sam2SmoothedContourOriginFrames ?? null
  )
  const [showRaw, setShowRaw] = useState(false)

  // ----- Playback -----
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)

  // ----- UI state -----
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const isValidated = mesh?.sam2SmoothingValidated === true

  // ----- Video -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)
  const { transformRef, screenToImage: _si, fitToCanvas, isPanning: _ip, spaceDown: _sd } =
    useCanvasInteraction(canvasRef)
  const prevFrameRef = useRef<Sam2SkeletonFrame | null>(null)

  // Active anchor frames (smoothed if available, otherwise raw)
  const activeFrames = useMemo(() => showRaw ? rawAnchorFrames : (smoothedFrames ?? rawAnchorFrames), [showRaw, smoothedFrames, rawAnchorFrames])

  const legRestPoses = useMemo<LegRestPose[]>(() => {
    if (!skeleton.legs.length || !Object.keys(activeFrames).length) return []
    return skeleton.legs.map(leg => computeLegRestPose(leg, activeFrames))
  }, [skeleton.legs, activeFrames])

  // ─── Video loading ────────────────────────────────────────────────────
  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url; video.muted = true; video.playsInline = true; video.preload = 'auto'
    const onReady = () => { videoRef.current = video; setVideoSize({ w: video.videoWidth, h: video.videoHeight }); setVideoReady(true) }
    video.onloadeddata = () => { video.currentTime = 0; video.onseeked = onReady; setTimeout(() => { if (!videoRef.current) onReady() }, 200) }
    video.load()
    return () => { video.pause(); URL.revokeObjectURL(url); videoRef.current = null; fittedRef.current = false; setVideoReady(false) }
  }, [project.videoBlob])

  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

  // ─── Canvas resize ────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current; const canvas = canvasRef.current
    if (!container || !canvas) return
    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr; canvas.height = height * dpr
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ─── Video seek ───────────────────────────────────────────────────────
  useEffect(() => { if (videoReady && videoRef.current) videoRef.current.currentTime = currentFrame / VIDEO_FPS }, [currentFrame, videoReady])

  // ─── Playback ─────────────────────────────────────────────────────────
  useEffect(() => {
    playingRef.current = playing
    if (!playing) return
    const interval = setInterval(() => { if (playingRef.current) setCurrentFrame(f => (f + 1) % Math.max(1, totalFrames)) }, 1000 / VIDEO_FPS)
    return () => clearInterval(interval)
  }, [playing, totalFrames])

  // ─── Compute smoothing ───────────────────────────────────────────────
  const handleCompute = useCallback(() => {
    if (!Object.keys(rawAnchorFrames).length) return
    setComputing(true)
    // Defer to let UI update
    setTimeout(() => {
      // 1. Anchors
      const anchorsOut: Record<string, Point2D[][]> = {}
      for (const zoneId of Object.keys(rawAnchorFrames)) {
        const frames = rawAnchorFrames[zoneId]
        if (!frames || frames.length < 7) { anchorsOut[zoneId] = frames; continue }
        anchorsOut[zoneId] = applyTemporalSmoothing(frames, undefined, cutoffHz, VIDEO_FPS)
      }
      setSmoothedFrames(anchorsOut)

      // 2. Subdivisions (same cutoff, per zone)
      const subsOut: Record<string, Point2D[][]> = {}
      for (const zoneId of Object.keys(rawSubdivisionFrames)) {
        const frames = rawSubdivisionFrames[zoneId]
        if (!frames || frames.length < 7) { subsOut[zoneId] = frames; continue }
        subsOut[zoneId] = applyTemporalSmoothing(frames, undefined, cutoffHz, VIDEO_FPS)
      }
      setSmoothedSubdivisionFrames(Object.keys(subsOut).length > 0 ? subsOut : null)

      // 3. Contour origins (1 point per frame → wrap as frame of length 1)
      const originsOut: Record<string, Point2D[]> = {}
      for (const zoneId of Object.keys(rawContourOriginFrames)) {
        const origins = rawContourOriginFrames[zoneId]
        if (!origins || origins.length < 7) { originsOut[zoneId] = origins; continue }
        const wrapped: Point2D[][] = origins.map(p => [p])
        const smoothed = applyTemporalSmoothing(wrapped, undefined, cutoffHz, VIDEO_FPS)
        originsOut[zoneId] = smoothed.map(f => f[0])
      }
      setSmoothedOriginFrames(Object.keys(originsOut).length > 0 ? originsOut : null)

      setComputing(false)
    }, 0)
  }, [rawAnchorFrames, rawSubdivisionFrames, rawContourOriginFrames, cutoffHz])

  // ─── Save ─────────────────────────────────────────────────────────────
  const handleSave = useCallback(async (validate: boolean) => {
    if (!mesh || !smoothedFrames || saving) return
    setSaving(true)
    try {
      const hints: StepUploadHint[] = ['sam2SmoothedAnchorFrames']
      if (smoothedSubdivisionFrames) hints.push('sam2SmoothedSubdivisionFrames')
      if (smoothedOriginFrames) hints.push('sam2SmoothedContourOriginFrames')
      // Re-validation invalidates downstream V2 steps (silent)
      await onSave({
        ...project,
        mesh: {
          ...mesh,
          sam2SmoothedAnchorFrames: smoothedFrames,
          sam2SmoothedSubdivisionFrames: smoothedSubdivisionFrames,
          sam2SmoothedContourOriginFrames: smoothedOriginFrames,
          sam2SmoothingCutoffHz: cutoffHz,
          sam2SmoothingValidated: validate,
          // Silent downstream invalidation (V2 pipeline)
          ...(validate ? {
            walkBodyFrames: null,
            walkBodyFramesSmoothed: null,
            walkBodyFramesSmoothingValidated: false,
            walkZoneFrames: null,
            walkZoneFramesSmoothed: null,
            walkZoneFramesSmoothingValidated: false,
          } : {}),
        },
      }, hints)
    } finally { setSaving(false) }
  }, [mesh, smoothedFrames, smoothedSubdivisionFrames, smoothedOriginFrames, saving, onSave, project, cutoffHz])

  // ─── Draw loop ────────────────────────────────────────────────────────
  useEffect(() => {
    let running = true; let rafId = 0
    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      if (!canvas || canvas.width === 0) { rafId = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr; const cssH = canvas.height / dpr
      ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save(); ctx.translate(t.offsetX, t.offsetY); ctx.scale(t.scale, t.scale)

      // Video
      const video = videoRef.current
      if (video && videoReady) ctx.drawImage(video, 0, 0)

      // Zone contours
      if (contoursAll) {
        const safeF = Math.max(0, Math.min(totalFrames - 1, currentFrame))
        for (const z of zones) {
          const contour = contoursAll[z.id]?.[safeF]
          if (!contour || contour.length < 3) continue
          ctx.globalAlpha = 0.15; ctx.fillStyle = z.color; ctx.beginPath()
          ctx.moveTo(contour[0].x, contour[0].y)
          for (let i = 1; i < contour.length; i++) ctx.lineTo(contour[i].x, contour[i].y)
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1
        }
      }

      // Skeleton (draw raw in red if showing comparison, active in normal colors) — hidden in V2
      const safeFrame = Math.max(0, Math.min(totalFrames - 1, currentFrame))
      const hasFrames = Object.keys(activeFrames).length > 0

      if (!hideSkeleton) {
        // If showing raw overlay while smoothed exists, draw raw skeleton faintly
        if (showRaw && smoothedFrames && hasFrames && totalFrames > 0) {
          const smoothFrame = resolveSkeletonFrame(skeleton, smoothedFrames, safeFrame, legRestPoses, null)
          drawSkeleton(ctx, t.scale, smoothFrame, skeleton, 0.3, '#888')
        }

        // Active skeleton
        if (hasFrames && totalFrames > 0 && (skeleton.bodyChain.length >= 2 || skeleton.legs.length > 0)) {
          const frame = resolveSkeletonFrame(skeleton, activeFrames, safeFrame, legRestPoses, prevFrameRef.current)
          prevFrameRef.current = frame
          drawSkeleton(ctx, t.scale, frame, skeleton, 1, null)
        }
      }

      // Anchor dots (visual feedback of smoothing effect — always drawn)
      if (hasFrames && totalFrames > 0) {
        const r = 3 / t.scale
        for (const z of zones) {
          const anchors = activeFrames[z.id]?.[safeFrame]
          if (!anchors) continue
          ctx.fillStyle = z.color
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1 / t.scale
          for (const p of anchors) {
            ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          }
        }

        // Overlay raw anchors faintly when comparison
        if (!showRaw && smoothedFrames && Object.keys(rawAnchorFrames).length > 0) {
          ctx.fillStyle = '#ef4444'
          ctx.globalAlpha = 0.35
          const rr = 2.2 / t.scale
          for (const z of zones) {
            const raw = rawAnchorFrames[z.id]?.[safeFrame]
            if (!raw) continue
            for (const p of raw) {
              ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.fill()
            }
          }
          ctx.globalAlpha = 1
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, currentFrame, totalFrames, activeFrames, smoothedFrames, rawAnchorFrames, showRaw, skeleton, legRestPoses, zones, contoursAll, transformRef, hideSkeleton])

  // ─── Guard returns ────────────────────────────────────────────────────
  if (!project.videoBlob) return <div className="placeholder">Importez d'abord une vidéo.</div>
  if (!mesh?.sam2ContourAnchorTrackingValidated) return <div className="placeholder">Validez d'abord le tracking des anchors (étape précédente).</div>

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Lissage Bones</span>

        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem' }}>
          Cutoff
          <input
            type="range" min={1} max={10} step={0.5} value={cutoffHz}
            onChange={e => setCutoffHz(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <span style={{ fontSize: 11, minWidth: 32 }}>{cutoffHz} Hz</span>
        </label>

        <button className="btn-sm btn-secondary" onClick={handleCompute} disabled={computing}>
          {computing ? 'Calcul...' : 'Calculer lissage'}
        </button>

        {smoothedFrames && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />
            Voir brut
          </label>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!isValidated && smoothedFrames && (
            <>
              <button className="btn-secondary" onClick={() => handleSave(false)} disabled={saving}>
                Sauvegarder
              </button>
              <button className="btn-primary" onClick={() => handleSave(true)} disabled={saving}>
                {saving ? 'Validation...' : 'Valider'}
              </button>
            </>
          )}
          {isValidated && (
            <button className="btn-secondary" onClick={() => handleSave(false)}>Rééditer</button>
          )}
        </div>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1, position: 'relative' }}>
        <canvas ref={canvasRef} />
        {isValidated && (
          <div style={{ position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.7)', padding: '4px 10px', borderRadius: 4, fontSize: 12, color: '#4ade80' }}>
            Lissage validé (cutoff {mesh?.sam2SmoothingCutoffHz ?? '?'} Hz)
          </div>
        )}
      </div>

      {totalFrames > 0 && (
        <div style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
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

// ─── Skeleton drawing helper ────────────────────────────────────────────

function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  scale: number,
  frame: Sam2SkeletonFrame,
  skeleton: { bodyChain: { id: string; name: string }[]; legs: { id: string; name: string }[] },
  alpha: number,
  overrideColor: string | null,
) {
  const lineW = 3 / scale
  const jointR = 5 / scale
  ctx.globalAlpha = alpha

  // Body chain segments
  for (let i = 0; i < frame.bodyJoints.length - 1; i++) {
    const a = frame.bodyJoints[i]; const b = frame.bodyJoints[i + 1]
    ctx.strokeStyle = overrideColor ?? getBoneColor(i)
    ctx.lineWidth = lineW; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
  }

  // Body chain joints
  for (let i = 0; i < frame.bodyJoints.length; i++) {
    const p = frame.bodyJoints[i]
    ctx.fillStyle = overrideColor ?? '#fff'
    ctx.strokeStyle = overrideColor ?? getBoneColor(Math.max(0, i - 1))
    ctx.lineWidth = 2 / scale; ctx.beginPath(); ctx.arc(p.x, p.y, jointR, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
  }

  // Legs
  for (let li = 0; li < frame.legs.length; li++) {
    const leg = frame.legs[li]
    const color = overrideColor ?? getBoneColor(skeleton.bodyChain.length + li)
    ctx.strokeStyle = color; ctx.lineWidth = lineW
    ctx.beginPath(); ctx.moveTo(leg.hip.x, leg.hip.y); ctx.lineTo(leg.knee.x, leg.knee.y); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(leg.knee.x, leg.knee.y); ctx.lineTo(leg.foot.x, leg.foot.y); ctx.stroke()

    // Knee square
    const kr = jointR * 1.1
    ctx.fillStyle = overrideColor ?? '#fbbf24'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / scale
    ctx.fillRect(leg.knee.x - kr, leg.knee.y - kr, kr * 2, kr * 2)
    ctx.strokeRect(leg.knee.x - kr, leg.knee.y - kr, kr * 2, kr * 2)
  }

  ctx.globalAlpha = 1
}
