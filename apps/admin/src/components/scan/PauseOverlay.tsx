import { playT } from '../../utils/playI18n'

interface Props {
  onContinue: () => void
  onBack: () => void
  backLabel?: string
}

export default function PauseOverlay({ onContinue, onBack, backLabel }: Props) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 16,
          padding: 32,
          minWidth: 280,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          alignItems: 'stretch',
        }}
      >
        <h2 style={{ margin: 0, textAlign: 'center' }}>{playT('pause.title')}</h2>
        <button className="btn-primary" onClick={onContinue} style={{ fontSize: 18, padding: '12px 16px' }}>
          {playT('pause.continue')}
        </button>
        <button className="btn-secondary" onClick={onBack} style={{ fontSize: 16, padding: '10px 16px' }}>
          {backLabel ?? playT('pause.backColorings')}
        </button>
      </div>
    </div>
  )
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Pause"
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        zIndex: 999,
        width: 44,
        height: 44,
        borderRadius: '50%',
        border: 'none',
        background: 'rgba(0,0,0,0.5)',
        color: 'white',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 22,
      }}
    >
      ⚙
    </button>
  )
}
