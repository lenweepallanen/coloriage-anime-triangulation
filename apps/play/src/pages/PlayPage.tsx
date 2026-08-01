import { useCallback, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useProjectForPlay } from '@shared/hooks/useProjectForPlay'
import ScanPage from '@shared/pages/ScanPage'
import { hasFilmVideo, saveFilmVideo } from '@shared/db/filmVideosStore'
import type { FilmRecordingResult } from '@shared/utils/filmRecorder'
import { generateVideoPoster } from '@shared/utils/videoPoster'
import ScannedProjectPage from './ScannedProjectPage'

export default function PlayPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const { project, loading, deferredLoaded } = useProjectForPlay(projectId!)

  // Écran « déjà scanné » : une vidéo locale existe ET on n'arrive pas avec une
  // intention explicite de scanner (QR → autocam). « Nouveau scan » bascule sur
  // le flux caméra pour la session.
  const [forceScan, setForceScan] = useState(false)
  const handleNewScan = useCallback(() => setForceScan(true), [])

  // Capture du film (1ʳᵉ lecture après scan) : sauvegarde LOCALE uniquement
  // (1 vidéo par coloriage, écrasement) + vignette extraite à 1/3 de la durée.
  // Rien n'est écrit dans les Photos de l'iPhone — la galerie est celle de l'app.
  const handleFilmRecorded = useCallback(async (r: FilmRecordingResult) => {
    if (!projectId) return
    const posterBlob = await generateVideoPoster(r.blob).catch(() => null)
    await saveFilmVideo(projectId, { ...r, posterBlob, projectName: project?.name })
  }, [projectId, project?.name])

  if (loading) return <div className="loading">Chargement…</div>

  if (!project) {
    return <UnavailableMessage reason="not-found" />
  }

  if (project.published !== true) {
    return <UnavailableMessage reason="not-published" />
  }

  const autocam = searchParams.get('autocam') === '1'
  const showReplay = !forceScan && !autocam && hasFilmVideo(project.id)

  if (showReplay) {
    return <ScannedProjectPage project={project} onNewScan={handleNewScan} />
  }

  return (
    <ScanPage
      project={project}
      loading={false}
      deferredLoaded={deferredLoaded}
      mode="play"
      onFilmRecorded={handleFilmRecorded}
    />
  )
}

function UnavailableMessage({ reason }: { reason: 'not-found' | 'not-published' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Coloriage indisponible</h1>
      <p style={{ maxWidth: 480, color: '#555' }}>
        {reason === 'not-found'
          ? "Ce coloriage n'existe pas ou a été retiré."
          : "Ce coloriage n'est pas encore publié."}
      </p>
      <p style={{ marginTop: 16 }}>
        <a href="/">Retour à l'accueil</a>
      </p>
    </div>
  )
}
