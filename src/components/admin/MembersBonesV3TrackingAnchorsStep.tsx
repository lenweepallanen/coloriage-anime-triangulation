/**
 * MembersBonesV3TrackingAnchorsStep — V3 étape "Tracking Anchors zones".
 *
 * Pipeline V3 hérite anchors+subdivision de projectTriangulation. Cette étape calcule
 * leur position dans la VIDÉO frame par frame, déterministe :
 *
 *   1. Pour chaque anchor_i (i ≥ 1), s_i = arc-length sur contour image réordonné depuis P0_image
 *   2. Pour chaque frame f, mask contour réordonné depuis P0_mask_f, sample arcLengthToPoint(s_i)
 *   3. Subdivisions : computeSubdivisionForFrame(orderedMask, mask anchors, params)
 *
 * Stocke `mesh.sam2ContourAnchorFrames` + `sam2ContourSubdivisionFrames` (coords VIDÉO).
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import type { Project, Animation, Point2D, SAM2Zone } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { reorderContourFromOrigin, computeArcLengths, computeSubdivisionForFrame } from '../../utils/curvilinearContour'
import { arcLengthToPoint } from '../../utils/sam2Contour'
import { interpolatePointArrayFrames } from '../../utils/sam2ValidFrames'
import FrameNavigator from '../keyframes/FrameNavigator'

const VIDEO_FPS = 24

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/** Compute arc-length [0,1] of a point on an ordered contour by nearest-vertex projection. */
function arcLengthOf(p: Point2D, ordered: Point2D[], arcLens: number[], total: number): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < ordered.length; i++) {
    const d = (ordered[i].x - p.x) ** 2 + (ordered[i].y - p.y) ** 2
    if (d < bestDist) { bestDist = d; bestIdx = i }
  }
  return total > 0 ? arcLens[bestIdx] / total : 0
}

