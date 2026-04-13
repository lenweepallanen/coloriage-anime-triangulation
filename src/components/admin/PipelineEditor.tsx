import { useState } from 'react'
import type { Project, ProjectStepView, MeshData, Animation } from '../../types/project'
import type { UploadHint, StepUploadHint } from '../../db/projectsStore'
import ImportStep from './ImportStep'
import CannyValidationStep from './CannyValidationStep'
import ContourOriginStep from './ContourOriginStep'
import ContourOriginTrackingStep from './ContourOriginTrackingStep'
import ContourAnchorsStep from './ContourAnchorsStep'
import ContourSubdivisionStep from './ContourSubdivisionStep'
import ContourTrackingStep from './ContourTrackingStep'
import AnchorPointsStep from './AnchorPointsStep'
import AnchorTrackingStep from './AnchorTrackingStep'
import TriangulationStep from './TriangulationStep'
import PhysicsAnimationEditor from './PhysicsAnimationEditor'
import BoneEditorStep from './BoneEditorStep'
import BoneTriangulationStep from './BoneTriangulationStep'
import WalkLimbEditorStep from './WalkLimbEditorStep'
import WalkZoneMeshStep from './WalkZoneMeshStep'
import WalkBoneEditorStep from './WalkBoneEditorStep'
import WalkParamsStep from './WalkParamsStep'
import WalkComputeStep from './WalkComputeStep'
import WalkHiddenFaceStep from './WalkHiddenFaceStep'
import MembersBonesZonesStep from './MembersBonesZonesStep'
import MembersBonesContourSmoothStep from './MembersBonesContourSmoothStep'
import MembersBonesContourOriginStep from './MembersBonesContourOriginStep'
import MembersBonesContourOriginTrackingStep from './MembersBonesContourOriginTrackingStep'
import MembersBonesContourAnchorsStep from './MembersBonesContourAnchorsStep'
import MembersBonesContourSubdivisionStep from './MembersBonesContourSubdivisionStep'
import MembersBonesContourAnchorTrackingStep from './MembersBonesContourAnchorTrackingStep'
import MembersBonesBoneStep from './MembersBonesBoneStep'
import MembersBonesSmoothingStep from './MembersBonesSmoothingStep'

const REST_STEPS = [
  'Vidéo', 'Canny', 'Point 0 Contour', 'Tracking Point 0',
  'Anchors Contour', 'Subdivision', 'Tracking Contour',
  'Ancres Internes', 'Tracking Ancres', 'Triangulation',
] as const

const ONESHOT_STEPS = [
  'Vidéo', 'Canny', 'Tracking Point 0',
  'Tracking Contour', 'Tracking Ancres', 'Triangulation',
] as const

const BONE_STEPS = [
  'Vidéo', 'Canny', 'Tracking Point 0',
  'Tracking Contour', 'Tracking Ancres', 'Bones', 'Triangulation',
] as const

const PHYSICS_STEPS = ['Code Editeur'] as const

const WALK_STEPS = ['Zones membres', 'Maillage zones', 'Face cachée', 'Bones marche', 'Paramètres', 'Calcul'] as const

const MEMBERS_BONES_STEPS = [
  'Vidéo',
  'Définir Zones',
  'Lissage Contours',
  'P0 par zone',
  'Tracking P0 zones',
  'Anchors par zone',
  'Subdivision par zone',
  'Tracking Anchors zones',
  'Bones par zone',
  'Lissage Bones',
] as const

type Step = (typeof REST_STEPS)[number] | (typeof PHYSICS_STEPS)[number] | (typeof BONE_STEPS)[number] | (typeof WALK_STEPS)[number] | (typeof MEMBERS_BONES_STEPS)[number]

