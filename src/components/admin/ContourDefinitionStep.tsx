import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationCanvas from '../triangulation/TriangulationCanvas'
import { useTriangulation } from '../triangulation/useTriangulation'
import { generateAutoMesh } from '../../utils/autoMeshGenerator'
import type { PointType } from '../triangulation/drawingUtils'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function ContourDefinitionStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [contourDensity, setContourDensity] = useState(5)
  const isAutoContour = useRef(false)

  const {
    contourPoints,
    contourClosed,
    addContourPoint,
    insertContourPoint,
    closeContour,
    movePoint,
    deletePoint,
    resampleContour,
    loadAutoMesh,
    clearAll,
  } = useTriangulation(
    project.mesh?.contourVertices?.length
      ? {
          contourPoints: project.mesh.contourVertices,
          internalPoints: [],
          triangles: [],
        }
      : undefined
  )

  useEffect(() => {
    if (!project.originalImageBlob) {
      setImageUrl(null)
      return
    }
    const url = URL.createObjectURL(project.originalImageBlob)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [project.originalImageBlob])

  const runAutoContour = useCallback(async (d: number) => {
    if (!project.originalImageBlob) return
    setGenerating(true)
    try {
      const result = await generateAutoMesh(project.originalImageBlob, d)
      loadAutoMesh(result.contourPoints, [])
      isAutoContour.current = true
    } catch (err) {
      console.error('Auto contour detection failed:', err)
    } finally {
      setGenerating(false)
    }
  }, [project.originalImageBlob, loadAutoMesh])

  function handleContourDensityChange(delta: number) {
    const newD = Math.max(1, Math.min(10, contourDensity + delta))
    setContourDensity(newD)
    if (isAutoContour.current) {
      runAutoContour(newD)
    }
  }

  const handleMovePoint = useCallback((type: PointType, index: number, p: Point2D) => {
    movePoint(type as 'contour' | 'internal', index, p)
  }, [movePoint])

  const handleDeletePoint = useCallback((type: PointType, index: number) => {
    deletePoint(type as 'contour' | 'internal', index)
  }, [deletePoint])

  function handleClearAll() {
    clearAll()
    isAutoContour.current = false
  }

  async function handleSave() {
    setSaving(true)
    try {
      const mesh: MeshData = {
        contourVertices: contourPoints,
        cannyParams: project.mesh?.cannyParams ?? null,
        contourKeyframeInterval: project.mesh?.contourKeyframeInterval ?? 10,
        contourKeyframes: project.mesh?.contourKeyframes ?? [],
        contourFrames: project.mesh?.contourFrames ?? null,
        contourTrackingValidated: false, // Reset when contour changes
        anchorPoints: project.mesh?.anchorPoints ?? [],
        anchorKeyframeInterval: project.mesh?.anchorKeyframeInterval ?? 10,
        anchorKeyframes: project.mesh?.anchorKeyframes ?? [],
        anchorFrames: project.mesh?.anchorFrames ?? null,
        anchorTrackingValidated: false,
        internalPoints: project.mesh?.internalPoints ?? [],
        triangles: project.mesh?.triangles ?? [],
        topologyLocked: false, // Reset topology when contour changes
        trackedTriangles: [],
        internalBarycentrics: [],
        videoFramesMesh: null,
      }

      await onSave({ ...project, mesh })
    } catch (err) {
      console.error('Failed to save contour:', err)
      alert('Erreur lors de la sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!project.originalImageBlob) {
    return (
      <div className="placeholder">
        Importez d&apos;abord une image dans l&apos;onglet Import.
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        <button onClick={() => runAutoContour(contourDensity)} disabled={generating}>
          {generating ? 'Détection...' : 'Auto-détecter contour'}
        </button>
        <button
          onClick={() => handleContourDensityChange(-1)}
          disabled={contourDensity <= 1 || generating}
          title="Moins dense"
        >
          −
        </button>
        <span className="density-label">Densité: {contourDensity}</span>
        <button
          onClick={() => handleContourDensityChange(1)}
          disabled={contourDensity >= 10 || generating}
          title="Plus dense"
        >
          +
        </button>

        {contourClosed && (
          <>
            <span className="toolbar-separator" />
            <button
              onClick={() => resampleContour(Math.max(3, contourPoints.length - 5))}
              disabled={contourPoints.length <= 3}
              title="Moins de points"
            >
              − pts
            </button>
            <span className="density-label">Contour: {contourPoints.length} pts</span>
            <button
              onClick={() => resampleContour(contourPoints.length + 5)}
              title="Plus de points"
            >
              + pts
            </button>
          </>
        )}

        <span className="toolbar-separator" />

        <button onClick={handleSave} disabled={saving || !contourClosed}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder contour'}
        </button>
        <button className="btn-danger" onClick={handleClearAll}>
          Tout effacer
        </button>

        <span className="toolbar-info">
          {contourPoints.length} sommets{contourClosed ? ' (fermé)' : ''} — tous trackés
        </span>
      </div>

      <div className="triangulation-help">
        {!contourClosed ? (
          <span>
            Clic gauche = ajouter un sommet | Clic sur le 1er point = fermer le contour |
            Clic droit = supprimer | Molette = zoom | Espace + glisser = déplacer la vue
          </span>
        ) : (
          <span>
            Clic gauche sur un bord = insérer un sommet | Glisser = déplacer |
            Clic droit = supprimer | ± pts pour ajuster la densité
          </span>
        )}
      </div>

      <TriangulationCanvas
        imageUrl={imageUrl}
        contourPoints={contourPoints}
        internalPoints={[]}
        triangles={[]}
        contourClosed={contourClosed}
        mode="contour"
        onAddContourPoint={addContourPoint}
        onInsertContourPoint={insertContourPoint}
        onCloseContour={closeContour}
        onAddInternalPoint={() => {}}
        onMovePoint={handleMovePoint}
        onDeletePoint={handleDeletePoint}
        showAnchorNumbers={true}
      />
    </div>
  )
}
