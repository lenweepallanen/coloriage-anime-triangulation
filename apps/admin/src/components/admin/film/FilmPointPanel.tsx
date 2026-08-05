import type { Animation, FilmPlan, FilmPoint } from '../../../types/project'
import { ActionCard } from '../SceneConfigPanel'
import FilmTravelFields from './FilmTravelFields'
import { planGeometry } from './filmEditorShared'

/**
 * Panneau du point sélectionné : échelle, trajet entrant (départ, forme, allure),
 * action à l'arrivée, pause, trajet de sortie.
 */
export default function FilmPointPanel({
  plan, point, pointIndex, readyAnimations, defaultSpeed,
  onPatchPlan, onPatchPoint, onMovePoint, onRemovePoint,
  onFilmSoundImported, onFilmSoundDeleted,
}: {
  plan: FilmPlan
  point: FilmPoint
  pointIndex: number
  readyAnimations: Animation[]
  defaultSpeed: number
  onPatchPlan: (partial: Partial<FilmPlan>) => void
  onPatchPoint: (pointId: string, partial: Partial<FilmPoint>) => void
  onMovePoint: (id: string, dir: -1 | 1) => void
  onRemovePoint: (id: string) => void
  onFilmSoundImported: (soundId: string) => void
  onFilmSoundDeleted: (soundId: string) => void
}) {
  const points = plan.points
  const geo = planGeometry(plan)
  const layerW = plan.backdrop?.width ?? 0
  const isOutOfFrame = point.x < geo.frameLeft || point.x > geo.frameRight
  const selected = point

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 600 }}>Point {pointIndex + 1}</span>
        <span style={{ fontSize: 12, opacity: 0.6 }}>({selected.x}, {selected.y})</span>
        {isOutOfFrame && <span style={{ fontSize: 12, color: 'var(--color-danger, #ef5350)' }}>hors cadre</span>}
        <div style={{ flex: 1 }} />
        <button className="btn-icon btn-sm" onClick={() => onMovePoint(selected.id, -1)} disabled={pointIndex === 0} title="Plus tôt dans le chemin">↑</button>
        <button className="btn-icon btn-sm" onClick={() => onMovePoint(selected.id, +1)} disabled={pointIndex === points.length - 1} title="Plus tard dans le chemin">↓</button>
        <button className="btn-icon btn-sm btn-danger" onClick={() => onRemovePoint(selected.id)} title="Supprimer le point">&times;</button>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="scene-editor-field" style={{ minWidth: 280, flex: 1, maxWidth: 400 }}>
          <label>Échelle du personnage : {selected.scale.toFixed(2)}×</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0.05} max={4} step={0.05}
              value={Math.min(4, selected.scale)}
              onChange={(e) => onPatchPoint(selected.id, { scale: parseFloat(e.target.value) })}
              style={{ flex: 1 }}
            />
            <input
              type="number" min={0.05} max={30} step={0.05}
              value={selected.scale}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (Number.isFinite(v) && v > 0) onPatchPoint(selected.id, { scale: Math.min(30, v) })
              }}
              style={{ width: 72 }}
              title="Échelle libre (au-delà de 4× : tapez la valeur — perso au premier plan, très gros)"
            />
          </div>
        </div>
        <div className="scene-editor-field" title="Sens du regard une fois arrivé au point. Auto = garde le sens du trajet d'arrivée.">
          <label>Regard au point</label>
          <div className="scene-config-panel-type-toggle">
            <button
              className={`btn-sm ${selected.facing == null ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchPoint(selected.id, { facing: undefined })}
            >Auto</button>
            <button
              className={`btn-sm ${selected.facing === 'left' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchPoint(selected.id, { facing: 'left' })}
              title="Le perso regarde vers la gauche à ce point"
            >◀ Gauche</button>
            <button
              className={`btn-sm ${selected.facing === 'right' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchPoint(selected.id, { facing: 'right' })}
              title="Le perso regarde vers la droite à ce point"
            >Droite ▶</button>
          </div>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          {pointIndex === 0 ? 'Entrée en scène (trajet hors-champ → point 1)' : `Trajet entrant (depuis le point ${pointIndex})`}
        </div>
        {/* Origine du trajet : point précédent (défaut), hors-champ, ou position libre */}
        <div className="scene-editor-field" style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 12 }}>Départ du trajet</label>
          <div className="scene-config-panel-type-toggle" style={{ flexWrap: 'wrap' }}>
            <button
              className={`btn-sm ${selected.travel.origin == null ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                const travel = { ...selected.travel }
                delete travel.origin
                onPatchPoint(selected.id, { travel })
              }}
              title={pointIndex === 0 ? 'Entrée hors-champ par le côté choisi ci-dessous' : `Le perso part du point ${pointIndex} (ou de sa sortie)`}
            >{pointIndex === 0 ? 'Entrée (défaut)' : 'Point précédent'}</button>
            <button
              className={`btn-sm ${selected.travel.origin?.kind === 'offscreen' && selected.travel.origin.side === 'left' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchPoint(selected.id, { travel: { ...selected.travel, origin: { kind: 'offscreen', side: 'left' } } })}
              title="Le perso revient de hors-champ gauche"
            >← Hors-champ</button>
            <button
              className={`btn-sm ${selected.travel.origin?.kind === 'offscreen' && selected.travel.origin.side === 'right' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchPoint(selected.id, { travel: { ...selected.travel, origin: { kind: 'offscreen', side: 'right' } } })}
              title="Le perso revient de hors-champ droite"
            >Hors-champ →</button>
            <button
              className={`btn-sm ${selected.travel.origin?.kind === 'custom' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                if (selected.travel.origin?.kind === 'custom') return
                onPatchPoint(selected.id, {
                  travel: {
                    ...selected.travel,
                    origin: {
                      kind: 'custom',
                      x: Math.round(Math.max(0, selected.x - Math.min(200, layerW * 0.15))),
                      y: selected.y,
                    },
                  },
                })
              }}
              title="Le perso part d'une position libre sur le décor (losange draggable)"
            >Position libre</button>
            <button
              className={`btn-sm ${selected.travel.origin?.kind === 'appear' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchPoint(selected.id, { travel: { ...selected.travel, origin: { kind: 'appear' } } })}
              title="Pas de trajet d'entrée : le perso apparaît directement posé sur ce point (idéal en début de plan)"
            >✨ Apparition</button>
          </div>
          {selected.travel.origin != null && pointIndex > 0 && !points[pointIndex - 1]?.departure && (
            <span style={{ fontSize: 11, opacity: 0.65 }}>
              ⚠ Le point {pointIndex} n'a pas de trajet de sortie : le perso disparaîtra en cut sec avant ce trajet.
            </span>
          )}
        </div>
        {pointIndex === 0 && selected.travel.origin == null && (
          <div className="scene-editor-field" style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12 }}>Le personnage entre par</label>
            <div className="scene-config-panel-type-toggle">
              <button className={`btn-sm ${plan.entrySide === 'left' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => onPatchPlan({ entrySide: 'left' })}>← Gauche</button>
              <button className={`btn-sm ${plan.entrySide === 'right' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => onPatchPlan({ entrySide: 'right' })}>Droite →</button>
            </div>
          </div>
        )}
        {selected.travel.origin?.kind === 'appear' ? (
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            ✨ Apparition : le perso est posé directement sur le point, sans trajet ni animation de déplacement.
          </span>
        ) : (
          <FilmTravelFields
            travel={selected.travel}
            readyAnimations={readyAnimations}
            defaultSpeed={defaultSpeed}
            onChange={(travel) => onPatchPoint(selected.id, { travel })}
            onFilmSoundImported={onFilmSoundImported}
            onFilmSoundDeleted={onFilmSoundDeleted}
            curveFromTo={{ from: geo.travelFrom(pointIndex), to: { x: selected.x, y: selected.y } }}
          />
        )}
      </div>

      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Action à l'arrivée</div>
        {selected.action ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ActionCard
              action={selected.action}
              readyAnimations={readyAnimations}
              onChange={(partial) => onPatchPoint(selected.id, { action: { ...selected.action!, ...partial } })}
              onSceneSoundImported={onFilmSoundImported}
              onSceneSoundDeleted={onFilmSoundDeleted}
            />
            <button
              className="btn-sm btn-ghost btn-danger"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                if (selected.action?.sound) onFilmSoundDeleted(selected.action.sound.id)
                for (const s of selected.action?.steps ?? []) if (s.sound) onFilmSoundDeleted(s.sound.id)
                onPatchPoint(selected.id, { action: undefined })
              }}
            >
              Retirer l'action (point de passage)
            </button>
          </div>
        ) : (
          <button
            className="btn-sm btn-secondary"
            onClick={() => onPatchPoint(selected.id, { action: { id: crypto.randomUUID(), name: `Action point ${pointIndex + 1}`, steps: [] } })}
          >
            + Ajouter une action
          </button>
        )}
      </div>

      {/* Pause idle au point (après l'action) */}
      <div className="scene-editor-field" style={{ maxWidth: 220 }}>
        <label>Pause au point (s)</label>
        <input
          type="number" min={0} step={0.5}
          placeholder="0"
          value={selected.pauseMs != null && selected.pauseMs > 0 ? selected.pauseMs / 1000 : ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            onPatchPoint(selected.id, { pauseMs: Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : undefined })
          }}
          title="Le perso attend en idle à ce point pendant N secondes (après l'action éventuelle)"
        />
      </div>

      {/* Trajet de sortie (departure) : le perso quitte le point après action/pause */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Trajet de sortie (après l'action / la pause)</div>
        <div className="scene-config-panel-type-toggle" style={{ flexWrap: 'wrap', marginBottom: selected.departure ? 8 : 0 }}>
          <button
            className={`btn-sm ${selected.departure == null ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              if (!selected.departure) return
              if (selected.departure.travel.sound) onFilmSoundDeleted(selected.departure.travel.sound.id)
              onPatchPoint(selected.id, { departure: undefined })
            }}
            title="Pas de sortie : le perso reste au point jusqu'au trajet suivant"
          >Aucun</button>
          <button
            className={`btn-sm ${selected.departure?.target.kind === 'offscreen' && selected.departure.target.side === 'left' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onPatchPoint(selected.id, { departure: { target: { kind: 'offscreen', side: 'left' }, travel: selected.departure?.travel ?? {} } })}
            title="Le perso sort hors-champ à gauche"
          >← Hors-champ</button>
          <button
            className={`btn-sm ${selected.departure?.target.kind === 'offscreen' && selected.departure.target.side === 'right' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => onPatchPoint(selected.id, { departure: { target: { kind: 'offscreen', side: 'right' }, travel: selected.departure?.travel ?? {} } })}
            title="Le perso sort hors-champ à droite"
          >Hors-champ →</button>
          <button
            className={`btn-sm ${selected.departure?.target.kind === 'custom' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              if (selected.departure?.target.kind === 'custom') return
              onPatchPoint(selected.id, {
                departure: {
                  target: {
                    kind: 'custom',
                    x: Math.round(Math.min(layerW, selected.x + Math.min(200, layerW * 0.15))),
                    y: selected.y,
                  },
                  travel: selected.departure?.travel ?? {},
                },
              })
            }}
            title="Le perso marche vers une position libre du décor (losange orange draggable)"
          >Position libre</button>
        </div>
        {selected.departure && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <FilmTravelFields
              travel={selected.departure.travel}
              readyAnimations={readyAnimations}
              defaultSpeed={defaultSpeed}
              onChange={(travel) => onPatchPoint(selected.id, { departure: { ...selected.departure!, travel } })}
              onFilmSoundImported={onFilmSoundImported}
              onFilmSoundDeleted={onFilmSoundDeleted}
              curveFromTo={{ from: { x: selected.x, y: selected.y }, to: geo.departureTo(pointIndex) ?? { x: selected.x, y: selected.y } }}
            />
            {selected.departure.target.kind === 'custom' && (
              <div className="scene-editor-field" style={{ maxWidth: 360 }}>
                <label>Échelle à l'arrivée de la sortie : {(selected.departure.target.scale ?? selected.scale).toFixed(2)}×</label>
                <input
                  type="range" min={0.2} max={3} step={0.05}
                  value={selected.departure.target.scale ?? selected.scale}
                  onChange={(e) => onPatchPoint(selected.id, {
                    departure: {
                      ...selected.departure!,
                      target: { ...(selected.departure!.target as { kind: 'custom'; x: number; y: number }), scale: parseFloat(e.target.value) },
                    },
                  })}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
