import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, KeyframeData, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { loadOpenCVWorker } from '../../utils/perspectiveCorrection'
import { precomputeOpticalFlow, trackSegment } from '../../utils/opticalFlowComputer'
import { extractKeyframes, propagateKeyframes } from '../../utils/keyframePropagation'
import KeyframeTimeline from '../keyframes/KeyframeTimeline'
import KeyframeEditor from '../keyframes/KeyframeEditor'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')) }
    img.src = url
  })
}

export default function KeyframeValidationStep({ project, onSave }: Props) {
  const [computing, setComputing] = useState(false)
  const [propagating, setPropagating] = useState(false)
  const [progress, setProgress] = useState({ stage: '', current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [interval, setInterval_] = useState(project.mesh?.keyframeInterval ?? 10)
  const [keyframes, setKeyframes] = useState<KeyframeData[]>(project.mesh?.keyframes ?? [])
  const [selectedKfIndex, setSelectedKfIndex] = useState<number | null>(null)
  const [totalFrames, setTotalFrames] = useState(0)
  const [imgDims, setImgDims] = useState<{ width: number; height: number } | null>(null)
  const [saving, setSaving] = useState(false)

  // Ref to hold the full per-frame anchor tracking (before keyframe extraction)
  const rawTrackingRef = useRef<Point2D[][] | null>(null)

  const mesh = project.mesh
  const isLocked = mesh?.topologyLocked ?? false
  const hasVideo = !!project.videoBlob
  const hasKeyframes = keyframes.length > 0

  // Load image dims on mount
  useEffect(() => {
    if (!project.originalImageBlob) return
    getImageDimensions(project.originalImageBlob).then(setImgDims)
  }, [project.originalImageBlob])

  // Compute total frames from video
  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.onloadedmetadata = () => {
      const frames = Math.floor(video.duration * 24)
      setTotalFrames(frames)
      URL.revokeObjectURL(url)
    }
    video.onerror = () => URL.revokeObjectURL(url)
    video.load()
  }, [project.videoBlob])

  async function handleComputeTracking() {
    if (!mesh || !project.videoBlob || !project.originalImageBlob) return

    setComputing(true)
    setError(null)

    try {
      setProgress({ stage: 'Chargement OpenCV...', current: 0, total: 1 })
      await loadOpenCVWorker()

      const dims = imgDims ?? await getImageDimensions(project.originalImageBlob)
      setImgDims(dims)

      // Track ONLY anchor points (not internal points)
      const { videoFramesMesh: anchorTracking } = await precomputeOpticalFlow(
        null,
        project.videoBlob,
        mesh.anchorPoints,
        dims.width,
        dims.height,
        (stage, current, total) => setProgress({ stage, current, total })
      )

      rawTrackingRef.current = anchorTracking
      setTotalFrames(anchorTracking.length)

      // Extract keyframes at the configured interval
      const kfs = extractKeyframes(anchorTracking, interval)
      setKeyframes(kfs)
      setSelectedKfIndex(null)
    } catch (err) {
      console.error('Tracking failed:', err)
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
    }

    setComputing(false)
  }

  function handleIntervalChange(newInterval: number) {
    const clamped = Math.max(1, Math.min(50, newInterval))
    setInterval_(clamped)

    // Re-extract keyframes if we have tracking data
    if (rawTrackingRef.current) {
      const kfs = extractKeyframes(rawTrackingRef.current, clamped)
      setKeyframes(kfs)
      setSelectedKfIndex(null)
    }
  }

  const handleUpdateKeyframePositions = useCallback((positions: Point2D[]) => {
    if (selectedKfIndex === null) return
    setKeyframes(prev => {
      const next = [...prev]
      next[selectedKfIndex] = { ...next[selectedKfIndex], anchorPositions: positions }
      return next
    })
  }, [selectedKfIndex])

  /**
   * Validate + propagate: re-track from corrected keyframe forward
   * to the next keyframe via Lucas-Kanade.
   */
  const handleValidateAndPropagate = useCallback(async () => {
    if (selectedKfIndex === null || !project.videoBlob || !imgDims) return

    const currentKf = keyframes[selectedKfIndex]
    const nextKfIndex = selectedKfIndex < keyframes.length - 1 ? selectedKfIndex + 1 : null

    if (nextKfIndex !== null) {
      const nextKf = keyframes[nextKfIndex]
      const startFrame = currentKf.frameIndex
      const endFrame = nextKf.frameIndex

      if (endFrame > startFrame) {
        setPropagating(true)
        setError(null)

        try {
          setProgress({ stage: 'Chargement OpenCV...', current: 0, total: 1 })
          await loadOpenCVWorker()

          setProgress({ stage: 'Propagation...', current: 0, total: endFrame - startFrame })
          const results = await trackSegment(
            project.videoBlob,
            currentKf.anchorPositions,
            imgDims.width,
            imgDims.height,
            startFrame,
            endFrame,
            (current, total) => setProgress({ stage: 'Propagation...', current, total })
          )

          // Update raw tracking data with new segment
          if (rawTrackingRef.current) {
            rawTrackingRef.current[startFrame] = currentKf.anchorPositions
            for (const { frameIndex, points } of results) {
              if (frameIndex >= 0 && frameIndex < rawTrackingRef.current.length) {
                rawTrackingRef.current[frameIndex] = points
              }
            }
          }

          // Update next keyframe positions from the new tracking
          const lastResult = results[results.length - 1]
          if (lastResult) {
            setKeyframes(prev => {
              const next = [...prev]
              next[nextKfIndex] = {
                ...next[nextKfIndex],
                anchorPositions: lastResult.points,
              }
              return next
            })
          }
        } catch (err) {
          console.error('Propagation failed:', err)
          setError(err instanceof Error ? err.message : 'Erreur propagation')
        }

        setPropagating(false)
      }
    }

    // Move to next keyframe
    if (nextKfIndex !== null) {
      setSelectedKfIndex(nextKfIndex)
    } else {
      setSelectedKfIndex(null)
    }
  }, [selectedKfIndex, keyframes, project.videoBlob, imgDims])

  const handleValidateOnly = useCallback(() => {
    if (selectedKfIndex !== null && selectedKfIndex < keyframes.length - 1) {
      setSelectedKfIndex(selectedKfIndex + 1)
    } else {
      setSelectedKfIndex(null)
    }
  }, [selectedKfIndex, keyframes.length])

  async function handleSaveKeyframes() {
    if (!mesh) return
    setSaving(true)
    try {
      // Propagate keyframes to get all frame positions
      const anchorFrames = propagateKeyframes(keyframes, totalFrames)

      const updatedMesh: MeshData = {
        ...mesh,
        keyframeInterval: interval,
        keyframes,
        anchorFrames,
      }

      await onSave(
        { ...project, mesh: updatedMesh },
        ['keyframes', 'anchorFrames']
      )
    } catch (err) {
      console.error('Failed to save keyframes:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!isLocked) {
    return (
      <div className="placeholder">
        Verrouillez d'abord la topologie dans l'onglet Triangulation.
      </div>
    )
  }

  if (!hasVideo) {
    return (
      <div className="placeholder">
        Importez d'abord une vidéo dans l'onglet Import.
      </div>
    )
  }

  const progressPercent = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0

  const isBusy = computing || propagating

  return (
    <div className="optical-flow-step">
      <h3>Validation des Keyframes</h3>
      <p style={{ fontSize: '0.875rem', color: '#888', marginBottom: 16 }}>
        Les points d'ancrage sont trackés automatiquement via Lucas-Kanade.
        Corrigez les positions puis \u00ab Valider & Propager \u00bb pour re-tracker\n        depuis vos corrections vers la keyframe suivante.
      </p>

      <div className="triangulation-toolbar">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Intervalle:
          <button onClick={() => handleIntervalChange(interval - 5)} disabled={interval <= 1 || isBusy}>−</button>
          <span className="density-label">{interval} frames</span>
          <button onClick={() => handleIntervalChange(interval + 5)} disabled={isBusy}>+</button>
        </label>

        <span className="toolbar-separator" />

        <button onClick={handleComputeTracking} disabled={isBusy}>
          {computing ? 'Tracking en cours...' : hasKeyframes ? 'Re-tracker' : 'Lancer le tracking'}
        </button>

        {hasKeyframes && (
          <>
            <span className="toolbar-separator" />
            <button onClick={handleSaveKeyframes} disabled={saving || isBusy}>
              {saving ? 'Sauvegarde...' : 'Sauvegarder keyframes'}
            </button>
          </>
        )}

        <span className="toolbar-info">
          {hasKeyframes
            ? `${keyframes.length} keyframes | ${totalFrames} frames total | ${mesh!.anchorPoints.length} anchors`
            : `${mesh!.anchorPoints.length} anchors à tracker`}
        </span>
      </div>

      {isBusy && (
        <div className="progress-container">
          <div className="progress-label">
            {progress.stage} — {progress.current}/{progress.total} ({progressPercent}%)
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      )}

      {error && <div className="error-message">Erreur : {error}</div>}

      {hasKeyframes && (
        <>
          <KeyframeTimeline
            keyframes={keyframes}
            totalFrames={totalFrames}
            selectedIndex={selectedKfIndex}
            onSelect={setSelectedKfIndex}
          />

          {selectedKfIndex !== null && imgDims && project.videoBlob && (
            <KeyframeEditor
              videoBlob={project.videoBlob}
              imageWidth={imgDims.width}
              imageHeight={imgDims.height}
              frameIndex={keyframes[selectedKfIndex].frameIndex}
              anchorPositions={keyframes[selectedKfIndex].anchorPositions}
              referencePositions={keyframes[0]?.anchorPositions}
              totalFrames={totalFrames}
              onUpdatePositions={handleUpdateKeyframePositions}
              onValidate={handleValidateAndPropagate}
              onValidateOnly={handleValidateOnly}
              propagating={propagating}
            />
          )}
        </>
      )}
    </div>
  )
}
