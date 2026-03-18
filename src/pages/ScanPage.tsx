import { useState, useEffect, useCallback } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import CameraView from '../components/scan/CameraView'
import CornerAdjustment from '../components/scan/CornerAdjustment'
import { useScanProcessor } from '../components/scan/ScanProcessor'
import AnimationPlayer from '../components/scan/AnimationPlayer'
import type { Point2D, Project } from '../types/project'

export default function ScanPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading } = useProject(projectId!)

  if (loading) return <div className="loading">Chargement...</div>
  if (!project) return <Navigate to="/" replace />

  const hasMesh = project.mesh && project.mesh.triangles.length > 0

  if (!project.originalImageBlob || !hasMesh) {
    return (
      <div className="scan-page">
        <h2>{project.name} — Mode Coloriage</h2>
        <div className="placeholder">
          {!project.originalImageBlob && 'Aucune image importée. '}
          {!hasMesh && 'Aucun mesh défini. '}
          Configurez le projet dans le mode Admin d'abord.
        </div>
      </div>
    )
  }

  return <ScanFlow project={project} />
}

function ScanFlow({ project }: { project: Project }) {
  type ScanStage = 'camera' | 'adjust' | 'processing' | 'debug' | 'preview' | 'animation'

  const [stage, setStage] = useState<ScanStage>('camera')
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [detectedCorners, setDetectedCorners] = useState<Point2D[] | null>(null)
  const processor = useScanProcessor(project)

  // Transition from processing to debug view when rectified canvas is ready
  useEffect(() => {
    if (processor.rectifiedCanvas && stage === 'processing' && !processor.processing) {
      setStage('debug')
    }
  }, [processor.rectifiedCanvas, processor.processing, stage])

  const onCameraCapture = useCallback(
    (blob: Blob, corners: Point2D[] | null) => {
      setCapturedBlob(blob)
      setDetectedCorners(corners)
      setStage('adjust')
    },
    []
  )

  const onCornersConfirmed = useCallback(
    async (adjustedCorners: Point2D[]) => {
      if (!capturedBlob) return
      setStage('processing')
      await processor.handleCapture(capturedBlob, adjustedCorners)
    },
    [capturedBlob, processor]
  )

  function handleRetake() {
    processor.reset()
    setCapturedBlob(null)
    setDetectedCorners(null)
    setStage('camera')
  }

  return (
    <div className="scan-page">
      {stage !== 'animation' && <h2>{project.name} — Mode Coloriage</h2>}

      {stage === 'camera' && (
        <CameraView onCapture={onCameraCapture} />
      )}

      {stage === 'adjust' && capturedBlob && (
        <CornerAdjustment
          imageBlob={capturedBlob}
          initialCorners={detectedCorners}
          onConfirm={onCornersConfirmed}
          onRetake={handleRetake}
        />
      )}

      {stage === 'processing' && (
        <div className="scan-processing">
          <div className="loading">
            {processor.processing
              ? 'Traitement du scan...'
              : processor.error
                ? `Erreur : ${processor.error}`
                : 'Préparation...'}
          </div>
          {processor.error && (
            <button onClick={handleRetake} style={{ marginTop: 16 }}>
              Réessayer
            </button>
          )}
        </div>
      )}

      {stage === 'debug' && processor.debugImages && (
        <div className="scan-debug" style={{ padding: 16, overflowY: 'auto', maxHeight: '80vh' }}>
          <h3>Debug — Pipeline de scan</h3>

          <div style={{ marginBottom: 24 }}>
            <h4>1. Photo capturée (brute)</h4>
            <img
              src={processor.debugImages.capturedUrl}
              alt="Photo brute"
              style={{ maxWidth: '100%', maxHeight: 300, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <h4>2. Après correction perspective (2048×2048 avec marges)</h4>
            <img
              src={processor.debugImages.raw2048Url}
              alt="Correction perspective brute"
              style={{ maxWidth: '100%', maxHeight: 300, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <h4>3. Redressée & croppée (dimensions originales)</h4>
            <img
              src={processor.debugImages.rectifiedUrl}
              alt="Redressée croppée"
              style={{ maxWidth: '100%', maxHeight: 300, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <h4>4. Redressée + Triangulation (frame 0)</h4>
            <img
              src={processor.debugImages.meshOverlayUrl}
              alt="Overlay maillage"
              style={{ maxWidth: '100%', maxHeight: 400, border: '1px solid #999', borderRadius: 8 }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button onClick={() => setStage('animation')}>
              Lancer l'animation
            </button>
            <button onClick={handleRetake}>
              Rescanner
            </button>
          </div>
        </div>
      )}

      {stage === 'animation' && processor.rectifiedCanvas && (
        <AnimationPlayer
          project={project}
          scanCanvas={processor.rectifiedCanvas}
          onClose={handleRetake}
        />
      )}
    </div>
  )
}
