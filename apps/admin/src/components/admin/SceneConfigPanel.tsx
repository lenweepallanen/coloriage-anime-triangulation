import { useState, useRef, useCallback } from 'react'
import { animationHasFrames, type SceneRestPoint, type SceneAction, type SceneActionStep, type SceneSound, type Animation, type SpeakSound, type BodyZone, type ZoneAnimationMapping } from '../../types/project'

interface Props {
  restPoint: SceneRestPoint
  animations: Animation[]
  bodyZones: BodyZone[]
  onRestPointChange: (updated: SceneRestPoint) => void
  speakSounds: SpeakSound[]
  speakSoundBlobs: (Blob | null)[]
  onSpeakSoundImport: (file: File) => void
  onSpeakSoundDelete: (soundId: string) => void
  onSceneSoundImported: (soundId: string) => void
  onSceneSoundDeleted: (soundId: string) => void
}

export default function SceneConfigPanel({
  restPoint: rp,
  animations,
  bodyZones,
  onRestPointChange,
  speakSounds,
  speakSoundBlobs,
  onSpeakSoundImport,
  onSpeakSoundDelete,
  onSceneSoundImported,
  onSceneSoundDeleted,
}: Props) {
  const readyAnimations = animations.filter(a => animationHasFrames(a))
  const actions = rp.actions ?? []

  const updateActions = (next: SceneAction[]) => {
    onRestPointChange({ ...rp, actions: next.length > 0 ? next : undefined })
  }

  const handleAddAction = () => {
    const newAction: SceneAction = {
      id: crypto.randomUUID(),
      name: `Action ${actions.length + 1}`,
      steps: [],
    }
    updateActions([...actions, newAction])
  }

  const handleUpdateAction = (idx: number, partial: Partial<SceneAction>) => {
    updateActions(actions.map((a, i) => i === idx ? { ...a, ...partial } : a))
  }

  const handleDeleteAction = (idx: number) => {
    const a = actions[idx]
    if (a?.sound) onSceneSoundDeleted(a.sound.id)
    for (const s of a?.steps ?? []) if (s.sound) onSceneSoundDeleted(s.sound.id)
    updateActions(actions.filter((_, i) => i !== idx))
  }

  return (
    <div className="scene-config-panel">
      <div className="scene-config-panel-header">
        <h4>Rest Point</h4>
        <span className="scene-config-panel-pos">X: {rp.backgroundX}px</span>
      </div>

      <div className="scene-config-panel-field">
        <label>Animation idle (boucle)</label>
        <select
          value={rp.restAnimationId ?? ''}
          onChange={(e) => onRestPointChange({ ...rp, restAnimationId: e.target.value || undefined })}
        >
          <option value="">(Aucune)</option>
          {readyAnimations.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
          ))}
        </select>
        {readyAnimations.length === 0 && (
          <span className="scene-config-panel-empty">Aucune animation prête.</span>
        )}
      </div>

      <div className="scene-config-panel-field">
        <label>Actions (bouton ☆)</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {actions.map((action, idx) => (
            <ActionCard
              key={action.id}
              action={action}
              readyAnimations={readyAnimations}
              onChange={(partial) => handleUpdateAction(idx, partial)}
              onDelete={() => handleDeleteAction(idx)}
              onSceneSoundImported={onSceneSoundImported}
              onSceneSoundDeleted={onSceneSoundDeleted}
            />
          ))}
          <button className="btn-sm btn-secondary" onClick={handleAddAction}>
            + Nouvelle action
          </button>
          {actions.length === 0 && (
            <span className="scene-config-panel-empty">Aucune action — clique sur "+ Nouvelle action" pour ajouter une séquence d'animations déclenchée par le bouton ☆.</span>
          )}
        </div>
      </div>

      {bodyZones.length > 0 && (
        <ZoneAnimationMappingsSection
          rp={rp}
          bodyZones={bodyZones}
          animations={readyAnimations}
          onRestPointChange={onRestPointChange}
        />
      )}

      <SpeakSoundsSection
        rp={rp}
        speakSounds={speakSounds}
        speakSoundBlobs={speakSoundBlobs}
        onRestPointChange={onRestPointChange}
        onSpeakSoundImport={onSpeakSoundImport}
        onSpeakSoundDelete={onSpeakSoundDelete}
      />

      <div className="scene-config-panel-field">
        <label>Fondu d'arrivée (ms) — {rp.arrivalCrossfadeMs ?? 290}</label>
        <input
          type="range" min={0} max={3000} step={10}
          value={rp.arrivalCrossfadeMs ?? 290}
          onChange={(e) => onRestPointChange({ ...rp, arrivalCrossfadeMs: parseInt(e.target.value, 10) })}
        />
      </div>

      <HelpTextsSection rp={rp} onRestPointChange={onRestPointChange} />
    </div>
  )
}

