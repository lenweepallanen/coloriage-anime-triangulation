import { useState, useEffect, useRef, useMemo } from 'react'
import type { ProjectStepView, Point2D, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { pointToArcLength, arcLengthToPoint } from '../../utils/sam2Contour'
import { detectGlobalCurvatureExtrema } from '../../utils/curvatureScaleSpace'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const VIDEO_FPS = 24

/**
 * Étape 5 du pipeline members-bones : tracking déterministe de P0 par zone via la
 * coordonnée curviligne sur les contours SAM 2 lissés. Pas d'optical flow — calcul
 * instantané (~50 ms × 5 zones).
 *
 * Pour chaque zone :
 *   1. Calculer s_0 = pointToArcLength(P0, contour_frame_0)
 *   2. Pour chaque frame f, échantillonner arcLengthToPoint(s_0, contour_frame_f)
 *
 * Stocke `mesh.sam2ContourOriginFrames: Record<zoneId, Point2D[]>`.
 */
export default function MembersBonesContourOriginTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null
  const origins = useMemo(() => mesh?.sam2ContourOrigins ?? {}, [mesh?.sam2ContourOrigins])
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0

  const totalFrames = useMemo(() => {
    if (!contoursAll) return 0
    const first = Object.values(contoursAll)[0]
    return first?.length ?? 0
  }, [contoursAll])

  // ----- State -----
  const [originFrames, setOriginFrames] = useState<Record<string, Point2D[]> | null>(
    () => mesh?.sam2ContourOriginFrames ?? null
  )
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)

  // ----- Video element + canvas -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      video.currentTime = 0
      video.onseeked = () => {
        videoRef.current = video
        setVideoSize({ w: video.videoWidth, h: video.videoHeight })
        setVideoReady(true)
      }
    }
    video.load()
    return () => {
      video.pause()
      URL.revokeObjectURL(url)
      videoRef.current = null
      fittedRef.current = false
    }
  }, [project.videoBlob])

  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

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

  // Seek video to currentFrame
  useEffect(() => {
    if (!videoReady) return
    const video = videoRef.current
    if (!video) return
    video.currentTime = currentFrame / VIDEO_FPS
  }, [currentFrame, videoReady])

  // Reset frame to 0 when origin frames change. React official compare-during-render pattern.
  const [prevOriginFrames, setPrevOriginFrames] = useState<Record<string, Point2D[]> | null>(originFrames)
  if (prevOriginFrames !== originFrames) {
    setPrevOriginFrames(originFrames)
    setCurrentFrame(0)
  }

  // Draw loop
  useEffect(() => {
    let running = true
    let rafId = 0
    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video || !videoReady) {
        rafId = requestAnimationFrame(draw)
        return
      }
      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr
      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)

      // Draw current video frame
      ctx.drawImage(video, 0, 0)

      // Draw contours of current frame (mask coords → video coords scale)
      if (contoursAll && sam2W > 0 && sam2H > 0) {
        const scaleX = videoSize.w / sam2W
        const scaleY = videoSize.h / sam2H
        const safeFrame = Math.min(currentFrame, totalFrames - 1)
        for (const z of zones) {
          const polys = contoursAll[z.id]
          if (!polys || polys.length === 0) continue
          const poly = polys[safeFrame]
          if (!poly || poly.length < 2) continue
          ctx.strokeStyle = z.color
          ctx.lineWidth = 1.5 / t.scale
          ctx.beginPath()
          ctx.moveTo(poly[0].x * scaleX, poly[0].y * scaleY)
          for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(poly[i].x * scaleX, poly[i].y * scaleY)
          }
          ctx.closePath()
          ctx.stroke()

          // Draw P0 of this frame for this zone (in video coords already)
          if (originFrames) {
            const p0Frames = originFrames[z.id]
            if (p0Frames && p0Frames[safeFrame]) {
              const p0 = p0Frames[safeFrame]
              const r = 8 / t.scale
              ctx.fillStyle = z.color
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 2 / t.scale
              ctx.beginPath()
              ctx.arc(p0.x, p0.y, r, 0, Math.PI * 2)
              ctx.fill()
              ctx.stroke()
            }
          } else {
            // Show only the static origin (frame 0)
            const p0 = origins[z.id]
            if (p0 && currentFrame === 0) {
              const r = 6 / t.scale
              ctx.fillStyle = z.color
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 2 / t.scale
              ctx.beginPath()
              ctx.arc(p0.x, p0.y, r, 0, Math.PI * 2)
              ctx.fill()
              ctx.stroke()
            }
          }
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, contoursAll, zones, currentFrame, originFrames, origins, transformRef, sam2W, sam2H, videoSize, totalFrames])

  // ----- Compute per-frame P0 (curvilinear + snap to nearest curvature extremum) -----
  function handleCompute() {
    if (!contoursAll || !mesh) return
    setComputing(true)
    const N_EXTREMA = 20
    try {
      const result: Record<string, Point2D[]> = {}
      const scaleX = videoSize.w / sam2W
      const scaleY = videoSize.h / sam2H
      for (const z of zones) {
        const polys = contoursAll[z.id]
        if (!polys || polys.length === 0) continue
        const p0Video = origins[z.id]
        if (!p0Video) continue

        // P0 is stored in video coords; convert to mask coords for curvilinear projection
        const p0Mask: Point2D = { x: p0Video.x / scaleX, y: p0Video.y / scaleY }

        // Compute s_0 on frame 0 contour (mask coords)
        const frame0 = polys[0]
        if (!frame0 || frame0.length < 2) {
          result[z.id] = polys.map(() => p0Video)
          continue
        }
        const s0 = pointToArcLength(p0Mask, frame0)

        // For each frame: sample at s_0, then snap to nearest curvature extremum
        const perFrame: Point2D[] = polys.map(poly => {
          if (!poly || poly.length < 2) return p0Video
          const raw = arcLengthToPoint(s0, poly)
          // Detect extrema and snap to the nearest by arc-length distance
          const extrema = detectGlobalCurvatureExtrema(poly, N_EXTREMA)
          if (extrema.length > 0) {
            let bestExt = extrema[0]
            let bestArcDist = Infinity
            for (const ext of extrema) {
              let d = Math.abs(ext.arcLengthNorm - s0)
              if (d > 0.5) d = 1 - d  // circular wrap
              if (d < bestArcDist) { bestArcDist = d; bestExt = ext }
            }
            return { x: bestExt.position.x * scaleX, y: bestExt.position.y * scaleY }
          }
          return { x: raw.x * scaleX, y: raw.y * scaleY }
        })
        result[z.id] = perFrame
      }
      setOriginFrames(result)
      console.log(`[origin-tracking] computed ${zones.length} zones × ${totalFrames} frames (extrema snap)`)
    } catch (err) {
      console.error('[origin-tracking] failed:', err)
      alert('Erreur calcul tracking P0 : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
  }

  // ----- Save -----
  async function handleSave() {
    if (!mesh || !originFrames) return
    setSaving(true)
    try {
      const updated = {
        ...mesh,
        sam2ContourOriginFrames: originFrames,
        sam2ContourOriginTrackingValidated: true,
      }
      await onSave({ ...project, mesh: updated }, ['sam2ContourOriginFrames'])
    } catch (err) {
      console.error('[origin-tracking] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!project.videoBlob) return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContoursValidated || !contoursAll) {
    return <div className="placeholder">Calculez d'abord les contours lissés (étape 3).</div>
  }
  const allFilledP0 = zones.length > 0 && zones.every(z => origins[z.id] != null)
  if (!allFilledP0) {
    return <div className="placeholder">Placez d'abord les P0 pour toutes les zones (étape 4).</div>
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Tracking P0 par zone (déterministe)</span>
        <button
          className="btn-primary"
          onClick={handleCompute}
          disabled={computing}
        >
          {computing ? 'Calcul...' : (originFrames ? 'Recalculer' : 'Calculer P0 par frame')}
        </button>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !originFrames}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>
        <span className="toolbar-info">
          {zones.length} zones × {totalFrames} frames
          {originFrames ? ' | ✓ Calculé' : ''}
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Pour chaque zone, on échantillonne le contour de chaque frame à la coordonnée
          curviligne du P0, puis on snappe sur l'extremum de courbure le plus proche.
          Scrubber le slider pour vérifier que les P0 suivent bien les points caractéristiques.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas ref={canvasRef} />
      </div>

      {totalFrames > 0 && (
        <>
          <div style={{
            padding: '6px 16px',
            fontSize: '0.8rem',
            color: 'var(--color-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ fontWeight: 'bold', color: 'var(--color-text)' }}>Preview tracking P0</span>
            <span>Frame {currentFrame + 1} / {totalFrames}</span>
          </div>
          <FrameNavigator
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            editedFrames={EMPTY_SET}
            onNavigate={setCurrentFrame}
          />
        </>
      )}
    </div>
  )
}

const EMPTY_SET: Set<number> = new Set()
