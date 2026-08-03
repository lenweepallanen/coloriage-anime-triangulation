import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getBook, getPublishedBooks, getBookCover } from '@shared/db/booksStore'
import { getProjectsByBook, getProjectThumbnailBlob, getProjectThumbnail } from '@shared/db/projectsStore'
import type { Book, Project } from '@shared/types/project'
import { useI18n } from '../i18n'
import { removeBook } from '../utils/bookDownload'
import LoadingScreen from '../components/LoadingScreen'

/** Préfixe https:// si l'URL n'a pas de schéma (ex. "amazon.com" → "https://amazon.com"). */
function normalizeUrl(u: string): string {
  const s = (u || '').trim()
  if (!s) return 'https://amazon.com'
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

export default function BookPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const { t } = useI18n()
  const [book, setBook] = useState<Book | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [otherBooks, setOtherBooks] = useState<Book[]>([])
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [bonusImgUrl, setBonusImgUrl] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
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
        if (b.coverImageBlob) {
          setCoverUrl(prev => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(b.coverImageBlob!) })
        }
        if (b.bonusImageBlob) {
          revokeBonus = URL.createObjectURL(b.bonusImageBlob)
          setBonusImgUrl(revokeBonus)
        }
        const ps = await getProjectsByBook(bookId, true)
        setProjects(ps)
      } catch (err) {
        console.error(err)
        setNotAvailable(true)
      } finally {
        // Le livre + ses coloriages sont prêts → on affiche TOUT DE SUITE. La liste
        // « même collection » (sous le fold) ne doit pas retarder l'affichage.
        setLoading(false)
      }
      // Chargement « même collection » vraiment non-bloquant : démarré après que la
      // page est rendue, un échec ne masque pas le livre courant.
      try {
        const all = await getPublishedBooks()
        setOtherBooks(all.filter(x => x.id !== bookId))
      } catch (err) {
        console.error('Collection load failed', err)
      }
    })()
    return () => { if (revokeBonus) URL.revokeObjectURL(revokeBonus) }
  }, [bookId])

  if (loading) return <LoadingScreen />
  if (notAvailable || !book) {
    return (
      <div className="play-panel">
        <div className="paper-card">
          <h1 className="book-title">{t('book.unavailable.title')}</h1>
          <p>{t('book.unavailable.text')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="book-page">
      <button className="book-home-btn" onClick={() => navigate('/')}>
        ← {t('book.back')}
      </button>
      {coverUrl && (
        <img className="book-cover-hero" src={coverUrl} alt="" aria-hidden="true" />
      )}
      <h1 className="book-title">{book.name}</h1>
      <p className="book-subtitle">
        {projects.length} {projects.length > 1 ? t('book.countPlural') : t('book.countSingle')}
      </p>
      {projects.length === 0 ? (
        <p className="book-empty">{t('book.empty')}</p>
      ) : (
        <div className="colo-list">
          {projects.map((p, i) => (
            <ColoCard
              key={p.id}
              project={p}
              index={i + 1}
              onClick={() => navigate(`/p/${p.id}?book=${book.id}`)}
            />
          ))}
        </div>
      )}

      {bonusImgUrl && (
        <div className="book-bonus-card">
          <span className="book-bonus-badge">✦ {t('book.bonusBadge')}</span>
          <div className="book-bonus-inner">
          <div className="book-bonus-body">
            <img className="book-bonus-img" src={bonusImgUrl} alt="" aria-hidden="true" />
            <div className="book-bonus-texts">
              <strong className="book-bonus-title">{t('book.bonusTitle')}</strong>
              <p className="book-bonus-text">{t('book.bonusText')}</p>
              <button
                className="book-bonus-btn"
                onClick={() => window.open(normalizeUrl(book.bonusUrl), '_blank', 'noopener')}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 4v10" />
                  <path d="m8 10.5 4 4 4-4" />
                  <path d="M5 19h14" />
                </svg>
                {t('book.bonus')}
              </button>
            </div>
          </div>
          </div>
        </div>
      )}

      <div className="book-remove-row">
        <button
          className="book-remove-btn"
          onClick={() => setConfirmRemove(true)}
        >
          {t('book.remove')}
        </button>
      </div>

      {otherBooks.length > 0 && (
        <>
          <h2 className="book-collection-title">{t('book.collection')}</h2>
          <div className="book-collection-grid">
            {otherBooks.map(b => (
              <CollectionCard key={b.id} book={b} />
            ))}
          </div>
        </>
      )}

      {confirmRemove && (
        <div className="scanner-confirm-backdrop" onClick={() => setConfirmRemove(false)}>
          <div className="scanner-confirm soft-card" onClick={e => e.stopPropagation()}>
            <p className="scanner-confirm-q">{t('book.removeConfirm')}</p>
            <div className="scanner-confirm-actions">
              <button
                className="soft-btn"
                onClick={() => {
                  removeBook(book.id)
                  navigate('/')
                }}
              >
                {t('common.yes')}
              </button>
              <button className="soft-btn soft-btn--ghost" onClick={() => setConfirmRemove(false)}>
                {t('common.no')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

function CollectionCard({ book }: { book: Book }) {
  const navigate = useNavigate()
  // null = en cours de chargement, '' = pas de couverture (carte masquée)
  const [url, setUrl] = useState<string | null>(null)
  // Lazy-load : la section « collection » est sous le fold. On ne télécharge la
  // couverture (image pleine taille) qu'une fois la carte visible à l'écran.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const el = wrapRef.current
    if (!el || visible) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setVisible(true)
        io.disconnect()
      }
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
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
  }, [book.id, visible])

  // Tant qu'on n'a pas tenté le chargement, on garde un placeholder observable (sinon
  // l'IntersectionObserver n'a rien à observer). '' = pas de couverture → masqué.
  if (url === '') return null
  if (url === null) return <div ref={wrapRef} className="collection-card collection-card--placeholder" aria-hidden="true" />

  return (
    <div className="collection-card">
      <div className="collection-card-cover">
        <img src={url} alt={book.name} />
      </div>
      <div className="collection-card-side">
        <span className="collection-card-name">{book.name}</span>
        <button
          className="collection-add-btn"
          aria-label={book.name}
          onClick={() => navigate('/scanner?mode=livre')}
        >
          +
        </button>
        <button
          className="collection-amazon-btn"
          onClick={() => window.open(normalizeUrl(book.amazonUrl), '_blank', 'noopener')}
        >
          <span className="collection-amazon-word">amazon</span>
          <svg className="collection-amazon-smile" viewBox="0 0 60 14" aria-hidden="true">
            <path d="M2 3 C 18 13, 42 13, 55 5" fill="none" stroke="#ff9900" strokeWidth="3" strokeLinecap="round" />
            <path d="M55 5 l -6 -1.5 M55 5 l -2.5 5" fill="none" stroke="#ff9900" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function ColoCard({ project, index, onClick }: { project: Project; index: number; onClick: () => void }) {
  const { t, lang } = useI18n()
  const [url, setUrl] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  const [scannedAt, setScannedAt] = useState<number | null>(null)

  useEffect(() => {
    try {
      setScanned(localStorage.getItem(`scanned:${project.id}`) === '1')
      const at = Number(localStorage.getItem(`scannedAt:${project.id}`) ?? 0)
      setScannedAt(at > 0 ? at : null)
    } catch { /* ignore */ }
    let revoke: string | null = null
    ;(async () => {
      let blob: Blob | null = null
      if (project.hasThumbnail) blob = await getProjectThumbnailBlob(project.id)
      if (!blob) blob = await getProjectThumbnail(project.id)
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
      className={`colo-card ${scanned ? 'colo-card--scanned' : ''}`}
    >
      <div className="colo-card-thumb">
        {url ? <img src={url} alt={project.name} /> : <span aria-hidden="true">🖍️</span>}
      </div>
      <div className="colo-card-texts">
        <strong className="colo-card-name">{index}. {project.name}</strong>
        <span className="colo-card-status">
          {scanned ? t('book.scanned') : t('book.notScanned')}
        </span>
        {scanned && scannedAt && (
          <span className="colo-card-date">
            {t('book.on')} {new Date(scannedAt).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB')}
          </span>
        )}
      </div>
      {scanned ? (
        <span className="colo-card-badge colo-card-badge--done" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
      ) : (
        <span className="colo-card-badge colo-card-badge--todo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
            <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
            <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
            <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
            <circle cx="12" cy="12" r="2.6" />
          </svg>
        </span>
      )}
    </div>
  )
}