// --- Action card (séquence ordonnée + son unique) ---

function ActionCard({ action, readyAnimations, onChange, onDelete, onSceneSoundImported, onSceneSoundDeleted }: {
  action: SceneAction
  readyAnimations: Animation[]
  onChange: (partial: Partial<SceneAction>) => void
  onDelete: () => void
  onSceneSoundImported: (soundId: string) => void
  onSceneSoundDeleted: (soundId: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [playingSound, setPlayingSound] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const updateStep = (i: number, partial: Partial<SceneActionStep>) => {
    const next = [...action.steps]
    next[i] = { ...next[i], ...partial }
    onChange({ steps: next })
  }
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= action.steps.length) return
    const next = [...action.steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange({ steps: next })
  }
  const removeStep = (i: number) => {
    const removed = action.steps[i]
    if (removed?.sound) onSceneSoundDeleted(removed.sound.id)
    onChange({ steps: action.steps.filter((_, k) => k !== i) })
  }
  const addStep = () => {
    onChange({ steps: [...action.steps, { animationId: readyAnimations[0]?.id ?? '' }] })
  }
  const setStepSound = (i: number, sound: SceneSound | undefined) => {
    const prev = action.steps[i]?.sound
    if (prev && (!sound || prev.id !== sound.id)) onSceneSoundDeleted(prev.id)
    updateStep(i, { sound })
  }

  const handleSoundImport = (file: File) => {
    if (action.sound) onSceneSoundDeleted(action.sound.id)
    const id = crypto.randomUUID()
    onChange({ sound: { id, name: file.name, blob: file } })
    onSceneSoundImported(id)
  }

  const handleSoundDelete = () => {
    if (!action.sound) return
    onSceneSoundDeleted(action.sound.id)
    onChange({ sound: undefined })
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; setPlayingSound(false) }
  }

  const togglePreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      try { URL.revokeObjectURL(audioRef.current.src) } catch { /* */ }
      audioRef.current = null
      setPlayingSound(false)
      return
    }
    if (!action.sound?.blob) return
    const url = URL.createObjectURL(action.sound.blob)
    const audio = new Audio(url)
    audioRef.current = audio
    setPlayingSound(true)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlayingSound(false); audioRef.current = null }
  }, [action.sound])

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="text"
          value={action.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Nom de l'action"
          style={{ flex: 1 }}
        />
        <button className="btn-icon btn-sm btn-danger" onClick={onDelete} title="Supprimer l'action">&times;</button>
      </div>

      {/* Steps */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 8 }}>
        {action.steps.map((step, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 4, background: 'var(--bg-soft, rgba(255,255,255,0.03))', borderRadius: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 24, opacity: 0.5, fontSize: 12 }}>{i + 1}.</span>
              <select
                value={step.animationId}
                onChange={(e) => updateStep(i, { animationId: e.target.value })}
                style={{ flex: 1 }}
              >
                <option value="">— Aucune —</option>
                {readyAnimations.map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                ))}
              </select>
              <button className="btn-icon btn-sm" onClick={() => moveStep(i, -1)} disabled={i === 0} title="Monter">↑</button>
              <button className="btn-icon btn-sm" onClick={() => moveStep(i, +1)} disabled={i === action.steps.length - 1} title="Descendre">↓</button>
              <button className="btn-icon btn-sm btn-danger" onClick={() => removeStep(i)} title="Retirer">&times;</button>
            </div>
            <StepSoundRow
              step={step}
              onChange={(partial) => updateStep(i, partial)}
              onImport={(file) => {
                const id = crypto.randomUUID()
                setStepSound(i, { id, name: file.name, blob: file })
                onSceneSoundImported(id)
              }}
              onDelete={() => setStepSound(i, undefined)}
            />
          </div>
        ))}
        <button className="btn-sm btn-ghost" onClick={addStep} disabled={readyAnimations.length === 0} style={{ alignSelf: 'flex-start' }}>
          + Animation
        </button>
      </div>

      {/* Action sound */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 8 }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Son d'action :</span>
        {action.sound ? (
          <>
            <span style={{ fontSize: 12, flex: 1 }}>{action.sound.name}</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }} title="Pilote la bouche (lip-sync) pendant la lecture">
              <input
                type="checkbox"
                checked={action.isSpoken ?? false}
                onChange={(e) => onChange({ isSpoken: e.target.checked || undefined })}
              />
              parlé
            </label>
            <button className="btn-icon btn-sm" onClick={togglePreview} disabled={!action.sound.blob} title={playingSound ? 'Stop' : 'Écouter'}>
              {playingSound ? '⏹' : '▶'}
            </button>
            <button className="btn-icon btn-sm btn-danger" onClick={handleSoundDelete} title="Retirer">&times;</button>
          </>
        ) : (
          <>
            <button className="btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>
              + Importer
            </button>
            <input
              ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleSoundImport(file)
                e.target.value = ''
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}

