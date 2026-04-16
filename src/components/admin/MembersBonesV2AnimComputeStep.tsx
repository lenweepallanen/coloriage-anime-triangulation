import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeLegAutoWeights, computeLegAnimation } from '../../utils/membersBonesTriangSolver'
import { resolveSkeletonFrame, computeLegRestPose } from '../../utils/sam2BoneSolver'
import type { LegRestPose } from '../../utils/sam2BoneSolver'
import { getMembersBonesBodyMesh } from '../../utils/membersBonesBodyMesh'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function MembersBonesV2AnimComputeStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation

  const [saving, setSaving] = useState(false)
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState<{ frame: number; total: number } | null>(null)

  // Preview state
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [showBones, setShowBones] = useState(true)
  const [showWireframe, setShowWireframe] = useState(true)
  const [showImage, setShowImage] = useState(true)

  // Computed results (local until saved)
  const [zoneFrames, setZoneFrames] = useState<Record<string, Point2D[][]> | null>(
    () => mesh?.walkZoneFrames ?? null
  )

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fittedRef = useRef(false)
  const animFrameRef = useRef<number>(0)

  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  // Image dimensions
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

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

  // Fit canvas when image loads
  useEffect(() => {
    if (imgSize.w > 0 && !fittedRef.current) {
      fittedRef.current = true
      fitToCanvas(imgSize.w, imgSize.h)
    }
  }, [imgSize, fitToCanvas])

  // Anchor frames (prefer smoothed)
  const anchorFrames = useMemo(() => {
    return mesh?.sam2SmoothedAnchorFrames ?? mesh?.sam2ContourAnchorFrames ?? null
  }, [mesh])

  const totalFrames = useMemo(() => {
    if (!anchorFrames) return 0
    const first = Object.values(anchorFrames)[0]
    return first?.length ?? 0
  }, [anchorFrames])

  // Video dimensions
  const vidW = mesh?.sam2VideoWidth ?? 1
  const vidH = mesh?.sam2VideoHeight ?? 1

  // Body frames: prefer smoothed body mesh so hip body-vertex positions are stable
  const bodyFrames = mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null

  // Prerequisites
  const triReady = tri?.step2Validated === true
  const bonesReady = mesh?.sam2BonesValidated === true
  const bodyReady = bodyFrames != null
  const hasResult = zoneFrames != null

  // --- Compute ---
  const handleCompute = useCallback(async () => {
    if (!tri || !mesh?.sam2Skeleton || !anchorFrames || !bodyFrames) return
    setComputing(true)
    setProgress(null)

    try {
      // Phase 1: leg auto-weights (uses bodyFrames[0] for hipBodyVertexIndex)
      const zoneWeights = computeLegAutoWeights(
        tri, mesh.sam2Skeleton, anchorFrames,
        imgSize.w, imgSize.h, vidW, vidH,
        bodyFrames[0],
      )

      // Phase 2: leg animation (uses full bodyFrames for hip override per frame)
      const result = computeLegAnimation(
        tri, mesh.sam2Skeleton, anchorFrames,
        zoneWeights, bodyFrames,
        imgSize.w, imgSize.h, vidW, vidH,
        (frame, total) => setProgress({ frame, total }),
      )

      setZoneFrames(result)
      setCurrentFrame(0)
    } catch (err) {
      console.error('[MBV2AnimCompute] Compute failed:', err)
      alert(`Erreur calcul: ${err instanceof Error ? err.message : err}`)
    } finally {
      setComputing(false)
      setProgress(null)
    }
  }, [tri, mesh, anchorFrames, bodyFrames, imgSize, vidW, vidH])

  // --- Save ---
  const handleSave = useCallback(async () => {
    if (!zoneFrames || !mesh) return
    setSaving(true)
    try {
      const updatedAnim: Animation = {
        ...animation,
        mesh: {
          ...mesh,
          walkZoneFrames: zoneFrames,
          // Silent downstream invalidation: leg smoothing is stale after recompute.
          walkZoneFramesSmoothed: null,
          walkZoneFramesSmoothingValidated: false,
        },
      }
      const updatedProject: Project = {
        ...project,
        animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a),
      }
      await onSave(updatedProject, [
        { animationId: animation.id, field: 'walkZoneFrames' },
      ])
    } finally {
      setSaving(false)
    }
  }, [zoneFrames, mesh, animation, project, onSave])

  // --- Playback ---
  useEffect(() => {
    if (!playing || !hasResult) return
    let raf: number
    let lastTime = performance.now()
    const msPerFrame = 1000 / 24
    let accumulator = 0
    const tick = (now: number) => {
      accumulator += now - lastTime
      lastTime = now
      if (accumulator >= msPerFrame) {
        const steps = Math.floor(accumulator / msPerFrame)
        accumulator -= steps * msPerFrame
        setCurrentFrame(f => {
          const next = f + steps
          return next >= totalFrames ? next % totalFrames : next
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, hasResult, totalFrames])

  // --- Skeleton resolution for preview ---
  const legRestPoses = useMemo<LegRestPose[] | null>(() => {
    if (!mesh?.sam2Skeleton || !anchorFrames || !bodyFrames) return null
    const bodyF0Vid = bodyFrames[0].map(p => ({
      x: p.x * (vidW / imgSize.w),
      y: p.y * (vidH / imgSize.h),
    }))
    return mesh.sam2Skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames, bodyF0Vid))
  }, [mesh?.sam2Skeleton, anchorFrames, bodyFrames, vidW, vidH, imgSize])

  // --- Canvas drawing ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const t = transformRef.current
    ctx.setTransform(t.scale * dpr, 0, 0, t.scale * dpr, t.offsetX * dpr, t.offsetY * dpr)

    // Draw image
    if (showImage && imageRef.current) {
      ctx.drawImage(imageRef.current, 0, 0)
    }

    if (!tri) return

    const f = currentFrame

    // Body wireframe (from walkBodyFrames). Body mesh switches between V2 (tri) and V3 (sam2 + internals).
    const bodyMesh = getMembersBonesBodyMesh(project, animation, imgSize.w, imgSize.h)
    const bodyTrianglesForDraw = bodyMesh?.bodyTriangles ?? tri.bodyTriangles
    const bpts = bodyFrames ? bodyFrames[f] ?? bodyMesh?.bodyPoints ?? tri.bodyPoints : (bodyMesh?.bodyPoints ?? tri.bodyPoints)
    if (bpts && showWireframe) {
      drawWireframe(ctx, bpts, bodyTrianglesForDraw, '#22c55e', 0.5)
    }

    // Zone wireframes
    for (const zone of tri.zones) {
      if (zone.id === 'body') continue
      const pts = hasResult && zoneFrames?.[zone.id] ? zoneFrames[zone.id][f] : tri.zonePoints[zone.id]
      const tris = tri.zoneTriangles[zone.id]
      if (pts && tris && showWireframe) {
        drawWireframe(ctx, pts, tris, zone.color, 0.5)
      }
    }

    // Draw skeleton
    if (showBones && mesh?.sam2Skeleton && anchorFrames && legRestPoses && totalFrames > 0) {
      // Convert body frame to video coords for hip override
      const bodyFVid = bodyFrames?.[f]
        ? bodyFrames[f].map(p => ({
            x: p.x * (vidW / imgSize.w),
            y: p.y * (vidH / imgSize.h),
          }))
        : null

      // Use a simple prev frame tracker via ref
      const skelFrame = resolveSkeletonFrame(
        mesh.sam2Skeleton, anchorFrames, f, legRestPoses, null, bodyFVid,
      )

      const toImg = (p: Point2D) => ({
        x: p.x * (imgSize.w / vidW),
        y: p.y * (imgSize.h / vidH),
      })

      // Body chain
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2 / t.scale
      for (let i = 0; i < skelFrame.bodyJoints.length - 1; i++) {
        const a = toImg(skelFrame.bodyJoints[i])
        const b = toImg(skelFrame.bodyJoints[i + 1])
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      }
      for (const j of skelFrame.bodyJoints) {
        const p = toImg(j)
        ctx.fillStyle = '#ffffff'
        ctx.beginPath(); ctx.arc(p.x, p.y, 4 / t.scale, 0, Math.PI * 2); ctx.fill()
      }
      // Legs
      const LEG_COLORS = ['#f59e0b', '#ef4444', '#3b82f6', '#a855f7']
      for (let li = 0; li < skelFrame.legs.length; li++) {
        const leg = skelFrame.legs[li]
        const hip = toImg(leg.hip), knee = toImg(leg.knee), foot = toImg(leg.foot)
        ctx.strokeStyle = LEG_COLORS[li % LEG_COLORS.length]
        ctx.lineWidth = 2 / t.scale
        ctx.beginPath(); ctx.moveTo(hip.x, hip.y); ctx.lineTo(knee.x, knee.y); ctx.lineTo(foot.x, foot.y); ctx.stroke()
        ctx.fillStyle = '#facc15'
        ctx.beginPath(); ctx.arc(knee.x, knee.y, 4 / t.scale, 0, Math.PI * 2); ctx.fill()
      }
    }

    animFrameRef.current = requestAnimationFrame(() => {})
  }, [currentFrame, showBones, showWireframe, showImage, tri, mesh, anchorFrames, zoneFrames, bodyFrames, hasResult, totalFrames, imgSize, vidW, vidH, legRestPoses])

  // --- Render ---

  if (!triReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Completez d'abord la triangulation projet (onglet Triangulation, etape 3) avant cette etape.
        </p>
      </div>
    )
  }

  if (!bonesReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Completez d'abord les etapes Bones et Lissage de cette animation Members-Bones.
        </p>
      </div>
    )
  }

  if (!bodyReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Calculez d'abord l'animation body (etape precedente) avant de calculer les pattes.
        </p>
      </div>
    )
  }

  return (
    <div className="step-section">
      <div className="step-controls" style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          className="btn-primary"
          onClick={handleCompute}
          disabled={computing || saving}
        >
          {computing ? 'Calcul en cours...' : 'Calculer animation pattes'}
        </button>

        {hasResult && (
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || computing}
          >
            {saving ? 'Sauvegarde...' : 'Sauvegarder'}
          </button>
        )}

        {progress && (
          <span style={{ fontSize: 13, color: '#94a3b8' }}>
            Frame {progress.frame} / {progress.total}
          </span>
        )}
      </div>

      {/* Info */}
      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>
        {Object.entries(tri.zonePoints).filter(([k]) => k !== 'body').map(([k, v]) => `${k}: ${v.length} pts`).join(', ')}
        {totalFrames > 0 && ` — ${totalFrames} frames`}
        {bodyFrames && ` — body: ${bodyFrames[0]?.length ?? 0} pts`}
      </div>

      {/* Toggles */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 13 }}>
        <label><input type="checkbox" checked={showImage} onChange={e => setShowImage(e.target.checked)} /> Image</label>
        <label><input type="checkbox" checked={showWireframe} onChange={e => setShowWireframe(e.target.checked)} /> Wireframe</label>
        <label><input type="checkbox" checked={showBones} onChange={e => setShowBones(e.target.checked)} /> Bones</label>
      </div>

      {/* Player */}
      {hasResult && totalFrames > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button className="btn-sm btn-secondary" onClick={() => setPlaying(p => !p)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            value={currentFrame}
            onChange={e => { setPlaying(false); setCurrentFrame(Number(e.target.value)) }}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 60 }}>
            {currentFrame + 1} / {totalFrames}
          </span>
        </div>
      )}

      {/* Canvas */}
      <div ref={containerRef} style={{ position: 'relative', width: '100%', height: 500, background: '#1a1a2e', borderRadius: 8, overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  )
}

function drawWireframe(
  ctx: CanvasRenderingContext2D,
  points: Point2D[],
  triangles: [number, number, number][],
  color: string,
  lineWidth: number,
) {
  const t = ctx.getTransform()
  const scale = Math.sqrt(t.a * t.a + t.b * t.b)
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth / (scale > 0 ? scale / (window.devicePixelRatio || 1) : 1)
  ctx.globalAlpha = 0.6
  for (const [a, b, c] of triangles) {
    if (a >= points.length || b >= points.length || c >= points.length) continue
    const pa = points[a], pb = points[b], pc = points[c]
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.lineTo(pc.x, pc.y)
    ctx.closePath()
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}
