import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Book, Project } from '@shared/types/project'
import { getPublishedBooks } from '@shared/db/booksStore'
import { getProjectsByBook } from '@shared/db/projectsStore'
import { listAllFilmVideos, getFilmVideoPoster, type FilmVideoRecord } from '@shared/db/filmVideosStore'
import { isBookDownloaded } from '../utils/bookDownload'
import { shareFilmVideo } from '../utils/shareFilmVideo'
import { useI18n } from '../i18n'
import SharePreparingOverlay from '../components/SharePreparingOverlay'
import LoadingScreen from '../components/LoadingScreen'
import Mascot from '@shared/components/mascot/Mascot'

interface GalleryEntry {
  video: FilmVideoRecord
  /** Nom affiché : nom du coloriage (record, sinon projet résolu). */
  name: string
  /** Livre d'appartenance si résolu (filtre + navigation avec ?book). */
  bookId: string | null
}

/**
 * Onglet Galerie de l'app : UNIQUEMENT les vidéos des coloriages déjà scannés
 * (une par coloriage), vignette = frame à 1/3 de la durée. Tout est local à
 * l'appareil — aucun lien avec les Photos de l'iPhone.
 */
export default function GaleriePage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [books, setBooks] = useState<Book[]>([])
  const [entries, setEntries] = useState<GalleryEntry[]>([])
  const [bookFilter, setBookFilter] = useState<string>('all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const videos = await listAllFilmVideos()
        if (videos.length === 0) {
          if (!cancelled) setEntries([])
          return
        }
        // Résout livre + nom pour chaque vidéo (best-effort : une vidéo dont le
        // projet n'est plus listé reste affichée avec le nom stocké).
        const allBooks = await getPublishedBooks().catch(() => [] as Book[])
        const owned = allBooks.filter(isBookDownloaded)
        const projectMeta = new Map<string, { name: string; bookId: string }>()
        await Promise.all(
          owned.map(async book => {
            const projects = await getProjectsByBook(book.id, true).catch(() => [] as Project[])
            for (const p of projects) projectMeta.set(p.id, { name: p.name, bookId: book.id })
          }),
        )
        if (cancelled) return
        setBooks(owned)
        setEntries(videos.map(video => {
          const meta = projectMeta.get(video.projectId)
          return {
            video,
            name: meta?.name ?? video.projectName ?? t('common.coloring'),
            bookId: meta?.bookId ?? null,
          }
        }))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const visible = useMemo(
    () => (bookFilter === 'all' ? entries : entries.filter(e => e.bookId === bookFilter)),
    [entries, bookFilter],
  )

  // Règle charte : une seule mascotte par écran → pendant le chargement,
  // uniquement celle du loader (pas de header).
  if (loading) return <LoadingScreen />

  return (
    <div className="book-page galerie-page">
      <div className="galerie-logo-row">
        <Mascot size={120} gaze="pointer" />
      </div>
      <h1 className="section-title">{t('gallery.title')}</h1>
      <p className="galerie-sub">{t('gallery.sub1')}<br />{t('gallery.sub2')}</p>

      {books.length > 0 && entries.length > 0 && (
        <div className="galerie-filterbar" role="tablist" aria-label={t('gallery.filterAria')}>
          <button
            className={`galerie-pill${bookFilter === 'all' ? ' galerie-pill--active' : ''}`}
            role="tab"
            aria-selected={bookFilter === 'all'}
            onClick={() => setBookFilter('all')}
          >
            <span className="galerie-pill-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="7" height="7" rx="2" />
                <rect x="13" y="4" width="7" height="7" rx="2" />
                <rect x="4" y="13" width="7" height="7" rx="2" />
                <rect x="13" y="13" width="7" height="7" rx="2" />
              </svg>
            </span>
            {t('gallery.all')} ({entries.length})
          </button>
          {books.map(b => {
            const count = entries.filter(e => e.bookId === b.id).length
            return (
              <button
                key={b.id}
                className={`galerie-pill${bookFilter === b.id ? ' galerie-pill--active' : ''}`}
                role="tab"
                aria-selected={bookFilter === b.id}
                onClick={() => setBookFilter(b.id)}
              >
                <span className="galerie-pill-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 6.5C10.5 4.8 8 4 5 4v14c3 0 5.5.8 7 2.5 1.5-1.7 4-2.5 7-2.5V4c-3 0-5.5.8-7 2.5Z" />
                    <path d="M12 6.5V20.5" />
                  </svg>
                </span>
                {b.name} ({count})
              </button>
            )
          })}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="placeholder-card soft-card galerie-empty">
          <Mascot size={80} mood="sleepy" />
          <p>
            {entries.length === 0 ? t('gallery.empty') : t('gallery.emptyBook')}
          </p>
        </div>
      ) : (
        <div className="galerie-grid">
          {visible.map(entry => (
            <GalleryCard
              key={entry.video.projectId}
              entry={entry}
              onOpen={() => navigate(`/p/${entry.video.projectId}${entry.bookId ? `?book=${entry.bookId}` : ''}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GalleryCard({ entry, onOpen }: { entry: GalleryEntry; onOpen: () => void }) {
  const { t } = useI18n()
  const { video, name } = entry
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [sharing, setSharing] = useState(false)

  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (sharing) return
    setSharing(true)
    try {
      await shareFilmVideo(video)
    } finally {
      setSharing(false)
    }
  }

  // Vignette = frame à 1/3 de la durée (générée + persistée si absente).
  useEffect(() => {
    let cancelled = false
    let objUrl: string | null = null
    void getFilmVideoPoster(video).then(b => {
      if (cancelled || !b) return
      objUrl = URL.createObjectURL(b)
      setThumbUrl(objUrl)
    })
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [video])

  const scannedDate = new Date(video.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div
      className="galerie-card soft-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => e.key === 'Enter' && onOpen()}
    >
      <div className="galerie-card-thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt={name} loading="lazy" />
        ) : (
          <span className="galerie-card-thumb-fallback" aria-hidden="true">🎬</span>
        )}
        <span className="galerie-card-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
            <path d="M8 5.5c0-1.1 1.2-1.8 2.1-1.2l9.4 6.5c.8.6.8 1.8 0 2.4l-9.4 6.5c-.9.6-2.1-.1-2.1-1.2V5.5z" />
          </svg>
        </span>
      </div>
      <div className="galerie-card-texts">
        <span className="galerie-card-name">{name}</span>
        <span className="galerie-card-status galerie-card-status--done">{t('gallery.scannedOn')} {scannedDate}</span>
      </div>
      <button
        className="galerie-card-share"
        onClick={e => { void handleShare(e) }}
        disabled={sharing}
        aria-label={`${t('gallery.share')} ${name}`}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 15V4" />
          <path d="m7.5 8 4.5-4.5L16.5 8" />
          <path d="M5 13v6a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6" />
        </svg>
      </button>
      {sharing && <SharePreparingOverlay />}
    </div>
  )
}
