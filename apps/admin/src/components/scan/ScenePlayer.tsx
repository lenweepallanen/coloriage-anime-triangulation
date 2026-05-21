import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { animationHasFrames, getIdleAnimation, getGeometryOwner, type Project, type Animation, type Point2D, type MeshData, type WalkLimbSeparation, type ProjectTriangulation, type SceneRestPoint, type SceneActionStep } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { OncePlayback } from '../../utils/oncePlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { ScenePlayback } from '../../utils/scenePlayback'
import type { SceneState } from '../../utils/scenePlayback'
import { buildTriangleZoneMap, detectTouchedZone } from '../../utils/bodyZoneUtils'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import {
  buildPropLayer, updatePropLayer, buildAnchorIndexMap,
  getAnchorsByZone, getAnchorsByZoneFromCurrent,
} from '../../utils/propRenderer'
import type { PropLayerSetup } from '../../utils/propRenderer'
import { computeZoneOutlinePolylines, drawZoneOutlinesPixi, hasZoneOutlineData } from '../../utils/zoneOutlines'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'
import { inpaintHiddenFaceOnScan, flowExtrudeLimbOnScan } from '../../utils/hiddenFaceTexture'
import { EyeBlinkOverlay, getEyeBodyMeshData, getMouthAttachMesh } from '../../utils/eyeBlinkOverlay'
import { MouthOverlay, computeMouthPolygonFrame0, filterTrianglesOutsideMouth } from '../../utils/mouthOverlay'
import { loadMouthAudio, type MouthAudioPlayer } from '../../utils/mouthAudioAnalyser'

