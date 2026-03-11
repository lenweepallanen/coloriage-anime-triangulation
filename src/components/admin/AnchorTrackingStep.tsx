import { useState, useRef, useCallback } from 'react'
import type { Project, Point2D, MeshData, KeyframeData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import type { TrackingConstraintParams } from '../../utils/opticalFlowComputer'
import { precomputeOpticalFlow, trackSegment } from '../../utils/opticalFlowComputer'
import { extractKeyframes, propagateKeyframes } from '../../utils/keyframePropagation'
import KeyframeEditor from '../keyframes/KeyframeEditor'
import KeyframeTimeline from '../keyframes/KeyframeTimeline'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

type Phase = 'config' | 'tracking' | 'keyframes' | 'validated'

export default function AnchorTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const anchorPoints = mesh?.anchorPoints ?? []

  const initialPhase: Phase = mesh?.anchorTrackingValidated
    ? 'validated'
    : (mesh?.anchorKeyframes?.length ?? 0) > 0
      ? 'keyframes'
      : 'config'

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [interval, setInterval_] = useState(mesh?.anchorKeyframeInterval ?? 10)
  const [progress, setProgress] = useState('')
  const [saving, setSaving] = useState(false)
  const [propagating, setPropagating] = useState(false)

  // Constraint toggles
  const [enableAntiSaut, setEnableAntiSaut] = useState(true)
  const [enableNeighbor, setEnableNeighbor] = useState(true)
  const [enableTemporal, setEnableTemporal] = useState(false)
  const [enableOutlier, setEnableOutlier] = useState(false)

  const rawTrackingRef = useRef<Point2D[][]>([])
  const [keyframes, setKeyframes] = useState<KeyframeData[]>(mesh?.anchorKeyframes ?? [])
  const [selectedKfIdx, setSelectedKfIdx] = useState<number | null>(null)
  const totalFramesRef = useRef(0)

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

    // Simple chain adjacency for anchor points
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

      const kfs = extractKeyframes(result.videoFramesMesh, interval)
      setKeyframes(kfs)
      setSelectedKfIdx(0)
      setPhase('keyframes')
      setProgress('')
    } catch (err) {
      console.error('Anchor tracking failed:', err)
      alert('Erreur tracking : ' + (err instanceof Error ? err.message : err))
      setPhase('config')
      setProgress('')
    }
  }

  const handlePropagateForwardOne = useCallback(async () => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const currentKf = keyframes[selectedKfIdx]
      const nextKf = keyframes[selectedKfIdx + 1]
      const constraints = buildConstraints()

      const segResults = await trackSegment(
        project.videoBlob, currentKf.anchorPositions,
        imageDims.w, imageDims.h,
        currentKf.frameIndex, nextKf.frameIndex,
        undefined, constraints
      )

      for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points

      if (segResults.length > 0) {
        const newKeyframes = [...keyframes]
        newKeyframes[selectedKfIdx + 1] = {
          ...nextKf, anchorPositions: segResults[segResults.length - 1].points,
        }
        setKeyframes(newKeyframes)
      }
      setSelectedKfIdx(selectedKfIdx + 1)
    } catch (err) {
      console.error('Propagation failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  const handlePropagateForwardAll = useCallback(async () => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      for (let i = selectedKfIdx; i < newKeyframes.length - 1; i++) {
        const segResults = await trackSegment(
          project.videoBlob, newKeyframes[i].anchorPositions,
          imageDims.w, imageDims.h,
          newKeyframes[i].frameIndex, newKeyframes[i + 1].frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[i + 1] = {
            ...newKeyframes[i + 1], anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }
      setKeyframes(newKeyframes)
      setSelectedKfIdx(newKeyframes.length - 1)
    } catch (err) {
      console.error('Propagation all failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  const handlePropagateBidiOne = useCallback(async () => {
    if (selectedKfIdx === null) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const currentKf = keyframes[selectedKfIdx]
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      if (selectedKfIdx < keyframes.length - 1) {
        const nextKf = keyframes[selectedKfIdx + 1]
        const segResults = await trackSegment(
          project.videoBlob, currentKf.anchorPositions,
          imageDims.w, imageDims.h,
          currentKf.frameIndex, nextKf.frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[selectedKfIdx + 1] = {
            ...nextKf, anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      if (selectedKfIdx > 0) {
        const prevKf = keyframes[selectedKfIdx - 1]
        const segResults = await trackSegment(
          project.videoBlob, currentKf.anchorPositions,
          imageDims.w, imageDims.h,
          currentKf.frameIndex, prevKf.frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[selectedKfIdx - 1] = {
            ...prevKf, anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      setKeyframes(newKeyframes)
    } catch (err) {
      console.error('Bidi propagation failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  const handlePropagateBidiAll = useCallback(async () => {
    if (selectedKfIdx === null) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      for (let i = selectedKfIdx; i < newKeyframes.length - 1; i++) {
        const segResults = await trackSegment(
          project.videoBlob, newKeyframes[i].anchorPositions,
          imageDims.w, imageDims.h,
          newKeyframes[i].frameIndex, newKeyframes[i + 1].frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[i + 1] = {
            ...newKeyframes[i + 1], anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      for (let i = selectedKfIdx; i > 0; i--) {
        const segResults = await trackSegment(
          project.videoBlob, newKeyframes[i].anchorPositions,
          imageDims.w, imageDims.h,
          newKeyframes[i].frameIndex, newKeyframes[i - 1].frameIndex,
          undefined, constraints
        )
        for (const seg of segResults) rawTrackingRef.current[seg.frameIndex] = seg.points
        if (segResults.length > 0) {
          newKeyframes[i - 1] = {
            ...newKeyframes[i - 1], anchorPositions: segResults[segResults.length - 1].points,
          }
        }
      }

      setKeyframes(newKeyframes)
    } catch (err) {
      console.error('Bidi all failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  const handleUpdatePositions = useCallback((positions: Point2D[]) => {
    if (selectedKfIdx === null) return
    const newKeyframes = [...keyframes]
    newKeyframes[selectedKfIdx] = {
      ...newKeyframes[selectedKfIdx],
      anchorPositions: positions,
    }
    setKeyframes(newKeyframes)
  }, [selectedKfIdx, keyframes])

  const handleValidateOnly = useCallback(() => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    setSelectedKfIdx(selectedKfIdx + 1)
  }, [selectedKfIdx, keyframes])

  async function handleSaveAndValidate() {
    if (!mesh || keyframes.length === 0) return
    setSaving(true)
    try {
      const totalFrames = totalFramesRef.current
      const anchorFrames = propagateKeyframes(keyframes, totalFrames)

      const updatedMesh: MeshData = {
        ...mesh,
        anchorKeyframeInterval: interval,
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
    if (!confirm('Réinitialiser le tracking des ancres ? Les keyframes seront perdues.')) return
    setKeyframes([])
    rawTrackingRef.current = []
    setSelectedKfIdx(null)
    setPhase('config')
  }

  // Prerequisites
  if (!mesh?.contourTrackingValidated) {
    return <div className="placeholder">Validez d&apos;abord le tracking contour (étape 4).</div>
  }
  if (!mesh?.anchorPoints?.length) {
    return <div className="placeholder">Définissez d&apos;abord les points d&apos;ancrage (étape 5).</div>
  }
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d&apos;abord une vidéo.</div>
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
          <h3 style={{ margin: 0 }}>Configuration du tracking des ancres</h3>
          <p style={{ color: '#888', margin: 0 }}>
            {anchorPoints.length} points d&apos;ancrage à tracker.
          </p>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label>Intervalle keyframes :</label>
            <button onClick={() => setInterval_(Math.max(1, interval - 5))} disabled={interval <= 1}>−</button>
            <span style={{ minWidth: 30, textAlign: 'center' }}>{interval}</span>
            <button onClick={() => setInterval_(interval + 5)}>+</button>
            <span style={{ color: '#888', fontSize: '0.85rem' }}>frames</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong>Contraintes :</strong>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableAntiSaut} onChange={e => setEnableAntiSaut(e.target.checked)} />
              Anti-saut (clamp déplacement max)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableNeighbor} onChange={e => setEnableNeighbor(e.target.checked)} />
              Contrainte voisinage (consensus médiane)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableTemporal} onChange={e => setEnableTemporal(e.target.checked)} />
              Lissage temporel (post-traitement)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableOutlier} onChange={e => setEnableOutlier(e.target.checked)} />
              Détection outliers (post-traitement)
            </label>
          </div>

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

  // Keyframes phase
  const selectedKf = selectedKfIdx !== null ? keyframes[selectedKfIdx] : null

  return (
    <div className="tracking-step" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <span style={{ fontWeight: 'bold' }}>
          Keyframes ancres ({keyframes.length})
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

      <KeyframeTimeline
        keyframes={keyframes}
        totalFrames={totalFramesRef.current}
        selectedIndex={selectedKfIdx}
        onSelect={setSelectedKfIdx}
      />

      {selectedKf && (
        <KeyframeEditor
          videoBlob={project.videoBlob!}
          imageWidth={imageDims.w}
          imageHeight={imageDims.h}
          frameIndex={selectedKf.frameIndex}
          anchorPositions={selectedKf.anchorPositions}
          referencePositions={keyframes[0]?.anchorPositions}
          totalFrames={totalFramesRef.current}
          onUpdatePositions={handleUpdatePositions}
          onPropagateForwardOne={handlePropagateForwardOne}
          onPropagateForwardAll={handlePropagateForwardAll}
          onPropagateBidiOne={handlePropagateBidiOne}
          onPropagateBidiAll={handlePropagateBidiAll}
          onValidateOnly={handleValidateOnly}
          propagating={propagating}
          isFirstKeyframe={selectedKfIdx === 0}
          isLastKeyframe={selectedKfIdx === keyframes.length - 1}
        />
      )}
    </div>
  )
}
