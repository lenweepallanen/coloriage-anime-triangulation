import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { animationHasFrames, isLoopAnimation, type Project, type Animation, type Point2D } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import { computeZoneOutlinePolylines, drawZoneOutlinesPixi, hasZoneOutlineData } from '../../utils/zoneOutlines'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'

interface Props {
  project: Project
  style?: React.CSSProperties
}


function getAnimationData(project: Project) {
  // L'animation idle est la 1ère animation en mode 'loop' avec frames calculées.
  // Fallback : la 1ère animation avec frames, peu importe son mode.
  const ready = project.animations.filter(animationHasFrames)
  const restAnim: Animation | undefined = ready.find(isLoopAnimation) ?? ready[0]
  const readyOneshots: Animation[] = ready.filter(a => a.id !== restAnim?.id)
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
      // Outlines : tracées en overlay PIXI dans le ticker, pas bakées dans la texture.

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

      // Check for walk animations with limb separation
      const walkAnim = project.animations.find(a => a.type === 'walk' && a.mesh?.walkZoneFrames && a.mesh?.walkLimbSeparation)
      let zoneMeshSetup: ZoneMeshSetup | null = null
      const zoneOutlineGraphics = new Map<string, PIXI.Graphics>()

      if (walkAnim?.mesh?.walkLimbSeparation) {
        zoneMeshSetup = buildZoneMeshes(
          walkAnim.mesh.walkLimbSeparation,
          allPoints,
          mesh.triangles,
          texture,
          texCanvas.width,
          texCanvas.height,
          scale,
          offsetX,
          offsetY,
        )
        meshContainer.addChild(zoneMeshSetup.container)
        zoneMeshSetup.container.visible = false
        if (project.projectTriangulation && hasZoneOutlineData(project.projectTriangulation)) {
          for (const zone of project.projectTriangulation.zones ?? []) {
            const g = new PIXI.Graphics()
            g.zIndex = (zone.zOrder ?? 0) + 0.9
            zoneMeshSetup.container.addChild(g)
          zoneOutlineGraphics.set(zone.id, g)
          }
        }
      }

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

      // Audio elements : pour tous les oneshots déclenchables (pas l'animation idle).
      const audioElements = new Map<string, HTMLAudioElement>()
      const audioUrls: string[] = []
      for (const anim of project.animations) {
        if (anim.id !== restAnim?.id && anim.audioBlob && anim.audioEnabled) {
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

      // Walk zone frame counter
      let walkFrameCounter = 0
      const walkZoneFrames = walkAnim?.mesh?.walkZoneFrames
      const walkBodyFrames = walkAnim?.mesh?.walkBodyFrames
      const walkTotalFrames = walkBodyFrames?.length ?? 0

      // Overlay PIXI pour les outlines de zones (par-dessus tous les meshes).
      const outlineOverlay = new PIXI.Graphics()
      meshContainer.addChild(outlineOverlay)
      const tri = project.projectTriangulation

      // Animation loop
      app.ticker.add((delta) => {
        if (playingRef.current) advancePlayback(delta)

        const positions = getPositions()

        // Check if walk zone rendering is active
        const activeOneshotName = hasOneshots ? (multiPlaybackRef.current as MultiAnimationPlayback)?.activeOneshotName : null
        const isWalkZonePlaying = activeOneshotName && walkAnim && walkZoneFrames && walkBodyFrames && zoneMeshSetup
          && activeOneshotName === walkAnim.name

        if (isWalkZonePlaying && zoneMeshSetup) {
          pixiMesh.visible = false
          zoneMeshSetup.container.visible = true
          walkFrameCounter = (walkFrameCounter + Math.round(delta)) % walkTotalFrames

          for (const zm of zoneMeshSetup.zoneMeshes) {
            const zoneFrame = walkZoneFrames[zm.zoneId]?.[walkFrameCounter]
            if (zoneFrame) updateZoneMeshVertices(zm, zoneFrame, scale, offsetX, offsetY)
          }
          const bodyFrame = walkBodyFrames[walkFrameCounter]
          if (bodyFrame) updateZoneMeshVertices(zoneMeshSetup.bodyMesh, bodyFrame, scale, offsetX, offsetY)
        } else {
          pixiMesh.visible = true
          if (zoneMeshSetup) zoneMeshSetup.container.visible = false
          walkFrameCounter = 0

          const verts = geometry.getBuffer('aVertexPosition')
          for (let i = 0; i < positions.length; i++) {
            (verts.data as unknown as Float32Array)[i * 2] = positions[i].x * scale + offsetX;
            (verts.data as unknown as Float32Array)[i * 2 + 1] = positions[i].y * scale + offsetY
          }
          verts.update()
        }

        // Outlines de zones
        outlineOverlay.clear()
        if (tri && hasZoneOutlineData(tri)) {
          const bodyPositions = isWalkZonePlaying && walkBodyFrames
            ? walkBodyFrames[walkFrameCounter] ?? tri.bodyPoints
            : tri.bodyPoints
          const limbPositions: Record<string, typeof tri.bodyPoints> = {}
          for (const zoneId of Object.keys(tri.zonePoints ?? {})) {
            const wf = isWalkZonePlaying && walkZoneFrames ? walkZoneFrames[zoneId]?.[walkFrameCounter] : null
            limbPositions[zoneId] = wf ?? tri.zonePoints![zoneId]
          }
          const polylines = computeZoneOutlinePolylines(
            tri,
            { body: bodyPositions, limbs: limbPositions },
            (pt) => ({ x: pt.x * scale + offsetX, y: pt.y * scale + offsetY }),
          )
          if (isWalkZonePlaying && zoneOutlineGraphics.size > 0) {
            drawZoneOutlinesPixi(zoneOutlineGraphics, polylines)
          } else {
            for (const pl of polylines) {
              if (pl.points.length < 3) continue
              const colorNum = parseInt(pl.color.replace('#', ''), 16) || 0
              outlineOverlay.lineStyle({ width: pl.width, color: colorNum, alignment: 0.5, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND })
              outlineOverlay.moveTo(pl.points[0].x, pl.points[0].y)
              for (let i = 1; i < pl.points.length; i++) outlineOverlay.lineTo(pl.points[i].x, pl.points[i].y)
              outlineOverlay.lineTo(pl.points[0].x, pl.points[0].y)
            }
            outlineOverlay.lineStyle(0)
          }
          if (isWalkZonePlaying) outlineOverlay.clear()
          else { for (const g of zoneOutlineGraphics.values()) g.clear(); for (const m of zoneOutlineMasks.values()) m.clear() }
        }
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
