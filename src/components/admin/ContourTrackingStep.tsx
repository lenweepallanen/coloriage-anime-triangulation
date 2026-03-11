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

export default function ContourTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const contourVertices = mesh?.contourVertices ?? []

  const initialPhase: Phase = mesh?.contourTrackingValidated
    ? 'validated'
    : (mesh?.contourKeyframes?.length ?? 0) > 0
      ? 'keyframes'
      : 'config'

  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [interval, setInterval_] = useState(mesh?.contourKeyframeInterval ?? 10)
  const [progress, setProgress] = useState('')
  const [saving, setSaving] = useState(false)
  const [propagating, setPropagating] = useState(false)

  // Constraint toggles
  const [enableAntiSaut, setEnableAntiSaut] = useState(true)
  const [enableNeighbor, setEnableNeighbor] = useState(true)
  const [enableTemporal, setEnableTemporal] = useState(false)
  const [enableContour, setEnableContour] = useState(false)
  const [enableOutlier, setEnableOutlier] = useState(false)
  const [enableSnap, setEnableSnap] = useState(true)

  // Raw tracking data (per-frame positions for all contour vertices)
  const rawTrackingRef = useRef<Point2D[][]>([])

  // Keyframes state
  const [keyframes, setKeyframes] = useState<KeyframeData[]>(mesh?.contourKeyframes ?? [])
  const [selectedKfIdx, setSelectedKfIdx] = useState<number | null>(null)
  const totalFramesRef = useRef(0)

  const [imageDims, setImageDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Load image dimensions on mount
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

  // Build constraints for tracking
  const buildConstraints = useCallback((): TrackingConstraintParams | undefined => {
    if (!enableAntiSaut && !enableNeighbor && !enableTemporal && !enableContour && !enableOutlier && !enableSnap) {
      return undefined
    }

    // Build a simple chain adjacency for contour points
    const contourOrder = contourVertices.map((_, i) => i)
    const anchorTriangles: [number, number, number][] = []
    for (let i = 0; i < contourVertices.length - 1; i++) {
      const next = (i + 2) % contourVertices.length
      anchorTriangles.push([i, i + 1, next])
    }

    return {
      anchorTriangles,
      contourAnchorOrder: contourOrder,
      enableAntiSaut,
      enableTemporalSmoothing: enableTemporal,
      enableContourConstraints: enableContour,
      enableOutlierDetection: enableOutlier,
      enableSnapToContour: enableSnap,
      cannyParams: enableSnap ? (mesh?.cannyParams ?? undefined) : undefined,
    }
  }, [enableAntiSaut, enableNeighbor, enableTemporal, enableContour, enableOutlier, enableSnap, contourVertices, mesh?.cannyParams])

  // Launch tracking
  async function handleLaunchTracking() {
    if (!project.videoBlob || !mesh || contourVertices.length === 0) return
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
        contourVertices,
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
      console.error('Contour tracking failed:', err)
      alert('Erreur tracking : ' + (err instanceof Error ? err.message : err))
      setPhase('config')
      setProgress('')
    }
  }

  // Propagate forward one step from current keyframe
  const handlePropagateForwardOne = useCallback(async () => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const currentKf = keyframes[selectedKfIdx]
      const nextKf = keyframes[selectedKfIdx + 1]
      const constraints = buildConstraints()

      const segResults = await trackSegment(
        project.videoBlob,
        currentKf.anchorPositions,
        imageDims.w,
        imageDims.h,
        currentKf.frameIndex,
        nextKf.frameIndex,
        undefined,
        constraints
      )

      for (const seg of segResults) {
        rawTrackingRef.current[seg.frameIndex] = seg.points
      }

      if (segResults.length > 0) {
        const lastSeg = segResults[segResults.length - 1]
        const newKeyframes = [...keyframes]
        newKeyframes[selectedKfIdx + 1] = {
          ...nextKf,
          anchorPositions: lastSeg.points,
        }
        setKeyframes(newKeyframes)
      }

      setSelectedKfIdx(selectedKfIdx + 1)
    } catch (err) {
      console.error('Propagation failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  // Propagate forward all from current keyframe
  const handlePropagateForwardAll = useCallback(async () => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const newKeyframes = [...keyframes]
      let currentIdx = selectedKfIdx
      const constraints = buildConstraints()

      while (currentIdx < newKeyframes.length - 1) {
        const currentKf = newKeyframes[currentIdx]
        const nextKf = newKeyframes[currentIdx + 1]

        const segResults = await trackSegment(
          project.videoBlob,
          currentKf.anchorPositions,
          imageDims.w,
          imageDims.h,
          currentKf.frameIndex,
          nextKf.frameIndex,
          undefined,
          constraints
        )

        for (const seg of segResults) {
          rawTrackingRef.current[seg.frameIndex] = seg.points
        }

        if (segResults.length > 0) {
          const lastSeg = segResults[segResults.length - 1]
          newKeyframes[currentIdx + 1] = {
            ...nextKf,
            anchorPositions: lastSeg.points,
          }
        }

        currentIdx++
      }

      setKeyframes(newKeyframes)
      setSelectedKfIdx(newKeyframes.length - 1)
    } catch (err) {
      console.error('Propagation all failed:', err)
    }
    setPropagating(false)
  }, [selectedKfIdx, keyframes, project.videoBlob, imageDims, buildConstraints])

  // Bidi propagate one step
  const handlePropagateBidiOne = useCallback(async () => {
    if (selectedKfIdx === null) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const currentKf = keyframes[selectedKfIdx]
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      // Forward
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

      // Backward
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

  // Bidi propagate all
  const handlePropagateBidiAll = useCallback(async () => {
    if (selectedKfIdx === null) return
    if (!project.videoBlob || imageDims.w === 0) return

    setPropagating(true)
    try {
      const newKeyframes = [...keyframes]
      const constraints = buildConstraints()

      // Forward from current to end
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

      // Backward from current to start
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

  // Update keyframe positions (from editor drag)
  const handleUpdatePositions = useCallback((positions: Point2D[]) => {
    if (selectedKfIdx === null) return
    const newKeyframes = [...keyframes]
    newKeyframes[selectedKfIdx] = {
      ...newKeyframes[selectedKfIdx],
      anchorPositions: positions,
    }
    setKeyframes(newKeyframes)
  }, [selectedKfIdx, keyframes])

  // Skip keyframe without propagation
  const handleValidateOnly = useCallback(() => {
    if (selectedKfIdx === null || selectedKfIdx >= keyframes.length - 1) return
    setSelectedKfIdx(selectedKfIdx + 1)
  }, [selectedKfIdx, keyframes])

  // Save & validate tracking
  async function handleSaveAndValidate() {
    if (!mesh || keyframes.length === 0) return
    setSaving(true)
    try {
      const totalFrames = totalFramesRef.current
      const contourFrames = propagateKeyframes(keyframes, totalFrames)

      const updatedMesh: MeshData = {
        ...mesh,
        contourKeyframeInterval: interval,
        contourKeyframes: keyframes,
        contourFrames,
        contourTrackingValidated: true,
      }

      await onSave(
        { ...project, mesh: updatedMesh },
        ['contourKeyframes', 'contourFrames']
      )
      setPhase('validated')
    } catch (err) {
      console.error('Save failed:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  // Reset tracking
  function handleReset() {
    if (!confirm('Réinitialiser le tracking contour ? Les keyframes seront perdues.')) return
    setKeyframes([])
    rawTrackingRef.current = []
    setSelectedKfIdx(null)
    setPhase('config')
  }

  // Prerequisite checks
  if (!mesh?.contourVertices?.length) {
    return <div className="placeholder">Définissez d&apos;abord le contour (étape 2).</div>
  }
  if (!mesh?.cannyParams) {
    return <div className="placeholder">Validez d&apos;abord les paramètres Canny (étape 3).</div>
  }
  if (!project.videoBlob) {
    return <div className="placeholder">Importez d&apos;abord une vidéo.</div>
  }

  // Validated phase
  if (phase === 'validated') {
    return (
      <div className="tracking-step">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px' }}>
          <span style={{ color: '#22c55e', fontWeight: 'bold', fontSize: '1.1rem' }}>
            Tracking contour validé
          </span>
          <span style={{ color: '#888' }}>
            {contourVertices.length} sommets trackés sur {mesh.contourFrames?.length ?? '?'} frames
          </span>
          <button className="btn-danger" onClick={handleReset}>
            Recommencer
          </button>
        </div>
      </div>
    )
  }

  // Config phase
  if (phase === 'config') {
    return (
      <div className="tracking-step">
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h3 style={{ margin: 0 }}>Configuration du tracking contour</h3>
          <p style={{ color: '#888', margin: 0 }}>
            {contourVertices.length} sommets du contour à tracker.
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
              <input type="checkbox" checked={enableContour} onChange={e => setEnableContour(e.target.checked)} />
              Contraintes contour (stabilisation curviligne)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableTemporal} onChange={e => setEnableTemporal(e.target.checked)} />
              Lissage temporel (post-traitement)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={enableOutlier} onChange={e => setEnableOutlier(e.target.checked)} />
              Détection outliers (post-traitement)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: enableSnap ? 'bold' : 'normal' }}>
              <input type="checkbox" checked={enableSnap} onChange={e => setEnableSnap(e.target.checked)} />
              Snap-to-contour (Canny)
              {!mesh?.cannyParams && <span style={{ color: '#f59e0b', fontSize: '0.8rem' }}> — validez Canny d&apos;abord</span>}
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

  // Tracking phase (in progress)
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
          Keyframes contour ({keyframes.length})
        </span>
        <button
          onClick={handleSaveAndValidate}
          disabled={saving}
          style={{ background: '#22c55e', color: 'white' }}
        >
          {saving ? 'Sauvegarde...' : 'Valider le tracking contour'}
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
