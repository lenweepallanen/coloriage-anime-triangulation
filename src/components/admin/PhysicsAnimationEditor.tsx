import { useState, useRef, useEffect, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { computeUVs } from '../../utils/textureExtractor'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, uploadOnly?: UploadHint[]) => Promise<void>
}

function getBasePositions(project: Project): Point2D[] | null {
  const restAnim = project.animations.find(a => a.type === 'rest')
  if (!restAnim?.mesh) return null
  // Prefer frame 0 from computed animation
  if (restAnim.mesh.videoFramesMesh && restAnim.mesh.videoFramesMesh.length > 0) {
    return restAnim.mesh.videoFramesMesh[0]
  }
  // Fallback: static mesh geometry
  const m = restAnim.mesh
  if (m.triangles.length === 0) return null
  return [
    ...m.contourAnchors,
    ...m.contourSubdivisionPoints,
    ...m.anchorPoints,
    ...m.internalPoints,
  ]
}

function getRestMeshTriangles(project: Project): [number, number, number][] {
  const restAnim = project.animations.find(a => a.type === 'rest')
  return restAnim?.mesh?.triangles ?? []
}

function createPhysicsFunction(code: string): ((
  positions: Point2D[],
  time: number,
  frameIndex: number,
  totalFrames: number,
  numVertices: number,
  progress: number,
) => void) | { error: string } {
  try {
    const fn = new Function(
      'positions', 'time', 'frameIndex', 'totalFrames', 'numVertices', 'progress',
      code,
    ) as (positions: Point2D[], time: number, frameIndex: number, totalFrames: number, numVertices: number, progress: number) => void
    return fn
  } catch (e) {
    return { error: String(e) }
  }
}

function precomputePhysicsFrames(
  code: string,
  basePositions: Point2D[],
  fps: number,
  duration: number,
): { frames: Point2D[][] } | { error: string } {
  const fnResult = createPhysicsFunction(code)
  if ('error' in fnResult) return fnResult

  const totalFrames = Math.max(1, Math.round(fps * duration))
  const frames: Point2D[][] = []

  for (let f = 0; f < totalFrames; f++) {
    const positions = basePositions.map(p => ({ x: p.x, y: p.y }))
    const time = f / fps
    const progress = totalFrames > 1 ? f / (totalFrames - 1) : 0
    try {
      fnResult(positions, time, f, totalFrames, positions.length, progress)
    } catch (e) {
      return { error: `Frame ${f}: ${String(e)}` }
    }
    frames.push(positions)
  }
  return { frames }
}

const FPS = 24

