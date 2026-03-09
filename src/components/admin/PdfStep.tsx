import { useState } from 'react'
import type { Project } from '../../types/project'
import { generateTemplatePDF } from '../../utils/pdfGenerator'

interface Props {
  project: Project
}

export default function PdfStep({ project }: Props) {
  const [generating, setGenerating] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  async function handleGenerate() {
    setGenerating(true)
    try {
      const blob = await generateTemplatePDF(project)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
      setPreviewUrl(URL.createObjectURL(blob))
    } catch (err) {
      console.error('PDF generation failed:', err)
      alert('Erreur lors de la génération du PDF')
    }
    setGenerating(false)
  }

  async function handleDownload() {
    setGenerating(true)
    try {
      const blob = await generateTemplatePDF(project)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${project.name}-coloriage.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('PDF download failed:', err)
      alert('Erreur lors du téléchargement du PDF')
    }
    setGenerating(false)
  }

  if (!project.originalImageBlob) {
    return <div className="placeholder">Importez d'abord une image dans l'onglet Import.</div>
  }

  return (
    <div className="pdf-step">
      <div className="triangulation-toolbar">
        <button onClick={handleGenerate} disabled={generating}>
          {generating ? 'Génération...' : 'Prévisualiser PDF'}
        </button>
        <button onClick={handleDownload} disabled={generating}>
          Télécharger PDF
        </button>
      </div>

      <p style={{ fontSize: '0.875rem', color: '#888', marginTop: 8 }}>
        Le PDF contiendra l'image du coloriage avec les 4 markers L aux coins,
        prêt à imprimer en A4.
      </p>

      {previewUrl && (
        <div className="pdf-preview">
          <iframe
            src={previewUrl}
            title="PDF Preview"
            style={{ width: '100%', height: 600, border: '1px solid #ddd', borderRadius: 8 }}
          />
        </div>
      )}
    </div>
  )
}
