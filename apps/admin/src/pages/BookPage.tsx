import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getBook, updateBook, deleteBook } from '../db/booksStore'
import { getProjectsByBook, getProjectThumbnail, setProjectBook } from '../db/projectsStore'
import { buildBookPlayUrl, buildBookPlayUrlLocal, setBookPublished } from '../db/publishProject'
import type { Book, Project } from '../types/project'

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [book, setBook] = useState<Book | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bookId) return
    load()
  }, [bookId])

  async function load() {
    if (!bookId) return
    setLoading(true)
    try {
      const [b, ps] = await Promise.all([getBook(bookId), getProjectsByBook(bookId)])
      if (!b) {
        alert('Livre introuvable')
        navigate('/')
        return
      }
      setBook(b)
      setName(b.name)
      setProjects(ps)
      if (b.coverImageBlob) setCoverUrl(URL.createObjectURL(b.coverImageBlob))
    } catch (err) {
      alert('Erreur chargement : ' + (err instanceof Error ? err.message : err))
    }
    setLoading(false)
  }

  async function handleRename() {
    if (!book) return
    const next = name.trim()
    if (!next || next === book.name) return
    try {
      await updateBook({ ...book, name: next })
      setBook({ ...book, name: next })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleCoverUpload(file: File) {
    if (!book) return
    try {
      const next = { ...book, coverImageBlob: file }
      await updateBook(next, ['cover'])
      setBook(next)
      if (coverUrl) URL.revokeObjectURL(coverUrl)
      setCoverUrl(URL.createObjectURL(file))
    } catch (err) {
      alert('Erreur upload cover : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleTogglePublish() {
    if (!book || busy) return
    setBusy(true)
    try {
      const next = !book.published
      await setBookPublished(book.id, next)
      setBook({ ...book, published: next, publishedAt: next ? Date.now() : book.publishedAt })
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  async function handleCopyUrl() {
    if (!book) return
    try {
      await navigator.clipboard.writeText(buildBookPlayUrl(book.id))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* ignore */ }
  }

  async function handleDelete() {
    if (!book) return
    if (!confirm(`Supprimer le livre "${book.name}" ? Les coloriages seront détachés (pas supprimés).`)) return
    try {
      await deleteBook(book.id)
      navigate('/')
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  async function handleRemoveProject(projectId: string) {
    if (!confirm('Retirer ce coloriage du livre ?')) return
    try {
      await setProjectBook(projectId, null)
      setProjects(prev => prev.filter(p => p.id !== projectId))
    } catch (err) {
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
  }

  if (loading || !book) return <div className="loading">Chargement...</div>

  const url = buildBookPlayUrl(book.id)
  const localUrl = buildBookPlayUrlLocal(book.id)

  return (
    <div className="home-page">
      <section className="create-project-section">
        <button className="btn-ghost" onClick={() => navigate('/')}>← Retour</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            style={{ fontSize: 'var(--text-2xl, 24px)', fontWeight: 600 }}
          />
          <button className="btn-icon btn-sm" onClick={handleDelete} title="Supprimer" style={{ color: 'var(--color-danger)' }}>
            ✕
          </button>
        </div>
      </section>

      <section className="create-project-section">
        <h3>Couverture du livre</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {coverUrl ? (
            <img src={coverUrl} alt="cover" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }} />
          ) : (
            <div style={{ width: 120, height: 120, background: '#f0f0f0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>📚</div>
          )}
          <label className="btn-secondary">
            {coverUrl ? 'Remplacer' : 'Importer'}
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleCoverUpload(f) }}
            />
          </label>
        </div>
      </section>

      <section className="create-project-section">
        <h3>Publication</h3>
        <div style={{
          border: '1px solid var(--color-border, #e0e0e0)',
          borderRadius: 8,
          padding: 16,
          background: book.published ? '#e8f5e9' : '#fff8e1',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong>{book.published ? '✓ Publié' : '⚠ Non publié'}</strong>
            <button onClick={handleTogglePublish} disabled={busy} className="btn-secondary">
              {busy ? '…' : book.published ? 'Dépublier' : 'Publier'}
            </button>
          </div>
          {book.published && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Lien USER du livre (prod) :</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '6px 10px', background: '#fff', borderRadius: 4, fontSize: 13, overflow: 'auto' }}>
                  {url}
                </code>
                <button onClick={handleCopyUrl} className="btn-sm btn-secondary">
                  {copied ? 'Copié !' : 'Copier'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: '#666', margin: '12px 0 4px' }}>Aperçu local (dev) :</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '6px 10px', background: '#fff', borderRadius: 4, fontSize: 13, overflow: 'auto' }}>
                  {localUrl}
                </code>
                <a href={localUrl} target="_blank" rel="noreferrer" className="btn-sm btn-secondary">
                  Ouvrir
                </a>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="project-list">
        <h2>Coloriages dans ce livre ({projects.length})</h2>
        {projects.length === 0 ? (
          <p className="empty-state">Aucun coloriage dans ce livre. Depuis la page d'accueil, utilisez le menu "⋯" d'un coloriage pour le déplacer ici.</p>
        ) : (
          <div className="project-grid">
            {projects.map(p => (
              <BookProjectCard
                key={p.id}
                project={p}
                onRemove={() => handleRemoveProject(p.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function BookProjectCard({ project, onRemove }: { project: Project; onRemove: () => void }) {
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
    >
      <div className="project-thumb">
        {thumbUrl ? <img src={thumbUrl} alt={project.name} /> : <div className="no-thumb">Pas d'image</div>}
      </div>
      <div className="project-info">
        <h3>{project.name}</h3>
        <div className="project-meta">
          <span className="project-date">{new Date(project.createdAt).toLocaleDateString('fr-FR')}</span>
          {project.published && <span style={{ color: 'green', fontSize: 12 }}>publié</span>}
        </div>
      </div>
      <div className="project-actions">
        <button className="btn-secondary btn-sm" onClick={e => { e.stopPropagation(); navigate(`/admin/${project.id}`) }}>
          Editer
        </button>
        <button className="btn-icon btn-sm" onClick={e => { e.stopPropagation(); onRemove() }} title="Retirer du livre">
          ⨯
        </button>
      </div>
    </div>
  )
}
