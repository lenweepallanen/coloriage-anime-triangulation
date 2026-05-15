import { useAdminContext } from './AdminLayout'
import SceneEditor from '../../components/admin/SceneEditor'

export default function SceneSection() {
  const { project, save, canEditScene } = useAdminContext()

  if (!canEditScene) {
    return (
      <div className="admin-section-disabled">
        <p>Complétez au moins une animation (calcul des frames) pour accéder à l'éditeur de scène.</p>
      </div>
    )
  }

  return <SceneEditor project={project} onSave={save} />
}
