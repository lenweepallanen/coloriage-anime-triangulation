/**
 * MembersBonesV2LegSmoothingStep — V2 étape "Lissage Maillage Pattes".
 *
 * Applies Butterworth temporal smoothing to walkZoneFrames (leg mesh vertices
 * animated by the leg bones). Smoothing runs per leg zone independently.
 * Stores the smoothed version separately so previews can toggle raw / smoothed.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { applyTemporalSmoothing } from '../../utils/trackingConstraints'
import FrameNavigator from '../keyframes/FrameNavigator'
import TriangulationLoopPreview from './TriangulationLoopPreview'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

const VIDEO_FPS = 24
const EMPTY_SET = new Set<number>()

export default function MembersBonesV2LegSmoothingStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation
  const rawZoneFrames = useMemo(() => mesh?.walkZoneFrames ?? null, [mesh?.walkZoneFrames])
  // Body frames (already smoothed if available) for context display only
  const bodyFrames = useMemo(() => mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null, [mesh?.walkBodyFramesSmoothed, mesh?.walkBodyFrames])

  const totalFrames = useMemo(() => {
    if (!rawZoneFrames) return 0
    const first = Object.values(rawZoneFrames)[0]
    return first?.length ?? 0
  }, [rawZoneFrames])

  // ----- Smoothing params -----
  const [cutoffHz, setCutoffHz] = useState(() => mesh?.walkZoneFramesSmoothingCutoffHz ?? 4)
  const [smoothedZoneFrames, setSmoothedZoneFrames] = useState<Record<string, Point2D[][]> | null>(
    () => mesh?.walkZoneFramesSmoothed ?? null
  )
  const [showRaw, setShowRaw] = useState(false)

  // ----- Playback -----
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)

  // ----- UI state -----
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const isValidated = mesh?.walkZoneFramesSmoothingValidated === true

  // ----- Canvas -----
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fittedRef = useRef(false)
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  // Active zone frames (smoothed if available, otherwise raw — unless showRaw forces raw)
  const activeZoneFrames = useMemo(() => {
    if (showRaw) return rawZoneFrames
    return smoothedZoneFrames ?? rawZoneFrames
  }, [showRaw, smoothedZoneFrames, rawZoneFrames])

  // Load project image
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

  useEffect(() => {
    if (imgSize.w > 0 && !fittedRef.current) {
      fittedRef.current = true
      fitToCanvas(imgSize.w, imgSize.h)
    }
  }, [imgSize, fitToCanvas])

  // Canvas resize
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

  // Playback
  useEffect(() => {
    playingRef.current = playing
    if (!playing) return
    const interval = setInterval(() => {
      if (playingRef.current) setCurrentFrame(f => (f + 1) % Math.max(1, totalFrames))
    }, 1000 / VIDEO_FPS)
    return () => clearInterval(interval)
  }, [playing, totalFrames])

  // ─── Compute smoothing per zone ──────────────────────────────────────
  const handleCompute = useCallback(() => {
    if (!rawZoneFrames) return
    setComputing(true)
    setTimeout(() => {
      const result: Record<string, Point2D[][]> = {}
      for (const zoneId of Object.keys(rawZoneFrames)) {
        const frames = rawZoneFrames[zoneId]
        if (!frames || frames.length < 7) { result[zoneId] = frames; continue }
        result[zoneId] = applyTemporalSmoothing(frames, undefined, cutoffHz, VIDEO_FPS)
      }
      setSmoothedZoneFrames(result)
      setComputing(false)
    }, 0)
  }, [rawZoneFrames, cutoffHz])

  // ─── Save ────────────────────────────────────────────────────────────
  const handleSave = useCallback(async (validate: boolean) => {
    if (!mesh || !smoothedZoneFrames || saving) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        walkZoneFramesSmoothed: smoothedZoneFrames,
        walkZoneFramesSmoothingCutoffHz: cutoffHz,
        walkZoneFramesSmoothingValidated: validate,
      }
      const updatedAnimations = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave(
        { ...project, animations: updatedAnimations },
        [{ animationId: animation.id, field: 'walkZoneFramesSmoothed' }],
      )
    } finally { setSaving(false) }
  }, [mesh, smoothedZoneFrames, saving, onSave, project, animation, cutoffHz])

  // ─── Draw loop ───────────────────────────────────────────────────────
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
      ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save(); ctx.translate(t.offsetX, t.offsetY); ctx.scale(t.scale, t.scale)

      if (imageRef.current) ctx.drawImage(imageRef.current, 0, 0)

      const safeF = Math.max(0, Math.min(totalFrames - 1, currentFrame))

      // Body wireframe (context)
      if (bodyFrames && tri?.bodyTriangles) {
        const bpts = bodyFrames[safeF]
        if (bpts) {
          ctx.strokeStyle = '#22c55e'
          ctx.lineWidth = 0.4 / t.scale
          ctx.globalAlpha = 0.3
          for (const [ia, ib, ic] of tri.bodyTriangles) {
            if (ia >= bpts.length || ib >= bpts.length || ic >= bpts.length) continue
            const a = bpts[ia], b = bpts[ib], c = bpts[ic]
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.stroke()
          }
          ctx.globalAlpha = 1
        }
      }

      // Leg zone wireframes (active)
      if (activeZoneFrames && tri) {
        for (const zone of tri.zones) {
          if (zone.id === 'body') continue
          const pts = activeZoneFrames[zone.id]?.[safeF]
          const tris = tri.zoneTriangles[zone.id]
          if (!pts || !tris) continue
          ctx.strokeStyle = showRaw ? '#ef4444' : zone.color
          ctx.lineWidth = 0.6 / t.scale
          ctx.globalAlpha = 0.7
          for (const [ia, ib, ic] of tris) {
            if (ia >= pts.length || ib >= pts.length || ic >= pts.length) continue
            const a = pts[ia], b = pts[ib], c = pts[ic]
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.stroke()
          }
          ctx.globalAlpha = 1
        }

        // Overlay raw as faint red when showing smoothed (comparison)
        if (!showRaw && smoothedZoneFrames && rawZoneFrames) {
          for (const zone of tri.zones) {
            if (zone.id === 'body') continue
            const pts = rawZoneFrames[zone.id]?.[safeF]
            const tris = tri.zoneTriangles[zone.id]
            if (!pts || !tris) continue
            ctx.strokeStyle = '#ef4444'
            ctx.lineWidth = 0.5 / t.scale
            ctx.globalAlpha = 0.25
            for (const [ia, ib, ic] of tris) {
              if (ia >= pts.length || ib >= pts.length || ic >= pts.length) continue
              const a = pts[ia], b = pts[ib], c = pts[ic]
              ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.stroke()
            }
            ctx.globalAlpha = 1
          }
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [activeZoneFrames, currentFrame, totalFrames, showRaw, smoothedZoneFrames, rawZoneFrames, bodyFrames, tri, transformRef])

  // ─── Guard returns ──────────────────────────────────────────────────
  if (!rawZoneFrames) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>Calculez d&apos;abord l&apos;animation des pattes (étape précédente).</p>
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Lissage Maillage Pattes</span>

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

        {smoothedZoneFrames && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />
            Voir brut
          </label>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {!isValidated && smoothedZoneFrames && (
            <>
              <button className="btn-secondary" onClick={() => handleSave(false)} disabled={saving}>Sauvegarder</button>
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
            Lissage validé (cutoff {mesh?.walkZoneFramesSmoothingCutoffHz ?? '?'} Hz)
          </div>
        )}
      </div>

      {totalFrames > 0 && (
        <div style={{ padding: '6px 16px', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
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
      <TriangulationLoopPreview project={project} animation={animation} />
    </div>
  )
}
