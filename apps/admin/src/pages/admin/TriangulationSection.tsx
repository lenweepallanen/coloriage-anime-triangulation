import { useState, useEffect, useCallback } from 'react'
import { useAdminContext } from './AdminLayout'
import type { Project, ProjectTriangulation } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import ProjectTriangZonesStep from '../../components/admin/ProjectTriangZonesStep'
import ProjectTriangMeshStep from '../../components/admin/ProjectTriangMeshStep'
import ProjectTriangHiddenFaceStep from '../../components/admin/ProjectTriangHiddenFaceStep'
import ProjectTriangPreviewStep from '../../components/admin/ProjectTriangPreviewStep'

const STEPS = ['Image référence', 'Zones SAM 2', 'Maillage par zone', 'Faces cachées', 'Preview'] as const
type TriangStep = (typeof STEPS)[number]

const SHORT_LABELS: Record<string, string> = {
  'Image référence': 'Image',
  'Zones SAM 2': 'Zones',
  'Maillage par zone': 'Maillage',
  'Faces cachées': 'Faces cachées',
  'Preview': 'Preview',
}

type StepStatus = 'done' | 'active' | 'pending'

function getStepStatus(step: TriangStep, activeStep: TriangStep, tri: ProjectTriangulation | null): StepStatus {
  if (step === activeStep) return 'active'
  switch (step) {
    case 'Image référence': return tri?.referenceImageBlob != null ? 'done' : 'pending'
    case 'Zones SAM 2': return tri?.step1Validated ? 'done' : 'pending'
    case 'Maillage par zone': return tri?.step2Validated ? 'done' : 'pending'
    case 'Faces cachées': return tri?.step3Validated ? 'done' : 'pending'
    case 'Preview': return tri?.step3Validated ? 'done' : 'pending'
    default: return 'pending'
  }
}

export default function TriangulationSection() {
  const { project, save } = useAdminContext()
  const [activeStep, setActiveStep] = useState<TriangStep>('Image référence')

  const tri = project.projectTriangulation

  return (
    <div className="pipeline-editor">
      <nav className="pipeline-stepper">
        {STEPS.map((step, i) => {
          const status = getStepStatus(step, activeStep, tri)
          return (
            <button
              key={step}
              className={`pipeline-step pipeline-step--${status}`}
              onClick={() => setActiveStep(step)}
            >
              <span className="pipeline-step-content">
                <span className="pipeline-step-circle">
                  {status === 'done' ? '✓' : i + 1}
                </span>
                <span className="pipeline-step-label">
                  {SHORT_LABELS[step] || step}
                </span>
              </span>
              {i < STEPS.length - 1 && (
                <span className="pipeline-step-connector" />
              )}
            </button>
          )
        })}
      </nav>

      <div className="pipeline-step-content-area">
        {activeStep === 'Image référence' && (
          <ReferenceImageStep project={project} onSave={save} />
        )}
        {activeStep === 'Zones SAM 2' && (
          <ProjectTriangZonesStep project={project} onSave={save} />
        )}
        {activeStep === 'Maillage par zone' && (
          <ProjectTriangMeshStep project={project} onSave={save} />
        )}
        {activeStep === 'Faces cachées' && (
          <ProjectTriangHiddenFaceStep project={project} onSave={save} />
        )}
        {activeStep === 'Preview' && (
          <ProjectTriangPreviewStep project={project} onSave={save} />
        )}
      </div>
    </div>
  )
}

// ─── Step 0: Reference Image Import ─────────────────────────────────

function ReferenceImageStep({ project, onSave }: { project: Project; onSave: (p: Project, hints?: UploadHint[]) => Promise<void> }) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const tri = project.projectTriangulation

  useEffect(() => {
    const blob = tri?.referenceImageBlob
    if (blob) {
      const url = URL.createObjectURL(blob)
      setImageUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setImageUrl(null)
    }
  }, [tri?.referenceImageBlob])

  const handleImageChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      const newTri: ProjectTriangulation = tri
        ? { ...tri, referenceImageBlob: file }
        : {
            referenceImageBlob: file,
            zones: [], prompts: [],
            masksRLE: null, maskWidth: 0, maskHeight: 0,
            contours: null, contourSmoothSigma: 3, bridgeThreshold: 8,
            step1Validated: false,
            zoneContourCount: {}, zoneContourPoints: {}, zoneContourValidated: {},
            zonePoints: {}, zoneTriangles: {}, zoneDensity: {},
            bodyPoints: [], bodyTriangles: [],
            step2Validated: false,
            hiddenFaceZones: [], hiddenFaceLimbZones: [],
            step3Validated: false,
          }
      await onSave(
        { ...project, projectTriangulation: newTri },
        ['triangulationReferenceImage'],
      )
    } catch (err) {
      console.error('Failed to save reference image:', err)
      alert('Erreur : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }, [tri, project, onSave])

  return (
    <div className="step-section">
      <h3 style={{ marginTop: 0 }}>Image de référence</h3>
      <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 16 }}>
        Importez une image <strong>colorée</strong> de l'animal (pas le coloriage noir &amp; blanc).
        SAM 2 utilisera cette image pour segmenter les zones (corps + pattes).
        Elle doit avoir les <strong>mêmes dimensions</strong> que le coloriage.
      </p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div>
          <label className="btn-primary" style={{ cursor: saving ? 'wait' : 'pointer' }}>
            {saving ? 'Import en cours...' : (imageUrl ? 'Changer l\'image' : 'Importer une image')}
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={handleImageChange}
              disabled={saving}
              style={{ display: 'none' }}
            />
          </label>
        </div>

        {imageUrl && (
          <div style={{ border: '1px solid #334155', borderRadius: 8, overflow: 'hidden', maxWidth: 400 }}>
            <img src={imageUrl} alt="Image de référence" style={{ display: 'block', maxWidth: '100%', maxHeight: 300 }} />
          </div>
        )}
      </div>

      {imageUrl && (
        <p style={{ color: '#22c55e', fontSize: 13, marginTop: 12 }}>
          Image importée. Passez à l'étape suivante pour définir les zones SAM 2.
        </p>
      )}
    </div>
  )
}
