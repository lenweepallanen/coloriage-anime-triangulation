import { useState } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import ImportStep from '../components/admin/ImportStep'
import CannyValidationStep from '../components/admin/CannyValidationStep'
import ContourAnchorsStep from '../components/admin/ContourAnchorsStep'
import ContourTrackingStep from '../components/admin/ContourTrackingStep'
import ContourSubdivisionStep from '../components/admin/ContourSubdivisionStep'
import AnchorPointsStep from '../components/admin/AnchorPointsStep'
import AnchorTrackingStep from '../components/admin/AnchorTrackingStep'
import TriangulationStep from '../components/admin/TriangulationStep'

const STEPS = [
  'Import',
  'Canny',
  'Anchors Contour',
  'Subdivision',
  'Tracking Contour',
  'Ancres Internes',
  'Tracking Ancres',
  'Triangulation',
] as const
type Step = (typeof STEPS)[number]

export default function AdminPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading, save } = useProject(projectId!)
  const [activeStep, setActiveStep] = useState<Step>('Import')

  if (loading) return <div className="loading">Chargement du projet...</div>
  if (!project) return <Navigate to="/" replace />

  return (
    <div className="admin-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2>{project.name} — Administration</h2>
        <Link to={`/scan/${project.id}`}>
          <button>Tester le scan</button>
        </Link>
      </div>

      <nav className="admin-tabs">
        {STEPS.map(step => (
          <button
            key={step}
            className={`tab ${activeStep === step ? 'active' : ''}`}
            onClick={() => setActiveStep(step)}
          >
            {step}
          </button>
        ))}
      </nav>

      <div className="admin-content">
        {activeStep === 'Import' && (
          <ImportStep project={project} onSave={save} />
        )}
        {activeStep === 'Canny' && (
          <CannyValidationStep project={project} onSave={save} />
        )}
        {activeStep === 'Anchors Contour' && (
          <ContourAnchorsStep project={project} onSave={save} />
        )}
        {activeStep === 'Subdivision' && (
          <ContourSubdivisionStep project={project} onSave={save} />
        )}
        {activeStep === 'Tracking Contour' && (
          <ContourTrackingStep project={project} onSave={save} />
        )}
        {activeStep === 'Ancres Internes' && (
          <AnchorPointsStep project={project} onSave={save} />
        )}
        {activeStep === 'Tracking Ancres' && (
          <AnchorTrackingStep project={project} onSave={save} />
        )}
        {activeStep === 'Triangulation' && (
          <TriangulationStep project={project} onSave={save} />
        )}
      </div>
    </div>
  )
}
