import { useState } from 'react'
import type { Animation } from '../../types/project'

interface Props {
  animation: Animation
  completionStatus: { done: number; total: number }
  onEdit: () => void
  onRename: (newName: string) => void
  onDelete: () => void
  onDuplicate: () => void
  onSetAsRest: () => void
}

const TYPE_LABELS: Record<string, string> = {
  rest: 'Rest',
  oneshot: 'Oneshot',
  physics: 'Physics',
}

export default function AnimationCard({
  animation, completionStatus, onEdit, onRename, onDelete, onDuplicate, onSetAsRest,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [nameValue, setNameValue] = useState(animation.name)

  const isRest = animation.type === 'rest'
  const isComplete = completionStatus.done === completionStatus.total

  const handleConfirmRename = () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== animation.name) {
      onRename(trimmed)
    }
    setEditing(false)
  }

  return (
    <div className={`anim-card anim-card--${animation.type}`}>
      <div className="anim-card-header">
        <span className={`anim-card-badge anim-card-badge--${animation.type}`}>
          {TYPE_LABELS[animation.type]}
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
        {!isRest && (
          <button className="btn-ghost btn-sm" onClick={onSetAsRest}>Définir Rest</button>
        )}
        {!isRest && (
          <button className="btn-danger btn-sm" onClick={onDelete}>Supprimer</button>
        )}
      </div>
    </div>
  )
}
