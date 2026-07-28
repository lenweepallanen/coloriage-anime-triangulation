import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { getPublishedBooks, getBookCover } from '@shared/db/booksStore'
import type { Book } from '@shared/types/project'
import { isBookDownloaded, subscribeBookDownloads, getBookDownloadProgress } from '../utils/bookDownload'
import { useI18n } from '../i18n'
import logoUrl from '../assets/picopop-logo.png'

const WORDMARK = ['P', 'i', 'c', 'o', 'P', 'o', 'p']

/** Préfixe https:// si l'URL n'a pas de schéma (ex. "amazon.com"). */
function normalizeUrl(u: string): string {
  const s = (u || '').trim()
  if (!s) return 'https://amazon.com'
  return /^https?:\/\//i.test(s) ? s : `https://${s}`
}

/**
 * Cache module de l'accueil : le boot screen (logo + devise + 3 s) ne
 * s'affiche qu'au lancement de l'app. Les retours à l'accueil (onglet,
 * bouton retour) réaffichent instantanément les données déjà chargées,
 * avec un rafraîchissement silencieux en arrière-plan.
 */
let homeCache: { books: Book[]; covers: Record<string, string> } | null = null

/**
 * Écran d'accueil PLAY.
 *
 * - MES LIVRES : livres ajoutés (via scan du QR livre) + carte « + » qui
 *   ouvre le scanner en mode livre.
 * - LES AUTRES LIVRES : vitrine — un tap ouvre la page Amazon du livre.
 *   L'ajout d'un livre dans l'app passe UNIQUEMENT par le scan de son QR
 *   (preuve de possession du livre papier).
 */
