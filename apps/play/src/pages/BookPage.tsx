import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getBook } from '@shared/db/booksStore'
import { getProjectsByBook, getProjectThumbnailBlob, getProjectThumbnail } from '@shared/db/projectsStore'
import type { Book, Project } from '@shared/types/project'

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [book, setBook] = useState<Book | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [notAvailable, setNotAvailable] = useState(false)

  useEffect(() => {
    if (!bookId) return
    ;(async () => {
      setLoading(true)
      try {
        const b = await getBook(bookId)
        if (!b || b.published !== true) {
          setNotAvailable(true)
          setLoading(false)
          return
        }
        setBook(b)
        const ps = await getProjectsByBook(bookId, true)
        setProjects(ps)
      } catch (err) {
        console.error(err)
        setNotAvailable(true)
      }
      setLoading(false)
    })()
  }, [bookId])

  if (loading) return <div className="loading">Chargement…</div>
  if (notAvailable || !book) {
    return (
      <div className="play-panel">
        <div className="paper-card">
          <h1>Livre indisponible</h1>
          <p>Ce livre n'existe pas ou n'est pas publié.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="book-page">
      <h1 className="book-title">{book.name}</h1>
      {projects.length === 0 ? (
        <p className="book-empty">Aucun coloriage disponible dans ce livre pour le moment.</p>
      ) : (
        <div className="book-grid">
          {projects.map(p => (
            <Vignette
              key={p.id}
              project={p}
              onClick={() => navigate(`/p/${p.id}?book=${book.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function Vignette({ project, onClick }: { project: Project; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)

  useEffect(() => {
    try { setScanned(localStorage.getItem(`scanned:${project.id}`) === '1') } catch { /* ignore */ }
    let revoke: string | null = null
    ;(async () => {
      // Priorité à la vignette dédiée, sinon fallback sur l'image coloriage
      const blob = (await getProjectThumbnailBlob(project.id)) ?? (await getProjectThumbnail(project.id))
      if (blob) {
        const u = URL.createObjectURL(blob)
        revoke = u
        setUrl(u)
      }
    })()
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [project.id])

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      className={`vignette ${scanned ? 'vignette--scanned' : 'vignette--unscanned'}`}
    >
      {scanned && <span className="vignette-badge" aria-label="Déjà scanné">⭐</span>}
      <div className="vignette-thumb">
        {url ? <img src={url} alt={project.name} /> : <span style={{ color: '#bbb' }}>—</span>}
        {!scanned && (
          <div className="vignette-play" aria-hidden="true">
            <span>▶</span>
          </div>
        )}
      </div>
      <div className="vignette-name">{project.name}</div>
    </div>
  )
}
