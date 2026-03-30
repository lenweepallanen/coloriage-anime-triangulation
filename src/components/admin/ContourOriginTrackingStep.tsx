import { useState, useRef, useCallback, useMemo } from 'react'
import type { ProjectStepView, Point2D, MeshData, KeyframeData } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import type { TrackingConstraintParams } from '../../utils/opticalFlowComputer'
import { precomputeOpticalFlow, trackSegment } from '../../utils/opticalFlowComputer'
import { propagateKeyframes } from '../../utils/keyframePropagation'
import KeyframeEditor from '../keyframes/KeyframeEditor'
import FrameNavigator from '../keyframes/FrameNavigator'
import { loadOpenCVWorker, flowCannyContour } from '../../utils/perspectiveCorrection'
import { ContourSpatialIndex } from '../../utils/contourSpatialIndex'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

type Phase = 'config' | 'tracking' | 'editing' | 'validated'

export default function ContourOriginTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const contourOrigin = mesh?.contourOrigin
  const cannyParams = mesh?.cannyParams

  const initialPhase: Phase = mesh?.contourOriginTrackingValidated
    ? 'validated'
    : (mesh?.contourOriginKeyframes?.length ?? 0) > 0
      ? 'editing'
      : 'config'

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [progress, setProgress] = useState('')
  const [saving, setSaving] = useState(false)
  const [propagating, setPropagating] = useState(false)

  const rawTrackingRef = useRef<Point2D[][]>([])

  // Frame-by-frame navigation + on-demand keyframes
  const [currentFrame, setCurrentFrame] = useState(0)
  const [editedFrames, setEditedFrames] = useState<Map<number, Point2D[]>>(() => {
    const map = new Map<number, Point2D[]>()
    for (const kf of mesh?.contourOriginKeyframes ?? []) {
      map.set(kf.frameIndex, kf.anchorPositions)
    }
    return map
  })
  const totalFramesRef = useRef(0)

  const editedFrameSet = useMemo(() => new Set(editedFrames.keys()), [editedFrames])

  const [imageDims, setImageDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Snap function for KeyframeEditor
  const cannyIndexRef = useRef<ContourSpatialIndex | null>(null)

  const handleSnapPoint = useCallback((p: Point2D): Point2D => {
    if (!cannyIndexRef.current) return p
    const result = cannyIndexRef.current.nearest(p, 30)
    return result ? result.point : p
  }, [])

  useState(() => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.onload = () => {
      setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.src = url
  })

  const originAsArray = useMemo(
    () => contourOrigin ? [contourOrigin] : [],
    [contourOrigin]
  )

  // ===== Get positions for any frame =====
  const getFramePositions = useCallback((frame: number): Point2D[] => {
    if (editedFrames.has(frame)) return editedFrames.get(frame)!
    if (rawTrackingRef.current[frame]) return rawTrackingRef.current[frame]
    return originAsArray
  }, [editedFrames, originAsArray])

  // ===== Find neighboring edited frames =====
  const findNeighborEdited = useCallback((frame: number): { prev: number | null; next: number | null } => {
    const sorted = Array.from(editedFrames.keys()).sort((a, b) => a - b)
    let prev: number | null = null
    let next: number | null = null
    for (const f of sorted) {
      if (f < frame) prev = f
      if (f > frame && next === null) { next = f; break }
    }
    return { prev, next }
  }, [editedFrames])

  // ===== Handle position update =====
  const handleUpdatePositions = useCallback((positions: Point2D[]) => {
    setEditedFrames(prev => {
      const next = new Map(prev)
      next.set(currentFrame, positions)
      return next
    })
    if (rawTrackingRef.current[currentFrame]) {
      rawTrackingRef.current[currentFrame] = positions
    }
  }, [currentFrame])

  // ===== Track segment helper =====
  const trackAndUpdateSegment = useCallback(async (fromFrame: number, toFrame: number) => {
    if (!project.videoBlob || imageDims.w === 0) return
    const startPositions = getFramePositions(fromFrame)

    const constraints: TrackingConstraintParams = {
      anchorTriangles: [],
      enableAntiSaut: true,
      enableSnapToContour: true,
      cannyParams: cannyParams ?? undefined,
    }

    const segResults = await trackSegment(
      project.videoBlob,
      startPositions,
      imageDims.w,
      imageDims.h,
      fromFrame,
      toFrame,
      undefined,
      constraints
    )

    for (const seg of segResults) {
      rawTrackingRef.current[seg.frameIndex] = seg.points
    }

    if (segResults.length > 0) {
      const lastSeg = segResults[segResults.length - 1]
      if (editedFrames.has(toFrame)) {
        setEditedFrames(prev => {
          const next = new Map(prev)
          next.set(toFrame, lastSeg.points)
          return next
        })
      }
    }
  }, [project.videoBlob, imageDims, cannyParams, getFramePositions, editedFrames])

  // ===== Propagation handlers =====
  const handlePropagateForward = useCallback(async (scope: 'segment' | 'all') => {
    if (!project.videoBlob || imageDims.w === 0) return
    setPropagating(true)
    try {
      const lastFrame = totalFramesRef.current - 1
      if (scope === 'segment') {
        const { next } = findNeighborEdited(currentFrame)
        await trackAndUpdateSegment(currentFrame, next ?? lastFrame)
      } else {
        const sorted = Array.from(editedFrames.keys()).filter(f => f >= currentFrame).sort((a, b) => a - b)
        if (sorted[sorted.length - 1] !== lastFrame) sorted.push(lastFrame)
        for (let i = 0; i < sorted.length - 1; i++) {
          await trackAndUpdateSegment(sorted[i], sorted[i + 1])
        }
      }
    } catch (err) {
      console.error('Forward propagation failed:', err)
    }
    setPropagating(false)
  }, [currentFrame, editedFrames, findNeighborEdited, trackAndUpdateSegment, project.videoBlob, imageDims])

  const handlePropagateBackward = useCallback(async (scope: 'segment' | 'all') => {
    if (!project.videoBlob || imageDims.w === 0) return
    setPropagating(true)
    try {
      if (scope === 'segment') {
        const { prev } = findNeighborEdited(currentFrame)
        await trackAndUpdateSegment(currentFrame, prev ?? 0)
      } else {
        const sorted = Array.from(editedFrames.keys()).filter(f => f <= currentFrame).sort((a, b) => b - a)
        if (sorted[sorted.length - 1] !== 0) sorted.push(0)
        for (let i = 0; i < sorted.length - 1; i++) {
          await trackAndUpdateSegment(sorted[i], sorted[i + 1])
        }
      }
    } catch (err) {
      console.error('Backward propagation failed:', err)
    }
    setPropagating(false)
  }, [currentFrame, editedFrames, findNeighborEdited, trackAndUpdateSegment, project.videoBlob, imageDims])

  const handlePropagateBidi = useCallback(async (scope: 'segment' | 'all') => {
    if (!project.videoBlob || imageDims.w === 0) return
    setPropagating(true)
    try {
      const lastFrame = totalFramesRef.current - 1
      if (scope === 'segment') {
        const { prev, next } = findNeighborEdited(currentFrame)
        if (next !== null || currentFrame < lastFrame) {
          await trackAndUpdateSegment(currentFrame, next ?? lastFrame)
        }
        if (prev !== null || currentFrame > 0) {
          await trackAndUpdateSegment(currentFrame, prev ?? 0)
        }
      } else {
        const fwd = Array.from(editedFrames.keys()).filter(f => f >= currentFrame).sort((a, b) => a - b)
        if (fwd[fwd.length - 1] !== lastFrame) fwd.push(lastFrame)
        for (let i = 0; i < fwd.length - 1; i++) {
          await trackAndUpdateSegment(fwd[i], fwd[i + 1])
        }
        const bwd = Array.from(editedFrames.keys()).filter(f => f <= currentFrame).sort((a, b) => b - a)
        if (bwd[bwd.length - 1] !== 0) bwd.push(0)
        for (let i = 0; i < bwd.length - 1; i++) {
          await trackAndUpdateSegment(bwd[i], bwd[i + 1])
        }
      }
    } catch (err) {
      console.error('Bidi propagation failed:', err)
    }
    setPropagating(false)
  }, [currentFrame, editedFrames, findNeighborEdited, trackAndUpdateSegment, project.videoBlob, imageDims])

  // ===== Build KeyframeData[] from editedFrames =====
  const buildKeyframesFromEdited = useCallback((): KeyframeData[] => {
    const frames = new Map(editedFrames)
    if (!frames.has(0)) {
      frames.set(0, rawTrackingRef.current[0] ?? originAsArray)
    }
    const lastFrame = totalFramesRef.current - 1
    if (lastFrame > 0 && !frames.has(lastFrame)) {
      frames.set(lastFrame, rawTrackingRef.current[lastFrame] ?? originAsArray)
    }
    return Array.from(frames.entries())
      .sort(([a], [b]) => a - b)
      .map(([frameIndex, anchorPositions]) => ({ frameIndex, anchorPositions }))
  }, [editedFrames, originAsArray])

  // ===== Launch tracking =====
  async function handleLaunchTracking() {
    if (!project.videoBlob || !mesh || !contourOrigin) return
    if (imageDims.w === 0) {
      alert('Dimensions image non chargées, réessayez.')
      return
    }

    setPhase('tracking')
    setProgress('Démarrage...')

    try {
      // Build Canny index for snap during editing
      if (cannyParams && project.originalImageBlob) {
        await loadOpenCVWorker()
        const img = new Image()
        const url = URL.createObjectURL(project.originalImageBlob)
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('Image load failed'))
          img.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const contourPts = await flowCannyContour(
          imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize
        )
        if (contourPts && contourPts.length > 0) {
          cannyIndexRef.current = new ContourSpatialIndex(contourPts, 8)
        }
        URL.revokeObjectURL(url)
      }

      const constraints: TrackingConstraintParams = {
        anchorTriangles: [],
        enableAntiSaut: true,
        enableSnapToContour: true,
        cannyParams: cannyParams ?? undefined,
      }

      const result = await precomputeOpticalFlow(
        null,
        project.videoBlob,
        [contourOrigin],
        imageDims.w,
        imageDims.h,
        (stage, current, total) => {
          setProgress(`${stage} : ${current}/${total}`)
        },
        constraints
      )

      rawTrackingRef.current = result.videoFramesMesh
      totalFramesRef.current = result.videoFramesMesh.length

      const initialEdited = new Map<number, Point2D[]>()
      initialEdited.set(0, result.videoFramesMesh[0])
      initialEdited.set(result.videoFramesMesh.length - 1, result.videoFramesMesh[result.videoFramesMesh.length - 1])
      setEditedFrames(initialEdited)
      setCurrentFrame(0)
      setPhase('editing')
      setProgress('')
    } catch (err) {
      console.error('Origin tracking failed:', err)
      alert('Erreur tracking : ' + (err instanceof Error ? err.message : err))
      setPhase('config')
      setProgress('')
    }
  }

  // ===== Save & validate =====
  async function handleSaveAndValidate() {
    if (!mesh) return
    setSaving(true)
    try {
      const totalFrames = totalFramesRef.current
      const keyframes = buildKeyframesFromEdited()
      const contourOriginFrames = propagateKeyframes(keyframes, totalFrames)

      // Snap intermediate frames to Canny contour
      if (cannyParams && project.videoBlob) {
        try {
          await loadOpenCVWorker()
          const video = document.createElement('video')
          video.muted = true
          video.preload = 'auto'
          const url = URL.createObjectURL(project.videoBlob)
          video.src = url
          await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve()
            video.onerror = () => reject(new Error('Video load failed'))
          })

          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const ctx = canvas.getContext('2d')!

          const keyframeSet = new Set(keyframes.map(k => k.frameIndex))

          for (let f = 0; f < totalFrames; f++) {
            if (keyframeSet.has(f)) continue
            if (f % 5 !== 0 && f !== totalFrames - 1) continue // Sample every 5 frames for perf

            video.currentTime = f / 24
            await new Promise<void>(resolve => { video.onseeked = () => resolve() })
            ctx.drawImage(video, 0, 0)
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
            const contourPts = await flowCannyContour(
              imageData, cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize
            )
            if (contourPts && contourPts.length > 0) {
              const idx = new ContourSpatialIndex(contourPts, 8)
              const snapped = contourOriginFrames[f].map(p => {
                const nearest = idx.nearest(p, 30)
                return nearest ? nearest.point : p
              })
              contourOriginFrames[f] = snapped
            }
          }
          URL.revokeObjectURL(url)
        } catch (err) {
          console.warn('Snap-to-contour during validation failed:', err)
        }
      }

      // If shared geometry exists (from rest animation), only reset tracking data.
      // If no geometry yet (rest animation first setup), reset everything downstream.
      const hasSharedGeometry = mesh.contourAnchors.length > 0
      const updatedMesh: MeshData = hasSharedGeometry ? {
        ...mesh,
        contourOriginKeyframeInterval: 0,
        contourOriginKeyframes: keyframes,
        contourOriginFrames,
        contourOriginTrackingValidated: true,
        // Reset only tracking data, keep shared geometry intact
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
        anchorKeyframes: [],
        anchorFrames: null,
        anchorTrackingValidated: false,
        videoFramesMesh: null,
      } : {
        ...mesh,
        contourOriginKeyframeInterval: 0,
        contourOriginKeyframes: keyframes,
        contourOriginFrames,
        contourOriginTrackingValidated: true,
        // No geometry yet — reset everything downstream
        contourAnchors: [],
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionPoints: [],
        contourSubdivisionParams: [],
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
        anchorPoints: [],
        anchorKeyframes: [],
        anchorFrames: null,
        anchorTrackingValidated: false,
        internalPoints: [],
        triangles: [],
        topologyLocked: false,
        trackedTriangles: [],
        internalBarycentrics: [],
        videoFramesMesh: null,
      }

      await onSave(
        { ...project, mesh: updatedMesh },
        ['contourOriginKeyframes', 'contourOriginFrames']
      )
      setPhase('validated')
    } catch (err) {
      console.error('Save failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  function handleReset() {
    if (!confirm('Réinitialiser le tracking du Point 0 ? Les corrections seront perdues.')) return
    setEditedFrames(new Map())
    rawTrackingRef.current = []
    setCurrentFrame(0)
    setPhase('config')
  }

  // ===== Prerequisites =====
  if (!cannyParams) {
    return <div className="placeholder">Validez d'abord les paramètres Canny (étape 2).</div>
  }
  if (!contourOrigin) {
    return <div className="placeholder">Définissez d'abord le Point 0 du contour (étape 3).</div>
  }
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  }

  // ===== Render =====

  if (phase === 'validated') {
    return (
      <div className="tracking-step">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px' }}>
          <span style={{ color: 'var(--color-success)', fontWeight: 'bold', fontSize: '1.1rem' }}>
            Tracking Point 0 validé
          </span>
          <span style={{ color: 'var(--color-muted)' }}>
            1 point tracké sur {mesh.contourOriginFrames?.length ?? '?'} frames
          </span>
          <button className="btn-danger" onClick={handleReset}>
            Recommencer
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'config') {
    return (
      <div className="tracking-step">
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3 style={{ margin: 0 }}>Tracking du Point 0 (origine curviligne)</h3>
          <p style={{ color: 'var(--color-muted)', margin: 0 }}>
            Le Point 0 sera tracké par optical flow avec snap automatique sur le contour Canny.
          </p>

          <button
            onClick={handleLaunchTracking}
            style={{ background: 'var(--color-primary)', color: 'white', padding: '8px 24px', alignSelf: 'flex-start' }}
          >
            Lancer le tracking
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'tracking') {
    return (
      <div className="tracking-step">
        <div style={{ padding: '16px', textAlign: 'center' }}>
          <h3>Tracking Point 0 en cours...</h3>
          <p style={{ fontFamily: 'monospace' }}>{progress}</p>
          <div style={{ width: '100%', maxWidth: 400, margin: '0 auto', height: 4, background: 'var(--color-surface-3)', borderRadius: 2 }}>
            <div style={{ width: '50%', height: '100%', background: '#ec4899', borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
        </div>
      </div>
    )
  }

  // Editing phase
  const currentPositions = getFramePositions(currentFrame)

  return (
    <div className="tracking-step" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <span style={{ fontWeight: 'bold', color: '#ec4899' }}>
          Point 0 — Édition frame par frame
        </span>
        <button
          onClick={handleSaveAndValidate}
          disabled={saving}
          style={{ background: 'var(--color-success)', color: 'white' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider le tracking Point 0'}
        </button>
        <button className="btn-danger" onClick={handleReset}>
          Recommencer
        </button>
      </div>

      <FrameNavigator
        currentFrame={currentFrame}
        totalFrames={totalFramesRef.current}
        editedFrames={editedFrameSet}
        onNavigate={setCurrentFrame}
      />

      <KeyframeEditor
        videoBlob={project.videoBlob!}
        imageWidth={imageDims.w}
        imageHeight={imageDims.h}
        frameIndex={currentFrame}
        anchorPositions={currentPositions}
        referencePositions={getFramePositions(0)}
        totalFrames={totalFramesRef.current}
        onUpdatePositions={handleUpdatePositions}
        onPropagateForward={handlePropagateForward}
        onPropagateBackward={handlePropagateBackward}
        onPropagateBidi={handlePropagateBidi}
        propagating={propagating}
        isEdited={editedFrames.has(currentFrame)}
        isFirstFrame={currentFrame === 0}
        isLastFrame={currentFrame === totalFramesRef.current - 1}
        onSnapPoint={handleSnapPoint}
      />
    </div>
  )
}
