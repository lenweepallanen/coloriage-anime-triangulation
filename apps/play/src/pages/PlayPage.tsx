import { useCallback, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useProjectForPlay } from '@shared/hooks/useProjectForPlay'
import { filmIsPlayable, filmTIsPlayable } from '@shared/types/project'
import ScanPage from '@shared/pages/ScanPage'
import { getFilmVideo, hasFilmVideo, saveFilmVideo } from '@shared/db/filmVideosStore'
import type { FilmRecordingResult } from '@shared/utils/filmRecorder'
import { generateVideoPoster } from '@shared/utils/videoPoster'
import ScannedProjectPage from './ScannedProjectPage'
import { shareFilmVideo } from '../utils/shareFilmVideo'
import SharePreparingOverlay from '../components/SharePreparingOverlay'
import LoadingScreen from '../components/LoadingScreen'
import Mascot from '@shared/components/mascot/Mascot'
import { useI18n } from '../i18n'

export default function PlayPage() {
  const { t } = useI18n()
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const { project, loading, deferredLoaded } = useProjectForPlay(projectId!)

  // Écran « déjà scanné » : une vidéo locale existe ET on n'arrive pas avec une
  // intention explicite de scanner (QR → autocam). « Nouveau scan » bascule sur
  // le flux caméra pour la session.
  const [forceScan, setForceScan] = useState(false)
  const handleNewScan = useCallback(() => setForceScan(true), [])

  // Partage depuis l'écran Fin du film : popup de préparation + feuille native.
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState(false)

  // Capture du film (1ʳᵉ lecture après scan) : sauvegarde LOCALE uniquement
  // (1 vidéo par coloriage, écrasement) + vignette extraite à 1/3 de la durée.
  // Rien n'est écrit dans les Photos de l'iPhone — la galerie est celle de l'app.
  const lastSaveRef = useRef<Promise<unknown> | null>(null)
  const handleFilmRecorded = useCallback(async (r: FilmRecordingResult) => {
    if (!projectId) return
    const save = (async () => {
      // Instant de vignette choisi dans l'éditeur FILM (temps global) — sinon 1/3.
      const posterMs = project?.filmT?.posterMs ?? null
      const posterBlob = await generateVideoPoster(r.blob, 1 / 3, 640, 10000, posterMs).catch(() => null)
      await saveFilmVideo(projectId, { ...r, posterBlob, posterMs, projectName: project?.name })
    })()
    lastSaveRef.current = save
    await save
  }, [projectId, project?.name, project?.filmT?.posterMs])

  const handleShareFilm = useCallback(async () => {
    if (!projectId || sharing) return
    setSharing(true)
    try {
      // La sauvegarde (poster inclus) peut encore être en cours juste après la fin
      // du film : on l'attend avant de lire l'enregistrement.
      await lastSaveRef.current?.catch(() => {})
      const rec = await getFilmVideo(projectId)
      const ok = rec ? await shareFilmVideo(rec) : false
      if (!ok) setShareError(true)
    } finally {
      setSharing(false)
    }
  }, [projectId, sharing])

  if (loading) return <LoadingScreen />

  // Un coloriage n'est jouable côté play QUE s'il est publié ET a un FILM.
  if (!project || project.published !== true || !(filmTIsPlayable(project.filmT) || filmIsPlayable(project.film))) {
    return <UnavailableMessage />
  }

  const autocam = searchParams.get('autocam') === '1'
  const showReplay = !forceScan && !autocam && hasFilmVideo(project.id)

  if (showReplay) {
    return <ScannedProjectPage project={project} onNewScan={handleNewScan} />
  }

  return (
    <>
      <ScanPage
        project={project}
        loading={false}
        deferredLoaded={deferredLoaded}
        mode="play"
        onFilmRecorded={handleFilmRecorded}
        onShareFilm={handleShareFilm}
      />
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
    </>
  )
}

function UnavailableMessage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  return (
    <div className="placeholder-page">
      <div className="placeholder-card soft-card">
        <Mascot size={88} mood="oops" />
        <h1>{t('unavailable.title')}</h1>
        <p className="text-preline">{t('unavailable.text')}</p>
        <button className="book-home-btn" onClick={() => navigate('/')}>
          ← {t('unavailable.home')}
        </button>
      </div>
    </div>
  )
}
