import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { animationHasFrames, type Project, type Animation, type Point2D, type MeshData } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { ScenePlayback } from '../../utils/scenePlayback'
import type { SceneState } from '../../utils/scenePlayback'
import { buildTriangleZoneMap, detectTouchedZone } from '../../utils/bodyZoneUtils'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'
import { inpaintHiddenFaceOnScan } from '../../utils/hiddenFaceTexture'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  lamaCanvas?: HTMLCanvasElement | null
  contentAlignment?: ContentAlignment | null
  onClose: () => void
  modal?: boolean
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

const LONG_PRESS_DURATION = 3000

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
    rafRef.current = requestAnimationFrame(animate)
  }, [onComplete])

  const start = useCallback(() => {
    completedRef.current = false
    startTimeRef.current = Date.now()
    setPressing(true)
    setProgress(0)
    rafRef.current = requestAnimationFrame(animate)
  }, [animate])

  const stop = useCallback(() => {
    setPressing(false)
    setProgress(0)
    cancelAnimationFrame(rafRef.current)
  }, [])

  useEffect(() => () => cancelAnimationFrame(rafRef.current), [])

  const circumference = 2 * Math.PI * 18
  const strokeOffset = circumference * (1 - progress)

  return (
    <button
      className="long-press-close-btn"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
    >
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="18" fill="rgba(0,0,0,0.5)" stroke="rgba(255,255,255,0.3)" strokeWidth="2" />
        {pressing && (
          <circle cx="22" cy="22" r="18" fill="none" stroke="#ef4444" strokeWidth="3"
            strokeDasharray={circumference} strokeDashoffset={strokeOffset}
            strokeLinecap="round" transform="rotate(-90 22 22)" />
        )}
        <line x1="16" y1="16" x2="28" y2="28" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="28" y1="16" x2="16" y2="28" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </button>
  )
}

