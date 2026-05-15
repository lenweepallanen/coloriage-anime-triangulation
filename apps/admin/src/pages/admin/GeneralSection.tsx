import { useState } from 'react'
import { useAdminContext } from './AdminLayout'
import ProjectImportSection from '../../components/admin/ProjectImportSection'
import PublishPanel from '../../components/admin/PublishPanel'
import { generateTemplatePDF } from '../../utils/pdfGenerator'

export default function GeneralSection() {
  const { project, save } = useAdminContext()
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(project.name)
  const [generatingPdf, setGeneratingPdf] = useState(false)

  const handleSaveName = async () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== project.name) {
      await save({ ...project, name: trimmed })
    }
    setEditingName(false)
  }

  const handleDownloadPdf = async () => {
    if (!project.originalImageBlob) return
    setGeneratingPdf(true)
    try {
      const restAnim = project.animations.find(a => a.type === 'rest')
      const blob = await generateTemplatePDF({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        originalImageBlob: project.originalImageBlob,
        backgroundVideoBlob: project.backgroundVideoBlob,
        ambientSoundBlob: project.ambientSoundBlob,
        ambientSoundEnabled: project.ambientSoundEnabled,
        markers: project.markers,
        videoBlob: restAnim?.videoBlob ?? null,
        mesh: restAnim?.mesh ?? null,
        audioBlob: restAnim?.audioBlob ?? null,
        audioEnabled: restAnim?.audioEnabled ?? false,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project.name}-template.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('PDF generation failed:', err)
    } finally {
      setGeneratingPdf(false)
    }
  }

  return (
    <div className="general-section">
      <div className="general-section-title-row">
        {editingName ? (
          <div className="general-section-name-edit">
            <input
              type="text"
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveName()
                if (e.key === 'Escape') { setNameValue(project.name); setEditingName(false) }
              }}
              autoFocus
            />
            <button className="btn-primary btn-sm" onClick={handleSaveName}>OK</button>
            <button className="btn-ghost btn-sm" onClick={() => { setNameValue(project.name); setEditingName(false) }}>Annuler</button>
          </div>
        ) : (
          <h3 className="general-section-name" onClick={() => { setNameValue(project.name); setEditingName(true) }}>
            {project.name}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16" style={{ marginLeft: 8, opacity: 0.5 }}>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </h3>
        )}
      </div>

      <div style={{ margin: '16px 0' }}>
        <PublishPanel
          projectId={project.id}
          published={project.published}
          publishedAt={project.publishedAt}
          onChange={(published) => {
            const updated = { ...project, published, publishedAt: published ? Date.now() : project.publishedAt }
            void save(updated)
          }}
        />
      </div>

      <ProjectImportSection project={project} onSave={save} />

      {project.originalImageBlob && (
        <div className="general-section-pdf">
          <button
            className="btn-secondary"
            onClick={handleDownloadPdf}
            disabled={generatingPdf}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <path d="M9 15v-2h1.5a1.5 1.5 0 0 1 0 3H9z" />
            </svg>
            {generatingPdf ? 'Génération...' : 'Télécharger le PDF'}
          </button>
        </div>
      )}
    </div>
  )
}
