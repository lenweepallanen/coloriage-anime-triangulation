import { useState } from 'react'
import type { Animation, AnimationPlaybackMode } from '../../types/project'
import { getPlaybackMode } from '../../types/project'

interface Props {
  animation: Animation
  completionStatus: { done: number; total: number }
  onEdit: () => void
  onRename: (newName: string) => void
  onDelete: () => void
  onDuplicate: () => void
  onSetPlaybackMode: (mode: AnimationPlaybackMode) => void
}

const TYPE_LABELS: Record<string, string> = {
  rest: 'Vidéo',
  oneshot: 'Vidéo',
  physics: 'Physics',
  bone: 'Bone',
  walk: 'Walk',
  'members-bones': 'MB',
  'members-bones-v2': 'MB-V2',
  'members-bones-v3': 'MB-V3',
  'cotracker-bones': 'CoTracker',
}

export default function AnimationCard({
  animation, completionStatus, onEdit, onRename, onDelete, onDuplicate, onSetPlaybackMode,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [nameValue, setNameValue] = useState(animation.name)

  const playbackMode = getPlaybackMode(animation)
  const isLoop = playbackMode === 'loop'
  const isComplete = completionStatus.done === completionStatus.total

  const handleConfirmRename = () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== animation.name) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  return (
    <div className={`anim-card anim-card--${animation.type} anim-card--${playbackMode}`}>
      <div className="anim-card-header">
        <span className={`anim-card-badge anim-card-badge--${animation.type}`}>
          {TYPE_LABELS[animation.type] ?? animation.type}
        </span>
        <span className={`anim-card-badge anim-card-badge--${playbackMode}`} title="Mode de lecture">
          {isLoop ? '🔁 Loop' : '▶ Oneshot'}
        </span>
        <span className="anim-card-completion">
          {isComplete ? (
            <span className="anim-card-completion-check" title="Pipeline complet">&#10003;</span>
          ) : (
            <span className="anim-card-completion-progress" title={`${completionStatus.done}/${completionStatus.total} étapes`}>
              {completionStatus.done}/{completionStatus.total}
            </span>
          )}
        </span>
      </div>

      <div className="anim-card-name">
        {editing ? (
          <input
            type="text"
            value={nameValue}
            onChange={e => setNameValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleConfirmRename()
              if (e.key === 'Escape') { setNameValue(animation.name); setEditing(false) }
            }}
            onBlur={handleConfirmRename}
            autoFocus
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="anim-card-name-text">{animation.name}</span>
        )}
      </div>

      <div className="anim-card-actions">
        <button className="btn-primary btn-sm" onClick={onEdit}>Éditer</button>
        <button className="btn-ghost btn-sm" onClick={() => { setNameValue(animation.name); setEditing(true) }}>Renommer</button>
        <button className="btn-ghost btn-sm" onClick={onDuplicate}>Dupliquer</button>
        <button
          className="btn-ghost btn-sm"
          onClick={() => onSetPlaybackMode(isLoop ? 'oneshot' : 'loop')}
          title={isLoop ? 'Basculer en lecture oneshot' : 'Basculer en lecture loop (idle)'}
        >
          {isLoop ? '→ Oneshot' : '→ Loop'}
        </button>
        <button className="btn-danger btn-sm" onClick={onDelete}>Supprimer</button>
      </div>
    </div>
  )
}
