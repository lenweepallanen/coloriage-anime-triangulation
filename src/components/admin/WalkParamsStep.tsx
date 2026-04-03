import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project, Animation, WalkParams } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import {
  computeWalkBonePositions, DEFAULT_WALK_PARAMS, WALK_PRESETS, buildWalkSkeleton,
} from '../../utils/walkSolver'

const FPS = 24
const CYCLES_PER_ANIM = 4

// Bone segments for drawing
const BONE_SEGMENTS: [number, number][] = [
  [0, 1], [1, 2], [3, 4], [4, 5],
  [6, 7], [7, 8], [9, 10], [10, 11],
  [12, 13], [13, 14], [15, 16], [16, 17],
]

const GROUP_COLORS = [
  '#3b82f6', '#3b82f6', '#3b82f6',
  '#22c55e', '#22c55e', '#22c55e',
  '#f59e0b', '#f59e0b', '#f59e0b',
  '#ef4444', '#ef4444', '#ef4444',
  '#a855f7', '#a855f7', '#a855f7',
  '#14b8a6', '#14b8a6', '#14b8a6',
]

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function WalkParamsStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const skeleton = mesh?.walkSkeleton

  const [params, setParams] = useState<WalkParams>(
    mesh?.walkParams ?? { ...DEFAULT_WALK_PARAMS }
  )
  const [legPhases, setLegPhases] = useState<[number, number, number, number]>(() => {
    if (skeleton) return skeleton.legs.map(l => l.phaseOffset) as [number, number, number, number]
    return [...WALK_PRESETS.walk]
  })
  const [playing, setPlaying] = useState(true)
  const [saving, setSaving] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)
  const timeRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)

  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      requestAnimationFrame(() => fitToCanvas(img.width, img.height))
    }
    img.src = url
    return () => {
      imageRef.current = null
      URL.revokeObjectURL(url)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalFrames = Math.round(CYCLES_PER_ANIM / params.speed * FPS)
  const duration = CYCLES_PER_ANIM / params.speed

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const img = imageRef.current
    if (!canvas || !ctx || !img || !skeleton) return

    // Advance time
    if (playing) {
      const dt = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 0
      timeRef.current = (timeRef.current + dt) % duration
    }
    lastTimeRef.current = timestamp

    const cyclePhase = (timeRef.current * params.speed) % 1

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

    // Image (dimmed)
    ctx.globalAlpha = 0.3
    ctx.drawImage(img, 0, 0)
    ctx.globalAlpha = 1

    // Compute bone positions with current leg phases
    const currentSkeleton = buildWalkSkeleton(skeleton.keyPoints, legPhases)
    const bonePos = computeWalkBonePositions(currentSkeleton, params, cyclePhase)
    const kp = bonePos.keyPoints

    // Draw bone segments
    ctx.lineWidth = 3 / t.scale
    for (const [hi, ti] of BONE_SEGMENTS) {
      if (!kp[hi] || !kp[ti]) continue
      ctx.strokeStyle = GROUP_COLORS[hi]
      ctx.beginPath()
      ctx.moveTo(kp[hi].x, kp[hi].y)
      ctx.lineTo(kp[ti].x, kp[ti].y)
      ctx.stroke()
    }

    // Spine
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.lineWidth = 3 / t.scale
    ctx.setLineDash([6 / t.scale, 4 / t.scale])
    ctx.beginPath()
    ctx.moveTo(bonePos.spineFront.x, bonePos.spineFront.y)
    ctx.lineTo(bonePos.spineBack.x, bonePos.spineBack.y)
    ctx.stroke()
    ctx.setLineDash([])

    // Draw keypoints
    const pr = 5 / t.scale
    for (let i = 0; i < kp.length; i++) {
      if (!kp[i]) continue
      ctx.fillStyle = GROUP_COLORS[i] || '#fff'
      ctx.beginPath()
      ctx.arc(kp[i].x, kp[i].y, pr, 0, Math.PI * 2)
      ctx.fill()
    }

    // Ground line (at foot rest Y)
    if (skeleton.legs.length > 0) {
      const footY = Math.max(
        ...skeleton.legs.map(l => skeleton.keyPoints[l.footIndex].y)
      )
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)'
      ctx.lineWidth = 1 / t.scale
      ctx.beginPath()
      ctx.moveTo(0, footY)
      ctx.lineTo(img.width, footY)
      ctx.stroke()
    }

    ctx.restore()

    animFrameRef.current = requestAnimationFrame(draw)
  }, [skeleton, params, legPhases, playing, duration, transformRef])

  useEffect(() => {
    lastTimeRef.current = 0
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  async function handleValidate() {
    if (!mesh || !skeleton) return
    const updatedSkeleton = buildWalkSkeleton(skeleton.keyPoints, legPhases)
    const updatedMesh = {
      ...mesh,
      walkSkeleton: updatedSkeleton,
      walkParams: params,
      walkParamsValidated: true,
      videoFramesMesh: null,
    }
    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, mesh: updatedMesh } : a
    )
    setSaving(true)
    await onSave({ ...project, animations: updatedAnims })
    setSaving(false)
  }

  if (!skeleton || !mesh?.walkSkeletonValidated) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>Validez d'abord le squelette de marche.</div>
  }

  if (!mesh.walkBodyValidated) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>Sélectionnez d'abord les triangles du corps.</div>
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: 500, display: 'block', borderRadius: 8 }}
        />
        <div style={{ display: 'flex', gap: 8, padding: '8px 0', alignItems: 'center' }}>
          <button className="btn-sm btn-secondary" onClick={() => setPlaying(!playing)}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="btn-sm btn-secondary" onClick={() => { timeRef.current = 0 }}>
            ⏮ Reset
          </button>
          <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 8 }}>
            Durée: {duration.toFixed(1)}s ({totalFrames} frames)
          </span>
        </div>
      </div>

      <div style={{ width: 280, flexShrink: 0 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Paramètres de marche</h3>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Vitesse : {params.speed.toFixed(1)} cycles/s
          </label>
          <input
            type="range" min={0.3} max={3} step={0.1}
            value={params.speed}
            onChange={e => setParams({ ...params, speed: parseFloat(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Amplitude du pas : {params.strideLength}px
          </label>
          <input
            type="range" min={10} max={200} step={5}
            value={params.strideLength}
            onChange={e => setParams({ ...params, strideLength: parseInt(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Levé de pied : {params.footLift}px
          </label>
          <input
            type="range" min={5} max={100} step={5}
            value={params.footLift}
            onChange={e => setParams({ ...params, footLift: parseInt(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Oscillation corps : {params.bodySway}px
          </label>
          <input
            type="range" min={0} max={30} step={1}
            value={params.bodySway}
            onChange={e => setParams({ ...params, bodySway: parseInt(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
            Oscillation cou/tête : {params.headSway ?? 50}%
          </label>
          <input
            type="range" min={0} max={100} step={5}
            value={params.headSway ?? 50}
            onChange={e => setParams({ ...params, headSway: parseInt(e.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: '#e5e7eb' }}>
            Déphasage des pattes
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {(['walk', 'trot', 'gallop'] as const).map(p => (
              <button
                key={p}
                className="btn-sm btn-secondary"
                onClick={() => setLegPhases([...WALK_PRESETS[p]])}
                style={{ textTransform: 'capitalize', fontSize: 11 }}
              >
                {p === 'walk' ? 'Marche' : p === 'trot' ? 'Trot' : 'Galop'}
              </button>
            ))}
          </div>
          {['AV gauche', 'AV droite', 'AR gauche', 'AR droite'].map((label, i) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, color: '#9ca3af', width: 70 }}>{label}</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={legPhases[i]}
                onChange={e => {
                  const newPhases = [...legPhases] as [number, number, number, number]
                  newPhases[i] = parseFloat(e.target.value)
                  setLegPhases(newPhases)
                }}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 11, color: '#6b7280', width: 30 }}>
                {legPhases[i].toFixed(2)}
              </span>
            </div>
          ))}
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <button
          className="btn-primary"
          onClick={handleValidate}
          disabled={saving}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider les paramètres'}
        </button>
      </div>
    </div>
  )
}
