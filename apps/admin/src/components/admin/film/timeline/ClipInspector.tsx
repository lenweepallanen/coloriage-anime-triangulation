import type React from 'react'
import type { Animation, FilmAnimClip, FilmMotionClip, FilmPlanTimeline, FilmSound, FilmSoundClip, FilmTravelEasing } from '../../../../types/project'
import type { TimelineSelection } from './TimelineEditor'
import { formatMs } from '../filmEditorShared'
import { FILM_FPS } from '../../../../utils/filmTimeline'

/**
 * Inspecteur du clip sélectionné dans la timeline : champs par type de clip
 * (déplacement / animation / son). La suppression et le drag se font sur la
 * timeline elle-même ; ici on règle les propriétés fines.
 *
 * Layout LOCAL (pas de .scene-editor-field : ses min-width débordent en rangée
 * compacte et les libellés glissent sous le champ voisin) : chaque champ est un
 * bloc insécable libellé AU-DESSUS de son contrôle, la rangée wrappe.
 */

/** Bloc champ : libellé au-dessus, contrôle en dessous — jamais coupé ni chevauché. */
const FIELD: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0,
}
const FIELD_LABEL: React.CSSProperties = {
  fontSize: 11, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap',
}
const INPUT: React.CSSProperties = {
  width: 90, padding: '6px 8px', background: 'var(--color-surface)',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
  color: 'var(--color-text)', fontSize: 'var(--text-sm)', boxSizing: 'border-box',
}
const SELECT: React.CSSProperties = { ...INPUT, width: 'auto', minWidth: 130, maxWidth: 240 }

