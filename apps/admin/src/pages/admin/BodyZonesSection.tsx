import { useAdminContext } from './AdminLayout'
import BodyZoneEditor from '../../components/admin/BodyZoneEditor'
import { getGeometryOwner } from '../../types/project'

export default function BodyZonesSection() {
  const { project, save } = useAdminContext()

  const owner = getGeometryOwner(project.animations)
  const hasTopology = owner?.mesh?.topologyLocked === true
    && owner.mesh.triangles.length > 0

  if (!hasTopology) {
    return (
      <div className="admin-section-disabled">
        <p>Verrouillez la topologie d'une animation pour accéder à l'éditeur de zones corporelles.</p>
      </div>
    )
  }

  return <BodyZoneEditor project={project} onSave={save} />
}
