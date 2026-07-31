import { useEffect, useState } from 'react'
import { useParams, Navigate, Outlet, NavLink, Link, useOutletContext } from 'react-router-dom'
import { useProject } from '../../hooks/useProject'
import { animationHasFrames, type Project } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { getBook } from '../../db/booksStore'

export interface AdminContext {
  project: Project
  save: (updated: Project, hints?: UploadHint[]) => Promise<void>
  /** Mise à jour locale de l'état projet (sans persistance — cf. useProject.patchLocal). */
  patchLocal: (partial: Partial<Project>) => void
  canPreview: boolean
  canEditScene: boolean
}

export function useAdminContext() {
  return useOutletContext<AdminContext>()
}

export default function AdminLayout() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading, save, patchLocal } = useProject(projectId!)

  if (loading) return <div className="loading">Chargement du projet...</div>
  if (!project) return <Navigate to="/" replace />

  // Activé dès qu'une animation a des frames calculées (peu importe son type / playback mode).
  const canPreview = project.animations.some(animationHasFrames)
  const canEditScene = canPreview

  const context: AdminContext = { project, save, patchLocal, canPreview, canEditScene }

  return (
    <div className="admin-layout">
      <div className="admin-layout-header">
        <div className="admin-layout-header-left">
          <Breadcrumb project={project} />
        </div>
        <div className="admin-layout-header-right">
          <Link
            to={canPreview ? `/scan/${project.id}` : '#'}
            className={`admin-scanner-btn ${!canPreview ? 'admin-scanner-btn--disabled' : ''}`}
            onClick={e => { if (!canPreview) e.preventDefault() }}
            title={canPreview ? 'Scanner le coloriage' : 'Complétez au moins une animation pour scanner'}
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
        <NavLink to="eyes" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Yeux
        </NavLink>
        <NavLink to="mouth" className={({ isActive }) => `admin-nav-tab ${isActive ? 'admin-nav-tab--active' : ''}`}>
          Bouche
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

function Breadcrumb({ project }: { project: Project }) {
  const [bookName, setBookName] = useState<string | null>(null)
  useEffect(() => {
    if (!project.bookId) { setBookName(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const b = await getBook(project.bookId!)
        if (!cancelled) setBookName(b?.name ?? 'Livre')
      } catch { if (!cancelled) setBookName('Livre') }
    })()
    return () => { cancelled = true }
  }, [project.bookId])

  return (
    <nav aria-label="Fil d'Ariane" className="admin-breadcrumb">
      <Link to="/" className="admin-breadcrumb-link" title="Menu principal">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 11l9-8 9 8" />
          <path d="M5 10v10h14V10" />
        </svg>
      </Link>
      {project.bookId && (
        <>
          <span className="admin-breadcrumb-sep">›</span>
          <Link to={`/books/${project.bookId}`} className="admin-breadcrumb-link">
            {bookName ?? 'Livre'}
          </Link>
        </>
      )}
      <span className="admin-breadcrumb-sep">›</span>
      <Link to={`/admin/${project.id}`} className="admin-breadcrumb-current">
        {project.name}
      </Link>
    </nav>
  )
}
