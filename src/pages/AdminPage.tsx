import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import type { Project, ProjectStepView, MeshData } from '../types/project'
import type { UploadHint, StepUploadHint } from '../db/projectsStore'
import AnimationManager, { SHARED_GEOMETRY_FIELDS, copySharedGeometry } from '../components/admin/AnimationManager'
import AdminPreview from '../components/admin/AdminPreview'
import ImportStep from '../components/admin/ImportStep'
import CannyValidationStep from '../components/admin/CannyValidationStep'
import ContourOriginStep from '../components/admin/ContourOriginStep'
import ContourOriginTrackingStep from '../components/admin/ContourOriginTrackingStep'
import ContourAnchorsStep from '../components/admin/ContourAnchorsStep'
import ContourSubdivisionStep from '../components/admin/ContourSubdivisionStep'
import ContourTrackingStep from '../components/admin/ContourTrackingStep'
import AnchorPointsStep from '../components/admin/AnchorPointsStep'
import AnchorTrackingStep from '../components/admin/AnchorTrackingStep'
import TriangulationStep from '../components/admin/TriangulationStep'
import PhysicsAnimationEditor from '../components/admin/PhysicsAnimationEditor'
import { generateTemplatePDF } from '../utils/pdfGenerator'

// Full pipeline for rest animation
const REST_STEPS = [
  'Import',
  'Canny',
  'Point 0 Contour',
  'Tracking Point 0',
  'Anchors Contour',
  'Subdivision',
  'Tracking Contour',
  'Ancres Internes',
  'Tracking Ancres',
  'Triangulation',
] as const

// Reduced pipeline for oneshot animations (no geometry placement steps)
const ONESHOT_STEPS = [
  'Import',
  'Canny',
  'Tracking Point 0',
  'Tracking Contour',
  'Tracking Ancres',
  'Triangulation',
] as const

// Physics animations: code editor only
const PHYSICS_STEPS = [
  'Code Editeur',
] as const

type Step = (typeof REST_STEPS)[number] | (typeof PHYSICS_STEPS)[number]

const PROJECT_LEVEL_HINTS = new Set(['image', 'backgroundVideo'])

// Short labels for stepper display
const STEP_SHORT_LABELS: Record<string, string> = {
  'Import': 'Import',
  'Canny': 'Canny',
  'Point 0 Contour': 'Point 0',
  'Tracking Point 0': 'Track P0',
  'Anchors Contour': 'Anchors',
  'Subdivision': 'Subdiv.',
  'Tracking Contour': 'Track Cont.',
  'Ancres Internes': 'Ancres Int.',
  'Tracking Ancres': 'Track Ancres',
  'Triangulation': 'Triangulation',
  'Code Editeur': 'Code',
}

type StepStatus = 'done' | 'active' | 'pending'

function getStepStatus(
  step: string,
  activeStep: string,
  mesh: MeshData | null,
  hasImage: boolean,
  hasVideo: boolean
): StepStatus {
  if (step === activeStep) return 'active'

  switch (step) {
    case 'Import':
      return hasImage && hasVideo ? 'done' : 'pending'
    case 'Canny':
      return mesh?.cannyParams != null ? 'done' : 'pending'
    case 'Point 0 Contour':
      return mesh?.contourOrigin != null ? 'done' : 'pending'
    case 'Tracking Point 0':
      return mesh?.contourOriginTrackingValidated ? 'done' : 'pending'
    case 'Anchors Contour':
      return (mesh?.contourAnchors?.length ?? 0) > 0 ? 'done' : 'pending'
    case 'Subdivision':
      return mesh?.contourSubdivisionValidated ? 'done' : 'pending'
    case 'Tracking Contour':
      return mesh?.contourAnchorTrackingValidated ? 'done' : 'pending'
    case 'Ancres Internes':
      return (mesh?.anchorPoints?.length ?? 0) > 0 ? 'done' : 'pending'
    case 'Tracking Ancres':
      return mesh?.anchorTrackingValidated ? 'done' : 'pending'
    case 'Triangulation':
      return mesh?.videoFramesMesh != null ? 'done' : 'pending'
    case 'Code Editeur':
      return mesh?.videoFramesMesh != null ? 'done' : 'pending'
    default:
      return 'pending'
  }
}

