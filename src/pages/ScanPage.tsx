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
  type ScanStage = 'camera' | 'adjust' | 'processing' | 'preview' | 'animation'

  const [stage, setStage] = useState<ScanStage>('camera')
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [detectedCorners, setDetectedCorners] = useState<Point2D[] | null>(null)
  const processor = useScanProcessor(project)

  // Transition from processing to preview when rectified canvas is ready
  useEffect(() => {
    if (processor.rectifiedCanvas && stage === 'processing' && !processor.processing) {
      const url = processor.rectifiedCanvas.toDataURL()
      setPreviewUrl(url)
      setStage('preview')
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
    setPreviewUrl(null)
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

      {stage === 'preview' && previewUrl && (
        <div className="scan-preview">
          <h3>Scan redressé</h3>
          <img
            src={previewUrl}
            alt="Scan redressé"
            style={{ maxWidth: '100%', maxHeight: 400, border: '1px solid #ddd', borderRadius: 8 }}
          />
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