// --- Row for a step's sound (import + delete + spoken toggle + preview) ---

function StepSoundRow({ step, onChange, onImport, onDelete }: {
  step: SceneActionStep
  onChange: (partial: Partial<SceneActionStep>) => void
  onImport: (file: File) => void
  onDelete: () => void
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
    if (!step.sound?.blob) return
    const url = URL.createObjectURL(step.sound.blob)
    const audio = new Audio(url)
    audioRef.current = audio
    setPlaying(true)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null }
  }, [step.sound])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 28, fontSize: 12 }}>
      <span style={{ opacity: 0.7 }}>son :</span>
      {step.sound ? (
        <>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.sound.name}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }} title="Pilote la bouche (lip-sync) pendant la lecture">
            <input
              type="checkbox"
              checked={step.isSpoken ?? false}
              onChange={(e) => onChange({ isSpoken: e.target.checked || undefined })}
            />
            parlé
          </label>
          <button className="btn-icon btn-sm" onClick={togglePreview} disabled={!step.sound.blob} title={playing ? 'Stop' : 'Écouter'}>
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

// --- Speak Sounds sub-section ---

function SpeakSoundsSection({ rp, speakSounds, speakSoundBlobs, onRestPointChange, onSpeakSoundImport, onSpeakSoundDelete }: {
  rp: SceneRestPoint
  speakSounds: SpeakSound[]
  speakSoundBlobs: (Blob | null)[]
  onRestPointChange: (updated: SceneRestPoint) => void
  onSpeakSoundImport: (file: File) => void
  onSpeakSoundDelete: (soundId: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const handlePreview = useCallback((soundId: string) => {
    if (audioRef.current) {
      audioRef.current.pause()
      URL.revokeObjectURL(audioRef.current.src)
      audioRef.current = null
    }
    if (playingId === soundId) { setPlayingId(null); return }
    const idx = speakSounds.findIndex(s => s.id === soundId)
    const blob = idx >= 0 ? speakSoundBlobs[idx] : null
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audioRef.current = audio
    setPlayingId(soundId)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlayingId(null); audioRef.current = null }
  }, [playingId, speakSounds, speakSoundBlobs])

  return (
    <div className="scene-config-panel-field">
      <label>Sons "Parler"</label>
      <button className="btn-sm btn-secondary" style={{ marginBottom: 8 }} onClick={() => fileInputRef.current?.click()}>
        + Importer son
      </button>
      <input
        ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onSpeakSoundImport(file)
          e.target.value = ''
        }}
      />
      <div className="scene-config-panel-checkboxes">
        {speakSounds.map(sound => {
          const checked = rp.speakSoundIds?.includes(sound.id) ?? false
          return (
            <div key={sound.id} className="scene-config-panel-sound-row">
              <label className="scene-config-panel-checkbox">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const current = rp.speakSoundIds ?? []
                    const updated = e.target.checked
                      ? [...current, sound.id]
                      : current.filter(id => id !== sound.id)
                    onRestPointChange({ ...rp, speakSoundIds: updated })
                  }}
                />
                <span>{sound.name}</span>
              </label>
              <div className="scene-config-panel-sound-actions">
                <button className="btn-icon btn-sm" onClick={() => handlePreview(sound.id)} title={playingId === sound.id ? 'Stop' : 'Écouter'}>
                  {playingId === sound.id ? '⏹' : '▶'}
                </button>
                <button className="btn-icon btn-sm btn-danger" onClick={() => onSpeakSoundDelete(sound.id)} title="Supprimer">&times;</button>
              </div>
            </div>
          )
        })}
        {speakSounds.length === 0 && (
          <span className="scene-config-panel-empty">Aucun son importé</span>
        )}
      </div>
    </div>
  )
}

