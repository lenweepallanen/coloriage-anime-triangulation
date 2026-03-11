import { useState } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import ImportStep from '../components/admin/ImportStep'
import ContourDefinitionStep from '../components/admin/ContourDefinitionStep'
import CannyValidationStep from '../components/admin/CannyValidationStep'
import ContourTrackingStep from '../components/admin/ContourTrackingStep'
import AnchorPointsStep from '../components/admin/AnchorPointsStep'
import AnchorTrackingStep from '../components/admin/AnchorTrackingStep'
import TriangulationStep from '../components/admin/TriangulationStep'
import FinalAnimationStep from '../components/admin/FinalAnimationStep'

const STEPS = [
  'Import',
  'Contour',
  'Validation Canny',
  'Tracking Contour',
  'Ancres',
  'Tracking Ancres',
  'Triangulation',
  'Animation finale',
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
        {activeStep === 'Contour' && (
          <ContourDefinitionStep project={project} onSave={save} />
        )}
        {activeStep === 'Validation Canny' && (
          <CannyValidationStep project={project} onSave={save} />
        )}
        {activeStep === 'Tracking Contour' && (
          <ContourTrackingStep project={project} onSave={save} />
        )}
        {activeStep === 'Ancres' && (
          <AnchorPointsStep project={project} onSave={save} />
        )}
        {activeStep === 'Tracking Ancres' && (
          <AnchorTrackingStep project={project} onSave={save} />
        )}
        {activeStep === 'Triangulation' && (
          <TriangulationStep project={project} onSave={save} />
        )}
        {activeStep === 'Animation finale' && (
          <FinalAnimationStep project={project} onSave={save} />
        )}
      </div>
    </div>
  )
}
