/**
 * MembersBonesV2BodyComputeStep — Step 11 "Calcul Corps" for members-bones-v2.
 *
 * Computes body LBS animation from the body chain skeleton + project triangulation.
 * Prerequisites: sam2BodyBonesValidated === true AND projectTriangulation.step2Validated === true.
 *
 * Flow:
 * 1. Compute body auto-weights (distance-inverse to body chain sub-bones)
 * 2. Compute body animation (LBS per frame)
 * 3. Preview animated body wireframe + body chain skeleton
 * 4. Save walkBodyFrames, invalidate walkZoneFrames
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeBodyAutoWeights, computeBodyAnimation } from '../../utils/membersBonesTriangSolver'
import { resolveBodyChain } from '../../utils/sam2BoneSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function MembersBonesV2BodyComputeStep({ project, animation, onSave }: Props) {
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

  // Computed result (local until saved)
  const [bodyFrames, setBodyFrames] = useState<Point2D[][] | null>(
    () => mesh?.walkBodyFrames ?? null
  )

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fittedRef = useRef(false)

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
  const triReady = tri?.step2Validated === true
  const bonesReady = mesh?.sam2BodyBonesValidated === true
  const hasResult = bodyFrames != null && bodyFrames.length > 0

  // --- Compute ---
  const handleCompute = useCallback(async () => {
    if (!tri || !mesh?.sam2Skeleton || !anchorFrames) return
    setComputing(true)
    setProgress(null)

    try {
      // Step 1: auto-weights for body vertices only
      const weights = computeBodyAutoWeights(
        tri, mesh.sam2Skeleton, anchorFrames,
        imgSize.w, imgSize.h, vidW, vidH,
      )

      // Step 2: LBS animation per frame (body only)
      const frames = computeBodyAnimation(
        tri, mesh.sam2Skeleton, anchorFrames,
        weights,
        imgSize.w, imgSize.h, vidW, vidH,
        (frame, total) => setProgress({ frame, total }),
      )

      setBodyFrames(frames)
      setCurrentFrame(0)
    } catch (err) {
      console.error('[MBV2BodyCompute] Compute failed:', err)
      alert(`Erreur calcul: ${err instanceof Error ? err.message : err}`)
    } finally {
      setComputing(false)
      setProgress(null)
    }
  }, [tri, mesh, anchorFrames, imgSize, vidW, vidH])

  // --- Save ---
  const handleSave = useCallback(async () => {
    if (!bodyFrames || !mesh) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        walkBodyFrames: bodyFrames,
        // Silent downstream invalidation (V2) — smoothing on body is stale,
        // leg compute + leg smoothing are stale.
        walkBodyFramesSmoothed: null,
        walkBodyFramesSmoothingValidated: false,
        walkZoneFrames: null,
        walkZoneFramesSmoothed: null,
        walkZoneFramesSmoothingValidated: false,
      }
      const updatedAnimations = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave(
        { ...project, animations: updatedAnimations },
        [
          { animationId: animation.id, field: 'walkBodyFrames' },
          { animationId: animation.id, field: 'walkZoneFrames' },
        ],
      )
    } finally {
      setSaving(false)
    }
  }, [bodyFrames, mesh, animation, project, onSave])

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

    // Draw body mesh wireframe
    const bpts = hasResult && bodyFrames ? bodyFrames[f] : tri.bodyPoints
    if (bpts && showWireframe) {
      drawWireframe(ctx, bpts, tri.bodyTriangles, '#22c55e', 0.5)
    }

    // Draw body chain skeleton
    if (showBones && mesh?.sam2Skeleton && anchorFrames && totalFrames > 0) {
      const bodyJoints = resolveBodyChain(mesh.sam2Skeleton.bodyChain, anchorFrames, f)

      // Convert video coords to image coords
      const toImg = (p: Point2D) => ({
        x: p.x * (imgSize.w / vidW),
        y: p.y * (imgSize.h / vidH),
      })

      // Draw chain segments
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2 / t.scale
      for (let i = 0; i < bodyJoints.length - 1; i++) {
        const a = toImg(bodyJoints[i])
        const b = toImg(bodyJoints[i + 1])
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Draw joints
      for (const j of bodyJoints) {
        const p = toImg(j)
        ctx.fillStyle = '#ffffff'
        ctx.beginPath()
        ctx.arc(p.x, p.y, 4 / t.scale, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }, [currentFrame, showBones, showWireframe, showImage, tri, mesh, anchorFrames, bodyFrames, hasResult, totalFrames, imgSize, vidW, vidH])

  // --- Render ---

  if (!triReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Completez d'abord la triangulation projet (onglet Triangulation, etape Maillage) avant cette etape.
        </p>
      </div>
    )
  }

  if (!bonesReady) {
    return (
      <div className="step-section">
        <p style={{ color: '#f87171' }}>
          Completez d'abord l'etape "Bones Corps" de cette animation avant le calcul.
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
          {computing ? 'Calcul en cours...' : 'Calculer animation corps'}
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
        Body : {tri.bodyPoints.length} pts, {tri.bodyTriangles.length} triangles
        {totalFrames > 0 && ` — ${totalFrames} frames`}
        {mesh?.sam2Skeleton && ` — ${mesh.sam2Skeleton.bodyChain.length} joints (${mesh.sam2Skeleton.bodyChain.length - 1} bones)`}
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
