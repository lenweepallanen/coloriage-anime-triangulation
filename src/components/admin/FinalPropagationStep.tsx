import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { precomputeARAP, solveARAPFrame } from '../../utils/arapSolver'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function FinalPropagationStep({ project, onSave }: Props) {
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [progress, setProgress] = useState(0)

  const mesh = project.mesh
  const hasAnchorFrames = mesh?.anchorFrames != null && mesh.anchorFrames.length > 0
  const hasVideoFramesMesh = mesh?.videoFramesMesh != null
  async function handleCompute() {
    if (!mesh || !mesh.anchorFrames) return
    setComputing(true)
    setProgress(0)

    try {
      const { anchorFrames } = mesh
      const totalFrames = anchorFrames.length
      const videoFramesMesh: Point2D[][] = new Array(totalFrames)

      // Build canonical mesh (frame 0) and precompute ARAP
      const restVertices = [...mesh.anchorPoints, ...mesh.contourPoints, ...mesh.internalPoints]
      const constrainedIndices = Array.from({ length: mesh.anchorPoints.length }, (_, i) => i)

      console.time('ARAP precomputation')
      const precomp = precomputeARAP(restVertices, mesh.triangles, constrainedIndices)
      console.timeEnd('ARAP precomputation')

      console.time('ARAP solve all frames')
      let prevResult: Point2D[] | undefined
      for (let f = 0; f < totalFrames; f++) {
        // Frame 0: use rest positions directly (identity deformation)
        if (f === 0) {
          videoFramesMesh[f] = restVertices.slice()
          prevResult = restVertices
        } else {
          const allPoints = solveARAPFrame(precomp, anchorFrames[f], prevResult, 3)
          videoFramesMesh[f] = allPoints
          prevResult = allPoints
        }

        // Report progress every 10 frames
        if (f % 10 === 0) {
          setProgress(Math.round((f / totalFrames) * 100))
          // Yield to UI
          await new Promise(r => setTimeout(r, 0))
        }
      }
      console.timeEnd('ARAP solve all frames')

      setProgress(100)

      const updatedMesh: MeshData = {
        ...mesh,
        videoFramesMesh,
      }

      setSaving(true)
      await onSave({ ...project, mesh: updatedMesh }, ['videoFramesMesh'])
      setSaving(false)
    } catch (err) {
      console.error('Final propagation failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }

    setComputing(false)
  }

  if (!mesh?.topologyLocked) {
    return (
      <div className="placeholder">
        Verrouillez d'abord la topologie dans l'onglet Triangulation.
      </div>
    )
  }

  if (!hasAnchorFrames) {
    return (
      <div className="placeholder">
        Effectuez d'abord le tracking et la validation des keyframes dans l'onglet Keyframes.
      </div>
    )
  }

  return (
    <div className="optical-flow-step">
      <h3>Animation finale</h3>
      <p style={{ fontSize: '0.875rem', color: '#888', marginBottom: 16 }}>
        Cette étape calcule les positions de tous les points (anchors + contour + internes)
        pour chaque frame en utilisant la déformation ARAP (As-Rigid-As-Possible).
        Le mesh canonique (frame 0) est déformé pour suivre les anchors tout en préservant la rigidité locale.
      </p>

      <div className="triangulation-toolbar">
        <button onClick={handleCompute} disabled={computing || saving}>
          {computing ? 'Calcul en cours...' : saving ? 'Sauvegarde...' : hasVideoFramesMesh ? 'Recalculer' : 'Calculer l\'animation'}
        </button>

        <span className="toolbar-info">
          {mesh.anchorFrames!.length} frames |
          {mesh.anchorPoints.length} anchors |
          {mesh.contourPoints.length} contour |
          {mesh.internalPoints.length} internes |
          {mesh.anchorPoints.length + mesh.contourPoints.length + mesh.internalPoints.length} points total
        </span>
      </div>

      {computing && (
        <div className="progress-container">
          <div className="progress-label">
            Déformation ARAP — {progress}%
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {hasVideoFramesMesh && !computing && (
        <>
          <div className="flow-status">
            Animation calculée : {mesh.videoFramesMesh!.length} frames,{' '}
            {mesh.videoFramesMesh![0]?.length ?? 0} points par frame.
          </div>
          <FlowPreview project={project} />
        </>
      )}
    </div>
  )
}

// Extracted and adapted from old OpticalFlowStep
function FlowPreview({ project }: { project: Project }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(true)
  const [videoReady, setVideoReady] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const imgDimsRef = useRef<{ width: number; height: number } | null>(null)
  const frameRef = useRef(0)
  const animRef = useRef<number>(0)
  const lastTimeRef = useRef(0)

  const mesh = project.mesh!
  const allPoints = [...mesh.anchorPoints, ...mesh.contourPoints, ...mesh.internalPoints]
  const videoFramesMesh = mesh.videoFramesMesh!
  const totalFrames = videoFramesMesh.length
  const fps = 24

  useEffect(() => {
    if (!project.videoBlob || !project.originalImageBlob) return

    const imgUrl = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imgDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(imgUrl)
    }
    img.src = imgUrl

    const vidUrl = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = vidUrl
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
      URL.revokeObjectURL(vidUrl)
    }
  }, [project.videoBlob, project.originalImageBlob])

  const drawFrame = useCallback((frameIndex: number) => {
    const canvas = canvasRef.current
    const video = videoRef.current
    const imgDims = imgDimsRef.current
    if (!canvas || !video || !imgDims) return

    const ctx = canvas.getContext('2d')!
    const cw = canvas.width
    const ch = canvas.height
    if (cw === 0 || ch === 0) return

    const scaleX = cw / video.videoWidth
    const scaleY = ch / video.videoHeight
    const vScale = Math.min(scaleX, scaleY) * 0.95
    const vox = (cw - video.videoWidth * vScale) / 2
    const voy = (ch - video.videoHeight * vScale) / 2

    const targetTime = frameIndex / fps
    if (Math.abs(video.currentTime - targetTime) > 0.02) {
      video.currentTime = targetTime
    }

    ctx.clearRect(0, 0, cw, ch)
    ctx.drawImage(video, vox, voy, video.videoWidth * vScale, video.videoHeight * vScale)

    const imgToCanvasX = (ix: number) => (ix / imgDims.width) * video.videoWidth * vScale + vox
    const imgToCanvasY = (iy: number) => (iy / imgDims.height) * video.videoHeight * vScale + voy

    const points = frameIndex === 0 ? allPoints : videoFramesMesh[frameIndex]

    ctx.strokeStyle = 'rgba(0, 200, 100, 0.6)'
    ctx.lineWidth = 1
    for (const [a, b, c] of mesh.triangles) {
      if (a >= points.length || b >= points.length || c >= points.length) continue
      const pa = points[a], pb = points[b], pc = points[c]
      ctx.beginPath()
      ctx.moveTo(imgToCanvasX(pa.x), imgToCanvasY(pa.y))
      ctx.lineTo(imgToCanvasX(pb.x), imgToCanvasY(pb.y))
      ctx.lineTo(imgToCanvasX(pc.x), imgToCanvasY(pc.y))
      ctx.closePath()
      ctx.stroke()
    }

    ctx.fillStyle = 'rgba(255, 80, 80, 0.8)'
    for (const p of points) {
      ctx.beginPath()
      ctx.arc(imgToCanvasX(p.x), imgToCanvasY(p.y), 3, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(8, 8, 110, 24)
    ctx.fillStyle = '#fff'
    ctx.font = '12px monospace'
    ctx.fillText(`Frame ${frameIndex + 1}/${totalFrames}`, 14, 24)
  }, [allPoints, videoFramesMesh, mesh.triangles, totalFrames])

  useEffect(() => {
    if (!videoReady) return
    const frameDuration = 1000 / fps

    function tick(time: number) {
      if (playing) {
        if (time - lastTimeRef.current >= frameDuration) {
          lastTimeRef.current = time
          frameRef.current = (frameRef.current + 1) % totalFrames
        }
      }
      drawFrame(frameRef.current)
      animRef.current = requestAnimationFrame(tick)
    }

    animRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animRef.current)
  }, [videoReady, playing, drawFrame, totalFrames])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const container = canvas.parentElement
    if (!container) return
    const ro = new ResizeObserver(() => {
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  return (
    <div className="flow-preview">
      <div className="flow-preview-toolbar">
        <button onClick={() => setPlaying(p => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => { frameRef.current = 0; lastTimeRef.current = 0 }}>
          Rembobiner
        </button>
        <span style={{ fontSize: '0.75rem', color: '#888' }}>
          Prévisualisation — {totalFrames} frames à 24 fps
        </span>
      </div>
      <div className="flow-preview-canvas-container">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
