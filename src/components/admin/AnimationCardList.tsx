import { useState } from 'react'
import type { Project, Animation, AnimationType, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import AnimationCard from './AnimationCard'
import { getAnimationCompletionStatus } from './PipelineEditor'

const SHARED_GEOMETRY_FIELDS: (keyof MeshData)[] = [
  'contourOrigin', 'contourAnchors', 'contourSubdivisionPoints',
  'contourSubdivisionParams', 'anchorPoints', 'internalPoints',
  'triangles', 'topologyLocked', 'trackedTriangles', 'internalBarycentrics',
]

export function copySharedGeometry(source: MeshData): Partial<MeshData> {
  const result: Record<string, unknown> = {}
  for (const key of SHARED_GEOMETRY_FIELDS) {
    const val = source[key]
    result[key] = Array.isArray(val) ? [...val] : val
  }
  return result as Partial<MeshData>
}

export { SHARED_GEOMETRY_FIELDS }

function createEmptyMesh(): MeshData {
  return {
    cannyParams: null,
    contourOrigin: null,
    contourOriginKeyframeInterval: 10,
    contourOriginKeyframes: [],
    contourOriginFrames: null,
    contourOriginTrackingValidated: false,
    contourAnchors: [],
    contourAnchorKeyframeInterval: 10,
    contourAnchorKeyframes: [],
    contourAnchorFrames: null,
    contourAnchorTrackingValidated: false,
    contourSubdivisionPoints: [],
    contourSubdivisionParams: [],
    contourSubdivisionFrames: null,
    contourSubdivisionValidated: false,
    contourCannyFrames: null,
    anchorPoints: [],
    anchorKeyframeInterval: 10,
    anchorKeyframes: [],
    anchorFrames: null,
    anchorTrackingValidated: false,
    internalPoints: [],
    triangles: [],
    topologyLocked: false,
    trackedTriangles: [],
    internalBarycentrics: [],
    bones: [],
    boneWeights: null,
    bonesValidated: false,
    walkLimbSeparation: null,
    walkLimbSeparationValidated: false,
    walkSkeleton: null,
    walkSkeletonValidated: false,
    walkBodyTriangles: [],
    walkBodyValidated: false,
    walkParams: null,
    walkParamsValidated: false,
    videoFramesMesh: null,
    walkZoneFrames: null,
    walkBodyFrames: null,
  }
}

const DEFAULT_PHYSICS_CODE = `// Tourbillon — modifiez ce code !
const cx = 300, cy = 300;
const angle = progress * Math.PI * 4;
const strength = Math.sin(progress * Math.PI) * 20;
for (let i = 0; i < numVertices; i++) {
  const dx = positions[i].x - cx;
  const dy = positions[i].y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const falloff = Math.exp(-dist / 200);
  const a = angle * falloff;
  positions[i].x += Math.sin(a) * strength * falloff;
  positions[i].y += Math.cos(a) * strength * falloff;
}`

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
  onEditAnimation: (animId: string) => void
}

