import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Project } from '@shared/types/project'
import { getFilmVideo, type FilmVideoRecord } from '@shared/db/filmVideosStore'
import { getProjectThumbnailBlob, getProjectThumbnail } from '@shared/db/projectsStore'

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
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const bookId = searchParams.get('book')

  const [video, setVideo] = useState<FilmVideoRecord | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    let objUrl: string | null = null
    let posterObjUrl: string | null = null
    getFilmVideo(project.id).then(rec => {
      if (cancelled) return
      setVideo(rec)
      if (rec?.blob) {
        objUrl = URL.createObjectURL(rec.blob)
        setVideoUrl(objUrl)
      }
      // Poster : vignette extraite à 1/3 de la vidéo (fallback : vignette du coloriage).
      if (rec?.posterBlob) {
        posterObjUrl = URL.createObjectURL(rec.posterBlob)
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

  useEffect(() => {
    if (video?.posterBlob) return
    let cancelled = false
    let objUrl: string | null = null
    getProjectThumbnailBlob(project.id)
      .then(b => b ?? getProjectThumbnail(project.id))
      .then(b => {
        if (cancelled || !b) return
        objUrl = URL.createObjectURL(b)
        setPosterUrl(prev => prev ?? objUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (objUrl) URL.revokeObjectURL(objUrl)
    }
  }, [project.id, video?.posterBlob])

  // Vidéo introuvable (purgée / marqueur orphelin) : bascule directe sur le scan.
  useEffect(() => {
    if (!loading && !video) onNewScan()
  }, [loading, video, onNewScan])

  const handleBack = () => {
    if (bookId) navigate(`/livre/${bookId}`)
    else navigate(-1)
  }

  if (loading || !video) return <div className="loading">Chargement…</div>

  return (
    <div className="book-page scanned-project-page">
      <button className="book-home-btn" onClick={handleBack}>← Retour</button>

      <h1 className="book-title">{project.name}</h1>
      <p className="book-subtitle">Coloriage scanné et animé ✓</p>

      <h2 className="scanned-project-headline">✦ Ton coloriage prend vie ! ✦</h2>
      <p className="scanned-project-sub">Regarde ton coloriage en action</p>

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
        <span className="scanned-project-bravo-star" aria-hidden="true">⭐</span>
        <div>
          <strong>Bravo !</strong>
          <p>Tu peux revoir la vidéo autant de fois que tu veux.</p>
        </div>
      </div>

      <div className="scanned-project-rescan">
        <button className="btn-primary btn-lg" onClick={onNewScan}>
          ⌜⌟ Nouveau scan
        </button>
        <p className="scanned-project-rescan-hint">
          Tu peux rescanner une nouvelle version de ton coloriage.
        </p>
      </div>
    </div>
  )
}