export default function PhysicsAnimationEditor({ project, animation, onSave }: Props) {
  const [code, setCode] = useState(animation.physicsCode ?? '')
  const [duration, setDuration] = useState(animation.physicsDuration ?? 2)
  const [overlay, setOverlay] = useState(animation.physicsOverlay ?? false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [computing, setComputing] = useState(false)

  // Preview state
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const fnRef = useRef<ReturnType<typeof createPhysicsFunction> | null>(null)
  const timeRef = useRef(0)
  const playingRef = useRef(true)
  const [playing, setPlaying] = useState(true)

  // Sync playing ref
  useEffect(() => { playingRef.current = playing }, [playing])

  // Debounce code → function compilation
  useEffect(() => {
    const timer = setTimeout(() => {
      const result = createPhysicsFunction(code)
      fnRef.current = result
      if ('error' in result) {
        setError(result.error)
      } else {
        setError(null)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [code])

  // Sync code when animation changes externally
  useEffect(() => {
    setCode(animation.physicsCode ?? '')
    setDuration(animation.physicsDuration ?? 2)
    setOverlay(animation.physicsOverlay ?? false)
  }, [animation.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const basePositions = getBasePositions(project)
  const triangles = getRestMeshTriangles(project)

  // PIXI preview
  useEffect(() => {
    if (!containerRef.current || !basePositions || triangles.length === 0) return
    if (!project.originalImageBlob) return

    let destroyed = false
    let app: PIXI.Application | null = null
    let imageUrl: string | null = null

    const img = new Image()
    imageUrl = URL.createObjectURL(project.originalImageBlob)
    img.src = imageUrl

    img.onload = () => {
      if (destroyed || !containerRef.current) return

      app = new PIXI.Application({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        backgroundColor: 0xFFFFFF,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      appRef.current = app
      app.ticker.maxFPS = 30
      containerRef.current.appendChild(app.view as HTMLCanvasElement)

      // Texture from original image
      const texCanvas = document.createElement('canvas')
      texCanvas.width = img.naturalWidth
      texCanvas.height = img.naturalHeight
      const texCtx = texCanvas.getContext('2d')!
      texCtx.drawImage(img, 0, 0)

      const texture = PIXI.Texture.from(texCanvas)
      const uvs = computeUVs(basePositions!, texCanvas.width, texCanvas.height)

      const indices = new Uint16Array(triangles.length * 3)
      triangles.forEach((tri, i) => {
        indices[i * 3] = tri[0]
        indices[i * 3 + 1] = tri[1]
        indices[i * 3 + 2] = tri[2]
      })

      const viewW = app.screen.width
      const viewH = app.screen.height
      const scaleX = viewW / texCanvas.width
      const scaleY = viewH / texCanvas.height
      const scale = Math.min(scaleX, scaleY)
      const offsetX = (viewW - texCanvas.width * scale) / 2
      const offsetY = (viewH - texCanvas.height * scale) / 2

      const vertices = new Float32Array(basePositions!.length * 2)
      basePositions!.forEach((p, i) => {
        vertices[i * 2] = p.x * scale + offsetX
        vertices[i * 2 + 1] = p.y * scale + offsetY
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
      const material = new PIXI.MeshMaterial(texture)
      const pixiMesh = new PIXI.Mesh(geometry, material)
      app.stage.addChild(pixiMesh)

      const modifiedPositions = basePositions!.map(p => ({ x: p.x, y: p.y }))
      const totalFrames = Math.max(1, Math.round(FPS * duration))

      // Animation loop
      app.ticker.add((delta) => {
        if (!playingRef.current) return

        const deltaSeconds = delta / 60
        timeRef.current += deltaSeconds

        // Loop the animation
        if (timeRef.current > duration) {
          timeRef.current = timeRef.current % duration
        }

        const fn = fnRef.current
        if (!fn || 'error' in fn) return

        const time = timeRef.current
        const frameIndex = Math.min(Math.floor(time * FPS), totalFrames - 1)
        const progress = totalFrames > 1 ? frameIndex / (totalFrames - 1) : 0

        // Clone base positions
        for (let i = 0; i < basePositions!.length; i++) {
          modifiedPositions[i].x = basePositions![i].x
          modifiedPositions[i].y = basePositions![i].y
        }

        try {
          fn(modifiedPositions, time, frameIndex, totalFrames, modifiedPositions.length, progress)
        } catch {
          return
        }

        // Update vertices
        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()
      })

      // ResizeObserver
      const resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current || !app) return
        app.renderer.resize(
          containerRef.current.clientWidth,
          containerRef.current.clientHeight,
        )
      })
      resizeObserver.observe(containerRef.current)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(containerRef.current as any).__pixiCleanup = () => {
        resizeObserver.disconnect()
        app!.destroy(true, { children: true, texture: true })
        appRef.current = null
      }
    }

    return () => {
      destroyed = true
      if (imageUrl) URL.revokeObjectURL(imageUrl)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleanup = (containerRef.current as any)?.__pixiCleanup
      if (cleanup) {
        cleanup()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (containerRef.current as any).__pixiCleanup
      }
    }
  }, [project.originalImageBlob, basePositions, triangles, duration]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveCode = useCallback(async () => {
    setSaving(true)
    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, physicsCode: code, physicsDuration: duration, physicsOverlay: overlay } : a
    )
    await onSave({ ...project, animations: updatedAnims })
    setSaving(false)
  }, [project, animation.id, code, duration, overlay, onSave])

  const handleCompute = useCallback(async () => {
    if (!basePositions) return
    setComputing(true)
    setError(null)

    // Use setTimeout to let UI update
    await new Promise(r => setTimeout(r, 50))

    const result = precomputePhysicsFrames(code, basePositions, FPS, duration)
    if ('error' in result) {
      setError(result.error)
      setComputing(false)
      return
    }

    // Get rest mesh to copy shared geometry
    const restAnim = project.animations.find(a => a.type === 'rest')
    const restMesh = restAnim?.mesh

    // Build mesh for this physics animation with the pre-computed frames
    const updatedMesh = animation.mesh ? { ...animation.mesh } : null
    if (updatedMesh) {
      updatedMesh.videoFramesMesh = result.frames
    } else if (restMesh) {
      // Import shared geometry fields from rest
      const { SHARED_GEOMETRY_FIELDS, copySharedGeometry } = await import('./AnimationManager')
      void SHARED_GEOMETRY_FIELDS // reference to avoid unused import
      const shared = copySharedGeometry(restMesh)
      const newMesh = {
        cannyParams: null,
        contourOrigin: null,
        contourOriginKeyframeInterval: 10,
        contourOriginKeyframes: [] as import('../../types/project').KeyframeData[],
        contourOriginFrames: null,
        contourOriginTrackingValidated: false,
        contourAnchors: [] as Point2D[],
        contourAnchorKeyframeInterval: 10,
        contourAnchorKeyframes: [] as import('../../types/project').KeyframeData[],
        contourAnchorFrames: null,
        contourAnchorTrackingValidated: false,
        contourSubdivisionPoints: [] as Point2D[],
        contourSubdivisionParams: [] as import('../../types/project').CurvilinearParam[],
        contourSubdivisionFrames: null,
        contourSubdivisionValidated: false,
        contourCannyFrames: null,
        anchorPoints: [] as Point2D[],
        anchorKeyframeInterval: 10,
        anchorKeyframes: [] as import('../../types/project').KeyframeData[],
        anchorFrames: null,
        anchorTrackingValidated: false,
        internalPoints: [] as Point2D[],
        triangles: [] as [number, number, number][],
        topologyLocked: false,
        trackedTriangles: [] as [number, number, number][],
        internalBarycentrics: [] as import('../../types/project').BarycentricRef[],
        videoFramesMesh: result.frames,
        ...shared,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, physicsCode: code, physicsDuration: duration, physicsOverlay: overlay, mesh: newMesh } : a
      )
      await onSave(
        { ...project, animations: updatedAnims },
        [{ animationId: animation.id, field: 'videoFramesMesh' }],
      )
      setComputing(false)
      return
    }

    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, physicsCode: code, physicsDuration: duration, physicsOverlay: overlay, mesh: updatedMesh } : a
    )
    await onSave(
      { ...project, animations: updatedAnims },
      [{ animationId: animation.id, field: 'videoFramesMesh' }],
    )
    setComputing(false)
  }, [project, animation, code, duration, basePositions, onSave])

  const handleReset = useCallback(() => {
    timeRef.current = 0
  }, [])

  if (!basePositions || triangles.length === 0) {
    return (
      <div style={{ padding: 20, color: 'var(--color-muted)' }}>
        <p>La rest animation doit avoir une triangulation calculee (etape 10) avant de pouvoir creer une animation physique.</p>
      </div>
    )
  }

  const hasPrecomputed = animation.mesh?.videoFramesMesh && animation.mesh.videoFramesMesh.length > 0
  const totalFrames = Math.round(FPS * duration)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Code editor */}
      <div>
        <label style={{ fontWeight: 600, display: 'block', marginBottom: 4 }}>
          Code JS — transforme les positions du maillage
        </label>
        <div style={{ fontSize: '0.75em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
          Variables disponibles : <code>positions</code> (Point2D[] a muter), <code>time</code> (secondes),{' '}
          <code>frameIndex</code>, <code>totalFrames</code>, <code>numVertices</code>, <code>progress</code> (0 a 1)
        </div>
        <textarea
          value={code}
          onChange={e => setCode(e.target.value)}
          spellCheck={false}
          style={{
            width: '100%',
            minHeight: 200,
            fontFamily: 'monospace',
            fontSize: '0.85em',
            padding: 10,
            border: error ? '2px solid var(--color-danger)' : '1px solid var(--color-input-border)',
            borderRadius: 6,
            resize: 'vertical',
            tabSize: 2,
            lineHeight: 1.4,
          }}
        />
        {error && (
          <div style={{ color: 'var(--color-danger)', fontSize: '0.8em', marginTop: 4, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
            {error}
          </div>
        )}
      </div>

      {/* Duration */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: '0.85em' }}>
          Duree : {duration.toFixed(1)}s ({totalFrames} frames a {FPS}fps)
        </label>
        <input
          type="range"
          min={0.5}
          max={5}
          step={0.5}
          value={duration}
          onChange={e => setDuration(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>

      {/* Overlay mode */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85em' }}>
        <input
          type="checkbox"
          checked={overlay}
          onChange={e => setOverlay(e.target.checked)}
        />
        Superposer rest loop — l'animation s'applique instantanement par-dessus la boucle rest, sans attendre la fin du cycle
      </label>

      {/* Preview */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 300,
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          overflow: 'hidden',
          background: 'var(--color-surface-2)',
        }}
      />

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn-icon" onClick={() => setPlaying(p => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn-icon" onClick={handleReset}>
          Reset
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn-secondary"
          onClick={handleSaveCode}
          disabled={saving || computing}
        >
          {saving ? 'Sauvegarde...' : 'Sauvegarder le code'}
        </button>
        <button
          className="btn-primary"
          onClick={handleCompute}
          disabled={saving || computing || !!error}
        >
          {computing ? 'Calcul en cours...' : 'Valider et pre-calculer'}
        </button>
      </div>

      {hasPrecomputed && (
        <div style={{ fontSize: '0.8em', color: 'var(--color-success)' }}>
          Animation pre-calculee ({animation.mesh!.videoFramesMesh!.length} frames). Le bouton apparait dans la preview et le scan.
        </div>
      )}
    </div>
  )
}
