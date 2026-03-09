import { useState, useEffect } from 'react'
import type { Project } from '../../types/project'
import TriangulationCanvas, { type EditorMode } from '../triangulation/TriangulationCanvas'
import { useTriangulation } from '../triangulation/useTriangulation'

interface Props {
  project: Project
  onSave: (project: Project) => Promise<void>
}

export default function TriangulationStep({ project, onSave }: Props) {
  const [mode, setMode] = useState<EditorMode>('contour')
  const [saving, setSaving] = useState(false)
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  const {
    contourPoints,
    internalPoints,
    allPoints,
    triangles,
    contourClosed,
    addContourPoint,
    closeContour,
    addInternalPoint,
    movePoint,
    deletePoint,
    clearAll,
  } = useTriangulation(project.mesh ?? undefined)

  useEffect(() => {
    if (!project.originalImageBlob) {
      setImageUrl(null)
      return
    }
    const url = URL.createObjectURL(project.originalImageBlob)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [project.originalImageBlob])

  async function handleSave() {
    setSaving(true)
    await onSave({
      ...project,
      mesh: {
        contourPoints,
        internalPoints,
        triangles,
        videoFramesMesh: project.mesh?.videoFramesMesh ?? null,
      },
    })
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
          disabled={contourClosed}
        >
          Mode Contour
        </button>
        <button
          className={mode === 'internal' ? 'active' : ''}
          onClick={() => setMode('internal')}
          disabled={!contourClosed}
        >
          Mode Points internes
        </button>

        <span className="toolbar-separator" />

        <button onClick={handleSave} disabled={saving}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder mesh'}
        </button>
        <button className="btn-danger" onClick={clearAll}>
          Tout effacer
        </button>

        <span className="toolbar-info">
          Contour: {contourPoints.length} pts{contourClosed ? ' (fermé)' : ''} |
          Internes: {internalPoints.length} pts |
          Triangles: {triangles.length}
        </span>
      </div>

      <div className="triangulation-help">
        {mode === 'contour' && !contourClosed && (
          <span>
            Clic gauche = ajouter un point de contour | Clic sur le 1er point = fermer le contour |
            Clic droit = supprimer un point | Molette = zoom | Espace + glisser = déplacer la vue
          </span>
        )}
        {mode === 'contour' && contourClosed && (
          <span>
            Contour fermé. Passez en mode "Points internes" pour ajouter des points.
          </span>
        )}
        {mode === 'internal' && (
          <span>
            Clic gauche = ajouter un point interne | Glisser = déplacer un point |
            Clic droit = supprimer
          </span>
        )}
      </div>

      <TriangulationCanvas
        imageUrl={imageUrl}
        contourPoints={contourPoints}
        internalPoints={internalPoints}
        triangles={triangles}
        contourClosed={contourClosed}
        mode={mode}
        onAddContourPoint={addContourPoint}
        onCloseContour={closeContour}
        onAddInternalPoint={addInternalPoint}
        onMovePoint={movePoint}
        onDeletePoint={deletePoint}
      />
    </div>
  )
}
