import { useCallback, useRef, useState } from 'react'
import type { Animation, FilmTravel, FilmTravelEasing, Point2D, SceneSound } from '../../../types/project'
import { defaultControlPoints } from './filmEditorShared'

/**
 * Champs d'édition d'un trajet de film : animation, vitesse, vitesse de lecture,
 * forme (droit / courbe Bézier), allure (easing) et son de trajet.
 */
export default function FilmTravelFields({ travel, readyAnimations, defaultSpeed, onChange, onFilmSoundImported, onFilmSoundDeleted, curveFromTo }: {
  travel: FilmTravel
  readyAnimations: Animation[]
  defaultSpeed: number
  onChange: (travel: FilmTravel) => void
  onFilmSoundImported: (soundId: string) => void
  onFilmSoundDeleted: (soundId: string) => void
  /** Endpoints du trajet (coords backdrop) pour initialiser les points de contrôle Bézier. */
  curveFromTo?: { from: Point2D; to: Point2D }
}) {
  const cpCount = travel.controlPoints?.length ?? 0
  const setShape = (count: 0 | 1 | 2) => {
    const next = { ...travel }
    if (count === 0) delete next.controlPoints
    else if (curveFromTo) next.controlPoints = defaultControlPoints(curveFromTo.from, curveFromTo.to, count)
    else return
    onChange(next)
  }
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div className="scene-editor-field">
        <label style={{ fontSize: 12 }}>Animation</label>
        <select
          value={travel.animationId ?? ''}
          onChange={(e) => {
            const next = { ...travel }
            if (e.target.value) next.animationId = e.target.value
            else delete next.animationId
            onChange(next)
          }}
        >
          <option value="">(défaut du film)</option>
          {readyAnimations.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
          ))}
        </select>
      </div>
      <div className="scene-editor-field">
        <label style={{ fontSize: 12 }}>Vitesse (px/s)</label>
        <input
          type="number" min={10} step={10}
          placeholder={String(defaultSpeed)}
          value={travel.speedPxPerSec ?? ''}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            const next = { ...travel }
            if (Number.isFinite(v) && v > 0) next.speedPxPerSec = v
            else delete next.speedPxPerSec
            onChange(next)
          }}
          style={{ width: 90 }}
        />
      </div>
      <div className="scene-editor-field" title="Multiplicateur de vitesse de lecture de l'animation (ex. déplacement 2× plus rapide → 2 pour que les jambes suivent)">
        <label style={{ fontSize: 12 }}>Anim ×</label>
        <input
          type="number" min={0.1} step={0.1}
          placeholder="1"
          value={travel.animSpeedMul ?? ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            const next = { ...travel }
            if (Number.isFinite(v) && v > 0) next.animSpeedMul = v
            else delete next.animSpeedMul
            onChange(next)
          }}
          style={{ width: 90 }}
        />
      </div>
      {curveFromTo && (
        <div className="scene-editor-field" title="Forme du trajet : droit ou courbe Bézier (points de contrôle blancs draggables sur le décor)">
          <label style={{ fontSize: 12 }}>Forme</label>
          <div className="scene-config-panel-type-toggle">
            <button className={`btn-sm ${cpCount === 0 ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShape(0)}>Droit</button>
            <button className={`btn-sm ${cpCount === 1 ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShape(1)}>Courbe 1 pt</button>
            <button className={`btn-sm ${cpCount === 2 ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setShape(2)}>Courbe 2 pts</button>
          </div>
        </div>
      )}
      <div className="scene-editor-field" title="Accélération/décélération du trajet (la durée totale ne change pas)">
        <label style={{ fontSize: 12 }}>Allure</label>
        <select
          value={travel.easing ?? ''}
          onChange={(e) => {
            const next = { ...travel }
            if (e.target.value) next.easing = e.target.value as FilmTravelEasing
            else delete next.easing
            onChange(next)
          }}
        >
          <option value="">Constante</option>
          <option value="easeIn">Départ doux</option>
          <option value="easeOut">Arrivée douce</option>
          <option value="easeInOut">Doux (les deux)</option>
        </select>
      </div>
      <FilmTravelSoundRow
        sound={travel.sound}
        onImport={(file) => {
          if (travel.sound) onFilmSoundDeleted(travel.sound.id)
          const id = crypto.randomUUID()
          onChange({ ...travel, sound: { id, name: file.name, blob: file } })
          onFilmSoundImported(id)
        }}
        onDelete={() => {
          if (!travel.sound) return
          onFilmSoundDeleted(travel.sound.id)
          const next = { ...travel }
          delete next.sound
          onChange(next)
        }}
        onVolume={(v) => {
          if (!travel.sound) return
          onChange({ ...travel, sound: { ...travel.sound, volume: v } })
        }}
        onToggleLoop={(loop) => {
          if (!travel.sound) return
          onChange({ ...travel, sound: { ...travel.sound, loop: loop || undefined } })
        }}
        onRate={(rate) => {
          if (!travel.sound) return
          onChange({ ...travel, sound: { ...travel.sound, rate } })
        }}
      />
    </div>
  )
}

/** Ligne son de trajet (import / preview / loop / vitesse / volume / delete). */
function FilmTravelSoundRow({ sound, onImport, onDelete, onVolume, onToggleLoop, onRate }: {
  sound: SceneSound | undefined
  onImport: (file: File) => void
  onDelete: () => void
  onVolume: (v: number) => void
  onToggleLoop: (loop: boolean) => void
  onRate: (rate: number | undefined) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const togglePreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      try { URL.revokeObjectURL(audioRef.current.src) } catch { /* */ }
      audioRef.current = null
      setPlaying(false)
      return
    }
    if (!sound?.blob) return
    const url = URL.createObjectURL(sound.blob)
    const audio = new Audio(url)
    audio.volume = sound.volume ?? 1
    audio.playbackRate = sound.rate ?? 1
    audioRef.current = audio
    setPlaying(true)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null }
  }, [sound])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ opacity: 0.7 }}>Son :</span>
      {sound ? (
        <>
          <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sound.name}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }} title="Boucle pendant tout le trajet, coupé à l'arrivée (ex. bruit de pas)">
            <input
              type="checkbox"
              checked={sound.loop ?? false}
              onChange={(e) => onToggleLoop(e.target.checked)}
            />
            loop
          </label>
          <input
            type="number" min={0.1} step={0.1}
            placeholder="×1"
            value={sound.rate ?? ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              onRate(Number.isFinite(v) && v > 0 ? v : undefined)
            }}
            style={{ width: 64 }}
            title="Vitesse de lecture du son (synchro son ↔ animation ; modifie la hauteur)"
          />
          <input
            type="range" min={0} max={1} step={0.05}
            value={sound.volume ?? 1}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              onVolume(v)
              if (audioRef.current) audioRef.current.volume = v
            }}
            style={{ width: 70 }}
            title={`Volume : ${Math.round((sound.volume ?? 1) * 100)}%`}
          />
          <button className="btn-icon btn-sm" onClick={togglePreview} disabled={!sound.blob} title={playing ? 'Stop' : 'Écouter'}>
            {playing ? '⏹' : '▶'}
          </button>
          <button className="btn-icon btn-sm btn-danger" onClick={onDelete} title="Retirer">&times;</button>
        </>
      ) : (
        <>
          <button className="btn-sm btn-ghost" onClick={() => fileInputRef.current?.click()}>+ son</button>
          <input
            ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onImport(file)
              e.target.value = ''
            }}
          />
        </>
      )}
    </div>
  )
}
