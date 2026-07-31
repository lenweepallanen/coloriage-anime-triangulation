import { useState, useCallback, useEffect, useRef } from 'react'
import { animationHasFrames, type Project, type Scene, type SceneRestPoint, type SceneBackground, type SceneForeground, type SceneSound, type SceneWalkTrapezoid } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import SceneTimeline, { type TimelineSelection } from './SceneTimeline'
import SceneConfigPanel from './SceneConfigPanel'
import SceneWalkZoneEditor from './SceneWalkZoneEditor'
import SceneFilmEditor from './SceneFilmEditor'
import CharacterOriginEditor from './CharacterOriginEditor'
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
    background: null,
    foreground: null,
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
  const [backgroundPreviewUrl, setBackgroundPreviewUrl] = useState<string | null>(null)
  const [foregroundPreviewUrl, setForegroundPreviewUrl] = useState<string | null>(null)
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

  const bg = scene.background
  const fg = scene.foreground
  const hasBackground = !!(bg && (bg.imageBlob || bg.videoBlob))
  const hasForeground = !!(fg && (fg.imageBlob || fg.videoBlob))
  // Référence de dimensions pour le rendu / la zone de marche / la timeline.
  const refDims = { width: bg?.width ?? 0, height: bg?.height ?? 0 }

  // Preview URLs (revoke à la sortie).
  useEffect(() => {
    const bgBlob = bg?.videoBlob ?? bg?.imageBlob ?? null
    const fgBlob = fg?.videoBlob ?? fg?.imageBlob ?? null
    const bgUrl = bgBlob ? URL.createObjectURL(bgBlob) : null
    const fgUrl = fgBlob ? URL.createObjectURL(fgBlob) : null
    setBackgroundPreviewUrl(bgUrl)
    setForegroundPreviewUrl(fgUrl)
    let cancelled = false
    let extractedUrl: string | null = null
    const setupBg = async () => {
      if (!bgBlob) { setBgImageUrl(null); return }
      if (bg?.imageBlob) { setBgImageUrl(bgUrl); return }
      if (bg?.videoBlob) {
        try {
          extractedUrl = await extractVideoFrame0(bg.videoBlob)
          if (!cancelled) setBgImageUrl(extractedUrl)
        } catch {
          if (!cancelled) setBgImageUrl(null)
        }
      }
    }
    setupBg()
    return () => {
      cancelled = true
      if (bgUrl) URL.revokeObjectURL(bgUrl)
      if (fgUrl) URL.revokeObjectURL(fgUrl)
      if (extractedUrl) URL.revokeObjectURL(extractedUrl)
    }
  }, [bg?.imageBlob, bg?.videoBlob, fg?.imageBlob, fg?.videoBlob]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleBackgroundImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
    URL.revokeObjectURL(url)
    const newBackground: SceneBackground = {
      imageBlob: isVideo ? null : blob,
      videoBlob: isVideo ? blob : null,
      width, height,
    }
    setScene(prev => {
      const updated: Scene = { ...prev, background: newBackground }
      if (!updated.restPoint || updated.restPoint.backgroundX === 0) {
        updated.restPoint = createDefaultRestPoint(width)
      }
      return updated
    })
  }, [])

  const handleBackgroundRemove = useCallback(() => {
    setScene(prev => ({ ...prev, background: null }))
  }, [])

  const handleForegroundImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
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
    URL.revokeObjectURL(url)
    const newForeground: SceneForeground = {
      imageBlob: isVideo ? null : blob,
      videoBlob: isVideo ? blob : null,
      width, height,
      // Défaut chroma key noir pour vidéo (cas le plus fréquent), pas de chroma pour PNG.
      chromaKeyColor: isVideo ? '#000000' : null,
      chromaKeyThreshold: isVideo ? 0.1 : undefined,
      chromaKeySmoothness: isVideo ? 0.12 : undefined,
    }
    setScene(prev => ({ ...prev, foreground: newForeground }))
  }, [])

  const handleForegroundRemove = useCallback(() => {
    setScene(prev => ({ ...prev, foreground: null }))
  }, [])

  const handleForegroundChromaColor = useCallback((color: string | null) => {
    setScene(prev => prev.foreground ? { ...prev, foreground: { ...prev.foreground, chromaKeyColor: color } } : prev)
  }, [])

  const handleForegroundChromaThreshold = useCallback((threshold: number) => {
    setScene(prev => prev.foreground ? { ...prev, foreground: { ...prev.foreground, chromaKeyThreshold: threshold } } : prev)
  }, [])

  const handleForegroundChromaSmoothness = useCallback((smoothness: number) => {
    setScene(prev => prev.foreground ? { ...prev, foreground: { ...prev.foreground, chromaKeySmoothness: smoothness } } : prev)
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
      const curBgBlob = scene.background?.videoBlob ?? scene.background?.imageBlob ?? null
      const oldBgBlob = project.scene?.background?.videoBlob ?? project.scene?.background?.imageBlob ?? null
      if (curBgBlob && curBgBlob !== oldBgBlob) hints.push('sceneBackground')
      const curFgBlob = scene.foreground?.videoBlob ?? scene.foreground?.imageBlob ?? null
      const oldFgBlob = project.scene?.foreground?.videoBlob ?? project.scene?.foreground?.imageBlob ?? null
      if (curFgBlob && curFgBlob !== oldFgBlob) hints.push('sceneForeground')
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

  const hasScene = hasBackground
  const canPreview = hasScene && project.originalImageBlob != null
    && project.animations.some(animationHasFrames)

  // Mode de la scène : INTERACTIF (UI de base) ou FILM (UI dédiée au séquenceur).
  // Les deux états sont conservés dans `scene` — basculer ne perd rien.
  const filmMode = scene.film?.enabled === true
  const handleSceneModeChange = useCallback((mode: 'interactive' | 'film') => {
    setScene(prev => {
      if (mode === 'film') {
        // Préserve un film v2 existant ; sinon crée un film vide par défaut.
        if (prev.film && Array.isArray(prev.film.points)) {
          return { ...prev, film: { ...prev.film, enabled: true } }
        }
        return {
          ...prev,
          film: {
            enabled: true,
            entrySide: 'left',
            points: [],
            ending: { kind: 'stay' },
            cameraX: Math.round((prev.background?.width ?? 0) / 2),
            moveSpeedPxPerSec: 260,
            endBehavior: 'menu',
          },
        }
      }
      return prev.film ? { ...prev, film: { ...prev.film, enabled: false } } : prev
    })
  }, [])

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

      {/* Sélecteur de mode : Interactif (UI de base) / Film (UI dédiée) */}
      {hasScene && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">Mode de la scène</h4>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div className="scene-config-panel-type-toggle">
              <button
                className={`btn-sm ${!filmMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => handleSceneModeChange('interactive')}
                title="Scène interactive : boutons action/discours, marche au clic"
              >🕹 Interactif</button>
              <button
                className={`btn-sm ${filmMode ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => handleSceneModeChange('film')}
                title="Film : la scène se joue seule comme une vidéo"
              >🎬 Film</button>
            </div>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {filmMode
                ? 'La configuration interactive reste sauvegardée — repassez en Interactif pour la retrouver.'
                : 'Le film reste sauvegardé — repassez en Film pour le retrouver.'}
            </span>
          </div>
        </div>
      )}

      {/* MODE FILM : chemin de points, UI dédiée */}
      {hasScene && filmMode && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">🎬 Film — chemin</h4>
          <SceneFilmEditor
            scene={scene}
            animations={project.animations}
            backgroundUrl={bgImageUrl}
            layerWidth={refDims.width}
            layerHeight={refDims.height}
            characterImageUrl={charImageUrl}
            characterImageSize={charImageSize}
            onChange={(film) => setScene(prev => ({ ...prev, film }))}
            onSceneSoundImported={handleSceneSoundImported}
            onSceneSoundDeleted={handleSceneSoundDeleted}
          />
        </div>
      )}

      <div className="scene-editor-toolbar">
        <div className="scene-layers-section">
          <div className="scene-layers-header">
            <span className="scene-layers-title">Plans de la scène</span>
            {hasBackground && (
              <button className="btn-ghost btn-sm" onClick={() => setLayersExpanded(p => !p)}>
                {layersExpanded ? 'Masquer' : 'Afficher'}
              </button>
            )}
          </div>

          {layersExpanded && (
            <div className="scene-layers-content">
              <div className="scene-layers-list">
                {/* Arrière-plan (image ou vidéo) */}
                <div className="scene-layer-row">
                  <div className="scene-layer-row-top">
                    <span className="scene-layer-label">Arrière-plan (image ou vidéo)</span>
                    <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                      {hasBackground ? 'Changer' : 'Importer'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
                        style={{ display: 'none' }}
                        onChange={handleBackgroundImport}
                      />
                    </label>
                    {hasBackground && bg && (
                      <>
                        <span className="scene-editor-dimensions">
                          {bg.width}×{bg.height}{bg.videoBlob ? ' (vidéo)' : ''}
                        </span>
                        <button className="btn-icon btn-sm btn-danger" onClick={handleBackgroundRemove} title="Supprimer">&times;</button>
                      </>
                    )}
                  </div>
                  {hasBackground && backgroundPreviewUrl && bg && (
                    bg.videoBlob
                      ? <video src={backgroundPreviewUrl} className="scene-layer-thumb" muted loop autoPlay playsInline />
                      : <img src={backgroundPreviewUrl} alt="Arrière-plan" className="scene-layer-thumb" />
                  )}
                </div>

                {/* Avant-plan (PNG transparent OU vidéo avec chroma key, devant le personnage) */}
                <div className="scene-layer-row">
                  <div className="scene-layer-row-top">
                    <span className="scene-layer-label">Avant-plan (PNG transparent ou vidéo, devant le personnage)</span>
                    <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                      {hasForeground ? 'Changer' : 'Importer'}
                      <input
                        type="file"
                        accept="image/png,image/webp,video/mp4,video/webm"
                        style={{ display: 'none' }}
                        onChange={handleForegroundImport}
                      />
                    </label>
                    {hasForeground && fg && (
                      <>
                        <span className="scene-editor-dimensions">
                          {fg.width}×{fg.height}{fg.videoBlob ? ' (vidéo)' : ''}
                          {hasBackground && bg && (fg.width !== bg.width || fg.height !== bg.height) && (
                            <span style={{ color: 'var(--color-danger)', marginLeft: 8 }} title="Doit matcher l'arrière-plan">⚠ dimensions ≠ arrière-plan</span>
                          )}
                        </span>
                        <button className="btn-icon btn-sm btn-danger" onClick={handleForegroundRemove} title="Supprimer">&times;</button>
                      </>
                    )}
                  </div>

                  {/* Chroma key (vidéo uniquement) */}
                  {hasForeground && fg?.videoBlob && (
                    <div className="scene-layer-row-top" style={{ marginTop: 8, gap: 12 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={fg.chromaKeyColor != null}
                          onChange={(e) => handleForegroundChromaColor(e.target.checked ? (fg.chromaKeyColor ?? '#000000') : null)}
                        />
                        Rendre une couleur transparente
                      </label>
                      {fg.chromaKeyColor != null && (
                        <>
                          <input
                            type="color"
                            value={fg.chromaKeyColor}
                            onChange={(e) => handleForegroundChromaColor(e.target.value)}
                            title="Couleur du fond à rendre transparent"
                            style={{ width: 36, height: 28, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }}
                          />
                          <label className="scene-editor-depth-label">
                            Tolérance
                            <input
                              type="range" min={0} max={1} step={0.01}
                              value={fg.chromaKeyThreshold ?? 0.1}
                              onChange={(e) => handleForegroundChromaThreshold(parseFloat(e.target.value))}
                            />
                            <span>{(fg.chromaKeyThreshold ?? 0.1).toFixed(2)}</span>
                          </label>
                          <label className="scene-editor-depth-label">
                            Adoucissement
                            <input
                              type="range" min={0} max={0.5} step={0.01}
                              value={fg.chromaKeySmoothness ?? 0.12}
                              onChange={(e) => handleForegroundChromaSmoothness(parseFloat(e.target.value))}
                            />
                            <span>{(fg.chromaKeySmoothness ?? 0.12).toFixed(2)}</span>
                          </label>
                        </>
                      )}
                    </div>
                  )}

                  {hasForeground && foregroundPreviewUrl && fg && (
                    fg.videoBlob
                      ? <video src={foregroundPreviewUrl} className="scene-layer-thumb" muted loop autoPlay playsInline />
                      : <img src={foregroundPreviewUrl} alt="Avant-plan" className="scene-layer-thumb" />
                  )}
                </div>
              </div>
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
                  min={-Math.round(refDims.height / 2)}
                  max={Math.round(refDims.height / 2)}
                  step={1}
                  value={scene.characterY}
                  onChange={(e) => setScene(prev => ({ ...prev, characterY: parseInt(e.target.value) }))}
                  style={{ flex: 1 }}
                />
                <span className="scene-editor-value">{scene.characterY}px</span>
              </div>
            </div>
            <div className="scene-editor-field">
              <label>Orientation du coloriage</label>
              <div className="scene-config-panel-type-toggle">
                <button
                  className={`btn-sm ${(scene.characterFacing ?? 'right') === 'left' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setScene(prev => ({ ...prev, characterFacing: 'left' }))}
                  title="Le coloriage est dessiné tourné vers la gauche"
                >← Gauche</button>
                <button
                  className={`btn-sm ${(scene.characterFacing ?? 'right') === 'right' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setScene(prev => ({ ...prev, characterFacing: 'right' }))}
                  title="Le coloriage est dessiné tourné vers la droite"
                >Droite →</button>
              </div>
            </div>
            <div className="scene-editor-field" style={{ gridColumn: '1 / -1' }}>
              <label>Origine (clic en marche libre cible ce point)</label>
              <CharacterOriginEditor
                imageUrl={charImageUrl}
                originU={scene.characterOriginU ?? 0.5}
                originV={scene.characterOriginV ?? 1.0}
                onChange={(u, v) => setScene(prev => ({ ...prev, characterOriginU: u, characterOriginV: v }))}
              />
            </div>
          </div>
        </div>
      )}

      {/* Section Entrée — carte dédiée (interactif uniquement : en film, l'entrée est un bloc du chemin) */}
      {hasScene && !filmMode && (
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

      {/* Section Marche libre — carte dédiée (interactif uniquement : le film ne dépend pas du trapèze) */}
      {hasScene && !filmMode && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">Zone de marche</h4>
          <SceneWalkZoneEditor
            scene={scene}
            animations={project.animations}
            backgroundUrl={bgImageUrl}
            layerWidth={refDims.width}
            layerHeight={refDims.height}
            onChange={(trap: SceneWalkTrapezoid | null) => setScene(prev => ({ ...prev, walkTrapezoid: trap }))}
          />
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

      {hasScene && !filmMode && (
        <SceneTimeline
          backgroundImageUrl={bgImageUrl}
          backgroundWidth={refDims.width}
          backgroundHeight={refDims.height}
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

      {/* Panneau rest point (actions, discours, présentation, zones…) : interactif uniquement */}
      {!filmMode && selection && (
        <SceneConfigPanel
          restPoint={scene.restPoint}
          animations={project.animations}
          bodyZones={project.bodyZones ?? []}
          onRestPointChange={handleRestPointChange}
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
