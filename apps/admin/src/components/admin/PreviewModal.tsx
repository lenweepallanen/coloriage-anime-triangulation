import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import type { Project } from '../../types/project'
import AdminPreview from './AdminPreview'

interface PreviewModalShellProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

export function PreviewModalShell({ open, onClose, children }: PreviewModalShellProps) {
  const [size, setSize] = useState({ w: 70, h: 75 }) // percentage of viewport
  const dragging = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragging.current = true
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !contentRef.current) return
    const overlay = contentRef.current.parentElement!
    const rect = overlay.getBoundingClientRect()
    // Content is centered, so width = 2 * (pointer.x - center)
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const newW = Math.max(30, Math.min(95, (2 * Math.abs(e.clientX - cx) / rect.width) * 100))
    const newH = Math.max(30, Math.min(95, (2 * Math.abs(e.clientY - cy) / rect.height) * 100))
    setSize({ w: newW, h: newH })
  }, [])

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="preview-modal-overlay" onClick={onClose}>
      <div
        ref={contentRef}
        className="preview-modal-content"
        style={{ width: `${size.w}vw`, height: `${size.h}vh` }}
        onClick={e => e.stopPropagation()}
      >
        <button className="preview-modal-close" onClick={onClose} title="Fermer">
          &times;
        </button>
        {children}
        <div
          className="preview-modal-resize-handle"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>
    </div>
  )
}

interface Props {
  project: Project
  open: boolean
  onClose: () => void
}

export default function PreviewModal({ project, open, onClose }: Props) {
  return (
    <PreviewModalShell open={open} onClose={onClose}>
      <AdminPreview project={project} style={{ width: '100%', height: '100%' }} />
    </PreviewModalShell>
  )
}
