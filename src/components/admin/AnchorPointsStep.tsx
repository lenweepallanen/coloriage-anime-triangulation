import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project, Point2D, MeshData, ContourPathEntry } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationCanvas, { type EditorMode } from '../triangulation/TriangulationCanvas'
import { useTriangulation } from '../triangulation/useTriangulation'
import { generateAutoMesh } from '../../utils/autoMeshGenerator'
import type { PointType } from '../triangulation/drawingUtils'

/** Reconstruct full ordered contour from contourPath */
function reconstructContour(mesh: MeshData): Point2D[] {
  if (mesh.contourPath?.length) {
    return mesh.contourPath.map(entry =>
      entry.type === 'anchor'
        ? mesh.anchorPoints[entry.index]
        : mesh.contourPoints[entry.index]
    )
  }
  // Fallback: contourPoints alone (no promoted anchors)
  return mesh.contourPoints ?? []
}

/** Extract promoted indices from contourPath */
function extractPromotedIndices(mesh: MeshData): Set<number> {
  const promoted = new Set<number>()
  if (mesh.contourPath?.length) {
    mesh.contourPath.forEach((entry, i) => {
      if (entry.type === 'anchor') promoted.add(i)
    })
  }
  return promoted
}

/** Extract feature anchors (not on contour) from mesh */
function extractFeatureAnchors(mesh: MeshData): Point2D[] {
  if (!mesh.contourPath?.length) return mesh.anchorPoints ?? []
  const contourAnchorIndices = new Set(
    mesh.contourPath.filter(e => e.type === 'anchor').map(e => e.index)
  )
  return mesh.anchorPoints.filter((_, i) => !contourAnchorIndices.has(i))
}

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
  const [promotedIndices, setPromotedIndices] = useState<Set<number>>(() => {
    if (!project.mesh) return new Set()
    return extractPromotedIndices(project.mesh)
  })
  const [featureAnchors, setFeatureAnchors] = useState<Point2D[]>(() => {
    if (!project.mesh) return []
    return extractFeatureAnchors(project.mesh)
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
          contourPoints: reconstructContour(project.mesh),
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
      setPromotedIndices(new Set())
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
    } else if (type === 'contour') {
      // Remove from promoted indices and re-index
      setPromotedIndices(prev => {
        const next = new Set<number>()
        for (const pi of prev) {
          if (pi < index) next.add(pi)
          else if (pi > index) next.add(pi - 1)
          // pi === index: skip (deleted)
        }
        return next
      })
      deleteContourPoint('contour', index)
    } else {
      deleteContourPoint(type as 'contour' | 'internal', index)
    }
  }, [deleteContourPoint])

  const handleTogglePromotion = useCallback((index: number) => {
    setPromotedIndices(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }, [])

  function handleClearAll() {
    clearContour()
    setFeatureAnchors([])
    setPromotedIndices(new Set())
    isAutoContour.current = false
    isAutoAnchors.current = false
    setMode('contour')
  }

  async function handleSave() {
    setSaving(true)
    try {
      // Split contour points into promoted (→ anchors) and non-promoted (→ contourPoints)
      const promoted: Point2D[] = []
      const nonPromoted: Point2D[] = []
      const promotedIndexMap = new Map<number, number>() // contour index → anchor index
      const nonPromotedIndexMap = new Map<number, number>() // contour index → contourPoints index

      for (let i = 0; i < contourPoints.length; i++) {
        if (promotedIndices.has(i)) {
          promotedIndexMap.set(i, promoted.length)
          promoted.push(contourPoints[i])
        } else {
          nonPromotedIndexMap.set(i, nonPromoted.length)
          nonPromoted.push(contourPoints[i])
        }
      }

      // anchorPoints = promoted contour points + feature anchors
      const anchorPoints = [...promoted, ...featureAnchors]

      // Build contourPath in original contour order
      const contourPath: ContourPathEntry[] = contourPoints.map((_, i) => {
        if (promotedIndices.has(i)) {
          return { type: 'anchor' as const, index: promotedIndexMap.get(i)! }
        } else {
          return { type: 'contour' as const, index: nonPromotedIndexMap.get(i)! }
        }
      })

      const mesh: MeshData = {
        anchorPoints,
        contourPoints: nonPromoted,
        contourPath,
        internalPoints: project.mesh?.internalPoints ?? [],
        triangles: project.mesh?.triangles ?? [],
        topologyLocked: false,
        anchorTriangles: [],
        contourBarycentrics: [],
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
                  onClick={() => { setPromotedIndices(new Set()); resampleContour(Math.max(3, contourPoints.length - 5)) }}
                  disabled={contourPoints.length <= 3}
                  title="Moins de points sur le bord"
                >
                  − pts
                </button>
                <span className="density-label">Bord: {contourPoints.length} pts</span>
                <button
                  onClick={() => { setPromotedIndices(new Set()); resampleContour(contourPoints.length + 5) }}
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
          Contour: {contourPoints.length} pts{contourClosed ? ' (fermé)' : ''}
          {promotedIndices.size > 0 && ` (${promotedIndices.size} promus)`} |
          Ancres int.: {featureAnchors.length} pts |
          Total trackés: {promotedIndices.size + featureAnchors.length}
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
            Clic droit = supprimer | Shift+clic = promouvoir/rétrograder en anchor |
            Utilisez ± pour ajuster la densité du bord
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
        promotedContourIndices={promotedIndices}
        onTogglePromoteContour={handleTogglePromotion}
      />
    </div>
  )
}
