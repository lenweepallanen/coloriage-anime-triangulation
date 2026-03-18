import { useState, useEffect } from 'react'
import type { Project } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'

interface Props {
  project: Project
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

export default function ImportStep({ project, onSave }: Props) {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [bgVideoUrl, setBgVideoUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (project.originalImageBlob) {
      const url = URL.createObjectURL(project.originalImageBlob)
      setImageUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [project.originalImageBlob])

  useEffect(() => {
    if (project.videoBlob) {
      const url = URL.createObjectURL(project.videoBlob)
      setVideoUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [project.videoBlob])

  useEffect(() => {
    if (project.backgroundVideoBlob) {
      const url = URL.createObjectURL(project.backgroundVideoBlob)
      setBgVideoUrl(url)
      return () => URL.revokeObjectURL(url)
    }
  }, [project.backgroundVideoBlob])

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

  return (
    <div className="import-step">
      <div className="import-section">
        <h3>Image du coloriage (noir & blanc)</h3>
        <input
          type="file"
          accept="image/png,image/jpeg"
          onChange={handleImageChange}
          disabled={saving}
        />
        {imageUrl && (
          <div className="preview">
            <img src={imageUrl} alt="Coloriage" style={{ maxWidth: '100%', maxHeight: 400 }} />
          </div>
        )}
      </div>

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

      <div className="import-section">
        <h3>Vidéo de fond (optionnel)</h3>
        <p style={{ fontSize: '0.85em', color: '#666', margin: '4px 0 8px' }}>
          Vidéo affichée en arrière-plan de l'animation. Jouée en boucle.
        </p>
        <input
          type="file"
          accept="video/mp4,video/webm"
          onChange={handleBgVideoChange}
          disabled={saving}
        />
        {bgVideoUrl && (
          <div className="preview">
            <video src={bgVideoUrl} controls style={{ maxWidth: '100%', maxHeight: 400 }} />
          </div>
        )}
      </div>

      {saving && <p>Sauvegarde en cours...</p>}

      <div className="import-status">
        <p>
          Image : {project.originalImageBlob ? 'OK' : 'Non importée'} |
          Vidéo : {project.videoBlob ? 'OK' : 'Non importée'} |
          Fond : {project.backgroundVideoBlob ? 'OK' : 'Non importé'}
        </p>
      </div>
    </div>
  )
}
