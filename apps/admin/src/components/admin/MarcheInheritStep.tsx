import { useState, useMemo } from 'react'
import type { Project, Animation, CoTrackerSkeleton, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { extractRestFromParentMesh } from '../../utils/marcheSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/**
 * Étape 1 — Hériter le squelette d'une animation parente cotracker-bones.
 *
 * Snapshot du `cotrackerSkeleton` + extraction des positions rest des joints
 * (frame 0 des chains lissés du parent), converties en coordonnées image.
 */
export default function MarcheInheritStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh

  // Sources éligibles : cotracker-bones avec squelette validé et frames calculées
  const sources = useMemo(() => project.animations.filter(a =>
    a.type === 'cotracker-bones'
    && a.mesh?.cotrackerBonesValidated
    && (a.mesh.cotrackerBodyJointFrames || a.mesh.cotrackerBodyJointFramesSmoothed
        || (a.mesh.cotrackerSkeleton && a.mesh.cotrackerFrames))
  ), [project.animations])

  const [parentId, setParentId] = useState<string>(
    () => mesh?.marcheParentAnimationId ?? (sources[0]?.id ?? ''),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parent = sources.find(s => s.id === parentId)
  const inherited = mesh?.marcheInheritValidated

  async function handleInherit() {
    setError(null)
    if (!parent || !parent.mesh) { setError('Choisis une animation parente.'); return }
    const sm = parent.mesh
    const rest = extractRestFromParentMesh(sm)
    if (!rest) { setError('Le parent n\'a pas assez de données pour extraire les rest positions.'); return }

    // Convert from parent video coords → image coords using image dimensions
    const imgW = await getImageWidth(project)
    const imgH = await getImageHeight(project)
    const vidW = sm.cotrackerVideoWidth ?? imgW
    const vidH = sm.cotrackerVideoHeight ?? imgH
    const sx = imgW / Math.max(vidW, 1)
    const sy = imgH / Math.max(vidH, 1)
    const mapPt = (p: Point2D): Point2D => ({ x: p.x * sx, y: p.y * sy })

    const bodyJointRestPositions = rest.bodyJointRest.map(mapPt)
    const legRestPositions: Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }> = {}
    for (const [legId, lr] of Object.entries(rest.legRest)) {
      legRestPositions[legId] = {
        hip: mapPt(lr.hip),
        joints: lr.joints.map(mapPt),
        foot: mapPt(lr.foot),
      }
    }

    // Deep-copy skeleton
    const snapshot: CoTrackerSkeleton = JSON.parse(JSON.stringify(sm.cotrackerSkeleton))

    const updatedMesh = {
      ...(mesh ?? {}),
      marcheParentAnimationId: parent.id,
      marcheSkeleton: snapshot,
      marcheBodyJointRestPositions: bodyJointRestPositions,
      marcheLegRestPositions: legRestPositions,
      marcheInheritValidated: true,
      // Reset downstream
      marcheGaitLegIds: [],
      marcheGaitLegsValidated: false,
      walkParams: null,
      walkParamsValidated: false,
      walkBodyFrames: null,
      walkZoneFrames: null,
      videoFramesMesh: null,
    }
    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, mesh: updatedMesh } : a,
    )
    setSaving(true)
    try {
      await onSave({ ...project, animations: updatedAnims })
    } finally {
      setSaving(false)
    }
  }

  if (sources.length === 0) {
    return (
      <div style={{ padding: 20, color: '#9ca3af' }}>
        Aucune animation <strong>par Vidéo (CoTracker)</strong> validée n'est disponible.
        Crée d'abord une animation cotracker-bones, valide son squelette et son tracking, puis reviens ici.
      </div>
    )
  }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>Hériter le squelette d'une animation par Vidéo</h2>
      <p style={{ color: '#9ca3af', fontSize: 13 }}>
        Sélectionne une animation <strong>par Vidéo (CoTracker)</strong> existante. Le squelette
        (colonne vertébrale + pattes) et les positions de repos sont copiés. La triangulation est
        celle de la <strong>Triangulation projet</strong>.
      </p>

      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <label style={{ fontSize: 13, color: '#9ca3af', display: 'block', marginBottom: 6 }}>
          Animation parente
        </label>
        <select
          value={parentId}
          onChange={e => setParentId(e.target.value)}
          disabled={saving}
          style={{ width: '100%', padding: 8 }}
        >
          {sources.map(a => {
            const sk = a.mesh!.cotrackerSkeleton!
            return (
              <option key={a.id} value={a.id}>
                {a.name} — {sk.bodyChain.length} joints corps, {sk.legs.length} pattes
              </option>
            )
          })}
        </select>
      </div>

      {parent?.mesh?.cotrackerSkeleton && (
        <div style={{ background: '#1a1b2e', padding: 12, borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          <div><strong>Body chain :</strong> {parent.mesh.cotrackerSkeleton.bodyChain.map(j => j.name).join(' → ')}</div>
          <div style={{ marginTop: 6 }}><strong>Pattes :</strong></div>
          <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
            {parent.mesh.cotrackerSkeleton.legs.map(leg => (
              <li key={leg.id}>{leg.name} <span style={{ color: '#6b7280' }}>(zone {leg.zoneId}, {leg.joints.length + 2} joints)</span></li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div style={{ color: '#ef4444', marginBottom: 12, fontSize: 13 }}>{error}</div>
      )}

      <button className="btn-primary" onClick={handleInherit} disabled={saving || !parent}>
        {saving ? 'Sauvegarde…' : inherited ? 'Re-hériter (écrase tout)' : 'Hériter ce squelette'}
      </button>

      {inherited && (
        <div style={{ marginTop: 16, color: '#22c55e', fontSize: 13 }}>
          ✓ Squelette hérité ({mesh?.marcheSkeleton?.legs.length ?? 0} pattes,
          {' '}{mesh?.marcheBodyJointRestPositions?.length ?? 0} joints corps).
          Passe à l'étape <strong>Pattes</strong>.
        </div>
      )}
    </div>
  )
}

async function getImageWidth(project: Project): Promise<number> {
  if (!project.originalImageBlob) return 1
  const img = await loadImage(project.originalImageBlob)
  return img.naturalWidth
}
async function getImageHeight(project: Project): Promise<number> {
  if (!project.originalImageBlob) return 1
  const img = await loadImage(project.originalImageBlob)
  return img.naturalHeight
}
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}
