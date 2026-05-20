import { useState } from 'react'
import type { Project, Animation, AnimationPlaybackMode, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import AnimationCard from './AnimationCard'
import { getAnimationCompletionStatus } from './PipelineEditor'
import { buildMarcheInheritSnapshot } from '../../utils/marcheSolver'

async function loadImageDimensions(blob: Blob | null): Promise<{ w: number; h: number } | null> {
  if (!blob) return null
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }) }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

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
  const [cotrackerInheritFrom, setCotrackerInheritFrom] = useState<string>('')
  const [marcheInheritFrom, setMarcheInheritFrom] = useState<string>('')
  const restAnim = project.animations.find(a => a.type === 'rest')

  // Sources d'héritage possibles pour cotracker-bones : animations du même type
  // ayant au moins des points CoTracker définis à frame 0 (l'étape "Points" est passée).
  const cotrackerSources = project.animations.filter(a =>
    a.type === 'cotracker-bones'
    && a.mesh?.cotrackerPoints
    && a.mesh.cotrackerPoints.length > 0
  )

  // Sources éligibles pour héritage marche : cotracker-bones avec bones validés
  // ET bone frames calculées (smoothed ou raw).
  const marcheSources = project.animations.filter(a =>
    a.type === 'cotracker-bones'
    && a.mesh?.cotrackerBonesValidated
    && a.mesh?.cotrackerSkeleton
    && (a.mesh.cotrackerBodyJointFrames
        || a.mesh.cotrackerBodyJointFramesSmoothed
        || a.mesh.cotrackerFrames)
  )

  async function handleAdd(type: 'oneshot' | 'physics' | 'cotracker-bones' | 'marche') {
    const isPhysics = type === 'physics'
    const isCoTrackerBones = type === 'cotracker-bones'
    const isMarche = type === 'marche'
    const defaultName = isPhysics
      ? `Animation Physique ${project.animations.filter(a => a.type === 'physics').length + 1}`
      : isCoTrackerBones
        ? `Animation par Vidéo ${project.animations.filter(a => a.type === 'cotracker-bones').length + 1}`
        : isMarche
          ? `Animation Marche ${project.animations.filter(a => a.type === 'marche').length + 1}`
          : `Animation par contour ${project.animations.filter(a => a.type === 'oneshot').length + 1}`
    const name = window.prompt('Nom de l\'animation :', defaultName)?.trim()
    if (!name) return
    let inheritedMesh: MeshData | null = (isCoTrackerBones || isMarche)
      ? createEmptyMesh()
      : (restAnim?.mesh ? { ...createEmptyMesh(), ...copySharedGeometry(restAnim.mesh) } : null)

    // Héritage Marche : squelette + rest positions depuis un cotracker-bones validé.
    // L'inheritance est obligatoire (sans elle, pas de squelette à animer).
    if (isMarche && inheritedMesh) {
      const parentId = marcheInheritFrom || marcheSources[0]?.id
      const parent = project.animations.find(a => a.id === parentId)
      if (!parent?.mesh) {
        alert('Aucune animation par Vidéo (CoTracker) validée disponible — impossible de créer la marche.')
        return
      }
      // Coord system : mask (= projectTriangulation.maskWidth/Height) — pour cohérence
      // avec bodyPoints/zonePoints utilisés par le LBS downstream.
      const imgW = project.projectTriangulation?.maskWidth ?? 1
      const imgH = project.projectTriangulation?.maskHeight ?? 1
      const snap = buildMarcheInheritSnapshot(parent.id, parent.mesh, imgW, imgH)
      if (!snap) {
        alert('Le parent CoTracker n\'a pas assez de données (bones non validés ?).')
        return
      }
      inheritedMesh = {
        ...inheritedMesh,
        ...snap,
        // Tous les bones cochés en gait par défaut
        marcheGaitLegIds: snap.marcheSkeleton.legs.map(l => l.id),
        marcheGaitLegsValidated: true,
      }
    }

    // Héritage CoTracker + Bones : copie des points frame 0 + squelette + params LBS
    // depuis une animation existante. Tracking et frames calculés sont volontairement
    // exclus pour forcer un re-tracking sur la nouvelle vidéo.
    if (isCoTrackerBones && cotrackerInheritFrom && inheritedMesh) {
      const source = project.animations.find(a => a.id === cotrackerInheritFrom)
      const sm = source?.mesh
      if (sm) {
        inheritedMesh = {
          ...inheritedMesh,
          cotrackerPoints: sm.cotrackerPoints ? sm.cotrackerPoints.map(p => ({
            ...p,
            prompts: p.prompts.map(pr => ({ ...pr })),
          })) : undefined,
          cotrackerSkeleton: sm.cotrackerSkeleton ? JSON.parse(JSON.stringify(sm.cotrackerSkeleton)) : undefined,
          cotrackerBonesValidated: !!sm.cotrackerBonesValidated,
          cotrackerLBSParams: sm.cotrackerLBSParams ? { ...sm.cotrackerLBSParams } : undefined,
        }
      }
    }
    const newAnim: Animation = {
      id: crypto.randomUUID(),
      name,
      type,
      // Le mode de lecture est explicite et indépendant du type. Par défaut, les nouvelles
      // animations sont créées en 'oneshot' (l'utilisateur passe en 'loop' depuis la carte).
      playbackMode: 'oneshot',
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
    if (!anim) return
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
    }
    setSaving(true)
    await onSave({ ...project, animations: [...project.animations, copy] })
    setSaving(false)
  }

  async function handleSetPlaybackMode(animId: string, mode: AnimationPlaybackMode) {
    const newAnims = project.animations.map(a =>
      a.id === animId ? { ...a, playbackMode: mode } : a
    )
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
            onSetPlaybackMode={(mode) => handleSetPlaybackMode(anim.id, mode)}
          />
        ))}
      </div>

      <div className="anim-card-add-row">
        <button className="btn-secondary" onClick={() => handleAdd('oneshot')} disabled={saving}>
          + Animation par contour
        </button>
        <button className="btn-secondary" onClick={() => handleAdd('physics')} disabled={saving}>
          + Animation Physique
        </button>
        <button
          className="btn-secondary"
          onClick={() => handleAdd('cotracker-bones')}
          disabled={saving || !project.projectTriangulation?.step3Validated}
          title={
            project.projectTriangulation?.step3Validated
              ? (cotrackerInheritFrom
                  ? 'Créer en héritant des points CoTracker et bones de l\'animation sélectionnée'
                  : 'Créer une animation CoTracker + Bones (topologie héritée de la Triangulation projet)')
              : 'Validez d\'abord la Triangulation projet jusqu\'à l\'étape Faces cachées (onglet Triangulation)'
          }
        >
          + Animation par Vidéo
        </button>
        <button
          className="btn-secondary"
          onClick={() => handleAdd('marche')}
          disabled={
            saving
            || !project.projectTriangulation?.step3Validated
            || !project.animations.some(a => a.type === 'cotracker-bones' && a.mesh?.cotrackerBonesValidated)
          }
          title={
            !project.projectTriangulation?.step3Validated
              ? 'Validez d\'abord la Triangulation projet'
              : !project.animations.some(a => a.type === 'cotracker-bones' && a.mesh?.cotrackerBonesValidated)
                ? 'Crée d\'abord une animation par Vidéo (CoTracker) avec squelette validé'
                : 'Animation procédurale héritant le squelette d\'une animation par Vidéo'
          }
        >
          + Animation Marche
        </button>
        <select
          value={marcheInheritFrom}
          onChange={(e) => setMarcheInheritFrom(e.target.value)}
          disabled={saving || marcheSources.length === 0}
          title="Animation parente (squelette hérité)"
          style={{ marginLeft: 4 }}
        >
          {marcheSources.length === 0 && <option value="">Marche : aucune source</option>}
          {marcheSources.length > 0 && marcheSources.map((a, i) => (
            <option key={a.id} value={a.id}>↳ {i === 0 ? '(défaut) ' : ''}Hériter de {a.name}</option>
          ))}
        </select>
        <select
          value={cotrackerInheritFrom}
          onChange={(e) => setCotrackerInheritFrom(e.target.value)}
          disabled={saving || cotrackerSources.length === 0}
          title={
            cotrackerSources.length === 0
              ? 'Aucune animation CoTracker existante avec points à frame 0'
              : 'Hériter les points CoTracker (frame 0) + bones d\'une animation existante'
          }
          style={{ marginLeft: 4 }}
        >
          <option value="">
            {cotrackerSources.length === 0
              ? 'CoTracker : aucune source à hériter'
              : 'CoTracker : sans héritage'}
          </option>
          {cotrackerSources.map(a => (
            <option key={a.id} value={a.id}>↳ Hériter de {a.name}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
