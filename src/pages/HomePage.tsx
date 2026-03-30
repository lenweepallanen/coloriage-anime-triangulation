import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllProjects, createProject, deleteProject, duplicateProject, getProjectThumbnail } from '../db/projectsStore'
import type { Project } from '../types/project'

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [newName, setNewName] = useState('')
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    loadProjects()
  }, [])

  async function loadProjects() {
    setLoading(true)
    try {
      const all = await getAllProjects()
      setProjects(all.sort((a, b) => b.createdAt - a.createdAt))
    } catch (err) {
      console.error('Failed to load projects:', err)
      alert('Erreur chargement : ' + (err instanceof Error ? err.message : err))
    }
    setLoading(false)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    try {
      const project = await createProject(name)
      setNewName('')
      navigate(`/admin/${project.id}`)
    } catch (err) {
      console.error('Failed to create project:', err)
      alert('Erreur création : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Supprimer ce projet ?')) return
    try {
      await deleteProject(id)
      await loadProjects()
    } catch (err) {
      console.error('Failed to delete project:', err)
      alert('Erreur suppression : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleDuplicate(id: string) {
    try {
      await duplicateProject(id)
      await loadProjects()
    } catch (err) {
      console.error('Failed to duplicate project:', err)
      alert('Erreur duplication : ' + (err instanceof Error ? err.message : err))
    }
  }

  if (loading) return <div className="loading">Chargement...</div>

  return (
    <div className="home-page">
      <section className="create-project-section">
        <div className="create-form">
          <input
            type="text"
            placeholder="Nom du nouveau projet..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <button className="btn-primary" onClick={handleCreate} disabled={!newName.trim()}>
            Créer
          </button>
        </div>
      </section>

      <section className="project-list">
        <h2>Projets existants</h2>
        {projects.length === 0 ? (
          <p className="empty-state">Aucun projet. Créez-en un ci-dessus.</p>
        ) : (
          <div className="project-grid">
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                onDelete={() => handleDelete(project.id)}
                onDuplicate={() => handleDuplicate(project.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ProjectCard({ project, onDelete, onDuplicate }: { project: Project; onDelete: () => void; onDuplicate: () => void }) {
  const navigate = useNavigate()
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoke: string | null = null
    getProjectThumbnail(project.id).then(blob => {
      if (blob) {
        const url = URL.createObjectURL(blob)
        revoke = url
        setThumbUrl(url)
      }
    })
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [project.id])

  return (
    <div
      className="project-card"
      onClick={() => navigate(`/admin/${project.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && navigate(`/admin/${project.id}`)}
    >
      <div className="project-thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt={project.name} />
        ) : (
          <div className="no-thumb">Pas d'image</div>
        )}
      </div>
      <div className="project-info">
        <h3>{project.name}</h3>
        <div className="project-meta">
          <span className="project-date">
            {new Date(project.createdAt).toLocaleDateString('fr-FR')}
          </span>
          {project.animations.length > 0 && (
            <span className="project-anim-count">
              {project.animations.length} anim{project.animations.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      <div className="project-actions">
        <button className="btn-icon" onClick={e => { e.stopPropagation(); onDuplicate() }} title="Dupliquer">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button className="btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/admin/${project.id}`) }}>
          Editer
        </button>
        <button className="btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/scan/${project.id}`) }}>
          Colorier
        </button>
        <button className="btn-icon btn-sm" onClick={e => { e.stopPropagation(); onDelete() }} title="Supprimer" style={{ color: 'var(--color-danger)' }}>
          ✕
        </button>
      </div>
    </div>
  )
}
