import { useState, useCallback, useEffect, useRef } from 'react'
import { animationHasFrames, type Project, type Scene, type SceneRestPoint, type SceneTransition, type SceneSegment } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import SceneTimeline from './SceneTimeline'
import type { TimelineSelection } from './SceneTimeline'
import SceneConfigPanel from './SceneConfigPanel'
import ScenePlayer from '../scan/ScenePlayer'
import { PreviewModalShell } from './PreviewModal'

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

function createDefaultScene(): Scene {
  return {
    id: crypto.randomUUID(),
    name: 'Scène principale',
    backgroundLayers: [
      { imageBlob: null, width: 0, height: 0, depthFactor: 0.3 },
      { imageBlob: null, width: 0, height: 0, depthFactor: 0.6 },
      { imageBlob: null, width: 0, height: 0, depthFactor: 1.0 },
    ],
    characterScale: 1.0,
    characterY: 0,
    restPoints: [],
    transitions: [],
    startMode: 'rest',
    speakSounds: [],
    speakSoundBlobs: [],
  }
}

function createRestPoint(backgroundX: number): SceneRestPoint {
  return {
    id: crypto.randomUUID(),
    backgroundX,
  }
}

function createDefaultTransition(): SceneTransition {
  return {
    waypoints: [],
    segments: [{ duration: 3 }],
  }
}

/**
 * Insert a waypoint into a transition at the correct position (sorted by X).
 * Also splits the containing segment into two segments with half the duration.
 */
function insertWaypoint(transition: SceneTransition, backgroundX: number, fromX: number, toX: number): SceneTransition {
  const allX = [fromX, ...transition.waypoints, toX]
  // Find which segment the new waypoint falls into
  let insertSegmentIdx = 0
  for (let i = 0; i < allX.length - 1; i++) {
    const segFromX = allX[i]
    const segToX = allX[i + 1]
    const minX = Math.min(segFromX, segToX)
    const maxX = Math.max(segFromX, segToX)
    if (backgroundX >= minX && backgroundX <= maxX) {
      insertSegmentIdx = i
      break
    }
  }

  // Insert waypoint in the waypoints array
  // Waypoint index in the waypoints array = insertSegmentIdx (since allX[0] is fromX)
  const waypointInsertIdx = insertSegmentIdx  // because waypoints start at allX[1]
  const newWaypoints = [...transition.waypoints]
  newWaypoints.splice(waypointInsertIdx, 0, backgroundX)

  // Split the segment at insertSegmentIdx into two
  const oldSegment = transition.segments[insertSegmentIdx] ?? { duration: 3 }
  const halfDuration = Math.max(0.5, oldSegment.duration / 2)
  const newSegments = [...transition.segments]
  newSegments.splice(insertSegmentIdx, 1,
    { duration: halfDuration, animationId: oldSegment.animationId },
    { duration: halfDuration, animationId: oldSegment.animationId },
  )

  return { waypoints: newWaypoints, segments: newSegments }
}

/**
 * Remove a waypoint from a transition, merging the adjacent segments.
 */
function removeWaypoint(transition: SceneTransition, waypointIndex: number): SceneTransition {
  const newWaypoints = transition.waypoints.filter((_, i) => i !== waypointIndex)
  const segIdx = waypointIndex
  const newSegments = [...transition.segments]
  // Merge segment[segIdx] and segment[segIdx+1]
  if (segIdx < newSegments.length - 1) {
    const merged: SceneSegment = {
      duration: newSegments[segIdx].duration + newSegments[segIdx + 1].duration,
      animationId: newSegments[segIdx].animationId,
    }
    newSegments.splice(segIdx, 2, merged)
  } else if (segIdx < newSegments.length) {
    // Remove last segment
    newSegments.splice(segIdx, 1)
  }

  return { waypoints: newWaypoints, segments: newSegments }
}

