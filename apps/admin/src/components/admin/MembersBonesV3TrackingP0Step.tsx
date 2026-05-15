/**
 * MembersBonesV3TrackingP0Step — V3 étape "Tracking P0 zones".
 *
 * Pipeline V3 hérite la P0 de chaque zone depuis projectTriangulation.zoneOrigins
 * (coords IMAGE). Cette étape calcule la position de P0 dans la VIDÉO frame par frame :
 *
 *   1. s_0 = pointToArcLength(p0_image, projectTriangulation.contours[zoneId])
 *   2. Pour chaque frame f, sample arcLengthToPoint(s_0, mesh.sam2Contours[zoneId][f])
 *   3. Snap sur l'extremum de courbure le plus proche (en distance d'arc circulaire)
 *
 * Stocke `mesh.sam2ContourOriginFrames` (coords VIDÉO).
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import type { Project, Animation, Point2D, SAM2Zone } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { pointToArcLength, arcLengthToPoint } from '../../utils/sam2Contour'
import { detectGlobalCurvatureExtrema } from '../../utils/curvatureScaleSpace'
import { interpolatePointFrames } from '../../utils/sam2ValidFrames'
import FrameNavigator from '../keyframes/FrameNavigator'

const VIDEO_FPS = 24
const N_EXTREMA = 20

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function MembersBonesV3TrackingP0Step({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0

  const totalFrames = useMemo(() => {
    if (!contoursAll) return 0
    const first = Object.values(contoursAll)[0]
    return first?.length ?? 0
  }, [contoursAll])

  const [originFrames, setOriginFrames] = useState<Record<string, Point2D[]> | null>(
    () => mesh?.sam2ContourOriginFrames ?? null
  )
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)

  // Video element + canvas
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  useEffect(() => {
    if (!animation.videoBlob) return
    const url = URL.createObjectURL(animation.videoBlob)
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
  }, [animation.videoBlob])

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

  useEffect(() => {
    if (!videoReady) return
    const video = videoRef.current
    if (!video) return
    video.currentTime = currentFrame / VIDEO_FPS
  }, [currentFrame, videoReady])

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
      ctx.drawImage(video, 0, 0)

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

          if (originFrames) {
            const p0 = originFrames[z.id]?.[safeFrame]
            if (p0) {
              const r = 8 / t.scale
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
  }, [videoReady, contoursAll, zones, currentFrame, originFrames, transformRef, sam2W, sam2H, videoSize, totalFrames])

  // ----- Compute deterministic per-frame P0 from projectTriangulation -----
  function handleCompute() {
    if (!contoursAll || !mesh || !tri || !tri.zoneOrigins || !tri.contours) return
    setComputing(true)
    try {
      const result: Record<string, Point2D[]> = {}
      const scaleX = videoSize.w / sam2W
      const scaleY = videoSize.h / sam2H
      for (const z of zones) {
        const polys = contoursAll[z.id]
        if (!polys || polys.length === 0) continue
        const p0Image = tri.zoneOrigins[z.id]
        const refContour = tri.contours[z.id]
        if (!p0Image || !refContour || refContour.length < 2) continue

        // Compute s_0 on the IMAGE reference contour (coords image)
        const s0 = pointToArcLength(p0Image, refContour)

        // For each video frame: sample at s_0 on mask contour, snap to extremum
        const perFrame: Point2D[] = polys.map(poly => {
          if (!poly || poly.length < 2) return { x: 0, y: 0 }
          const raw = arcLengthToPoint(s0, poly)
          const extrema = detectGlobalCurvatureExtrema(poly, N_EXTREMA)
          if (extrema.length > 0) {
            let bestExt = extrema[0]
            let bestArcDist = Infinity
            for (const ext of extrema) {
              let d = Math.abs(ext.arcLengthNorm - s0)
              if (d > 0.5) d = 1 - d
              if (d < bestArcDist) { bestArcDist = d; bestExt = ext }
            }
            return { x: bestExt.position.x * scaleX, y: bestExt.position.y * scaleY }
          }
          return { x: raw.x * scaleX, y: raw.y * scaleY }
        })
        const validZ = mesh.sam2ZoneValidFrames?.[z.id]
        result[z.id] = validZ && validZ.length === perFrame.length
          ? interpolatePointFrames(perFrame, validZ)
          : perFrame
      }
      setOriginFrames(result)
      console.log(`[V3-origin-tracking] computed ${zones.length} zones × ${totalFrames} frames`)
    } catch (err) {
      console.error('[V3-origin-tracking] failed:', err)
      alert('Erreur calcul tracking P0 : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
  }

  async function handleSave() {
    if (!mesh || !originFrames) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        sam2ContourOriginFrames: originFrames,
        sam2ContourOriginTrackingValidated: true,
        // Invalidate downstream
        sam2ContourAnchorFrames: null,
        sam2ContourSubdivisionFrames: null,
        sam2ContourAnchorTrackingValidated: false,
        sam2SmoothedAnchorFrames: null,
        sam2SmoothedSubdivisionFrames: null,
        sam2SmoothedContourOriginFrames: null,
        sam2SmoothingValidated: false,
        walkBodyFrames: null,
        walkBodyFramesSmoothed: null,
        walkBodyFramesSmoothingValidated: false,
      }
      const updatedAnimations = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave(
        { ...project, animations: updatedAnimations },
        [{ animationId: animation.id, field: 'sam2ContourOriginFrames' }],
      )
    } catch (err) {
      console.error('[V3-origin-tracking] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!animation.videoBlob) return <div className="placeholder">Importez d&apos;abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContoursValidated || !contoursAll) {
    return <div className="placeholder">Calculez d&apos;abord les contours lissés (étape 3).</div>
  }
  if (!tri?.step3Validated) {
    return <div className="placeholder">Validez d&apos;abord la Triangulation projet jusqu&apos;à l&apos;étape Faces cachées.</div>
  }
  if (!tri.zoneOrigins || !tri.contours) {
    return <div className="placeholder">P0 par zone manquant dans la Triangulation projet.</div>
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Tracking P0 V3 (déterministe depuis Triangulation projet)</span>
        <button className="btn-primary" onClick={handleCompute} disabled={computing}>
          {computing ? 'Calcul...' : (originFrames ? 'Recalculer' : 'Calculer P0 par frame')}
        </button>
        <button className="btn-primary" onClick={handleSave} disabled={saving || !originFrames}>
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>
        <span className="toolbar-info">
          {zones.length} zones × {totalFrames} frames
          {originFrames ? ' | ✓ Calculé' : ''}
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Pour chaque zone, on récupère le P0 de la Triangulation projet (coords image),
          on calcule sa coord. curviligne sur le contour image de référence, puis on
          échantillonne le contour vidéo à chaque frame à cette même position et on snappe
          sur l&apos;extremum de courbure le plus proche.
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
