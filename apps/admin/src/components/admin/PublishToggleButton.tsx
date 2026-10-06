import { useState } from 'react'
import { setProjectPublished } from '../../db/publishProject'

/**
 * Bouton « Publier » / « Dépublier » posé directement sur une carte coloriage (accueil et page livre),
 * pour ne pas avoir à ouvrir le projet puis le PublishPanel. Même action que le PublishPanel
 * (`setProjectPublished` : Firestore + audit + vignette), optimiste avec retour arrière en cas d'erreur.
 */
export default function PublishToggleButton({ projectId, published, onChange }: { projectId: string; published: boolean; onChange: (published: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  async function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    const next = !published
    if (!next && !window.confirm('Dépublier ce coloriage ? Il disparaîtra du menu du livre dans l\'app.')) return
    setBusy(true)
    onChange(next)
    try {
      await setProjectPublished(projectId, next)
    } catch (err) {
      console.error('[publish] échec', err)
      onChange(!next)
      window.alert('La publication a échoué. Réessaie.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      className={published ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
      onClick={toggle}
      disabled={busy}
      title={published ? 'Dépublier (retire du menu du livre dans l\'app)' : 'Publier (visible dans l\'app play)'}
      style={{ whiteSpace: 'nowrap' }}
    >
      {busy ? '…' : published ? '✓ Publié' : 'Publier'}
    </button>
  )
}
