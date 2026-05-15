import { useState, useRef, useCallback } from 'react'
import { animationHasFrames, isLoopAnimation, type SceneRestPoint, type SceneTransition, type SceneSegment, type SceneSound, type Animation, type SpeakSound, type BodyZone, type ZoneAnimationMapping } from '../../types/project'
import type { TimelineSelection } from './SceneTimeline'

interface Props {
  selection: TimelineSelection
  restPoints: SceneRestPoint[]
  transitions: SceneTransition[]
  startMode: 'rest' | 'transition'
  startX?: number
  startTransition?: SceneTransition
  animations: Animation[]
  bodyZones: BodyZone[]
  onRestPointChange: (index: number, updated: SceneRestPoint) => void
  onSegmentChange: (transitionIndex: number, segmentIndex: number, updated: SceneSegment) => void
  onStartModeChange: (mode: 'rest' | 'transition') => void
  speakSounds: SpeakSound[]
  speakSoundBlobs: (Blob | null)[]
  onSpeakSoundImport: (file: File) => void
  onSpeakSoundDelete: (soundId: string) => void
  /** Called when an animation sound is imported (caller registers upload hint). */
  onSceneSoundImported: (soundId: string) => void
  /** Called when an animation sound is deleted (caller registers delete hint). */
  onSceneSoundDeleted: (soundId: string) => void
}

