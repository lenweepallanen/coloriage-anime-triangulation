import { useState, useEffect, useRef } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { interpolateInternalPoint } from '../../utils/barycentricUtils'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function FinalAnimationStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState('')


  // Preview state
  const [playing, setPlaying] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoReady, setVideoReady] = useState(false)
  const animFrameRef = useRef(0)

  const hasAnimation = mesh?.videoFramesMesh != null

  // Prerequisites
  if (!mesh?.topologyLocked) {
    return <div className="placeholder">Verrouillez d&apos;abord la topologie (étape 7).</div>
  }
  if (!mesh?.contourFrames || !mesh?.anchorFrames) {
    return <div className="placeholder">Validez d&apos;abord le tracking contour et ancres.</div>
  }

  const contourFrames = mesh.contourFrames
  const anchorFrames = mesh.anchorFrames
  const totalFrames = Math.min(contourFrames.length, anchorFrames.length)
  const trackedTriangles = mesh.trackedTriangles
  const internalBarycentrics = mesh.internalBarycentrics

  async function handleCompute() {
    if (!mesh || totalFrames === 0) return
    setComputing(true)
    setProgress('Calcul...')

    try {
      const videoFramesMesh: Point2D[][] = []

      for (let f = 0; f < totalFrames; f++) {
        if (f % 10 === 0) {
          setProgress(`Frame ${f + 1} / ${totalFrames}`)
          // Yield to UI
          await new Promise(r => setTimeout(r, 0))
        }

        // Tracked positions = contour + anchors for this frame
        const trackedPositions = [...contourFrames[f], ...anchorFrames[f]]

        // Interpolate internal points via barycentrics
        const internalPositions = internalBarycentrics.map(bary =>
          interpolateInternalPoint(bary, trackedPositions, trackedTriangles)
        )

        // All points = tracked + internal (same convention as triangulation)
        videoFramesMesh.push([...trackedPositions, ...internalPositions])
      }

      const updatedMesh: MeshData = {
        ...mesh,
        videoFramesMesh,
      }

      setProgress('Sauvegarde...')
      await onSave(
        { ...project, mesh: updatedMesh },
        ['videoFramesMesh']
      )

      setComputing(false)
      setProgress('')
    } catch (err) {
      console.error('Animation computation failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
      setComputing(false)
      setProgress('')
    }
  }

  // Load video for preview
  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      videoRef.current = video
      setVideoReady(true)
    }
    video.load()
    return () => {
      video.pause()
      URL.revokeObjectURL(url)
    }
  }, [project.videoBlob])

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Animation loop for preview
  useEffect(() => {
    if (!hasAnimation || !playing) return
    const frames = mesh!.videoFramesMesh!
    let lastTime = performance.now()

    function tick(now: number) {
      const elapsed = now - lastTime
      if (elapsed >= 1000 / 24) {
        lastTime = now
        setCurrentFrame(f => (f + 1) % frames.length)
      }
      animFrameRef.current = requestAnimationFrame(tick)
    }

    animFrameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [hasAnimation, playing, mesh])

  // Draw preview
  useEffect(() => {
    if (!hasAnimation || !videoReady) return
    const canvas = canvasRef.current
    const video = videoRef.current
    const frames = mesh!.videoFramesMesh!
    const triangles = mesh!.triangles

    if (!canvas || !video || currentFrame >= frames.length) return

    video.currentTime = currentFrame / 24

    const drawOnSeeked = () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr
      ctx.clearRect(0, 0, cssW, cssH)

      const vw = video.videoWidth
      const vh = video.videoHeight
      const scaleX = cssW / vw
      const scaleY = cssH / vh
      const s = Math.min(scaleX, scaleY) * 0.95
      const ox = (cssW - vw * s) / 2
      const oy = (cssH - vh * s) / 2

      // Draw video frame
      ctx.drawImage(video, ox, oy, vw * s, vh * s)

      // Get image dimensions for coord conversion
      const imgW = project.originalImageBlob ? vw : vw // Approximate
      const imgH = project.originalImageBlob ? vh : vh

      // Draw mesh overlay
      const points = frames[currentFrame]
      ctx.strokeStyle = 'rgba(0, 255, 100, 0.4)'
      ctx.lineWidth = 1

      for (const [a, b, c] of triangles) {
        if (a >= points.length || b >= points.length || c >= points.length) continue
        const pa = points[a], pb = points[b], pc = points[c]
        const ax = (pa.x / imgW) * vw * s + ox
        const ay = (pa.y / imgH) * vh * s + oy
        const bx = (pb.x / imgW) * vw * s + ox
        const by = (pb.y / imgH) * vh * s + oy
        const cx = (pc.x / imgW) * vw * s + ox
        const cy = (pc.y / imgH) * vh * s + oy

        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(bx, by)
        ctx.lineTo(cx, cy)
        ctx.closePath()
        ctx.stroke()
      }

      // Frame counter
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(8, 8, 120, 24)
      ctx.fillStyle = '#fff'
      ctx.font = '12px monospace'
      ctx.fillText(`Frame ${currentFrame} / ${frames.length - 1}`, 14, 24)
    }

    video.onseeked = drawOnSeeked
    // If already at the right time, draw immediately
    if (Math.abs(video.currentTime - currentFrame / 24) < 0.01) {
      drawOnSeeked()
    }
  }, [hasAnimation, videoReady, currentFrame, mesh, project.originalImageBlob])

  return (
    <div className="tracking-step" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        {!hasAnimation ? (
          <>
            <button
              onClick={handleCompute}
              disabled={computing}
              style={{ background: '#2563eb', color: 'white', padding: '8px 24px' }}
            >
              {computing ? 'Calcul en cours...' : 'Calculer l\'animation'}
            </button>
            {computing && (
              <span style={{ fontFamily: 'monospace', color: '#888' }}>{progress}</span>
            )}
            <span style={{ color: '#888' }}>
              {mesh.internalPoints.length} points internes,{' '}
              {totalFrames} frames
            </span>
          </>
        ) : (
          <>
            <span style={{ color: '#22c55e', fontWeight: 'bold' }}>
              Animation calculée
            </span>
            <span style={{ color: '#888' }}>
              {mesh.videoFramesMesh!.length} frames, {mesh.videoFramesMesh![0]?.length ?? 0} points/frame
            </span>
            <button onClick={() => setPlaying(!playing)}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <button onClick={() => { setPlaying(false); setCurrentFrame(0) }}>
              Rewind
            </button>
            <button
              onClick={handleCompute}
              disabled={computing}
              style={{ marginLeft: 'auto' }}
            >
              Recalculer
            </button>
          </>
        )}
      </div>

      {computing && (
        <div style={{ padding: '0 16px' }}>
          <div style={{ width: '100%', height: 4, background: '#333', borderRadius: 2 }}>
            <div style={{ width: '50%', height: '100%', background: '#2563eb', borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}

      {hasAnimation && (
        <div ref={containerRef} style={{ flex: 1, minHeight: 300, position: 'relative' }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
        </div>
      )}
    </div>
  )
}
