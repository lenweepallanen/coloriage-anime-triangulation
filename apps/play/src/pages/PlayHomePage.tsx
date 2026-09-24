import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { getPublishedBooks, getBookCover } from '@shared/db/booksStore'
import type { Book } from '@shared/types/project'
import { isBookAdded, isBookPending, subscribeBookDownloads, getBookDownloadPercent, consumeBookJustCompleted, resumePendingBookDownloads } from '../utils/bookDownload'
import { playUi } from '@shared/utils/uiSound'
import { useI18n } from '../i18n'
import Mascot from '@shared/components/mascot/Mascot'
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
 * Borne une promesse dans le temps. Sur une WebView native (Capacitor), le
 * transport Firestore peut rester suspendu sans jamais rejeter quand le réseau
 * est bloqué ou très lent — le boot screen resterait alors figé indéfiniment
 * (« l'app ne se charge pas »). Ce garde-fou force un rejet après `ms` pour que
 * l'app bascule sur l'écran d'erreur/réessai au lieu de tourner sans fin.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/** Délai max du chargement initial avant de montrer l'écran d'erreur/réessai. */
const BOOT_LOAD_TIMEOUT_MS = 15000

/**
 * Écran d'accueil PLAY.
 *
 * - Sans livre ajouté : « Bienvenue ! Scanne ton premier coloriage » + une
 *   flèche animée qui pointe le bouton SCAN de la barre (aucune carte « + » :
 *   l'ajout passe uniquement par le scan d'un QR, livre ou coloriage).
 * - MES LIVRES : livres ajoutés. Un livre en cours de téléchargement montre un
 *   cercle de progression en % et n'est pas ouvrable tant qu'il n'est pas prêt
 *   (pas d'écran d'attente à l'intérieur) ; à 100 % la carte « s'allume ».
 * - LES AUTRES LIVRES : vitrine — un tap ouvre la page Amazon du livre.
 */
export default function PlayHomePage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [books, setBooks] = useState<Book[]>(homeCache?.books ?? [])
  const [covers, setCovers] = useState<Record<string, string>>(homeCache?.covers ?? {})
  const [ready, setReady] = useState(homeCache !== null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Ré-essais silencieux automatiques avant d'exposer l'écran d'erreur : couvre
  // le cold-start Firestore et les micro-coupures réseau au premier lancement.
  const [autoRetries, setAutoRetries] = useState(0)
  // Re-render quand la progression d'un téléchargement de livre change ; un
  // livre qui vient de finir joue le signal « prêt » (son + carte qui s'allume).
  const [, setDownloadTick] = useState(0)
  const [readyIds, setReadyIds] = useState<Set<string>>(new Set())
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(
    () => new Set((homeCache?.books ?? []).filter(isBookAdded).map(b => b.id)),
  )
  const booksRef = useRef<Book[]>([])
  useEffect(() => subscribeBookDownloads(() => {
    setDownloadTick(v => v + 1)
    // Un livre ajouté depuis le scanner apparaît tout de suite dans MES LIVRES.
    setDownloadedIds(new Set(booksRef.current.filter(isBookAdded).map(b => b.id)))
    for (const b of booksRef.current) {
      if (consumeBookJustCompleted(b.id)) {
        playUi('success')
        setReadyIds(prev => new Set(prev).add(b.id))
        setTimeout(() => setReadyIds(prev => { const n = new Set(prev); n.delete(b.id); return n }), 1600)
      }
    }
  }), [])
  useEffect(() => {
    booksRef.current = books
    // Livres ajoutés dont le pré-chargement a été interrompu (app fermée) : on reprend.
    resumePendingBookDownloads(books)
  }, [books])

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
        // Garde-fou : la liste des livres (Firestore) DOIT aboutir ou échouer
        // dans un délai borné — jamais de loader infini sur une WebView native.
        const bs = await withTimeout(getPublishedBooks(), BOOT_LOAD_TIMEOUT_MS)
        const map: Record<string, string> = { ...(homeCache?.covers ?? {}) }
        // Les couvertures ne doivent pas bloquer l'affichage : bornées aussi et
        // non fatales (on affiche les livres même si une couverture manque).
        await withTimeout(
          Promise.all(
            bs.map(async b => {
              if (map[b.id]) return
              const blob = await getBookCover(b.id).catch(() => null)
              if (blob) map[b.id] = URL.createObjectURL(blob)
            }),
          ),
          BOOT_LOAD_TIMEOUT_MS,
        ).catch(() => { /* couvertures partielles tolérées */ })
        if (cancelled) return
        homeCache = { books: bs, covers: map }
        setCovers(map)
        setBooks(bs)
        setDownloadedIds(new Set(bs.filter(isBookAdded).map(b => b.id)))
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

  // Sur échec du premier chargement : jusqu'à 2 ré-essais silencieux (le boot
  // screen reste affiché) avant de montrer l'écran d'erreur/réessai manuel.
  useEffect(() => {
    if (!error || autoRetries >= 2) return
    const id = setTimeout(() => {
      setAutoRetries(n => n + 1)
      setError(false)
      setReady(false)
      setAttempt(a => a + 1)
    }, 2000)
    return () => clearTimeout(id)
  }, [error, autoRetries])

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
  // « LES AUTRES LIVRES » (découverte) : on masque les livres non listés
  // (review). Ils restent ajoutables par QR + visibles dans MES LIVRES.
  const otherBooks = books.filter(b => !downloadedIds.has(b.id) && !b.unlisted)
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
          {firstTime ? (
            <WelcomeScan title={t('home.welcome')} subtitle={t('home.welcomeSub')} />
          ) : (
            <>
              <h2 className="section-title">{t('home.myBooks')}</h2>
              <div className="home-grid">
                {myBooks.map(b => (
                  <BookCard
                    key={b.id}
                    book={b}
                    coverUrl={covers[b.id] ?? null}
                    variant="owned"
                    percent={getBookDownloadPercent(b.id) ?? (isBookPending(b) ? 0 : null)}
                    downloadingLabel={t('home.downloading')}
                    ready={readyIds.has(b.id)}
                    onClick={() => navigate(`/livre/${b.id}`)}
                  />
                ))}
              </div>
            </>
          )}
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
      <div className="home-mascot"><Mascot size={120} gaze="pointer" /></div>
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

/**
 * Accueil sans livre : titre ✦ + consigne, et une flèche « sticker » animée
 * (portal : fixée juste au-dessus du bouton SCAN de la barre d'onglets).
 */
function WelcomeScan({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <>
      <div className="welcome-block">
        <h2 className="section-title">{title}</h2>
        <p className="welcome-sub">{subtitle}</p>
      </div>
      {createPortal(
        <div className="welcome-arrow" aria-hidden="true">
          <svg viewBox="0 0 64 88" width="54" height="74">
            <path
              d="M32 6v52M12 40l20 22 20-22"
              fill="none"
              stroke="#ffffff"
              strokeWidth="18"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M32 6v52M12 40l20 22 20-22"
              fill="none"
              stroke="#8b7cf0"
              strokeWidth="9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * Anneau de progression (téléchargement d'un livre) avec le % au centre.
 * La progression réelle avance par étapes (3 par coloriage) ; entre deux étapes,
 * un gros fichier peut prendre 20 s. Pour que l'enfant voie que « ça avance »,
 * l'anneau glisse doucement vers l'étape suivante (jamais en arrière, jamais
 * au-delà), puis se cale sur la valeur réelle dès qu'elle arrive.
 */
function ProgressRing({ percent, label }: { percent: number; label: string }) {
  const [crept, setCrept] = useState(percent)
  useEffect(() => {
    const from = percent
    const at = Date.now()
    const step = 100 / 9 // taille d'une étape pour un livre d'un coloriage (la plus grande possible)
    const timer = setInterval(() => {
      const elapsed = (Date.now() - at) / 1000
      const creep = Math.min(step * 0.8, step * (1 - Math.exp(-elapsed / 12)))
      setCrept(Math.min(99, Math.round(from + creep)))
    }, 500)
    return () => clearInterval(timer)
  }, [percent])
  // Jamais en dessous de la valeur réelle (le glissement ne fait qu'anticiper l'étape suivante).
  const shown = Math.max(percent, crept)
  const r = 30
  const c = 2 * Math.PI * r
  const dash = c * Math.max(0, Math.min(100, shown)) / 100
  return (
    <div className="book-progress" aria-live="polite">
      <div className="book-progress-disc">
        <svg className="book-progress-ring" viewBox="0 0 76 76" width="76" height="76">
          <circle cx="38" cy="38" r={r} fill="none" stroke="#e6ddfa" strokeWidth="7" />
          <circle
            cx="38" cy="38" r={r} fill="none" stroke="#8b7cf0" strokeWidth="7" strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`} transform="rotate(-90 38 38)"
          />
        </svg>
        <span className="book-progress-pct">{shown}%</span>
      </div>
      <span className="book-progress-label">{label}</span>
    </div>
  )
}

function BookCard({ book, coverUrl, variant, shopLabel, percent, downloadingLabel, ready, onClick }: {
  book: Book
  coverUrl: string | null
  variant: 'owned' | 'shop'
  shopLabel?: string
  /** Téléchargement en cours (0–100) ; null = prêt. */
  percent?: number | null
  downloadingLabel?: string
  /** Vient de finir : animation « prêt ». */
  ready?: boolean
  onClick: () => void
}) {
  const downloading = variant === 'owned' && percent != null
  const activate = () => { if (!downloading) onClick() }
  return (
    <div
      onClick={activate}
      role="button"
      tabIndex={downloading ? -1 : 0}
      aria-disabled={downloading || undefined}
      onKeyDown={e => e.key === 'Enter' && activate()}
      className={`book-card${downloading ? ' book-card--downloading' : ''}${ready ? ' book-card--ready' : ''}`}
    >
      {coverUrl ? (
        <img className="book-card-cover" src={coverUrl} alt={book.name} />
      ) : (
        <div className="book-card-fallback">
          <span aria-hidden="true">📖</span>
          <span className="book-card-fallback-name">{book.name}</span>
        </div>
      )}
      {downloading && (
        <ProgressRing percent={percent ?? 0} label={downloadingLabel ?? ''} />
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