export default function SceneConfigPanel({
  selection,
  restPoints,
  transitions,
  startMode,
  startX,
  startTransition,
  animations,
  bodyZones,
  onRestPointChange,
  onSegmentChange,
  onStartModeChange,
  speakSounds,
  speakSoundBlobs,
  onSpeakSoundImport,
  onSpeakSoundDelete,
  onSceneSoundImported,
  onSceneSoundDeleted,
}: Props) {
  const readyAnimations = animations.filter(a => animationHasFrames(a))
  const loopAnimations = readyAnimations.filter(isLoopAnimation)
  const oneshotAnimations = readyAnimations.filter(a => !isLoopAnimation(a))

  if (selection.type === 'restPoint') {
    const rp = restPoints[selection.index]
    if (!rp) return null

    const randomIds = rp.randomAnimationIds ?? []
    const randomSounds = rp.randomAnimationSounds ?? []

    const updateSoundsAtIndex = (entryIdx: number, nextList: SceneSound[]) => {
      const padded: SceneSound[][] = randomIds.map((_, i) => (randomSounds[i] ?? []).slice())
      padded[entryIdx] = nextList
      onRestPointChange(selection.index, {
        ...rp,
        randomAnimationSounds: padded.some(arr => arr.length > 0) ? padded : undefined,
      })
    }

    const toggleAnimation = (animId: string, checked: boolean) => {
      if (checked) {
        const newIds = [...randomIds, animId]
        const newSounds: SceneSound[][] = newIds.map((_, i) => (randomSounds[i] ?? []).slice())
        onRestPointChange(selection.index, {
          ...rp,
          randomAnimationIds: newIds,
          randomAnimationSounds: newSounds.some(arr => arr.length > 0) ? newSounds : undefined,
        })
      } else {
        const removeIdx = randomIds.indexOf(animId)
        const removed = randomSounds[removeIdx] ?? []
        for (const s of removed) onSceneSoundDeleted(s.id)
        const newIds = randomIds.filter(id => id !== animId)
        const newSounds = randomSounds.filter((_, i) => i !== removeIdx)
        onRestPointChange(selection.index, {
          ...rp,
          randomAnimationIds: newIds,
          randomAnimationSounds: newSounds.some(arr => arr.length > 0) ? newSounds : undefined,
        })
      }
    }

    return (
      <div className="scene-config-panel">
        <div className="scene-config-panel-header">
          <h4>Rest Point #{selection.index + 1}</h4>
          <span className="scene-config-panel-pos">X: {rp.backgroundX}px</span>
        </div>

        <div className="scene-config-panel-field">
          <label>Animation idle (loop)</label>
          <select
            value={rp.restAnimationId ?? ''}
            onChange={(e) => onRestPointChange(selection.index, {
              ...rp, restAnimationId: e.target.value || undefined,
            })}
          >
            <option value="">(Aucune)</option>
            {loopAnimations.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {loopAnimations.length === 0 && (
            <span className="scene-config-panel-empty">Aucune animation en mode loop. Bascule une animation en loop depuis sa carte.</span>
          )}
        </div>

        <div className="scene-config-panel-field">
          <label>Animations aléatoires (oneshot)</label>
          <div className="scene-config-panel-checkboxes">
            {oneshotAnimations.map(a => {
              const checked = randomIds.includes(a.id)
              const entryIdx = randomIds.indexOf(a.id)
              const sounds = entryIdx >= 0 ? (randomSounds[entryIdx] ?? []) : []
              return (
                <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label className="scene-config-panel-checkbox">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => toggleAnimation(a.id, e.target.checked)}
                    />
                    <span>{a.name} ({a.type})</span>
                  </label>
                  {checked && (
                    <AnimationSoundsRow
                      sounds={sounds}
                      onImport={(file) => {
                        const id = crypto.randomUUID()
                        const next: SceneSound[] = [...sounds, { id, name: file.name, blob: file }]
                        updateSoundsAtIndex(entryIdx, next)
                        onSceneSoundImported(id)
                      }}
                      onDelete={(soundId) => {
                        const next = sounds.filter(s => s.id !== soundId)
                        updateSoundsAtIndex(entryIdx, next)
                        onSceneSoundDeleted(soundId)
                      }}
                    />
                  )}
                </div>
              )
            })}
            {oneshotAnimations.length === 0 && (
              <span className="scene-config-panel-empty">Aucune animation oneshot disponible</span>
            )}
          </div>
        </div>

        {bodyZones.length > 0 && (
          <ZoneAnimationMappingsSection
            rp={rp}
            rpIndex={selection.index}
            bodyZones={bodyZones}
            animations={oneshotAnimations}
            onRestPointChange={onRestPointChange}
          />
        )}

        <SpeakSoundsSection
          rp={rp}
          rpIndex={selection.index}
          speakSounds={speakSounds}
          speakSoundBlobs={speakSoundBlobs}
          onRestPointChange={onRestPointChange}
          onSpeakSoundImport={onSpeakSoundImport}
          onSpeakSoundDelete={onSpeakSoundDelete}
        />

        <div className="scene-config-panel-field">
          <label>Fondu d'arrivée (ms) — {rp.arrivalCrossfadeMs ?? 290}</label>
          <input
            type="range"
            min={0}
            max={3000}
            step={10}
            value={rp.arrivalCrossfadeMs ?? 290}
            onChange={(e) => onRestPointChange(selection.index, {
              ...rp, arrivalCrossfadeMs: parseInt(e.target.value, 10),
            })}
          />
        </div>

        <HelpTextsSection
          rp={rp}
          rpIndex={selection.index}
          onRestPointChange={onRestPointChange}
        />
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

    const segSounds = segment.sounds ?? []
    const updateSegSounds = (next: SceneSound[]) => {
      onSegmentChange(transitionIndex, segmentIndex, {
        ...segment, sounds: next.length > 0 ? next : undefined,
      })
    }

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

        <div className="scene-config-panel-field">
          <label>Sons de cette animation</label>
          <AnimationSoundsRow
            sounds={segSounds}
            onImport={(file) => {
              const id = crypto.randomUUID()
              updateSegSounds([...segSounds, { id, name: file.name, blob: file }])
              onSceneSoundImported(id)
            }}
            onDelete={(soundId) => {
              updateSegSounds(segSounds.filter(s => s.id !== soundId))
              onSceneSoundDeleted(soundId)
            }}
          />
        </div>

        <div className="scene-config-panel-field">
          <label>Mouvement</label>
          <select
            value={segment.easing ?? 'smoothstep'}
            onChange={(e) => onSegmentChange(transitionIndex, segmentIndex, {
              ...segment, easing: e.target.value as 'smoothstep' | 'linear' | 'ease-out' | 'ease-in',
            })}
          >
            <option value="smoothstep">Ease in-out (accélère/décélère)</option>
            <option value="linear">Linéaire (vitesse constante)</option>
            <option value="ease-out">Ralentir à la fin (départ continu du segment précédent)</option>
            <option value="ease-in">Accélérer au début (fin continue vers le segment suivant)</option>
          </select>
        </div>

        <div className="scene-config-panel-field">
          <label>Fondu (ms) — {segment.crossfadeMs ?? 290}</label>
          <input
            type="range"
            min={0}
            max={1500}
            step={10}
            value={segment.crossfadeMs ?? 290}
            onChange={(e) => onSegmentChange(transitionIndex, segmentIndex, {
              ...segment, crossfadeMs: parseInt(e.target.value, 10),
            })}
          />
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

// --- Animation sounds row (list + import + delete + preview) ---

function AnimationSoundsRow({ sounds, onImport, onDelete }: {
  sounds: SceneSound[]
  onImport: (file: File) => void
  onDelete: (soundId: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const handlePreview = useCallback((soundId: string) => {
    if (audioRef.current) {
      audioRef.current.pause()
      try { URL.revokeObjectURL(audioRef.current.src) } catch { /* */ }
      audioRef.current = null
    }
    if (playingId === soundId) {
      setPlayingId(null)
      return
    }
    const sound = sounds.find(s => s.id === soundId)
    if (!sound?.blob) return
    const url = URL.createObjectURL(sound.blob)
    const audio = new Audio(url)
    audioRef.current = audio
    setPlayingId(soundId)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlayingId(null); audioRef.current = null }
  }, [playingId, sounds])

  return (
    <div style={{ paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Sons</span>
        <button
          className="btn-sm btn-secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          + Importer son
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onImport(file)
            e.target.value = ''
          }}
        />
      </div>
      {sounds.map(sound => (
        <div key={sound.id} className="scene-config-panel-sound-row" style={{ fontSize: 12 }}>
          <span>{sound.name}</span>
          <div className="scene-config-panel-sound-actions">
            <button
              className="btn-icon btn-sm"
              onClick={() => handlePreview(sound.id)}
              title={playingId === sound.id ? 'Stop' : 'Écouter'}
              disabled={!sound.blob}
            >
              {playingId === sound.id ? '⏹' : '▶'}
            </button>
            <button
              className="btn-icon btn-sm btn-danger"
              onClick={() => onDelete(sound.id)}
              title="Supprimer"
            >
              &times;
            </button>
          </div>
        </div>
      ))}
      {sounds.length === 0 && (
        <span className="scene-config-panel-empty" style={{ fontSize: 12 }}>Aucun son</span>
      )}
    </div>
  )
}

// --- Speak Sounds sub-section ---

function SpeakSoundsSection({ rp, rpIndex, speakSounds, speakSoundBlobs, onRestPointChange, onSpeakSoundImport, onSpeakSoundDelete }: {
  rp: SceneRestPoint
  rpIndex: number
  speakSounds: SpeakSound[]
  speakSoundBlobs: (Blob | null)[]
  onRestPointChange: (index: number, updated: SceneRestPoint) => void
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
    if (playingId === soundId) {
      setPlayingId(null)
      return
    }
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
      <button
        className="btn-sm btn-secondary"
        style={{ marginBottom: 8 }}
        onClick={() => fileInputRef.current?.click()}
      >
        + Importer son
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: 'none' }}
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
                    onRestPointChange(rpIndex, { ...rp, speakSoundIds: updated })
                  }}
                />
                <span>{sound.name}</span>
              </label>
              <div className="scene-config-panel-sound-actions">
                <button
                  className="btn-icon btn-sm"
                  onClick={() => handlePreview(sound.id)}
                  title={playingId === sound.id ? 'Stop' : 'Écouter'}
                >
                  {playingId === sound.id ? '⏹' : '▶'}
                </button>
                <button
                  className="btn-icon btn-sm btn-danger"
                  onClick={() => onSpeakSoundDelete(sound.id)}
                  title="Supprimer"
                >
                  &times;
                </button>
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

function ZoneAnimationMappingsSection({ rp, rpIndex, bodyZones, animations, onRestPointChange }: {
  rp: SceneRestPoint
  rpIndex: number
  bodyZones: BodyZone[]
  animations: Animation[]
  onRestPointChange: (index: number, updated: SceneRestPoint) => void
}) {
  const mappings = rp.zoneAnimationMappings ?? []

  const handleChange = (zoneId: string, animationId: string) => {
    const filtered = mappings.filter(m => m.zoneId !== zoneId)
    const updated: ZoneAnimationMapping[] = animationId
      ? [...filtered, { zoneId, animationId }]
      : filtered
    onRestPointChange(rpIndex, { ...rp, zoneAnimationMappings: updated })
  }

  return (
    <div className="scene-config-panel-field">
      <label>Zones Corporelles</label>
      <div className="scene-config-panel-checkboxes">
        {bodyZones.map(zone => {
          const mapping = mappings.find(m => m.zoneId === zone.id)
          return (
            <div key={zone.id} className="scene-config-panel-zone-row">
              <span
                className="scene-config-panel-zone-swatch"
                style={{ backgroundColor: zone.color }}
              />
              <span className="scene-config-panel-zone-label">{zone.label}</span>
              <select
                value={mapping?.animationId ?? ''}
                onChange={e => handleChange(zone.id, e.target.value)}
              >
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

function HelpTextsSection({ rp, rpIndex, onRestPointChange }: {
  rp: SceneRestPoint
  rpIndex: number
  onRestPointChange: (index: number, updated: SceneRestPoint) => void
}) {
  const [newText, setNewText] = useState('')
  const texts = rp.helpTexts ?? []

  const handleAdd = () => {
    const trimmed = newText.trim()
    if (!trimmed) return
    onRestPointChange(rpIndex, { ...rp, helpTexts: [...texts, trimmed] })
    setNewText('')
  }

  const handleRemove = (index: number) => {
    onRestPointChange(rpIndex, { ...rp, helpTexts: texts.filter((_, i) => i !== index) })
  }

  return (
    <div className="scene-config-panel-field">
      <label>Textes d'aide "?"</label>
      <div className="scene-config-panel-help-add">
        <input
          type="text"
          value={newText}
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
            <button
              className="btn-icon btn-sm btn-danger"
              onClick={() => handleRemove(i)}
              title="Supprimer"
            >
              &times;
            </button>
          </div>
        ))}
        {texts.length === 0 && (
          <span className="scene-config-panel-empty">Aucun texte d'aide</span>
        )}
      </div>
    </div>
  )
}
