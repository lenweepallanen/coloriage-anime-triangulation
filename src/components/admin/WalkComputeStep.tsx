import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeWalkFrames, computeWalkFramesSeparated } from '../../utils/walkSolver'

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
  const walkZoneFrames = mesh?.walkZoneFrames
  const walkBodyFrames = mesh?.walkBodyFrames
  const separation = mesh?.walkLimbSeparation
  const isSeparatedMode = !!walkZoneFrames && !!walkBodyFrames && !!separation
  const triangles = restMesh?.triangles ?? []
  // In separated mode, use body frames length; in legacy, use videoFramesMesh length
  const totalFrames = isSeparatedMode
    ? (walkBodyFrames?.length ?? 0)
    : (videoFramesMesh?.length ?? 0)
  const hasComputed = isSeparatedMode || !!videoFramesMesh

  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      requestAnimationFrame(() => fitToCanvas(img.width, img.height))
    }
    img.src = url
    const canvas = canvasRef.current
    let ro: ResizeObserver | null = null
    if (canvas) {
      ro = new ResizeObserver(() => {
        if (imageRef.current && canvas.clientWidth > 0)
          fitToCanvas(imageRef.current.naturalWidth, imageRef.current.naturalHeight)
      })
      ro.observe(canvas)
    }
    return () => {
      imageRef.current = null
      URL.revokeObjectURL(url)
      ro?.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob])

  // Get all rest points for allPoints reference
  const allRestPoints: Point2D[] = restMesh ? [
    ...(restMesh.contourAnchors || []),
    ...(restMesh.contourSubdivisionPoints || []),
    ...(restMesh.anchorPoints || []),
    ...(restMesh.internalPoints || []),
  ] : []

  const hasSeparation = !!mesh?.walkLimbSeparationValidated && !!mesh?.walkLimbSeparation

  async function handleCompute() {
    if (!mesh?.walkSkeleton || !mesh.walkParams || !restMesh) return

    setComputing(true)
    setProgress('Préparation...')

    // Use setTimeout to let UI update
    await new Promise(r => setTimeout(r, 50))

    try {
      if (hasSeparation && mesh.walkLimbSeparation) {
        // Separated mode: per-zone + body frames
        const { zoneFrames, bodyFrames } = computeWalkFramesSeparated(
          mesh.walkSkeleton!,
          mesh.walkParams!,
          mesh.walkLimbSeparation,
          allRestPoints,
          triangles,
          (frame, total) => { setProgress(`Frame ${frame}/${total} (zones)`) },
        )

        // Also compute legacy single-mesh frames for backward-compat (ScenePlayer etc.)
        setProgress('Calcul mesh unifie...')
        await new Promise(r => setTimeout(r, 10))
        const legacyFrames = computeWalkFrames(
          mesh.walkSkeleton!,
          mesh.walkBodyTriangles ?? [],
          mesh.walkParams!,
          allRestPoints,
          triangles,
          (frame, total) => { setProgress(`Frame ${frame}/${total} (legacy)`) },
          mesh.walkLimbSeparation,
        )

        setProgress('Sauvegarde...')
        const updatedMesh = {
          ...mesh,
          videoFramesMesh: legacyFrames,
          walkZoneFrames: zoneFrames,
          walkBodyFrames: bodyFrames,
        }
        const updatedAnims = project.animations.map(a =>
          a.id === animation.id ? { ...a, mesh: updatedMesh } : a
        )
        setSaving(true)
        await onSave({ ...project, animations: updatedAnims }, [
          { animationId: animation.id, field: 'videoFramesMesh' },
          { animationId: animation.id, field: 'walkZoneFrames' },
          { animationId: animation.id, field: 'walkBodyFrames' },
        ])
      } else {
        // Legacy mode: single mesh
        const frames = computeWalkFrames(
          mesh.walkSkeleton!,
          mesh.walkBodyTriangles ?? [],
          mesh.walkParams!,
          allRestPoints,
          triangles,
          (frame, total) => { setProgress(`Frame ${frame}/${total}`) },
        )

        setProgress('Sauvegarde...')
        const updatedMesh = { ...mesh, videoFramesMesh: frames, walkZoneFrames: null, walkBodyFrames: null }
        const updatedAnims = project.animations.map(a =>
          a.id === animation.id ? { ...a, mesh: updatedMesh } : a
        )
        setSaving(true)
        await onSave({ ...project, animations: updatedAnims }, [
          { animationId: animation.id, field: 'videoFramesMesh' },
        ])
      }

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
    if (playing && hasComputed && totalFrames > 0) {
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

    // Build frame data depending on mode
    type TriAndPoints = { tris: [number, number, number][]; getPoint: (idx: number) => Point2D | undefined; color?: string }[]
    let drawGroups: TriAndPoints = []

    if (isSeparatedMode && walkZoneFrames && walkBodyFrames && separation) {
      // Separated mode: each zone has its own local points + triangles
      for (const zone of separation.zones) {
        const zoneFrame = walkZoneFrames[zone.id]?.[currentFrame]
        const zoneTris = separation.zoneTriangles[zone.id] || []
        if (!zoneFrame) continue
        drawGroups.push({
          tris: zoneTris,
          getPoint: (idx: number) => zoneFrame[idx],
          color: zone.color,
        })
      }
      // Body — use pre-computed bodyTriangles if available
      const bodyFrame = walkBodyFrames[currentFrame]
      if (bodyFrame && restMesh) {
        let bodyLocalTris: [number, number, number][]
        if (separation.bodyTriangles) {
          bodyLocalTris = separation.bodyTriangles
        } else {
          const bodyVertSet = new Set<number>()
          for (const ti of separation.bodyTriangleIndices) {
            const [a, b, c] = (restMesh.triangles ?? [])[ti] ?? []
            if (a !== undefined) { bodyVertSet.add(a); bodyVertSet.add(b); bodyVertSet.add(c) }
          }
          const bodyGlobal = [...bodyVertSet].sort((a, b) => a - b)
          const g2l = new Map<number, number>()
          bodyGlobal.forEach((g, i) => g2l.set(g, i))
          bodyLocalTris = separation.bodyTriangleIndices.map(ti => {
            const [a, b, c] = (restMesh.triangles ?? [])[ti] ?? [0, 0, 0]
            return [g2l.get(a)!, g2l.get(b)!, g2l.get(c)!]
          })
        }
        drawGroups.push({
          tris: bodyLocalTris,
          getPoint: (idx: number) => bodyFrame[idx],
          color: '#888888',
        })
      }
    } else if (videoFramesMesh) {
      // Legacy mode: single mesh
      const framePoints = videoFramesMesh[currentFrame]
      if (framePoints) {
        drawGroups.push({
          tris: triangles,
          getPoint: (idx: number) => framePoints[idx],
        })
      }
    }

    if (drawGroups.length === 0) {
      ctx.drawImage(img, 0, 0)
      ctx.restore()
      animFrameRef.current = requestAnimationFrame(draw)
      return
    }

    if (viewMode === 'wireframe') {
      ctx.globalAlpha = 0.2
      ctx.drawImage(img, 0, 0)
      ctx.globalAlpha = 1
    }

    for (const group of drawGroups) {
      for (const [ai, bi, ci] of group.tris) {
        const a = group.getPoint(ai), b = group.getPoint(bi), c = group.getPoint(ci)
        if (!a || !b || !c) continue

        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.lineTo(c.x, c.y)
        ctx.closePath()

        if (viewMode === 'gradient') {
          const cx = (a.x + b.x + c.x) / 3
          const cy = (a.y + b.y + c.y) / 3
          const hue = group.color
            ? 0 // Use zone color
            : ((cx + cy) * 0.5) % 360
          if (group.color) {
            ctx.fillStyle = group.color + 'B3' // ~70% alpha
            ctx.strokeStyle = group.color + 'CC'
          } else {
            ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.7)`
            ctx.strokeStyle = `hsla(${hue}, 70%, 40%, 0.8)`
          }
          ctx.lineWidth = 0.5 / t.scale
          ctx.fill()
          ctx.stroke()
        } else {
          ctx.strokeStyle = group.color
            ? group.color + '80'
            : 'rgba(0, 255, 200, 0.5)'
          ctx.lineWidth = 1 / t.scale
          ctx.stroke()
        }
      }
    }

    ctx.restore()
    animFrameRef.current = requestAnimationFrame(draw)
  }, [videoFramesMesh, walkZoneFrames, walkBodyFrames, separation, isSeparatedMode, hasComputed, currentFrame, playing, triangles, viewMode, totalFrames, transformRef])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  if (!mesh?.walkSkeletonValidated || !mesh.walkParamsValidated) {
    return (
      <div style={{ padding: 20, color: '#9ca3af' }}>
        Completez d'abord les etapes precedentes (squelette, parametres).
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {!hasComputed && (
          <button
            className="btn-primary"
            onClick={handleCompute}
            disabled={computing || saving}
          >
            {computing ? progress : 'Calculer l\'animation'}
          </button>
        )}
        {hasComputed && (
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

      {hasComputed && (
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

      {hasComputed && (
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
