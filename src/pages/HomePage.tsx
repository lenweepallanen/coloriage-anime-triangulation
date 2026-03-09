import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getAllProjects, createProject, deleteProject } from '../db/projectsStore'
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
    const all = await getAllProjects()
    setProjects(all.sort((a, b) => b.createdAt - a.createdAt))
    setLoading(false)
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    const project = await createProject(name)
    setNewName('')
    navigate(`/admin/${project.id}`)
  }

  async function handleDelete(id: string) {
    await deleteProject(id)
    await loadProjects()
  }

  if (loading) return <div className="loading">Chargement...</div>

  return (
    <div className="home-page">
      <section className="create-project">
        <h2>Nouveau projet</h2>
        <div className="create-form">
          <input
            type="text"
            placeholder="Nom du projet"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <button onClick={handleCreate} disabled={!newName.trim()}>
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
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function ProjectCard({ project, onDelete }: { project: Project; onDelete: () => void }) {
  const navigate = useNavigate()
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  useEffect(() => {
    if (project.originalImageBlob) {
      const url = URL.createObjectURL(project.originalImageBlob)
      setThumbUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [project.originalImageBlob])

  return (
    <div className="project-card">
      <div className="project-thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt={project.name} />
        ) : (
          <div className="no-thumb">Pas d'image</div>
        )}
      </div>
      <div className="project-info">
        <h3>{project.name}</h3>
        <span className="project-date">
          {new Date(project.createdAt).toLocaleDateString('fr-FR')}
        </span>
      </div>
      <div className="project-actions">
        <button onClick={() => navigate(`/admin/${project.id}`)}>Admin</button>
        <button onClick={() => navigate(`/scan/${project.id}`)}>Colorier</button>
        <button className="btn-danger" onClick={onDelete}>Supprimer</button>
      </div>
    </div>
  )
}
