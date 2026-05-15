import { useState } from 'react'
import { setProjectPublished, buildPlayUrl } from '../../db/publishProject'

interface Props {
  projectId: string
  published: boolean
  publishedAt: number | null
  onChange: (published: boolean) => void
}

export default function PublishPanel({ projectId, published, publishedAt, onChange }: Props) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const url = buildPlayUrl(projectId)

  async function handleToggle() {
    if (busy) return
    setBusy(true)
    try {
      await setProjectPublished(projectId, !published)
      onChange(!published)
    } catch (e) {
      console.error('[publish] toggle failed', e)
      alert('Échec : ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      console.error('[publish] copy failed', e)
    }
  }

  return (
    <div style={{
      border: '1px solid var(--color-border, #e0e0e0)',
      borderRadius: 8,
      padding: 16,
      background: published ? '#e8f5e9' : '#fff8e1',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong>{published ? '✓ Publié' : '⚠ Non publié'}</strong>
        <button onClick={handleToggle} disabled={busy} className="btn-secondary">
          {busy ? '…' : published ? 'Dépublier' : 'Publier'}
        </button>
        {publishedAt && (
          <span style={{ color: '#666', fontSize: 12 }}>
            depuis le {new Date(publishedAt).toLocaleString('fr-FR')}
          </span>
        )}
      </div>
      {published && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>Lien USER (QR code) :</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '6px 10px', background: '#fff', borderRadius: 4, fontSize: 13, overflow: 'auto' }}>
              {url}
            </code>
            <button onClick={handleCopy} className="btn-sm btn-secondary">
              {copied ? 'Copié !' : 'Copier'}
            </button>
          </div>
        </div>
      )}
      {!published && (
        <p style={{ marginTop: 8, color: '#666', fontSize: 13, marginBottom: 0 }}>
          Tant que le projet n'est pas publié, le lien play.NDD/p/{projectId.slice(0, 8)}… renvoie « Coloriage indisponible ».
        </p>
      )}
    </div>
  )
}