export default function PlayHomePage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [books, setBooks] = useState<Book[]>(homeCache?.books ?? [])
  const [covers, setCovers] = useState<Record<string, string>>(homeCache?.covers ?? {})
  const [ready, setReady] = useState(homeCache !== null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Re-render quand la progression d'un téléchargement de livre change
  const [, setDownloadTick] = useState(0)
  useEffect(() => subscribeBookDownloads(() => setDownloadTick(v => v + 1)), [])
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(
    () => new Set((homeCache?.books ?? []).filter(isBookDownloaded).map(b => b.id)),
  )

  useEffect(() => {
    let cancelled = false
    // Premier chargement de la session : boot screen affiché au moins 3 s
    // (temps de lire la devise — branding). Ensuite : les données en cache
    // s'affichent immédiatement, rafraîchissement silencieux en arrière-plan.
    const isFirstLoad = homeCache === null
    const bootStart = Date.now()
    ;(async () => {
      if (isFirstLoad) setReady(false)
      setError(false)
      try {
        const bs = await getPublishedBooks()
        const map: Record<string, string> = { ...(homeCache?.covers ?? {}) }
        await Promise.all(
          bs.map(async b => {
            if (map[b.id]) return
            const blob = await getBookCover(b.id).catch(() => null)
            if (blob) map[b.id] = URL.createObjectURL(blob)
          }),
        )
        if (cancelled) return
        homeCache = { books: bs, covers: map }
        setCovers(map)
        setBooks(bs)
        setDownloadedIds(new Set(bs.filter(isBookDownloaded).map(b => b.id)))
        if (isFirstLoad) {
          const remaining = 3000 - (Date.now() - bootStart)
          if (remaining > 0) await new Promise(r => setTimeout(r, remaining))
        }
        if (!cancelled) setReady(true)
      } catch (err) {
        console.error('Chargement des livres impossible', err)
        if (!cancelled && homeCache === null) setError(true)
      }
    })()
    return () => { cancelled = true }
  }, [attempt])

  if (error) {
    return (
      <div className="home-page">
        <HomeHeader />
        <div className="home-status soft-card">
          <p>{t('home.error1')}<br />{t('home.error2')}</p>
          <button className="soft-btn" onClick={() => setAttempt(a => a + 1)}>
            {t('home.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (!ready) {
    // Portal : le boot screen couvre tout, y compris la barre d'onglets et le menu.
    return createPortal(
      <div className="boot-screen">
        <img className="boot-logo" src={logoUrl} alt="Picopop" />
        <Wordmark />
        <p className="boot-tagline">
          <span className="tagline-line1">{t('tagline.line1')}</span>
          <span className="tagline-line2">
            {t('tagline.line2.pre')}
            <em className="tagline-hl">{t('tagline.line2.hl')}</em>
            {t('tagline.line2.post')}
          </span>
        </p>
        <div className="boot-spinner" aria-label={t('loading')} />
      </div>,
      document.body,
    )
  }

  const myBooks = books.filter(b => downloadedIds.has(b.id))
  const otherBooks = books.filter(b => !downloadedIds.has(b.id))
  const firstTime = myBooks.length === 0

  const openShop = (book: Book) =>
    window.open(normalizeUrl(book.amazonUrl), '_blank', 'noopener')

  return (
    <div className="home-page">
      <HomeHeader />
      {books.length === 0 ? (
        <div className="home-status soft-card">
          <p>{t('home.empty1')}<br />{t('home.empty2')}</p>
        </div>
      ) : (
        <>
          <h2 className="section-title">
            {firstTime ? t('home.firstBook') : t('home.myBooks')}
          </h2>
          <div className="home-grid">
            {myBooks.map(b => (
              <BookCard
                key={b.id}
                book={b}
                coverUrl={covers[b.id] ?? null}
                variant="owned"
                progress={getBookDownloadProgress(b.id)}
                addingLabel={t('home.adding')}
                onClick={() => navigate(`/livre/${b.id}`)}
              />
            ))}
            <AddBookCard onClick={() => navigate('/scanner?mode=livre')} />
          </div>
          {otherBooks.length > 0 && (
            <>
              <h2 className="section-title section-title--other">{t('home.otherBooks')}</h2>
              <div className="home-grid">
                {otherBooks.map(b => (
                  <BookCard
                    key={b.id}
                    book={b}
                    coverUrl={covers[b.id] ?? null}
                    variant="shop"
                    shopLabel={t('home.discover')}
                    onClick={() => openShop(b)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function Wordmark() {
  return (
    <h1 className="wordmark" aria-label="PicoPop">
      {WORDMARK.map((c, i) => (
        <span key={i} aria-hidden="true">{c}</span>
      ))}
    </h1>
  )
}

function HomeHeader() {
  const { t } = useI18n()
  return (
    <header className="home-header">
      <img className="home-logo" src={logoUrl} alt="" aria-hidden="true" />
      <Wordmark />
      <p className="home-tagline">
        <span className="tagline-line1">{t('tagline.line1')}</span>
        <span className="tagline-line2">
          {t('tagline.line2.pre')}
          <em className="tagline-hl">{t('tagline.line2.hl')}</em>
          {t('tagline.line2.post')}
        </span>
      </p>
    </header>
  )
}

/** Carte « + » : ajouter un livre en scannant son QR code. */
function AddBookCard({ onClick }: { onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      className="book-card add-card"
    >
      <span className="add-card-plus" aria-hidden="true">+</span>
    </div>
  )
}

function BookCard({ book, coverUrl, variant, shopLabel, progress, addingLabel, onClick }: {
  book: Book
  coverUrl: string | null
  variant: 'owned' | 'shop'
  shopLabel?: string
  progress?: { done: number; total: number } | null
  addingLabel?: string
  onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
      className="book-card"
    >
      {coverUrl ? (
        <img className="book-card-cover" src={coverUrl} alt={book.name} />
      ) : (
        <div className="book-card-fallback">
          <span aria-hidden="true">📖</span>
          <span className="book-card-fallback-name">{book.name}</span>
        </div>
      )}
      {variant === 'owned' && progress && (
        <div className="book-adding-pill" aria-live="polite">
          <span className="boot-spinner boot-spinner--small" />
          <span>
            {addingLabel}
            {progress.total > 0 && ` ${progress.done}/${progress.total}`}
          </span>
        </div>
      )}
      {variant === 'shop' && (
        <div className="book-dl" aria-hidden="true">
          <span className="book-dl-pill">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="20" r="1.4" />
              <circle cx="17.5" cy="20" r="1.4" />
              <path d="M3 4h2.5l2.2 11.5h10.8L21 8H6" />
            </svg>
            {shopLabel}
          </span>
        </div>
      )}
    </div>
  )
}
