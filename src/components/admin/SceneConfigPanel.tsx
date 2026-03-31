import type { SceneRestPoint, SceneTransition, SceneSegment, Animation } from '../../types/project'
import type { TimelineSelection } from './SceneTimeline'

interface Props {
  selection: TimelineSelection
  restPoints: SceneRestPoint[]
  transitions: SceneTransition[]
  startMode: 'rest' | 'transition'
  startX?: number
  startTransition?: SceneTransition
  animations: Animation[]
  onRestPointChange: (index: number, updated: SceneRestPoint) => void
  onSegmentChange: (transitionIndex: number, segmentIndex: number, updated: SceneSegment) => void
  onStartModeChange: (mode: 'rest' | 'transition') => void
}

export default function SceneConfigPanel({
  selection,
  restPoints,
  transitions,
  startMode,
  startX,
  startTransition,
  animations,
  onRestPointChange,
  onSegmentChange,
  onStartModeChange,
}: Props) {
  const readyAnimations = animations.filter(a => a.mesh?.videoFramesMesh != null)
  const restAnimations = readyAnimations.filter(a => a.type === 'rest')
  const nonRestAnimations = readyAnimations.filter(a => a.type !== 'rest')

  if (selection.type === 'restPoint') {
    const rp = restPoints[selection.index]
    if (!rp) return null

    return (
      <div className="scene-config-panel">
        <div className="scene-config-panel-header">
          <h4>Rest Point #{selection.index + 1}</h4>
          <span className="scene-config-panel-pos">X: {rp.backgroundX}px</span>
        </div>

        <div className="scene-config-panel-field">
          <label>Animation rest</label>
          <select
            value={rp.restAnimationId ?? ''}
            onChange={(e) => onRestPointChange(selection.index, {
              ...rp, restAnimationId: e.target.value || undefined,
            })}
          >
            <option value="">(Rest par défaut)</option>
            {restAnimations.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        <div className="scene-config-panel-field">
          <label>Animations disponibles</label>
          <div className="scene-config-panel-checkboxes">
            {nonRestAnimations.map(a => {
              const checked = rp.availableAnimationIds?.includes(a.id) ?? false
              return (
                <label key={a.id} className="scene-config-panel-checkbox">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const current = rp.availableAnimationIds ?? []
                      const updated = e.target.checked
                        ? [...current, a.id]
                        : current.filter(id => id !== a.id)
                      onRestPointChange(selection.index, {
                        ...rp, availableAnimationIds: updated,
                      })
                    }}
                  />
                  <span>{a.name} ({a.type})</span>
                </label>
              )
            })}
            {nonRestAnimations.length === 0 && (
              <span className="scene-config-panel-empty">Aucune animation oneshot/physics disponible</span>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (selection.type === 'segment') {
    const { transitionIndex, segmentIndex } = selection
    const transition = transitionIndex === -1 ? startTransition : transitions[transitionIndex]
    const segment = transition?.segments[segmentIndex]
    if (!transition || !segment) return null

    const label = transitionIndex === -1
      ? `Départ → Rest Point #1, segment ${segmentIndex + 1}`
      : `Rest Point #${transitionIndex + 1} → #${transitionIndex + 2}, segment ${segmentIndex + 1}`

    return (
      <div className="scene-config-panel">
        <div className="scene-config-panel-header">
          <h4>{label}</h4>
        </div>

        <div className="scene-config-panel-field">
          <label>Durée (secondes)</label>
          <input
            type="number"
            min={0.5}
            max={60}
            step={0.5}
            value={segment.duration}
            onChange={(e) => onSegmentChange(transitionIndex, segmentIndex, {
              ...segment, duration: parseFloat(e.target.value) || 3,
            })}
          />
        </div>

        <div className="scene-config-panel-field">
          <label>Animation de mouvement</label>
          <select
            value={segment.animationId ?? ''}
            onChange={(e) => onSegmentChange(transitionIndex, segmentIndex, {
              ...segment, animationId: e.target.value || undefined,
            })}
          >
            <option value="">— Aucune —</option>
            {readyAnimations.map(a => (
              <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
            ))}
          </select>
        </div>
      </div>
    )
  }

  if (selection.type === 'startPoint') {
    return (
      <div className="scene-config-panel">
        <div className="scene-config-panel-header">
          <h4>Point de départ</h4>
          {startX != null && <span className="scene-config-panel-pos">X: {startX}px</span>}
        </div>

        <div className="scene-config-panel-field">
          <label>Mode de démarrage</label>
          <div className="scene-config-panel-type-toggle">
            <button
              className={`btn-sm ${startMode === 'rest' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onStartModeChange('rest')}
            >
              Rest Point
            </button>
            <button
              className={`btn-sm ${startMode === 'transition' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onStartModeChange('transition')}
            >
              En mouvement
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
