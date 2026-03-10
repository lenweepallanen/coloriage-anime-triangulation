import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationCanvas, { type EditorMode } from '../triangulation/TriangulationCanvas'
import { useTriangulation } from '../triangulation/useTriangulation'
import { generateAutoMesh } from '../../utils/autoMeshGenerator'
import type { PointType } from '../triangulation/drawingUtils'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function AnchorPointsStep({ project, onSave }: Props) {
  const [mode, setMode] = useState<EditorMode>('contour')
  const [saving, setSaving] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [contourDensity, setContourDensity] = useState(5)
  const [anchorDensity, setAnchorDensity] = useState(3)
  const isAutoContour = useRef(false)
  const isAutoAnchors = useRef(false)
  const [featureAnchors, setFeatureAnchors] = useState<Point2D[]>(() => {
    if (!project.mesh) return []
    const contourSet = new Set(project.mesh.contourIndices)
    return project.mesh.anchorPoints.filter((_, i) => !contourSet.has(i))
  })

  const {
    contourPoints,
    contourClosed,
    addContourPoint,
    insertContourPoint,
    closeContour,
    movePoint: moveContourPoint,
    deletePoint: deleteContourPoint,
    resampleContour,
    loadAutoMesh,
    clearAll: clearContour,
  } = useTriangulation(
    project.mesh
      ? {
          contourPoints: project.mesh.contourIndices.map(i => project.mesh!.anchorPoints[i]),
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

  const runAutoAnchors = useCallback(async (d: number) => {
    if (!project.originalImageBlob || !contourClosed) return
    setGenerating(true)
    try {
      // Use generateAutoMesh to get internal points, using current contour
      const result = await generateAutoMesh(project.originalImageBlob, d)
      setFeatureAnchors(result.internalPoints)
      isAutoAnchors.current = true
    } catch (err) {
      console.error('Auto anchor detection failed:', err)
    } finally {
      setGenerating(false)
    }
  }, [project.originalImageBlob, contourClosed])

  function handleContourDensityChange(delta: number) {
    const newD = Math.max(1, Math.min(10, contourDensity + delta))
    setContourDensity(newD)
    if (isAutoContour.current) {
      runAutoContour(newD)
    }
  }

  function handleAnchorDensityChange(delta: number) {
    const newD = Math.max(1, Math.min(10, anchorDensity + delta))
    setAnchorDensity(newD)
    if (isAutoAnchors.current) {
      runAutoAnchors(newD)
    }
  }

  const handleAddFeatureAnchor = useCallback((p: Point2D) => {
    setFeatureAnchors(prev => [...prev, p])
  }, [])

  const handleMovePoint = useCallback((type: PointType, index: number, p: Point2D) => {
    if (type === 'anchor') {
      setFeatureAnchors(prev => {
        const next = [...prev]
        next[index] = p
        return next
      })
    } else {
      moveContourPoint(type as 'contour' | 'internal', index, p)
    }
  }, [moveContourPoint])

  const handleDeletePoint = useCallback((type: PointType, index: number) => {
    if (type === 'anchor') {
      setFeatureAnchors(prev => prev.filter((_, i) => i !== index))
    } else {
      deleteContourPoint(type as 'contour' | 'internal', index)
    }
  }, [deleteContourPoint])

  function handleClearAll() {
    clearContour()
    setFeatureAnchors([])
    isAutoContour.current = false
    isAutoAnchors.current = false
    setMode('contour')
  }

  async function handleSave() {
    setSaving(true)
    try {
      // Build anchorPoints = [...contourPoints, ...featureAnchors]
      const anchorPoints = [...contourPoints, ...featureAnchors]
      const contourIndices = contourPoints.map((_, i) => i)

      const mesh: MeshData = {
        anchorPoints,
        contourIndices,
        internalPoints: project.mesh?.internalPoints ?? [],
        triangles: project.mesh?.triangles ?? [],
        topologyLocked: false,
        anchorTriangles: [],
        internalBarycentrics: [],
        keyframeInterval: project.mesh?.keyframeInterval ?? 10,
        keyframes: project.mesh?.keyframes ?? [],
        anchorFrames: project.mesh?.anchorFrames ?? null,
        videoFramesMesh: project.mesh?.videoFramesMesh ?? null,
      }

      await onSave({ ...project, mesh })
    } catch (err) {
      console.error('Failed to save anchors:', err)
      alert('Erreur lors de la sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!project.originalImageBlob) {
    return (
      <div className="placeholder">
        Importez d'abord une image dans l'onglet Import.
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        <button
          className={mode === 'contour' ? 'active' : ''}
          onClick={() => setMode('contour')}
        >
          Mode Contour
        </button>
        <button
          className={mode === 'anchor' ? 'active' : ''}
          onClick={() => setMode('anchor')}
          disabled={!contourClosed}
        >
          Mode Ancres
        </button>

        <span className="toolbar-separator" />

        {mode === 'contour' && (
          <>
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
                  title="Moins de points sur le bord"
                >
                  − pts
                </button>
                <span className="density-label">Bord: {contourPoints.length} pts</span>
                <button
                  onClick={() => resampleContour(contourPoints.length + 5)}
                  title="Plus de points sur le bord"
                >
                  + pts
                </button>
              </>
            )}
          </>
        )}

        {mode === 'anchor' && (
          <>
            <button onClick={() => runAutoAnchors(anchorDensity)} disabled={generating}>
              {generating ? 'Détection...' : 'Auto-détecter ancres'}
            </button>
            <button
              onClick={() => handleAnchorDensityChange(-1)}
              disabled={anchorDensity <= 1 || generating}
              title="Moins dense"
            >
              −
            </button>
            <span className="density-label">Densité: {anchorDensity}</span>
            <button
              onClick={() => handleAnchorDensityChange(1)}
              disabled={anchorDensity >= 10 || generating}
              title="Plus dense"
            >
              +
            </button>
            <button
              className="btn-danger"
              onClick={() => { setFeatureAnchors([]); isAutoAnchors.current = false }}
            >
              Effacer ancres
            </button>
          </>
        )}

        <span className="toolbar-separator" />

        <button onClick={handleSave} disabled={saving || !contourClosed}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder'}
        </button>
        <button className="btn-danger" onClick={handleClearAll}>
          Tout effacer
        </button>

        <span className="toolbar-info">
          Contour: {contourPoints.length} pts{contourClosed ? ' (fermé)' : ''} |
          Ancres: {featureAnchors.length} pts |
          Total: {contourPoints.length + featureAnchors.length}
        </span>
      </div>

      <div className="triangulation-help">
        {mode === 'contour' && !contourClosed && (
          <span>
            Clic gauche = ajouter un point de contour | Clic sur le 1er point = fermer le contour |
            Clic droit = supprimer | Molette = zoom | Espace + glisser = déplacer la vue
          </span>
        )}
        {mode === 'contour' && contourClosed && (
          <span>
            Clic gauche = ajouter un point sur le bord | Glisser = déplacer |
            Clic droit = supprimer | Utilisez ± pour ajuster la densité du bord
          </span>
        )}
        {mode === 'anchor' && (
          <span>
            Clic gauche = ajouter un point d'ancrage (yeux, ailes, queue...) |
            Glisser = déplacer | Clic droit = supprimer |
            Ces points seront trackés dans la vidéo.
          </span>
        )}
      </div>

      <TriangulationCanvas
        imageUrl={imageUrl}
        contourPoints={contourPoints}
        internalPoints={[]}
        triangles={[]}
        contourClosed={contourClosed}
        mode={mode}
        onAddContourPoint={addContourPoint}
        onInsertContourPoint={insertContourPoint}
        onCloseContour={closeContour}
        onAddInternalPoint={() => {}}
        onMovePoint={handleMovePoint}
        onDeletePoint={handleDeletePoint}
        anchorPoints={featureAnchors}
        onAddAnchorPoint={handleAddFeatureAnchor}
        showAnchorNumbers={true}
      />
    </div>
  )
}
