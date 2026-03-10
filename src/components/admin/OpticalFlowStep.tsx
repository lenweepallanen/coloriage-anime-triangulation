import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project } from '../../types/project'
import type { Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker, type FlowMetrics } from '../../utils/perspectiveCorrection'
import { precomputeOpticalFlow } from '../../utils/opticalFlowComputer'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function OpticalFlowStep({ project, onSave }: Props) {
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState({ stage: '', current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [frameMetrics, setFrameMetrics] = useState<FlowMetrics[]>([])
  const [showMetrics, setShowMetrics] = useState(false)

  const hasMesh = project.mesh && project.mesh.triangles.length > 0
  const hasVideo = !!project.videoBlob
  const hasFlow = project.mesh?.videoFramesMesh != null

  async function handleCompute() {
    if (!project.mesh || !project.videoBlob || !project.originalImageBlob) return

    setComputing(true)
    setError(null)

    try {
      setProgress({ stage: 'Chargement OpenCV...', current: 0, total: 1 })
      await loadOpenCVWorker()

      // Get image dimensions
      const imgDims = await getImageDimensions(project.originalImageBlob)

      const allPoints = [...project.mesh.contourPoints, ...project.mesh.internalPoints]

      const metricsAccumulator: FlowMetrics[] = []
      setFrameMetrics([])

      const { videoFramesMesh } = await precomputeOpticalFlow(
        null,
        project.videoBlob,
        allPoints,
        imgDims.width,
        imgDims.height,
        project.mesh.triangles,
        (stage, current, total) => setProgress({ stage, current, total }),
        (_frameIndex, metrics) => {
          metricsAccumulator.push(metrics)
          if (metricsAccumulator.length % 10 === 0) setFrameMetrics([...metricsAccumulator])
        }
      )
      setFrameMetrics(metricsAccumulator)

      await onSave({
        ...project,
        mesh: {
          ...project.mesh,
          videoFramesMesh,
        },
      }, ['videoFramesMesh'])
    } catch (err) {
      console.error('Optical flow computation failed:', err)
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
    }

    setComputing(false)
  }

  if (!hasVideo || !hasMesh) {
    return (
      <div className="placeholder">
        {!hasVideo && 'Importez d\'abord une vidéo. '}
        {!hasMesh && 'Définissez d\'abord un mesh dans l\'onglet Triangulation.'}
      </div>
    )
  }

  const progressPercent = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0

  return (
    <div className="optical-flow-step">
      <h3>Pré-calcul du tracking optique</h3>
      <p style={{ fontSize: '0.875rem', color: '#888', marginBottom: 16 }}>
        Ce calcul suit les points du mesh à travers chaque frame de la vidéo
        via l'algorithme Lucas-Kanade. Le résultat permet d'animer le mesh
        en synchronisation avec la vidéo.
      </p>

      {hasFlow && (
        <>
          <div className="flow-status">
            Tracking déjà calculé ({project.mesh!.videoFramesMesh!.length} frames).
            Vous pouvez recalculer si vous avez modifié le mesh.
          </div>
          <FlowPreview project={project} />
        </>
      )}

      <div className="triangulation-toolbar">
        <button onClick={handleCompute} disabled={computing}>
          {computing ? 'Calcul en cours...' : hasFlow ? 'Recalculer' : 'Lancer le calcul'}
        </button>
      </div>

      {computing && (
        <div className="progress-container">
          <div className="progress-label">
            {progress.stage} — {progress.current}/{progress.total} ({progressPercent}%)
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="error-message">
          Erreur : {error}
        </div>
      )}

      {frameMetrics.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowMetrics(s => !s)}
            style={{ fontSize: '0.8rem', padding: '4px 10px', background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: 4, cursor: 'pointer' }}
          >
            {showMetrics ? 'Masquer' : 'Afficher'} les métriques ({frameMetrics.length} frames)
          </button>
          {showMetrics && <FlowMetricsPanel metrics={frameMetrics} />}
        </div>
      )}
    </div>
  )
}

