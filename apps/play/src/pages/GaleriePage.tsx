import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Book, Project } from '@shared/types/project'
import { getPublishedBooks } from '@shared/db/booksStore'
import { getProjectsByBook, getProjectThumbnailBlob, getProjectThumbnail } from '@shared/db/projectsStore'
import { listAllFilmVideos, type FilmVideoRecord } from '@shared/db/filmVideosStore'
import { isBookDownloaded } from '../utils/bookDownload'

interface GalleryEntry {
  project: Project
  book: Book
  indexInBook: number
  video: FilmVideoRecord | null
}

/**
 * Onglet Galerie de l'app : tous les coloriages des livres possédés, avec la
 * vidéo enregistrée (vignette extraite à 1/3 de la durée + ▶) pour ceux qui ont
 * pris vie, la vignette du coloriage + « À scanner » pour les autres.
 * Tout est local à l'appareil — rien ne vient ni ne va vers les Photos iPhone.
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
        const [allBooks, videos] = await Promise.all([getPublishedBooks(), listAllFilmVideos()])
        const owned = allBooks.filter(isBookDownloaded)
        const videoByProject = new Map(videos.map(v => [v.projectId, v]))
        const perBook = await Promise.all(
          owned.map(async book => {
            const projects = await getProjectsByBook(book.id, true).catch(() => [] as Project[])
            return projects.map((project, i): GalleryEntry => ({
              project,
              book,
              indexInBook: i,
              video: videoByProject.get(project.id) ?? null,
            }))
          }),
        )
        if (cancelled) return
        setBooks(owned)
        setEntries(perBook.flat())
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [])

  const visible = useMemo(
    () => (bookFilter === 'all' ? entries : entries.filter(e => e.book.id === bookFilter)),
    [entries, bookFilter],
  )

  return (
    <div className="book-page galerie-page">
      <h1 className="book-title">Galerie</h1>
      <p className="book-subtitle">Retrouve tous tes coloriages qui ont pris vie !</p>

      {books.length > 1 && (
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
            {books.length === 0
              ? 'Ajoute un livre depuis l’accueil pour voir tes coloriages ici.'
              : 'Aucun coloriage dans ce livre.'}
          </p>
        </div>
      ) : (
        <div className="galerie-grid">
          {visible.map(entry => (
            <GalleryCard
              key={entry.project.id}
              entry={entry}
              onOpen={() => navigate(`/p/${entry.project.id}?book=${entry.book.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function GalleryCard({ entry, onOpen }: { entry: GalleryEntry; onOpen: () => void }) {
  const { project, indexInBook, video } = entry
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)

  // Vignette : frame à 1/3 de la vidéo si elle existe, sinon vignette du coloriage.
  useEffect(() => {
    let cancelled = false
    let objUrl: string | null = null
    const source: Promise<Blob | null> = video?.posterBlob
      ? Promise.resolve(video.posterBlob)
      : getProjectThumbnailBlob(project.id).then(b => b ?? getProjectThumbnail(project.id)).catch(() => null)
    void source.then(b => {
      if (cancelled || !b) return
      objUrl = URL.createObjectURL(b)
      setThumbUrl(objUrl)
    })
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [project.id, video?.posterBlob])

  const scannedDate = video
    ? new Date(video.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
    : null

  return (
    <div
      className={`galerie-card soft-card${video ? ' galerie-card--video' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => e.key === 'Enter' && onOpen()}
    >
      <div className="galerie-card-thumb">
        {thumbUrl ? (
          <img src={thumbUrl} alt={project.name} loading="lazy" />
        ) : (
          <span className="galerie-card-thumb-fallback" aria-hidden="true">🖍️</span>
        )}
        {video && (
          <span className="galerie-card-play" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
              <path d="M8 5.5c0-1.1 1.2-1.8 2.1-1.2l9.4 6.5c.8.6.8 1.8 0 2.4l-9.4 6.5c-.9.6-2.1-.1-2.1-1.2V5.5z" />
            </svg>
          </span>
        )}
      </div>
      <div className="galerie-card-texts">
        <span className="galerie-card-name">{indexInBook + 1}. {project.name}</span>
        <span className={`galerie-card-status${video ? ' galerie-card-status--done' : ''}`}>
          {video ? `Scanné le ${scannedDate}` : 'À scanner'}
        </span>
      </div>
    </div>
  )
}
