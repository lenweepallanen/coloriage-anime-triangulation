import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getBook, getPublishedBooks, getBookCover } from '@shared/db/booksStore'
import { getProjectsByBook, getProjectThumbnailBlob, getProjectThumbnail } from '@shared/db/projectsStore'
import type { Book, Project } from '@shared/types/project'

/** Préfixe https:// si l'URL n'a pas de schéma (ex. "amazon.com" → "https://amazon.com"). */
function normalizeUrl(u: string): string {
  const s = (u || '').trim()
  if (!s) return 'https://amazon.com'
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const [book, setBook] = useState<Book | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [otherBooks, setOtherBooks] = useState<Book[]>([])
  const [bonusImgUrl, setBonusImgUrl] = useState<string | null>(null)
  const [showBonus, setShowBonus] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notAvailable, setNotAvailable] = useState(false)

  useEffect(() => {
    if (!bookId) return
    let revokeBonus: string | null = null
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
        if (b.bonusImageBlob) {
          revokeBonus = URL.createObjectURL(b.bonusImageBlob)
          setBonusImgUrl(revokeBonus)
        }
        const ps = await getProjectsByBook(bookId, true)
        setProjects(ps)
      } catch (err) {
        console.error(err)
        setNotAvailable(true)
      }
      // Chargement « même collection » non-bloquant : un échec ne doit pas
      // masquer le livre courant.
      try {
        const all = await getPublishedBooks()
        setOtherBooks(all.filter(x => x.id !== bookId))
      } catch (err) {
        console.error('Collection load failed', err)
      }
      setLoading(false)
    })()
    return () => { if (revokeBonus) URL.revokeObjectURL(revokeBonus) }
  }, [bookId])

  // Le sticky footer bonus n'apparaît qu'après ~1/3 du scroll (moins « pushy »).
  // On attend la fin du chargement (page réellement haute) avant de calculer,
  // sinon au montage la page courte déclencherait le fallback et l'afficherait
  // tout de suite. Fallback : page non scrollable → affichage direct.
  useEffect(() => {
    if (!bonusImgUrl || loading) return
    const onScroll = () => {
      const el = document.documentElement
      const scrollable = el.scrollHeight - el.clientHeight
      if (scrollable <= 40) { setShowBonus(true); return }
      setShowBonus(el.scrollTop / scrollable >= 1 / 3)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [bonusImgUrl, loading, projects.length, otherBooks.length])

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
      <p className="book-subtitle">Clique sur l'un des coloriages pour le scanner et le voir s'animer !</p>
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

      {otherBooks.length > 0 && (
        <>
          <hr className="book-collection-sep" />
          <h2 className="book-collection-title">Dans la même collection</h2>
          <div className="book-collection-grid">
            {otherBooks.map(b => (
              <BookCover key={b.id} book={b} />
            ))}
          </div>
        </>
      )}

      {bonusImgUrl && (
        <div className={`book-bonus-footer ${showBonus ? 'book-bonus-footer--visible' : ''}`}>
          <div className="book-bonus-left">
            <img className="book-bonus-vignette" src={bonusImgUrl} alt="Bonus" />
          </div>
          <div className="book-bonus-right">
            <button
              className="book-bonus-btn"
              onClick={() => window.open(normalizeUrl(book.bonusUrl), '_blank', 'noopener')}
            >
              TÉLÉCHARGER BONUS
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function BookCover({ book }: { book: Book }) {
  // null = en cours de chargement, '' = pas de couverture (vignette masquée)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoke: string | null = null
    ;(async () => {
      const blob = await getBookCover(book.id)
      if (blob) {
        const u = URL.createObjectURL(blob)
        revoke = u
        setUrl(u)
      } else {
        setUrl('')
      }
    })()
    return () => { if (revoke) URL.revokeObjectURL(revoke) }
  }, [book.id])

  // Vignette = couverture : on n'affiche pas les livres sans couverture
  if (url === null || url === '') return null

  const open = () => window.open(normalizeUrl(book.amazonUrl), '_blank', 'noopener')

  return (
    <div
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && open()}
      className="vignette"
    >
      <div className="vignette-thumb">
        <img src={url} alt={book.name} />
      </div>
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