const STEP_SHORT_LABELS: Record<string, string> = {
  'Vidéo': 'Vidéo',
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
  'Bones': 'Bones',
  'Zones membres': 'Zones',
  'Maillage zones': 'Maillage',
  'Bones marche': 'Bones',
  'Paramètres': 'Paramètres',
  'Face cachée': 'Face cachée',
  'Calcul': 'Calcul',
  'Définir Zones': 'Zones',
  'Lissage Contours': 'Lissage',
  'P0 par zone': 'P0',
  'Tracking P0 zones': 'Track P0',
  'Anchors par zone': 'Anchors',
  'Subdivision par zone': 'Subdiv.',
  'Tracking Anchors zones': 'Track Anc.',
  'Bones par zone': 'Bones',
  'Lissage Bones': 'Lissage',
}

type StepStatus = 'done' | 'active' | 'pending'

function getStepStatus(step: string, activeStep: string, mesh: MeshData | null, hasVideo: boolean): StepStatus {
  if (step === activeStep) return 'active'
  switch (step) {
    case 'Vidéo': return hasVideo ? 'done' : 'pending'
    case 'Canny': return mesh?.cannyParams != null ? 'done' : 'pending'
    case 'Point 0 Contour': return mesh?.contourOrigin != null ? 'done' : 'pending'
    case 'Tracking Point 0': return mesh?.contourOriginTrackingValidated ? 'done' : 'pending'
    case 'Anchors Contour': return (mesh?.contourAnchors?.length ?? 0) > 0 ? 'done' : 'pending'
    case 'Subdivision': return mesh?.contourSubdivisionValidated ? 'done' : 'pending'
    case 'Tracking Contour': return mesh?.contourAnchorTrackingValidated ? 'done' : 'pending'
    case 'Ancres Internes': return (mesh?.anchorPoints?.length ?? 0) > 0 ? 'done' : 'pending'
    case 'Tracking Ancres': return mesh?.anchorTrackingValidated ? 'done' : 'pending'
    case 'Triangulation': return mesh?.videoFramesMesh != null ? 'done' : 'pending'
    case 'Bones': return mesh?.bonesValidated ? 'done' : 'pending'
    case 'Code Editeur': return mesh?.videoFramesMesh != null ? 'done' : 'pending'
    case 'Zones membres': return mesh?.walkLimbSeparationValidated ? 'done' : 'pending'
    case 'Maillage zones': return mesh?.walkLimbSeparationValidated ? 'done' : 'pending'
    case 'Face cachée': return mesh?.walkHiddenFaceValidated ? 'done' : 'pending'
    case 'Bones marche': return mesh?.walkSkeletonValidated ? 'done' : 'pending'
    case 'Paramètres': return mesh?.walkParamsValidated ? 'done' : 'pending'
    case 'Calcul': return (mesh?.videoFramesMesh != null || mesh?.walkZoneFrames != null) ? 'done' : 'pending'
    case 'Définir Zones': return mesh?.sam2Validated ? 'done' : 'pending'
    case 'Lissage Contours': return mesh?.sam2ContoursValidated ? 'done' : 'pending'
    case 'P0 par zone': return allZonesFilled(mesh, mesh?.sam2ContourOrigins) ? 'done' : 'pending'
    case 'Tracking P0 zones': return mesh?.sam2ContourOriginTrackingValidated ? 'done' : 'pending'
    case 'Anchors par zone': return allZonesFilled(mesh, mesh?.sam2ContourAnchors) ? 'done' : 'pending'
    case 'Subdivision par zone': return mesh?.sam2ContourSubdivisionValidated ? 'done' : 'pending'
    case 'Tracking Anchors zones': return mesh?.sam2ContourAnchorTrackingValidated ? 'done' : 'pending'
    case 'Bones par zone': return mesh?.sam2BonesValidated ? 'done' : 'pending'
    case 'Lissage Bones': return mesh?.sam2SmoothingValidated ? 'done' : 'pending'
    default: return 'pending'
  }
}

/** Check that the given Record has an entry for every zoneId defined in mesh.sam2Zones. */
function allZonesFilled(mesh: MeshData | null, record: Record<string, unknown> | undefined): boolean {
  if (!mesh?.sam2Zones || mesh.sam2Zones.length === 0) return false
  if (!record) return false
  return mesh.sam2Zones.every(z => record[z.id] != null)
}

