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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Livre indisponible</h1>
        <p style={{ maxWidth: 480, color: '#555' }}>Ce livre n'existe pas ou n'est pas publié.</p>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ textAlign: 'center', margin: '12px 0 24px' }}>{book.name}</h1>
      {projects.length === 0 ? (
        <p style={{ textAlign: 'center', color: '#666' }}>Aucun coloriage disponible dans ce livre pour le moment.</p>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 16,
          maxWidth: 1200,
          margin: '0 auto',
        }}>
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
      style={{
        cursor: 'pointer',
        background: '#fff',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'transform 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.transform = 'scale(1.03)')}
      onMouseLeave={e => (e.currentTarget.style.transform = 'scale(1)')}
    >
      <div style={{
        aspectRatio: '1 / 1',
        background: '#f0f0f0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}>
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          filter: scanned ? 'none' : 'grayscale(1)',
          opacity: scanned ? 1 : 0.6,
        }}>
          {url ? <img src={url} alt={project.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span style={{ color: '#aaa' }}>—</span>}
        </div>
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}>
          <svg viewBox="0 0 64 64" width="22%" height="22%" style={{ opacity: 0.55, filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))' }} aria-hidden="true">
            <circle cx="32" cy="32" r="30" fill="rgba(255,255,255,0.85)" />
            <polygon points="26,20 26,44 46,32" fill="#222" />
          </svg>
        </div>
      </div>
      <div style={{ padding: '8px 12px', fontSize: 14, textAlign: 'center', color: '#000' }}>{project.name}</div>
    </div>
  )
}
