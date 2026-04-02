import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, Point2D } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'

interface Props {
  project: Project
  style?: React.CSSProperties
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
  const multiPlaybackRef = useRef<MultiAnimationPlayback | null>(null)
  const ambientAudioRef = useRef<HTMLAudioElement | null>(null)
  const [playbackState, setPlaybackState] = useState<string>('rest')

  const { restAnim, readyOneshots } = getAnimationData(project)

  // Keep playingRef in sync + control ambient audio
  useEffect(() => {
    playingRef.current = playing
    const audio = ambientAudioRef.current
    if (audio) {
      if (playing) audio.play().catch(() => {})
      else audio.pause()
    }
  }, [playing])

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

      // Stage hierarchy
      const bgContainer = new PIXI.Container()
      const meshContainer = new PIXI.Container()
      app.stage.addChild(bgContainer)
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

      // Build oneshot animation data
      const oneshotAnims: OneshotAnimation[] = readyOneshots
        .filter(a => a.mesh?.videoFramesMesh)
        .map(a => ({
          id: a.id,
          name: a.name,
          frames: a.mesh!.videoFramesMesh!,
          overlay: a.physicsOverlay ?? false,
        }))

      // Audio elements (oneshot + physics only, not rest)
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

      // Ambient sound (project-level, looped continuously)
      let ambientAudio: HTMLAudioElement | null = null
      let ambientAudioUrl: string | null = null
      if (project.ambientSoundBlob && project.ambientSoundEnabled) {
        ambientAudioUrl = URL.createObjectURL(project.ambientSoundBlob)
        ambientAudio = new Audio(ambientAudioUrl)
        ambientAudio.loop = true
        ambientAudio.play().catch(() => {})
        ambientAudioRef.current = ambientAudio
      }

      const hasOneshots = oneshotAnims.length > 0
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
          },
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

        // Update vertices
        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < positions.length; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = positions[i].x * scale + offsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = positions[i].y * scale + offsetY
        }
        verts.update()
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
        if (bgVideoEl) { bgVideoEl.pause(); bgVideoEl.src = '' }
        if (bgVideoUrl) URL.revokeObjectURL(bgVideoUrl)
        // Cleanup audio
        for (const audio of audioElements.values()) { audio.pause(); audio.src = '' }
        for (const url of audioUrls) URL.revokeObjectURL(url)
        if (ambientAudio) { ambientAudio.pause(); ambientAudio.src = '' }
        if (ambientAudioUrl) URL.revokeObjectURL(ambientAudioUrl)
        ambientAudioRef.current = null
        app!.destroy(true, { children: true, texture: true })
        appRef.current = null
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

    </div>
  )
}
