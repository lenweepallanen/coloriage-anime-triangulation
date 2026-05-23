/**
 * CoTracker + Bones — Step 2 : placement & tracking of arbitrary points via CoTracker3.
 *
 * Workflow:
 *  - Upload was done in Step 1 (Vidéo).
 *  - User scrubs the video, clicks on canvas to add tracker points at the current frame.
 *  - Selecting an existing point in the sidebar + clicking on canvas adds a *new prompt*
 *    for that point at the current frame (multi-frame queries — CoTracker3 propagates
 *    forward and backward).
 *  - Right-click on a point deletes it. Drag a prompt to move it.
 *  - "Lancer CoTracker3" sends video + queries → receives per-point trajectories.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Animation, CoTrackerPoint } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { requestCoTracker, type CoTrackerResolution, type CoTrackerEngine } from '../../utils/cotrackerTracking'

interface TimingInfo {
  label: string
  resolution: CoTrackerResolution
  elapsedMs: number
  serverInferenceMs?: number
  interpShapeUsed?: [number, number]
  subsampleUsed?: number
  engineUsed?: CoTrackerEngine
}

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

const PALETTE = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#a855f7', '#ec4899']

export default function CoTrackerBonesTrackingStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoDims, setVideoDims] = useState<{ w: number; h: number; duration: number } | null>(null)
  const [frame, setFrame] = useState(0)
  const fps = 24

  const [points, setPoints] = useState<CoTrackerPoint[]>(mesh?.cotrackerPoints ?? [])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tracking, setTracking] = useState<{ phase: string } | null>(null)
  const [trackedFrames, setTrackedFrames] = useState<Record<string, { x: number; y: number }[]> | null>(
    mesh?.cotrackerFrames ?? null
  )
  const [error, setError] = useState<string | null>(null)
  const [resolution, setResolution] = useState<CoTrackerResolution>('native')
  const [lastTiming, setLastTiming] = useState<TimingInfo | null>(null)

  // Load video blob
  useEffect(() => {
    if (!animation.videoBlob) return
    const url = URL.createObjectURL(animation.videoBlob)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [animation.videoBlob])

  // Capture dimensions
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = () => setVideoDims({ w: v.videoWidth, h: v.videoHeight, duration: v.duration })
    v.addEventListener('loadedmetadata', onMeta)
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [videoUrl])

  const totalFrames = useMemo(() => videoDims ? Math.floor(videoDims.duration * fps) : 0, [videoDims])

  // Seek video on frame change
  useEffect(() => {
    if (!videoRef.current || !videoDims) return
    videoRef.current.currentTime = Math.min(frame / fps, videoDims.duration - 0.001)
  }, [frame, videoDims])

  // Draw overlay
  useEffect(() => {
    const c = canvasRef.current
    const v = videoRef.current
    if (!c || !v || !videoDims) return
    c.width = videoDims.w
    c.height = videoDims.h
    const ctx = c.getContext('2d')
    if (!ctx) return
    const render = () => {
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(v, 0, 0, c.width, c.height)
      const drawLabel = (x: number, y: number, label: string) => {
        ctx.font = 'bold 14px system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        const tx = x + 10
        const ty = y - 10
        const metrics = ctx.measureText(label)
        const padX = 4, padY = 2
        ctx.fillStyle = 'rgba(0,0,0,0.7)'
        ctx.fillRect(tx - padX, ty - 8 - padY, metrics.width + padX * 2, 16 + padY * 2)
        ctx.fillStyle = '#fff'
        ctx.fillText(label, tx, ty)
      }

      // Tracked trajectories (only if no prompt overrides at this frame)
      if (trackedFrames) {
        points.forEach((pt, idx) => {
          const hasPromptHere = pt.prompts.some(q => q.frameIdx === frame)
          if (hasPromptHere) return // drawn below as manual marker
          const traj = trackedFrames[pt.id]
          if (!traj) return
          const f = traj[frame]
          if (!f) return
          ctx.fillStyle = pt.color
          ctx.beginPath()
          ctx.arc(f.x, f.y, 6, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = pt.id === selectedId ? '#fff' : '#000'
          ctx.lineWidth = pt.id === selectedId ? 2 : 1
          ctx.stroke()
          drawLabel(f.x, f.y, String(idx + 1))
        })
      }
      // Manual prompts at current frame — distinctive square + white double ring
      points.forEach((pt, idx) => {
        for (const q of pt.prompts) {
          if (q.frameIdx !== frame) continue
          // Outer white ring (manual marker)
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(q.x, q.y, 11, 0, Math.PI * 2)
          ctx.stroke()
          // Filled square (vs circle for auto-tracked)
          ctx.fillStyle = pt.color
          ctx.fillRect(q.x - 6, q.y - 6, 12, 12)
          ctx.strokeStyle = pt.id === selectedId ? '#fff' : '#000'
          ctx.lineWidth = pt.id === selectedId ? 3 : 1.5
          ctx.strokeRect(q.x - 6, q.y - 6, 12, 12)
          drawLabel(q.x, q.y, String(idx + 1) + '✎')
        }
      })
    }
    let raf = 0
    const tick = () => { render(); raf = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [points, frame, videoDims, selectedId, trackedFrames])

  function canvasToVideo(e: React.MouseEvent<HTMLCanvasElement>) {
    const c = canvasRef.current
    if (!c || !videoDims) return null
    const rect = c.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * videoDims.w
    const y = ((e.clientY - rect.top) / rect.height) * videoDims.h
    return { x, y }
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return
    const pos = canvasToVideo(e)
    if (!pos) return
    if (selectedId) {
      // Add a prompt to the selected point at the current frame
      setPoints(ps => ps.map(p => {
        if (p.id !== selectedId) return p
        const others = p.prompts.filter(q => q.frameIdx !== frame)
        return { ...p, prompts: [...others, { frameIdx: frame, x: pos.x, y: pos.y }].sort((a, b) => a.frameIdx - b.frameIdx) }
      }))
    } else {
      // New point at current frame — pas d'auto-sélection : clic clic clic ajoute plein de points
      const id = crypto.randomUUID()
      const color = PALETTE[points.length % PALETTE.length]
      setPoints(ps => [...ps, {
        id, color,
        name: `pt${ps.length + 1}`,
        prompts: [{ frameIdx: frame, x: pos.x, y: pos.y }],
      }])
      setTrackedFrames(null) // invalidate previous tracking
    }
  }

  function handleCanvasContextMenu(e: React.MouseEvent<HTMLCanvasElement>) {
    e.preventDefault()
    const pos = canvasToVideo(e)
    if (!pos) return
    // Find nearest prompt at current frame to delete its point
    let bestId: string | null = null
    let bestD = 400
    for (const pt of points) {
      const q = pt.prompts.find(qq => qq.frameIdx === frame)
      if (!q) continue
      const d = (q.x - pos.x) ** 2 + (q.y - pos.y) ** 2
      if (d < bestD) { bestD = d; bestId = pt.id }
    }
    if (bestId) {
      setPoints(ps => ps.filter(p => p.id !== bestId))
      if (selectedId === bestId) setSelectedId(null)
      setTrackedFrames(null)
    }
  }

  async function handleRun(mode: 'standard' | 'optimized' = 'standard') {
    if (!animation.videoBlob) { setError('Aucune vidéo'); return }
    if (points.length === 0) { setError('Aucun point à tracker'); return }
    setError(null)
    setTracking({ phase: 'init' })
    try {
      const requestResolution: CoTrackerResolution = mode === 'optimized' ? 'native' : resolution
      const subsample = mode === 'optimized' ? 2 : 1
      const engine: CoTrackerEngine = 'offline'
      const res = await requestCoTracker(animation.videoBlob, points, {
        onPhase: phase => setTracking({ phase }),
        resolution: requestResolution,
        subsample,
        engine,
      })
      setTrackedFrames(res.points)
      setLastTiming({
        label: mode === 'optimized' ? 'CoTracker Optimisé (12 fps + 8 vCPU)' : `CoTracker ${requestResolution}`,
        resolution: res.resolutionUsed,
        elapsedMs: res.elapsedMs,
        serverInferenceMs: res.serverInferenceMs,
        interpShapeUsed: res.interpShapeUsed,
        subsampleUsed: res.subsampleUsed,
        engineUsed: res.engineUsed,
      })
      const updatedAnim: Animation = {
        ...animation,
        mesh: {
          ...(mesh ?? {} as any),
          cotrackerPoints: points,
          cotrackerFrames: res.points,
          cotrackerVideoWidth: res.videoWidth,
          cotrackerVideoHeight: res.videoHeight,
          cotrackerTrackingValidated: true,
          // invalidate downstream
          cotrackerBonesValidated: false,
          cotrackerBoneSmoothingValidated: false,
          walkBodyFrames: null,
          walkBodyFramesSmoothed: null,
          walkZoneFrames: null,
          walkZoneFramesSmoothed: null,
          cotrackerJawOpennessFrames: null,
        },
      }
      await onSave(
        { ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) },
        [{ animationId: animation.id, field: 'cotrackerFrames' }],
      )
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTracking(null)
    }
  }

  async function handleSavePromptsOnly() {
    const updatedAnim: Animation = {
      ...animation,
      mesh: {
        ...(mesh ?? {} as any),
        cotrackerPoints: points,
      },
    }
    await onSave({ ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) })
  }

  if (!animation.videoBlob) {
    return <div className="step-content"><p>Importez d'abord une vidéo à l'étape 1.</p></div>
  }

  return (
    <div className="step-content">
      <h2>CoTracker3 — tracking de points</h2>
      <p className="text-muted">
        Clic gauche : ajouter un point (ou un prompt multi-frame si un point est sélectionné).
        Clic droit : supprimer. Sélectionnez un point dans le panneau, scrubbez à une frame où le tracking dérive,
        et cliquez à la position correcte pour ajouter une correction. Les corrections sont visibles en
        carré ✎ blanc-cerclé, et apparaissent comme tirets sous la timeline. Cliquez « Recalculer » pour
        relancer CoTracker3 avec ces points de référence supplémentaires.
      </p>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <video ref={videoRef} src={videoUrl ?? undefined} style={{ display: 'none' }} muted />
          <canvas
            ref={canvasRef}
            style={{ width: '100%', height: 'auto', background: '#000', cursor: 'crosshair' }}
            onMouseDown={handleCanvasClick}
            onContextMenu={handleCanvasContextMenu}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <button className="btn-secondary" onClick={() => setFrame(0)}>⏮</button>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                type="range"
                min={0}
                max={Math.max(0, totalFrames - 1)}
                value={frame}
                onChange={e => setFrame(Number(e.target.value))}
                style={{ width: '100%', display: 'block' }}
              />
              {/* Tick marks for prompt frames */}
              {totalFrames > 1 && (
                <div style={{ position: 'relative', height: 10, marginTop: -2 }}>
                  {points.flatMap(pt =>
                    pt.prompts.map(pr => {
                      const isSelectedPt = pt.id === selectedId
                      return (
                        <div
                          key={`${pt.id}-${pr.frameIdx}`}
                          onClick={() => setFrame(pr.frameIdx)}
                          title={`${pt.name ?? pt.id.slice(0, 6)} — frame ${pr.frameIdx}`}
                          style={{
                            position: 'absolute',
                            left: `${(pr.frameIdx / (totalFrames - 1)) * 100}%`,
                            transform: 'translateX(-50%)',
                            width: isSelectedPt ? 3 : 2,
                            height: isSelectedPt ? 10 : 6,
                            background: pt.color,
                            border: isSelectedPt ? '1px solid #fff' : 'none',
                            borderRadius: 1,
                            cursor: 'pointer',
                            opacity: selectedId && !isSelectedPt ? 0.35 : 1,
                          }}
                        />
                      )
                    })
                  )}
                </div>
              )}
            </div>
            <span>{frame} / {totalFrames - 1}</span>
          </div>
        </div>
        <aside style={{ width: 280 }}>
          <h3>Points ({points.length})</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 340, overflowY: 'auto' }}>
            {points.map(p => (
              <li
                key={p.id}
                onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                  borderRadius: 6, marginBottom: 4, cursor: 'pointer',
                  background: p.id === selectedId ? '#1e3a5f' : '#222',
                }}
              >
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12 }}>
                  {p.name ?? p.id.slice(0, 6)} — {p.prompts.length} prompt(s)
                  {p.prompts.length > 1 && (
                    <span style={{ display: 'block', fontSize: 10, opacity: 0.7 }}>
                      frames : {p.prompts.map(q => q.frameIdx).join(', ')}
                    </span>
                  )}
                </span>
                <button
                  className="btn-icon btn-sm"
                  onClick={(e) => { e.stopPropagation(); setPoints(ps => ps.filter(pp => pp.id !== p.id)); setTrackedFrames(null) }}
                  title="Supprimer"
                >×</button>
              </li>
            ))}
          </ul>
          {selectedId && (
            <p style={{ fontSize: 11, opacity: 0.8 }}>
              Point sélectionné : cliquez sur le canvas à n'importe quelle frame pour ajouter/modifier le prompt à cette frame.
            </p>
          )}
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, background: '#1a1a1a', borderRadius: 6 }}>
              <span style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: 0.5 }}>Résolution inférence</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="cotracker-resolution"
                  value="native"
                  checked={resolution === 'native'}
                  onChange={() => setResolution('native')}
                  disabled={tracking != null}
                />
                <span>CoTracker natif <span style={{ opacity: 0.6 }}>(résolution vidéo)</span></span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="cotracker-resolution"
                  value="512"
                  checked={resolution === '512'}
                  onChange={() => setResolution('512')}
                  disabled={tracking != null}
                />
                <span>CoTracker 512 <span style={{ opacity: 0.6 }}>(downscale côté long ≤ 512 px)</span></span>
              </label>
            </div>
            <button className="btn-primary" onClick={() => handleRun('standard')} disabled={tracking != null || points.length === 0}>
              {tracking
                ? `CoTracker3… (${tracking.phase})`
                : (trackedFrames ? 'Recalculer (avec corrections)' : 'Lancer CoTracker3')}
            </button>
            <button
              className="btn-secondary"
              onClick={() => handleRun('optimized')}
              disabled={tracking != null || points.length === 0}
              title="12 fps (subsample 2× + interpolation linéaire) sur Cloud Function 8 vCPU"
              style={{ borderColor: '#22c55e', color: '#22c55e' }}
            >
              ⚡ CoTracker Optimisé
            </button>
            <button className="btn-secondary" onClick={handleSavePromptsOnly} disabled={tracking != null}>
              Sauvegarder les prompts (sans tracking)
            </button>
            {error && <p style={{ color: '#f87171', fontSize: 12 }}>{error}</p>}
            {trackedFrames && (
              <p style={{ fontSize: 12, color: '#22c55e' }}>
                ✓ Tracking validé ({Object.keys(trackedFrames).length} trajectoires)
              </p>
            )}
            {lastTiming && (
              <div style={{ fontSize: 12, padding: 8, background: '#0f1d2e', borderRadius: 6, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600, color: '#93c5fd' }}>
                  ⏱ {lastTiming.label}
                </div>
                <div>Temps total : <b>{(lastTiming.elapsedMs / 1000).toFixed(2)} s</b></div>
                {lastTiming.serverInferenceMs != null && (
                  <div>Inférence serveur : <b>{(lastTiming.serverInferenceMs / 1000).toFixed(2)} s</b></div>
                )}
                {lastTiming.interpShapeUsed && (
                  <div style={{ opacity: 0.7 }}>
                    interp_shape modèle : {lastTiming.interpShapeUsed[0]}×{lastTiming.interpShapeUsed[1]} px
                  </div>
                )}
                {lastTiming.subsampleUsed && lastTiming.subsampleUsed > 1 && (
                  <div style={{ opacity: 0.7 }}>
                    subsample : 1 frame sur {lastTiming.subsampleUsed} (interpolation linéaire des frames manquantes)
                  </div>
                )}
                {lastTiming.engineUsed && (
                  <div style={{ opacity: 0.7 }}>moteur : {lastTiming.engineUsed}</div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
