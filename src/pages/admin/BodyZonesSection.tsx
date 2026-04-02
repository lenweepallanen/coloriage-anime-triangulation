import { useAdminContext } from './AdminLayout'
import BodyZoneEditor from '../../components/admin/BodyZoneEditor'

export default function BodyZonesSection() {
  const { project, save } = useAdminContext()

  const restAnim = project.animations.find(a => a.type === 'rest')
  const hasTopology = restAnim?.mesh?.topologyLocked === true
    && restAnim.mesh.triangles.length > 0

  if (!hasTopology) {
    return (
      <div className="admin-section-disabled">
        <p>Verrouillez la topologie dans l'étape Triangulation de l'animation rest pour accéder à l'éditeur de zones corporelles.</p>
      </div>
    )
  }

  return <BodyZoneEditor project={project} onSave={save} />
}
