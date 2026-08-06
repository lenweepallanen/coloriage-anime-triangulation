import type React from 'react'
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
  anchorTargets, motionPathLen,
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
  /** Cibles d'ancrage ⚓ (clips motion + anim du plan, libellés). */
  anchorTargets: { id: string; label: string }[]
  /** Longueur du chemin d'un MotionClip (px décor) — pour la vitesse dérivée. */
  motionPathLen: (id: string) => number
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexBasis: '100%' }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
      <div style={{ flex: 1 }} />
      <button className="btn-icon btn-sm btn-danger" onClick={onRemove} title="Supprimer le clip">&times;</button>
    </div>
  )

  /** Conteneur : champs en LIGNE (wrap) sous le canvas — pleine largeur. */
  const ROW: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16 }

  if (selection.kind === 'motion') {
    const clip = timeline.motion.find(c => c.id === selection.id)
    if (!clip) return null
    return (
      <div style={ROW}>
        {header(clip.kind === 'appear' ? '✨ Apparition' : clip.kind === 'exit' ? 'Clip sortie' : 'Clip trajet')}
        <div style={{ fontSize: 11, opacity: 0.65, flexBasis: '100%' }}>
          {formatMs(clip.startMs)} → {formatMs(clip.startMs + clip.durationMs)}
          {clip.to.kind === 'waypoint' && ' · vers un point du canvas'}
          {clip.to.kind === 'offscreen' && ` · vers hors-champ ${clip.to.side === 'left' ? '←' : '→'}`}
        </div>
        {clip.kind !== 'appear' && (() => {
          const pathLen = motionPathLen(clip.id)
          const speed = clip.durationMs > 0 ? Math.round((pathLen / clip.durationMs) * 1000) : 0
          const locked = clip.lockedSpeedPxPerSec != null
          return (
            <>
              {locked ? (
                <div style={{ fontSize: 11, opacity: 0.75 }}>
                  Durée : {(clip.durationMs / 1000).toFixed(2)} s (dérivée de la vitesse verrouillée)
                </div>
              ) : (
                numField('Durée (s)', clip.durationMs / 1000, v => onPatchMotion(clip.id, { durationMs: Math.max(100, Math.round(v * 1000)) }), { min: 0.1, title: 'La durée est la donnée maîtresse — la vitesse en découle' })
              )}
              <label
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
                title="Verrouillé : déplacer les points/courbes recalcule la durée pour garder cette vitesse constante"
              >
                <input
                  type="checkbox"
                  checked={locked}
                  onChange={(e) => onPatchMotion(clip.id, { lockedSpeedPxPerSec: e.target.checked ? Math.max(1, speed) : undefined })}
                />
                🔒 vitesse verrouillée — {locked ? clip.lockedSpeedPxPerSec : speed} px/s
              </label>
            </>
          )
        })()}
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
      <div style={ROW}>
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
    <div style={ROW}>
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
      {/* Ancrage ⚓ : le début du son est calé sur un clip motion/anim + offset.
          Ex. rugissement à +2 s du début de l'anim rugissement. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <div className="scene-editor-field" style={{ minWidth: 220 }}>
          <label style={{ fontSize: 11 }}>⚓ Ancrer à</label>
          <select
            value={clip.anchor?.clipId ?? ''}
            onChange={(e) => {
              const clipId = e.target.value
              if (!clipId) patch({ anchor: undefined })
              else patch({ anchor: { clipId, edge: clip.anchor?.edge ?? 'start', offsetMs: clip.anchor?.offsetMs ?? 0 } })
            }}
            title="Le début du son suit ce clip : le déplacer déplace le son"
          >
            <option value="">— libre (temps absolu) —</option>
            {anchorTargets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        {clip.anchor && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="scene-editor-field" style={{ maxWidth: 120 }}>
              <label style={{ fontSize: 11 }}>Bord</label>
              <select
                value={clip.anchor.edge}
                onChange={(e) => patch({ anchor: { ...clip.anchor!, edge: e.target.value as 'start' | 'end' } })}
              >
                <option value="start">Début</option>
                <option value="end">Fin</option>
              </select>
            </div>
            <div className="scene-editor-field" style={{ maxWidth: 130 }}>
              <label style={{ fontSize: 11 }}>Décalage (s)</label>
              <input
                type="number" step={0.1}
                value={clip.anchor.offsetMs / 1000}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isFinite(v)) patch({ anchor: { ...clip.anchor!, offsetMs: Math.round(v * 1000) } })
                }}
                title="Peut être négatif (le son démarre avant le bord ancré)"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
