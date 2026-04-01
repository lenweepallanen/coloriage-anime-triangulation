import type { Project } from '../../types/project'
import AdminPreview from './AdminPreview'

interface Props {
  project: Project
  open: boolean
  onClose: () => void
}

export default function PreviewModal({ project, open, onClose }: Props) {
  if (!open) return null

  return (
    <div className="preview-modal-overlay" onClick={onClose}>
      <div className="preview-modal-content" onClick={e => e.stopPropagation()}>
        <button className="preview-modal-close" onClick={onClose} title="Fermer">
          &times;
        </button>
        <AdminPreview project={project} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  )
}
