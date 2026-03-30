import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, Point2D } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { MeshPhysicsEffect, DEFAULT_PHYSICS_CONFIG } from '../../utils/meshPhysicsEffects'
import type { TouchState, PhysicsConfig } from '../../utils/meshPhysicsEffects'
import { DeviceParallax } from '../../utils/deviceParallax'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  contentAlignment?: ContentAlignment | null
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
  parallaxRangeX: number    // 0 to 60 px — horizontal
  parallaxRangeY: number    // 0 to 60 px — vertical
}

const DEFAULT_VISUAL_EFFECTS: VisualEffectsConfig = {
  shadowAlpha: 0.25,
  lightingAlpha: 0.6,
  parallaxRangeX: 20,
  parallaxRangeY: 20,
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
  { key: 'parallaxRangeX', label: 'Parallax H', min: 0, max: 60, step: 2 },
  { key: 'parallaxRangeY', label: 'Parallax V', min: 0, max: 60, step: 2 },
]

const LONG_PRESS_DURATION = 3000 // ms

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

// --- Long-press close button ---

function LongPressCloseButton({ onComplete }: { onComplete: () => void }) {
  const [progress, setProgress] = useState(0)
  const [pressing, setPressing] = useState(false)
  const startTimeRef = useRef<number>(0)
  const rafRef = useRef<number>(0)
  const completedRef = useRef(false)

  const animate = useCallback(() => {
    const elapsed = Date.now() - startTimeRef.current
    const p = Math.min(elapsed / LONG_PRESS_DURATION, 1)
    setProgress(p)
    if (p >= 1 && !completedRef.current) {
      completedRef.current = true
      onComplete()
      return
    }
    if (p < 1) {
      rafRef.current = requestAnimationFrame(animate)
    }
  }, [onComplete])

  const startPress = useCallback(() => {
    completedRef.current = false
    startTimeRef.current = Date.now()
    setPressing(true)
    rafRef.current = requestAnimationFrame(animate)
  }, [animate])

  const cancelPress = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    setPressing(false)
    setProgress(0)
  }, [])

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  // SVG circle progress
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const strokeOffset = circumference * (1 - progress)

  return (
    <button
      className="fullscreen-close-btn"
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={e => e.preventDefault()}
    >
      <svg width="44" height="44" viewBox="0 0 44 44">
        {/* Background circle */}
        <circle cx="22" cy="22" r={radius} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
        {/* Progress arc */}
        {pressing && (
          <circle
            cx="22" cy="22" r={radius}
            fill="none"
            stroke="#ff4444"
            strokeWidth="3"
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
            strokeLinecap="round"
            transform="rotate(-90 22 22)"
          />
        )}
        {/* X icon */}
        <line x1="16" y1="16" x2="28" y2="28" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="28" y1="16" x2="16" y2="28" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </button>
  )
}

// --- Helper: get rest animation and ready oneshot animations ---

function getAnimationData(project: Project) {
  const restAnim = project.animations.find(a => a.type === 'rest')
  const readyOneshots: Animation[] = project.animations.filter(
    a => (a.type === 'oneshot' || a.type === 'physics') && a.mesh?.videoFramesMesh && a.mesh.videoFramesMesh.length > 0
  )
  return { restAnim, readyOneshots }
}

