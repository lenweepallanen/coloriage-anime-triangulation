import { useState } from 'react'
import type { Project, Animation } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/**
 * Étape 2 — Cocher les bones-pattes qui suivent le cycle de marche.
 * Les pattes non cochées resteront fixes à leur position de repos.
 */
export default function MarcheGaitLegsStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const skeleton = mesh?.marcheSkeleton

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(mesh?.marcheGaitLegIds ?? skeleton?.legs.map(l => l.id) ?? []),
  )
  const [saving, setSaving] = useState(false)

  if (!skeleton || !mesh?.marcheInheritValidated) {
    return (
      <div style={{ padding: 20, color: '#9ca3af' }}>
        Hérite d'abord un squelette à l'étape <strong>Hériter bones</strong>.
      </div>
    )
  }

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  async function handleValidate() {
    if (!mesh) return
    const updatedMesh = {
      ...mesh,
      marcheGaitLegIds: [...selected],
      marcheGaitLegsValidated: true,
      // Reset downstream computation
      walkBodyFrames: null,
      walkZoneFrames: null,
      videoFramesMesh: null,
    }
    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, mesh: updatedMesh } : a,
    )
    setSaving(true)
    try { await onSave({ ...project, animations: updatedAnims }) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ padding: 20, maxWidth: 600 }}>
      <h2 style={{ marginTop: 0 }}>Définir les pattes du cycle de marche</h2>
      <p style={{ color: '#9ca3af', fontSize: 13 }}>
        Coche les bones du squelette qui doivent suivre le cycle de marche (pied au sol / en l'air).
        Les bones non cochés (bras, ailes, queue…) resteront fixes à leur position de repos.
      </p>

      <div style={{ marginTop: 16 }}>
        {skeleton.legs.map(leg => (
          <label
            key={leg.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 12px', marginBottom: 6, background: '#1a1b2e',
              borderRadius: 6, cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={selected.has(leg.id)}
              onChange={() => toggle(leg.id)}
            />
            <span style={{ flex: 1 }}>
              <strong>{leg.name}</strong>
              <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 12 }}>
                zone {leg.zoneId} — {leg.joints.length + 2} joints
              </span>
            </span>
          </label>
        ))}
      </div>

      {skeleton.legs.length === 0 && (
        <div style={{ color: '#9ca3af', fontSize: 13 }}>Aucune patte dans le squelette hérité.</div>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
        <button className="btn-primary" onClick={handleValidate} disabled={saving}>
          {saving ? 'Sauvegarde…' : 'Valider la sélection'}
        </button>
        <span style={{ color: '#9ca3af', fontSize: 13, alignSelf: 'center' }}>
          {selected.size} / {skeleton.legs.length} pattes en cycle
        </span>
      </div>
    </div>
  )
}
