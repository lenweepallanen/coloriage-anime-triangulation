import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { animationHasFrames, type Project, type Animation, type Point2D } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { DeviceParallax } from '../../utils/deviceParallax'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import { inpaintHiddenFaceOnScan } from '../../utils/hiddenFaceTexture'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  lamaCanvas?: HTMLCanvasElement | null
  contentAlignment?: ContentAlignment | null
  onClose: () => void
}

// --- Visual effects config ---

interface VisualEffectsConfig {
  parallaxRangeX: number    // 0 to 60 px — horizontal
  parallaxRangeY: number    // 0 to 60 px — vertical
}

const DEFAULT_VISUAL_EFFECTS: VisualEffectsConfig = {
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
  { key: 'parallaxRangeX', label: 'Parallax H', min: 0, max: 60, step: 2 },
  { key: 'parallaxRangeY', label: 'Parallax V', min: 0, max: 60, step: 2 },
]

const LONG_PRESS_DURATION = 3000 // ms

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
    a => (a.type === 'oneshot' || a.type === 'physics' || a.type === 'bone' || a.type === 'walk') && animationHasFrames(a)
  )
  return { restAnim, readyOneshots }
}

export default function AnimationPlayer({ project, scanCanvas, lamaCanvas, contentAlignment, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [visualConfig, setVisualConfig] = useState<VisualEffectsConfig>({ ...DEFAULT_VISUAL_EFFECTS })
  const visualRef = useRef<VisualEffectsConfig>({ ...DEFAULT_VISUAL_EFFECTS })
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

    // --- Stage hierarchy ---
    const bgContainer = new PIXI.Container()
    const meshContainer = new PIXI.Container()
    app.stage.addChild(bgContainer)
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

    // --- Hidden face texture ---
    // LaMa mode: use the inpainted "scan without legs" for hidden face zones only
    // Fallback: Laplacian diffusion on a copy of the scan
    // In both cases, pure body + limbs use the original high-res scan texture
    let hfTexture: PIXI.Texture | undefined
    const walkAnim0 = project.animations.find(a => a.type === 'walk' && a.mesh?.walkLimbSeparation?.hiddenFaceZones)
    if (lamaCanvas) {
      hfTexture = PIXI.Texture.from(lamaCanvas)
    } else if (walkAnim0?.mesh?.walkLimbSeparation) {
      const sep = walkAnim0.mesh.walkLimbSeparation
      if (sep.hiddenFaceZones && sep.hiddenFaceZones.length > 0 && sep.bodyPoints && sep.bodyTriangles) {
        const hfCanvas = document.createElement('canvas')
        hfCanvas.width = scanCanvas.width
        hfCanvas.height = scanCanvas.height
        hfCanvas.getContext('2d')!.drawImage(scanCanvas, 0, 0)
        for (const hfz of sep.hiddenFaceZones) {
          inpaintHiddenFaceOnScan(hfCanvas, hfz, sep.bodyPoints, sep.bodyTriangles, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)
        }
        hfTexture = PIXI.Texture.from(hfCanvas)
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

    // --- Check for walk animations with limb separation ---
    // Find any walk animation with zone frames to enable multi-mesh z-order rendering
    const walkAnim = project.animations.find(a => a.type === 'walk' && a.mesh?.walkZoneFrames && a.mesh?.walkLimbSeparation)
    let zoneMeshSetup: ZoneMeshSetup | null = null

    if (walkAnim?.mesh?.walkLimbSeparation) {
      zoneMeshSetup = buildZoneMeshes(
        walkAnim.mesh.walkLimbSeparation,
        allPoints,
        mesh.triangles,
        texture,
        scanCanvas.width,
        scanCanvas.height,
        scale,
        offsetX,
        offsetY,
        contentAlignment ?? undefined,
        hfTexture,
      )
      meshContainer.addChild(zoneMeshSetup.container)
      // Hide the zone mesh container by default (shown during walk playback)
      zoneMeshSetup.container.visible = false

      // Hidden face meshes use the same scan texture (already inpainted above)
      // — no separate texture or UV replacement needed.
    }

    // Main mesh (used for rest + non-walk animations)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
    const material = new PIXI.MeshMaterial(texture)
    const pixiMesh = new PIXI.Mesh(geometry, material)
    meshContainer.addChild(pixiMesh)

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

      // Walk zone mesh frame counter (for z-ordered multi-mesh during walk oneshot)
      let walkFrameCounter = 0
      const walkZoneFrames = walkAnim?.mesh?.walkZoneFrames
      const walkBodyFrames = walkAnim?.mesh?.walkBodyFrames
      const walkTotalFrames = walkBodyFrames?.length ?? 0

      // Debug: verify body data consistency
      if (walkAnim?.mesh?.walkLimbSeparation) {
        const sep = walkAnim.mesh.walkLimbSeparation
        console.log('[Walk HF debug]', {
          bodyPointsCount: sep.bodyPoints?.length ?? 0,
          bodyFrameF0Count: walkBodyFrames?.[0]?.length ?? 0,
          hfZones: sep.hiddenFaceZones?.map(z => ({
            id: z.limbZoneId,
            triIndices: z.bodyTriangleIndices,
            maxVertIdx: Math.max(...z.bodyTriangleIndices.flatMap(ti => sep.bodyTriangles?.[ti] ?? [])),
          })),
          hfMeshes: zoneMeshSetup?.hiddenFaceMeshes?.map(m => ({ id: m.zoneId, numVerts: m.numVertices })),
          bodyMeshVerts: zoneMeshSetup?.bodyMesh?.numVertices,
        })
      }

      app.ticker.add((delta) => {
        if (playing) advancePlayback(delta)

        const positions = getPositions()

        // Check if we should use zone mesh rendering (walk animation active with separation)
        const activeOneshotId = hasOneshots ? (multiPlaybackRef.current as MultiAnimationPlayback)?.activeOneshotName : null
        const isWalkZonePlaying = activeOneshotId && walkAnim && walkZoneFrames && walkBodyFrames && zoneMeshSetup
          && activeOneshotId === walkAnim.name

        if (isWalkZonePlaying && zoneMeshSetup) {
          // Multi-mesh z-ordered rendering for walk animation
          pixiMesh.visible = false
          zoneMeshSetup.container.visible = true

          // Advance walk frame counter
          walkFrameCounter = (walkFrameCounter + Math.round(delta)) % walkTotalFrames

          // Update zone meshes
          for (const zm of zoneMeshSetup.zoneMeshes) {
            const zoneFrame = walkZoneFrames[zm.zoneId]?.[walkFrameCounter]
            if (zoneFrame) {
              updateZoneMeshVertices(zm, zoneFrame, scale, offsetX, offsetY)
            }
          }
          // Update body mesh
          const bodyFrame = walkBodyFrames[walkFrameCounter]
          if (bodyFrame) {
            updateZoneMeshVertices(zoneMeshSetup.bodyMesh, bodyFrame, scale, offsetX, offsetY)
          }
          // Update hidden face meshes (same bodyFrames, same bodyPoints)
          if (bodyFrame && zoneMeshSetup.hiddenFaceMeshes) {
            for (const hfm of zoneMeshSetup.hiddenFaceMeshes) {
              updateZoneMeshVertices(hfm, bodyFrame, scale, offsetX, offsetY)
            }
          }
        } else {
          // Standard single-mesh rendering
          pixiMesh.visible = true
          if (zoneMeshSetup) zoneMeshSetup.container.visible = false
          walkFrameCounter = 0

          // Update main mesh vertices
          const verts = geometry.getBuffer('aVertexPosition')
          for (let i = 0; i < positions.length; i++) {
            (verts.data as unknown as Float32Array)[i * 2] = positions[i].x * scale + offsetX;
            (verts.data as unknown as Float32Array)[i * 2 + 1] = positions[i].y * scale + offsetY
          }
          verts.update()
        }

        // Parallax on background
        if (bgSprite) {
          const p = parallax.getOffset()
          bgSprite.x = bgBase.x + p.offsetX * visualRef.current.parallaxRangeX
          bgSprite.y = bgBase.y + p.offsetY * visualRef.current.parallaxRangeY
        }
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
      multiPlaybackRef.current = null
      parallax.destroy()
      parallaxRef.current = null
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
