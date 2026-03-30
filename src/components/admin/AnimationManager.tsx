import { useState } from 'react'
import type { Project, Animation, AnimationType, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'

interface Props {
  project: Project
  selectedAnimationId: string
  onSelectAnimation: (id: string) => void
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

/** Geometry fields shared across all animations (defined on rest, copied to others) */
const SHARED_GEOMETRY_FIELDS: (keyof MeshData)[] = [
  'contourOrigin',
  'contourAnchors',
  'contourSubdivisionPoints',
  'contourSubdivisionParams',
  'anchorPoints',
  'internalPoints',
  'triangles',
  'topologyLocked',
  'trackedTriangles',
  'internalBarycentrics',
]

function copySharedGeometry(source: MeshData): Partial<MeshData> {
  const result: Record<string, unknown> = {}
  for (const key of SHARED_GEOMETRY_FIELDS) {
    const val = source[key]
    result[key] = Array.isArray(val) ? [...val] : val
  }
  return result as Partial<MeshData>
}

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
    videoFramesMesh: null,
  }
}

export default function AnimationManager({ project, selectedAnimationId, onSelectAnimation, onSave }: Props) {
  const [editingNameId, setEditingNameId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)

  const restAnim = project.animations.find(a => a.type === 'rest')

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

  async function handleAddOneshot() {
    const newAnim: Animation = {
      id: crypto.randomUUID(),
      name: `Animation ${project.animations.length + 1}`,
      type: 'oneshot',
      createdAt: Date.now(),
      videoBlob: null,
      mesh: restAnim?.mesh ? { ...createEmptyMesh(), ...copySharedGeometry(restAnim.mesh) } : null,
      physicsCode: null,
      physicsDuration: null,
      physicsOverlay: false,
    }
    const updated = { ...project, animations: [...project.animations, newAnim] }
    setSaving(true)
    await onSave(updated)
    setSaving(false)
    onSelectAnimation(newAnim.id)
  }

  async function handleAddPhysics() {
    const newAnim: Animation = {
      id: crypto.randomUUID(),
      name: `Physics ${project.animations.filter(a => a.type === 'physics').length + 1}`,
      type: 'physics',
      createdAt: Date.now(),
      videoBlob: null,
      mesh: restAnim?.mesh ? { ...createEmptyMesh(), ...copySharedGeometry(restAnim.mesh) } : null,
      physicsCode: DEFAULT_PHYSICS_CODE,
      physicsDuration: 2,
      physicsOverlay: false,
    }
    const updated = { ...project, animations: [...project.animations, newAnim] }
    setSaving(true)
    await onSave(updated)
    setSaving(false)
    onSelectAnimation(newAnim.id)
  }

  async function handleDelete(animId: string) {
    const anim = project.animations.find(a => a.id === animId)
    if (!anim) return
    if (anim.type === 'rest') {
      alert('Impossible de supprimer la rest animation.')
      return
    }
    if (!confirm(`Supprimer "${anim.name}" ?`)) return
    const updated = { ...project, animations: project.animations.filter(a => a.id !== animId) }
    setSaving(true)
    await onSave(updated)
    setSaving(false)
    if (selectedAnimationId === animId) {
      onSelectAnimation(project.animations.find(a => a.id !== animId)!.id)
    }
  }

  async function handleToggleType(animId: string) {
    const anim = project.animations.find(a => a.id === animId)
    if (!anim) return
    const newType: AnimationType = anim.type === 'rest' ? 'oneshot' : 'rest'
    // Enforce exactly one rest
    const newAnims = project.animations.map(a => {
      if (a.id === animId) return { ...a, type: newType }
      if (newType === 'rest' && a.type === 'rest') return { ...a, type: 'oneshot' as AnimationType }
      return a
    })
    setSaving(true)
    await onSave({ ...project, animations: newAnims })
    setSaving(false)
  }

  function startRename(anim: Animation) {
    setEditingNameId(anim.id)
    setEditName(anim.name)
  }

  async function confirmRename(animId: string) {
    if (!editName.trim()) return
    const newAnims = project.animations.map(a =>
      a.id === animId ? { ...a, name: editName.trim() } : a
    )
    setSaving(true)
    await onSave({ ...project, animations: newAnims })
    setSaving(false)
    setEditingNameId(null)
  }

  return (
    <div className="anim-manager">
      {project.animations.map(anim => {
        const isSelected = anim.id === selectedAnimationId
        const isEditing = editingNameId === anim.id
        return (
          <div
            key={anim.id}
            className={`anim-pill ${isSelected ? 'selected' : ''}`}
            onClick={() => !isEditing && onSelectAnimation(anim.id)}
          >
            <span
              className={`anim-pill-dot ${anim.type}`}
              title={anim.type === 'rest' ? 'Rest (boucle)' : anim.type === 'physics' ? 'Physics (code)' : 'One-shot'}
            />
            {isEditing ? (
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmRename(anim.id); if (e.key === 'Escape') setEditingNameId(null) }}
                onBlur={() => confirmRename(anim.id)}
                autoFocus
                style={{ width: 100, fontSize: '0.9em' }}
                onClick={e => e.stopPropagation()}
              />
            ) : (
              <span onDoubleClick={(e) => { e.stopPropagation(); startRename(anim) }}>
                {anim.name}
              </span>
            )}
            {isSelected && (
              <span className="anim-pill-actions">
                {anim.type !== 'physics' && (
                  <button
                    onClick={e => { e.stopPropagation(); handleToggleType(anim.id) }}
                    title={anim.type === 'rest' ? 'Passer en oneshot' : 'Définir comme rest'}
                    disabled={saving}
                  >
                    {anim.type === 'rest' ? '∞' : '▶'}
                  </button>
                )}
                {anim.type !== 'rest' && (
                  <button
                    className="btn-delete"
                    onClick={e => { e.stopPropagation(); handleDelete(anim.id) }}
                    title="Supprimer"
                    disabled={saving}
                  >
                    ✕
                  </button>
                )}
              </span>
            )}
          </div>
        )
      })}
      <button
        className="anim-add-btn btn-ghost"
        onClick={handleAddOneshot}
        disabled={saving}
        title="Ajouter une animation oneshot (vidéo)"
      >
        + Oneshot
      </button>
      <button
        className="anim-add-btn btn-ghost physics"
        onClick={handleAddPhysics}
        disabled={saving}
        title="Ajouter une animation physique (code)"
      >
        + Physics
      </button>
    </div>
  )
}

export { SHARED_GEOMETRY_FIELDS, copySharedGeometry }
