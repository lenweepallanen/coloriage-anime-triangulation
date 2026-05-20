import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { Project, Animation, WalkParams, CoTrackerSkeleton, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeMarcheBoneFrames, type MarcheSolverInput } from '../../utils/marcheSolver'
import { DEFAULT_WALK_PARAMS } from '../../utils/walkSolver'
import { solveElbowIK } from '../../utils/boneSolver'

const FPS = 24
const CYCLES_PER_ANIM = 4

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/**
 * Étape 3 — Sliders WalkParams + preview live + bouton calcul.
 * Calcule walkBodyFrames + walkZoneFrames via marcheSolver et les sauvegarde.
 */
export default function MarcheParamsStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const triangulation = project.projectTriangulation
  const skeleton = mesh?.marcheSkeleton

  const [params, setParams] = useState<WalkParams>(
    () => mesh?.walkParams ?? { ...DEFAULT_WALK_PARAMS },
  )
  const [legPhases, setLegPhases] = useState<Record<string, number>>(
    () => ({ ...(mesh?.marcheLegPhases ?? {}) }),
  )
  const [playing, setPlaying] = useState(true)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)
  const timeRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)

  // Mask coords (cohérent avec bodyPoints/zonePoints + bones stockés)
  const maskW = project.projectTriangulation?.maskWidth ?? 1
  const maskH = project.projectTriangulation?.maskHeight ?? 1

  // Load original image
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImageLoaded(true)
      requestAnimationFrame(() => fitToCanvas(maskW, maskH))
    }
    img.src = url
    return () => {
      imageRef.current = null
      setImageLoaded(false)
      URL.revokeObjectURL(url)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob, maskW, maskH])

  const solverInput: MarcheSolverInput | null = useMemo(() => {
    if (!skeleton || !mesh?.marcheBodyJointRestPositions || !mesh?.marcheLegRestPositions || !triangulation) return null
    return {
      skeleton,
      bodyJointRest: mesh.marcheBodyJointRestPositions,
      legRest: mesh.marcheLegRestPositions,
      gaitLegIds: mesh.marcheGaitLegIds ?? [],
      params,
      triangulation,
      legPhases,
    }
  }, [skeleton, mesh, triangulation, params, legPhases])

  // Live preview: animate the skeleton in real time (without LBS, just bones)
  const duration = CYCLES_PER_ANIM / Math.max(params.speed, 0.01)

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const img = imageRef.current
    if (!canvas || !ctx || !img || !skeleton || !mesh?.marcheBodyJointRestPositions || !mesh?.marcheLegRestPositions) {
      animFrameRef.current = requestAnimationFrame(draw)
      return
    }

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
    ctx.globalAlpha = 0.3
    ctx.drawImage(img, 0, 0, maskW, maskH)
    ctx.globalAlpha = 1

    // Compute current bones live (only the skeleton — not the LBS mesh)
    const livePositions = computeLiveBones(
      skeleton, mesh.marcheBodyJointRestPositions, mesh.marcheLegRestPositions,
      mesh.marcheGaitLegIds ?? [], params, cyclePhase, legPhases,
    )

    // Draw body chain (cyan)
    ctx.strokeStyle = '#06b6d4'
    ctx.lineWidth = 4 / t.scale
    ctx.beginPath()
    livePositions.body.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.stroke()

    // Draw legs (color per leg, gait highlighted brighter)
    skeleton.legs.forEach((leg, li) => {
      const chain = livePositions.legs[leg.id]
      if (!chain) return
      const isGait = (mesh.marcheGaitLegIds ?? []).includes(leg.id)
      const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']
      ctx.strokeStyle = palette[li % palette.length]
      ctx.lineWidth = (isGait ? 4 : 2) / t.scale
      ctx.beginPath()
      chain.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
      ctx.stroke()

      // Joints
      ctx.fillStyle = palette[li % palette.length]
      const r = 4 / t.scale
      for (const p of chain) {
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill()
      }
    })

    // Body joints
    ctx.fillStyle = '#06b6d4'
    const rb = 5 / t.scale
    for (const p of livePositions.body) {
      ctx.beginPath(); ctx.arc(p.x, p.y, rb, 0, Math.PI * 2); ctx.fill()
    }

    ctx.restore()

    animFrameRef.current = requestAnimationFrame(draw)
  }, [skeleton, mesh, params, playing, duration, transformRef, legPhases])

  useEffect(() => {
    lastTimeRef.current = 0
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // Sync legPhases when gait selection changes (fill defaults for new legs)
  useEffect(() => {
    if (!skeleton) return
    const gaitSet = new Set(mesh?.marcheGaitLegIds ?? [])
    const gaitList = skeleton.legs.filter(l => gaitSet.has(l.id))
    const nonGaitList = skeleton.legs.filter(l => !gaitSet.has(l.id))
    setLegPhases(prev => {
      const next = { ...prev }
      for (const leg of skeleton.legs) {
        if (next[leg.id] != null) continue
        const isGait = gaitSet.has(leg.id)
        const list = isGait ? gaitList : nonGaitList
        const i = list.findIndex(l => l.id === leg.id)
        if (isGait) {
          next[leg.id] = list.length === 4 ? [0, 0.5, 0.25, 0.75][i] : i / Math.max(1, list.length)
        } else {
          next[leg.id] = (Math.abs(hashLegId(leg.id)) % 100) * 0.0137 % 1
        }
      }
      return next
    })
  }, [skeleton, mesh?.marcheGaitLegIds])

  async function handleCompute() {
    if (!solverInput || !mesh || !skeleton) return
    setSaving(true)
    setProgress(0)
    try {
      const result = computeMarcheBoneFrames(solverInput)

      // Map bone frames keyed by leg.id → keyed by zoneId, matching the
      // cotrackerLegBoneFrames structure expected by the LBS step.
      const legBoneFrames: Record<string, { chain: Point2D[][] }> = {}
      for (const leg of skeleton.legs) {
        const chain = result.legChainFramesByLegId[leg.id]
        if (chain) legBoneFrames[leg.zoneId] = { chain }
      }

      // Make the marche animation look like a validated cotracker-bones to
      // downstream steps (LBS / Calcul Animation / Preview) without touching
      // its own type. cotrackerVideoWidth/Height = image dims so video↔image
      // conversion is identity inside runCoTrackerLBSCompute.
      const imgW = project.projectTriangulation?.maskWidth ?? 1
      const imgH = project.projectTriangulation?.maskHeight ?? 1

      const updatedMesh = {
        ...mesh,
        walkParams: params,
        walkParamsValidated: true,
        marcheLegPhases: legPhases,
        // Bone joint frames (consumed by Calcul Animation smoothing step)
        cotrackerSkeleton: skeleton,
        cotrackerBodyJointFrames: result.bodyJointFramesImg,
        cotrackerLegBoneFrames: legBoneFrames,
        cotrackerBodyJointFramesSmoothed: null,
        cotrackerLegBoneFramesSmoothed: null,
        cotrackerBoneSmoothingValidated: false,
        // Mark the cotracker pipeline gates as ready (the marche tracking IS the
        // kinematic compute we just ran).
        cotrackerBonesValidated: true,
        cotrackerTrackingValidated: true,
        cotrackerVideoWidth: imgW,
        cotrackerVideoHeight: imgH,
        cotrackerFrames: {},  // empty — not used when override is passed
        // Invalidate downstream mesh — user must re-run LBS step.
        walkBodyFrames: null,
        walkZoneFrames: null,
        walkBodyFramesSmoothed: null,
        walkZoneFramesSmoothed: null,
        cotrackerLBSValidated: false,
        walkBodyFramesSmoothingValidated: false,
        walkZoneFramesSmoothingValidated: false,
        videoFramesMesh: null,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a,
      )
      await onSave({ ...project, animations: updatedAnims })
      setProgress(1)
    } finally {
      setSaving(false)
      setTimeout(() => setProgress(null), 500)
    }
  }

  if (!triangulation?.step3Validated) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>La Triangulation projet doit être validée jusqu'aux Faces cachées.</div>
  }
  if (!skeleton || !mesh?.marcheInheritValidated) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>Hérite d'abord un squelette à l'étape <strong>Hériter bones</strong>.</div>
  }
  if (!mesh.marcheGaitLegsValidated) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>Sélectionne les pattes du cycle à l'étape <strong>Pattes</strong>.</div>
  }
  if (!imageLoaded && !project.originalImageBlob) {
    return <div style={{ padding: 20, color: '#9ca3af' }}>Importe l'image du coloriage avant de paramétrer la marche.</div>
  }

  const totalFrames = Math.max(2, Math.round(CYCLES_PER_ANIM / Math.max(params.speed, 0.01) * FPS))

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            aspectRatio: `${maskW} / ${maskH}`,
            maxHeight: '70vh',
            display: 'block',
            borderRadius: 8,
          }}
        />
        <div style={{ display: 'flex', gap: 8, padding: '8px 0', alignItems: 'center' }}>
          <button className="btn-sm btn-secondary" onClick={() => setPlaying(!playing)}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="btn-sm btn-secondary" onClick={() => { timeRef.current = 0 }}>⏮ Reset</button>
          <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 8 }}>
            Durée: {duration.toFixed(1)}s ({totalFrames} frames)
          </span>
          {mesh.cotrackerBodyJointFrames && (
            <span style={{ color: '#22c55e', fontSize: 12, marginLeft: 8 }}>
              ✓ {mesh.cotrackerBodyJointFrames[0]?.length ?? 0} frames bones — passe à <strong>LBS</strong>
            </span>
          )}
        </div>
      </div>

      <div style={{ width: 280, flexShrink: 0 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>Paramètres de marche</h3>

        <Slider label="Vitesse" unit="cycles/s" value={params.speed} min={0.3} max={3} step={0.1}
          onChange={v => setParams({ ...params, speed: v })} />
        <Slider label="Amplitude du pas" unit="px" value={params.strideLength} min={10} max={400} step={5}
          onChange={v => setParams({ ...params, strideLength: v })} />
        <Slider label="Levé de pied" unit="px" value={params.footLift} min={5} max={200} step={5}
          onChange={v => setParams({ ...params, footLift: v })} />
        <Slider label="Oscillation corps" unit="px" value={params.bodySway} min={0} max={30} step={1}
          onChange={v => setParams({ ...params, bodySway: v })} />
        <Slider label="Oscillation cou/tête" unit="%" value={params.headSway ?? 50} min={0} max={100} step={5}
          onChange={v => setParams({ ...params, headSway: v })} />
        <Slider label="Oscillation secondaire (membres non-gait)" unit="%" value={params.secondarySway ?? 30} min={0} max={100} step={5}
          onChange={v => setParams({ ...params, secondarySway: v })} />
        <Slider label="Saut / rebond" unit="px" value={params.jumpHeight ?? 0} min={0} max={300} step={5}
          onChange={v => setParams({ ...params, jumpHeight: v })} />

        {skeleton && (
          <PhaseEditor
            skeleton={skeleton}
            gaitIds={mesh?.marcheGaitLegIds ?? []}
            legPhases={legPhases}
            onChange={setLegPhases}
          />
        )}

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 6 }}>Sens de marche</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className={`btn-sm ${(params.direction ?? 1) === -1 ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setParams({ ...params, direction: -1 })}
              style={{ flex: 1 }}
            >← Gauche</button>
            <button
              type="button"
              className={`btn-sm ${(params.direction ?? 1) === 1 ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setParams({ ...params, direction: 1 })}
              style={{ flex: 1 }}
            >Droite →</button>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input type="checkbox" checked={params.kneeForwardFront ?? false}
              onChange={e => setParams({ ...params, kneeForwardFront: e.target.checked })} />
            Pattes avant : genoux vers l'avant
          </label>
          <label style={{ fontSize: 13, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={params.kneeForwardBack ?? false}
              onChange={e => setParams({ ...params, kneeForwardBack: e.target.checked })} />
            Pattes arrière : genoux vers l'avant
          </label>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <button className="btn-primary" onClick={handleCompute} disabled={saving} style={{ width: '100%' }}>
          {saving
            ? (progress != null ? `Calcul… ${Math.round(progress * 100)}%` : 'Sauvegarde…')
            : 'Calculer et sauvegarder'}
        </button>
      </div>
    </div>
  )
}

function Slider({
  label, unit, value, min, max, step, onChange,
}: { label: string; unit: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 4 }}>
        {label} : {value.toFixed(step < 1 ? 1 : 0)} {unit}
      </label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} style={{ width: '100%' }} />
    </div>
  )
}