/** Build a pseudo-WalkLimbSeparation from a ProjectTriangulation for zone mesh rendering. */
function buildPseudoSeparation(tri: ProjectTriangulation): WalkLimbSeparation {
  return {
    zones: tri.zones.filter(z => z.id !== 'body').map((z, i) => ({
      id: z.id, label: z.label, color: z.color, bezierNodes: [], zOrder: z.zOrder ?? (i + 1), legIndex: i,
    })),
    overlapMargin: 0,
    zonePoints: tri.zonePoints,
    zoneTriangles: tri.zoneTriangles,
    bodyTriangleIndices: [],
    bodyZOrder: tri.zones.find(z => z.id === 'body')?.zOrder ?? 0,
    bodyPoints: tri.bodyPoints,
    bodyTriangles: tri.bodyTriangles,
    hiddenFaceZones: tri.hiddenFaceZones,
    hiddenFaceLimbZones: tri.hiddenFaceLimbZones,
  }
}

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
  const [showHelpBubble, setShowHelpBubble] = useState(false)
  const [currentHelpText, setCurrentHelpText] = useState('')
  const speakAudioRef = useRef<HTMLAudioElement | null>(null)
  // Active overlapping audio instances for attached scene animation sounds.
  const animSoundAudiosRef = useRef<HTMLAudioElement[]>([])
  // Lecteur WebAudio pour la bouche animée (RMS lip-sync).
  const mouthAudioRef = useRef<MouthAudioPlayer | null>(null)
  // RMS courant lu par le ticker PIXI (0 si aucun speak en cours).
  const mouthOpennessRef = useRef(0)
  // Étapes de l'action en cours (déclenchée par le bouton ☆) et son curseur.
  // Quand non-null, chaque démarrage d'oneshot consomme l'étape suivante et joue son son.
  const activeActionStepsRef = useRef<SceneActionStep[] | null>(null)
  const actionStepIdxRef = useRef(0)
  const scenePlaybackRef = useRef<ScenePlayback | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => { playingRef.current = playing }, [playing])

  const scene = project.scene!
  // Animation idle de la scène : on suit l'animation idle du rest point, sinon fallback.
  const restAnim = getIdleAnimation(project.animations, scene.restPoint?.restAnimationId)
    ?? getGeometryOwner(project.animations)

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
    // Pick the highest-index layer that actually has an image; fall back to viewport dims
    // so the scene still renders (character only) when no background layers are imported.
    let frontLayer = scene.backgroundLayers[2]
    for (let i = 2; i >= 0; i--) {
      const l = scene.backgroundLayers[i]
      if ((l?.imageBlob || l?.videoBlob) && l.height > 0) { frontLayer = l; break }
    }
    const bgScale = ((frontLayer.imageBlob || frontLayer.videoBlob) && frontLayer.height > 0)
      ? viewH / frontLayer.height
      : 1

    // Pre-create 3 containers to guarantee z-order
    const layerContainers = [new PIXI.Container(), new PIXI.Container(), new PIXI.Container()]
    for (const lc of layerContainers) bgContainer.addChild(lc)

    const bgVideoElements: HTMLVideoElement[] = []
    for (let li = 0; li < 3; li++) {
      const layer = scene.backgroundLayers[li]
      const layerIndex = li
      if (layer.videoBlob) {
        const url = URL.createObjectURL(layer.videoBlob)
        bgImageUrls.push(url)
        const vid = document.createElement('video')
        // iOS Safari : muted + playsInline DOIVENT être définis avant src,
        // sinon l'autoplay est bloqué et la texture PIXI reste blanche.
        vid.muted = true
        vid.defaultMuted = true
        vid.loop = true
        vid.autoplay = true
        vid.playsInline = true
        vid.setAttribute('muted', '')
        vid.setAttribute('playsinline', '')
        vid.setAttribute('webkit-playsinline', '')
        vid.setAttribute('autoplay', '')
        vid.setAttribute('loop', '')
        vid.crossOrigin = 'anonymous'
        vid.src = url
        // iOS exige que la <video> soit dans le DOM pour décoder. On l'ajoute en
        // caché — PIXI lira les frames via la même balise.
        vid.style.position = 'absolute'
        vid.style.width = '1px'
        vid.style.height = '1px'
        vid.style.opacity = '0'
        vid.style.pointerEvents = 'none'
        document.body.appendChild(vid)
        bgVideoElements.push(vid)
        const tryPlay = () => vid.play().catch(() => { /* retry on user gesture */ })
        tryPlay()
        // iOS bloque l'autoplay tant qu'il n'y a pas un geste utilisateur. On retente
        // au premier touch/pointer/click n'importe où, en phase capture pour passer
        // avant les handlers de la page.
        const onGesture = () => {
          tryPlay()
          document.removeEventListener('pointerdown', onGesture, true)
          document.removeEventListener('touchstart', onGesture, true)
          document.removeEventListener('click', onGesture, true)
        }
        document.addEventListener('pointerdown', onGesture, { passive: true, capture: true })
        document.addEventListener('touchstart', onGesture, { passive: true, capture: true })
        document.addEventListener('click', onGesture, { passive: true, capture: true })
        const bgTexture = PIXI.Texture.from(vid)
        const sprite = new PIXI.Sprite(bgTexture)
        const layerScale = viewH / layer.height
        sprite.width = layer.width * layerScale
        sprite.height = viewH
        layerContainers[layerIndex].addChild(sprite)
        bgSprites[layerIndex] = sprite
      } else if (layer.imageBlob) {
        const url = URL.createObjectURL(layer.imageBlob)
        bgImageUrls.push(url)
        const bgImg = new Image()
        bgImg.src = url
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
    let hfCanvasForOutline: HTMLCanvasElement | null = null
    const walkAnimForInpaint = project.animations.find(a => a.type === 'walk' && a.mesh?.walkLimbSeparation?.hiddenFaceZones)
    // Fallback project triangulation (members-bones-v3 sans LaMa).
    const triHiddenFace = project.projectTriangulation?.step3Validated && project.projectTriangulation.hiddenFaceZones.length > 0
      ? project.projectTriangulation : null
    if (lamaCanvas) {
      hfCanvasForOutline = lamaCanvas
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
        hfCanvasForOutline = hfCanvas
      }
    } else if (triHiddenFace && triHiddenFace.bodyPoints.length > 0 && triHiddenFace.bodyTriangles.length > 0) {
      const hfCanvas = document.createElement('canvas')
      hfCanvas.width = scanCanvas.width
      hfCanvas.height = scanCanvas.height
      hfCanvas.getContext('2d')!.drawImage(scanCanvas, 0, 0)
      for (const hfz of triHiddenFace.hiddenFaceZones) {
        inpaintHiddenFaceOnScan(hfCanvas, hfz, triHiddenFace.bodyPoints, triHiddenFace.bodyTriangles, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)
      }
      hfCanvasForOutline = hfCanvas
    }
    if (hfCanvasForOutline) {
      hfTexture = PIXI.Texture.from(hfCanvasForOutline)
    }

    // Outlines : tracées en overlay PIXI dans le ticker, pas bakées.
    const texture = PIXI.Texture.from(scanCanvas)
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)

    // --- Mouth hole polygon (frame 0, image coords) ---
    // Calculé une fois, sert à trouer le mesh legacy ET les zone/body meshes
    // pour que l'overlay mâchoire révèle le fond de scène en transparence.
    let mouthHolePolygon: Point2D[] | null = null
    {
      const mAttachId = project.projectMouth?.attachZoneId ?? 'body'
      if (project.projectMouth) {
        const mAttach = getMouthAttachMesh(project, mAttachId)
        if (mAttach && mAttach.triangles.length > 0) {
          mouthHolePolygon = computeMouthPolygonFrame0(project.projectMouth, mAttach.points, mAttach.triangles)
        }
      }
    }

    const legacyTriangles = mouthHolePolygon
      ? filterTrianglesOutsideMouth(allPoints, mesh.triangles, mouthHolePolygon)
      : mesh.triangles
    const indices = new Uint16Array(legacyTriangles.length * 3)
    legacyTriangles.forEach((tri, i) => {
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
    // Allow eyeOverlay (zIndex=9999) to render above walk/MB zone meshes added later.
    characterContainer.sortableChildren = true

    // --- Props (accessoires) — calque sprites rigides au-dessus du mesh.
    // Texture extraite du scan rectifié → l'enfant voit ses couleurs.
    let propLayer: PropLayerSetup | null = null
    const propAnchorIndexMap = buildAnchorIndexMap(project.projectTriangulation)
    if (project.props.length > 0) {
      propLayer = buildPropLayer(
        project.props,
        scanCanvas,
        scanCanvas.width,
        scanCanvas.height,
        project.projectTriangulation,
        charScale,
        charOffsetX,
        charOffsetY,
      )
      characterContainer.addChild(propLayer.container)
    }

    // --- Mouth overlay (project-level, optional) ---
    // Le body mesh sert d'ancrage barycentrique. On l'instancie après pixiMesh
    // pour qu'il rende au-dessus, et on l'update dans le ticker en utilisant
    // les positions body courantes (walk/MB) ou les positions du mesh legacy.
    let mouthOverlay: MouthOverlay | null = null
    let mouthOverlayBodyFrame0: Point2D[] | null = null
    const mouthAttachZoneId = project.projectMouth?.attachZoneId ?? 'body'
    if (project.projectMouth) {
      const mouthAttach = getMouthAttachMesh(project, mouthAttachZoneId)
      if (mouthAttach && mouthAttach.triangles.length > 0) {
        mouthOverlayBodyFrame0 = mouthAttach.points
        mouthOverlay = new MouthOverlay(
          project.projectMouth,
          characterContainer,
          mouthAttach.points,
          mouthAttach.triangles,
          texture,
          scanCanvas.width,
          scanCanvas.height,
          contentAlignment ?? undefined,
        )
      }
    }

    // --- Eye blink overlay (project-level, optional) ---
    let eyeOverlay: EyeBlinkOverlay | null = null
    if (project.projectEyes && project.projectEyes.regions.length > 0) {
      const bodyMesh = getEyeBodyMeshData(project)
      eyeOverlay = new EyeBlinkOverlay(
        project.projectEyes,
        characterContainer,
        mesh.trackedTriangles.length > 0 ? mesh.trackedTriangles : null,
        {
          nContourAnchors: mesh.contourAnchors.length,
          nContourSubdivision: mesh.contourSubdivisionPoints.length,
          nAnchorPoints: mesh.anchorPoints.length,
        },
        bodyMesh?.bodyTriangles ?? null,
        bodyMesh?.bodyPoints ?? null,
      )
    }

    // --- Zone meshes for walk animations with limb separation or MB with project triangulation ---
    const walkAnims = project.animations.filter(a => a.type === 'walk' && a.mesh?.walkZoneFrames && a.mesh?.walkLimbSeparation)
    const mbTriangAnims = project.projectTriangulation?.step3Validated
      ? project.animations.filter(a => (a.type === 'members-bones' || a.type === 'members-bones-v2' || a.type === 'members-bones-v3' || a.type === 'cotracker-bones' || a.type === 'marche') && a.mesh?.walkZoneFrames)
      : []
    const walkZoneMeshMap = new Map<string, ZoneMeshSetup>()
    // Outlines de zones par anim : Map animId → Map zoneId → PIXI.Graphics
    const zoneOutlineByAnim = new Map<string, Map<string, PIXI.Graphics>>()

    const allZoneAnims = [
      ...walkAnims.map(a => ({ anim: a, sep: a.mesh!.walkLimbSeparation! })),
      ...mbTriangAnims.map(a => ({ anim: a, sep: buildPseudoSeparation(project.projectTriangulation!) })),
    ]

    for (const { anim: wa, sep } of allZoneAnims) {

      // Generate per-limb extension textures via texture mirroring (synchronous)
      let hflTextures: Record<string, PIXI.Texture> | undefined
      if (sep.hiddenFaceLimbZones && sep.hiddenFaceLimbZones.length > 0) {
        hflTextures = {}
        for (const hfl of sep.hiddenFaceLimbZones) {
          const zonePts = sep.zonePoints[hfl.limbZoneId]
          const zoneTris = sep.zoneTriangles[hfl.limbZoneId]
          if (!zonePts || !zoneTris) continue
          const hflCanvas = document.createElement('canvas')
          hflCanvas.width = scanCanvas.width
          hflCanvas.height = scanCanvas.height
          hflCanvas.getContext('2d')!.drawImage(scanCanvas, 0, 0)
          flowExtrudeLimbOnScan(hflCanvas, hfl, zonePts, zoneTris, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)
          hflTextures[hfl.limbZoneId] = PIXI.Texture.from(hflCanvas)
        }
      }

      const setup = buildZoneMeshes(
        sep, allPoints, mesh.triangles, texture,
        scanCanvas.width, scanCanvas.height, charScale, 0, 0,
        contentAlignment ?? undefined, hfTexture, hflTextures,
        mouthHolePolygon
          ? { polygon: mouthHolePolygon, zoneId: project.projectMouth?.attachZoneId ?? 'body' }
          : null,
      )
      setup.container.visible = false
      characterContainer.addChild(setup.container)
      walkZoneMeshMap.set(wa.id, setup)
      // Outlines : une Graphics par zone, ajoutée dans setup.container avec
      // zIndex = zone.zOrder + 0.5 → s'interleave entre les meshes.
      if (project.projectTriangulation && hasZoneOutlineData(project.projectTriangulation)) {
        const outlineMap = new Map<string, PIXI.Graphics>()
        for (const zone of project.projectTriangulation.zones ?? []) {
          const g = new PIXI.Graphics()
          g.zIndex = (zone.zOrder ?? 0) + 0.9
          setup.container.addChild(g)
          outlineMap.set(zone.id, g)
        }
        zoneOutlineByAnim.set(wa.id, outlineMap)
      }
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

    /**
     * Joue un son de scène (action.sound ou step.sound). Si `isSpoken`, route via
     * MouthAudioPlayer pour piloter la bouche (lip-sync RMS) ; sinon HTMLAudio simple
     * empilé dans animSoundAudiosRef (cleanup au démontage ou au prochain ☆).
     */
    const playSceneSound = async (blob: Blob, isSpoken: boolean, volume: number = 1) => {
      if (isSpoken && project.projectMouth) {
        mouthAudioRef.current?.cleanup()
        mouthAudioRef.current = null
        try {
          const player = await loadMouthAudio(blob, {
            volume,
            onEnded: () => {
              mouthOpennessRef.current = 0
              mouthAudioRef.current?.cleanup()
              mouthAudioRef.current = null
            },
          })
          mouthAudioRef.current = player
          await player.play()
        } catch (err) {
          console.error('[ScenePlayer] spoken scene sound failed', err)
        }
        return
      }
      // Non parlé (ou pas de bouche définie) : HTMLAudio empilé
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.volume = volume
      animSoundAudiosRef.current.push(audio)
      audio.play().catch(() => {})
      audio.onended = () => {
        URL.revokeObjectURL(url)
        animSoundAudiosRef.current = animSoundAudiosRef.current.filter(a => a !== audio)
      }
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

    // --- Son d'ambiance (boucle continue) + son d'entrée (1 fois au début) ---
    let sceneAmbientAudio: HTMLAudioElement | null = null
    if (scene.ambientSound?.blob) {
      const url = URL.createObjectURL(scene.ambientSound.blob)
      const audio = new Audio(url)
      audio.loop = true
      audio.volume = scene.ambientSound.volume ?? 1
      audio.play().catch(() => {})
      sceneAmbientAudio = audio
    }
    if (scene.entrySound?.blob) {
      const url = URL.createObjectURL(scene.entrySound.blob)
      const audio = new Audio(url)
      audio.volume = scene.entrySound.volume ?? 1
      animSoundAudiosRef.current.push(audio)
      audio.play().catch(() => {})
      audio.onended = () => {
        URL.revokeObjectURL(url)
        animSoundAudiosRef.current = animSoundAudiosRef.current.filter(a => a !== audio)
      }
    }

    // --- Scene playback state machine ---
    const scenePlayback = new ScenePlayback({
      scene,
      viewportWidth: viewW / bgScale,
      viewportHeight: viewH / bgScale,
    })
    scenePlaybackRef.current = scenePlayback

    // Now that scenePlayback exists, compute the correct initial charOffsetX
    charOffsetX = computeCharOffsetX(scenePlayback)

    // --- Animation switching ---
    let currentGetPositions: () => Point2D[] = () => allPoints
    let currentAdvance: (delta: number) => void = () => {}

    let crossfadeProgress = 1   // 1 = no fade in progress
    let crossfadeDuration = 290 / 1000   // seconds
    let currentAdvanceEaseIn = false   // true = ramp new playback's delta during fade (segment → rest)
    let prevGetPositions: (() => Point2D[]) | null = null
    let prevAdvance: ((delta: number) => void) | null = null

    // Zone playback state for walk animations
    let activeZonePlaybacks: { zoneId: string; playback: LoopPlayback | OncePlayback }[] | null = null
    let activeBodyPlayback: LoopPlayback | OncePlayback | null = null
    let prevZonePlaybacks: { zoneId: string; playback: LoopPlayback | OncePlayback }[] | null = null
    let prevBodyPlayback: LoopPlayback | OncePlayback | null = null
    let prevWalkZoneAnimId: string | null = null

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
        const sep = anim.mesh.walkLimbSeparation ?? (project.projectTriangulation ? buildPseudoSeparation(project.projectTriangulation) : null)
        if (!sep) return
        // Capture les refs localement pour que la closure `currentAdvance` n'avance
        // QUE ses propres playbacks même après que `activeZonePlaybacks`/`activeBodyPlayback`
        // soient réassignés par un beginCrossfade ultérieur.
        const localZP = sep.zones.map(zone => ({
          zoneId: zone.id,
          playback: new LoopPlayback(anim.mesh!.walkZoneFrames![zone.id], { crossfadeFrames: anim.mesh?.crossfadeFrames ?? 7 }),
        }))
        const localBP = new LoopPlayback(anim.mesh.walkBodyFrames, { crossfadeFrames: anim.mesh?.crossfadeFrames ?? 7 })
        activeZonePlaybacks = localZP
        activeBodyPlayback = localBP

        // currentGetPositions still returns legacy positions for blending/touch detection
        const legacyFrames = anim.mesh.videoFramesMesh
        if (legacyFrames && legacyFrames.length > 0) {
          const legacyPb = new LoopPlayback(legacyFrames, { crossfadeFrames: anim.mesh?.crossfadeFrames ?? 7 })
          currentGetPositions = () => legacyPb.getPositions()
          currentAdvance = (delta) => {
            legacyPb.advance(delta)
            for (const zp of localZP) zp.playback.advance(delta)
            localBP.advance(delta)
          }
        } else {
          currentGetPositions = () => allPoints
          currentAdvance = (delta) => {
            for (const zp of localZP) zp.playback.advance(delta)
            localBP.advance(delta)
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
      const restId = restAnimId || restAnim?.id
      const rest = restId ? animMap.current.get(restId) : null

      // Cas zone-based (walk / members-bones-v*) : utiliser walkBodyFrames + walkZoneFrames
      // exactement comme setupMovementAnimation. La main pixiMesh est cachée.
      if (rest && rest.mesh?.walkZoneFrames && rest.mesh.walkBodyFrames && walkZoneMeshMap.has(rest.id)) {
        activateZoneMeshes(rest.id)
        pixiMesh.visible = false

        const sep = rest.mesh.walkLimbSeparation ?? (project.projectTriangulation ? buildPseudoSeparation(project.projectTriangulation) : null)
        if (!sep) return
        const localZP = sep.zones.map(zone => ({
          zoneId: zone.id,
          playback: new LoopPlayback(rest.mesh!.walkZoneFrames![zone.id], { crossfadeFrames: rest.mesh?.crossfadeFrames ?? 7 }),
        }))
        const localBP = new LoopPlayback(rest.mesh.walkBodyFrames, { crossfadeFrames: rest.mesh?.crossfadeFrames ?? 7 })
        activeZonePlaybacks = localZP
        activeBodyPlayback = localBP

        // Positions legacy pour blending / hit-test ; oneshots non supportés ici (le rest
        // est zone-based, les overlays mesh classique ne s'alignent pas).
        const legacyFrames = rest.mesh.videoFramesMesh
        if (legacyFrames && legacyFrames.length > 0) {
          const legacyPb = new LoopPlayback(legacyFrames, { crossfadeFrames: rest.mesh?.crossfadeFrames ?? 7 })
          currentGetPositions = () => legacyPb.getPositions()
          currentAdvance = (delta) => {
            legacyPb.advance(delta)
            for (const zp of localZP) zp.playback.advance(delta)
            localBP.advance(delta)
          }
        } else {
          currentGetPositions = () => allPoints
          currentAdvance = (delta) => {
            for (const zp of localZP) zp.playback.advance(delta)
            localBP.advance(delta)
          }
        }
        return
      }

      // Cas standard (single mesh) : pixiMesh + videoFramesMesh
      activateZoneMeshes(null)
      pixiMesh.visible = true

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
        const onOneshotStart = (animId: string) => {
          playAnimAudio(animId)
          // Consomme l'étape courante de l'action active : joue le step.sound
          // au démarrage effectif de l'animation (après wait + trans-out).
          const steps = activeActionStepsRef.current
          if (steps) {
            const idx = actionStepIdxRef.current
            const step = steps[idx]
            if (step?.sound?.blob) {
              playSceneSound(step.sound.blob, step.isSpoken ?? false, step.sound.volume ?? 1)
            }
            actionStepIdxRef.current = idx + 1
            if (idx + 1 >= steps.length) {
              activeActionStepsRef.current = null
              actionStepIdxRef.current = 0
            }
          }
        }
        const multiPlayback = new MultiAnimationPlayback(restFrames, oneshotAnims, {
          crossfadeFrames: rest?.mesh?.crossfadeFrames ?? 7,
          onOneshotStart,
          onOverlayStart: onOneshotStart,
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
    let lastSegmentCrossfadeMs: number | null = null
    let lastSegmentAnimId: string | undefined = undefined

    let zoneOneshotBody: OncePlayback | null = null

    function beginCrossfade(durationMs: number, easeInNew: boolean) {
      // Hide any leftover prev container (if a previous fade hadn't finished yet)
      if (prevWalkZoneAnimId && prevWalkZoneAnimId !== activeWalkZoneAnimId) {
        const oldSetup = walkZoneMeshMap.get(prevWalkZoneAnimId)
        if (oldSetup) { oldSetup.container.visible = false; oldSetup.container.alpha = 1 }
      }

      // Stash current playback state as "prev" — it will keep advancing during the fade.
      prevGetPositions = currentGetPositions
      prevAdvance = currentAdvance
      prevZonePlaybacks = activeZonePlaybacks
      prevBodyPlayback = activeBodyPlayback
      prevWalkZoneAnimId = activeWalkZoneAnimId

      crossfadeProgress = 0
      crossfadeDuration = Math.max(durationMs, 1) / 1000
      currentAdvanceEaseIn = easeInNew

      // Reset live refs so setup* doesn't accidentally inherit
      activeZonePlaybacks = null
      activeBodyPlayback = null
    }

    function switchAnimation(newState: SceneState, durationMs: number, easeInNew: boolean) {
      // Any scene-state-driven switch cancels an in-progress zone oneshot.
      zoneOneshotBody = null
      beginCrossfade(durationMs, easeInNew)

      if (newState === 'entering') {
        setupMovementAnimation(scenePlayback.currentSegmentAnimationId)
      } else if (newState === 'interaction' || newState === 'blend') {
        const rp = scenePlayback.currentRestPoint
        const animIds = collectRestPointAnimIds(rp)
        setupInteractionAnimation(rp?.restAnimationId, animIds)
      }

    }

    /** Collecte tous les ids d'animations déclenchables au rest point :
     *  actions flatmap + zoneAnimationMappings, avec fallback legacy randomAnimationIds. */
    function collectRestPointAnimIds(rp: SceneRestPoint | null): string[] {
      if (!rp) return []
      const set = new Set<string>()
      for (const a of rp.actions ?? []) for (const s of a.steps) if (s.animationId) set.add(s.animationId)
      for (const m of rp.zoneAnimationMappings ?? []) if (m.animationId) set.add(m.animationId)
      for (const id of rp.randomAnimationIds ?? []) set.add(id) // legacy
      return Array.from(set)
    }

    /**
     * Trigger a zone-based (walk / members-bones-v*) oneshot from the interaction state.
     * Plays the animation once (OncePlayback per zone + body), then auto-reverts to the
     * current rest point setup. Ignored if a oneshot is already in flight or the anim
     * is not zone-based / not ready.
     */
    function triggerZoneOneshot(animId: string): boolean {
      if (zoneOneshotBody) return false
      const anim = animMap.current.get(animId)
      if (!anim || !anim.mesh?.walkZoneFrames || !anim.mesh.walkBodyFrames || !walkZoneMeshMap.has(anim.id)) return false
      const sep = anim.mesh.walkLimbSeparation ?? (project.projectTriangulation ? buildPseudoSeparation(project.projectTriangulation) : null)
      if (!sep) return false

      beginCrossfade(290, false)
      activateZoneMeshes(anim.id)
      pixiMesh.visible = false

      const fps = 24
      const localZP = sep.zones.map(zone => ({
        zoneId: zone.id,
        playback: new OncePlayback(anim.mesh!.walkZoneFrames![zone.id], { fps }),
      }))
      const localBP = new OncePlayback(anim.mesh.walkBodyFrames, { fps })
      activeZonePlaybacks = localZP
      activeBodyPlayback = localBP
      zoneOneshotBody = localBP

      const legacyFrames = anim.mesh.videoFramesMesh
      if (legacyFrames && legacyFrames.length > 0) {
        const legacyPb = new OncePlayback(legacyFrames, { fps })
        currentGetPositions = () => legacyPb.getPositions()
        currentAdvance = (delta) => {
          legacyPb.advance(delta)
          for (const zp of localZP) zp.playback.advance(delta)
          localBP.advance(delta)
        }
      } else {
        currentGetPositions = () => allPoints
        currentAdvance = (delta) => {
          for (const zp of localZP) zp.playback.advance(delta)
          localBP.advance(delta)
        }
      }
      return true
    }

    function revertFromZoneOneshot() {
      zoneOneshotBody = null
      beginCrossfade(290, false)
      const rp = scenePlayback.currentRestPoint
      setupInteractionAnimation(rp?.restAnimationId, collectRestPointAnimIds(rp))
    }

    // Initialize based on scene playback initial state
    const initialState = scenePlayback.currentState
    if (scene.restPoint) {
      if (initialState === 'entering') {
        setupMovementAnimation(scenePlayback.currentSegmentAnimationId)
      } else {
        const rp = scene.restPoint
        setupInteractionAnimation(rp.restAnimationId, collectRestPointAnimIds(rp))
      }
    }

    let prevSceneState: SceneState = initialState
    lastSegmentAnimId = scenePlayback.currentSegmentAnimationId
    lastSegmentCrossfadeMs = null

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
      if (!mapping) return
      if (currentMultiPlaybackRef) {
        currentMultiPlaybackRef.requestOneshot(mapping.animationId)
      } else {
        triggerZoneOneshot(mapping.animationId)
      }
    }
    canvas.addEventListener('pointerdown', onPointerDown)

    // Overlay PIXI legacy (utilisé quand AUCUN setup walk/MB n'est actif —
    // on dessine au-dessus du single mesh).
    const outlineOverlay = new PIXI.Graphics()
    characterContainer.addChild(outlineOverlay)
    const triForOutline = project.projectTriangulation

    // --- Main ticker ---
    app.ticker.add((delta) => {
      const deltaSeconds = delta / 60

      // Sync pause/play du son d'ambiance avec le toggle ⏵/⏸
      if (sceneAmbientAudio) {
        if (playingRef.current && sceneAmbientAudio.paused) {
          sceneAmbientAudio.play().catch(() => {})
        } else if (!playingRef.current && !sceneAmbientAudio.paused) {
          sceneAmbientAudio.pause()
        }
      }

      if (playingRef.current) {
        scenePlayback.update(deltaSeconds)
        const newState = scenePlayback.currentState
        const newSegAnimId = scenePlayback.currentSegmentAnimationId
        const segCrossfade = 290

        // State change OR segment→segment animation change within the same transition
        const stateChanged = newState !== prevSceneState
        const segmentBoundary = newState === 'segment'
          && prevSceneState === 'entering'
          && newSegAnimId !== lastSegmentAnimId

        if (stateChanged || segmentBoundary) {
          // Choose crossfade duration: outgoing segment if we're leaving one,
          // otherwise incoming segment, otherwise default 290ms.
          let durationMs: number
          if (prevSceneState === 'entering' && (newState === 'interaction' || newState === 'blend')) {
            // Segment → rest point : priorité au fondu d'arrivée propre au rest point
            const arrivalMs = scenePlayback.currentRestPoint?.arrivalCrossfadeMs
            durationMs = arrivalMs ?? lastSegmentCrossfadeMs ?? 290
          } else if (prevSceneState === 'entering' && lastSegmentCrossfadeMs != null) {
            durationMs = lastSegmentCrossfadeMs
          } else if (newState === 'segment') {
            durationMs = segCrossfade
          } else {
            durationMs = 290
          }
          setSceneState(newState)
          const easeInNew = prevSceneState === 'entering' && (newState === 'interaction' || newState === 'blend')
          switchAnimation(newState, durationMs, easeInNew)
          prevSceneState = newState
        }

        // Track current segment metadata (for next-frame outgoing decision)
        if (newState === 'entering') {
          lastSegmentCrossfadeMs = segCrossfade
          lastSegmentAnimId = newSegAnimId
        } else {
          lastSegmentAnimId = undefined
        }

        // Pendant un fondu segment→rest, on ramp la nouvelle playback (rest) avec smoothstep
        // pour masquer le "démarrage à pleine vitesse" de la rest pendant que le segment est encore visible.
        if (currentAdvanceEaseIn && crossfadeProgress < 1) {
          const ramp = smoothstep(Math.min(crossfadeProgress, 1))
          currentAdvance(delta * ramp)
        } else {
          currentAdvance(delta)
        }
        if (prevAdvance && crossfadeProgress < 1) {
          prevAdvance(delta)
        }

        // Auto-revert from a zone-based oneshot once its body playback hits the last frame.
        // Only revert if the scene is still in interaction (a scene-state switch already
        // cancelled the oneshot via switchAnimation).
        if (zoneOneshotBody && zoneOneshotBody.isFinished && scenePlayback.currentState === 'interaction') {
          revertFromZoneOneshot()
        }
      }

      let positions: Point2D[]
      if (prevGetPositions && crossfadeProgress < 1) {
        crossfadeProgress += deltaSeconds / crossfadeDuration
        const t = smoothstep(Math.min(crossfadeProgress, 1))
        const from = prevGetPositions()
        const to = currentGetPositions()
        positions = new Array(numPoints)
        for (let i = 0; i < numPoints; i++) {
          positions[i] = {
            x: from[i].x * (1 - t) + to[i].x * t,
            y: from[i].y * (1 - t) + to[i].y * t,
          }
        }
        if (crossfadeProgress >= 1) {
          prevGetPositions = null
          prevAdvance = null
          prevZonePlaybacks = null
          prevBodyPlayback = null
          if (prevWalkZoneAnimId && prevWalkZoneAnimId !== activeWalkZoneAnimId) {
            const oldSetup = walkZoneMeshMap.get(prevWalkZoneAnimId)
            if (oldSetup) { oldSetup.container.visible = false; oldSetup.container.alpha = 1 }
          }
          prevWalkZoneAnimId = null
        }
      } else {
        positions = currentGetPositions()
      }

      // Update character X position based on current scene position
      charOffsetX = computeCharOffsetX(scenePlayback)
      latestPositions = positions

      // Vertex-position crossfade for zone-based meshes (topologie partagée).
      // Hide the old container; we blend positions onto the NEW container at alpha=1.
      const fadeActive = prevGetPositions != null && crossfadeProgress < 1
      const fadeT = fadeActive ? smoothstep(Math.min(crossfadeProgress, 1)) : 1
      if (activeWalkZoneAnimId) {
        const setup = walkZoneMeshMap.get(activeWalkZoneAnimId)
        if (setup) setup.container.alpha = 1
      }
      if (prevWalkZoneAnimId && prevWalkZoneAnimId !== activeWalkZoneAnimId) {
        const oldSetup = walkZoneMeshMap.get(prevWalkZoneAnimId)
        if (oldSetup) { oldSetup.container.visible = false; oldSetup.container.alpha = 1 }
      }

      const blendPts = (a: Point2D[], b: Point2D[], t: number): Point2D[] => {
        const n = Math.min(a.length, b.length)
        const out = new Array<Point2D>(n)
        for (let i = 0; i < n; i++) out[i] = { x: a[i].x * (1 - t) + b[i].x * t, y: a[i].y * (1 - t) + b[i].y * t }
        return out
      }

      // Zone mesh rendering for walk animations
      if (activeWalkZoneAnimId && activeZonePlaybacks && activeBodyPlayback) {
        const setup = walkZoneMeshMap.get(activeWalkZoneAnimId)
        if (setup) {
          // Update zone mesh positions (blend with prev zone playback if fading)
          for (const zp of activeZonePlaybacks) {
            const zm = setup.zoneMeshes.find(z => z.zoneId === zp.zoneId)
            if (!zm) continue
            let pts = zp.playback.getPositions()
            if (fadeActive && prevZonePlaybacks) {
              const prevZp = prevZonePlaybacks.find(z => z.zoneId === zp.zoneId)
              if (prevZp) pts = blendPts(prevZp.playback.getPositions(), pts, fadeT)
            }
            updateZoneMeshVertices(zm, pts, charScale, charOffsetX, charOffsetY)
          }
          // Update body mesh
          let bodyPositions = activeBodyPlayback.getPositions()
          if (fadeActive && prevBodyPlayback) {
            bodyPositions = blendPts(prevBodyPlayback.getPositions(), bodyPositions, fadeT)
          }
          updateZoneMeshVertices(setup.bodyMesh, bodyPositions, charScale, charOffsetX, charOffsetY)
          // Update hidden face meshes (same bodyPoints, same bodyFrames)
          if (setup.hiddenFaceMeshes) {
            for (const hfm of setup.hiddenFaceMeshes) {
              updateZoneMeshVertices(hfm, bodyPositions, charScale, charOffsetX, charOffsetY)
            }
          }
          // Update hidden face limb meshes (same zonePoints, same zoneFrames)
          if (setup.hiddenFaceLimbMeshes) {
            for (const hflm of setup.hiddenFaceLimbMeshes) {
              const zoneId = hflm.zoneId.replace('__hfl_', '')
              const zp = activeZonePlaybacks.find(z => z.zoneId === zoneId)
              if (zp) {
                let pts = zp.playback.getPositions()
                if (fadeActive && prevZonePlaybacks) {
                  const prevZp = prevZonePlaybacks.find(z => z.zoneId === zoneId)
                  if (prevZp) pts = blendPts(prevZp.playback.getPositions(), pts, fadeT)
                }
                updateZoneMeshVertices(hflm, pts, charScale, charOffsetX, charOffsetY)
              }
            }
          }
        }
      }

      // Accessoires : repositionnement frame-à-frame.
      if (propLayer) {
        let anchorsByZone: Record<string, Point2D[]>
        if (activeWalkZoneAnimId && activeBodyPlayback) {
          const bodyPos = activeBodyPlayback.getPositions()
          const zonePos: Record<string, Point2D[]> = {}
          for (const zp of activeZonePlaybacks ?? []) {
            zonePos[zp.zoneId] = zp.playback.getPositions()
          }
          anchorsByZone = getAnchorsByZoneFromCurrent(
            bodyPos, zonePos, propAnchorIndexMap,
            getAnchorsByZone(project.projectTriangulation),
          )
        } else {
          anchorsByZone = getAnchorsByZone(project.projectTriangulation)
        }
        updatePropLayer(propLayer, anchorsByZone, charScale, charOffsetX, charOffsetY)
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

      // Eye blink overlay (positioned in character space)
      // Applique le crossfade aussi aux positions body utilisées par les overlays,
      // sinon yeux/bouche sautent au moment du switch d'animation.
      let bodyPositionsForOverlays: Point2D[] | null = activeBodyPlayback ? activeBodyPlayback.getPositions() : null
      if (bodyPositionsForOverlays && fadeActive && prevBodyPlayback) {
        bodyPositionsForOverlays = blendPts(prevBodyPlayback.getPositions(), bodyPositionsForOverlays, fadeT)
      }
      if (eyeOverlay) {
        eyeOverlay.update(positions, bodyPositionsForOverlays, charScale, charOffsetX, charOffsetY, (delta / 60) * 1000)
      }

      // Mouth overlay : pilote l'ouverture par RMS du speak audio.
      // Si pas d'animation walk/MB active, on déforme la bouche dans le repère
      // body frame 0 (statique) — la mâchoire reste centrée sur le perso au repos.
      if (mouthOverlay) {
        // Si la bouche est rattachée à une zone membre (head, etc.), on prend
        // les positions de cette zone plutôt que celles du body, blendées avec
        // le prev playback pendant le crossfade.
        let bodyForMouth: Point2D[] | null = bodyPositionsForOverlays ?? mouthOverlayBodyFrame0
        if (mouthAttachZoneId !== 'body' && activeZonePlaybacks) {
          const zp = activeZonePlaybacks.find(z => z.zoneId === mouthAttachZoneId)
          if (zp) {
            let pts = zp.playback.getPositions()
            if (fadeActive && prevZonePlaybacks) {
              const prevZp = prevZonePlaybacks.find(z => z.zoneId === mouthAttachZoneId)
              if (prevZp) pts = blendPts(prevZp.playback.getPositions(), pts, fadeT)
            }
            bodyForMouth = pts
          }
        }
        const rms = mouthAudioRef.current ? mouthAudioRef.current.getRMS() : 0
        mouthOpennessRef.current = rms
        mouthOverlay.update(bodyForMouth, charScale, charOffsetX, charOffsetY, rms)
      }

      // Parallax scrolling: each layer scrolls at depthFactor × front speed.
      // The offset is relative to the front layer's scroll, applied directly in screen pixels.
      const frontOffsetPx = scenePlayback.backgroundOffsetX * bgScale
      for (let li = 0; li < 3; li++) {
        const sprite = bgSprites[li]
        if (!sprite) continue
        sprite.x = -frontOffsetPx * scene.backgroundLayers[li].depthFactor
      }

      // Outlines de zones
      outlineOverlay.clear()
      // Clear toutes les Graphics zone des anims non actifs.
      for (const [animId, map] of zoneOutlineByAnim) {
        if (animId !== activeWalkZoneAnimId) {
          for (const g of map.values()) g.clear()
        }
      }
      if (triForOutline && hasZoneOutlineData(triForOutline)) {
        // Body positions avec crossfade pour rester aligné avec le mesh body.
        let bodyPositions: Point2D[] | undefined
        if (activeWalkZoneAnimId && activeBodyPlayback) {
          bodyPositions = activeBodyPlayback.getPositions()
          if (fadeActive && prevBodyPlayback) {
            bodyPositions = blendPts(prevBodyPlayback.getPositions(), bodyPositions, fadeT)
          }
        } else {
          bodyPositions = triForOutline.bodyPoints
        }
        const limbPositions: Record<string, Point2D[]> = {}
        for (const zoneId of Object.keys(triForOutline.zonePoints ?? {})) {
          const zp = (activeWalkZoneAnimId && activeZonePlaybacks) ? activeZonePlaybacks.find(z => z.zoneId === zoneId) : null
          if (zp) {
            let pts = zp.playback.getPositions()
            if (fadeActive && prevZonePlaybacks) {
              const prevZp = prevZonePlaybacks.find(z => z.zoneId === zoneId)
              if (prevZp) pts = blendPts(prevZp.playback.getPositions(), pts, fadeT)
            }
            limbPositions[zoneId] = pts
          } else {
            limbPositions[zoneId] = triForOutline.zonePoints![zoneId]
          }
        }
        const mapPoint = (pt: Point2D) => {
          if (contentAlignment) {
            const { drawBBox, meshBBox } = contentAlignment
            const meshW = meshBBox.maxX - meshBBox.minX
            const meshH = meshBBox.maxY - meshBBox.minY
            const drawW = drawBBox.maxX - drawBBox.minX
            const drawH = drawBBox.maxY - drawBBox.minY
            const nx = meshW > 0 ? (pt.x - meshBBox.minX) / meshW : 0.5
            const ny = meshH > 0 ? (pt.y - meshBBox.minY) / meshH : 0.5
            return {
              x: (nx * drawW + drawBBox.minX) * charScale + charOffsetX,
              y: (ny * drawH + drawBBox.minY) * charScale + charOffsetY,
            }
          }
          return { x: pt.x * charScale + charOffsetX, y: pt.y * charScale + charOffsetY }
        }
        const polylines = computeZoneOutlinePolylines(
          triForOutline,
          { body: bodyPositions, limbs: limbPositions },
          mapPoint,
          mouthHolePolygon
            ? { polygon: mouthHolePolygon, zoneId: project.projectMouth?.attachZoneId ?? 'body' }
            : null,
        )
        const activeZoneOutlineMap = activeWalkZoneAnimId ? zoneOutlineByAnim.get(activeWalkZoneAnimId) : null
        if (activeZoneOutlineMap && activeZoneOutlineMap.size > 0) {
          drawZoneOutlinesPixi(activeZoneOutlineMap, polylines)
        } else {
          // Legacy : pas de setup actif, dessine sur l'overlay global.
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
      }
    })

    function handleResize() {
      if (!containerRef.current) return
      app.renderer.resize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    }
    window.addEventListener('resize', handleResize)

    const getMultiPlayback = () => currentMultiPlaybackRef
    ;(scenePlaybackRef.current as unknown as { getMultiPlayback: typeof getMultiPlayback }).getMultiPlayback = getMultiPlayback
    ;(scenePlaybackRef.current as unknown as { triggerZoneOneshot: typeof triggerZoneOneshot }).triggerZoneOneshot = triggerZoneOneshot

    return () => {
      scenePlaybackRef.current = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', handleResize)
      for (const v of bgVideoElements) { v.pause(); v.src = ''; v.remove() }
      for (const url of bgImageUrls) URL.revokeObjectURL(url)
      for (const audio of animAudioElements.values()) { audio.pause() }
      for (const url of animAudioUrls) URL.revokeObjectURL(url)
      if (sceneAmbientAudio) { sceneAmbientAudio.pause(); try { URL.revokeObjectURL(sceneAmbientAudio.src) } catch { /* */ } }
      if (mouthOverlay) mouthOverlay.destroy()
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

  const handleRandomAnimation = useCallback(async () => {
    const rp = scene.restPoint
    const actions = rp?.actions ?? []
    const playable = actions.filter(a =>
      a.steps.length > 0 &&
      a.steps.every(s => {
        const anim = project.animations.find(x => x.id === s.animationId)
        return anim != null && animationHasFrames(anim)
      })
    )
    if (playable.length === 0) return
    const action = playable[Math.floor(Math.random() * playable.length)]

    // Couper l'audio d'action précédent (sons HTML cumulés + lip-sync mouth)
    for (const a of animSoundAudiosRef.current) {
      a.pause()
      try { URL.revokeObjectURL(a.src) } catch { /* */ }
    }
    animSoundAudiosRef.current = []
    if (mouthAudioRef.current) {
      mouthAudioRef.current.cleanup()
      mouthAudioRef.current = null
      mouthOpennessRef.current = 0
    }

    // Son d'action : lancé immédiatement, route lip-sync si isSpoken (et bouche définie)
    if (action.sound?.blob) {
      const blob = action.sound.blob
      const isSpoken = action.isSpoken === true
      const volume = action.sound.volume ?? 1
      if (isSpoken && project.projectMouth) {
        try {
          const player = await loadMouthAudio(blob, {
            volume,
            onEnded: () => {
              mouthOpennessRef.current = 0
              mouthAudioRef.current?.cleanup()
              mouthAudioRef.current = null
            },
          })
          mouthAudioRef.current = player
          await player.play()
        } catch (err) {
          console.error('[ScenePlayer] spoken action sound failed', err)
        }
      } else {
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.volume = volume
        animSoundAudiosRef.current.push(audio)
        audio.play().catch(() => {})
        audio.onended = () => {
          URL.revokeObjectURL(url)
          animSoundAudiosRef.current = animSoundAudiosRef.current.filter(a => a !== audio)
        }
      }
    }

    // Marque l'action active : chaque oneshot suivant consomme une étape
    activeActionStepsRef.current = action.steps
    actionStepIdxRef.current = 0

    const animIds = action.steps.map(s => s.animationId)
    const sp = scenePlaybackRef.current as unknown as {
      getMultiPlayback?: () => MultiAnimationPlayback | null
      triggerZoneOneshot?: (animId: string) => boolean
    }
    const mp = sp?.getMultiPlayback?.()
    if (mp) mp.requestSequence(animIds)
    else sp?.triggerZoneOneshot?.(animIds[0])
  }, [scene, project.animations, project.projectMouth])

  const handleSpeak = useCallback(async () => {
    const rp = scene.restPoint
    const activeIds = rp?.speakSoundIds ?? []
    if (activeIds.length === 0) return
    const randomId = activeIds[Math.floor(Math.random() * activeIds.length)]
    const idx = scene.speakSounds.findIndex(s => s.id === randomId)
    const blob = idx >= 0 ? scene.speakSoundBlobs[idx] : null
    if (!blob) return

    // Si une bouche est définie, on utilise MouthAudioPlayer (AudioBufferSource +
    // AnalyserNode) pour piloter le lip-sync via RMS. Sinon, fallback HTMLAudio.
    if (project.projectMouth) {
      mouthAudioRef.current?.cleanup()
      mouthAudioRef.current = null
      try {
        const player = await loadMouthAudio(blob, {
          onEnded: () => {
            mouthOpennessRef.current = 0
            mouthAudioRef.current?.cleanup()
            mouthAudioRef.current = null
          },
        })
        mouthAudioRef.current = player
        await player.play()
      } catch (err) {
        console.error('[ScenePlayer] speak audio failed', err)
      }
      return
    }

    if (speakAudioRef.current) {
      speakAudioRef.current.pause()
      URL.revokeObjectURL(speakAudioRef.current.src)
    }
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    speakAudioRef.current = audio
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); speakAudioRef.current = null }
  }, [scene, project.projectMouth])

  const handleHelp = useCallback(() => {
    const rp = scene.restPoint
    const texts = rp?.helpTexts ?? []
    if (texts.length === 0) return
    setCurrentHelpText(texts[Math.floor(Math.random() * texts.length)])
    setShowHelpBubble(true)
  }, [scene.restPoint])

  // Cleanup speak audio on unmount
  useEffect(() => () => {
    if (speakAudioRef.current) {
      speakAudioRef.current.pause()
      URL.revokeObjectURL(speakAudioRef.current.src)
      speakAudioRef.current = null
    }
    mouthAudioRef.current?.cleanup()
    mouthAudioRef.current = null
    for (const audio of animSoundAudiosRef.current) {
      audio.pause()
      try { URL.revokeObjectURL(audio.src) } catch { /* */ }
    }
    animSoundAudiosRef.current = []
  }, [])

  const currentRp = scene.restPoint
  const actionAnimIds = (currentRp?.actions ?? []).flatMap(a => a.steps.map(s => s.animationId))
  const hasRandomAnims = actionAnimIds.some(id => {
    const a = project.animations.find(a => a.id === id)
    return a != null && (a.mesh?.videoFramesMesh != null || (a.mesh?.walkZoneFrames != null && a.mesh?.walkBodyFrames != null))
  })
  const hasSpeakSounds = (currentRp?.speakSoundIds ?? []).length > 0
  const hasHelpTexts = (currentRp?.helpTexts ?? []).length > 0

  const isInteraction = sceneState === 'interaction'

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
