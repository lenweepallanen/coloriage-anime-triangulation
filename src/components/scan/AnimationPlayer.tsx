import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Point2D } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import { computeScanInsets } from '../../utils/pdfLayout'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MeshPhysicsEffect, DEFAULT_PHYSICS_CONFIG } from '../../utils/meshPhysicsEffects'
import type { TouchState, PhysicsConfig } from '../../utils/meshPhysicsEffects'
import { DeviceParallax } from '../../utils/deviceParallax'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  onClose: () => void
}

// --- Physics sliders ---

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

// --- Visual effects config ---

interface VisualEffectsConfig {
  shadowAlpha: number       // 0 to 0.5
  lightingAlpha: number     // 0 to 1
  parallaxRange: number     // 0 to 40 px
}

const DEFAULT_VISUAL_EFFECTS: VisualEffectsConfig = {
  shadowAlpha: 0.25,
  lightingAlpha: 0.6,
  parallaxRange: 20,
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
  { key: 'lightingAlpha', label: 'Éclairage', min: 0, max: 1, step: 0.05 },
  { key: 'parallaxRange', label: 'Parallax', min: 0, max: 40, step: 2 },
]

// --- Helper: create lighting gradient texture ---

function createLightingCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')!
  // Radial gradient: bright top-left, dark bottom-right
  const grad = ctx.createRadialGradient(80, 80, 0, 128, 128, 180)
  grad.addColorStop(0, 'rgba(255,255,255,0.35)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0)')
  grad.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 256, 256)
  return c
}

