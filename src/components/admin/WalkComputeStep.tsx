import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeWalkFrames } from '../../utils/walkSolver'

type ViewMode = 'wireframe' | 'gradient'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function WalkComputeStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const restAnim = project.animations.find(a => a.type === 'rest')
  const restMesh = restAnim?.mesh

  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState('')
  const [playing, setPlaying] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>('wireframe')
  const [saving, setSaving] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)
  const lastTimeRef = useRef<number>(0)
  const frameAccum = useRef<number>(0)

  const videoFramesMesh = mesh?.videoFramesMesh
  const triangles = restMesh?.triangles ?? []
  const totalFrames = videoFramesMesh?.length ?? 0

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

  // Get all rest points for allPoints reference
  const allRestPoints: Point2D[] = restMesh ? [
    ...(restMesh.contourAnchors || []),
    ...(restMesh.contourSubdivisionPoints || []),
    ...(restMesh.anchorPoints || []),
    ...(restMesh.internalPoints || []),
  ] : []

  async function handleCompute() {
    if (!mesh?.walkSkeleton || !mesh.walkParams || !restMesh) return

    setComputing(true)
    setProgress('Préparation...')

    // Use setTimeout to let UI update
    await new Promise(r => setTimeout(r, 50))

    try {
      const frames = computeWalkFrames(
        mesh.walkSkeleton!,
        mesh.walkBodyTriangles ?? [],
        mesh.walkParams!,
        allRestPoints,
        triangles,
        (frame, total) => {
          setProgress(`Frame ${frame}/${total}`)
        },
      )

      setProgress('Sauvegarde...')
      const updatedMesh = { ...mesh, videoFramesMesh: frames }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      setSaving(true)
      await onSave({ ...project, animations: updatedAnims }, [
        { animationId: animation.id, field: 'videoFramesMesh' },
      ])
      setSaving(false)
      setPlaying(true)
      setCurrentFrame(0)
    } catch (err) {
      console.error('Walk compute error:', err)
      setProgress(`Erreur: ${err}`)
    } finally {
      setComputing(false)
    }
  }

  // Playback draw loop
  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const img = imageRef.current
    if (!canvas || !ctx || !img) return

    // Advance frame
    if (playing && videoFramesMesh && totalFrames > 0) {
      if (lastTimeRef.current > 0) {
        const dt = (timestamp - lastTimeRef.current) / 1000
        frameAccum.current += dt * 24
        if (frameAccum.current >= 1) {
          const advance = Math.floor(frameAccum.current)
          frameAccum.current -= advance
          setCurrentFrame(prev => (prev + advance) % totalFrames)
        }
      }
      lastTimeRef.current = timestamp
    } else {
      lastTimeRef.current = 0
      frameAccum.current = 0
    }

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

    const framePoints = videoFramesMesh?.[currentFrame]
    if (!framePoints || triangles.length === 0) {
      ctx.drawImage(img, 0, 0)
      ctx.restore()
      animFrameRef.current = requestAnimationFrame(draw)
      return
    }

    if (viewMode === 'gradient') {
      // Draw triangles with HSL gradient based on centroid
      for (let i = 0; i < triangles.length; i++) {
        const [ai, bi, ci] = triangles[i]
        if (ai >= framePoints.length || bi >= framePoints.length || ci >= framePoints.length) continue
        const a = framePoints[ai], b = framePoints[bi], c = framePoints[ci]
        const cx = (a.x + b.x + c.x) / 3
        const cy = (a.y + b.y + c.y) / 3
        const hue = ((cx + cy) * 0.5) % 360

        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()
        ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.7)`
        ctx.fill()
        ctx.strokeStyle = `hsla(${hue}, 70%, 40%, 0.8)`
        ctx.lineWidth = 0.5 / t.scale
        ctx.stroke()
      }
    } else {
      // Wireframe on dark background
      ctx.globalAlpha = 0.2
      ctx.drawImage(img, 0, 0)
      ctx.globalAlpha = 1

      ctx.strokeStyle = 'rgba(0, 255, 200, 0.5)'
      ctx.lineWidth = 1 / t.scale
      for (let i = 0; i < triangles.length; i++) {
        const [ai, bi, ci] = triangles[i]
        if (ai >= framePoints.length || bi >= framePoints.length || ci >= framePoints.length) continue
        const a = framePoints[ai], b = framePoints[bi], c = framePoints[ci]
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()
        ctx.stroke()
      }
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  }, [videoFramesMesh, currentFrame, playing, triangles, viewMode, totalFrames, transformRef])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  if (!mesh?.walkSkeletonValidated || !mesh.walkBodyValidated || !mesh.walkParamsValidated) {
    return (
      <div style={{ padding: 20, color: '#9ca3af' }}>
        Complétez d'abord les étapes précédentes (squelette, corps, paramètres).
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {!videoFramesMesh && (
          <button
            className="btn-primary"
            onClick={handleCompute}
            disabled={computing || saving}
          >
            {computing ? progress : 'Calculer l\'animation'}
          </button>
        )}
        {videoFramesMesh && (
          <>
            <button className="btn-sm btn-secondary" onClick={() => setPlaying(!playing)}>
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <button className="btn-sm btn-secondary" onClick={() => { setCurrentFrame(0); setPlaying(false) }}>
              ⏮
            </button>
            <span style={{ color: '#9ca3af', fontSize: 13, marginLeft: 8 }}>
              Frame {currentFrame + 1} / {totalFrames}
            </span>
            <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
              {(['wireframe', 'gradient'] as const).map(mode => (
                <button
                  key={mode}
                  className={`btn-sm ${viewMode === mode ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setViewMode(mode)}
                  style={{ textTransform: 'capitalize' }}
                >
                  {mode}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {videoFramesMesh && (
        <div style={{ marginBottom: 8 }}>
          <input
            type="range"
            min={0} max={totalFrames - 1}
            value={currentFrame}
            onChange={e => { setCurrentFrame(parseInt(e.target.value)); setPlaying(false) }}
            style={{ width: '100%' }}
          />
        </div>
      )}

      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: 500, display: 'block', borderRadius: 8 }}
      />

      {videoFramesMesh && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button
            className="btn-secondary"
            onClick={handleCompute}
            disabled={computing || saving}
          >
            Recalculer
          </button>
        </div>
      )}
    </div>
  )
}
