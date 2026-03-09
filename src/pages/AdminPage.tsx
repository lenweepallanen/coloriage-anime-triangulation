import { useState } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import ImportStep from '../components/admin/ImportStep'
import TriangulationStep from '../components/admin/TriangulationStep'
import PdfStep from '../components/admin/PdfStep'
import OpticalFlowStep from '../components/admin/OpticalFlowStep'

const STEPS = ['Import', 'Triangulation', 'PDF', 'Optical Flow'] as const
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
        {activeStep === 'Triangulation' && (
          <TriangulationStep project={project} onSave={save} />
        )}
        {activeStep === 'PDF' && (
          <PdfStep project={project} />
        )}
        {activeStep === 'Optical Flow' && (
          <OpticalFlowStep project={project} onSave={save} />
        )}
      </div>
    </div>
  )
}
