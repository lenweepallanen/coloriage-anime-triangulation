import { useState } from 'react'
import type { Project } from '../../types/project'
import { loadOpenCV } from '../../utils/opencvLoader'
import { precomputeOpticalFlow } from '../../utils/opticalFlowComputer'

interface Props {
  project: Project
  onSave: (project: Project) => Promise<void>
}

export default function OpticalFlowStep({ project, onSave }: Props) {
  const [computing, setComputing] = useState(false)
  const [progress, setProgress] = useState({ stage: '', current: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)

  const hasMesh = project.mesh && project.mesh.triangles.length > 0
  const hasVideo = !!project.videoBlob
  const hasFlow = project.mesh?.videoFramesMesh != null

  async function handleCompute() {
    if (!project.mesh || !project.videoBlob || !project.originalImageBlob) return

    setComputing(true)
    setError(null)

    try {
      const cv = await loadOpenCV()

      // Get image dimensions
      const imgDims = await getImageDimensions(project.originalImageBlob)

      const allPoints = [...project.mesh.contourPoints, ...project.mesh.internalPoints]

      const { videoFramesMesh } = await precomputeOpticalFlow(
        cv,
        project.videoBlob,
        allPoints,
        imgDims.width,
        imgDims.height,
        (stage, current, total) => setProgress({ stage, current, total })
      )

      await onSave({
        ...project,
        mesh: {
          ...project.mesh,
          videoFramesMesh,
        },
      })
    } catch (err) {
      console.error('Optical flow computation failed:', err)
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
    }

    setComputing(false)
  }

  if (!hasVideo || !hasMesh) {
    return (
      <div className="placeholder">
        {!hasVideo && 'Importez d\'abord une vidéo. '}
        {!hasMesh && 'Définissez d\'abord un mesh dans l\'onglet Triangulation.'}
      </div>
    )
  }

  const progressPercent = progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0

  return (
    <div className="optical-flow-step">
      <h3>Pré-calcul du tracking optique</h3>
      <p style={{ fontSize: '0.875rem', color: '#888', marginBottom: 16 }}>
        Ce calcul suit les points du mesh à travers chaque frame de la vidéo
        via l'algorithme Lucas-Kanade. Le résultat permet d'animer le mesh
        en synchronisation avec la vidéo.
      </p>

      {hasFlow && (
        <div className="flow-status">
          Tracking déjà calculé ({project.mesh!.videoFramesMesh!.length} frames).
          Vous pouvez recalculer si vous avez modifié le mesh.
        </div>
      )}

      <div className="triangulation-toolbar">
        <button onClick={handleCompute} disabled={computing}>
          {computing ? 'Calcul en cours...' : hasFlow ? 'Recalculer' : 'Lancer le calcul'}
        </button>
      </div>

      {computing && (
        <div className="progress-container">
          <div className="progress-label">
            {progress.stage} — {progress.current}/{progress.total} ({progressPercent}%)
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="error-message">
          Erreur : {error}
        </div>
      )}
    </div>
  )
}

function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}
