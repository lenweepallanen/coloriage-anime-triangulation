import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Book, Project } from '@shared/types/project'
import { getPublishedBooks } from '@shared/db/booksStore'
import { getProjectsByBook } from '@shared/db/projectsStore'
import { listAllFilmVideos, getFilmVideoPoster, type FilmVideoRecord } from '@shared/db/filmVideosStore'
import { isBookDownloaded } from '../utils/bookDownload'

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
            name: meta?.name ?? video.projectName ?? 'Coloriage',
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

  return (
    <div className="book-page galerie-page">
      <h1 className="book-title">Galerie</h1>
      <p className="book-subtitle">Retrouve tous tes coloriages qui ont pris vie !</p>

      {books.length > 1 && entries.length > 0 && (
        <div className="galerie-filters">
          <select
            className="galerie-filter-select"
            value={bookFilter}
            onChange={e => setBookFilter(e.target.value)}
            aria-label="Filtrer par livre"
          >
            <option value="all">📚 Tous les livres</option>
            {books.map(b => (
              <option key={b.id} value={b.id}>📖 {b.name}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="loading">Chargement…</div>
      ) : visible.length === 0 ? (
        <div className="placeholder-card soft-card galerie-empty">
          <p>
            {entries.length === 0
              ? 'Aucune vidéo pour l’instant — scanne ton premier coloriage pour le voir prendre vie !'
              : 'Aucune vidéo dans ce livre.'}
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
  const { video, name } = entry
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

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

  const scannedDate = new Date(video.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div
      className="galerie-card soft-card galerie-card--video"
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
        <span className="galerie-card-status galerie-card-status--done">Scanné le {scannedDate}</span>
      </div>
    </div>
  )
}