export default function SceneEditor({ project, onSave }: Props) {
  const [scene, setScene] = useState<Scene>(project.scene ?? createDefaultScene())
  const [selection, setSelection] = useState<TimelineSelection | null>(
    scene.restPoints.length > 0 ? { type: 'restPoint', index: 0 } : null
  )
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null)
  const [bgImageUrl, setBgImageUrl] = useState<string | null>(null)
  const [layerPreviewUrls, setLayerPreviewUrls] = useState<(string | null)[]>([null, null, null])
  const [layersExpanded, setLayersExpanded] = useState(true)
  const previewProjectRef = useRef<Project | null>(null)

  useEffect(() => {
    if (project.scene) {
      setScene(project.scene)
    }
  }, [project.scene])

  // Character image URL + dimensions for timeline preview
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

  // Dimensions de référence : front layer en priorité, sinon n'importe quel layer importé.
  const frontLayer = scene.backgroundLayers[2].imageBlob != null
    ? scene.backgroundLayers[2]
    : (scene.backgroundLayers.find(l => l.imageBlob != null) ?? scene.backgroundLayers[2])

  // Layer preview URLs
  useEffect(() => {
    const urls: (string | null)[] = []
    for (let i = 0; i < 3; i++) {
      const blob = scene.backgroundLayers[i]?.imageBlob
      urls.push(blob ? URL.createObjectURL(blob) : null)
    }
    setLayerPreviewUrls(urls)
    // Fond timeline : front layer en priorité, sinon premier layer importé.
    setBgImageUrl(urls[2] ?? urls.find(u => u != null) ?? null)
    return () => { for (const u of urls) if (u) URL.revokeObjectURL(u) }
  }, [scene.backgroundLayers[0]?.imageBlob, scene.backgroundLayers[1]?.imageBlob, scene.backgroundLayers[2]?.imageBlob]) // eslint-disable-line react-hooks/exhaustive-deps

  // Background layer import
  const handleLayerImport = useCallback(async (layerIndex: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const blob = file as Blob
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.src = url

    await new Promise<void>((resolve) => {
      img.onload = () => {
        const newLayers = [...scene.backgroundLayers]
        newLayers[layerIndex] = {
          imageBlob: blob,
          width: img.naturalWidth,
          height: img.naturalHeight,
          depthFactor: newLayers[layerIndex].depthFactor,
        }
        const updated: Scene = { ...scene, backgroundLayers: newLayers }
        // Auto-create rest points dès l'import du 1er layer (n'importe lequel).
        if (updated.restPoints.length === 0) {
          const firstRp = createRestPoint(Math.round(img.naturalWidth * 0.3))
          const secondRp = createRestPoint(Math.round(img.naturalWidth * 0.7))
          updated.restPoints = [firstRp, secondRp]
          updated.transitions = [createDefaultTransition()]
          setSelection({ type: 'restPoint', index: 0 })
        }
        setScene(updated)
        URL.revokeObjectURL(url)
        resolve()
      }
    })
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
      newLayers[layerIndex] = { imageBlob: null, width: 0, height: 0, depthFactor: newLayers[layerIndex].depthFactor }
      return { ...prev, backgroundLayers: newLayers }
    })
  }, [])

  // Add rest point — inserts in sorted order and creates transitions
  const handleAddRestPoint = useCallback((backgroundX: number) => {
    setScene(prev => {
      const newRp = createRestPoint(backgroundX)
      const newRestPoints = [...prev.restPoints]
      const newTransitions = [...prev.transitions]

      // Find insertion index (sorted by X)
      let insertIdx = newRestPoints.length
      for (let i = 0; i < newRestPoints.length; i++) {
        if (backgroundX < newRestPoints[i].backgroundX) {
          insertIdx = i
          break
        }
      }

      newRestPoints.splice(insertIdx, 0, newRp)

      // Fix transitions: if inserting between two existing rest points, split the transition
      if (insertIdx > 0 && insertIdx < newRestPoints.length - 1) {
        // Was transition at index insertIdx-1, now need two transitions
        const oldTransition = newTransitions[insertIdx - 1] ?? createDefaultTransition()
        newTransitions.splice(insertIdx - 1, 1,
          { waypoints: [], segments: [{ duration: oldTransition.segments[0]?.duration ?? 3 }] },
          { waypoints: [], segments: [{ duration: 3 }] },
        )
      } else if (insertIdx === 0 && newRestPoints.length > 1) {
        // Inserting at beginning — add transition before existing first
        newTransitions.splice(0, 0, createDefaultTransition())
      } else if (insertIdx === newRestPoints.length - 1 && newRestPoints.length > 1) {
        // Inserting at end — add transition after existing last
        newTransitions.push(createDefaultTransition())
      }

      setSelection({ type: 'restPoint', index: insertIdx })
      return { ...prev, restPoints: newRestPoints, transitions: newTransitions }
    })
  }, [])

  // Move rest point
  const handleMoveRestPoint = useCallback((index: number, backgroundX: number) => {
    setScene(prev => ({
      ...prev,
      restPoints: prev.restPoints.map((rp, i) =>
        i === index ? { ...rp, backgroundX } : rp
      ),
    }))
  }, [])

  // Delete rest point
  const handleDeleteRestPoint = useCallback((index: number) => {
    setScene(prev => {
      if (prev.restPoints.length <= 1) return prev
      const newRestPoints = prev.restPoints.filter((_, i) => i !== index)
      const newTransitions = [...prev.transitions]
      // Remove the transition that connects to the deleted rest point
      if (index > 0 && index < prev.restPoints.length - 1) {
        // Middle: merge two adjacent transitions
        const merged: SceneTransition = {
          waypoints: [],
          segments: [{ duration: (newTransitions[index - 1]?.segments[0]?.duration ?? 3) + (newTransitions[index]?.segments[0]?.duration ?? 3) }],
        }
        newTransitions.splice(index - 1, 2, merged)
      } else if (index === 0 && newTransitions.length > 0) {
        newTransitions.splice(0, 1)
      } else if (index === prev.restPoints.length - 1 && newTransitions.length > 0) {
        newTransitions.splice(newTransitions.length - 1, 1)
      }
      return { ...prev, restPoints: newRestPoints, transitions: newTransitions }
    })
    if (selection?.type === 'restPoint' && selection.index === index) {
      setSelection(null)
    }
  }, [selection])

  // Move start point
  const handleMoveStartPoint = useCallback((backgroundX: number) => {
    setScene(prev => ({ ...prev, startX: backgroundX }))
  }, [])

  // Move waypoint
  const handleMoveWaypoint = useCallback((transitionIndex: number, waypointIndex: number, backgroundX: number) => {
    setScene(prev => {
      if (transitionIndex === -1) {
        if (!prev.startTransition) return prev
        const newWaypoints = [...prev.startTransition.waypoints]
        newWaypoints[waypointIndex] = backgroundX
        return { ...prev, startTransition: { ...prev.startTransition, waypoints: newWaypoints } }
      }
      const newTransitions = [...prev.transitions]
      const t = newTransitions[transitionIndex]
      if (!t) return prev
      const newWaypoints = [...t.waypoints]
      newWaypoints[waypointIndex] = backgroundX
      newTransitions[transitionIndex] = { ...t, waypoints: newWaypoints }
      return { ...prev, transitions: newTransitions }
    })
  }, [])

  // Add waypoint to a transition
  const handleAddWaypoint = useCallback((transitionIndex: number, backgroundX: number) => {
    setScene(prev => {
      if (transitionIndex === -1) {
        if (!prev.startTransition) return prev
        const fromX = prev.startX ?? 0
        const toX = prev.restPoints[0]?.backgroundX ?? 0
        return { ...prev, startTransition: insertWaypoint(prev.startTransition, backgroundX, fromX, toX) }
      }
      const newTransitions = [...prev.transitions]
      const t = newTransitions[transitionIndex]
      if (!t) return prev
      const fromX = prev.restPoints[transitionIndex]?.backgroundX ?? 0
      const toX = prev.restPoints[transitionIndex + 1]?.backgroundX ?? 0
      newTransitions[transitionIndex] = insertWaypoint(t, backgroundX, fromX, toX)
      return { ...prev, transitions: newTransitions }
    })
  }, [])

  // Delete waypoint
  const handleDeleteWaypoint = useCallback((transitionIndex: number, waypointIndex: number) => {
    setScene(prev => {
      if (transitionIndex === -1) {
        if (!prev.startTransition) return prev
        return { ...prev, startTransition: removeWaypoint(prev.startTransition, waypointIndex) }
      }
      const newTransitions = [...prev.transitions]
      const t = newTransitions[transitionIndex]
      if (!t) return prev
      newTransitions[transitionIndex] = removeWaypoint(t, waypointIndex)
      return { ...prev, transitions: newTransitions }
    })
  }, [])

  // Update rest point config
  const handleRestPointChange = useCallback((index: number, updated: SceneRestPoint) => {
    setScene(prev => ({
      ...prev,
      restPoints: prev.restPoints.map((rp, i) => i === index ? updated : rp),
    }))
  }, [])

  // Update segment config
  const handleSegmentChange = useCallback((transitionIndex: number, segmentIndex: number, updated: SceneSegment) => {
    setScene(prev => {
      if (transitionIndex === -1) {
        if (!prev.startTransition) return prev
        const newSegments = [...prev.startTransition.segments]
        newSegments[segmentIndex] = updated
        return { ...prev, startTransition: { ...prev.startTransition, segments: newSegments } }
      }
      const newTransitions = [...prev.transitions]
      const t = newTransitions[transitionIndex]
      if (!t) return prev
      const newSegments = [...t.segments]
      newSegments[segmentIndex] = updated
      newTransitions[transitionIndex] = { ...t, segments: newSegments }
      return { ...prev, transitions: newTransitions }
    })
  }, [])

  // Start mode toggle
  const handleStartModeChange = useCallback((mode: 'rest' | 'transition') => {
    setScene(prev => {
      if (mode === 'transition' && !prev.startTransition) {
        return {
          ...prev,
          startMode: mode,
          startX: Math.round((prev.restPoints[0]?.backgroundX ?? prev.backgroundLayers[2].width / 2) * 0.5),
          startTransition: createDefaultTransition(),
        }
      }
      return { ...prev, startMode: mode }
    })
  }, [])

  // Pending speak sound upload hints (accumulated between saves)
  const pendingSpeakHintsRef = useRef<UploadHint[]>([])

  // Import speak sound to scene pool
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

  // Delete speak sound from scene pool + uncheck from all rest points
  const handleSpeakSoundDelete = useCallback((soundId: string) => {
    setScene(prev => {
      const idx = prev.speakSounds.findIndex(s => s.id === soundId)
      if (idx < 0) return prev
      return {
        ...prev,
        speakSounds: prev.speakSounds.filter(s => s.id !== soundId),
        speakSoundBlobs: prev.speakSoundBlobs.filter((_, i) => i !== idx),
        restPoints: prev.restPoints.map(rp => ({
          ...rp,
          speakSoundIds: rp.speakSoundIds?.filter(id => id !== soundId),
        })),
      }
    })
    pendingSpeakHintsRef.current.push({ deleteSpeakSoundId: soundId })
  }, [])

  // Save scene
  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const hints: UploadHint[] = [...pendingSpeakHintsRef.current]
      for (let i = 0; i < 3; i++) {
        const blob = scene.backgroundLayers[i]?.imageBlob
        const oldBlob = project.scene?.backgroundLayers[i]?.imageBlob
        if (blob && blob !== oldBlob) {
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

  // Delete scene
  const handleDeleteScene = useCallback(async () => {
    setSaving(true)
    try {
      const updatedProject: Project = { ...project, scene: null }
      await onSave(updatedProject)
      setScene(createDefaultScene())
      setSelection(null)
    } finally {
      setSaving(false)
    }
  }, [project, onSave])

  // Preview
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

  // Au moins un layer importé suffit (front layer pas obligatoire).
  const hasScene = scene.backgroundLayers.some(l => l.imageBlob != null)
  const canPreview = hasScene && scene.restPoints.length > 0 && project.originalImageBlob != null
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

      {/* Background layers import */}
      <div className="scene-editor-toolbar">
        <div className="scene-layers-section">
          <div className="scene-layers-header">
            <span className="scene-layers-title">Backgrounds parallax</span>
            {scene.backgroundLayers.some(l => l.imageBlob) && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => setLayersExpanded(p => !p)}
              >
                {layersExpanded ? 'Masquer' : 'Afficher'}
              </button>
            )}
          </div>

          {layersExpanded && (
            <div className="scene-layers-content">
              {/* Left: 3 rows (label + import + preview) */}
              <div className="scene-layers-list">
                {(['Arrière-plan', 'Milieu', 'Premier plan'] as const).map((label, i) => {
                  const layer = scene.backgroundLayers[i]
                  const url = layerPreviewUrls[i]
                  return (
                    <div key={i} className="scene-layer-row">
                      <div className="scene-layer-row-top">
                        <span className="scene-layer-label">{label}</span>
                        <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
                          {layer.imageBlob ? 'Changer' : 'Importer'}
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            style={{ display: 'none' }}
                            onChange={(e) => handleLayerImport(i, e)}
                          />
                        </label>
                        {layer.imageBlob && (
                          <>
                            <span className="scene-editor-dimensions">{layer.width}×{layer.height}</span>
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
                      {layer.imageBlob && url && (
                        <img src={url} alt={label} className="scene-layer-thumb" />
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Right: stacked preview (all layers superimposed) */}
              {scene.backgroundLayers.some(l => l.imageBlob) && (
                <div className="scene-layers-stacked-preview">
                  {[0, 1, 2].map(i => {
                    const url = layerPreviewUrls[i]
                    if (!url) return null
                    return <img key={i} src={url} alt="" className="scene-layers-stacked-img" />
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {hasScene && (
          <>
            <div className="scene-editor-field">
              <label>Échelle personnage</label>
              <input
                type="range"
                min={0.1}
                max={3}
                step={0.05}
                value={scene.characterScale}
                onChange={(e) => setScene(prev => ({ ...prev, characterScale: parseFloat(e.target.value) }))}
              />
              <span className="scene-editor-value">{scene.characterScale.toFixed(2)}×</span>
            </div>

            <div className="scene-editor-field">
              <label>Position Y personnage</label>
              <input
                type="range"
                min={-Math.round(frontLayer.height / 2)}
                max={Math.round(frontLayer.height / 2)}
                step={1}
                value={scene.characterY}
                onChange={(e) => setScene(prev => ({ ...prev, characterY: parseInt(e.target.value) }))}
              />
              <span className="scene-editor-value">{scene.characterY}px</span>
            </div>

            <div className="scene-editor-field">
              <label>Démarrage</label>
              <div className="scene-config-panel-type-toggle">
                <button
                  className={`btn-sm ${scene.startMode === 'rest' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => handleStartModeChange('rest')}
                >
                  Au repos
                </button>
                <button
                  className={`btn-sm ${scene.startMode === 'transition' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => handleStartModeChange('transition')}
                >
                  En mouvement
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Timeline */}
      {hasScene && (
        <SceneTimeline
          backgroundImageUrl={bgImageUrl}
          backgroundWidth={frontLayer.width}
          backgroundHeight={frontLayer.height}
          restPoints={scene.restPoints}
          transitions={scene.transitions}
          startMode={scene.startMode}
          startX={scene.startX}
          startTransition={scene.startTransition}
          selection={selection}
          onSelect={setSelection}
          onMoveRestPoint={handleMoveRestPoint}
          onMoveStartPoint={handleMoveStartPoint}
          onMoveWaypoint={handleMoveWaypoint}
          onAddWaypoint={handleAddWaypoint}
          onDeleteRestPoint={handleDeleteRestPoint}
          onDeleteWaypoint={handleDeleteWaypoint}
          onAddRestPoint={handleAddRestPoint}
          characterImageUrl={charImageUrl}
          characterImageWidth={charImageSize.w}
          characterImageHeight={charImageSize.h}
          characterScale={scene.characterScale}
          characterY={scene.characterY}
        />
      )}

      {/* Config panel */}
      {selection && (
        <SceneConfigPanel
          selection={selection}
          restPoints={scene.restPoints}
          transitions={scene.transitions}
          startMode={scene.startMode}
          startX={scene.startX}
          startTransition={scene.startTransition}
          animations={project.animations}
          bodyZones={project.bodyZones ?? []}
          onRestPointChange={handleRestPointChange}
          onSegmentChange={handleSegmentChange}
          onStartModeChange={handleStartModeChange}
          speakSounds={scene.speakSounds}
          speakSoundBlobs={scene.speakSoundBlobs}
          onSpeakSoundImport={handleSpeakSoundImport}
          onSpeakSoundDelete={handleSpeakSoundDelete}
        />
      )}

      {/* Scene preview modal */}
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
