import { useCallback, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useProjectForPlay } from '@shared/hooks/useProjectForPlay'
import { filmIsPlayable, filmTIsPlayable } from '@shared/types/project'
import ScanPage from '@shared/pages/ScanPage'
import { getFilmVideo, hasFilmVideo, saveFilmVideo, type FilmVideoRecord } from '@shared/db/filmVideosStore'
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
  // Dernière vidéo capturée, en mémoire : le partage de fin de film part de là,
  // sans attendre la vignette (jusqu'à 10 s) ni la relecture IndexedDB.
  const lastRecordingRef = useRef<FilmRecordingResult | null>(null)
  const handleFilmRecorded = useCallback(async (r: FilmRecordingResult) => {
    if (!projectId) return
    lastRecordingRef.current = r
    const save = (async () => {
      // Vignette capturée DIRECTEMENT depuis le rendu PIXI pendant la lecture
      // (fiable iPhone/iPad) → prioritaire. Sinon, repli par extraction d'une frame
      // de la vidéo (peut échouer sur iPad : seek des vidéos MediaRecorder KO).
      const posterMs = r.posterMs ?? project?.filmT?.posterMs ?? null
      const posterBlob = r.posterBlob
        ?? await generateVideoPoster(r.blob, 1 / 3, 640, 10000, project?.filmT?.posterMs ?? null).catch(() => null)
      await saveFilmVideo(projectId, { ...r, posterBlob, posterMs, projectName: project?.name })
    })()
    lastSaveRef.current = save
    await save
  }, [projectId, project?.name, project?.filmT?.posterMs])

  const handleShareFilm = useCallback(async () => {
    if (!projectId || sharing) return
    setSharing(true)
    try {
      // Juste après la carte Fin, le recorder peut encore finaliser la vidéo
      // (quelques centaines de ms) : on lui laisse jusqu'à 2 s avant de se
      // rabattre sur la vidéo déjà enregistrée.
      for (let i = 0; i < 20 && !lastRecordingRef.current && lastSaveRef.current == null; i++) {
        await new Promise(r => setTimeout(r, 100))
      }
      const r = lastRecordingRef.current
      const rec: FilmVideoRecord | null = r
        ? {
            projectId,
            createdAt: Date.now(),
            mimeType: r.mimeType,
            durationMs: r.durationMs,
            blob: r.blob,
            posterMs: r.posterMs ?? project?.filmT?.posterMs ?? null,
            projectName: project?.name,
          }
        : await getFilmVideo(projectId)
      const ok = rec ? await shareFilmVideo(rec) : false
      if (!ok) setShareError(true)
    } finally {
      setSharing(false)
    }
  }, [projectId, sharing, project?.filmT?.posterMs, project?.name])

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
        // L'overlay est rendu DANS la carte Fin (portail z-index 1400) : rendu
        // ici, il restait invisible derrière la carte (« l'app ne répond plus »).
        sharePreparing={sharing}
        shareOverlay={<SharePreparingOverlay />}
      />
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
