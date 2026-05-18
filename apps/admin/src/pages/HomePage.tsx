import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { getAllProjects, createProject, deleteProject, duplicateProject, getProjectThumbnail, setProjectBook } from '../db/projectsStore'
import { createBook, getAllBooks, getBookCover, deleteBook } from '../db/booksStore'
import { duplicateProjectIntoBook } from '../db/booksStore'
import type { Project, Book } from '../types/project'

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [books, setBooks] = useState<Book[]>([])
  const [newProjectName, setNewProjectName] = useState('')
  const [newBookName, setNewBookName] = useState('')
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    loadAll()
  }, [])

  async function loadAll() {
    setLoading(true)
    try {
      const [allBooks, allProjects] = await Promise.all([getAllBooks(), getAllProjects()])
      setBooks(allBooks.sort((a, b) => b.createdAt - a.createdAt))
      setProjects(allProjects.sort((a, b) => b.createdAt - a.createdAt))
    } catch (err) {
      console.error('Failed to load:', err)
      alert('Erreur chargement : ' + (err instanceof Error ? err.message : err))
    }
    setLoading(false)
  }

  async function handleCreateProject() {
    const name = newProjectName.trim()
    if (!name) return
    try {
      const project = await createProject(name)
      setNewProjectName('')
      navigate(`/admin/${project.id}`)
    } catch (err) {
      alert('Erreur création projet : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleCreateBook() {
    const name = newBookName.trim()
    if (!name) return
    try {
      const book = await createBook(name)
      setNewBookName('')
      navigate(`/books/${book.id}`)
    } catch (err) {
      alert('Erreur création livre : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Supprimer ce projet ?')) return
    try {
      await deleteProject(id)
      await loadAll()
    } catch (err) {
      alert('Erreur suppression : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleDuplicate(id: string) {
    try {
      await duplicateProject(id)
      await loadAll()
    } catch (err) {
      alert('Erreur duplication : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleDeleteBook(id: string, name: string) {
    if (!confirm(`Supprimer le livre "${name}" ?\nLes coloriages contenus seront détachés (envoyés dans "Coloriages sans livre"), pas supprimés.`)) return
    try {
      await deleteBook(id)
      await loadAll()
    } catch (err) {
      alert('Erreur suppression livre : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleMoveToBook(projectId: string, bookId: string | null) {
    try {
      await setProjectBook(projectId, bookId)
      await loadAll()
    } catch (err) {
      alert('Erreur déplacement : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleDuplicateToBook(projectId: string, bookId: string | null) {
    try {
      await duplicateProjectIntoBook(projectId, bookId)
      await loadAll()
    } catch (err) {
      alert('Erreur duplication : ' + (err instanceof Error ? err.message : err))
    }
  }

  if (loading) return <div className="loading">Chargement...</div>

  const unbookedProjects = projects.filter(p => !p.bookId)
  const projectCountByBook: Record<string, number> = {}
  for (const p of projects) {
    if (p.bookId) projectCountByBook[p.bookId] = (projectCountByBook[p.bookId] ?? 0) + 1
  }

  return (
    <div className="home-page">
      <section className="create-project-section">
        <div className="create-form">
          <input
            type="text"
            placeholder="Nom du nouveau livre..."
            value={newBookName}
            onChange={e => setNewBookName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateBook()}
          />
          <button className="btn-primary" onClick={handleCreateBook} disabled={!newBookName.trim()}>
            Créer un livre
          </button>
        </div>
        <div className="create-form" style={{ marginTop: 'var(--space-3)' }}>
          <input
            type="text"
            placeholder="Nom du nouveau coloriage..."
            value={newProjectName}
            onChange={e => setNewProjectName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
          />
          <button className="btn-secondary" onClick={handleCreateProject} disabled={!newProjectName.trim()}>
            Créer un coloriage
          </button>
        </div>
      </section>

      <section className="project-list">
        <h2>Livres</h2>
        {books.length === 0 ? (
          <p className="empty-state">Aucun livre. Créez-en un ci-dessus.</p>
        ) : (
          <div className="project-grid">
            {books.map(book => (
              <BookCard
                key={book.id}
                book={book}
                projectCount={projectCountByBook[book.id] ?? 0}
                onDelete={() => handleDeleteBook(book.id, book.name)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="project-list" style={{ marginTop: 'var(--space-6)' }}>
        <h2>Coloriages sans livre</h2>
        {unbookedProjects.length === 0 ? (
          <p className="empty-state">Tous les coloriages sont rangés dans un livre.</p>
        ) : (
          <div className="project-grid">
            {unbookedProjects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                books={books}
                onDelete={() => handleDelete(project.id)}
                onDuplicate={() => handleDuplicate(project.id)}
                onMoveToBook={bookId => handleMoveToBook(project.id, bookId)}
                onDuplicateToBook={bookId => handleDuplicateToBook(project.id, bookId)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function BookCard({ book, projectCount, onDelete }: { book: Book; projectCount: number; onDelete: () => void }) {
  const navigate = useNavigate()
  const [coverUrl, setCoverUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoke: string | null = null
    getBookCover(book.id).then(blob => {
      if (blob) {
        const url = URL.createObjectURL(blob)
        revoke = url
        setCoverUrl(url)
      }
    })
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [book.id])

  return (
    <div
      className="project-card"
      onClick={() => navigate(`/books/${book.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && navigate(`/books/${book.id}`)}
    >
      <div className="project-thumb">
        {coverUrl ? (
          <img src={coverUrl} alt={book.name} />
        ) : (
          <div className="no-thumb">📚</div>
        )}
      </div>
      <div className="project-info">
        <h3>{book.name}</h3>
        <div className="project-meta">
          <span className="project-anim-count">
            {projectCount} coloriage{projectCount > 1 ? 's' : ''}
          </span>
          {book.published && (
            <span className="project-anim-count" style={{ color: 'var(--color-success, green)' }}>
              publié
            </span>
          )}
        </div>
      </div>
      <div className="project-actions">
        <button
          className="btn-icon btn-sm"
          onClick={e => { e.stopPropagation(); onDelete() }}
          title="Supprimer le livre"
          style={{ color: 'var(--color-danger)' }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  books,
  onDelete,
  onDuplicate,
  onMoveToBook,
  onDuplicateToBook,
}: {
  project: Project
  books: Book[]
  onDelete: () => void
  onDuplicate: () => void
  onMoveToBook: (bookId: string | null) => void
  onDuplicateToBook: (bookId: string | null) => void
}) {
  const navigate = useNavigate()
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

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

  useEffect(() => {
    if (!menuOpen) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

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
        <button
          className="btn-icon"
          onClick={e => { e.stopPropagation(); setMenuOpen(true) }}
          title="Plus d'actions"
        >
          ⋯
        </button>
        {menuOpen && createPortal(
          <div
            onClick={e => { e.stopPropagation(); setMenuOpen(false) }}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 9999,
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: '#1c1f26', color: '#e6e6e6',
                border: '1px solid #2d3340', borderRadius: 12,
                padding: 20, minWidth: 320, maxHeight: '80vh', overflowY: 'auto',
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong>{project.name}</strong>
                <button className="btn-icon btn-sm" onClick={() => setMenuOpen(false)}>✕</button>
              </div>

              <div style={{ fontSize: 12, color: '#9aa3b2', margin: '12px 0 4px' }}>Déplacer vers…</div>
              {books.length === 0 && (
                <div style={{ fontSize: 12, color: '#6b7280', padding: '4px 8px' }}>Aucun livre disponible.</div>
              )}
              {books.map(b => (
                <button
                  key={b.id}
                  className="btn-ghost"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' }}
                  onClick={() => { setMenuOpen(false); onMoveToBook(b.id) }}
                >
                  📚 {b.name}
                </button>
              ))}
              {project.bookId && (
                <button
                  className="btn-ghost"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' }}
                  onClick={() => { setMenuOpen(false); onMoveToBook(null) }}
                >
                  ⨯ Retirer du livre
                </button>
              )}

              <div style={{ fontSize: 12, color: '#9aa3b2', margin: '16px 0 4px' }}>Dupliquer vers…</div>
              {books.map(b => (
                <button
                  key={`dup-${b.id}`}
                  className="btn-ghost"
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' }}
                  onClick={() => { setMenuOpen(false); onDuplicateToBook(b.id) }}
                >
                  📚 {b.name}
                </button>
              ))}
              <button
                className="btn-ghost"
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' }}
                onClick={() => { setMenuOpen(false); onDuplicateToBook(null) }}
              >
                (hors livre)
              </button>
            </div>
          </div>,
          document.body
        )}
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
