import { useAdminContext } from './AdminLayout'
import FilmEditorT from '../../components/admin/film/FilmEditorT'

export default function FilmSection() {
  const { project, save, canPreview } = useAdminContext()

  if (!canPreview) {
    return (
      <div className="admin-section-disabled">
        <p>Complétez au moins une animation (calcul des frames) pour créer le film.</p>
      </div>
    )
  }

  return <FilmEditorT project={project} onSave={save} />
}