function PhaseEditor({
  skeleton, gaitIds, legPhases, onChange,
}: {
  skeleton: CoTrackerSkeleton
  gaitIds: string[]
  legPhases: Record<string, number>
  onChange: (next: Record<string, number>) => void
}) {
  const gaitSet = new Set(gaitIds)
  const gaitLegs = skeleton.legs.filter(l => gaitSet.has(l.id))
  const nonGaitLegs = skeleton.legs.filter(l => !gaitSet.has(l.id))

  function setPhase(id: string, v: number) { onChange({ ...legPhases, [id]: v }) }
  function setAll(ids: string[], v: number) {
    const next = { ...legPhases }
    for (const id of ids) next[id] = v
    onChange(next)
  }

  return (
    <>
      {gaitLegs.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #374151' }}>
          <div style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 600, marginBottom: 6 }}>
            Phases — pattes en marche ({gaitLegs.length})
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <button className="btn-sm btn-secondary" onClick={() => setAll(gaitLegs.map(l => l.id), 0)} style={{ flex: 1, fontSize: 11 }}>Sync (kangourou)</button>
            <button className="btn-sm btn-secondary"
              onClick={() => {
                const next = { ...legPhases }
                const preset = gaitLegs.length === 4 ? [0, 0.5, 0.25, 0.75] : null
                gaitLegs.forEach((l, i) => {
                  next[l.id] = preset ? preset[i] : i / Math.max(1, gaitLegs.length)
                })
                onChange(next)
              }}
              style={{ flex: 1, fontSize: 11 }}>Quadrupède</button>
          </div>
          {gaitLegs.map(leg => (
            <PhaseRow key={leg.id} label={leg.name} value={legPhases[leg.id] ?? 0}
              onChange={v => setPhase(leg.id, v)} />
          ))}
        </div>
      )}

      {nonGaitLegs.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #374151' }}>
          <div style={{ fontSize: 13, color: '#e5e7eb', fontWeight: 600, marginBottom: 6 }}>
            Phases — membres secondaires ({nonGaitLegs.length})
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <button className="btn-sm btn-secondary" onClick={() => setAll(nonGaitLegs.map(l => l.id), 0)} style={{ flex: 1, fontSize: 11 }}>Sync</button>
            <button className="btn-sm btn-secondary" onClick={() => setAll(nonGaitLegs.map(l => l.id), 0.5)} style={{ flex: 1, fontSize: 11 }}>Opposés</button>
          </div>
          {nonGaitLegs.map(leg => (
            <PhaseRow key={leg.id} label={leg.name} value={legPhases[leg.id] ?? 0}
              onChange={v => setPhase(leg.id, v)} />
          ))}
        </div>
      )}
    </>
  )
}

function PhaseRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={{ fontSize: 11, color: '#9ca3af', width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <input type="range" min={0} max={1} step={0.01} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: '#6b7280', width: 32, textAlign: 'right' }}>{value.toFixed(2)}</span>
    </div>
  )
}

// ─── Light-weight live bone computation (no LBS, no zone deformation) ───

interface LivePositions {
  body: Point2D[]
  legs: Record<string, Point2D[]>
}

export function hashLegId(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function computeLiveBones(
  skeleton: CoTrackerSkeleton,
  bodyRest: Point2D[],
  legRest: Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }>,
  gaitIds: string[],
  params: WalkParams,
  cyclePhase: number,
  legPhases: Record<string, number>,
): LivePositions {
  const STANCE = 0.6
  const bodyDy = -params.bodySway * Math.sin(2 * Math.PI * 2 * cyclePhase)
  const tilt = (params.bodySway / 200) * Math.sin(2 * Math.PI * cyclePhase)
  let bcx = 0, bcy = 0
  for (const p of bodyRest) { bcx += p.x; bcy += p.y }
  bcx /= Math.max(1, bodyRest.length)
  bcy /= Math.max(1, bodyRest.length)

  // Jump
  const jumpAmp = params.jumpHeight ?? 0
  const gaitSet = new Set(gaitIds)
  const gaitListLeg = skeleton.legs.filter(l => gaitSet.has(l.id) && legRest[l.id])
  let jumpDy = 0
  if (jumpAmp > 0 && gaitListLeg.length > 0) {
    let sum = 0
    for (const leg of gaitListLeg) {
      const phase = (cyclePhase + (legPhases[leg.id] ?? 0)) % 1
      if (phase >= STANCE) {
        const air = (phase - STANCE) / (1 - STANCE)
        sum += Math.sin(Math.PI * air)
      }
    }
    jumpDy = -jumpAmp * (sum / gaitListLeg.length)
  }
  const totalDy = bodyDy + jumpDy
  const center = { x: bcx, y: bcy + totalDy }
  const applyBody = (p: Point2D): Point2D => {
    const shifted = { x: p.x, y: p.y + totalDy }
    const dx = shifted.x - center.x, dy = shifted.y - center.y
    const cs = Math.cos(tilt), sn = Math.sin(tilt)
    return { x: center.x + cs * dx - sn * dy, y: center.y + sn * dx + cs * dy }
  }
  const body = bodyRest.map(applyBody)
  // head sway
  if (body.length >= 2 && (params.headSway ?? 0) > 0) {
    const tail = body[body.length - 1]; const prev = body[body.length - 2]
    const dx = tail.x - prev.x, dy = tail.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    const perpX = -dy / len, perpY = dx / len
    const amp = ((params.headSway ?? 0) / 100) * params.bodySway * 1.2
    const osc = amp * Math.sin(2 * Math.PI * cyclePhase + Math.PI / 4)
    body[body.length - 1] = { x: tail.x + perpX * osc, y: tail.y + perpY * osc }
  }

  const legs: Record<string, Point2D[]> = {}
  for (const leg of skeleton.legs) {
    const r = legRest[leg.id]
    if (!r) continue
    const hipC = applyBody(r.hip)
    let footC: Point2D
    if (gaitSet.has(leg.id)) {
      const baseFoot = jumpAmp > 0 ? r.foot : applyBody(r.foot)
      const phase = (cyclePhase + (legPhases[leg.id] ?? 0)) % 1
      const stride = params.strideLength * (params.direction ?? 1)
      if (phase < STANCE) {
        const t = phase / STANCE
        footC = { x: baseFoot.x + stride * (0.5 - t), y: baseFoot.y }
      } else {
        const air = (phase - STANCE) / (1 - STANCE)
        footC = {
          x: baseFoot.x + stride * (-0.5 + air),
          y: baseFoot.y - params.footLift * Math.sin(Math.PI * air),
        }
      }
    } else {
      const moved = applyBody(r.foot)
      const amp = ((params.secondarySway ?? 30) / 100)
      const hipFoot = { x: r.foot.x - r.hip.x, y: r.foot.y - r.hip.y }
      const lenHF = Math.hypot(hipFoot.x, hipFoot.y) || 1
      const perpX = -hipFoot.y / lenHF, perpY = hipFoot.x / lenHF
      const phi = 2 * Math.PI * (cyclePhase + (legPhases[leg.id] ?? 0))
      const lateral = amp * params.strideLength * 0.40 * Math.sin(phi)
      const bob = amp * params.footLift * 1.00 * Math.sin(phi * 2 + Math.PI / 3)
      footC = { x: moved.x + perpX * lateral, y: moved.y + perpY * lateral - bob }
    }
    // Clamp foot so hip→foot ≤ totalRestLen (preserve sub-bone lengths)
    const allRest = [r.hip, ...r.joints, r.foot]
    let totalRest = 0
    for (let i = 0; i < allRest.length - 1; i++) {
      totalRest += Math.hypot(allRest[i + 1].x - allRest[i].x, allRest[i + 1].y - allRest[i].y)
    }
    const dxLP = footC.x - hipC.x, dyLP = footC.y - hipC.y
    const dLP = Math.hypot(dxLP, dyLP)
    if (dLP > totalRest && dLP > 0) {
      const s = totalRest / dLP
      footC = { x: hipC.x + dxLP * s, y: hipC.y + dyLP * s }
    }

    const chain: Point2D[] = [hipC]
    if (r.joints.length === 1) {
      const thigh = Math.hypot(r.joints[0].x - r.hip.x, r.joints[0].y - r.hip.y)
      const shin = Math.hypot(r.foot.x - r.joints[0].x, r.foot.y - r.joints[0].y)
      const isFront = skeleton.legs.indexOf(leg) < skeleton.legs.length / 2
      const flipKnee = (isFront ? params.kneeForwardFront : params.kneeForwardBack) ? -1 : 1
      const cross = (r.joints[0].x - r.hip.x) * (r.foot.y - r.hip.y) - (r.joints[0].y - r.hip.y) * (r.foot.x - r.hip.x)
      const side = (cross >= 0 ? 1 : -1) * flipKnee
      chain.push(solveElbowIK(hipC, footC, thigh, shin, side))
    } else if (r.joints.length > 1) {
      // Proportional interpolation
      const segs: number[] = []
      const all = [r.hip, ...r.joints, r.foot]
      let total = 0
      for (let i = 0; i < all.length - 1; i++) {
        const l = Math.hypot(all[i + 1].x - all[i].x, all[i + 1].y - all[i].y)
        segs.push(l); total += l
      }
      let cumul = 0
      for (let i = 0; i < r.joints.length; i++) {
        cumul += segs[i]
        const t = cumul / Math.max(total, 1e-6)
        chain.push({ x: hipC.x + (footC.x - hipC.x) * t, y: hipC.y + (footC.y - hipC.y) * t })
      }
    }
    chain.push(footC)
    legs[leg.id] = chain
  }

  return { body, legs }
}
