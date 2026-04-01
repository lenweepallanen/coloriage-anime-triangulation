import { useAdminContext } from './AdminLayout'
import SceneEditor from '../../components/admin/SceneEditor'

export default function SceneSection() {
  const { project, save, canPreview } = useAdminContext()

  if (!canPreview) {
    return (
      <div className="admin-section-disabled">
        <p>Complétez le pipeline de l'animation rest (triangulation + calcul animation) pour accéder à l'éditeur de scène.</p>
      </div>
    )
  }

  return <SceneEditor project={project} onSave={save} />
}
