import { useState } from 'react'

interface Props {
  service: 'sam2'
}

const PROJECT_PATH = '/Users/nicolasrocher/Documents/claude code projects/coloriage-anime-triangulation-custom'

const SERVICE_INFO = {
  sam2: {
    label: 'SAM 2',
    folder: 'sam2-local',
    port: 8765,
  },
}

/**
 * Help disclosure shown next to SAM 2 actions in the admin pipeline.
 * Provides one-click copy of the shell commands needed to start the local Mac M2 MPS
 * server. Closed by default — admin opens it if they see a "Failed to fetch" error or
 * just want to verify the server is up.
 */
export default function LocalServerHelp({ service }: Props) {
  const info = SERVICE_INFO[service]
  const [copied, setCopied] = useState<string | null>(null)

  // Direct venv invocation (no activate) — robust against macOS Sonoma+ xattr issues
  // that block `source venv/bin/activate` in some zsh configs.
  const runCommand = `cd "${PROJECT_PATH}/${info.folder}"
venv/bin/python server.py`

  const setupCommand = `cd "${PROJECT_PATH}/${info.folder}"
python3.12 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt`

  async function copy(content: string, key: string) {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(key)
      setTimeout(() => setCopied(curr => (curr === key ? null : curr)), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <details
      style={{
        margin: '8px 0',
        padding: '6px 10px',
        background: 'rgba(59, 130, 246, 0.08)',
        border: '1px solid rgba(59, 130, 246, 0.3)',
        borderRadius: 4,
        fontSize: '0.85rem',
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', color: '#3b82f6' }}>
        Serveur {info.label} local pas démarré ?
      </summary>

      <div style={{ marginTop: 8, color: 'var(--color-text)' }}>
        <p style={{ margin: '4px 0' }}>
          Si tu vois <code>Failed to fetch</code> en cliquant le bouton de calcul, lance le serveur Python local
          dans un terminal :
        </p>

        <CodeBlock
          code={runCommand}
          copied={copied === 'run'}
          onCopy={() => copy(runCommand, 'run')}
        />

        <p style={{ margin: '8px 0 4px 0', color: 'var(--color-muted)', fontSize: '0.8rem' }}>
          Une fois lancé, le serveur écoute sur <code>http://127.0.0.1:{info.port}</code>. Tu peux laisser
          le terminal ouvert pendant toute la session admin et l'arrêter avec <kbd>Ctrl+C</kbd> à la fin.
        </p>

        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--color-muted)', fontSize: '0.8rem' }}>
            Premier lancement / installation des dépendances
          </summary>
          <p style={{ margin: '4px 0', fontSize: '0.8rem', color: 'var(--color-muted)' }}>
            À faire une seule fois (~5-10 min, télécharge PyTorch + {info.label}) :
          </p>
          <CodeBlock
            code={setupCommand}
            copied={copied === 'setup'}
            onCopy={() => copy(setupCommand, 'setup')}
          />
        </details>
      </div>
    </details>
  )
}

function CodeBlock({ code, copied, onCopy }: { code: string; copied: boolean; onCopy: () => void }) {
  return (
    <div style={{ position: 'relative', margin: '4px 0' }}>
      <pre
        style={{
          background: 'rgba(0, 0, 0, 0.6)',
          color: '#e2e8f0',
          padding: '8px 12px',
          paddingRight: 70,
          borderRadius: 4,
          fontSize: '0.75rem',
          fontFamily: 'monospace',
          margin: 0,
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
{code}
      </pre>
      <button
        onClick={onCopy}
        type="button"
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          background: copied ? '#22c55e' : 'rgba(59, 130, 246, 0.8)',
          color: '#fff',
          border: 'none',
          padding: '3px 8px',
          borderRadius: 3,
          fontSize: '0.7rem',
          cursor: 'pointer',
        }}
      >
        {copied ? '✓ Copié' : '📋 Copier'}
      </button>
    </div>
  )
}
