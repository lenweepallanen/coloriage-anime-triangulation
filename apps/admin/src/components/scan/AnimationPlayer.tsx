import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import { animationHasFrames, getIdleAnimation, isLoopAnimation, type Project, type Animation, type Point2D, type WalkLimbSeparation, type ProjectTriangulation } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MultiAnimationPlayback } from '../../utils/multiAnimationPlayback'
import type { OneshotAnimation } from '../../utils/multiAnimationPlayback'
import { DeviceParallax } from '../../utils/deviceParallax'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import { computeZoneOutlinePolylines, drawZoneOutlinesPixi, hasZoneOutlineData } from '../../utils/zoneOutlines'
import { EyeBlinkOverlay, buildEyeAttachMeshes } from '../../utils/eyeBlinkOverlay'
import { inpaintHiddenFaceOnScan, flowExtrudeLimbOnScan } from '../../utils/hiddenFaceTexture'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'

/** Build a pseudo-WalkLimbSeparation from a ProjectTriangulation for zone mesh rendering. */
function buildPseudoSeparation(tri: ProjectTriangulation): WalkLimbSeparation {
  return {
    zones: tri.zones.filter(z => z.id !== 'body').map((z, i) => ({
      id: z.id,
      label: z.label,
      color: z.color,
      bezierNodes: [],
      zOrder: z.zOrder ?? (i + 1),
      legIndex: i,
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
  /** Mode aperçu de validation (play) : cadre sur le personnage, sans plein écran,
   *  sans contrôles, sans parallaxe/son/interactions. Figé à la frame 0 par défaut. */
  previewFrame0?: boolean
  /** Aperçu de validation ANIMÉ : on joue la rest loop au lieu de figer la frame 0
   *  (à combiner avec previewFrame0 pour garder le cadrage/chrome d'aperçu). */
  previewAnimated?: boolean
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
  const restAnim = getIdleAnimation(project.animations)
  // Tout ce qui est prêt et n'est pas l'animation idle est considéré comme oneshot.
  const readyOneshots: Animation[] = project.animations.filter(
    a => a.id !== restAnim?.id && animationHasFrames(a) && !isLoopAnimation(a)
  )
  return { restAnim, readyOneshots }
}

export default function AnimationPlayer({ project, scanCanvas, lamaCanvas, contentAlignment, onClose, previewFrame0, previewAnimated }: Props) {
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
    if (previewFrame0) return // aperçu embarqué : pas de plein écran
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

    // Côté play (body.play-app), canvas transparent → fond doodle de la page visible
    // derrière le perso quand il n'y a pas de fond vidéo opaque.
    const transparentBg = document.body.classList.contains('play-app') && !hasBgVideo
    // Create PIXI application
    const app = new PIXI.Application({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: hasBgVideo ? 0x000000 : 0xFFFFFF,
      backgroundAlpha: transparentBg ? 0 : 1,
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

    if (!previewFrame0 && DeviceParallax.isAvailable) {
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
    let hfCanvasForOutline: HTMLCanvasElement | null = null
    const walkAnim0 = project.animations.find(a => a.type === 'walk' && a.mesh?.walkLimbSeparation?.hiddenFaceZones)
    // Also check project triangulation hidden face zones
    const triHiddenFace = project.projectTriangulation?.step3Validated && project.projectTriangulation.hiddenFaceZones.length > 0
      ? project.projectTriangulation : null
    if (lamaCanvas) {
      hfCanvasForOutline = lamaCanvas
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

    // --- Mesh texture & geometry ---
    // Outlines : tracées en overlay PIXI dans le ticker, pas bakées.
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
    let scale = Math.min(scaleX, scaleY)
    let offsetX = (viewW - scanCanvas.width * scale) / 2
    let offsetY = (viewH - scanCanvas.height * scale) / 2

    // Aperçu de validation : cadrer sur le PERSONNAGE (bbox de sa frame 0), pas sur
    // tout le scan — centré et agrandi pour être bien visible devant l'utilisateur.
    if (previewFrame0) {
      const zoneAnimForBox = project.animations.find(a => a.type === 'walk' && a.mesh?.walkZoneFrames && a.mesh?.walkLimbSeparation)
        ?? project.animations.find(a =>
          (a.type === 'members-bones' || a.type === 'members-bones-v2' || a.type === 'members-bones-v3' || a.type === 'cotracker-bones' || a.type === 'marche')
          && a.mesh?.walkZoneFrames && project.projectTriangulation?.step3Validated)
      const boxPts: Point2D[] = []
      const zbf = zoneAnimForBox?.mesh?.walkBodyFrames
      const zzf = zoneAnimForBox?.mesh?.walkZoneFrames
      if (zbf?.[0]) {
        boxPts.push(...zbf[0])
        if (zzf) for (const id of Object.keys(zzf)) { const f0 = zzf[id]?.[0]; if (f0) boxPts.push(...f0) }
      } else if (hasFlow && mesh.videoFramesMesh![0]) {
        boxPts.push(...mesh.videoFramesMesh![0])
      } else {
        boxPts.push(...allPoints)
      }
      if (boxPts.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const p of boxPts) {
          if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y
          if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y
        }
        const bw = maxX - minX, bh = maxY - minY
        if (bw > 1 && bh > 1) {
          const FILL = 0.82 // fraction de la dimension écran occupée par le perso
          scale = Math.min((viewW * FILL) / bw, (viewH * FILL) / bh)
          offsetX = viewW / 2 - (minX + bw / 2) * scale
          offsetY = viewH / 2 - (minY + bh / 2) * scale
        }
      }
    }

    // Initial vertices — en aperçu, on fige sur la frame 0 trackée (videoFramesMesh[0])
    // si disponible et cohérente, sinon les positions statiques de repos.
    const frame0 = previewFrame0 && hasFlow && mesh.videoFramesMesh![0]?.length === allPoints.length
      ? mesh.videoFramesMesh![0]
      : allPoints
    const vertices = new Float32Array(allPoints.length * 2)
    frame0.forEach((p, i) => {
      vertices[i * 2] = p.x * scale + offsetX
      vertices[i * 2 + 1] = p.y * scale + offsetY
    })

    // --- Check for walk or members-bones animations with zone frames ---
    const walkAnim = project.animations.find(a => a.type === 'walk' && a.mesh?.walkZoneFrames && a.mesh?.walkLimbSeparation)
    // Members-bones animation with project triangulation zone frames
    const mbTriangAnim = !walkAnim ? project.animations.find(a =>
      (a.type === 'members-bones' || a.type === 'members-bones-v2' || a.type === 'members-bones-v3' || a.type === 'cotracker-bones' || a.type === 'marche') && a.mesh?.walkZoneFrames && project.projectTriangulation?.step3Validated
    ) : null
    let zoneMeshSetup: ZoneMeshSetup | null = null
    const zoneOutlineGraphics = new Map<string, PIXI.Graphics>()

    // Build zone separation from walk or project triangulation
    const zoneSep = walkAnim?.mesh?.walkLimbSeparation
      ?? (mbTriangAnim && project.projectTriangulation ? buildPseudoSeparation(project.projectTriangulation) : null)

    if (zoneSep) {
      // Generate per-limb extension textures via texture mirroring (synchronous)
      let hflTextures: Record<string, PIXI.Texture> | undefined
      if (zoneSep.hiddenFaceLimbZones && zoneSep.hiddenFaceLimbZones.length > 0) {
        hflTextures = {}
        const allExtByLimb = new Map<string, Set<number>>()
        for (const hfl of zoneSep.hiddenFaceLimbZones) {
          const set = allExtByLimb.get(hfl.limbZoneId) ?? new Set<number>()
          for (const ti of hfl.zoneTriangleIndices) set.add(ti)
          allExtByLimb.set(hfl.limbZoneId, set)
        }
        for (const hfl of zoneSep.hiddenFaceLimbZones) {
          const zonePts = zoneSep.zonePoints[hfl.limbZoneId]
          const zoneTris = zoneSep.zoneTriangles[hfl.limbZoneId]
          if (!zonePts || !zoneTris) continue
          const hflCanvas = document.createElement('canvas')
          hflCanvas.width = scanCanvas.width
          hflCanvas.height = scanCanvas.height
          hflCanvas.getContext('2d')!.drawImage(scanCanvas, 0, 0)
          flowExtrudeLimbOnScan(
            hflCanvas, hfl, zonePts, zoneTris, scanCanvas.width, scanCanvas.height,
            contentAlignment ?? undefined, allExtByLimb.get(hfl.limbZoneId),
          )
          hflTextures[hfl.id ?? hfl.limbZoneId] = PIXI.Texture.from(hflCanvas)
        }
      }

      zoneMeshSetup = buildZoneMeshes(
        zoneSep, allPoints, mesh.triangles, texture,
        scanCanvas.width, scanCanvas.height, scale, offsetX, offsetY,
        contentAlignment ?? undefined, hfTexture, hflTextures,
      )
      meshContainer.addChild(zoneMeshSetup.container)
      zoneMeshSetup.container.visible = false
      // Outlines interleavés par z-order : une Graphics par zone dans le
      // container du setup (sortableChildren déjà true).
      if (project.projectTriangulation && hasZoneOutlineData(project.projectTriangulation)) {
        for (const zone of project.projectTriangulation.zones ?? []) {
          const g = new PIXI.Graphics()
          g.zIndex = (zone.zOrder ?? 0) + 0.9
          zoneMeshSetup.container.addChild(g)
          zoneOutlineGraphics.set(zone.id, g)
        }
      }
    }

    // Main mesh (used for rest + non-walk animations)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
    const material = new PIXI.MeshMaterial(texture)
    const pixiMesh = new PIXI.Mesh(geometry, material)
    meshContainer.addChild(pixiMesh)

    // --- Eye blink overlay (project-level, optional) ---
    let eyeOverlay: EyeBlinkOverlay | null = null
    app.stage.sortableChildren = true
    if (project.projectEyes && project.projectEyes.regions.length > 0) {
      eyeOverlay = new EyeBlinkOverlay(
        project.projectEyes,
        app.stage,
        mesh.trackedTriangles.length > 0 ? mesh.trackedTriangles : null,
        {
          nContourAnchors: mesh.contourAnchors.length,
          nContourSubdivision: mesh.contourSubdivisionPoints.length,
          nAnchorPoints: mesh.anchorPoints.length,
        },
        buildEyeAttachMeshes(project),
      )
    }

    // --- Background video parallax base position (updated on loadedmetadata) ---
    const bgBase = { x: bgSprite ? bgSprite.x : 0, y: bgSprite ? bgSprite.y : 0 }
    if (bgVideoEl) {
      bgVideoEl.addEventListener('loadedmetadata', () => {
        bgBase.x = bgSprite!.x
        bgBase.y = bgSprite!.y
      }, { once: true })
    }

    // --- Aperçu de validation : rendu statique frame 0 (pas de lecture ni ticker) ---
    // Positionne explicitement le bon maillage sur sa frame 0 : meshes de zones pour
    // les projets autonomes (members-bones/walk/marche), sinon le mesh unique legacy
    // (déjà positionné via les vertices initiaux). Le ticker auto de PIXI rend une fois.
    // On positionne TOUJOURS la frame 0 (perso visible immédiatement). En aperçu ANIMÉ
    // zone-based, le ticker dédié plus bas prend ensuite le relais.
    if (previewFrame0) {
      const zoneAnimP = walkAnim ?? mbTriangAnim
      const wbf = zoneAnimP?.mesh?.walkBodyFrames
      const wzf = zoneAnimP?.mesh?.walkZoneFrames
      if (zoneMeshSetup && wbf && wbf.length > 0) {
        pixiMesh.visible = false
        zoneMeshSetup.container.visible = true
        const body0 = wbf[0]
        for (const zm of zoneMeshSetup.zoneMeshes) {
          const f0 = wzf?.[zm.zoneId]?.[0]
          if (f0) updateZoneMeshVertices(zm, f0, scale, offsetX, offsetY)
        }
        if (body0) updateZoneMeshVertices(zoneMeshSetup.bodyMesh, body0, scale, offsetX, offsetY)
        if (body0) for (const hfm of zoneMeshSetup.hiddenFaceMeshes) updateZoneMeshVertices(hfm, body0, scale, offsetX, offsetY)
        for (const hflm of zoneMeshSetup.hiddenFaceLimbMeshes) {
          const f0 = wzf?.[hflm.zoneId]?.[0]
          if (f0) updateZoneMeshVertices(hflm, f0, scale, offsetX, offsetY)
        }
      }
    }

    // --- Aperçu ANIMÉ zone-based (rest sans videoFramesMesh) : boucle des frames de
    // zone (walkBodyFrames/walkZoneFrames) sur les meshes de zone, en rest loop. ---
    if (previewAnimated && !hasFlow && zoneMeshSetup) {
      const zAnim = walkAnim ?? mbTriangAnim
      const wbf = zAnim?.mesh?.walkBodyFrames
      const wzf = zAnim?.mesh?.walkZoneFrames
      if (wbf && wbf.length > 0) {
        pixiMesh.visible = false
        zoneMeshSetup.container.visible = true
        const total = wbf.length
        // Curseur à 24 FPS (= même vitesse que la rest loop), MAIS interpolation
        // sous-frame entre f0 et f1 comme LoopPlayback → rendu fluide au refresh
        // écran (60/120 Hz) au lieu de sauter en frames entières (saccade).
        const FPS = 24
        let cursor = 0
        const lerpFrame = (a: Point2D[], b: Point2D[] | undefined, t: number): Point2D[] =>
          (b && b.length === a.length)
            ? a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t }))
            : a
        app.ticker.add((delta) => {
          if (!playing) return
          cursor = (cursor + FPS * (delta / 60)) % total
          const f0 = Math.floor(cursor)
          const f1 = (f0 + 1) % total
          const t = cursor - f0
          const body = lerpFrame(wbf[f0], wbf[f1], t)
          for (const zm of zoneMeshSetup!.zoneMeshes) {
            const z0 = wzf?.[zm.zoneId]?.[f0]
            if (z0) updateZoneMeshVertices(zm, lerpFrame(z0, wzf?.[zm.zoneId]?.[f1], t), scale, offsetX, offsetY)
          }
          updateZoneMeshVertices(zoneMeshSetup!.bodyMesh, body, scale, offsetX, offsetY)
          for (const hfm of zoneMeshSetup!.hiddenFaceMeshes) updateZoneMeshVertices(hfm, body, scale, offsetX, offsetY)
          for (const hflm of zoneMeshSetup!.hiddenFaceLimbMeshes) {
            const z0 = wzf?.[hflm.zoneId]?.[f0]
            if (z0) updateZoneMeshVertices(hflm, lerpFrame(z0, wzf?.[hflm.zoneId]?.[f1], t), scale, offsetX, offsetY)
          }
        })
      }
    }

    // --- Audio elements (oneshot + physics only, not rest) ---
    const audioElements = new Map<string, HTMLAudioElement>()
    const audioUrls: string[] = []
    for (const anim of project.animations) {
      if (!previewFrame0 && anim.id !== restAnim?.id && anim.audioBlob && anim.audioEnabled) {
        const url = URL.createObjectURL(anim.audioBlob)
        audioUrls.push(url)
        const audio = new Audio(url)
        audioElements.set(anim.id, audio)
      }
    }

    // --- Ambient sound (project-level, looped continuously) ---
    let ambientAudio: HTMLAudioElement | null = null
    let ambientAudioUrl: string | null = null
    if (!previewFrame0 && project.ambientSoundBlob && project.ambientSoundEnabled) {
      ambientAudioUrl = URL.createObjectURL(project.ambientSoundBlob)
      ambientAudio = new Audio(ambientAudioUrl)
      ambientAudio.loop = true
      ambientAudio.play().catch(() => {})
      ambientAudioRef.current = ambientAudio
    }

    // --- Animation loop ---
    // En aperçu de validation FIGÉ, on ne crée aucune lecture ni ticker (mesh figé
    // sur la frame 0). En aperçu ANIMÉ, on joue la rest loop comme en lecture normale.
    if (hasFlow && (!previewFrame0 || previewAnimated)) {
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

      // Walk/MB zone mesh frame counter (for z-ordered multi-mesh during walk/MB oneshot)
      const zoneAnim = walkAnim ?? mbTriangAnim  // animation that owns the zone frames
      let walkFrameCounter = 0
      const walkZoneFrames = zoneAnim?.mesh?.walkZoneFrames
      const walkBodyFrames = zoneAnim?.mesh?.walkBodyFrames
      const walkTotalFrames = walkBodyFrames?.length ?? 0

      // Debug: verify body data consistency
      if (zoneSep) {
        console.log('[Zone HF debug]', {
          bodyPointsCount: zoneSep.bodyPoints?.length ?? 0,
          bodyFrameF0Count: walkBodyFrames?.[0]?.length ?? 0,
          hfZones: zoneSep.hiddenFaceZones?.map(z => ({
            id: z.limbZoneId,
            triIndices: z.bodyTriangleIndices,
            maxVertIdx: Math.max(...z.bodyTriangleIndices.flatMap(ti => zoneSep.bodyTriangles?.[ti] ?? [])),
          })),
          hfMeshes: zoneMeshSetup?.hiddenFaceMeshes?.map(m => ({ id: m.zoneId, numVerts: m.numVertices })),
          bodyMeshVerts: zoneMeshSetup?.bodyMesh?.numVertices,
        })
      }

      const outlineOverlay = new PIXI.Graphics()
      app.stage.addChild(outlineOverlay)
      const triForOutline = project.projectTriangulation

      app.ticker.add((delta) => {
        if (playing) advancePlayback(delta)

        const positions = getPositions()

        // Check if we should use zone mesh rendering (walk animation active with separation)
        const activeOneshotId = hasOneshots ? (multiPlaybackRef.current as MultiAnimationPlayback)?.activeOneshotName : null
        const isWalkZonePlaying = activeOneshotId && zoneAnim && walkZoneFrames && walkBodyFrames && zoneMeshSetup
          && activeOneshotId === zoneAnim.name

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
          // Update hidden face limb meshes (same zoneFrames, same zonePoints)
          if (zoneMeshSetup.hiddenFaceLimbMeshes) {
            for (const hflm of zoneMeshSetup.hiddenFaceLimbMeshes) {
              const zoneId = hflm.zoneId
              const zoneFrame = walkZoneFrames[zoneId]?.[walkFrameCounter]
              if (zoneFrame) {
                updateZoneMeshVertices(hflm, zoneFrame, scale, offsetX, offsetY)
              }
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

        // Eye blink overlay
        if (eyeOverlay) {
          // Pendant une animation de zone (walk/cotracker) : déformer l'œil par le
          // maillage body/zone. Sinon (rest loop) : laisser le chemin "tracked" via
          // `positions` (byZone = null).
          let byZone: Record<string, Point2D[]> | null = null
          if (isWalkZonePlaying && walkBodyFrames) {
            byZone = { body: walkBodyFrames[walkFrameCounter] ?? walkBodyFrames[0] }
            if (walkZoneFrames) {
              for (const zid of Object.keys(walkZoneFrames)) {
                const f = walkZoneFrames[zid]?.[walkFrameCounter] ?? walkZoneFrames[zid]?.[0]
                if (f) byZone[zid] = f
              }
            }
          }
          // Offset pupille : seulement pendant la lecture de l'animation cotracker
          // qui possède les frames pré-calculées. Sinon pupille centrée.
          let pupilOffsets: Record<string, Point2D> | null = null
          const eyePupilFrames = zoneAnim?.mesh?.cotrackerEyePupilFrames
          if (isWalkZonePlaying && eyePupilFrames) {
            pupilOffsets = {}
            for (const eyeId of Object.keys(eyePupilFrames)) {
              const frames = eyePupilFrames[eyeId]
              if (frames && frames.length > 0) {
                pupilOffsets[eyeId] = frames[Math.min(walkFrameCounter, frames.length - 1)]
              }
            }
          }
          eyeOverlay.update(positions, byZone, scale, offsetX, offsetY, (delta / 60) * 1000, pupilOffsets)
        }

        // Parallax on background
        if (bgSprite) {
          const p = parallax.getOffset()
          bgSprite.x = bgBase.x + p.offsetX * visualRef.current.parallaxRangeX
          bgSprite.y = bgBase.y + p.offsetY * visualRef.current.parallaxRangeY
        }

        // Outlines de zones
        outlineOverlay.clear()
        if (triForOutline && hasZoneOutlineData(triForOutline)) {
          const bodyPositions = isWalkZonePlaying && walkBodyFrames
            ? walkBodyFrames[walkFrameCounter] ?? triForOutline.bodyPoints
            : triForOutline.bodyPoints
          const limbPositions: Record<string, typeof triForOutline.bodyPoints> = {}
          for (const zoneId of Object.keys(triForOutline.zonePoints ?? {})) {
            const wf = isWalkZonePlaying && walkZoneFrames ? walkZoneFrames[zoneId]?.[walkFrameCounter] : null
            limbPositions[zoneId] = wf ?? triForOutline.zonePoints![zoneId]
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
                x: (nx * drawW + drawBBox.minX) * scale + offsetX,
                y: (ny * drawH + drawBBox.minY) * scale + offsetY,
              }
            }
            return { x: pt.x * scale + offsetX, y: pt.y * scale + offsetY }
          }
          const polylines = computeZoneOutlinePolylines(
            triForOutline,
            { body: bodyPositions, limbs: limbPositions },
            mapPoint,
          )
          // Cas walk/MB actif : per-zone Graphics interleavées (z-order respecté).
          // Cas legacy : overlay global au-dessus du single mesh.
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
          // Si on bascule depuis walk/MB vers legacy ou inverse, on clear l'autre.
          if (isWalkZonePlaying) outlineOverlay.clear()
          else { for (const g of zoneOutlineGraphics.values()) g.clear(); for (const m of zoneOutlineMasks.values()) m.clear() }
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
    <div className={`animation-player${previewFrame0 ? ' animation-player--preview' : ''}`} ref={playerRef}>
      <div ref={containerRef} className="animation-canvas" />

      {/* Floating close button (long-press 3s) */}
      {!previewFrame0 && <LongPressCloseButton onComplete={handleExitFullscreen} />}

      {/* Oneshot animation trigger buttons */}
      {!previewFrame0 && readyOneshots.length > 0 && (
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
                className="oneshot-btn"
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
      {!previewFrame0 && (
      <button
        className="fullscreen-settings-btn"
        onClick={() => setSidebarOpen(o => !o)}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      )}

      {/* Retractable sidebar overlay */}
      {!previewFrame0 && sidebarOpen && (
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
