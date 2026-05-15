import { useState, useEffect } from 'react'
import type { Project } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function ProjectImportSection({ project, onSave }: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [bgVideoUrl, setBgVideoUrl] = useState<string | null>(null)
  const [ambientUrl, setAmbientUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (project.originalImageBlob) {
      const url = URL.createObjectURL(project.originalImageBlob)
      setImageUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setImageUrl(null)
    }
  }, [project.originalImageBlob])

  useEffect(() => {
    if (project.backgroundVideoBlob) {
      const url = URL.createObjectURL(project.backgroundVideoBlob)
      setBgVideoUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setBgVideoUrl(null)
    }
  }, [project.backgroundVideoBlob])

  useEffect(() => {
    if (project.ambientSoundBlob) {
      const url = URL.createObjectURL(project.ambientSoundBlob)
      setAmbientUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setAmbientUrl(null)
    }
  }, [project.ambientSoundBlob])

  async function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      await onSave({ ...project, originalImageBlob: file }, ['image'])
    } catch (err) {
      console.error('Failed to save image:', err)
      alert('Erreur lors de la sauvegarde de l\'image : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  async function handleBgVideoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      await onSave({ ...project, backgroundVideoBlob: file }, ['backgroundVideo'])
    } catch (err) {
      console.error('Failed to save background video:', err)
      alert('Erreur lors de la sauvegarde de la vidéo de fond : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  async function handleAmbientSoundChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      await onSave({ ...project, ambientSoundBlob: file, ambientSoundEnabled: true }, ['ambientSound'])
    } catch (err) {
      console.error('Failed to save ambient sound:', err)
      alert('Erreur lors de la sauvegarde du son d\'ambiance : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  async function handleAmbientSoundToggle() {
    setSaving(true)
    try {
      await onSave({ ...project, ambientSoundEnabled: !project.ambientSoundEnabled })
    } catch (err) {
      console.error('Failed to toggle ambient sound:', err)
    }
    setSaving(false)
  }

  async function handleAmbientSoundRemove() {
    setSaving(true)
    try {
      await onSave({ ...project, ambientSoundBlob: null, ambientSoundEnabled: false })
    } catch (err) {
      console.error('Failed to remove ambient sound:', err)
    }
    setSaving(false)
  }

  return (
    <section className="project-import-section">
      <div className="anim-manager-section-header">
        <div className="anim-manager-section-label">Projet</div>
      </div>
      <div className="project-import-grid">
        <div className="project-import-slot">
          <label className="project-import-slot-label">Image coloriage</label>
          <input
            type="file"
            accept="image/png,image/jpeg"
            onChange={handleImageChange}
            disabled={saving}
          />
          {imageUrl && (
            <div className="preview">
              <img src={imageUrl} alt="Coloriage" style={{ maxWidth: '100%', maxHeight: 160 }} />
            </div>
          )}
          {!imageUrl && (
            <div className="project-import-empty">Aucune image</div>
          )}
        </div>

        <div className="project-import-slot">
          <label className="project-import-slot-label">Vidéo de fond <span className="project-import-optional">(optionnel)</span></label>
          <input
            type="file"
            accept="video/mp4,video/webm"
            onChange={handleBgVideoChange}
            disabled={saving}
          />
          {bgVideoUrl && (
            <div className="preview">
              <video src={bgVideoUrl} controls style={{ maxWidth: '100%', maxHeight: 160 }} />
            </div>
          )}
        </div>

        <div className="project-import-slot">
          <label className="project-import-slot-label">Son d'ambiance <span className="project-import-optional">(optionnel)</span></label>
          {!ambientUrl && (
            <input
              type="file"
              accept="audio/mpeg,audio/wav,audio/ogg"
              onChange={handleAmbientSoundChange}
              disabled={saving}
            />
          )}
          {ambientUrl && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <audio src={ambientUrl} controls style={{ flex: 1, height: 32 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={project.ambientSoundEnabled}
                  onChange={handleAmbientSoundToggle}
                  disabled={saving}
                />
                Activé
              </label>
              <button className="btn-ghost btn-sm" onClick={handleAmbientSoundRemove} disabled={saving}>
                Supprimer
              </button>
            </div>
          )}
        </div>
      </div>
      {saving && <p style={{ fontSize: 'var(--text-sm)', color: 'var(--color-muted)', marginTop: 8 }}>Sauvegarde en cours...</p>}
    </section>
  )
}
