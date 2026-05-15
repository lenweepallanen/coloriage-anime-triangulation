import { Link } from 'react-router-dom'
import { useAdminContext } from './AdminLayout'
import { getGeometryOwner } from '../../types/project'

export default function AdminSectionMenu() {
  const { project, canEditScene } = useAdminContext()

  // Zones corporelles : on a besoin d'une animation détenant une topologie verrouillée
  // (rest legacy ou n'importe quel mesh avec topologyLocked).
  const owner = getGeometryOwner(project.animations)
  const hasTopology = owner?.mesh?.topologyLocked === true
    && (owner.mesh.triangles?.length ?? 0) > 0

  return (
    <div className="admin-section-menu">
      <Link to="general" className="admin-section-card">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span className="admin-section-card-title">Paramètres Généraux</span>
        <span className="admin-section-card-desc">Titre, image, vidéo de fond, son, PDF</span>
      </Link>

      <Link to="animations" className="admin-section-card">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
          <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
          <path d="M7 2v20" />
          <path d="M17 2v20" />
          <path d="M2 12h20" />
          <path d="M2 7h5" />
          <path d="M2 17h5" />
          <path d="M17 17h5" />
          <path d="M17 7h5" />
        </svg>
        <span className="admin-section-card-title">Animations</span>
        <span className="admin-section-card-desc">Créer, éditer et prévisualiser les animations</span>
      </Link>

      <Link
        to={hasTopology ? 'zones' : '#'}
        className={`admin-section-card ${!hasTopology ? 'admin-section-card--disabled' : ''}`}
        onClick={e => { if (!hasTopology) e.preventDefault() }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span className="admin-section-card-title">Zones Corporelles</span>
        <span className="admin-section-card-desc">
          {hasTopology
            ? 'Définir les zones du maillage pour les interactions tactiles'
            : 'Verrouillez la topologie pour accéder aux zones'}
        </span>
      </Link>

      <Link
        to={canEditScene ? 'scene' : '#'}
        className={`admin-section-card ${!canEditScene ? 'admin-section-card--disabled' : ''}`}
        onClick={e => { if (!canEditScene) e.preventDefault() }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8" />
          <path d="M12 17v4" />
          <path d="M7 8l3 3-3 3" />
        </svg>
        <span className="admin-section-card-title">Scène</span>
        <span className="admin-section-card-desc">
          {canEditScene
            ? 'Éditeur de scène et transitions'
            : 'Complétez au moins une animation pour accéder à la scène'}
        </span>
      </Link>
    </div>
  )
}
