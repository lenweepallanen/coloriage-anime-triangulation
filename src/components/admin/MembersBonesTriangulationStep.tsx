import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeTriangAutoWeights, computeTriangAnimation } from '../../utils/membersBonesTriangSolver'
import { resolveSkeletonFrame, computeLegRestPose } from '../../utils/sam2BoneSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function MembersBonesTriangulationStep({ project, animation, onSave }: Props) {
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
  const [bodyFrames, setBodyFrames] = useState<Point2D[][] | null>(
    () => mesh?.walkBodyFrames ?? null
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

  // Determine anchor frames (prefer smoothed if available)
  const anchorFrames = useMemo(() => {
    return mesh?.sam2SmoothedAnchorFrames ?? mesh?.sam2ContourAnchorFrames ?? null
  }, [mesh])

  const totalFrames = useMemo(() => {
    if (!anchorFrames) return 0
    const first = Object.values(anchorFrames)[0]
    return first?.length ?? 0
  }, [anchorFrames])

  // Video dimensions from mesh
  const vidW = mesh?.sam2VideoWidth ?? 1
  const vidH = mesh?.sam2VideoHeight ?? 1

  // Prerequisites check
  const triReady = tri?.step3Validated === true
  const bonesReady = mesh?.sam2SmoothingValidated === true || mesh?.sam2BonesValidated === true
  const hasResult = zoneFrames != null && bodyFrames != null

  // --- Compute ---
  const handleCompute = useCallback(async () => {
    if (!tri || !mesh?.sam2Skeleton || !anchorFrames) return
    setComputing(true)
    setProgress(null)

    try {
      // Step 1: auto-weights
      const weights = computeTriangAutoWeights(
        tri, mesh.sam2Skeleton, anchorFrames,
        imgSize.w, imgSize.h, vidW, vidH,
      )

      // Step 2: LBS animation per frame
      const result = computeTriangAnimation(
        tri, mesh.sam2Skeleton, anchorFrames,
        weights.bodyWeights, weights.zoneWeights,
        imgSize.w, imgSize.h, vidW, vidH,
        (frame, total) => setProgress({ frame, total }),
      )

      setZoneFrames(result.walkZoneFrames)
      setBodyFrames(result.walkBodyFrames)
      setCurrentFrame(0)
    } catch (err) {
      console.error('[MBTriang] Compute failed:', err)
      alert(`Erreur calcul: ${err instanceof Error ? err.message : err}`)
    } finally {
      setComputing(false)
      setProgress(null)
    }
  }, [tri, mesh, anchorFrames, imgSize, vidW, vidH])

  // --- Save ---
  const handleSave = useCallback(async () => {
    if (!zoneFrames || !bodyFrames || !mesh) return
    setSaving(true)
    try {
      const updatedAnim: Animation = {
        ...animation,
        mesh: { ...mesh, walkZoneFrames: zoneFrames, walkBodyFrames: bodyFrames },
      }
      const updatedProject: Project = {
        ...project,
        animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a),
      }
      await onSave(updatedProject, [
        { animationId: animation.id, field: 'walkZoneFrames' },
        { animationId: animation.id, field: 'walkBodyFrames' },
      ])
    } finally {
      setSaving(false)
    }
  }, [zoneFrames, bodyFrames, mesh, animation, project, onSave])

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

  // --- Canvas drawing ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Resize canvas
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

    // Draw body mesh
    const bpts = hasResult && bodyFrames ? bodyFrames[f] : tri.bodyPoints
    if (bpts && showWireframe) {
      drawWireframe(ctx, bpts, tri.bodyTriangles, '#22c55e', 0.5)
    }

    // Draw zone meshes
    for (const zone of tri.zones) {
      if (zone.id === 'body') continue
      const pts = hasResult && zoneFrames?.[zone.id] ? zoneFrames[zone.id][f] : tri.zonePoints[zone.id]
      const tris = tri.zoneTriangles[zone.id]
      if (pts && tris && showWireframe) {
        drawWireframe(ctx, pts, tris, zone.color, 0.5)
      }
    }

    // Draw bones
    if (showBones && mesh?.sam2Skeleton && anchorFrames && totalFrames > 0) {
      const legRestPoses = mesh.sam2Skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames))
      const skelFrame = resolveSkeletonFrame(mesh.sam2Skeleton, anchorFrames, f, legRestPoses, null)

      // Convert to image coords
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
      // Joints
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
        // Knee marker
        ctx.fillStyle = '#facc15'
        ctx.beginPath(); ctx.arc(knee.x, knee.y, 4 / t.scale, 0, Math.PI * 2); ctx.fill()
      }
    }

    animFrameRef.current = requestAnimationFrame(() => {})
  }, [currentFrame, showBones, showWireframe, showImage, tri, mesh, anchorFrames, zoneFrames, bodyFrames, hasResult, totalFrames, imgSize, vidW, vidH])

  // --- Render ---

  if (!triReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Complétez d'abord la triangulation projet (onglet Triangulation, 3 étapes) avant cette étape.
        </p>
      </div>
    )
  }

  if (!bonesReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Complétez d'abord les étapes Bones et Lissage de cette animation Members-Bones.
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
          {computing ? 'Calcul en cours...' : 'Calculer auto-weights + animation'}
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
        Triangulation : {tri.zones.length} zones,{' '}
        body {tri.bodyPoints.length} pts,{' '}
        {Object.entries(tri.zonePoints).filter(([k]) => k !== 'body').map(([k, v]) => `${k}: ${v.length} pts`).join(', ')}
        {totalFrames > 0 && ` — ${totalFrames} frames`}
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
  const scale = Math.sqrt(t.a * t.a + t.b * t.b) // approximate scale from transform
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