function Field({ label, title, children }: { label: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <div style={FIELD} title={title}>
      <span style={FIELD_LABEL}>{label}</span>
      {children}
    </div>
  )
}

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
    opts?: { min?: number; step?: number; title?: string },
  ) => (
    <Field label={label} title={opts?.title}>
      <input
        type="number"
        style={INPUT}
        min={opts?.min ?? 0}
        step={opts?.step ?? 0.1}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </Field>
  )

  const header = (title: string) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexBasis: '100%' }}>
      <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
      <div style={{ flex: 1 }} />
      <button className="btn-icon btn-sm btn-danger" onClick={onRemove} title="Supprimer le clip">&times;</button>
    </div>
  )

  /** Conteneur : champs en LIGNE (wrap) sous le canvas — pleine largeur. */
  const ROW: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, rowGap: 12 }

  if (selection.kind === 'motion') {
    const clip = timeline.motion.find(c => c.id === selection.id)
    if (!clip) return null
    const wpIdx = clip.to.kind === 'waypoint' ? timeline.waypoints.findIndex(w => w.id === (clip.to as { id: string }).id) : -1
    const toLbl = wpIdx >= 0 ? `📍 ${wpIdx + 1}` : clip.to.kind === 'offscreen' ? 'hors-champ' : 'position libre'
    const isExit = clip.kind === 'exit' || clip.to.kind === 'free'
    return (
      <div style={ROW}>
        {header(clip.kind === 'appear' ? `✨ Apparition ${toLbl}` : isExit ? `Sortie → ${toLbl}` : `Trajet → ${toLbl}`)}
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
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}
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
        {clip.kind !== 'appear' && (
          <Field label="Animation du trajet" title="Animation du corps jouée pendant CE trajet (un clip Animation posé par-dessus a priorité)">
            <select
              style={SELECT}
              value={clip.animationId ?? ''}
              onChange={(e) => onPatchMotion(clip.id, { animationId: e.target.value || undefined })}
            >
              <option value="">Défaut du film</option>
              {animations.map(a => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
            </select>
          </Field>
        )}
        {clip.kind !== 'appear' && numField('Vitesse anim ×', clip.animSpeedMul ?? 1, v => onPatchMotion(clip.id, { animSpeedMul: v > 0 && v !== 1 ? v : undefined }), { min: 0.1, title: 'Vitesse de lecture de l’animation de marche pendant ce trajet' })}
        <Field label="Allure">
          <select
            style={SELECT}
            value={clip.easing ?? 'linear'}
            onChange={(e) => onPatchMotion(clip.id, { easing: e.target.value === 'linear' ? undefined : e.target.value as FilmTravelEasing })}
          >
            <option value="linear">Constante</option>
            <option value="easeIn">Départ doux</option>
            <option value="easeOut">Arrivée douce</option>
            <option value="easeInOut">Doux départ+arrivée</option>
          </select>
        </Field>
        {clip.kind !== 'appear' && (
          <Field label="Forme du trajet">
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
          </Field>
        )}
      </div>
    )
  }

  if (selection.kind === 'anim') {
    const clip = timeline.anim.find(c => c.id === selection.id)
    if (!clip) return null
    // Durée d'UNE passe de l'animation à la vitesse choisie — la durée du bloc
    // est INDÉPENDANTE : en boucle, l'animation se répète autant que nécessaire.
    const anim = animations.find(a => a.id === clip.animationId)
    const rawFrames = anim?.mesh?.videoFramesMesh?.length ?? anim?.mesh?.walkBodyFrames?.length ?? 0
    const mul = Math.max(0.01, clip.speedMul ?? 1)
    const passMs = rawFrames > 0 ? (rawFrames / (FILM_FPS * mul)) * 1000 : 0
    return (
      <div style={ROW}>
        {header('Clip animation')}
        {passMs > 0 && (
          <div style={{ fontSize: 11, opacity: 0.65, flexBasis: '100%' }}>
            1 passe = {(passMs / 1000).toFixed(2)} s à ×{mul} · durée du bloc indépendante de la vitesse
            {clip.fillMode === 'loop'
              ? ` — boucle : ~${Math.max(1, Math.round(clip.durationMs / passMs))} passes dans le bloc`
              : clip.durationMs > passMs ? ` — figé sur la dernière frame après ${(passMs / 1000).toFixed(2)} s` : ''}
          </div>
        )}
        <Field label="Animation">
          <select style={SELECT} value={clip.animationId} onChange={(e) => onPatchAnim(clip.id, { animationId: e.target.value })}>
            {animations.map(a => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
          </select>
        </Field>
        {numField('Durée du bloc (s)', clip.durationMs / 1000, v => onPatchAnim(clip.id, { durationMs: Math.max(100, Math.round(v * 1000)) }), { min: 0.1, title: 'Durée totale du clip sur la timeline — indépendante de la vitesse' })}
        {numField('Vitesse ×', clip.speedMul ?? 1, v => onPatchAnim(clip.id, { speedMul: v > 0 ? v : undefined }), { min: 0.1, title: 'Vitesse de lecture de l’animation (ne change PAS la durée du bloc)' })}
        <Field label="Remplissage">
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
        </Field>
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
      <Field label={`Volume : ${Math.round((clip.volume ?? 1) * 100)}%`}>
        <input
          type="range" min={0} max={1} step={0.05}
          style={{ width: 140, accentColor: 'var(--color-primary)' }}
          value={clip.volume ?? 1}
          onChange={(e) => patch({ volume: parseFloat(e.target.value) })}
        />
      </Field>
      {numField('Vitesse ×', clip.rate ?? 1, v => patch({ rate: v > 0 && v !== 1 ? v : undefined }), { min: 0.1, title: 'Vitesse de lecture (modifie la hauteur)' })}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }} title="Boucle sur toute la durée du clip">
          <input type="checkbox" checked={clip.loop === true} onChange={(e) => patch({ loop: e.target.checked || undefined })} />
          🔁 boucle
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }} title="Pilote la bouche (lip-sync) pendant la lecture">
          <input type="checkbox" checked={clip.isSpoken === true} onChange={(e) => patch({ isSpoken: e.target.checked || undefined })} />
          🗣 parlé
        </label>
      </div>
      {numField('Fade in (s)', (clip.fadeInMs ?? 0) / 1000, v => patch({ fadeInMs: v > 0 ? Math.round(v * 1000) : undefined }), { min: 0, step: 0.1 })}
      {numField('Fade out (s)', (clip.fadeOutMs ?? 0) / 1000, v => patch({ fadeOutMs: v > 0 ? Math.round(v * 1000) : undefined }), { min: 0, step: 0.1 })}
      {/* Ancrage ⚓ : le début du son est calé sur un clip motion/anim + offset.
          Ex. rugissement à +2 s du début de l'anim rugissement. */}
      <Field label="⚓ Ancrer à" title="Le début du son suit ce clip : le déplacer déplace le son">
        <select
          style={SELECT}
          value={clip.anchor?.clipId ?? ''}
          onChange={(e) => {
            const clipId = e.target.value
            if (!clipId) patch({ anchor: undefined })
            else patch({ anchor: { clipId, edge: clip.anchor?.edge ?? 'start', offsetMs: clip.anchor?.offsetMs ?? 0 } })
          }}
        >
          <option value="">— libre (temps absolu) —</option>
          {anchorTargets.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </Field>
      {clip.anchor && (
        <>
          <Field label="Bord">
            <select
              style={{ ...SELECT, minWidth: 90 }}
              value={clip.anchor.edge}
              onChange={(e) => patch({ anchor: { ...clip.anchor!, edge: e.target.value as 'start' | 'end' } })}
            >
              <option value="start">Début</option>
              <option value="end">Fin</option>
            </select>
          </Field>
          <Field label="Décalage (s)" title="Peut être négatif (le son démarre avant le bord ancré)">
            <input
              type="number" step={0.1}
              style={INPUT}
              value={clip.anchor.offsetMs / 1000}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (Number.isFinite(v)) patch({ anchor: { ...clip.anchor!, offsetMs: Math.round(v * 1000) } })
              }}
            />
          </Field>
        </>
      )}
    </div>
  )
}
