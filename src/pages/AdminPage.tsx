import { useState, useCallback, useMemo } from 'react'
import { useParams, Navigate, Link } from 'react-router-dom'
import { useProject } from '../hooks/useProject'
import type { Project, ProjectStepView } from '../types/project'
import type { UploadHint, StepUploadHint } from '../db/projectsStore'
import AnimationManager, { SHARED_GEOMETRY_FIELDS, copySharedGeometry } from '../components/admin/AnimationManager'
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

type Step = (typeof REST_STEPS)[number]

const PROJECT_LEVEL_HINTS = new Set(['image', 'backgroundVideo'])

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

  // Steps available for the current animation type
  const availableSteps = isRestAnim ? REST_STEPS : ONESHOT_STEPS

  // If current step isn't available for this animation type, reset to Import
  if (!availableSteps.includes(activeStep as never)) {
    setActiveStep('Import')
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

      <AnimationManager
        project={project}
        selectedAnimationId={selectedAnimationId}
        onSelectAnimation={setSelectedAnimationId}
        onSave={save}
      />

      <nav className="admin-tabs">
        {availableSteps.map(step => (
          <button
            key={step}
            className={`tab ${activeStep === step ? 'active' : ''}`}
            onClick={() => setActiveStep(step)}
          >
            {step}
          </button>
        ))}
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
        </div>
      )}
    </div>
  )
}
