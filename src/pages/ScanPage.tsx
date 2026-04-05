import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, Navigate } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import CameraView from '../components/scan/CameraView'
import CornerAdjustment from '../components/scan/CornerAdjustment'
import { useScanProcessor } from '../components/scan/ScanProcessor'
import AnimationPlayer from '../components/scan/AnimationPlayer'
import ScenePlayer from '../components/scan/ScenePlayer'
import { generateLimbMask } from '../utils/limbMaskGenerator'
import { requestLamaInpainting } from '../utils/lamaInpainting'
import type { Point2D, Project } from '../types/project'

export default function ScanPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading } = useProject(projectId!)

  if (loading) return <div className="loading">Chargement...</div>
  if (!project) return <Navigate to="/" replace />

  const restAnim = project.animations.find(a => a.type === 'rest')
  const hasMesh = restAnim?.mesh && restAnim.mesh.triangles.length > 0

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
  type LamaStatus = 'idle' | 'generating-mask' | 'warmup' | 'inpainting' | 'done' | 'error' | 'not-needed'

  const [stage, setStage] = useState<ScanStage>('camera')
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [detectedCorners, setDetectedCorners] = useState<Point2D[] | null>(null)
  const [lamaCanvas, setLamaCanvas] = useState<HTMLCanvasElement | null>(null)
  const [lamaStatus, setLamaStatus] = useState<LamaStatus>('idle')
  const [lamaError, setLamaError] = useState<string | null>(null)
  const [lamaMaskUrl, setLamaMaskUrl] = useState<string | null>(null)
  const [lamaResultUrl, setLamaResultUrl] = useState<string | null>(null)
  const lamaStartedRef = useRef(false)
  const processor = useScanProcessor(project)

  // Transition from processing to debug view when rectified canvas is ready
  useEffect(() => {
    if (processor.rectifiedCanvas && stage === 'processing' && !processor.processing) {
      setStage('debug')
    }
  }, [processor.rectifiedCanvas, processor.processing, stage])

  // Trigger LaMa inpainting after rectified canvas is ready
  useEffect(() => {
    if (!processor.rectifiedCanvas || lamaStartedRef.current) return
    lamaStartedRef.current = true

    // Find walk animation with limb separation zones
    const walkAnim = project.animations.find(
      a => a.type === 'walk' && a.mesh?.walkLimbSeparation?.zones?.length
    )
    if (!walkAnim?.mesh?.walkLimbSeparation) {
      setLamaStatus('not-needed')
      return
    }

    const sep = walkAnim.mesh.walkLimbSeparation
    const scanCanvas = processor.rectifiedCanvas

    ;(async () => {
      try {
        setLamaStatus('generating-mask')

        // Generate binary mask from limb zone Bézier polygons
        const maskCanvas = generateLimbMask(
          sep.zones,
          scanCanvas.width, scanCanvas.height,
          scanCanvas.width, scanCanvas.height,
          processor.contentAlignment ?? undefined,
        )
        setLamaMaskUrl(maskCanvas.toDataURL())

        setLamaStatus('warmup')

        // Call LaMa Cloud Function (ping warmup + inpainting)
        const result = await requestLamaInpainting(scanCanvas, maskCanvas, {
          onPhase: (phase) => setLamaStatus(phase),
        })
        setLamaCanvas(result)
        setLamaResultUrl(result.toDataURL())
        setLamaStatus('done')
      } catch (err) {
        console.warn('[LaMa] Inpainting failed, will use Laplacian fallback:', err)
        setLamaError(err instanceof Error ? err.message : 'Erreur LaMa')
        setLamaStatus('error')
      }
    })()
  }, [processor.rectifiedCanvas, processor.contentAlignment, project.animations])

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
    setLamaCanvas(null)
    setLamaStatus('idle')
    setLamaError(null)
    setLamaMaskUrl(null)
    setLamaResultUrl(null)
    lamaStartedRef.current = false
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

          {(lamaStatus === 'generating-mask' || lamaStatus === 'warmup' || lamaStatus === 'inpainting' || lamaStatus === 'done' || lamaStatus === 'error') && (
            <div style={{
              marginBottom: 16, padding: '10px 16px', borderRadius: 8,
              background: lamaStatus === 'done' ? '#e6f9e6' : lamaStatus === 'error' ? '#fff3cd' : '#e8f4fd',
              border: `1px solid ${lamaStatus === 'done' ? '#7bc67b' : lamaStatus === 'error' ? '#e8a735' : '#8ec8f0'}`,
              fontSize: 14,
            }}>
              {lamaStatus === 'generating-mask' && 'LaMa : Génération du masque...'}
              {lamaStatus === 'warmup' && 'LaMa : Lancement instance...'}
              {lamaStatus === 'inpainting' && 'LaMa : Calcul inpainting...'}
              {lamaStatus === 'done' && 'LaMa : Terminé'}
              {lamaStatus === 'error' && `LaMa : Erreur (fallback Laplacien) — ${lamaError}`}
            </div>
          )}

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

          {lamaStatus !== 'idle' && lamaStatus !== 'not-needed' && (
            <div style={{ marginBottom: 24 }}>
              <h4>5. LaMa Inpainting — Scan sans pattes</h4>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: '1 1 200px', maxWidth: 400 }}>
                  <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>Masque (zones pattes)</div>
                  {lamaMaskUrl ? (
                    <img
                      src={lamaMaskUrl}
                      alt="Masque LaMa"
                      style={{ width: '100%', maxHeight: 300, objectFit: 'contain', border: '1px solid #999', borderRadius: 8 }}
                    />
                  ) : (
                    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #ccc', borderRadius: 8, color: '#999', fontSize: 13 }}>
                      Génération du masque...
                    </div>
                  )}
                </div>
                <div style={{ flex: '1 1 200px', maxWidth: 400 }}>
                  <div style={{ fontSize: 13, color: '#666', marginBottom: 4 }}>Résultat inpainting</div>
                  {lamaResultUrl ? (
                    <img
                      src={lamaResultUrl}
                      alt="Résultat LaMa"
                      style={{ width: '100%', maxHeight: 300, objectFit: 'contain', border: '1px solid #999', borderRadius: 8 }}
                    />
                  ) : lamaStatus === 'error' ? (
                    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #e8a735', borderRadius: 8, background: '#fff8e8', color: '#8a6d00', fontSize: 13, padding: 12, textAlign: 'center' }}>
                      Erreur LaMa — fallback Laplacien<br/><span style={{ fontSize: 11, color: '#999' }}>{lamaError}</span>
                    </div>
                  ) : (
                    <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #ccc', borderRadius: 8, color: '#999', fontSize: 13 }}>
                      {lamaStatus === 'warmup' ? 'Démarrage instance...' : lamaStatus === 'inpainting' ? 'Calcul inpainting...' : 'En attente...'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              onClick={() => setStage('animation')}
              disabled={lamaStatus === 'generating-mask' || lamaStatus === 'warmup' || lamaStatus === 'inpainting'}
            >
              {lamaStatus === 'warmup' || lamaStatus === 'inpainting' ? 'Inpainting en cours...' : 'Lancer l\'animation'}
            </button>
            <button onClick={handleRetake}>
              Rescanner
            </button>
          </div>
        </div>
      )}

      {stage === 'animation' && processor.rectifiedCanvas && (
        project.scene && project.scene.backgroundLayers[2].imageBlob && project.scene.restPoints.length > 0
          ? <ScenePlayer
              project={project}
              scanCanvas={processor.rectifiedCanvas}
              lamaCanvas={lamaCanvas}
              contentAlignment={processor.contentAlignment}
              onClose={handleRetake}
            />
          : <AnimationPlayer
              project={project}
              scanCanvas={processor.rectifiedCanvas}
              lamaCanvas={lamaCanvas}
              contentAlignment={processor.contentAlignment}
              onClose={handleRetake}
            />
      )}
    </div>
  )
}
