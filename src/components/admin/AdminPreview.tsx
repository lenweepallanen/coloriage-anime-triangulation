import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, Point2D } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { MeshPhysicsEffect, DEFAULT_PHYSICS_CONFIG } from '../../utils/meshPhysicsEffects'
import type { TouchState, PhysicsConfig } from '../../utils/meshPhysicsEffects'

interface Props {
  project: Project
  style?: React.CSSProperties
}

interface SliderDef {
  key: keyof PhysicsConfig
  label: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderDef[] = [
  { key: 'force', label: 'Force', min: 5, max: 150, step: 5 },
  { key: 'radius', label: 'Rayon', min: 30, max: 500, step: 10 },
  { key: 'concentration', label: 'Concentration', min: 0.5, max: 5, step: 0.25 },
  { key: 'returnSpeed', label: 'Retour', min: 0.5, max: 0.98, step: 0.01 },
]

interface VisualEffectsConfig {
  shadowAlpha: number
  lightingAlpha: number
}

const DEFAULT_VISUAL: VisualEffectsConfig = {
  shadowAlpha: 0.25,
  lightingAlpha: 0.6,
}

interface VisualSliderDef {
  key: keyof VisualEffectsConfig
  label: string
  min: number
  max: number
  step: number
}

const VISUAL_SLIDERS: VisualSliderDef[] = [
  { key: 'shadowAlpha', label: 'Ombre', min: 0, max: 0.5, step: 0.05 },
  { key: 'lightingAlpha', label: 'Eclairage', min: 0, max: 1, step: 0.05 },
]

function createLightingCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')!
  const grad = ctx.createRadialGradient(80, 80, 0, 128, 128, 180)
  grad.addColorStop(0, 'rgba(255,255,255,0.35)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 256, 256)
  return c
}

function getAnimationData(project: Project) {
  const restAnim = project.animations.find(a => a.type === 'rest')
  const readyOneshots: Animation[] = project.animations.filter(
    a => (a.type === 'oneshot' || a.type === 'physics') && a.mesh?.videoFramesMesh && a.mesh.videoFramesMesh.length > 0
  )
  return { restAnim, readyOneshots }
}

export default function AdminPreview({ project, style }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const playingRef = useRef(true)
  const [playing, setPlaying] = useState(true)
  const [physicsConfig, setPhysicsConfig] = useState<PhysicsConfig>({ ...DEFAULT_PHYSICS_CONFIG })
  const [visualConfig, setVisualConfig] = useState<VisualEffectsConfig>({ ...DEFAULT_VISUAL })
  const physicsRef = useRef<MeshPhysicsEffect | null>(null)
  const visualRef = useRef<VisualEffectsConfig>({ ...DEFAULT_VISUAL })
  const touchRef = useRef<{ active: boolean; screenX: number; screenY: number }>({
    active: false, screenX: 0, screenY: 0,
  })
  const multiPlaybackRef = useRef<MultiAnimationPlayback | null>(null)
  const [playbackState, setPlaybackState] = useState<string>('rest')

  const { restAnim, readyOneshots } = getAnimationData(project)

  // Keep playingRef in sync
  useEffect(() => { playingRef.current = playing }, [playing])

  const updateConfig = useCallback((key: keyof PhysicsConfig, value: number) => {
    setPhysicsConfig(prev => {
      const next = { ...prev, [key]: value }
      if (physicsRef.current) physicsRef.current.config = next
      return next
    })
  }, [])

  const updateVisualConfig = useCallback((key: keyof VisualEffectsConfig, value: number) => {
    setVisualConfig(prev => {
      const next = { ...prev, [key]: value }
      visualRef.current = next
      return next
    })
  }, [])

  const handleOneshotTrigger = useCallback((animId: string) => {
    multiPlaybackRef.current?.requestOneshot(animId)
  }, [])

  // PIXI setup
  useEffect(() => {
    if (!containerRef.current || !restAnim?.mesh) return

    const mesh = restAnim.mesh
    const hasFlow = mesh.videoFramesMesh && mesh.videoFramesMesh.length > 0
    if (!hasFlow) return

    const imageBlob = project.originalImageBlob
    if (!imageBlob) return

    let destroyed = false
    let app: PIXI.Application | null = null
    let bgVideoEl: HTMLVideoElement | null = null
    let bgVideoUrl: string | null = null
    let imageUrl: string | null = null

    // Load original image as texture source
    const img = new Image()
    imageUrl = URL.createObjectURL(imageBlob)
    img.src = imageUrl

    img.onload = () => {
      if (destroyed || !containerRef.current) return

      const allPoints = [
        ...mesh.contourAnchors,
        ...mesh.contourSubdivisionPoints,
        ...mesh.anchorPoints,
        ...mesh.internalPoints,
      ]

      const hasBgVideo = !!project.backgroundVideoBlob

      app = new PIXI.Application({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        backgroundColor: hasBgVideo ? 0x000000 : 0xFFFFFF,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      appRef.current = app
      // Cap FPS for admin preview
      app.ticker.maxFPS = 30
      containerRef.current.appendChild(app.view as HTMLCanvasElement)

      // Pointer events for physics
      const canvas = app.view as HTMLCanvasElement
      canvas.style.touchAction = 'none'

      const onPointerDown = (e: PointerEvent) => {
        touchRef.current = { active: true, screenX: e.offsetX, screenY: e.offsetY }
      }
      const onPointerMove = (e: PointerEvent) => {
        if (touchRef.current.active) {
          touchRef.current.screenX = e.offsetX
          touchRef.current.screenY = e.offsetY
        }
      }
      const onPointerUp = () => { touchRef.current.active = false }

      canvas.addEventListener('pointerdown', onPointerDown)
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerup', onPointerUp)
      canvas.addEventListener('pointerleave', onPointerUp)
      canvas.addEventListener('pointercancel', onPointerUp)

      // Stage hierarchy
      const bgContainer = new PIXI.Container()
      const shadowContainer = new PIXI.Container()
      const meshContainer = new PIXI.Container()
      app.stage.addChild(bgContainer)
      app.stage.addChild(shadowContainer)
      app.stage.addChild(meshContainer)

      const viewW = app.screen.width
      const viewH = app.screen.height

      // Background video (no parallax)
      let bgSprite: PIXI.Sprite | null = null
      if (hasBgVideo) {
        bgVideoEl = document.createElement('video')
        bgVideoUrl = URL.createObjectURL(project.backgroundVideoBlob!)
        bgVideoEl.src = bgVideoUrl
        bgVideoEl.loop = true
        bgVideoEl.muted = true
        bgVideoEl.playsInline = true
        bgVideoEl.setAttribute('playsinline', '')
        bgVideoEl.play().catch(() => {})

        const bgTexture = PIXI.Texture.from(bgVideoEl, { resourceOptions: { autoPlay: true } })
        bgSprite = new PIXI.Sprite(bgTexture)

        const setupBgSize = () => {
          const vidW = bgVideoEl!.videoWidth || viewW
          const vidH = bgVideoEl!.videoHeight || viewH
          const coverScale = Math.max(viewW / vidW, viewH / vidH)
          bgSprite!.width = vidW * coverScale
          bgSprite!.height = vidH * coverScale
          bgSprite!.x = (viewW - vidW * coverScale) / 2
          bgSprite!.y = (viewH - vidH * coverScale) / 2
        }
        bgVideoEl.addEventListener('loadedmetadata', setupBgSize, { once: true })
        setupBgSize()
        bgContainer.addChild(bgSprite)
      }

      // Draw original image to a canvas for PIXI texture
      const texCanvas = document.createElement('canvas')
      texCanvas.width = img.naturalWidth
      texCanvas.height = img.naturalHeight
      const texCtx = texCanvas.getContext('2d')!
      texCtx.drawImage(img, 0, 0)

      // Mesh texture & geometry
      const texture = PIXI.Texture.from(texCanvas)
      const uvs = computeUVs(allPoints, texCanvas.width, texCanvas.height)

      const indices = new Uint16Array(mesh.triangles.length * 3)
      mesh.triangles.forEach((tri, i) => {
        indices[i * 3] = tri[0]
        indices[i * 3 + 1] = tri[1]
        indices[i * 3 + 2] = tri[2]
      })

      // Scale & offset — fit to available space
      const scaleX = viewW / texCanvas.width
      const scaleY = viewH / texCanvas.height
      const scale = Math.min(scaleX, scaleY)
      const offsetX = (viewW - texCanvas.width * scale) / 2
      const offsetY = (viewH - texCanvas.height * scale) / 2

      // Initial vertices
      const vertices = new Float32Array(allPoints.length * 2)
      allPoints.forEach((p, i) => {
        vertices[i * 2] = p.x * scale + offsetX
        vertices[i * 2 + 1] = p.y * scale + offsetY
      })

      // Main mesh
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
      const material = new PIXI.MeshMaterial(texture)
      const pixiMesh = new PIXI.Mesh(geometry, material)
      meshContainer.addChild(pixiMesh)

      // Shadow (filled contour polygon)
      const shadowOffsetX = 4
      const shadowOffsetY = 6
      const numContourAnchors = mesh.contourAnchors.length
      const contourSubParams = mesh.contourSubdivisionParams ?? []
      const contourVertexIds: number[] = []
      for (let i = 0; i < numContourAnchors; i++) {
        contourVertexIds.push(i)
        const segPts: { t: number; idx: number }[] = []
        for (let j = 0; j < contourSubParams.length; j++) {
          if (contourSubParams[j].segmentIndex === i) {
            segPts.push({ t: contourSubParams[j].t, idx: numContourAnchors + j })
          }
        }
        segPts.sort((a, b) => a.t - b.t)
        for (const sp of segPts) contourVertexIds.push(sp.idx)
      }

      const shadowGraphics = new PIXI.Graphics()
      shadowContainer.addChild(shadowGraphics)
      shadowContainer.filters = [new PIXI.BlurFilter(18)]

      function drawShadow(positions: Point2D[]) {
        shadowGraphics.clear()
        shadowContainer.alpha = visualRef.current.shadowAlpha
        if (shadowContainer.alpha <= 0 || contourVertexIds.length < 3) return
        shadowGraphics.beginFill(0x000000, 1.0)
        const first = contourVertexIds[0]
        shadowGraphics.moveTo(
          positions[first].x * scale + offsetX + shadowOffsetX,
          positions[first].y * scale + offsetY + shadowOffsetY,
        )
        for (let ci = 1; ci < contourVertexIds.length; ci++) {
          const idx = contourVertexIds[ci]
          shadowGraphics.lineTo(
            positions[idx].x * scale + offsetX + shadowOffsetX,
            positions[idx].y * scale + offsetY + shadowOffsetY,
          )
        }
        shadowGraphics.closePath()
        shadowGraphics.endFill()
      }
      drawShadow(allPoints)

      // Lighting overlay
      const lightCanvas = createLightingCanvas()
      const lightTexture = PIXI.Texture.from(lightCanvas)
      const lightSprite = new PIXI.Sprite(lightTexture)
      lightSprite.width = texCanvas.width * scale
      lightSprite.height = texCanvas.height * scale
      lightSprite.x = offsetX
      lightSprite.y = offsetY
      lightSprite.blendMode = PIXI.BLEND_MODES.OVERLAY
      lightSprite.alpha = visualRef.current.lightingAlpha
      meshContainer.addChild(lightSprite)

      // Physics
      const physics = new MeshPhysicsEffect(allPoints.length, physicsConfig)
      physicsRef.current = physics
      const modifiedPositions: Point2D[] = new Array(allPoints.length)
      for (let i = 0; i < allPoints.length; i++) modifiedPositions[i] = { x: 0, y: 0 }

      const screenToImage = (sx: number, sy: number): { x: number; y: number } => ({
        x: (sx - offsetX) / scale,
        y: (sy - offsetY) / scale,
      })

      // Build oneshot animation data
      const oneshotAnims: OneshotAnimation[] = readyOneshots
        .filter(a => a.mesh?.videoFramesMesh)
        .map(a => ({
          id: a.id,
          name: a.name,
          frames: a.mesh!.videoFramesMesh!,
          overlay: a.physicsOverlay ?? false,
        }))

      const hasOneshots = oneshotAnims.length > 0
      let getPositions: () => Point2D[]
      let advancePlayback: (delta: number) => void

      if (hasOneshots) {
        const multiPlayback = new MultiAnimationPlayback(
          mesh.videoFramesMesh!,
          oneshotAnims,
          { crossfadeFrames: mesh.crossfadeFrames ?? 7 },
        )
        multiPlaybackRef.current = multiPlayback
        getPositions = () => multiPlayback.getPositions()
        advancePlayback = (delta) => {
          multiPlayback.advance(delta)
          setPlaybackState(multiPlayback.currentState)
        }
      } else {
        const playback = new LoopPlayback(mesh.videoFramesMesh!, { crossfadeFrames: mesh.crossfadeFrames ?? 7 })
        getPositions = () => playback.getPositions()
        advancePlayback = (delta) => playback.advance(delta)
      }

      // Animation loop
      app.ticker.add((delta) => {
        if (playingRef.current) advancePlayback(delta)

        const positions = getPositions()

        // Physics
        const t = touchRef.current
        const imgCoord = screenToImage(t.screenX, t.screenY)
        const touchState: TouchState = { active: t.active, imageX: imgCoord.x, imageY: imgCoord.y }
        physics.update(positions, touchState, delta)

        if (physics.isIdle() && !playingRef.current) return

        physics.apply(positions, modifiedPositions)

        // Update vertices
        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()

        // Shadow + lighting
        drawShadow(modifiedPositions)
        lightSprite.alpha = visualRef.current.lightingAlpha
      })

      // ResizeObserver for responsive sizing
      const resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current || !app) return
        app.renderer.resize(
          containerRef.current.clientWidth,
          containerRef.current.clientHeight,
        )
      })
      resizeObserver.observe(containerRef.current)

      // Store cleanup references on the outer scope
      const cleanupFn = () => {
        resizeObserver.disconnect()
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointerleave', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerUp)
        if (bgVideoEl) { bgVideoEl.pause(); bgVideoEl.src = '' }
        if (bgVideoUrl) URL.revokeObjectURL(bgVideoUrl)
        app!.destroy(true, { children: true, texture: true })
        appRef.current = null
        physicsRef.current = null
        multiPlaybackRef.current = null
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(containerRef.current as any).__pixiCleanup = cleanupFn
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
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="admin-preview-panel" style={style}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <strong>Preview</strong>
        <button
          onClick={() => setPlaying(p => !p)}
          style={{ padding: '4px 12px', fontSize: '0.85rem' }}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
      </div>

      <div className="admin-preview-canvas-wrapper" ref={containerRef} />

      {/* Oneshot trigger buttons */}
      {readyOneshots.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {readyOneshots.map(anim => {
            const isOverlay = anim.physicsOverlay ?? false
            const disabled = !isOverlay && playbackState !== 'rest' && playbackState !== 'wait'
            return (
              <button
                key={anim.id}
                onClick={() => handleOneshotTrigger(anim.id)}
                disabled={disabled}
                style={{
                  padding: '4px 12px',
                  fontSize: '0.8rem',
                  borderRadius: 8,
                  opacity: disabled ? 0.5 : 1,
                  borderColor: isOverlay ? 'var(--color-type-physics)' : undefined,
                }}
              >
                {anim.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Settings */}
      <details style={{ fontSize: '0.8rem' }}>
        <summary>Physique</summary>
        <div className="settings-group" style={{ padding: '4px 0' }}>
          {SLIDERS.map(({ key, label, min, max, step }) => (
            <label key={key} className="physics-slider">
              <span>{label}: {physicsConfig[key]}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={physicsConfig[key]}
                onChange={e => updateConfig(key, parseFloat(e.target.value))}
              />
            </label>
          ))}
        </div>
      </details>
      <details style={{ fontSize: '0.8rem' }}>
        <summary>Effets visuels</summary>
        <div className="settings-group" style={{ padding: '4px 0' }}>
          {VISUAL_SLIDERS.map(({ key, label, min, max, step }) => (
            <label key={key} className="physics-slider">
              <span>{label}: {visualConfig[key]}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={visualConfig[key]}
                onChange={e => updateVisualConfig(key, parseFloat(e.target.value))}
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  )
}
