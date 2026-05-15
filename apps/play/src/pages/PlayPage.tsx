import { useParams, Navigate } from 'react-router-dom'
import { useProject } from '@shared/hooks/useProject'
import ScanPage from '@shared/pages/ScanPage'

export default function PlayPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading } = useProject(projectId!)

  if (loading) return <div className="loading">Chargement…</div>

  if (!project) {
    return <UnavailableMessage reason="not-found" />
  }

  if (project.published !== true) {
    return <UnavailableMessage reason="not-published" />
  }

  return <ScanPage />
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
