/**
 * MembersBonesV3LegBoneSmoothingStep — V3 étape "Lissage Bones Pattes".
 *
 * Pré-résout hip/knee/foot par patte par frame (en coords VIDÉO) via resolveSkeletonFrame,
 * puis applique un Butterworth temporel sur les 3 trajectoires de chaque patte. Coupe
 * le jitter haute fréquence introduit par l'IK 2-bones du genou avant le LBS, ce qui est
 * plus principal que de lisser le mesh résultant. L'étape "Calcul Pattes" suivante
 * détectera `sam2LegBoneFramesSmoothed` et bypassera resolveSkeletonFrame.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { resolveSkeletonFrame, computeLegRestPose, type Sam2SkeletonFrame } from '../../utils/sam2BoneSolver'
import { applyTemporalSmoothing } from '../../utils/trackingConstraints'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

const VIDEO_FPS = 24
const EMPTY_SET = new Set<number>()

type LegBoneFrames = { hip: Point2D[]; knee: Point2D[]; foot: Point2D[] }

/** Convert image-coords body frames to video coords for hip override. */
function imageToVideoFrame(p: Point2D, imgW: number, imgH: number, vidW: number, vidH: number): Point2D {
  return { x: (p.x / imgW) * vidW, y: (p.y / imgH) * vidH }
}

/** Wrap 3 trajectories of a leg as Point2D[][] for applyTemporalSmoothing. */
function smoothLegFrames(raw: LegBoneFrames, cutoffHz: number): LegBoneFrames {
  const N = raw.hip.length
  if (N === 0) return raw
  // Build [frame][3 anchors: hip, knee, foot]
  const frames: Point2D[][] = new Array(N)
  for (let f = 0; f < N; f++) {
    frames[f] = [raw.hip[f], raw.knee[f], raw.foot[f]]
  }
  const smoothed = applyTemporalSmoothing(frames, undefined, cutoffHz, VIDEO_FPS)
  const out: LegBoneFrames = { hip: new Array(N), knee: new Array(N), foot: new Array(N) }
  for (let f = 0; f < N; f++) {
    out.hip[f] = smoothed[f][0]
    out.knee[f] = smoothed[f][1]
    out.foot[f] = smoothed[f][2]
  }
  return out
}