export default function AnimationPlayer({ project, scanCanvas, contentAlignment, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [physicsConfig, setPhysicsConfig] = useState<PhysicsConfig>({ ...DEFAULT_PHYSICS_CONFIG })
  const [visualConfig, setVisualConfig] = useState<VisualEffectsConfig>({ ...DEFAULT_VISUAL_EFFECTS })
  const physicsRef = useRef<MeshPhysicsEffect | null>(null)
  const visualRef = useRef<VisualEffectsConfig>({ ...DEFAULT_VISUAL_EFFECTS })
  const touchRef = useRef<{ active: boolean; screenX: number; screenY: number }>({
    active: false, screenX: 0, screenY: 0
  })
  const [needsMotionPermission, setNeedsMotionPermission] = useState(false)
  const parallaxRef = useRef<DeviceParallax | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const multiPlaybackRef = useRef<MultiAnimationPlayback | null>(null)
  const ambientAudioRef = useRef<HTMLAudioElement | null>(null)
  const [playbackState, setPlaybackState] = useState<string>('rest')

  const { restAnim, readyOneshots } = getAnimationData(project)

  // Sync ambient audio with play/pause
  useEffect(() => {
    const audio = ambientAudioRef.current
    if (audio) {
      if (playing) audio.play().catch(() => {})
      else audio.pause()
    }
  }, [playing])

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

  const handleOneshotTrigger = useCallback((animId: string) => {
    multiPlaybackRef.current?.requestOneshot(animId)
  }, [])

  // Enter fullscreen + lock landscape on mount
  useEffect(() => {
    const el = playerRef.current
    if (!el) return

    let mounted = true

    const enterFullscreen = async () => {
      try {
        await el.requestFullscreen()
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (screen.orientation as any)?.lock?.('landscape')
        } catch { /* orientation lock not supported */ }
      } catch { /* fullscreen not supported */ }
    }
    enterFullscreen()

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && mounted) {
        try { screen.orientation?.unlock?.() } catch { /* ignore */ }
        onCloseRef.current()
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)

    return () => {
      mounted = false
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {})
      }
      try { screen.orientation?.unlock?.() } catch { /* ignore */ }
    }
  }, [])

  // PIXI setup
  useEffect(() => {
    if (!containerRef.current || !restAnim?.mesh) return

    const mesh = restAnim.mesh
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

      // Cover viewport preserving aspect ratio + oversize for parallax margin
      const setupBgSize = () => {
        const vidW = bgVideoEl!.videoWidth || viewW
        const vidH = bgVideoEl!.videoHeight || viewH
        const coverScale = Math.max(viewW / vidW, viewH / vidH) * 1.15
        bgSprite!.width = vidW * coverScale
        bgSprite!.height = vidH * coverScale
        bgSprite!.x = (viewW - vidW * coverScale) / 2
        bgSprite!.y = (viewH - vidH * coverScale) / 2
      }
      bgVideoEl.addEventListener('loadedmetadata', setupBgSize, { once: true })
      setupBgSize() // fallback if metadata already loaded
      bgContainer.addChild(bgSprite)
    }

    // --- Parallax ---
    const parallax = new DeviceParallax({ sensitivity: 6, smoothing: 0.8 })
    parallaxRef.current = parallax

    // Detect CSS-rotated landscape (phone physically in portrait but display rotated 90°)
    const isCSSRotated = window.matchMedia('(orientation: portrait)').matches
    if (isCSSRotated) {
      parallax.cssRotationOffset = 90
    }

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
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)

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

    // --- Shadow (filled contour polygon, no triangle mesh) ---
    const shadowOffsetX = 4
    const shadowOffsetY = 6

    // Build ordered contour vertex IDs (indices into allPoints)
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

    // Draw shadow polygon from point positions (image coords)
    function drawShadow(positions: Point2D[]) {
      shadowGraphics.clear()
      shadowContainer.alpha = visualRef.current.shadowAlpha
      if (shadowContainer.alpha <= 0 || contourVertexIds.length < 3) return
      shadowGraphics.beginFill(0x000000, 1.0)
      const first = contourVertexIds[0]
      shadowGraphics.moveTo(
        positions[first].x * scale + offsetX + shadowOffsetX,
        positions[first].y * scale + offsetY + shadowOffsetY
      )
      for (let ci = 1; ci < contourVertexIds.length; ci++) {
        const idx = contourVertexIds[ci]
        shadowGraphics.lineTo(
          positions[idx].x * scale + offsetX + shadowOffsetX,
          positions[idx].y * scale + offsetY + shadowOffsetY
        )
      }
      shadowGraphics.closePath()
      shadowGraphics.endFill()
    }

    // Initial shadow draw
    drawShadow(allPoints)

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

    // --- Background video parallax base position (updated on loadedmetadata) ---
    const bgBase = { x: bgSprite ? bgSprite.x : 0, y: bgSprite ? bgSprite.y : 0 }
    if (bgVideoEl) {
      bgVideoEl.addEventListener('loadedmetadata', () => {
        bgBase.x = bgSprite!.x
        bgBase.y = bgSprite!.y
      }, { once: true })
    }

    // --- Audio elements (oneshot + physics only, not rest) ---
    const audioElements = new Map<string, HTMLAudioElement>()
    const audioUrls: string[] = []
    for (const anim of project.animations) {
      if (anim.type !== 'rest' && anim.audioBlob && anim.audioEnabled) {
        const url = URL.createObjectURL(anim.audioBlob)
        audioUrls.push(url)
        const audio = new Audio(url)
        audioElements.set(anim.id, audio)
      }
    }

    // --- Ambient sound (project-level, looped continuously) ---
    let ambientAudio: HTMLAudioElement | null = null
    let ambientAudioUrl: string | null = null
    if (project.ambientSoundBlob && project.ambientSoundEnabled) {
      ambientAudioUrl = URL.createObjectURL(project.ambientSoundBlob)
      ambientAudio = new Audio(ambientAudioUrl)
      ambientAudio.loop = true
      ambientAudio.play().catch(() => {})
      ambientAudioRef.current = ambientAudio
    }

    // --- Animation loop ---
    if (hasFlow) {
      // Build oneshot animation data for MultiAnimationPlayback
      const oneshotAnims: OneshotAnimation[] = readyOneshots
        .filter(a => a.mesh?.videoFramesMesh)
        .map(a => ({
          id: a.id,
          name: a.name,
          frames: a.mesh!.videoFramesMesh!,
          overlay: a.physicsOverlay ?? false,
        }))

      const hasOneshots = oneshotAnims.length > 0

      // Use MultiAnimationPlayback if there are oneshot animations, otherwise plain LoopPlayback
      let getPositions: () => Point2D[]
      let advancePlayback: (delta: number) => void

      if (hasOneshots) {
        const playAudio = (animId: string) => {
          const audio = audioElements.get(animId)
          if (audio) { audio.currentTime = 0; audio.play().catch(() => {}) }
        }
        const multiPlayback = new MultiAnimationPlayback(
          mesh.videoFramesMesh!,
          oneshotAnims,
          {
            crossfadeFrames: mesh.crossfadeFrames ?? 7,
            onOneshotStart: playAudio,
            onOverlayStart: playAudio,
          }
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

      app.ticker.add((delta) => {
        if (playing) advancePlayback(delta)

        const positions = getPositions()

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

        // Update shadow contour polygon
        drawShadow(modifiedPositions)
        lightSprite.alpha = visualRef.current.lightingAlpha

        // Parallax on background
        if (bgSprite) {
          const p = parallax.getOffset()
          bgSprite.x = bgBase.x + p.offsetX * visualRef.current.parallaxRangeX
          bgSprite.y = bgBase.y + p.offsetY * visualRef.current.parallaxRangeY
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
        lightSprite.alpha = visualRef.current.lightingAlpha

        // Parallax (always active)
        if (bgSprite) {
          const p = parallax.getOffset()
          bgSprite.x = bgBase.x + p.offsetX * visualRef.current.parallaxRangeX
          bgSprite.y = bgBase.y + p.offsetY * visualRef.current.parallaxRangeY
        }

        if (physics.isIdle()) return

        physics.apply(allPoints, modifiedPositions)

        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()

        // Update shadow contour polygon
        drawShadow(modifiedPositions)
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
      multiPlaybackRef.current = null
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
      // Cleanup audio elements
      for (const audio of audioElements.values()) { audio.pause(); audio.src = '' }
      for (const url of audioUrls) URL.revokeObjectURL(url)
      if (ambientAudio) { ambientAudio.pause(); ambientAudio.src = '' }
      if (ambientAudioUrl) URL.revokeObjectURL(ambientAudioUrl)
      ambientAudioRef.current = null
      app.destroy(true, { children: true, texture: true })
      appRef.current = null
    }
  }, [project, scanCanvas, contentAlignment]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
      // onClose will be called via fullscreenchange listener
    } else {
      onClose()
    }
  }, [onClose])

  return (
    <div className="animation-player" ref={playerRef}>
      <div ref={containerRef} className="animation-canvas" />

      {/* Floating close button (long-press 3s) */}
      <LongPressCloseButton onComplete={handleExitFullscreen} />

      {/* Oneshot animation trigger buttons */}
      {readyOneshots.length > 0 && (
        <div className="oneshot-buttons" style={{
          position: 'absolute',
          bottom: 20,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 10,
          zIndex: 110,
        }}>
          {readyOneshots.map(anim => {
            const isOverlay = anim.physicsOverlay ?? false
            const disabled = !isOverlay && playbackState !== 'rest' && playbackState !== 'wait'
            return (
              <button
                key={anim.id}
                onClick={() => handleOneshotTrigger(anim.id)}
                disabled={disabled}
                style={{
                  padding: '10px 20px',
                  fontSize: '1em',
                  borderRadius: 12,
                  border: isOverlay ? '2px solid #9c27b0' : 'none',
                  background: disabled
                    ? 'rgba(255,255,255,0.3)'
                    : 'rgba(255,255,255,0.85)',
                  color: '#333',
                  cursor: disabled ? 'default' : 'pointer',
                  fontWeight: 600,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                  backdropFilter: 'blur(8px)',
                }}
              >
                {anim.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Floating settings gear button */}
      <button
        className="fullscreen-settings-btn"
        onClick={() => setSidebarOpen(o => !o)}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Retractable sidebar overlay */}
      {sidebarOpen && (
        <div className="animation-sidebar-overlay" onClick={() => setSidebarOpen(false)}>
          <div className="animation-sidebar-panel" onClick={e => e.stopPropagation()}>
            <div className="animation-controls">
              <button onClick={() => setPlaying(p => !p)}>
                {playing ? '⏸' : '▶'}
              </button>
              {needsMotionPermission && (
                <button onClick={handleMotionPermission}>
                  Mouvement
                </button>
              )}
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
      )}
    </div>
  )
}
