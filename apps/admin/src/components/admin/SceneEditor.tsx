import { useState, useCallback, useEffect, useRef } from 'react'
import { animationHasFrames, type Project, type Scene, type SceneRestPoint, type SceneBackgroundLayer, type SceneSound } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import SceneTimeline, { type TimelineSelection } from './SceneTimeline'
import SceneConfigPanel from './SceneConfigPanel'
import ScenePlayer from '../scan/ScenePlayer'
import { PreviewModalShell } from './PreviewModal'

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/** Extrait la frame 0 d'une vidéo en blob URL (PNG) pour usage en CSS background. */
async function extractVideoFrame0(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const vid = document.createElement('video')
    vid.preload = 'auto'
    vid.muted = true
    vid.src = url
    const cleanup = () => { URL.revokeObjectURL(url); vid.remove() }
    vid.onloadeddata = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = vid.videoWidth
        canvas.height = vid.videoHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) { cleanup(); reject(new Error('no ctx')); return }
        ctx.drawImage(vid, 0, 0)
        canvas.toBlob((b) => {
          cleanup()
          if (!b) { reject(new Error('toBlob null')); return }
          resolve(URL.createObjectURL(b))
        }, 'image/png')
      } catch (err) {
        cleanup()
        reject(err)
      }
    }
    vid.onerror = () => { cleanup(); reject(new Error('video load failed')) }
  })
}

function createDefaultRestPoint(width: number): SceneRestPoint {
  return {
    id: crypto.randomUUID(),
    backgroundX: Math.round(width * 0.5),
  }
}

function createDefaultScene(): Scene {
  return {
    id: crypto.randomUUID(),
    name: 'Scène principale',
    backgroundLayers: [
      { imageBlob: null, videoBlob: null, width: 0, height: 0, depthFactor: 0.3 },
      { imageBlob: null, videoBlob: null, width: 0, height: 0, depthFactor: 0.6 },
      { imageBlob: null, videoBlob: null, width: 0, height: 0, depthFactor: 1.0 },
    ],
    characterScale: 1.0,
    characterY: 0,
    restPoint: createDefaultRestPoint(0),
    entry: 'fixed',
    speakSounds: [],
    speakSoundBlobs: [],
  }
}