function FlowMetricsPanel({ metrics }: { metrics: FlowMetrics[] }) {
  const n = metrics.length
  if (n === 0) return null

  const sum = (fn: (m: FlowMetrics) => number) => metrics.reduce((acc, m) => acc + fn(m), 0)
  const avg = (fn: (m: FlowMetrics) => number) => sum(fn) / n
  const totalPts = metrics[0].totalPoints

  const pct = (val: number) => totalPts > 0 ? (val / totalPts * 100).toFixed(1) + '%' : '—'

  const rows: { label: string; stage: string; value: number; warn: boolean }[] = [
    { label: 'S1 Status+Erreur LK', stage: 'Rejet', value: avg(m => m.rejectedS1), warn: avg(m => m.rejectedS1) > totalPts * 0.2 },
    { label: 'S2 Forward-Backward', stage: 'Rejet', value: avg(m => m.rejectedS2), warn: avg(m => m.rejectedS2) > totalPts * 0.2 },
    { label: 'S2.5 Couleur', stage: 'Rejet', value: avg(m => m.rejectedS2_5), warn: avg(m => m.rejectedS2_5) > totalPts * 0.2 },
    { label: 'S3 Displacement cap', stage: 'Rejet', value: avg(m => m.rejectedS3), warn: avg(m => m.rejectedS3) > totalPts * 0.1 },
    { label: 'S4 Median outlier', stage: 'Rejet', value: avg(m => m.rejectedS4), warn: avg(m => m.rejectedS4) > totalPts * 0.2 },
    { label: 'S5 Edge length', stage: 'Rejet', value: avg(m => m.rejectedS5), warn: avg(m => m.rejectedS5) > totalPts * 0.2 },
    { label: 'S6 Reconstruction', stage: 'Reconstruit', value: avg(m => m.reconstructedS6), warn: false },
    { label: 'S6.5 Contraintes geo', stage: 'Corrigé', value: avg(m => m.correctedS6_5), warn: false },
    { label: 'S7 Color snap', stage: 'Snappé', value: avg(m => m.snappedS7), warn: false },
    { label: 'S7 Freeze', stage: 'Gelé', value: avg(m => m.frozenS7), warn: avg(m => m.frozenS7) > totalPts * 0.1 },
  ]

  const avgDisp = avg(m => m.avgDisplacement)
  const maxMaxDisp = Math.max(...metrics.map(m => m.maxDisplacement))

  const cellStyle: React.CSSProperties = { padding: '3px 8px', borderBottom: '1px solid #444', fontSize: '0.75rem' }

  return (
    <div style={{ marginTop: 8, background: '#1a1a2e', border: '1px solid #444', borderRadius: 6, padding: 12, maxWidth: 520 }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: 8, color: '#ddd' }}>
        Moyennes sur {n} frames — {totalPts} points/frame
      </div>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr style={{ color: '#999', fontSize: '0.7rem', textAlign: 'left' }}>
            <th style={cellStyle}>Stage</th>
            <th style={cellStyle}>Type</th>
            <th style={{ ...cellStyle, textAlign: 'right' }}>Moy/frame</th>
            <th style={{ ...cellStyle, textAlign: 'right' }}>% points</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label} style={{ color: r.warn ? '#ff6b6b' : '#ccc' }}>
              <td style={cellStyle}>{r.label}</td>
              <td style={cellStyle}>{r.stage}</td>
              <td style={{ ...cellStyle, textAlign: 'right', fontFamily: 'monospace' }}>{r.value.toFixed(1)}</td>
              <td style={{ ...cellStyle, textAlign: 'right', fontFamily: 'monospace' }}>{pct(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 8, fontSize: '0.7rem', color: '#999' }}>
        Déplacement moyen : {avgDisp.toFixed(2)}px — Max observé : {maxMaxDisp.toFixed(1)}px
      </div>
    </div>
  )
}

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
  const allPoints = [...mesh.contourPoints, ...mesh.internalPoints]
  const videoFramesMesh = mesh.videoFramesMesh!
  const totalFrames = videoFramesMesh.length
  const fps = 24

  // Load video + get image dimensions
  useEffect(() => {
    if (!project.videoBlob || !project.originalImageBlob) return

    // Get image dimensions to compute coordinate mapping
    const imgUrl = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imgDimsRef.current = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(imgUrl)
    }
    img.src = imgUrl

    // Load video
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

    // Scale video to fit canvas
    const scaleX = cw / video.videoWidth
    const scaleY = ch / video.videoHeight
    const vScale = Math.min(scaleX, scaleY) * 0.95
    const vox = (cw - video.videoWidth * vScale) / 2
    const voy = (ch - video.videoHeight * vScale) / 2

    // Seek video to match frame
    const targetTime = frameIndex / fps
    if (Math.abs(video.currentTime - targetTime) > 0.02) {
      video.currentTime = targetTime
    }

    ctx.clearRect(0, 0, cw, ch)
    ctx.drawImage(video, vox, voy, video.videoWidth * vScale, video.videoHeight * vScale)

    // Mesh points are in image coordinates — convert to canvas coordinates
    // image coords → video coords → canvas coords
    const imgToCanvasX = (ix: number) => (ix / imgDims.width) * video.videoWidth * vScale + vox
    const imgToCanvasY = (iy: number) => (iy / imgDims.height) * video.videoHeight * vScale + voy

    const points: Point2D[] = frameIndex === 0 ? allPoints : videoFramesMesh[frameIndex]

    // Draw triangles
    ctx.strokeStyle = 'rgba(0, 200, 100, 0.6)'
    ctx.lineWidth = 1
    for (const [a, b, c] of mesh.triangles) {
      const pa = points[a], pb = points[b], pc = points[c]
      ctx.beginPath()
      ctx.moveTo(imgToCanvasX(pa.x), imgToCanvasY(pa.y))
      ctx.lineTo(imgToCanvasX(pb.x), imgToCanvasY(pb.y))
      ctx.lineTo(imgToCanvasX(pc.x), imgToCanvasY(pc.y))
      ctx.closePath()
      ctx.stroke()
    }

    // Draw points
    ctx.fillStyle = 'rgba(255, 80, 80, 0.8)'
    for (const p of points) {
      ctx.beginPath()
      ctx.arc(imgToCanvasX(p.x), imgToCanvasY(p.y), 3, 0, Math.PI * 2)
      ctx.fill()
    }

    // Frame counter
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(8, 8, 110, 24)
    ctx.fillStyle = '#fff'
    ctx.font = '12px monospace'
    ctx.fillText(`Frame ${frameIndex + 1}/${totalFrames}`, 14, 24)
  }, [allPoints, videoFramesMesh, mesh.triangles, totalFrames])

  // Animation loop
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

  // Resize canvas to container
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
          Prévisualisation du tracking — {totalFrames} frames à 24 fps
        </span>
      </div>
      <div className="flow-preview-canvas-container">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}

function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}