export default function MembersBonesV3TrackingAnchorsStep({ project, animation, onSave }: Props) {
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

  const [anchorFrames, setAnchorFrames] = useState<Record<string, Point2D[][]> | null>(
    () => mesh?.sam2ContourAnchorFrames ?? null
  )
  const [subdivisionFrames, setSubdivisionFrames] = useState<Record<string, Point2D[][]> | null>(
    () => mesh?.sam2ContourSubdivisionFrames ?? null
  )
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)

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

  // Draw loop : show contour + anchors + subdivisions
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
          ctx.lineWidth = 1.2 / t.scale
          ctx.beginPath()
          ctx.moveTo(poly[0].x * scaleX, poly[0].y * scaleY)
          for (let i = 1; i < poly.length; i++) {
            ctx.lineTo(poly[i].x * scaleX, poly[i].y * scaleY)
          }
          ctx.closePath()
          ctx.stroke()

          // Anchors (red for P0=index 0, zone color for others)
          const anchorsF = anchorFrames?.[z.id]?.[safeFrame]
          if (anchorsF) {
            for (let i = 0; i < anchorsF.length; i++) {
              const p = anchorsF[i]
              ctx.fillStyle = i === 0 ? '#ef4444' : z.color
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath()
              ctx.arc(p.x, p.y, (i === 0 ? 7 : 5) / t.scale, 0, Math.PI * 2)
              ctx.fill(); ctx.stroke()
            }
          }
          // Subdivisions
          const subF = subdivisionFrames?.[z.id]?.[safeFrame]
          if (subF) {
            ctx.fillStyle = z.color
            for (const p of subF) {
              ctx.beginPath()
              ctx.arc(p.x, p.y, 3 / t.scale, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, contoursAll, zones, currentFrame, anchorFrames, subdivisionFrames, transformRef, sam2W, sam2H, videoSize, totalFrames])

  // ----- Compute -----
  function handleCompute() {
    if (!contoursAll || !mesh || !tri || !tri.zoneAnchors || !tri.contours || !tri.zoneOrigins) return
    const originFramesAll = mesh.sam2ContourOriginFrames
    if (!originFramesAll) {
      alert('Lancez d\'abord le tracking P0 (étape précédente).')
      return
    }
    setComputing(true)
    try {
      const newAnchorFrames: Record<string, Point2D[][]> = {}
      const newSubdivisionFrames: Record<string, Point2D[][]> = {}
      const scaleX = videoSize.w / sam2W
      const scaleY = videoSize.h / sam2H

      for (const z of zones) {
        const polys = contoursAll[z.id]
        const refContour = tri.contours[z.id]
        const anchorsImage = tri.zoneAnchors[z.id]
        const subParams = tri.zoneSubdivisionParams?.[z.id] ?? []
        const p0Image = tri.zoneOrigins[z.id]
        if (!polys || !refContour || !anchorsImage || !p0Image || anchorsImage.length === 0) continue

        // Reference image contour reordered from P0
        const orderedRef = reorderContourFromOrigin(refContour, p0Image)
        const refArcLens = computeArcLengths(orderedRef)
        const refTotal = refArcLens[refArcLens.length - 1] || 1
        // Compute s_i for each anchor on the image reference (i=0 → s_0 = 0 by definition)
        const anchorS: number[] = anchorsImage.map(a => arcLengthOf(a, orderedRef, refArcLens, refTotal))
        anchorS[0] = 0 // P0

        const originFramesZ = originFramesAll[z.id]
        if (!originFramesZ) continue

        const perFrameAnchors: Point2D[][] = []
        const perFrameSubs: Point2D[][] = []

        for (let f = 0; f < polys.length; f++) {
          const poly = polys[f]
          if (!poly || poly.length < 2) {
            perFrameAnchors.push(anchorsImage.map(() => ({ x: 0, y: 0 })))
            perFrameSubs.push(subParams.map(() => ({ x: 0, y: 0 })))
            continue
          }

          // P0 in mask coords (originFrames is in video coords → divide by scale)
          const p0Video = originFramesZ[f]
          const p0Mask: Point2D = p0Video
            ? { x: p0Video.x / scaleX, y: p0Video.y / scaleY }
            : { x: poly[0].x, y: poly[0].y }

          const orderedMask = reorderContourFromOrigin(poly, p0Mask)

          // Anchors per frame in video coords
          const anchorsVideo: Point2D[] = []
          for (let i = 0; i < anchorsImage.length; i++) {
            if (i === 0) {
              // P0 is always taken from originFrames (already snapped)
              anchorsVideo.push(p0Video ?? { x: 0, y: 0 })
            } else {
              const pMask = arcLengthToPoint(anchorS[i], orderedMask)
              anchorsVideo.push({ x: pMask.x * scaleX, y: pMask.y * scaleY })
            }
          }
          perFrameAnchors.push(anchorsVideo)

          // Subdivisions : convert anchors back to mask coords for computeSubdivisionForFrame
          const anchorsMask = anchorsVideo.map(p => ({ x: p.x / scaleX, y: p.y / scaleY }))
          const subdivMask = computeSubdivisionForFrame(orderedMask, anchorsMask, subParams)
          const subdivVideo = subdivMask.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }))
          perFrameSubs.push(subdivVideo)
        }

        const validZ = mesh.sam2ZoneValidFrames?.[z.id]
        if (validZ && validZ.length === perFrameAnchors.length) {
          newAnchorFrames[z.id] = interpolatePointArrayFrames(perFrameAnchors, validZ)
          newSubdivisionFrames[z.id] = interpolatePointArrayFrames(perFrameSubs, validZ)
        } else {
          newAnchorFrames[z.id] = perFrameAnchors
          newSubdivisionFrames[z.id] = perFrameSubs
        }
      }

      setAnchorFrames(newAnchorFrames)
      setSubdivisionFrames(newSubdivisionFrames)
      console.log(`[V3-anchor-tracking] computed ${zones.length} zones × ${totalFrames} frames`)
    } catch (err) {
      console.error('[V3-anchor-tracking] failed:', err)
      alert('Erreur calcul tracking anchors : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
  }

  async function handleSave() {
    if (!mesh || !anchorFrames || !subdivisionFrames) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        sam2ContourAnchorFrames: anchorFrames,
        sam2ContourSubdivisionFrames: subdivisionFrames,
        sam2ContourAnchorTrackingValidated: true,
        // Invalidate downstream
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
        [
          { animationId: animation.id, field: 'sam2ContourAnchorFrames' },
          { animationId: animation.id, field: 'sam2ContourSubdivisionFrames' },
        ],
      )
    } catch (err) {
      console.error('[V3-anchor-tracking] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // ----- Prerequisites -----
  if (!animation.videoBlob) return <div className="placeholder">Importez d&apos;abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContourOriginTrackingValidated) {
    return <div className="placeholder">Lancez d&apos;abord le tracking P0 (étape précédente).</div>
  }
  if (!tri?.step3Validated || !tri.zoneAnchors) {
    return <div className="placeholder">Triangulation projet incomplète (anchors manquants).</div>
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Tracking Anchors V3 (déterministe depuis Triangulation projet)</span>
        <button className="btn-primary" onClick={handleCompute} disabled={computing}>
          {computing ? 'Calcul...' : (anchorFrames ? 'Recalculer' : 'Calculer Anchors par frame')}
        </button>
        <button className="btn-primary" onClick={handleSave} disabled={saving || !anchorFrames || !subdivisionFrames}>
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>
        <span className="toolbar-info">
          {zones.length} zones × {totalFrames} frames
          {anchorFrames ? ' | ✓ Calculé' : ''}
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Pour chaque zone, on récupère les anchors et la subdivision de la Triangulation
          projet, on calcule leur arc-length sur le contour image, puis on les
          échantillonne sur les contours vidéo de chaque frame.
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
            <span style={{ fontWeight: 'bold', color: 'var(--color-text)' }}>Preview tracking Anchors</span>
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