export default function AnimationPlayer({ project, scanCanvas, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [physicsConfig, setPhysicsConfig] = useState<PhysicsConfig>({ ...DEFAULT_PHYSICS_CONFIG })
  const [visualConfig, setVisualConfig] = useState<VisualEffectsConfig>({ ...DEFAULT_VISUAL_EFFECTS })
  const physicsRef = useRef<MeshPhysicsEffect | null>(null)
  const visualRef = useRef<VisualEffectsConfig>({ ...DEFAULT_VISUAL_EFFECTS })
  const touchRef = useRef<{ active: boolean; screenX: number; screenY: number }>({
    active: false, screenX: 0, screenY: 0
  })
  const [needsMotionPermission, setNeedsMotionPermission] = useState(false)
  const parallaxRef = useRef<DeviceParallax | null>(null)

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

  const handleMotionPermission = useCallback(async () => {
    const p = parallaxRef.current
    if (!p) return
    const granted = await p.requestPermission()
    if (granted) {
      p.start()
      setNeedsMotionPermission(false)
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current || !project.mesh) return

    const mesh = project.mesh
    const allPoints = [...mesh.contourAnchors, ...mesh.contourSubdivisionPoints, ...mesh.anchorPoints, ...mesh.internalPoints]
    const hasFlow = mesh.videoFramesMesh && mesh.videoFramesMesh.length > 0
    const hasBgVideo = !!project.backgroundVideoBlob

    // Create PIXI application
    const app = new PIXI.Application({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: hasBgVideo ? 0x000000 : 0xFFFFFF,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    appRef.current = app
    containerRef.current.appendChild(app.view as HTMLCanvasElement)

    // Pointer events for physics interaction
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
    const onPointerUp = () => {
      touchRef.current.active = false
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    // --- Stage hierarchy ---
    const bgContainer = new PIXI.Container()
    const shadowContainer = new PIXI.Container()
    const meshContainer = new PIXI.Container()
    app.stage.addChild(bgContainer)
    app.stage.addChild(shadowContainer)
    app.stage.addChild(meshContainer)

    // --- Background video ---
    let bgSprite: PIXI.Sprite | null = null
    let bgVideoEl: HTMLVideoElement | null = null
    let bgVideoUrl: string | null = null
    const viewW = app.screen.width
    const viewH = app.screen.height

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

      // Cover viewport with 10% oversize for parallax margin
      const oversize = 1.1
      bgSprite.width = viewW * oversize
      bgSprite.height = viewH * oversize
      bgSprite.x = -(viewW * (oversize - 1)) / 2
      bgSprite.y = -(viewH * (oversize - 1)) / 2
      bgContainer.addChild(bgSprite)
    }

    // --- Parallax ---
    const parallax = new DeviceParallax({ sensitivity: 6, smoothing: 0.8 })
    parallaxRef.current = parallax

    if (DeviceParallax.isAvailable) {
      if (DeviceParallax.needsPermission) {
        // iOS: need user gesture — show button
        setNeedsMotionPermission(true)
      } else {
        parallax.requestPermission().then(granted => {
          if (granted) parallax.start()
        })
      }
    }

    // --- Mesh texture & geometry ---
    const texture = PIXI.Texture.from(scanCanvas)
    const insets = computeScanInsets(scanCanvas.width, scanCanvas.height)
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height, insets)

    const indices = new Uint16Array(mesh.triangles.length * 3)
    mesh.triangles.forEach((tri, i) => {
      indices[i * 3] = tri[0]
      indices[i * 3 + 1] = tri[1]
      indices[i * 3 + 2] = tri[2]
    })

    // Scale & offset — fit canvas content to available space
    const scaleX = viewW / scanCanvas.width
    const scaleY = viewH / scanCanvas.height
    const scale = Math.min(scaleX, scaleY)
    const offsetX = (viewW - scanCanvas.width * scale) / 2
    const offsetY = (viewH - scanCanvas.height * scale) / 2

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

    // --- Shadow mesh ---
    const shadowVertices = new Float32Array(vertices)
    // Flat UVs (all 0,0) for solid color
    const shadowUvs = new Float32Array(allPoints.length * 2)
    const shadowGfx = new PIXI.Graphics()
    shadowGfx.beginFill(0x000000)
    shadowGfx.drawRect(0, 0, 1, 1)
    shadowGfx.endFill()
    const shadowTexture = app.renderer.generateTexture(shadowGfx)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shadowGeometry = new PIXI.MeshGeometry(shadowVertices as any, shadowUvs as any, indices as any)
    const shadowMaterial = new PIXI.MeshMaterial(shadowTexture, { alpha: visualRef.current.shadowAlpha })
    const shadowMesh = new PIXI.Mesh(shadowGeometry, shadowMaterial)
    shadowContainer.addChild(shadowMesh)
    shadowContainer.filters = [new PIXI.BlurFilter(4)]

    const shadowOffsetX = 3
    const shadowOffsetY = 5

    // --- Lighting overlay ---
    const lightCanvas = createLightingCanvas()
    const lightTexture = PIXI.Texture.from(lightCanvas)
    const lightSprite = new PIXI.Sprite(lightTexture)
    lightSprite.width = scanCanvas.width * scale
    lightSprite.height = scanCanvas.height * scale
    lightSprite.x = offsetX
    lightSprite.y = offsetY
    lightSprite.blendMode = PIXI.BLEND_MODES.OVERLAY
    lightSprite.alpha = visualRef.current.lightingAlpha
    meshContainer.addChild(lightSprite)

    // --- Physics ---
    const physics = new MeshPhysicsEffect(allPoints.length, physicsConfig)
    physicsRef.current = physics
    const modifiedPositions: Point2D[] = new Array(allPoints.length)
    for (let i = 0; i < allPoints.length; i++) modifiedPositions[i] = { x: 0, y: 0 }

    const screenToImage = (sx: number, sy: number): { x: number; y: number } => ({
      x: (sx - offsetX) / scale,
      y: (sy - offsetY) / scale,
    })

    // --- Background video parallax base position ---
    const bgBaseX = bgSprite ? bgSprite.x : 0
    const bgBaseY = bgSprite ? bgSprite.y : 0

    // --- Animation loop ---
    if (hasFlow) {
      const playback = new LoopPlayback(mesh.videoFramesMesh!, { crossfadeFrames: mesh.crossfadeFrames ?? 7 })

      app.ticker.add((delta) => {
        if (playing) playback.advance(delta)

        const positions = playback.getPositions()

        // Physics
        const t = touchRef.current
        const img = screenToImage(t.screenX, t.screenY)
        const touchState: TouchState = { active: t.active, imageX: img.x, imageY: img.y }
        physics.update(positions, touchState, delta)

        if (physics.isIdle() && !playing) return

        physics.apply(positions, modifiedPositions)

        // Update main mesh vertices
        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()

        // Update shadow mesh vertices (with offset)
        const sVerts = shadowGeometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (sVerts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX + shadowOffsetX;
          (sVerts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY + shadowOffsetY
        }
        sVerts.update()

        // Visual effects live update
        shadowMaterial.alpha = visualRef.current.shadowAlpha
        lightSprite.alpha = visualRef.current.lightingAlpha

        // Parallax on background
        if (bgSprite) {
          const p = parallax.getOffset()
          const range = visualRef.current.parallaxRange
          bgSprite.x = bgBaseX + p.offsetX * range
          bgSprite.y = bgBaseY + p.offsetY * range
        }
      })
    } else {
      // Static mesh: only physics, no animation
      app.ticker.add((delta) => {
        const t = touchRef.current
        const img = screenToImage(t.screenX, t.screenY)
        const touchState: TouchState = { active: t.active, imageX: img.x, imageY: img.y }
        physics.update(allPoints, touchState, delta)

        // Visual effects live update
        shadowMaterial.alpha = visualRef.current.shadowAlpha
        lightSprite.alpha = visualRef.current.lightingAlpha

        // Parallax (always active)
        if (bgSprite) {
          const p = parallax.getOffset()
          const range = visualRef.current.parallaxRange
          bgSprite.x = bgBaseX + p.offsetX * range
          bgSprite.y = bgBaseY + p.offsetY * range
        }

        if (physics.isIdle()) return

        physics.apply(allPoints, modifiedPositions)

        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()

        const sVerts = shadowGeometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (sVerts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX + shadowOffsetX;
          (sVerts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY + shadowOffsetY
        }
        sVerts.update()
      })
    }

    // Handle resize
    function handleResize() {
      if (!containerRef.current) return
      app.renderer.resize(
        containerRef.current.clientWidth,
        containerRef.current.clientHeight
      )
    }
    window.addEventListener('resize', handleResize)

    return () => {
      physicsRef.current = null
      parallax.destroy()
      parallaxRef.current = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('resize', handleResize)
      if (bgVideoEl) {
        bgVideoEl.pause()
        bgVideoEl.src = ''
      }
      if (bgVideoUrl) URL.revokeObjectURL(bgVideoUrl)
      app.destroy(true, { children: true, texture: true })
      appRef.current = null
    }
  }, [project, scanCanvas]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleFullscreen() {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      el.requestFullscreen()
    }
  }

  return (
    <div className="animation-player">
      <div ref={containerRef} className="animation-canvas" />
      <div className="animation-sidebar">
        <div className="animation-controls">
          <button onClick={() => setPlaying(p => !p)}>
            {playing ? '⏸' : '▶'}
          </button>
          {needsMotionPermission && (
            <button onClick={handleMotionPermission}>
              Mouvement
            </button>
          )}
          <button onClick={toggleFullscreen}>
            ⛶
          </button>
          <button onClick={onClose} className="btn-danger">
            ✕
          </button>
        </div>
        <div className="animation-settings">
          <details open>
            <summary>Physique</summary>
            <div className="settings-group">
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
          <details open>
            <summary>Effets visuels</summary>
            <div className="settings-group">
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
      </div>
    </div>
  )
}
