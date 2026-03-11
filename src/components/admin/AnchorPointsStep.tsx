import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationCanvas from '../triangulation/TriangulationCanvas'
import { useTriangulation } from '../triangulation/useTriangulation'
import { generateAutoMesh } from '../../utils/autoMeshGenerator'
import type { PointType } from '../triangulation/drawingUtils'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function AnchorPointsStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [anchorDensity, setAnchorDensity] = useState(3)
  const isAutoAnchors = useRef(false)
  const [featureAnchors, setFeatureAnchors] = useState<Point2D[]>(
    () => project.mesh?.anchorPoints ?? []
  )

  // Load contour from mesh as read-only reference
  const contourVertices = project.mesh?.contourVertices ?? []

  const {
    contourPoints,
    contourClosed,
  } = useTriangulation(
    contourVertices.length
      ? { contourPoints: contourVertices, internalPoints: [], triangles: [] }
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

  const runAutoAnchors = useCallback(async (d: number) => {
    if (!project.originalImageBlob) return
    setGenerating(true)
    try {
      const result = await generateAutoMesh(project.originalImageBlob, d)
      setFeatureAnchors(result.internalPoints)
      isAutoAnchors.current = true
    } catch (err) {
      console.error('Auto anchor detection failed:', err)
    } finally {
      setGenerating(false)
    }
  }, [project.originalImageBlob])

  function handleAnchorDensityChange(delta: number) {
    const newD = Math.max(1, Math.min(10, anchorDensity + delta))
    setAnchorDensity(newD)
    if (isAutoAnchors.current) {
      runAutoAnchors(newD)
    }
  }

  const handleAddAnchor = useCallback((p: Point2D) => {
    setFeatureAnchors(prev => [...prev, p])
  }, [])

  const handleMovePoint = useCallback((type: PointType, index: number, p: Point2D) => {
    if (type === 'anchor') {
      setFeatureAnchors(prev => {
        const next = [...prev]
        next[index] = p
        return next
      })
    }
  }, [])

  const handleDeletePoint = useCallback((type: PointType, index: number) => {
    if (type === 'anchor') {
      setFeatureAnchors(prev => prev.filter((_, i) => i !== index))
    }
  }, [])

  async function handleSave() {
    if (!project.mesh) return
    setSaving(true)
    try {
      const mesh = {
        ...project.mesh,
        anchorPoints: featureAnchors,
        anchorTrackingValidated: false,
        anchorKeyframes: [],
        anchorFrames: null,
        topologyLocked: false,
        trackedTriangles: [] as [number, number, number][],
        internalBarycentrics: [],
        videoFramesMesh: null,
      }

      await onSave({ ...project, mesh })
    } catch (err) {
      console.error('Failed to save anchors:', err)
      alert('Erreur lors de la sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!project.mesh?.contourTrackingValidated) {
    return (
      <div className="placeholder">
        Validez d&apos;abord le tracking du contour (étape 4).
      </div>
    )
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

        <span className="toolbar-separator" />

        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder ancres'}
        </button>
        <button
          className="btn-danger"
          onClick={() => { setFeatureAnchors([]); isAutoAnchors.current = false }}
        >
          Effacer ancres
        </button>

        <span className="toolbar-info">
          Contour: {contourVertices.length} pts (lecture seule) |
          Ancres: {featureAnchors.length} pts
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Clic gauche = ajouter un point d&apos;ancrage (yeux, ailes, queue...) |
          Glisser = déplacer | Clic droit = supprimer |
          Le contour (bleu) est en lecture seule.
        </span>
      </div>

      <TriangulationCanvas
        imageUrl={imageUrl}
        contourPoints={contourPoints}
        internalPoints={[]}
        triangles={[]}
        contourClosed={contourClosed}
        mode="anchor"
        onAddContourPoint={() => {}}
        onInsertContourPoint={() => {}}
        onCloseContour={() => {}}
        onAddInternalPoint={() => {}}
        onMovePoint={handleMovePoint}
        onDeletePoint={handleDeletePoint}
        anchorPoints={featureAnchors}
        onAddAnchorPoint={handleAddAnchor}
        showAnchorNumbers={true}
      />
    </div>
  )
}
