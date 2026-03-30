import { useState, useRef, useCallback, useMemo } from 'react'
import type { ProjectStepView, Point2D, MeshData, KeyframeData } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import type { TrackingConstraintParams } from '../../utils/opticalFlowComputer'
import { precomputeOpticalFlow, trackSegment } from '../../utils/opticalFlowComputer'
import { propagateKeyframes } from '../../utils/keyframePropagation'
import KeyframeEditor from '../keyframes/KeyframeEditor'
import FrameNavigator from '../keyframes/FrameNavigator'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

type Phase = 'config' | 'tracking' | 'editing' | 'validated'

export default function AnchorTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const anchorPoints = mesh?.anchorPoints ?? []

  const initialPhase: Phase = mesh?.anchorTrackingValidated
    ? 'validated'
    : (mesh?.anchorKeyframes?.length ?? 0) > 0
      ? 'editing'
      : 'config'

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [progress, setProgress] = useState('')
  const [saving, setSaving] = useState(false)
  const [propagating, setPropagating] = useState(false)

  // Constraints hardcoded
  const enableAntiSaut = true
  const enableNeighbor = true
  const enableTemporal = false
  const enableOutlier = false

  const rawTrackingRef = useRef<Point2D[][]>([])

  // ===== Frame-by-frame navigation + on-demand keyframes =====
  const [currentFrame, setCurrentFrame] = useState(0)
  const [editedFrames, setEditedFrames] = useState<Map<number, Point2D[]>>(() => {
    const map = new Map<number, Point2D[]>()
    for (const kf of mesh?.anchorKeyframes ?? []) {
      map.set(kf.frameIndex, kf.anchorPositions)
    }
    return map
  })
  const totalFramesRef = useRef(0)

  const editedFrameSet = useMemo(() => new Set(editedFrames.keys()), [editedFrames])

  const [imageDims, setImageDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

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

  const buildConstraints = useCallback((): TrackingConstraintParams | undefined => {
    if (!enableAntiSaut && !enableNeighbor && !enableTemporal && !enableOutlier) {
      return undefined
    }

    const anchorTriangles: [number, number, number][] = []
    for (let i = 0; i < anchorPoints.length - 2; i++) {
      anchorTriangles.push([i, i + 1, i + 2])
    }

    return {
      anchorTriangles,
      enableAntiSaut,
      enableTemporalSmoothing: enableTemporal,
      enableOutlierDetection: enableOutlier,
    }
  }, [enableAntiSaut, enableNeighbor, enableTemporal, enableOutlier, anchorPoints])

  // ===== Get positions for any frame =====
  const getFramePositions = useCallback((frame: number): Point2D[] => {
    if (editedFrames.has(frame)) return editedFrames.get(frame)!
    if (rawTrackingRef.current[frame]) return rawTrackingRef.current[frame]
    return anchorPoints
  }, [editedFrames, anchorPoints])

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

  // ===== Handle position update (user drag) — marks frame as edited =====
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
    const constraints = buildConstraints()
    const startPositions = getFramePositions(fromFrame)

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
  }, [project.videoBlob, imageDims, buildConstraints, getFramePositions, editedFrames])

  // ===== Forward propagation =====
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

  // ===== Backward propagation =====
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

  // ===== Bidirectional propagation =====
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

  // ===== Build KeyframeData[] from editedFrames for save =====
  const buildKeyframesFromEdited = useCallback((): KeyframeData[] => {
    const frames = new Map(editedFrames)
    if (!frames.has(0)) {
      frames.set(0, rawTrackingRef.current[0] ?? anchorPoints)
    }
    const lastFrame = totalFramesRef.current - 1
    if (lastFrame > 0 && !frames.has(lastFrame)) {
      frames.set(lastFrame, rawTrackingRef.current[lastFrame] ?? anchorPoints)
    }
    return Array.from(frames.entries())
      .sort(([a], [b]) => a - b)
      .map(([frameIndex, anchorPositions]) => ({ frameIndex, anchorPositions }))
  }, [editedFrames, anchorPoints])

  async function handleLaunchTracking() {
    if (!project.videoBlob || !mesh || anchorPoints.length === 0) return
    if (imageDims.w === 0) {
      alert('Dimensions image non chargées, réessayez.')
      return
    }

    setPhase('tracking')
    setProgress('Démarrage...')

    try {
      const constraints = buildConstraints()
      const result = await precomputeOpticalFlow(
        null,
        project.videoBlob,
        anchorPoints,
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
      console.error('Anchor tracking failed:', err)
      alert('Erreur tracking : ' + (err instanceof Error ? err.message : err))
      setPhase('config')
      setProgress('')
    }
  }

  async function handleSaveAndValidate() {
    if (!mesh) return
    setSaving(true)
    try {
      const totalFrames = totalFramesRef.current
      const keyframes = buildKeyframesFromEdited()
      const anchorFrames = propagateKeyframes(keyframes, totalFrames)

      const updatedMesh: MeshData = {
        ...mesh,
        anchorKeyframeInterval: 0,
        anchorKeyframes: keyframes,
        anchorFrames,
        anchorTrackingValidated: true,
      }

      await onSave(
        { ...project, mesh: updatedMesh },
        ['anchorKeyframes', 'anchorFrames']
      )
      setPhase('validated')
    } catch (err) {
      console.error('Save failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  function handleReset() {
    if (!confirm('Réinitialiser le tracking des ancres ? Les corrections seront perdues.')) return
    setEditedFrames(new Map())
    rawTrackingRef.current = []
    setCurrentFrame(0)
    setPhase('config')
  }

  // Prerequisites
  if (!mesh?.contourAnchorTrackingValidated) {
    return <div className="placeholder">Validez d'abord le tracking contour (étape 5).</div>
  }
  if (!mesh?.anchorPoints?.length) {
    return <div className="placeholder">Définissez d'abord les ancres internes (étape 6).</div>
  }
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d'abord une vidéo.</div>
  }

  if (phase === 'validated') {
    return (
      <div className="tracking-step">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px' }}>
          <span style={{ color: '#22c55e', fontWeight: 'bold', fontSize: '1.1rem' }}>
            Tracking ancres validé
          </span>
          <span style={{ color: '#888' }}>
            {anchorPoints.length} ancres trackées sur {mesh.anchorFrames?.length ?? '?'} frames
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
          <h3 style={{ margin: 0 }}>Tracking des ancres internes</h3>
          <p style={{ color: '#888', margin: 0 }}>
            {anchorPoints.length} points d'ancrage à tracker.
          </p>

          <button
            onClick={handleLaunchTracking}
            style={{ background: '#2563eb', color: 'white', padding: '8px 24px', alignSelf: 'flex-start' }}
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
          <h3>Tracking en cours...</h3>
          <p style={{ fontFamily: 'monospace' }}>{progress}</p>
          <div style={{ width: '100%', maxWidth: 400, margin: '0 auto', height: 4, background: '#333', borderRadius: 2 }}>
            <div style={{ width: '50%', height: '100%', background: '#2563eb', borderRadius: 2, transition: 'width 0.3s' }} />
          </div>
        </div>
      </div>
    )
  }

  // Editing phase (frame-by-frame)
  const currentPositions = getFramePositions(currentFrame)

  return (
    <div className="tracking-step" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <span style={{ fontWeight: 'bold' }}>
          Édition frame par frame
        </span>
        <button
          onClick={handleSaveAndValidate}
          disabled={saving}
          style={{ background: '#22c55e', color: 'white' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider le tracking ancres'}
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
      />
    </div>
  )
}
