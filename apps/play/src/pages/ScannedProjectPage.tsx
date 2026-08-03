import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Project } from '@shared/types/project'
import { getFilmVideo, getFilmVideoPoster, type FilmVideoRecord } from '@shared/db/filmVideosStore'
import { getProjectThumbnailBlob, getProjectThumbnail } from '@shared/db/projectsStore'
import { shareFilmVideo } from '../utils/shareFilmVideo'
import { useI18n } from '../i18n'
import SharePreparingOverlay from '../components/SharePreparingOverlay'
import Mascot from '@shared/components/mascot/Mascot'
import LoadingScreen from '../components/LoadingScreen'

interface Props {
  project: Project
  /** Relance le flux scan (caméra) pour rescanner une nouvelle version. */
  onNewScan: () => void
}

/**
 * Écran « coloriage déjà scanné » : la vidéo du film enregistrée localement se
 * revoit ici sans re-scanner ; « Nouveau scan » relance le flux caméra (à la fin
 * du nouveau play, l'écran Fin demandera si on remplace la vidéo).
 */
export default function ScannedProjectPage({ project, onNewScan }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const bookId = searchParams.get('book')

  const [video, setVideo] = useState<FilmVideoRecord | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState(false)

  const handleShare = async () => {
    if (!video || sharing) return
    setSharing(true)
    try {
      const ok = await shareFilmVideo(video)
      if (!ok) setShareError(true)
    } finally {
      setSharing(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    let objUrl: string | null = null
    let posterObjUrl: string | null = null
    getFilmVideo(project.id).then(async rec => {
      if (cancelled) return
      setVideo(rec)
      if (rec?.blob) {
        objUrl = URL.createObjectURL(rec.blob)
        setVideoUrl(objUrl)
      }
      // Poster = frame à 1/3 de la durée (générée + persistée si absente),
      // fallback : vignette du coloriage.
      const poster = rec
        ? await getFilmVideoPoster(rec).catch(() => null)
        : null
      const fallback = poster
        ? null
        : await getProjectThumbnailBlob(project.id).then(b => b ?? getProjectThumbnail(project.id)).catch(() => null)
      if (cancelled) return
      const posterSource = poster ?? fallback
      if (posterSource) {
        posterObjUrl = URL.createObjectURL(posterSource)
        setPosterUrl(posterObjUrl)
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
      if (posterObjUrl) URL.revokeObjectURL(posterObjUrl)
    }
  }, [project.id])

  // Vidéo introuvable (purgée / marqueur orphelin) : bascule directe sur le scan.
  useEffect(() => {
    if (!loading && !video) onNewScan()
  }, [loading, video, onNewScan])

  const handleBack = () => {
    if (bookId) navigate(`/livre/${bookId}`)
    else navigate(-1)
  }

  if (loading || !video) return <LoadingScreen />

  return (
    <div className="book-page scanned-project-page">
      <button className="book-home-btn" onClick={handleBack}>← {t('common.back')}</button>

      <h1 className="book-title">{project.name}</h1>
      <p className="book-subtitle">{t('scanned.badge')}</p>

      <h2 className="scanned-project-headline">{t('scanned.headline')}</h2>
      <p className="scanned-project-sub">{t('scanned.sub')}</p>

      <div className="soft-card scanned-project-video-card">
        <video
          className="scanned-project-video"
          src={videoUrl ?? undefined}
          poster={posterUrl ?? undefined}
          controls
          playsInline
          preload="metadata"
        />
      </div>

      <div className="paper-card scanned-project-bravo">
        <Mascot size={60} mood="happy" />
        <div>
          <strong>{t('scanned.bravo')}</strong>
          <p>{t('scanned.bravoText')}</p>
        </div>
      </div>

      <div className="scanned-project-rescan">
        <button className="btn-secondary btn-lg" onClick={() => { void handleShare() }} disabled={sharing}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 15V4" />
            <path d="m7.5 8 4.5-4.5L16.5 8" />
            <path d="M5 13v6a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6" />
          </svg>
          {' '}
          {sharing ? t('scanned.sharePrep') : t('scanned.share')}
        </button>
        <button className="btn-primary btn-lg" onClick={onNewScan}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
            <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
            <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
            <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
          </svg>
          {' '}
          {t('scanned.newScan')}
        </button>
        <p className="scanned-project-rescan-hint">
          {t('scanned.rescanHint')}
        </p>
      </div>

      {sharing && <SharePreparingOverlay />}

      {shareError && (
        <div className="scanner-confirm-backdrop" onClick={() => setShareError(false)}>
          <div className="scanner-confirm soft-card" onClick={e => e.stopPropagation()}>
            <p className="scanner-confirm-q">{t('scanned.shareError')}</p>
            <div className="scanner-confirm-actions">
              <button className="soft-btn" onClick={() => setShareError(false)}>{t('common.ok')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