export default function AdminPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const { project, loading, save } = useProject(projectId!)
  const [activeStep, setActiveStep] = useState<Step>('Import')
  const [selectedAnimationId, setSelectedAnimationId] = useState<string>('')

  // Initialize selectedAnimationId from first animation
  if (project && !selectedAnimationId && project.animations.length > 0) {
    setSelectedAnimationId(project.animations[0].id)
  }

  const selectedAnim = project?.animations.find(a => a.id === selectedAnimationId)
  const isRestAnim = selectedAnim?.type === 'rest'
  const isPhysicsAnim = selectedAnim?.type === 'physics'

  // Steps available for the current animation type
  const availableSteps = isRestAnim ? REST_STEPS : isPhysicsAnim ? PHYSICS_STEPS : ONESHOT_STEPS

  // If current step isn't available for this animation type, reset to first available step
  if (!availableSteps.includes(activeStep as never)) {
    setActiveStep(availableSteps[0] as Step)
  }

  // Build a ProjectStepView for step components (adapter pattern)
  const stepView = useMemo((): ProjectStepView | null => {
    if (!project || !selectedAnim) return null
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      originalImageBlob: project.originalImageBlob,
      backgroundVideoBlob: project.backgroundVideoBlob,
      markers: project.markers,
      videoBlob: selectedAnim.videoBlob,
      mesh: selectedAnim.mesh,
    }
  }, [project, selectedAnim])

  // Wrap save: merge step view changes back into project, scope upload hints
  const stepSave = useCallback(async (updated: ProjectStepView, hints?: StepUploadHint[]) => {
    if (!project || !selectedAnimationId) return

    // Detect which fields changed on the mesh
    const updatedMesh = updated.mesh
    const currentAnim = project.animations.find(a => a.id === selectedAnimationId)

    // Check if shared geometry fields changed (only on rest animation)
    let geometryChanged = false
    if (isRestAnim && updatedMesh && currentAnim?.mesh) {
      for (const key of SHARED_GEOMETRY_FIELDS) {
        if (updatedMesh[key] !== currentAnim.mesh[key]) {
          geometryChanged = true
          break
        }
      }
    }

    // Update the selected animation's video + mesh
    let newAnims = project.animations.map(a => {
      if (a.id === selectedAnimationId) {
        return { ...a, videoBlob: updated.videoBlob, mesh: updatedMesh }
      }
      return a
    })

    // Propagate shared geometry to other animations if rest geometry changed
    if (geometryChanged && updatedMesh) {
      const shared = copySharedGeometry(updatedMesh)
      newAnims = newAnims.map(a => {
        if (a.id === selectedAnimationId) return a
        if (!a.mesh) return a
        return {
          ...a,
          mesh: {
            ...a.mesh,
            ...shared,
            // Invalidate tracking since geometry changed
            contourOriginTrackingValidated: false,
            contourOriginFrames: null,
            contourOriginKeyframes: [],
            contourAnchorTrackingValidated: false,
            contourAnchorFrames: null,
            contourAnchorKeyframes: [],
            contourSubdivisionFrames: null,
            contourSubdivisionValidated: false,
            contourCannyFrames: null,
            anchorTrackingValidated: false,
            anchorFrames: null,
            anchorKeyframes: [],
            videoFramesMesh: null,
          },
        }
      })
      const otherCount = newAnims.length - 1
      if (otherCount > 0) {
        console.log(`[AnimSync] Geometry propagated to ${otherCount} other animation(s), tracking invalidated`)
      }
    }

    // Convert step hints to scoped upload hints
    const scopedHints: UploadHint[] | undefined = hints?.map(h => {
      if (PROJECT_LEVEL_HINTS.has(h)) return h as UploadHint
      return { animationId: selectedAnimationId, field: h as import('../db/projectsStore').AnimationUploadField }
    })

    // Merge back into project
    const updatedProject: Project = {
      ...project,
      originalImageBlob: updated.originalImageBlob,
      backgroundVideoBlob: updated.backgroundVideoBlob,
      markers: updated.markers,
      animations: newAnims,
    }

    await save(updatedProject, scopedHints)
  }, [project, selectedAnimationId, isRestAnim, save])

  // Preview panel toggle + resizable splitter
  const [previewVisible, setPreviewVisible] = useState(true)
  const [previewRatio, setPreviewRatio] = useState(33.3) // % of total width for preview
  const splitterRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  // Drag-to-resize splitter
  useEffect(() => {
    const splitter = splitterRef.current
    const page = pageRef.current
    if (!splitter || !page) return

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMouseMove = (e: MouseEvent) => {
        const rect = page.getBoundingClientRect()
        const x = e.clientX - rect.left
        const pct = ((rect.width - x) / rect.width) * 100
        setPreviewRatio(Math.max(15, Math.min(60, pct)))
      }

      const onMouseUp = () => {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    }

    splitter.addEventListener('mousedown', onMouseDown)
    return () => splitter.removeEventListener('mousedown', onMouseDown)
  }, [previewVisible, loading])

  if (loading) return <div className="loading">Chargement du projet...</div>
  if (!project) return <Navigate to="/" replace />

  const restAnimForPreview = project.animations.find(a => a.type === 'rest')
  const canPreview = restAnimForPreview?.mesh?.videoFramesMesh != null
    && restAnimForPreview.mesh.videoFramesMesh.length > 0

  return (
    <div className="admin-page" ref={pageRef}>
      <div className="admin-left-panel" style={previewVisible ? { flex: `0 0 ${100 - previewRatio}%` } : undefined}>
        <div className="admin-header">
          <h2>{project.name} — Administration</h2>
          <div className="admin-header-actions">
            <button className="btn-secondary" onClick={() => setPreviewVisible(v => !v)}>
              {previewVisible ? 'Masquer preview' : 'Afficher preview'}
            </button>
          </div>
        </div>

        <div className="admin-section-row">
          <section className="anim-manager-section">
            <div className="anim-manager-section-header">
              <div className="anim-manager-section-label">Animations</div>
            </div>
            <AnimationManager
              project={project}
              selectedAnimationId={selectedAnimationId}
              onSelectAnimation={setSelectedAnimationId}
              onSave={save}
            />
          </section>

          {project.originalImageBlob && (
            <button
              className="pdf-download-card"
              onClick={async () => {
                try {
                  const blob = await generateTemplatePDF({
                    ...project,
                    videoBlob: selectedAnim?.videoBlob ?? null,
                    mesh: selectedAnim?.mesh ?? null,
                  })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `${project.name}-template.pdf`
                  a.click()
                  URL.revokeObjectURL(url)
                } catch (err) {
                  console.error('PDF generation failed:', err)
                }
              }}
            >
              <svg className="pdf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M9 15v-2h1.5a1.5 1.5 0 0 1 0 3H9z" />
              </svg>
              <span className="pdf-download-label">PDF</span>
            </button>
          )}

          <Link to={`/scan/${project.id}`} className="scan-card">
            <svg className="scan-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            <span className="scan-card-label">Scanner</span>
          </Link>
        </div>

        <nav className="pipeline-stepper">
          {availableSteps.map((step, i) => {
            const status = getStepStatus(
              step,
              activeStep,
              selectedAnim?.mesh ?? null,
              project.originalImageBlob != null,
              selectedAnim?.videoBlob != null
            )
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
                    {STEP_SHORT_LABELS[step] || step}
                  </span>
                </span>
                {i < availableSteps.length - 1 && (
                  <span className="pipeline-step-connector" />
                )}
              </button>
            )
          })}
        </nav>

        {stepView && (
          <div className="admin-content">
            {activeStep === 'Import' && (
              <ImportStep project={stepView} onSave={stepSave} isRestAnimation={isRestAnim} />
            )}
            {activeStep === 'Canny' && (
              <CannyValidationStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Point 0 Contour' && (
              <ContourOriginStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Tracking Point 0' && (
              <ContourOriginTrackingStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Anchors Contour' && (
              <ContourAnchorsStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Subdivision' && (
              <ContourSubdivisionStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Tracking Contour' && (
              <ContourTrackingStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Ancres Internes' && (
              <AnchorPointsStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Tracking Ancres' && (
              <AnchorTrackingStep project={stepView} onSave={stepSave} />
            )}
            {activeStep === 'Triangulation' && (
              <TriangulationStep project={stepView} onSave={stepSave} isRestAnimation={isRestAnim} />
            )}
            {activeStep === 'Code Editeur' && selectedAnim && (
              <PhysicsAnimationEditor
                project={project}
                animation={selectedAnim}
                onSave={save}
              />
            )}
          </div>
        )}
      </div>

      {previewVisible && (
        <>
          <div className="admin-splitter" ref={splitterRef} />
          {canPreview ? (
            <AdminPreview project={project} style={{ flex: `0 0 ${previewRatio}%` }} />
          ) : (
            <div className="admin-preview-panel" style={{ flex: `0 0 ${previewRatio}%` }}>
              <div className="preview-placeholder">
                Validez l'animation rest (triangulation + calcul animation) pour activer l'apercu
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
