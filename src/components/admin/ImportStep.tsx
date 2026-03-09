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

      {saving && <p>Sauvegarde en cours...</p>}

      <div className="import-status">
        <p>
          Image : {project.originalImageBlob ? 'OK' : 'Non importée'} |
          Vidéo : {project.videoBlob ? 'OK' : 'Non importée'}
        </p>
      </div>
    </div>
  )
}