export default function AnimationCardList({ project, onSave, onEditAnimation }: Props) {
  const [saving, setSaving] = useState(false)
  const restAnim = project.animations.find(a => a.type === 'rest')

  async function handleAdd(type: 'oneshot' | 'physics' | 'bone' | 'walk' | 'members-bones' | 'members-bones-v2' | 'members-bones-v3') {
    const isPhysics = type === 'physics'
    const isBone = type === 'bone'
    const isWalk = type === 'walk'
    const isMembersBones = type === 'members-bones'
    const isMembersBonesV2 = type === 'members-bones-v2'
    const isMembersBonesV3 = type === 'members-bones-v3'
    const name = isPhysics
      ? `Physics ${project.animations.filter(a => a.type === 'physics').length + 1}`
      : isBone
        ? `Bone ${project.animations.filter(a => a.type === 'bone').length + 1}`
        : isWalk
          ? `Walk ${project.animations.filter(a => a.type === 'walk').length + 1}`
          : isMembersBones
            ? `Members-Bones ${project.animations.filter(a => a.type === 'members-bones').length + 1}`
            : isMembersBonesV2
              ? `MB-V2 ${project.animations.filter(a => a.type === 'members-bones-v2').length + 1}`
              : isMembersBonesV3
                ? `MB-V3 ${project.animations.filter(a => a.type === 'members-bones-v3').length + 1}`
                : `Animation ${project.animations.length + 1}`
    // Members-bones (v1, v2, v3) sont autonomes : ne dépendent pas de la rest, n'héritent pas la géométrie
    const inheritedMesh = (isMembersBones || isMembersBonesV2 || isMembersBonesV3)
      ? createEmptyMesh()
      : (restAnim?.mesh ? { ...createEmptyMesh(), ...copySharedGeometry(restAnim.mesh) } : null)
    const newAnim: Animation = {
      id: crypto.randomUUID(),
      name,
      type,
      createdAt: Date.now(),
      videoBlob: null,
      mesh: inheritedMesh,
      physicsCode: isPhysics ? DEFAULT_PHYSICS_CODE : null,
      physicsDuration: isPhysics ? 2 : null,
      physicsOverlay: false,
      audioBlob: null,
      audioEnabled: false,
    }
    setSaving(true)
    await onSave({ ...project, animations: [...project.animations, newAnim] })
    setSaving(false)
  }

  async function handleDelete(animId: string) {
    const anim = project.animations.find(a => a.id === animId)
    if (!anim || anim.type === 'rest') return
    if (!confirm(`Supprimer "${anim.name}" ?`)) return
    setSaving(true)
    await onSave({ ...project, animations: project.animations.filter(a => a.id !== animId) })
    setSaving(false)
  }

  async function handleRename(animId: string, newName: string) {
    const newAnims = project.animations.map(a =>
      a.id === animId ? { ...a, name: newName } : a
    )
    setSaving(true)
    await onSave({ ...project, animations: newAnims })
    setSaving(false)
  }

  async function handleDuplicate(animId: string) {
    const source = project.animations.find(a => a.id === animId)
    if (!source) return
    const copy: Animation = {
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} (copie)`,
      createdAt: Date.now(),
      type: source.type === 'rest' ? 'oneshot' : source.type,
    }
    setSaving(true)
    await onSave({ ...project, animations: [...project.animations, copy] })
    setSaving(false)
  }

  async function handleSetAsRest(animId: string) {
    const newAnims = project.animations.map(a => {
      if (a.id === animId) return { ...a, type: 'rest' as AnimationType }
      if (a.type === 'rest') return { ...a, type: 'oneshot' as AnimationType }
      return a
    })
    setSaving(true)
    await onSave({ ...project, animations: newAnims })
    setSaving(false)
  }

  return (
    <div className="anim-card-list">
      <div className="anim-card-grid">
        {project.animations.map(anim => (
          <AnimationCard
            key={anim.id}
            animation={anim}
            completionStatus={getAnimationCompletionStatus(anim)}
            onEdit={() => onEditAnimation(anim.id)}
            onRename={(name) => handleRename(anim.id, name)}
            onDelete={() => handleDelete(anim.id)}
            onDuplicate={() => handleDuplicate(anim.id)}
            onSetAsRest={() => handleSetAsRest(anim.id)}
          />
        ))}
      </div>

      <div className="anim-card-add-row">
        <button className="btn-secondary" onClick={() => handleAdd('oneshot')} disabled={saving}>
          + Oneshot
        </button>
        <button className="btn-secondary" onClick={() => handleAdd('physics')} disabled={saving}>
          + Physics
        </button>
        <button className="btn-secondary" onClick={() => handleAdd('bone')} disabled={saving}>
          + Bone
        </button>
        <button className="btn-secondary" onClick={() => handleAdd('walk')} disabled={saving}>
          + Walk
        </button>
        <button className="btn-secondary" onClick={() => handleAdd('members-bones')} disabled={saving}>
          + Members-Bones
        </button>
        <button className="btn-secondary" onClick={() => handleAdd('members-bones-v2')} disabled={saving}>
          + MB V2
        </button>
        <button
          className="btn-secondary"
          onClick={() => handleAdd('members-bones-v3')}
          disabled={saving || !project.projectTriangulation?.step3Validated}
          title={
            project.projectTriangulation?.step3Validated
              ? 'Créer une animation Members-Bones V3 (topologie héritée de la Triangulation projet)'
              : 'Validez d\'abord la Triangulation projet jusqu\'à l\'étape Faces cachées (onglet Triangulation)'
          }
        >
          + MB V3
        </button>
      </div>
    </div>
  )
}
