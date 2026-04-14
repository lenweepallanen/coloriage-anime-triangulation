import { useParams, Navigate, Outlet, NavLink, Link, useOutletContext } from 'react-router-dom'
import { useProject } from '../../hooks/useProject'
import { animationHasFrames, type Project } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'

export interface AdminContext {
  project: Project
  save: (updated: Project, hints?: UploadHint[]) => Promise<void>
  canPreview: boolean
}

export function useAdminContext() {
  return useOutletContext<AdminContext>()
}

export default function AdminLayout() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading, save } = useProject(projectId!)

  if (loading) return <div className="loading">Chargement du projet...</div>
  if (!project) return <Navigate to="/" replace />

  const restAnim = project.animations.find(a => a.type === 'rest')
  const canPreview = restAnim != null && animationHasFrames(restAnim)

  const context: AdminContext = { project, save, canPreview }

  return (
    <div className="admin-layout">
      <div className="admin-layout-header">
        <div className="admin-layout-header-left">
          <Link to={`/admin/${project.id}`} className="admin-layout-home-link">
            {project.name}
          </Link>
        </div>
        <div className="admin-layout-header-right">
          <Link
            to={canPreview ? `/scan/${project.id}` : '#'}
            className={`admin-scanner-btn ${!canPreview ? 'admin-scanner-btn--disabled' : ''}`}
            onClick={e => { if (!canPreview) e.preventDefault() }}
            title={canPreview ? 'Scanner le coloriage' : 'Complétez le pipeline rest pour scanner'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span>Scanner</span>
          </Link>
        </div>
      </div>

      <nav className="admin-layout-nav">
        <NavLink to="general" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Paramètres
        </NavLink>
        <NavLink to="animations" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Animations
        </NavLink>
        <NavLink to="zones" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Zones
        </NavLink>
        <NavLink to="scene" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Scène
        </NavLink>
        <NavLink to="triangulation" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Triangulation
        </NavLink>
      </nav>

      <div className="admin-layout-content">
        <Outlet context={context} />
      </div>
    </div>
  )
}
