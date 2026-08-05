import { useAdminContext } from './AdminLayout'
import FilmEditor from '../../components/admin/film/FilmEditor'

export default function FilmSection() {
  const { project, save, canPreview } = useAdminContext()

  if (!canPreview) {
    return (
      <div className="admin-section-disabled">
        <p>Complétez au moins une animation (calcul des frames) pour créer le film.</p>
      </div>
    )
  }

  return <FilmEditor project={project} onSave={save} />
}