/** Count how many steps are "done" for a given animation */
export function getAnimationCompletionStatus(animation: Animation): { done: number; total: number } {
  const steps = animation.type === 'rest' ? REST_STEPS
    : animation.type === 'physics' ? PHYSICS_STEPS
    : animation.type === 'bone' ? BONE_STEPS
    : animation.type === 'walk' ? WALK_STEPS
    : animation.type === 'members-bones' ? MEMBERS_BONES_STEPS
    : ONESHOT_STEPS
  const mesh = animation.mesh
  const hasVideo = animation.videoBlob != null
  let done = 0
  for (const step of steps) {
    if (getStepStatus(step, '', mesh, hasVideo) === 'done') done++
  }
  return { done, total: steps.length }
}

interface Props {
  project: Project
  animation: Animation
  stepView: ProjectStepView
  stepSave: (updated: ProjectStepView, hints?: StepUploadHint[]) => Promise<void>
  projectSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function PipelineEditor({ project, animation, stepView, stepSave, projectSave }: Props) {
  const isRestAnim = animation.type === 'rest'
  const isPhysicsAnim = animation.type === 'physics'
  const isBoneAnim = animation.type === 'bone'
  const isWalkAnim = animation.type === 'walk'
  const isMembersBonesAnim = animation.type === 'members-bones'
  const availableSteps = isRestAnim ? REST_STEPS
    : isPhysicsAnim ? PHYSICS_STEPS
    : isBoneAnim ? BONE_STEPS
    : isWalkAnim ? WALK_STEPS
    : isMembersBonesAnim ? MEMBERS_BONES_STEPS
    : ONESHOT_STEPS
  const [activeStep, setActiveStep] = useState<Step>(availableSteps[0] as Step)

  // Reset step if not available for this animation type
  if (!availableSteps.includes(activeStep as never)) {
    setActiveStep(availableSteps[0] as Step)
  }

  return (
    <div className="pipeline-editor">
      <nav className="pipeline-stepper">
        {availableSteps.map((step, i) => {
          const status = getStepStatus(step, activeStep, animation.mesh, animation.videoBlob != null)
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

      <div className="admin-content">
        {activeStep === 'Vidéo' && (
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
        {activeStep === 'Bones' && (
          <BoneEditorStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Triangulation' && !isBoneAnim && (
          <TriangulationStep project={stepView} onSave={stepSave} isRestAnimation={isRestAnim} />
        )}
        {activeStep === 'Triangulation' && isBoneAnim && (
          <BoneTriangulationStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Code Editeur' && (
          <PhysicsAnimationEditor
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Zones membres' && (
          <WalkLimbEditorStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Maillage zones' && (
          <WalkZoneMeshStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Face cachée' && (
          <WalkHiddenFaceStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Bones marche' && (
          <WalkBoneEditorStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Paramètres' && (
          <WalkParamsStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Calcul' && (
          <WalkComputeStep
            project={project}
            animation={animation}
            onSave={projectSave}
          />
        )}
        {activeStep === 'Définir Zones' && (
          <MembersBonesZonesStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Lissage Contours' && (
          <MembersBonesContourSmoothStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'P0 par zone' && (
          <MembersBonesContourOriginStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Tracking P0 zones' && (
          <MembersBonesContourOriginTrackingStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Anchors par zone' && (
          <MembersBonesContourAnchorsStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Subdivision par zone' && (
          <MembersBonesContourSubdivisionStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Tracking Anchors zones' && (
          <MembersBonesContourAnchorTrackingStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Bones par zone' && (
          <MembersBonesBoneStep project={stepView} onSave={stepSave} />
        )}
        {activeStep === 'Lissage Bones' && (
          <MembersBonesSmoothingStep project={stepView} onSave={stepSave} />
        )}
      </div>
    </div>
  )
}
