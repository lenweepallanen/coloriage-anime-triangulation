import type { Animation, FilmAnimClip, FilmMotionClip, FilmPlanTimeline, FilmSound, FilmSoundClip, FilmTravelEasing } from '../../../../types/project'
import type { TimelineSelection } from './TimelineEditor'
import { formatMs } from '../filmEditorShared'

/**
 * Inspecteur du clip sélectionné dans la timeline : champs par type de clip
 * (déplacement / animation / son). La suppression et le drag se font sur la
 * timeline elle-même ; ici on règle les propriétés fines.
 */
export default function ClipInspector({
  timeline, selection, animations, sounds,
  onPatchMotion, onSetMotionCurve, onPatchAnim, onPatchSound, onRemove,
}: {
  timeline: FilmPlanTimeline
  selection: NonNullable<TimelineSelection>
  animations: Animation[]
  sounds: FilmSound[]
  onPatchMotion: (id: string, partial: Partial<FilmMotionClip>) => void
  /** Change la forme du trajet (0 = droit, 1/2 = CPs posés au milieu, draggables sur le canvas). */
  onSetMotionCurve: (id: string, count: 0 | 1 | 2) => void
  onPatchAnim: (id: string, partial: Partial<FilmAnimClip>) => void
  onPatchSound: (trackIndex: number, id: string, partial: Partial<FilmSoundClip>) => void
  onRemove: () => void
}) {
  const numField = (
    label: string, value: number, onChange: (v: number) => void,
    opts?: { min?: number; step?: number; title?: string; suffix?: string },
  ) => (
    <div className="scene-editor-field" style={{ maxWidth: 170 }}>
      <label style={{ fontSize: 11 }}>{label}</label>
      <input
        type="number"
        min={opts?.min ?? 0}
        step={opts?.step ?? 0.1}
        value={value}
        title={opts?.title}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </div>
  )

  const header = (title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
      <div style={{ flex: 1 }} />
      <button className="btn-icon btn-sm btn-danger" onClick={onRemove} title="Supprimer le clip">&times;</button>
    </div>
  )

  if (selection.kind === 'motion') {
    const clip = timeline.motion.find(c => c.id === selection.id)
    if (!clip) return null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {header(clip.kind === 'appear' ? '✨ Apparition' : clip.kind === 'exit' ? 'Clip sortie' : 'Clip trajet')}
        <div style={{ fontSize: 11, opacity: 0.65 }}>
          {formatMs(clip.startMs)} → {formatMs(clip.startMs + clip.durationMs)}
          {clip.to.kind === 'waypoint' && ' · vers un point du canvas'}
          {clip.to.kind === 'offscreen' && ` · vers hors-champ ${clip.to.side === 'left' ? '←' : '→'}`}
        </div>
        {clip.kind !== 'appear' && numField('Durée (s)', clip.durationMs / 1000, v => onPatchMotion(clip.id, { durationMs: Math.max(100, Math.round(v * 1000)) }), { min: 0.1, title: 'La durée est la donnée maîtresse — la vitesse en découle' })}
        <div className="scene-editor-field" style={{ maxWidth: 170 }}>
          <label style={{ fontSize: 11 }}>Allure</label>
          <select
            value={clip.easing ?? 'linear'}
            onChange={(e) => onPatchMotion(clip.id, { easing: e.target.value === 'linear' ? undefined : e.target.value as FilmTravelEasing })}
          >
            <option value="linear">Constante</option>
            <option value="easeIn">Départ doux</option>
            <option value="easeOut">Arrivée douce</option>
            <option value="easeInOut">Doux départ+arrivée</option>
          </select>
        </div>
        {clip.kind !== 'appear' && (
          <div className="scene-editor-field" style={{ maxWidth: 220 }}>
            <label style={{ fontSize: 11 }}>Forme du trajet</label>
            <div className="scene-config-panel-type-toggle">
              {([0, 1, 2] as const).map(n => (
                <button
                  key={n}
                  className={`btn-sm ${(clip.controlPoints?.length ?? 0) === n ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => onSetMotionCurve(clip.id, n)}
                  title={n === 0 ? 'Trajet droit' : `Courbe Bézier à ${n} point${n > 1 ? 's' : ''} de contrôle (draggables sur le canvas)`}
                >{n === 0 ? 'Droit' : `${n} CP`}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (selection.kind === 'anim') {
    const clip = timeline.anim.find(c => c.id === selection.id)
    if (!clip) return null
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {header('Clip animation')}
        <div className="scene-editor-field">
          <label style={{ fontSize: 11 }}>Animation</label>
          <select value={clip.animationId} onChange={(e) => onPatchAnim(clip.id, { animationId: e.target.value })}>
            {animations.map(a => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
          </select>
        </div>
        {numField('Durée (s)', clip.durationMs / 1000, v => onPatchAnim(clip.id, { durationMs: Math.max(100, Math.round(v * 1000)) }), { min: 0.1 })}
        {numField('Vitesse ×', clip.speedMul ?? 1, v => onPatchAnim(clip.id, { speedMul: v > 0 ? v : undefined }), { min: 0.1, title: 'Vitesse de lecture de l’animation' })}
        <div className="scene-editor-field" style={{ maxWidth: 220 }}>
          <label style={{ fontSize: 11 }}>Remplissage</label>
          <div className="scene-config-panel-type-toggle">
            <button
              className={`btn-sm ${clip.fillMode === 'loop' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchAnim(clip.id, { fillMode: 'loop' })}
              title="Rejoue en boucle sur toute la durée du clip"
            >🔁 Boucle</button>
            <button
              className={`btn-sm ${clip.fillMode === 'once-hold' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => onPatchAnim(clip.id, { fillMode: 'once-hold' })}
              title="Une passe, puis figé sur la dernière frame"
            >1× puis figé</button>
          </div>
        </div>
      </div>
    )
  }

  // Son
  const track = timeline.soundTracks[selection.trackIndex] ?? []
  const clip = track.find(c => c.id === selection.id)
  if (!clip) return null
  const patch = (partial: Partial<FilmSoundClip>) => onPatchSound(selection.trackIndex, clip.id, partial)
  const soundName = sounds.find(x => x.id === clip.soundId)?.name ?? clip.soundId.slice(0, 8)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {header(`Clip son — ${soundName}`)}
      {numField('Durée (s)', clip.durationMs / 1000, v => patch({ durationMs: Math.max(100, Math.round(v * 1000)) }), { min: 0.1, title: 'Tronque ou étend (loop) le son' })}
      <div className="scene-editor-field" style={{ maxWidth: 200 }}>
        <label style={{ fontSize: 11 }}>Volume : {Math.round((clip.volume ?? 1) * 100)}%</label>
        <input
          type="range" min={0} max={1} step={0.05}
          value={clip.volume ?? 1}
          onChange={(e) => patch({ volume: parseFloat(e.target.value) })}
        />
      </div>
      {numField('Vitesse ×', clip.rate ?? 1, v => patch({ rate: v > 0 && v !== 1 ? v : undefined }), { min: 0.1, title: 'Vitesse de lecture (modifie la hauteur)' })}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }} title="Boucle sur toute la durée du clip">
          <input type="checkbox" checked={clip.loop === true} onChange={(e) => patch({ loop: e.target.checked || undefined })} />
          🔁 boucle
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }} title="Pilote la bouche (lip-sync) pendant la lecture">
          <input type="checkbox" checked={clip.isSpoken === true} onChange={(e) => patch({ isSpoken: e.target.checked || undefined })} />
          🗣 parlé
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {numField('Fade in (s)', (clip.fadeInMs ?? 0) / 1000, v => patch({ fadeInMs: v > 0 ? Math.round(v * 1000) : undefined }), { min: 0, step: 0.1 })}
        {numField('Fade out (s)', (clip.fadeOutMs ?? 0) / 1000, v => patch({ fadeOutMs: v > 0 ? Math.round(v * 1000) : undefined }), { min: 0, step: 0.1 })}
      </div>
    </div>
  )
}