export default function MembersBonesV3LegBoneSmoothingStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh

  const anchorFrames = useMemo(
    () => mesh?.sam2SmoothedAnchorFrames ?? mesh?.sam2ContourAnchorFrames ?? null,
    [mesh?.sam2SmoothedAnchorFrames, mesh?.sam2ContourAnchorFrames],
  )
  const bodyFramesImg = mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null
  const skeleton = mesh?.sam2Skeleton ?? null
  const vidW = mesh?.sam2VideoWidth ?? 1
  const vidH = mesh?.sam2VideoHeight ?? 1

  const totalFrames = useMemo(() => {
    if (!anchorFrames) return 0
    const first = Object.values(anchorFrames)[0]
    return first?.length ?? 0
  }, [anchorFrames])

  // ----- State -----
  const [cutoffHz, setCutoffHz] = useState(() => mesh?.sam2LegBoneSmoothingCutoffHz ?? 4)
  const [rawBoneFrames, setRawBoneFrames] = useState<Record<string, LegBoneFrames> | null>(
    () => mesh?.sam2LegBoneFrames ?? null,
  )
  const [smoothedBoneFrames, setSmoothedBoneFrames] = useState<Record<string, LegBoneFrames> | null>(
    () => mesh?.sam2LegBoneFramesSmoothed ?? null,
  )
  const [showRaw, setShowRaw] = useState(false)
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)

  // Re-smooth in real time when slider moves and we have raw frames
  useEffect(() => {
    if (!rawBoneFrames) return
    const out: Record<string, LegBoneFrames> = {}
    for (const zoneId of Object.keys(rawBoneFrames)) {
      out[zoneId] = smoothLegFrames(rawBoneFrames[zoneId], cutoffHz)
    }
    setSmoothedBoneFrames(out)
  }, [rawBoneFrames, cutoffHz])

  // ----- Project image dimensions (needed to rescale walkBodyFrames image→video) -----
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  useEffect(() => {
    const blob = project.originalImageBlob ?? project.projectTriangulation?.referenceImageBlob
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [project.originalImageBlob, project.projectTriangulation?.referenceImageBlob])

  // ----- Video element + canvas -----
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

  // Draw loop
  useEffect(() => {
    let running = true
    let rafId = 0
    const draw = () => {
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

      const safeFrame = Math.min(currentFrame, totalFrames - 1)
      const display = showRaw ? rawBoneFrames : (smoothedBoneFrames ?? rawBoneFrames)

      if (display) {
        for (const zoneId of Object.keys(display)) {
          const fr = display[zoneId]
          if (!fr || fr.hip.length === 0) continue
          const hip = fr.hip[safeFrame]
          const knee = fr.knee[safeFrame]
          const foot = fr.foot[safeFrame]
          if (!hip || !knee || !foot) continue
          ctx.strokeStyle = showRaw ? '#ef4444' : '#22c55e'
          ctx.lineWidth = 3 / t.scale
          ctx.beginPath()
          ctx.moveTo(hip.x, hip.y)
          ctx.lineTo(knee.x, knee.y)
          ctx.lineTo(foot.x, foot.y)
          ctx.stroke()
          for (const [p, fill] of [[hip, '#fbbf24'], [knee, '#3b82f6'], [foot, '#a855f7']] as const) {
            ctx.fillStyle = fill
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1.5 / t.scale
            ctx.beginPath()
            ctx.arc(p.x, p.y, 6 / t.scale, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
          }
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, currentFrame, totalFrames, transformRef, rawBoneFrames, smoothedBoneFrames, showRaw])

  // ----- Compute raw bone frames -----
  const handleCompute = useCallback(() => {
    if (!skeleton || !anchorFrames) return
    setComputing(true)
    try {
      // bodyFramesImg are in IMAGE coords → rescale to video coords for hip override.
      const bodyFramesVid: Point2D[][] | null = (bodyFramesImg && imgSize.w > 0 && imgSize.h > 0)
        ? bodyFramesImg.map(frame => frame.map(p => imageToVideoFrame(p, imgSize.w, imgSize.h, vidW, vidH)))
        : null

      // Compute leg rest poses (frame 0)
      const bodyF0Vid = bodyFramesVid?.[0] ?? null
      const legRestPoses = skeleton.legs.map(leg => computeLegRestPose(leg, anchorFrames, bodyF0Vid))

      const result: Record<string, LegBoneFrames> = {}
      for (const leg of skeleton.legs) {
        result[leg.zoneId] = { hip: new Array(totalFrames), knee: new Array(totalFrames), foot: new Array(totalFrames) }
      }

      let prevFrame: Sam2SkeletonFrame | null = null
      for (let f = 0; f < totalFrames; f++) {
        const bodyFVid = bodyFramesVid?.[f] ?? null
        const skelFrame = resolveSkeletonFrame(skeleton, anchorFrames, f, legRestPoses, prevFrame, bodyFVid)
        prevFrame = skelFrame
        for (let li = 0; li < skeleton.legs.length; li++) {
          const zoneId = skeleton.legs[li].zoneId
          const lf = skelFrame.legs[li]
          result[zoneId].hip[f] = lf.hip
          result[zoneId].knee[f] = lf.knee
          result[zoneId].foot[f] = lf.foot
        }
      }
      setRawBoneFrames(result)
    } catch (err) {
      console.error('[V3-leg-bone-smooth] compute failed:', err)
      alert('Erreur calcul bones : ' + (err instanceof Error ? err.message : err))
    } finally {
      setComputing(false)
    }
  }, [skeleton, anchorFrames, bodyFramesImg, totalFrames, vidW, vidH, imgSize])

  // ----- Save -----
  const handleSave = useCallback(async (validate: boolean) => {
    if (!mesh || !rawBoneFrames || !smoothedBoneFrames) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        sam2LegBoneFrames: rawBoneFrames,
        sam2LegBoneFramesSmoothed: smoothedBoneFrames,
        sam2LegBoneSmoothingCutoffHz: cutoffHz,
        sam2LegBoneSmoothingValidated: validate,
        // Cascade: invalidate downstream leg LBS results
        walkZoneFrames: null,
        walkZoneFramesSmoothed: null,
        walkZoneFramesSmoothingValidated: false,
      }
      const updatedAnimations = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a,
      )
      await onSave({ ...project, animations: updatedAnimations }, [])
    } catch (err) {
      console.error('[V3-leg-bone-smooth] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    } finally {
      setSaving(false)
    }
  }, [mesh, rawBoneFrames, smoothedBoneFrames, cutoffHz, project, animation.id, onSave])

  // ----- Prerequisites -----
  if (!animation.videoBlob) return <div className="placeholder">Importez d&apos;abord une vidéo (étape 1).</div>
  if (!skeleton || (skeleton.legs?.length ?? 0) === 0) {
    return <div className="placeholder">Définissez d&apos;abord les bones pattes (étape précédente).</div>
  }
  if (!anchorFrames) {
    return <div className="placeholder">Tracking anchors manquant.</div>
  }

  const isValidated = mesh?.sam2LegBoneSmoothingValidated === true

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Lissage Bones Pattes</span>

        <button className="btn-primary" onClick={handleCompute} disabled={computing}>
          {computing ? 'Calcul...' : (rawBoneFrames ? 'Recalculer bones' : 'Calculer bones par frame')}
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.85rem' }}>Cutoff :</span>
          <input
            type="range" min={1} max={10} step={0.5}
            value={cutoffHz}
            onChange={(e) => setCutoffHz(parseFloat(e.target.value))}
            disabled={!rawBoneFrames}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: '0.85rem', minWidth: 36, textAlign: 'right' }}>{cutoffHz} Hz</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem' }}>
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          Brut (rouge)
        </label>

        <button className="btn-primary" onClick={() => handleSave(false)} disabled={saving || !smoothedBoneFrames}>
          Sauvegarder
        </button>
        <button className="btn-primary" onClick={() => handleSave(true)} disabled={saving || !smoothedBoneFrames}>
          {saving ? '...' : 'Valider'}
        </button>

        <span className="toolbar-info">
          {skeleton.legs.length} pattes × {totalFrames} frames
          {isValidated ? ` | ✓ Validé (${mesh?.sam2LegBoneSmoothingCutoffHz} Hz)` : ''}
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Pré-résout hip/knee/foot par patte, puis lisse temporellement (Butterworth) les
          trajectoires. Le LBS suivant utilisera ces positions lissées au lieu de re-résoudre
          l&apos;IK frame par frame, ce qui élimine le jitter du genou à la source. Toggle
          &quot;Brut&quot; pour comparer.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas ref={canvasRef} />
      </div>

      {totalFrames > 0 && (
        <>
          <div style={{ padding: '6px 16px', fontSize: '0.8rem', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontWeight: 'bold', color: 'var(--color-text)' }}>Preview bones</span>
            <span>Frame {currentFrame + 1} / {totalFrames}</span>
            <span>{showRaw ? 'Brut' : 'Lissé'}</span>
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
