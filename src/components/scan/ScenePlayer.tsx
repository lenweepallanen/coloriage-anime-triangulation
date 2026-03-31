import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, Point2D, MeshData } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { MeshPhysicsEffect, DEFAULT_PHYSICS_CONFIG } from '../../utils/meshPhysicsEffects'
import type { TouchState } from '../../utils/meshPhysicsEffects'
import { ScenePlayback } from '../../utils/scenePlayback'
import type { SceneState } from '../../utils/scenePlayback'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  contentAlignment?: ContentAlignment | null
  onClose: () => void
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

export default function ScenePlayer({ project, scanCanvas, contentAlignment, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)
  const playingRef = useRef(true)
  const [sceneState, setSceneState] = useState<SceneState>('interaction')
  const [currentRestIdx, setCurrentRestIdx] = useState(0)
  const scenePlaybackRef = useRef<ScenePlayback | null>(null)
  const physicsRef = useRef<MeshPhysicsEffect | null>(null)
  const touchRef = useRef<{ active: boolean; screenX: number; screenY: number }>({
    active: false, screenX: 0, screenY: 0,
  })
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => { playingRef.current = playing }, [playing])

  const scene = project.scene!
  const restAnim = project.animations.find(a => a.type === 'rest')

  const animMap = useRef(new Map<string, Animation>())
  useEffect(() => {
    const map = new Map<string, Animation>()
    for (const a of project.animations) {
      if (a.mesh?.videoFramesMesh && a.mesh.videoFramesMesh.length > 0) {
        map.set(a.id, a)
      }
    }
    animMap.current = map
  }, [project.animations])

  // Enter fullscreen + lock landscape
  useEffect(() => {
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
  }, [])

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

    const canvas = app.view as HTMLCanvasElement
    canvas.style.touchAction = 'none'

    const onPointerDown = (e: PointerEvent) => { touchRef.current = { active: true, screenX: e.offsetX, screenY: e.offsetY } }
    const onPointerMove = (e: PointerEvent) => { if (touchRef.current.active) { touchRef.current.screenX = e.offsetX; touchRef.current.screenY = e.offsetY } }
    const onPointerUp = () => { touchRef.current.active = false }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    const viewW = app.screen.width
    const viewH = app.screen.height

    const bgContainer = new PIXI.Container()
    const characterContainer = new PIXI.Container()
    app.stage.addChild(bgContainer)
    app.stage.addChild(characterContainer)

    let bgSprite: PIXI.Sprite | null = null
    let bgImageUrl: string | null = null
    const bgScale = viewH / scene.backgroundHeight

    if (scene.backgroundImageBlob) {
      bgImageUrl = URL.createObjectURL(scene.backgroundImageBlob)
      const bgImg = new Image()
      bgImg.src = bgImageUrl
      bgImg.onload = () => {
        const bgCanvas = document.createElement('canvas')
        bgCanvas.width = bgImg.naturalWidth
        bgCanvas.height = bgImg.naturalHeight
        const bgCtx = bgCanvas.getContext('2d')!
        bgCtx.drawImage(bgImg, 0, 0)

        const bgTexture = PIXI.Texture.from(bgCanvas)
        const sprite = new PIXI.Sprite(bgTexture)
        sprite.width = scene.backgroundWidth * bgScale
        sprite.height = viewH
        bgContainer.addChild(sprite)
        bgSprite = sprite

        bgSprite.x = -scenePlayback.backgroundOffsetX * bgScale
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

    const physics = new MeshPhysicsEffect(numPoints, { ...DEFAULT_PHYSICS_CONFIG })
    physicsRef.current = physics
    const modifiedPositions: Point2D[] = new Array(numPoints)
    for (let i = 0; i < numPoints; i++) modifiedPositions[i] = { x: 0, y: 0 }

    const screenToImage = (sx: number, sy: number): { x: number; y: number } => ({
      x: (sx - charOffsetX) / charScale,
      y: (sy - charOffsetY) / charScale,
    })

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

    function setupMovementAnimation(animId: string | undefined) {
      const anim = animId ? animMap.current.get(animId) : null
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
        setupInteractionAnimation(rp?.restAnimationId, rp?.availableAnimationIds ?? [])
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
        setupInteractionAnimation(firstRp.restAnimationId, firstRp.availableAnimationIds ?? [])
      }
    }

    let prevSceneState: SceneState = initialState

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

      const t = touchRef.current
      const img = screenToImage(t.screenX, t.screenY)
      const touchState: TouchState = { active: t.active && scenePlayback.currentState === 'interaction', imageX: img.x, imageY: img.y }
      physics.update(positions, touchState, delta)
      physics.apply(positions, modifiedPositions)

      const verts = geometry.getBuffer('aVertexPosition')
      for (let i = 0; i < numPoints; i++) {
        (verts.data as unknown as Float32Array)[i * 2] = modifiedPositions[i].x * charScale + charOffsetX;
        (verts.data as unknown as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * charScale + charOffsetY
      }
      verts.update()

      if (bgSprite) {
        bgSprite.x = -scenePlayback.backgroundOffsetX * bgScale
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
      physicsRef.current = null
      scenePlaybackRef.current = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('resize', handleResize)
      if (bgImageUrl) URL.revokeObjectURL(bgImageUrl)
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

  const handleOneshotTrigger = useCallback((animId: string) => {
    const sp = scenePlaybackRef.current as unknown as { getMultiPlayback?: () => MultiAnimationPlayback | null }
    sp?.getMultiPlayback?.()?.requestOneshot(animId)
  }, [])

  // Get available animations for current rest point
  const currentRp = scene.restPoints[currentRestIdx]
  const availableAnims = (currentRp?.availableAnimationIds ?? [])
    .map(id => project.animations.find(a => a.id === id))
    .filter((a): a is Animation => a != null && a.mesh?.videoFramesMesh != null)

  const isInteraction = sceneState === 'interaction'
  const isLastRestPoint = currentRestIdx >= scene.restPoints.length - 1

  return (
    <div className="animation-player scene-player" ref={playerRef}>
      <div ref={containerRef} className="animation-canvas" />

      <LongPressCloseButton onComplete={handleExitFullscreen} />

      {isInteraction && (
        <div className="scene-player-buttons">
          {availableAnims.map(anim => (
            <button
              key={anim.id}
              onClick={() => handleOneshotTrigger(anim.id)}
              className="scene-player-anim-btn"
            >
              {anim.name}
            </button>
          ))}
          {!isLastRestPoint && (
            <button onClick={handleContinue} className="scene-player-continue-btn">
              Continuer ▶
            </button>
          )}
        </div>
      )}

      <button
        className="scene-player-playpause"
        onClick={() => setPlaying(p => !p)}
      >
        {playing ? '⏸' : '▶'}
      </button>
    </div>
  )
}