// --- Zone Animation Mappings sub-section ---

function ZoneAnimationMappingsSection({ rp, bodyZones, animations, onRestPointChange }: {
  rp: SceneRestPoint
  bodyZones: BodyZone[]
  animations: Animation[]
  onRestPointChange: (updated: SceneRestPoint) => void
}) {
  const mappings = rp.zoneAnimationMappings ?? []
  const handleChange = (zoneId: string, animationId: string) => {
    const filtered = mappings.filter(m => m.zoneId !== zoneId)
    const updated: ZoneAnimationMapping[] = animationId
      ? [...filtered, { zoneId, animationId }]
      : filtered
    onRestPointChange({ ...rp, zoneAnimationMappings: updated })
  }
  return (
    <div className="scene-config-panel-field">
      <label>Zones Corporelles</label>
      <div className="scene-config-panel-checkboxes">
        {bodyZones.map(zone => {
          const mapping = mappings.find(m => m.zoneId === zone.id)
          return (
            <div key={zone.id} className="scene-config-panel-zone-row">
              <span className="scene-config-panel-zone-swatch" style={{ backgroundColor: zone.color }} />
              <span className="scene-config-panel-zone-label">{zone.label}</span>
              <select value={mapping?.animationId ?? ''} onChange={e => handleChange(zone.id, e.target.value)}>
                <option value="">— Aucune —</option>
                {animations.map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                ))}
              </select>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- Help Texts sub-section ---

function HelpTextsSection({ rp, onRestPointChange }: {
  rp: SceneRestPoint
  onRestPointChange: (updated: SceneRestPoint) => void
}) {
  const [newText, setNewText] = useState('')
  const texts = rp.helpTexts ?? []

  const handleAdd = () => {
    const trimmed = newText.trim()
    if (!trimmed) return
    onRestPointChange({ ...rp, helpTexts: [...texts, trimmed] })
    setNewText('')
  }
  const handleRemove = (index: number) => {
    onRestPointChange({ ...rp, helpTexts: texts.filter((_, i) => i !== index) })
  }

  return (
    <div className="scene-config-panel-field">
      <label>Textes d'aide "?"</label>
      <div className="scene-config-panel-help-add">
        <input
          type="text" value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="Nouveau texte d'aide..."
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd() }}
        />
        <button className="btn-sm btn-secondary" onClick={handleAdd}>+</button>
      </div>
      <div className="scene-config-panel-help-list">
        {texts.map((text, i) => (
          <div key={i} className="scene-config-panel-help-item">
            <span className="scene-config-panel-help-text">"{text}"</span>
            <button className="btn-icon btn-sm btn-danger" onClick={() => handleRemove(i)} title="Supprimer">&times;</button>
          </div>
        ))}
        {texts.length === 0 && (
          <span className="scene-config-panel-empty">Aucun texte d'aide</span>
        )}
      </div>
    </div>
  )
}