export default function ScenePlayer({ project, scanCanvas, lamaCanvas, contentAlignment, onClose, modal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)
  const playingRef = useRef(true)
  const [sceneState, setSceneState] = useState<SceneState>('interaction')
  const [currentRestIdx, setCurrentRestIdx] = useState(0)
  const [showHelpBubble, setShowHelpBubble] = useState(false)
  const [currentHelpText, setCurrentHelpText] = useState('')
  const speakAudioRef = useRef<HTMLAudioElement | null>(null)
  const scenePlaybackRef = useRef<ScenePlayback | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => { playingRef.current = playing }, [playing])

  const scene = project.scene!
  const restAnim = project.animations.find(a => a.type === 'rest')

  const animMap = useRef(new Map<string, Animation>())
  useEffect(() => {
    const map = new Map<string, Animation>()
    for (const a of project.animations) {
      if (animationHasFrames(a)) {
        map.set(a.id, a)
      }
    }
    animMap.current = map
  }, [project.animations])

  // Enter fullscreen + lock landscape (skip in modal mode)
  useEffect(() => {
    if (modal) return
    const el = playerRef.current
    if (!el) return
    let mounted = true

    const enterFullscreen = async () => {
      try {
        await el.requestFullscreen()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { await (screen.orientation as any)?.lock?.('landscape') } catch { /* */ }
      } catch { /* */ }
    }
    enterFullscreen()

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && mounted) {
        try { screen.orientation?.unlock?.() } catch { /* */ }
        onCloseRef.current()
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)

    return () => {
      mounted = false
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      try { screen.orientation?.unlock?.() } catch { /* */ }
    }
  }, [modal])

  // PIXI setup
  useEffect(() => {
    if (!containerRef.current || !restAnim?.mesh) return

    const mesh = restAnim.mesh as MeshData
    const allPoints = [
      ...mesh.contourAnchors, ...mesh.contourSubdivisionPoints,
      ...mesh.anchorPoints, ...mesh.internalPoints,
    ]
    const numPoints = allPoints.length

    const app = new PIXI.Application({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: 0x000000,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    appRef.current = app
    containerRef.current.appendChild(app.view as HTMLCanvasElement)

    const viewW = app.screen.width
    const viewH = app.screen.height

    const bgContainer = new PIXI.Container()
    const characterContainer = new PIXI.Container()
    app.stage.addChild(bgContainer)
    app.stage.addChild(characterContainer)

    const bgSprites: (PIXI.Sprite | null)[] = [null, null, null]
    const bgImageUrls: string[] = []
    const frontLayer = scene.backgroundLayers[2]
    const bgScale = viewH / frontLayer.height

    // Pre-create 3 containers to guarantee z-order
    const layerContainers = [new PIXI.Container(), new PIXI.Container(), new PIXI.Container()]
    for (const lc of layerContainers) bgContainer.addChild(lc)

    for (let li = 0; li < 3; li++) {
      const layer = scene.backgroundLayers[li]
      if (!layer.imageBlob) continue
      const url = URL.createObjectURL(layer.imageBlob)
      bgImageUrls.push(url)
      const bgImg = new Image()
      bgImg.src = url
      const layerIndex = li
      bgImg.onload = () => {
        const bgCanvas = document.createElement('canvas')
        bgCanvas.width = bgImg.naturalWidth
        bgCanvas.height = bgImg.naturalHeight
        const bgCtx = bgCanvas.getContext('2d')!
        bgCtx.drawImage(bgImg, 0, 0)

        const bgTexture = PIXI.Texture.from(bgCanvas)
        const sprite = new PIXI.Sprite(bgTexture)
        const layerScale = viewH / layer.height
        sprite.width = layer.width * layerScale
        sprite.height = viewH
        layerContainers[layerIndex].addChild(sprite)
        bgSprites[layerIndex] = sprite
      }
    }

    const charFitScale = viewH / scanCanvas.height
    const charScale = charFitScale * scene.characterScale
    const charW = scanCanvas.width * charScale
    const charH = scanCanvas.height * charScale
    const charOffsetY = (viewH - charH) / 2 + scene.characterY * bgScale

    // Character X offset: computed dynamically each frame from scenePlayback.currentX.
    // Positions the character at its backgroundX on the background image,
    // accounting for background scroll offset. When background is wide enough to scroll,
    // the character appears centered. When it can't scroll (image not wide enough),
    // the character moves across the fixed background — giving the impression of movement.
    function computeCharOffsetX(sp: ScenePlayback): number {
      return sp.currentX * bgScale - sp.backgroundOffsetX * bgScale - charW / 2
    }
    // Initial value — will be updated once scenePlayback is created
    let charOffsetX = (viewW - charW) / 2

    // Hidden face texture
    // LaMa mode: use the inpainted "scan without legs" for hidden face zones only
    // Fallback: Laplacian diffusion on a copy of the scan
    // In both cases, pure body + limbs use the original high-res scan texture
    let hfTexture: PIXI.Texture | undefined
    const walkAnimForInpaint = project.animations.find(a => a.type === 'walk' && a.mesh?.walkLimbSeparation?.hiddenFaceZones)
    if (lamaCanvas) {
      hfTexture = PIXI.Texture.from(lamaCanvas)
    } else if (walkAnimForInpaint?.mesh?.walkLimbSeparation) {
      const sep = walkAnimForInpaint.mesh.walkLimbSeparation
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

    const texture = PIXI.Texture.from(scanCanvas)
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)

    const indices = new Uint16Array(mesh.triangles.length * 3)
    mesh.triangles.forEach((tri, i) => {
      indices[i * 3] = tri[0]
      indices[i * 3 + 1] = tri[1]
      indices[i * 3 + 2] = tri[2]
    })

    const vertices = new Float32Array(numPoints * 2)
    allPoints.forEach((p, i) => {
      vertices[i * 2] = p.x * charScale + charOffsetX
      vertices[i * 2 + 1] = p.y * charScale + charOffsetY
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
    const material = new PIXI.MeshMaterial(texture)
    const pixiMesh = new PIXI.Mesh(geometry, material)

    characterContainer.addChild(pixiMesh)

    // --- Zone meshes for walk animations with limb separation ---
    const walkAnims = project.animations.filter(a => a.type === 'walk' && a.mesh?.walkZoneFrames && a.mesh?.walkLimbSeparation)
    const walkZoneMeshMap = new Map<string, ZoneMeshSetup>()
    for (const wa of walkAnims) {
      if (!wa.mesh?.walkLimbSeparation) continue
      const setup = buildZoneMeshes(
        wa.mesh.walkLimbSeparation,
        allPoints,
        mesh.triangles,
        texture,
        scanCanvas.width,
        scanCanvas.height,
        charScale,
        0, 0, // offsets applied dynamically per frame
        contentAlignment ?? undefined,
        hfTexture,
      )
      setup.container.visible = false
      characterContainer.addChild(setup.container)
      walkZoneMeshMap.set(wa.id, setup)
    }
    // Track which walk zone mesh is currently active
    let activeWalkZoneAnimId: string | null = null

    // --- Audio elements for animation sounds ---
    const animAudioElements = new Map<string, HTMLAudioElement>()
    const animAudioUrls: string[] = []
    for (const anim of project.animations) {
      if (anim.type !== 'rest' && anim.audioBlob && anim.audioEnabled) {
        const url = URL.createObjectURL(anim.audioBlob)
        animAudioUrls.push(url)
        const audio = new Audio(url)
        animAudioElements.set(anim.id, audio)
      }
    }
    const playAnimAudio = (animId: string) => {
      const audio = animAudioElements.get(animId)
      if (audio) { audio.currentTime = 0; audio.play().catch(() => {}) }
    }

    // --- Zone touch detection (setup) ---
    const triangleZoneMap = buildTriangleZoneMap(mesh.triangles, project.bodyZones ?? [])
    let latestPositions: Point2D[] = allPoints

    const screenToImage = (sx: number, sy: number): { x: number; y: number } => ({
      x: (sx - charOffsetX) / charScale,
      y: (sy - charOffsetY) / charScale,
    })

    const canvas = app.view as HTMLCanvasElement
    canvas.style.touchAction = 'none'

    // --- Scene playback state machine ---
    const scenePlayback = new ScenePlayback({
      scene,
      viewportWidth: viewW / bgScale,
      viewportHeight: viewH / bgScale,
      onRestPointArrival: (index) => {
        setCurrentRestIdx(index)
      },
    })
    scenePlaybackRef.current = scenePlayback

    // Now that scenePlayback exists, compute the correct initial charOffsetX
    charOffsetX = computeCharOffsetX(scenePlayback)

    // --- Animation switching ---
    let currentGetPositions: () => Point2D[] = () => allPoints
    let currentAdvance: (delta: number) => void = () => {}

    let blendFrom: Point2D[] | null = null
    let blendTo: (() => Point2D[]) | null = null
    let blendProgress = 0
    const blendDuration = 7 / 24

    // Zone playback state for walk animations
    let activeZonePlaybacks: { zoneId: string; playback: LoopPlayback }[] | null = null
    let activeBodyPlayback: LoopPlayback | null = null

    function activateZoneMeshes(animId: string | null) {
      // Hide all zone setups
      for (const [id, setup] of walkZoneMeshMap) {
        setup.container.visible = (id === animId)
      }
      activeWalkZoneAnimId = animId
      if (!animId) {
        activeZonePlaybacks = null
        activeBodyPlayback = null
      }
    }

    function setupMovementAnimation(animId: string | undefined) {
      const anim = animId ? animMap.current.get(animId) : null

      // Check if this is a walk with zone separation
      if (anim && anim.mesh?.walkZoneFrames && anim.mesh.walkBodyFrames && walkZoneMeshMap.has(anim.id)) {
        activateZoneMeshes(anim.id)
        pixiMesh.visible = false

        // Create per-zone LoopPlayback
        const sep = anim.mesh.walkLimbSeparation!
        activeZonePlaybacks = sep.zones.map(zone => ({
          zoneId: zone.id,
          playback: new LoopPlayback(anim.mesh!.walkZoneFrames![zone.id], { crossfadeFrames: anim.mesh?.crossfadeFrames ?? 7 }),
        }))
        activeBodyPlayback = new LoopPlayback(anim.mesh.walkBodyFrames, { crossfadeFrames: anim.mesh?.crossfadeFrames ?? 7 })

        // currentGetPositions still returns legacy positions for blending/touch detection
        const legacyFrames = anim.mesh.videoFramesMesh
        if (legacyFrames && legacyFrames.length > 0) {
          const legacyPb = new LoopPlayback(legacyFrames, { crossfadeFrames: anim.mesh?.crossfadeFrames ?? 7 })
          currentGetPositions = () => legacyPb.getPositions()
          currentAdvance = (delta) => {
            legacyPb.advance(delta)
            activeZonePlaybacks?.forEach(zp => zp.playback.advance(delta))
            activeBodyPlayback?.advance(delta)
          }
        } else {
          currentGetPositions = () => allPoints
          currentAdvance = (delta) => {
            activeZonePlaybacks?.forEach(zp => zp.playback.advance(delta))
            activeBodyPlayback?.advance(delta)
          }
        }
        return
      }

      // Standard (non-walk) animation
      activateZoneMeshes(null)
      pixiMesh.visible = true

      const frames = anim?.mesh?.videoFramesMesh
      if (!frames || frames.length === 0) {
        currentGetPositions = () => allPoints
        currentAdvance = () => {}
        return
      }
      const playback = new LoopPlayback(frames, { crossfadeFrames: anim?.mesh?.crossfadeFrames ?? 7 })
      currentGetPositions = () => playback.getPositions()
      currentAdvance = (delta) => playback.advance(delta)
    }

    function setupInteractionAnimation(restAnimId: string | undefined, availableAnimIds: string[]) {
      // Deactivate zone meshes when switching to interaction mode
      activateZoneMeshes(null)
      pixiMesh.visible = true

      const restId = restAnimId || restAnim?.id
      const rest = restId ? animMap.current.get(restId) : null
      const restFrames = rest?.mesh?.videoFramesMesh || mesh.videoFramesMesh
      if (!restFrames || restFrames.length === 0) {
        currentGetPositions = () => allPoints
        currentAdvance = () => {}
        return
      }

      const oneshotAnims: OneshotAnimation[] = []
      for (const id of availableAnimIds) {
        const a = animMap.current.get(id)
        if (a?.mesh?.videoFramesMesh) {
          oneshotAnims.push({
            id: a.id,
            name: a.name,
            frames: a.mesh.videoFramesMesh,
            overlay: a.physicsOverlay ?? false,
          })
        }
      }

      if (oneshotAnims.length > 0) {
        const multiPlayback = new MultiAnimationPlayback(restFrames, oneshotAnims, {
          crossfadeFrames: rest?.mesh?.crossfadeFrames ?? 7,
          onOneshotStart: playAnimAudio,
          onOverlayStart: playAnimAudio,
        })
        currentMultiPlaybackRef = multiPlayback
        currentGetPositions = () => multiPlayback.getPositions()
        currentAdvance = (delta) => multiPlayback.advance(delta)
      } else {
        const playback = new LoopPlayback(restFrames, { crossfadeFrames: rest?.mesh?.crossfadeFrames ?? 7 })
        currentGetPositions = () => playback.getPositions()
        currentAdvance = (delta) => playback.advance(delta)
      }
    }

    let currentMultiPlaybackRef: MultiAnimationPlayback | null = null

    function switchAnimation(newState: SceneState) {
      blendFrom = currentGetPositions()
      blendProgress = 0

      if (newState === 'segment') {
        setupMovementAnimation(scenePlayback.currentSegmentAnimationId)
      } else if (newState === 'interaction' || newState === 'blend') {
        const rp = scenePlayback.currentRestPoint
        setupInteractionAnimation(rp?.restAnimationId, rp?.randomAnimationIds ?? [])
      }
      blendTo = currentGetPositions
    }

    // Initialize based on scene playback initial state
    const initialState = scenePlayback.currentState
    if (scene.restPoints.length > 0) {
      if (initialState === 'segment') {
        setupMovementAnimation(scenePlayback.currentSegmentAnimationId)
      } else {
        const firstRp = scene.restPoints[0]
        setupInteractionAnimation(firstRp.restAnimationId, firstRp.randomAnimationIds ?? [])
      }
    }

    let prevSceneState: SceneState = initialState

    // --- Zone touch detection (pointer event) ---
    const onPointerDown = (e: PointerEvent) => {
      if (scenePlayback.currentState !== 'interaction') return
      const img = screenToImage(e.offsetX, e.offsetY)
      const zoneId = detectTouchedZone(
        { x: img.x, y: img.y },
        latestPositions,
        mesh.triangles,
        triangleZoneMap,
      )
      if (!zoneId) return
      const rp = scenePlayback.currentRestPoint
      const mapping = rp?.zoneAnimationMappings?.find(m => m.zoneId === zoneId)
      if (mapping && currentMultiPlaybackRef) {
        currentMultiPlaybackRef.requestOneshot(mapping.animationId)
      }
    }
    canvas.addEventListener('pointerdown', onPointerDown)

    // --- Main ticker ---
    app.ticker.add((delta) => {
      const deltaSeconds = delta / 60

      if (playingRef.current) {
        scenePlayback.update(deltaSeconds)
        const newState = scenePlayback.currentState

        if (newState !== prevSceneState) {
          setSceneState(newState)
          switchAnimation(newState)
          prevSceneState = newState
        }

        currentAdvance(delta)
      }

      let positions: Point2D[]
      if (blendFrom && blendTo && blendProgress < 1) {
        blendProgress += (delta / 60) / blendDuration
        const t = smoothstep(Math.min(blendProgress, 1))
        const from = blendFrom
        const to = blendTo()
        positions = new Array(numPoints)
        for (let i = 0; i < numPoints; i++) {
          positions[i] = {
            x: from[i].x * (1 - t) + to[i].x * t,
            y: from[i].y * (1 - t) + to[i].y * t,
          }
        }
        if (blendProgress >= 1) {
          blendFrom = null
          blendTo = null
        }
      } else {
        positions = currentGetPositions()
      }

      // Update character X position based on current scene position
      charOffsetX = computeCharOffsetX(scenePlayback)
      latestPositions = positions

      // Zone mesh rendering for walk animations
      if (activeWalkZoneAnimId && activeZonePlaybacks && activeBodyPlayback) {
        const setup = walkZoneMeshMap.get(activeWalkZoneAnimId)
        if (setup) {
          // Update zone mesh positions
          for (const zp of activeZonePlaybacks) {
            const zm = setup.zoneMeshes.find(z => z.zoneId === zp.zoneId)
            if (zm) {
              updateZoneMeshVertices(zm, zp.playback.getPositions(), charScale, charOffsetX, charOffsetY)
            }
          }
          // Update body mesh
          const bodyPositions = activeBodyPlayback.getPositions()
          updateZoneMeshVertices(setup.bodyMesh, bodyPositions, charScale, charOffsetX, charOffsetY)
          // Update hidden face meshes (same bodyPoints, same bodyFrames)
          if (setup.hiddenFaceMeshes) {
            for (const hfm of setup.hiddenFaceMeshes) {
              updateZoneMeshVertices(hfm, bodyPositions, charScale, charOffsetX, charOffsetY)
            }
          }
        }
      }

      // Update single mesh (for non-walk or legacy fallback)
      if (pixiMesh.visible) {
        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < numPoints; i++) {
          (verts.data as unknown as Float32Array)[i * 2] = positions[i].x * charScale + charOffsetX;
          (verts.data as unknown as Float32Array)[i * 2 + 1] = positions[i].y * charScale + charOffsetY
        }
        verts.update()
      }

      // Parallax scrolling: each layer scrolls at depthFactor × front speed.
      // The offset is relative to the front layer's scroll, applied directly in screen pixels.
      const frontOffsetPx = scenePlayback.backgroundOffsetX * bgScale
      for (let li = 0; li < 3; li++) {
        const sprite = bgSprites[li]
        if (!sprite) continue
        sprite.x = -frontOffsetPx * scene.backgroundLayers[li].depthFactor
      }
    })

    function handleResize() {
      if (!containerRef.current) return
      app.renderer.resize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    const getMultiPlayback = () => currentMultiPlaybackRef
    ;(scenePlaybackRef.current as unknown as { getMultiPlayback: typeof getMultiPlayback }).getMultiPlayback = getMultiPlayback

    return () => {
      scenePlaybackRef.current = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', handleResize)
      for (const url of bgImageUrls) URL.revokeObjectURL(url)
      for (const audio of animAudioElements.values()) { audio.pause() }
      for (const url of animAudioUrls) URL.revokeObjectURL(url)
      app.destroy(true, { children: true, texture: true })
      appRef.current = null
    }
  }, [project, scanCanvas, contentAlignment, scene, restAnim]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      onClose()
    }
  }, [onClose])

  const handleContinue = useCallback(() => {
    scenePlaybackRef.current?.advance()
  }, [])

  const handleRandomAnimation = useCallback(() => {
    const rp = scene.restPoints[currentRestIdx]
    const ids = (rp?.randomAnimationIds ?? []).filter(id => {
      const a = project.animations.find(a => a.id === id)
      return a != null && animationHasFrames(a)
    })
    if (ids.length === 0) return
    const randomId = ids[Math.floor(Math.random() * ids.length)]
    const sp = scenePlaybackRef.current as unknown as { getMultiPlayback?: () => MultiAnimationPlayback | null }
    sp?.getMultiPlayback?.()?.requestOneshot(randomId)
  }, [currentRestIdx, scene.restPoints, project.animations])

  const handleSpeak = useCallback(() => {
    const rp = scene.restPoints[currentRestIdx]
    const activeIds = rp?.speakSoundIds ?? []
    if (activeIds.length === 0) return
    const randomId = activeIds[Math.floor(Math.random() * activeIds.length)]
    const idx = scene.speakSounds.findIndex(s => s.id === randomId)
    const blob = idx >= 0 ? scene.speakSoundBlobs[idx] : null
    if (!blob) return

    if (speakAudioRef.current) {
      speakAudioRef.current.pause()
      URL.revokeObjectURL(speakAudioRef.current.src)
    }
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    speakAudioRef.current = audio
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); speakAudioRef.current = null }
  }, [currentRestIdx, scene])

  const handleHelp = useCallback(() => {
    const rp = scene.restPoints[currentRestIdx]
    const texts = rp?.helpTexts ?? []
    if (texts.length === 0) return
    setCurrentHelpText(texts[Math.floor(Math.random() * texts.length)])
    setShowHelpBubble(true)
  }, [currentRestIdx, scene.restPoints])

  // Dismiss help bubble when rest point changes
  useEffect(() => { setShowHelpBubble(false) }, [currentRestIdx])

  // Cleanup speak audio on unmount
  useEffect(() => () => {
    if (speakAudioRef.current) {
      speakAudioRef.current.pause()
      URL.revokeObjectURL(speakAudioRef.current.src)
      speakAudioRef.current = null
    }
  }, [])

  const currentRp = scene.restPoints[currentRestIdx]
  const hasRandomAnims = (currentRp?.randomAnimationIds ?? []).some(id => {
    const a = project.animations.find(a => a.id === id)
    return a != null && a.mesh?.videoFramesMesh != null
  })
  const hasSpeakSounds = (currentRp?.speakSoundIds ?? []).length > 0
  const hasHelpTexts = (currentRp?.helpTexts ?? []).length > 0

  const isInteraction = sceneState === 'interaction'
  const isLastRestPoint = currentRestIdx >= scene.restPoints.length - 1

  return (
    <div className="animation-player scene-player" ref={playerRef}>
      <div ref={containerRef} className="animation-canvas" />

      {modal ? (
        <button className="preview-modal-close" onClick={onClose} title="Fermer">&times;</button>
      ) : (
        <LongPressCloseButton onComplete={handleExitFullscreen} />
      )}

      {/* LEFT side buttons */}
      {isInteraction && (hasRandomAnims || hasSpeakSounds) && (
        <div className="scene-player-left-buttons">
          {hasRandomAnims && (
            <button className="scene-player-random-anim-btn" onClick={handleRandomAnimation}>
              Animation
            </button>
          )}
          {hasSpeakSounds && (
            <button className="scene-player-speak-btn" onClick={handleSpeak}>
              Parler
            </button>
          )}
        </div>
      )}

      {/* RIGHT side - next arrow */}
      {isInteraction && !isLastRestPoint && (
        <button className="scene-player-next-btn" onClick={handleContinue}>
          &#x276F;
        </button>
      )}

      {/* RIGHT side - help button */}
      {hasHelpTexts && (
        <button className="scene-player-help-btn" onClick={handleHelp}>?</button>
      )}

      {/* Help speech bubble */}
      {showHelpBubble && (
        <div className="scene-player-help-bubble" onClick={() => setShowHelpBubble(false)}>
          <p>{currentHelpText}</p>
        </div>
      )}

      {/* Bottom center - play/pause */}
      <button
        className="scene-player-playpause"
        onClick={() => setPlaying(p => !p)}
      >
        {playing ? '⏸' : '▶'}
      </button>
    </div>
  )
}
