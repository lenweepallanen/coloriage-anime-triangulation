import { useState, useEffect } from 'react'
import type { ProjectStepView } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
  isRestAnimation?: boolean
}

export default function ImportStep({ project, onSave, isRestAnimation = true }: Props) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (project.videoBlob) {
      const url = URL.createObjectURL(project.videoBlob)
      setVideoUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setVideoUrl(null)
    }
  }, [project.videoBlob])

  useEffect(() => {
    if (project.audioBlob) {
      const url = URL.createObjectURL(project.audioBlob)
      setAudioUrl(url)
      return () => URL.revokeObjectURL(url)
    } else {
      setAudioUrl(null)
    }
  }, [project.audioBlob])

  async function handleVideoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      await onSave({ ...project, videoBlob: file }, ['video'])
    } catch (err) {
      console.error('Failed to save video:', err)
      alert('Erreur lors de la sauvegarde de la vidéo : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  async function handleAudioChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      await onSave({ ...project, audioBlob: file, audioEnabled: true }, ['audio'])
    } catch (err) {
      console.error('Failed to save audio:', err)
      alert('Erreur lors de la sauvegarde du son : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  async function handleAudioToggle() {
    setSaving(true)
    try {
      await onSave({ ...project, audioEnabled: !project.audioEnabled })
    } catch (err) {
      console.error('Failed to toggle audio:', err)
    }
    setSaving(false)
  }

  async function handleAudioRemove() {
    setSaving(true)
    try {
      await onSave({ ...project, audioBlob: null, audioEnabled: false })
    } catch (err) {
      console.error('Failed to remove audio:', err)
    }
    setSaving(false)
  }

  return (
    <div className="import-step">
      <div className="import-section">
        <h3>Vidéo d'animation (MP4)</h3>
        <input
          type="file"
          accept="video/mp4,video/webm"
          onChange={handleVideoChange}
          disabled={saving}
        />
        {videoUrl && (
          <div className="preview">
            <video src={videoUrl} controls style={{ maxWidth: '100%', maxHeight: 400 }} />
          </div>
        )}
      </div>

      {!isRestAnimation && (
        <div className="import-section">
          <h3>Son (optionnel)</h3>
          <p style={{ fontSize: '0.85em', color: 'var(--color-text-secondary)', margin: '4px 0 8px' }}>
            Son joué avec l'animation. MP3, WAV ou OGG.
          </p>
          <input
            type="file"
            accept="audio/mpeg,audio/wav,audio/ogg"
            onChange={handleAudioChange}
            disabled={saving}
          />
          {audioUrl && (
            <div className="preview" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <audio src={audioUrl} controls style={{ flex: 1 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={project.audioEnabled}
                  onChange={handleAudioToggle}
                  disabled={saving}
                />
                Activé
              </label>
              <button className="btn-ghost btn-sm" onClick={handleAudioRemove} disabled={saving}>
                Supprimer
              </button>
            </div>
          )}
        </div>
      )}

      {saving && <p>Sauvegarde en cours...</p>}

      <div className="import-status">
        <p>
          Vidéo : {project.videoBlob ? 'OK' : 'Non importée'}
          {!isRestAnimation && (
            <> | Son : {project.audioBlob ? (project.audioEnabled ? 'OK (activé)' : 'OK (désactivé)') : 'Non importé'}</>
          )}
        </p>
      </div>
    </div>
  )
}