export default function SceneEditor({ project, onSave }: Props) {
  const [scene, setScene] = useState<Scene>(project.scene ?? createDefaultScene())
  const [selection, setSelection] = useState<TimelineSelection | null>({ type: 'restPoint' })
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null)
  const [bgImageUrl, setBgImageUrl] = useState<string | null>(null)
  const [layerPreviewUrls, setLayerPreviewUrls] = useState<(string | null)[]>([null, null, null])
  const [layersExpanded, setLayersExpanded] = useState(true)
  const previewProjectRef = useRef<Project | null>(null)

  useEffect(() => {
    if (project.scene) setScene(project.scene)
  }, [project.scene])

  const [charImageUrl, setCharImageUrl] = useState<string | null>(null)
  const [charImageSize, setCharImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  useEffect(() => {
    if (project.originalImageBlob) {
      const url = URL.createObjectURL(project.originalImageBlob)
      setCharImageUrl(url)
      const img = new Image()
      img.src = url
      img.onload = () => setCharImageSize({ w: img.naturalWidth, h: img.naturalHeight })
      return () => { URL.revokeObjectURL(url); setCharImageUrl(null) }
    } else {
      setCharImageUrl(null)
      setCharImageSize({ w: 0, h: 0 })
    }
  }, [project.originalImageBlob])

  const hasMedia = (l: SceneBackgroundLayer) => l.imageBlob != null || l.videoBlob != null
  const frontLayer = hasMedia(scene.backgroundLayers[2])
    ? scene.backgroundLayers[2]
    : (scene.backgroundLayers.find(hasMedia) ?? scene.backgroundLayers[2])

  useEffect(() => {
    const urls: (string | null)[] = []
    for (let i = 0; i < 3; i++) {
      const l = scene.backgroundLayers[i]
      const blob = l?.videoBlob ?? l?.imageBlob ?? null
      urls.push(blob ? URL.createObjectURL(blob) : null)
    }
    setLayerPreviewUrls(urls)
    // Fond timeline : extrait frame 0 si vidéo, sinon image directement
    const frontIdx = scene.backgroundLayers[2]?.videoBlob || scene.backgroundLayers[2]?.imageBlob ? 2
      : scene.backgroundLayers.findIndex(l => l?.videoBlob || l?.imageBlob)
    let cancelled = false
    let extractedUrl: string | null = null
    const setupBg = async () => {
      if (frontIdx < 0) { setBgImageUrl(null); return }
      const layer = scene.backgroundLayers[frontIdx]
      if (layer.imageBlob) {
        setBgImageUrl(urls[frontIdx])
        return
      }
      if (layer.videoBlob) {
        try {
          extractedUrl = await extractVideoFrame0(layer.videoBlob)
          if (!cancelled) setBgImageUrl(extractedUrl)
        } catch {
          if (!cancelled) setBgImageUrl(null)
        }
      }
    }
    setupBg()
    return () => {
      cancelled = true
      for (const u of urls) if (u) URL.revokeObjectURL(u)
      if (extractedUrl) URL.revokeObjectURL(extractedUrl)
    }
  }, [scene.backgroundLayers[0]?.imageBlob, scene.backgroundLayers[0]?.videoBlob, scene.backgroundLayers[1]?.imageBlob, scene.backgroundLayers[1]?.videoBlob, scene.backgroundLayers[2]?.imageBlob, scene.backgroundLayers[2]?.videoBlob]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleLayerImport = useCallback(async (layerIndex: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const blob = file as Blob
    const isVideo = file.type.startsWith('video/')
    const url = URL.createObjectURL(blob)
    const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
      if (isVideo) {
        const vid = document.createElement('video')
        vid.preload = 'metadata'
        vid.muted = true
        vid.src = url
        vid.onloadedmetadata = () => resolve({ width: vid.videoWidth, height: vid.videoHeight })
      } else {
        const img = new Image()
        img.src = url
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
      }
    })
    const newLayers = [...scene.backgroundLayers]
    newLayers[layerIndex] = {
      imageBlob: isVideo ? null : blob,
      videoBlob: isVideo ? blob : null,
      width, height,
      depthFactor: newLayers[layerIndex].depthFactor,
    }
    const updated: Scene = { ...scene, backgroundLayers: newLayers }
    // Initialise restPoint à 50% si pas encore défini
    if (!updated.restPoint || updated.restPoint.backgroundX === 0) {
      updated.restPoint = createDefaultRestPoint(width)
    }
    setScene(updated)
    URL.revokeObjectURL(url)
  }, [scene])

  const handleLayerDepthChange = useCallback((layerIndex: number, depthFactor: number) => {
    setScene(prev => {
      const newLayers = [...prev.backgroundLayers]
      newLayers[layerIndex] = { ...newLayers[layerIndex], depthFactor }
      return { ...prev, backgroundLayers: newLayers }
    })
  }, [])

  const handleLayerRemove = useCallback((layerIndex: number) => {
    setScene(prev => {
      const newLayers = [...prev.backgroundLayers]
      newLayers[layerIndex] = { imageBlob: null, videoBlob: null, width: 0, height: 0, depthFactor: newLayers[layerIndex].depthFactor }
      return { ...prev, backgroundLayers: newLayers }
    })
  }, [])

  const handleMoveRestPoint = useCallback((backgroundX: number) => {
    setScene(prev => ({ ...prev, restPoint: { ...prev.restPoint, backgroundX } }))
  }, [])

  const handleMoveEntryStart = useCallback((backgroundX: number) => {
    setScene(prev => ({ ...prev, entryStartX: backgroundX }))
  }, [])

  const handleRestPointChange = useCallback((updated: SceneRestPoint) => {
    setScene(prev => ({ ...prev, restPoint: updated }))
  }, [])

  const handleEntryModeChange = useCallback((mode: 'fixed' | 'moving') => {
    setScene(prev => {
      if (mode === 'moving' && prev.entryStartX == null) {
        const w = prev.backgroundLayers[2].width || prev.backgroundLayers.find(hasMedia)?.width || 1000
        return {
          ...prev,
          entry: mode,
          entryStartX: Math.round(prev.restPoint.backgroundX * 0.2),
          entryDurationMs: prev.entryDurationMs ?? 1500,
        }
      }
      return { ...prev, entry: mode }
    })
  }, [])

  const handleEntryDurationChange = useCallback((ms: number) => {
    setScene(prev => ({ ...prev, entryDurationMs: ms }))
  }, [])

  const pendingSpeakHintsRef = useRef<UploadHint[]>([])

  const handleEntrySoundImport = useCallback((file: File) => {
    const id = crypto.randomUUID()
    setScene(prev => {
      if (prev.entrySound) pendingSpeakHintsRef.current.push({ deleteSceneSoundId: prev.entrySound.id })
      return { ...prev, entrySound: { id, name: file.name, blob: file } }
    })
    pendingSpeakHintsRef.current.push({ sceneSoundId: id })
  }, [])

  const handleEntrySoundDelete = useCallback(() => {
    setScene(prev => {
      if (prev.entrySound) pendingSpeakHintsRef.current.push({ deleteSceneSoundId: prev.entrySound.id })
      return { ...prev, entrySound: undefined }
    })
  }, [])

  const handleAmbientSoundImport = useCallback((file: File) => {
    const id = crypto.randomUUID()
    setScene(prev => {
      if (prev.ambientSound) pendingSpeakHintsRef.current.push({ deleteSceneSoundId: prev.ambientSound.id })
      return { ...prev, ambientSound: { id, name: file.name, blob: file } }
    })
    pendingSpeakHintsRef.current.push({ sceneSoundId: id })
  }, [])

  const handleAmbientSoundDelete = useCallback(() => {
    setScene(prev => {
      if (prev.ambientSound) pendingSpeakHintsRef.current.push({ deleteSceneSoundId: prev.ambientSound.id })
      return { ...prev, ambientSound: undefined }
    })
  }, [])

  const handleSpeakSoundImport = useCallback((file: File) => {
    const id = crypto.randomUUID()
    const name = file.name
    const blob = file as Blob
    setScene(prev => ({
      ...prev,
      speakSounds: [...prev.speakSounds, { id, name }],
      speakSoundBlobs: [...prev.speakSoundBlobs, blob],
    }))
    pendingSpeakHintsRef.current.push({ speakSoundId: id })
  }, [])

  const handleSpeakSoundDelete = useCallback((soundId: string) => {
    setScene(prev => {
      const idx = prev.speakSounds.findIndex(s => s.id === soundId)
      if (idx < 0) return prev
      return {
        ...prev,
        speakSounds: prev.speakSounds.filter(s => s.id !== soundId),
        speakSoundBlobs: prev.speakSoundBlobs.filter((_, i) => i !== idx),
        restPoint: {
          ...prev.restPoint,
          speakSoundIds: prev.restPoint.speakSoundIds?.filter(id => id !== soundId),
        },
      }
    })
    pendingSpeakHintsRef.current.push({ deleteSpeakSoundId: soundId })
  }, [])

  const handleSceneSoundImported = useCallback((soundId: string) => {
    pendingSpeakHintsRef.current.push({ sceneSoundId: soundId })
  }, [])
  const handleSceneSoundDeleted = useCallback((soundId: string) => {
    pendingSpeakHintsRef.current.push({ deleteSceneSoundId: soundId })
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const hints: UploadHint[] = [...pendingSpeakHintsRef.current]
      for (let i = 0; i < 3; i++) {
        const cur = scene.backgroundLayers[i]
        const old = project.scene?.backgroundLayers[i]
        const curBlob = cur?.videoBlob ?? cur?.imageBlob ?? null
        const oldBlob = old?.videoBlob ?? old?.imageBlob ?? null
        if (curBlob && curBlob !== oldBlob) {
          hints.push(`sceneBackgroundLayer${i}` as UploadHint)
        }
      }
      const updatedProject: Project = { ...project, scene }
      await onSave(updatedProject, hints.length > 0 ? hints : undefined)
      pendingSpeakHintsRef.current = []
    } finally {
      setSaving(false)
    }
  }, [scene, project, onSave])

  const handleDeleteScene = useCallback(async () => {
    setSaving(true)
    try {
      const updatedProject: Project = { ...project, scene: null }
      await onSave(updatedProject)
      setScene(createDefaultScene())
      setSelection({ type: 'restPoint' })
    } finally {
      setSaving(false)
    }
  }, [project, onSave])

  const handlePreview = useCallback(async () => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.src = url
    await new Promise<void>((resolve) => {
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        URL.revokeObjectURL(url)
        previewProjectRef.current = { ...project, scene }
        setPreviewCanvas(canvas)
        setPreviewing(true)
        resolve()
      }
    })
  }, [project, scene])

  const handleClosePreview = useCallback(() => {
    setPreviewing(false)
    setPreviewCanvas(null)
    previewProjectRef.current = null
  }, [])

  const hasScene = scene.backgroundLayers.some(hasMedia)
  const canPreview = hasScene && project.originalImageBlob != null
    && project.animations.some(animationHasFrames)

  return (
    <div className="scene-editor">
      <div className="scene-editor-header">
        <h3>Éditeur de scène</h3>
        <div className="scene-editor-header-actions">
          {canPreview && (
            <button className="btn-secondary btn-sm" onClick={handlePreview} disabled={saving}>
              ▶ Preview scène
            </button>
          )}
          {hasScene && (
            <button className="btn-danger btn-sm" onClick={handleDeleteScene} disabled={saving}>
              Supprimer la scène
            </button>
          )}
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Sauvegarde...' : 'Sauvegarder'}
          </button>
        </div>
      </div>

      <div className="scene-editor-toolbar">
        <div className="scene-layers-section">
          <div className="scene-layers-header">
            <span className="scene-layers-title">Backgrounds parallax</span>
            {scene.backgroundLayers.some(hasMedia) && (
              <button className="btn-ghost btn-sm" onClick={() => setLayersExpanded(p => !p)}>
                {layersExpanded ? 'Masquer' : 'Afficher'}
              </button>
            )}
          </div>

          {layersExpanded && (
            <div className="scene-layers-content">
              <div className="scene-layers-list">
                {(['Arrière-plan', 'Milieu', 'Premier plan'] as const).map((label, i) => {
                  const layer = scene.backgroundLayers[i]
                  const url = layerPreviewUrls[i]
                  const has = hasMedia(layer)
                  const accept = i === 0
                    ? 'image/png,image/jpeg,image/webp,video/mp4,video/webm'
                    : 'image/png,image/jpeg,image/webp'
                  return (
                    <div key={i} className="scene-layer-row">
                      <div className="scene-layer-row-top">
                        <span className="scene-layer-label">{label}{i === 0 ? ' (image ou vidéo)' : ''}</span>
                        <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                          {has ? 'Changer' : 'Importer'}
                          <input
                            type="file"
                            accept={accept}
                            style={{ display: 'none' }}
                            onChange={(e) => handleLayerImport(i, e)}
                          />
                        </label>
                        {has && (
                          <>
                            <span className="scene-editor-dimensions">
                              {layer.width}×{layer.height}{layer.videoBlob ? ' (vidéo)' : ''}
                            </span>
                            <label className="scene-editor-depth-label">
                              Vitesse
                              <input
                                type="range" min={0} max={1} step={0.05}
                                value={layer.depthFactor}
                                onChange={(e) => handleLayerDepthChange(i, parseFloat(e.target.value))}
                              />
                              <span>{layer.depthFactor.toFixed(2)}</span>
                            </label>
                            <button className="btn-icon btn-sm btn-danger" onClick={() => handleLayerRemove(i)} title="Supprimer">&times;</button>
                          </>
                        )}
                      </div>
                      {has && url && (
                        layer.videoBlob
                          ? <video src={url} className="scene-layer-thumb" muted loop autoPlay playsInline />
                          : <img src={url} alt={label} className="scene-layer-thumb" />
                      )}
                    </div>
                  )
                })}
              </div>

              {scene.backgroundLayers.some(hasMedia) && (
                <div className="scene-layers-stacked-preview">
                  {[0, 1, 2].map(i => {
                    const url = layerPreviewUrls[i]
                    const layer = scene.backgroundLayers[i]
                    if (!url) return null
                    return layer.videoBlob
                      ? <video key={i} src={url} className="scene-layers-stacked-img" muted loop autoPlay playsInline />
                      : <img key={i} src={url} alt="" className="scene-layers-stacked-img" />
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Section Personnage — carte dédiée */}
      {hasScene && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">Personnage</h4>
          <div className="scene-editor-section-grid">
            <div className="scene-editor-field">
              <label>Échelle</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range" min={0.1} max={3} step={0.05}
                  value={scene.characterScale}
                  onChange={(e) => setScene(prev => ({ ...prev, characterScale: parseFloat(e.target.value) }))}
                  style={{ flex: 1 }}
                />
                <span className="scene-editor-value">{scene.characterScale.toFixed(2)}×</span>
              </div>
            </div>
            <div className="scene-editor-field">
              <label>Position Y</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="range"
                  min={-Math.round(frontLayer.height / 2)}
                  max={Math.round(frontLayer.height / 2)}
                  step={1}
                  value={scene.characterY}
                  onChange={(e) => setScene(prev => ({ ...prev, characterY: parseInt(e.target.value) }))}
                  style={{ flex: 1 }}
                />
                <span className="scene-editor-value">{scene.characterY}px</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Section Entrée — carte dédiée */}
      {hasScene && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">Entrée</h4>
          <div className="scene-editor-section-grid">
            <div className="scene-editor-field">
              <label>Mode</label>
              <div className="scene-config-panel-type-toggle">
                <button
                  className={`btn-sm ${scene.entry === 'fixed' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => handleEntryModeChange('fixed')}
                >
                  Fixe
                </button>
                <button
                  className={`btn-sm ${scene.entry === 'moving' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => handleEntryModeChange('moving')}
                >
                  En mouvement
                </button>
              </div>
            </div>

            {scene.entry === 'moving' && (
              <div className="scene-editor-field">
                <label>Durée (ms)</label>
                <input
                  type="range" min={300} max={6000} step={100}
                  value={scene.entryDurationMs ?? 1500}
                  onChange={(e) => handleEntryDurationChange(parseInt(e.target.value))}
                />
                <span className="scene-editor-value">{scene.entryDurationMs ?? 1500}ms</span>
              </div>
            )}

            <div className="scene-editor-field">
              <label>Animation pendant l'arrivée</label>
              <select
                value={scene.entryAnimationId ?? ''}
                onChange={(e) => setScene(prev => ({ ...prev, entryAnimationId: e.target.value || undefined }))}
                disabled={scene.entry === 'fixed'}
              >
                <option value="">(Idle du rest point)</option>
                {project.animations.filter(a => animationHasFrames(a)).map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                ))}
              </select>
            </div>

            <div className="scene-editor-field">
              <label>Son d'entrée (1 fois)</label>
              <SceneSoundRow
                sound={scene.entrySound}
                onImport={handleEntrySoundImport}
                onDelete={handleEntrySoundDelete}
                onChange={(partial) => setScene(prev => prev.entrySound ? { ...prev, entrySound: { ...prev.entrySound, ...partial } } : prev)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Section Son d'ambiance — carte dédiée, loop continu */}
      {hasScene && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">Son d'ambiance (boucle continue)</h4>
          <SceneSoundRow
            sound={scene.ambientSound}
            onImport={handleAmbientSoundImport}
            onDelete={handleAmbientSoundDelete}
            onChange={(partial) => setScene(prev => prev.ambientSound ? { ...prev, ambientSound: { ...prev.ambientSound, ...partial } } : prev)}
          />
        </div>
      )}

      {hasScene && (
        <SceneTimeline
          backgroundImageUrl={bgImageUrl}
          backgroundWidth={frontLayer.width}
          backgroundHeight={frontLayer.height}
          restPointX={scene.restPoint.backgroundX}
          entry={scene.entry}
          entryStartX={scene.entryStartX}
          selection={selection}
          onSelect={setSelection}
          onMoveRestPoint={handleMoveRestPoint}
          onMoveEntryStart={handleMoveEntryStart}
          characterImageUrl={charImageUrl}
          characterImageWidth={charImageSize.w}
          characterImageHeight={charImageSize.h}
          characterScale={scene.characterScale}
          characterY={scene.characterY}
        />
      )}

      {selection && (
        <SceneConfigPanel
          restPoint={scene.restPoint}
          animations={project.animations}
          bodyZones={project.bodyZones ?? []}
          onRestPointChange={handleRestPointChange}
          speakSounds={scene.speakSounds}
          speakSoundBlobs={scene.speakSoundBlobs}
          onSpeakSoundImport={handleSpeakSoundImport}
          onSpeakSoundDelete={handleSpeakSoundDelete}
          onSceneSoundImported={handleSceneSoundImported}
          onSceneSoundDeleted={handleSceneSoundDeleted}
        />
      )}

      <PreviewModalShell open={previewing && !!previewCanvas && !!previewProjectRef.current} onClose={handleClosePreview}>
        {previewCanvas && previewProjectRef.current && (
          <ScenePlayer
            project={previewProjectRef.current}
            scanCanvas={previewCanvas}
            onClose={handleClosePreview}
            modal
          />
        )}
      </PreviewModalShell>
    </div>
  )
}

// --- Petit composant réutilisable pour un son de scène (import / preview / delete) ---

function SceneSoundRow({ sound, onImport, onDelete, onChange }: {
  sound: SceneSound | undefined
  onImport: (file: File) => void
  onDelete: () => void
  onChange?: (partial: Partial<SceneSound>) => void
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
    audioRef.current = audio
    setPlaying(true)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null }
  }, [sound])

  if (sound) {
    const volume = sound.volume ?? 1
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sound.name}</span>
        {onChange && (
          <>
            <input
              type="range" min={0} max={1} step={0.05}
              value={volume}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                onChange({ volume: v })
                if (audioRef.current) audioRef.current.volume = v
              }}
              style={{ width: 90 }}
              title={`Volume : ${Math.round(volume * 100)}%`}
            />
            <span style={{ fontSize: 11, opacity: 0.7, minWidth: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(volume * 100)}%
            </span>
          </>
        )}
        <button className="btn-icon btn-sm" onClick={togglePreview} disabled={!sound.blob} title={playing ? 'Stop' : 'Écouter'}>
          {playing ? '⏹' : '▶'}
        </button>
        <button className="btn-icon btn-sm btn-danger" onClick={onDelete} title="Retirer">&times;</button>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button className="btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>+ Importer son</button>
      <input
        ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onImport(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
