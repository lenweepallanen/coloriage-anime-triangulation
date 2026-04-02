import { useState, useMemo, useCallback } from 'react'
import { useAdminContext } from './AdminLayout'
import type { ProjectStepView } from '../../types/project'
import type { UploadHint, StepUploadHint, AnimationUploadField } from '../../db/projectsStore'
import AnimationCardList, { SHARED_GEOMETRY_FIELDS, copySharedGeometry } from '../../components/admin/AnimationCardList'
import PipelineEditor from '../../components/admin/PipelineEditor'
import PreviewModal from '../../components/admin/PreviewModal'

const PROJECT_LEVEL_HINTS = new Set(['image', 'backgroundVideo', 'ambientSound', 'sceneBackgroundLayer0', 'sceneBackgroundLayer1', 'sceneBackgroundLayer2'])

export default function AnimationsSection() {
  const { project, save, canPreview } = useAdminContext()
  const [editingAnimationId, setEditingAnimationId] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)

  const selectedAnim = editingAnimationId
    ? project.animations.find(a => a.id === editingAnimationId) ?? null
    : null

  const isRestAnim = selectedAnim?.type === 'rest'

  // Build ProjectStepView (adapter pattern)
  const stepView = useMemo((): ProjectStepView | null => {
    if (!selectedAnim) return null
    return {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      originalImageBlob: project.originalImageBlob,
      backgroundVideoBlob: project.backgroundVideoBlob,
      ambientSoundBlob: project.ambientSoundBlob,
      ambientSoundEnabled: project.ambientSoundEnabled,
      markers: project.markers,
      videoBlob: selectedAnim.videoBlob,
      mesh: selectedAnim.mesh,
      audioBlob: selectedAnim.audioBlob,
      audioEnabled: selectedAnim.audioEnabled,
    }
  }, [project, selectedAnim])

  // Wrap save: merge step view changes back into project, scope upload hints
  const stepSave = useCallback(async (updated: ProjectStepView, hints?: StepUploadHint[]) => {
    if (!editingAnimationId) return

    const updatedMesh = updated.mesh
    const currentAnim = project.animations.find(a => a.id === editingAnimationId)

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
      if (a.id === editingAnimationId) {
        return { ...a, videoBlob: updated.videoBlob, mesh: updatedMesh, audioBlob: updated.audioBlob, audioEnabled: updated.audioEnabled }
      }
      return a
    })

    // Propagate shared geometry to other animations if rest geometry changed
    if (geometryChanged && updatedMesh) {
      const shared = copySharedGeometry(updatedMesh)
      newAnims = newAnims.map(a => {
        if (a.id === editingAnimationId) return a
        if (!a.mesh) return a
        return {
          ...a,
          mesh: {
            ...a.mesh,
            ...shared,
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
            bonesValidated: false,
            boneWeights: null,
            videoFramesMesh: null,
          },
        }
      })
      const otherCount = newAnims.length - 1
      if (otherCount > 0) {
        console.log(`[AnimSync] Geometry propagated to ${otherCount} other animation(s), tracking invalidated`)
      }
      // Clear body zones when geometry changes (vertex indices become stale)
      if (project.bodyZones.length > 0) {
        console.log('[AnimSync] Body zones cleared due to geometry change')
      }
    }

    // Convert step hints to scoped upload hints
    const scopedHints: UploadHint[] | undefined = hints?.map(h => {
      if (PROJECT_LEVEL_HINTS.has(h)) return h as UploadHint
      return { animationId: editingAnimationId, field: h as AnimationUploadField }
    })

    const updatedProject = {
      ...project,
      originalImageBlob: updated.originalImageBlob,
      backgroundVideoBlob: updated.backgroundVideoBlob,
      ambientSoundBlob: updated.ambientSoundBlob,
      ambientSoundEnabled: updated.ambientSoundEnabled,
      markers: updated.markers,
      animations: newAnims,
      ...(geometryChanged && { bodyZones: [] }),
    }

    await save(updatedProject, scopedHints)
  }, [project, editingAnimationId, isRestAnim, save])

  // Editing a specific animation's pipeline
  if (selectedAnim && stepView) {
    return (
      <div className="animations-section">
        <div className="animations-section-back-row">
          <button className="btn-ghost" onClick={() => setEditingAnimationId(null)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
              <path d="M19 12H5" />
              <polyline points="12 19 5 12 12 5" />
            </svg>
            Retour aux animations
          </button>
          <span className="animations-section-editing-label">
            <span className={`anim-card-badge anim-card-badge--${selectedAnim.type}`}>
              {selectedAnim.type}
            </span>
            {selectedAnim.name}
          </span>
          {canPreview && (
            <button className="btn-secondary" onClick={() => setPreviewOpen(true)}>
              Preview
            </button>
          )}
        </div>
        <PipelineEditor
          project={project}
          animation={selectedAnim}
          stepView={stepView}
          stepSave={stepSave}
          projectSave={save}
        />
        <PreviewModal project={project} open={previewOpen} onClose={() => setPreviewOpen(false)} />
      </div>
    )
  }

  // Animation list view
  return (
    <div className="animations-section">
      <div className="animations-section-header">
        <h3>Animations</h3>
        {canPreview && (
          <button className="btn-secondary" onClick={() => setPreviewOpen(true)}>
            Preview
          </button>
        )}
      </div>
      <AnimationCardList
        project={project}
        onSave={save}
        onEditAnimation={setEditingAnimationId}
      />
      <PreviewModal project={project} open={previewOpen} onClose={() => setPreviewOpen(false)} />
    </div>
  )
}
