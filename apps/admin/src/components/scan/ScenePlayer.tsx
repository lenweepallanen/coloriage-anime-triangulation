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
import { computeZoneOutlinePolylines, drawZoneOutlinesPixi, hasZoneOutlineData } from '../../utils/zoneOutlines'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'
import { inpaintHiddenFaceOnScan, flowExtrudeLimbOnScan, imageToScanPixel } from '../../utils/hiddenFaceTexture'
import { EyeBlinkOverlay, buildEyeAttachMeshes, getMouthAttachMesh } from '../../utils/eyeBlinkOverlay'
import { MouthOverlay, computeMouthPolygonFrame0 } from '../../utils/mouthOverlay'
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
  // Bouton actif (animation/son en cours). Tous les autres boutons sont désactivés.
  const [activeBtn, setActiveBtn] = useState<string | null>(null)
  const [btnProgress, setBtnProgress] = useState(0)
  const btnRafRef = useRef<number | null>(null)
  const startBtnTimer = useCallback((id: string, durationMs: number) => {
    if (btnRafRef.current) cancelAnimationFrame(btnRafRef.current)
    if (durationMs <= 0) { setActiveBtn(null); setBtnProgress(0); return }
    setActiveBtn(id)
    setBtnProgress(0)
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / durationMs)
      setBtnProgress(t)
      if (t >= 1) { setActiveBtn(null); btnRafRef.current = null; return }
      btnRafRef.current = requestAnimationFrame(tick)
    }
    btnRafRef.current = requestAnimationFrame(tick)
  }, [])
  useEffect(() => () => { if (btnRafRef.current) cancelAnimationFrame(btnRafRef.current) }, [])
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

  // Dimensions natives de l'image du coloriage = espace de coordonnées du maillage.
  // Sert de référence pour le scaling/position du perso, invariant au scanCanvas
  // (image en admin, 2048×2048 en play) et au contentAlignment.
  const [imgRefDims, setImgRefDims] = useState<{ w: number; h: number } | null>(null)
  const [imgRefReady, setImgRefReady] = useState(false)
  useEffect(() => {
    if (!project.originalImageBlob) { setImgRefDims(null); setImgRefReady(true); return }
    let cancelled = false
    setImgRefReady(false)
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => { if (!cancelled) { setImgRefDims({ w: img.naturalWidth, h: img.naturalHeight }); setImgRefReady(true) }; URL.revokeObjectURL(url) }
    img.onerror = () => { if (!cancelled) setImgRefReady(true); URL.revokeObjectURL(url) } // fallback scanCanvas dims
    img.src = url
    return () => { cancelled = true }
  }, [project.originalImageBlob])

  const scene = project.scene!

  // Carte scène (mode play/scan, hors modal) : on dimensionne le canvas EXACTEMENT au
  // format du fond → scène centrée, coins arrondis, et marge gauche libre pour les boutons.
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const bgAspectW = scene.background?.width
  const bgAspectH = scene.background?.height
  useEffect(() => {
    if (modal) return
    const SIDEBAR = 96 // espace réservé à gauche pour les boutons 1/2/3
    const PAD = 14
    function compute() {
      const vw = window.innerWidth, vh = window.innerHeight
      const aspect = bgAspectW && bgAspectH ? bgAspectW / bgAspectH : 16 / 9
      const availW = Math.max(160, vw - SIDEBAR - PAD * 2)
      const availH = Math.max(120, vh - PAD * 2)
      let h = availH, w = h * aspect
      if (w > availW) { w = availW; h = w / aspect }
      setCardSize({ w: Math.round(w), h: Math.round(h) })
    }
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [modal, bgAspectW, bgAspectH])
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
    // Attendre la résolution des dimensions de l'image (référence de scaling perso)
    // AVANT de construire : évite un teardown/rebuild de toute la scène (flash + retour
    // scan) quand elles arrivent. `imgRefReady` passe true au chargement OU à l'échec.
    if (!imgRefReady) return
    // Hors modal : attendre que la taille de la carte soit calculée (le canvas est
    // dimensionné au format du fond, pas au viewport entier).
    if (!modal && cardSize.w === 0) return

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
    const foregroundContainer = new PIXI.Container()
    // Ordre z : arrière-plan → personnage (+ overlays) → avant-plan → HUD (DOM).
    app.stage.addChild(bgContainer)
    app.stage.addChild(characterContainer)
    app.stage.addChild(foregroundContainer)

    const bg = scene.background
    const fg = scene.foreground
    const bgScale = (bg && (bg.imageBlob || bg.videoBlob) && bg.height > 0)
      ? viewH / bg.height
      : 1

    let backgroundSprite: PIXI.Sprite | null = null
    let foregroundSprite: PIXI.Sprite | null = null
    const bgImageUrls: string[] = []
    const bgVideoElements: HTMLVideoElement[] = []

    if (bg?.videoBlob) {
      const url = URL.createObjectURL(bg.videoBlob)
      bgImageUrls.push(url)
      const vid = document.createElement('video')
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
      vid.style.position = 'absolute'
      vid.style.width = '1px'
      vid.style.height = '1px'
      vid.style.opacity = '0'
      vid.style.pointerEvents = 'none'
      document.body.appendChild(vid)
      bgVideoElements.push(vid)
      const tryPlay = () => vid.play().catch(() => {})
      tryPlay()
      const onGesture = () => {
        tryPlay()
        document.removeEventListener('pointerdown', onGesture, true)
        document.removeEventListener('touchstart', onGesture, true)
        document.removeEventListener('click', onGesture, true)
      }
      document.addEventListener('pointerdown', onGesture, { passive: true, capture: true })
      document.addEventListener('touchstart', onGesture, { passive: true, capture: true })
      document.addEventListener('click', onGesture, { passive: true, capture: true })
      const tex = PIXI.Texture.from(vid, { resourceOptions: { autoPlay: true } })
      // iOS : la texture est créée avant que la vidéo ait des frames (→ 0×0 noir).
      // On force un ré-upload dès que des frames arrivent / la lecture démarre.
      vid.addEventListener('loadeddata', () => tex.update())
      vid.addEventListener('playing', () => tex.update())
      const sprite = new PIXI.Sprite(tex)
      sprite.width = bg.width * bgScale
      sprite.height = viewH
      bgContainer.addChild(sprite)
      backgroundSprite = sprite
    } else if (bg?.imageBlob) {
      const url = URL.createObjectURL(bg.imageBlob)
      bgImageUrls.push(url)
      const img = new Image()
      img.src = url
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d')!.drawImage(img, 0, 0)
        const tex = PIXI.Texture.from(canvas)
        const sprite = new PIXI.Sprite(tex)
        sprite.width = bg.width * bgScale
        sprite.height = viewH
        bgContainer.addChild(sprite)
        backgroundSprite = sprite
      }
    }

    // Filtre chroma key partagé image/vidéo :
    //  - smoothstep entre threshold et threshold+smoothness → bord progressif
    //  - érosion 1 pixel (min des 4 voisins) → tire le bord vers l'intérieur, supprime l'aliasing
    //  - despill (unmultiply puis remultiply) → enlève la teinte clé résiduelle dans la bande de transition,
    //    élimine le liseré sombre quand la clé est noire
    const buildChromaKeyFilter = (hex: string, threshold: number, smoothness: number): PIXI.Filter => {
      const r = parseInt(hex.slice(1, 3), 16) / 255
      const g = parseInt(hex.slice(3, 5), 16) / 255
      const b = parseInt(hex.slice(5, 7), 16) / 255
      const fragment = `
        precision mediump float;
        varying vec2 vTextureCoord;
        uniform sampler2D uSampler;
        uniform vec3 uKey;
        uniform float uThreshold;
        uniform float uSmoothness;
        void main(void) {
          vec4 c = texture2D(uSampler, vTextureCoord);
          float d = distance(c.rgb, uKey);
          float a = smoothstep(uThreshold, uThreshold + max(uSmoothness, 0.001), d);
          gl_FragColor = vec4(c.rgb * a, c.a * a);
        }
      `
      return new PIXI.Filter(undefined, fragment, {
        uKey: [r, g, b],
        uThreshold: threshold,
        uSmoothness: smoothness,
      })
    }

    if (fg?.videoBlob) {
      const url = URL.createObjectURL(fg.videoBlob)
      bgImageUrls.push(url)
      const vid = document.createElement('video')
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
      vid.style.position = 'absolute'
      vid.style.width = '1px'
      vid.style.height = '1px'
      vid.style.opacity = '0'
      vid.style.pointerEvents = 'none'
      document.body.appendChild(vid)
      bgVideoElements.push(vid)
      const tryPlay = () => vid.play().catch(() => {})
      tryPlay()
      const onGesture = () => {
        tryPlay()
        document.removeEventListener('pointerdown', onGesture, true)
        document.removeEventListener('touchstart', onGesture, true)
        document.removeEventListener('click', onGesture, true)
      }
      document.addEventListener('pointerdown', onGesture, { passive: true, capture: true })
      document.addEventListener('touchstart', onGesture, { passive: true, capture: true })
      document.addEventListener('click', onGesture, { passive: true, capture: true })
      const tex = PIXI.Texture.from(vid, { resourceOptions: { autoPlay: true } })
      vid.addEventListener('loadeddata', () => tex.update())
      vid.addEventListener('playing', () => tex.update())
      const sprite = new PIXI.Sprite(tex)
      sprite.width = fg.width * bgScale
      sprite.height = fg.height * bgScale
      if (fg.chromaKeyColor) {
        sprite.filters = [buildChromaKeyFilter(fg.chromaKeyColor, fg.chromaKeyThreshold ?? 0.1, fg.chromaKeySmoothness ?? 0.12)]
      }
      foregroundContainer.addChild(sprite)
      foregroundSprite = sprite
    } else if (fg?.imageBlob) {
      const url = URL.createObjectURL(fg.imageBlob)
      bgImageUrls.push(url)
      const img = new Image()
      img.src = url
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d')!.drawImage(img, 0, 0)
        const tex = PIXI.Texture.from(canvas)
        const sprite = new PIXI.Sprite(tex)
        sprite.width = fg.width * bgScale
        sprite.height = fg.height * bgScale
        if (fg.chromaKeyColor) {
          sprite.filters = [buildChromaKeyFilter(fg.chromaKeyColor, fg.chromaKeyThreshold ?? 0.1, fg.chromaKeySmoothness ?? 0.12)]
        }
        foregroundContainer.addChild(sprite)
        foregroundSprite = sprite
      }
    }

    // Référence de scaling = dimensions de l'IMAGE du coloriage (espace des coords du
    // maillage), pas le scanCanvas (2048 en play). En admin scanCanvas == image → identique.
    const refW = imgRefDims?.w ?? scanCanvas.width
    const refH = imgRefDims?.h ?? scanCanvas.height
    const charFitScale = viewH / refH
    const baseCharScale = charFitScale * scene.characterScale
    // charScale, charW, charH, charOffsetY peuvent varier par frame (marche libre :
    // perspective scale + déplacement vertical sur le trapèze).
    let charScale = baseCharScale
    let charW = refW * charScale
    let charH = refH * charScale
    const baseCharOffsetY = (viewH - charH) / 2 + scene.characterY * bgScale
    let charOffsetY = baseCharOffsetY
    // Origine du personnage (U,V) ∈ [0,1] dans l'image du coloriage. Le clic en marche
    // libre vise ce point ; pivot des transforms (rotation/skew/flip) = ce point.
    const originU = scene.characterOriginU ?? 0.5
    const originV = scene.characterOriginV ?? 1.0
    /** Y de l'origine au rest, en coords background front (utilisé comme initial currentY). */
    const baselineOriginBgY = (baseCharOffsetY + originV * refH * baseCharScale) / bgScale

    // Character X offset: computed dynamically each frame from scenePlayback.currentX.
    // L'origine du personnage (U×W) doit se trouver à (currentX - bgOffset) * bgScale en X.
    // → charOffsetX = (currentX - bgOffset)*bgScale - originU * charW
    function computeCharOffsetX(sp: ScenePlayback): number {
      return sp.currentX * bgScale - sp.backgroundOffsetX * bgScale - originU * charW
    }
    // Initial value — will be updated once scenePlayback is created
    let charOffsetX = (viewW - charW) / 2 - (originU - 0.5) * charW

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

    // --- Mouth polygon (frame 0, image coords) ---
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

    // Approche 2 textures : tête-sans-mâchoire (alpha effacée dans le polygone)
    // + mâchoire-seule (alpha gardée seulement dans le polygone). Plus de trou
    // dans la géométrie : les bords s'alignent au pixel près par construction.
    let bodyTexCanvas: HTMLCanvasElement = scanCanvas
    let jawTexCanvas: HTMLCanvasElement | null = null
    if (mouthHolePolygon && mouthHolePolygon.length >= 3) {
      const scanW = scanCanvas.width
      const scanH = scanCanvas.height
      const scanPoly = mouthHolePolygon.map(p =>
        imageToScanPixel(p, scanW, scanH, scanW, scanH, contentAlignment ?? undefined)
      )
      const tracePath = (ctx: CanvasRenderingContext2D) => {
        ctx.beginPath()
        ctx.moveTo(scanPoly[0].x, scanPoly[0].y)
        for (let i = 1; i < scanPoly.length; i++) ctx.lineTo(scanPoly[i].x, scanPoly[i].y)
        ctx.closePath()
      }
      // Tête : copie + efface l'intérieur du polygone
      const headCanvas = document.createElement('canvas')
      headCanvas.width = scanW
      headCanvas.height = scanH
      const hctx = headCanvas.getContext('2d')!
      hctx.drawImage(scanCanvas, 0, 0)
      hctx.globalCompositeOperation = 'destination-out'
      tracePath(hctx)
      hctx.fill()
      hctx.globalCompositeOperation = 'source-over'
      bodyTexCanvas = headCanvas
      // Mâchoire : copie + garde uniquement l'intérieur du polygone
      const jawCanvas = document.createElement('canvas')
      jawCanvas.width = scanW
      jawCanvas.height = scanH
      const jctx = jawCanvas.getContext('2d')!
      jctx.drawImage(scanCanvas, 0, 0)
      jctx.globalCompositeOperation = 'destination-in'
      tracePath(jctx)
      jctx.fill()
      jctx.globalCompositeOperation = 'source-over'
      jawTexCanvas = jawCanvas
    }

    // Outlines : tracées en overlay PIXI dans le ticker, pas bakées.
    const texture = PIXI.Texture.from(bodyTexCanvas)
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height, contentAlignment ?? undefined)

    const legacyTriangles = mesh.triangles
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
          jawTexCanvas ? PIXI.Texture.from(jawTexCanvas) : texture,
          scanCanvas.width,
          scanCanvas.height,
          contentAlignment ?? undefined,
        )
      }
    }

    // --- Eye blink overlay (project-level, optional) ---
    let eyeOverlay: EyeBlinkOverlay | null = null
    if (project.projectEyes && project.projectEyes.regions.length > 0) {
      eyeOverlay = new EyeBlinkOverlay(
        project.projectEyes,
        characterContainer,
        mesh.trackedTriangles.length > 0 ? mesh.trackedTriangles : null,
        {
          nContourAnchors: mesh.contourAnchors.length,
          nContourSubdivision: mesh.contourSubdivisionPoints.length,
          nAnchorPoints: mesh.anchorPoints.length,
        },
        buildEyeAttachMeshes(project),
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
        // Union des extension-tris par limbZoneId : exclut TOUTES les HFL du membre de la
        // partie "visible" qu'on extrude, pour qu'une HFL voisine ne pollue pas l'échantillon.
        const allExtByLimb = new Map<string, Set<number>>()
        for (const hfl of sep.hiddenFaceLimbZones) {
          const set = allExtByLimb.get(hfl.limbZoneId) ?? new Set<number>()
          for (const ti of hfl.zoneTriangleIndices) set.add(ti)
          allExtByLimb.set(hfl.limbZoneId, set)
        }
        for (const hfl of sep.hiddenFaceLimbZones) {
          const zonePts = sep.zonePoints[hfl.limbZoneId]
          const zoneTris = sep.zoneTriangles[hfl.limbZoneId]
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

      const setup = buildZoneMeshes(
        sep, allPoints, mesh.triangles, texture,
        scanCanvas.width, scanCanvas.height, charScale, 0, 0,
        contentAlignment ?? undefined, hfTexture, hflTextures,
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
      initialFeetBgY: baselineOriginBgY,
      // Largeur du personnage à scale=1 (sans perspective) en coords background.
      characterBaseWidthBg: (refW * baseCharScale) / bgScale,
      characterOriginU: originU,
    })
    scenePlaybackRef.current = scenePlayback

    // Now that scenePlayback exists, compute the correct initial charOffsetX
    charOffsetX = computeCharOffsetX(scenePlayback)

    // [DEBUG] Diagnostic caméra/fond — à retirer une fois le placement validé.
    setTimeout(() => {
      const vid = bgVideoElements[0]
      // eslint-disable-next-line no-console
      console.log('[ScenePlayer DEBUG]', {
        viewW, viewH, bgScale,
        bgW: bg?.width, bgH: bg?.height,
        hasBgVideo: !!bg?.videoBlob, hasBgImage: !!bg?.imageBlob,
        bgSprite: backgroundSprite
          ? { x: Math.round(backgroundSprite.x), y: Math.round(backgroundSprite.y), w: Math.round(backgroundSprite.width), h: Math.round(backgroundSprite.height), visible: backgroundSprite.visible }
          : 'NULL (pas de sprite fond créé)',
        bgOffsetX: Math.round(scenePlayback.backgroundOffsetX),
        currentX: Math.round(scenePlayback.currentX),
        charOffsetX: Math.round(charOffsetX), charScale: charScale.toFixed(3),
        charW: Math.round(charW), charH: Math.round(charH), refW, refH,
        video: vid ? { paused: vid.paused, readyState: vid.readyState, vw: vid.videoWidth, vh: vid.videoHeight } : 'pas de <video> fond',
      })
    }, 1800)

    // --- Animation switching ---
    let currentGetPositions: () => Point2D[] = () => allPoints
    let currentAdvance: (delta: number) => void = () => {}

    let crossfadeProgress = 1   // 1 = no fade in progress
    let crossfadeDuration = 400 / 1000   // seconds
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
        currentRestPlayback = playback
      }
    }

    let currentMultiPlaybackRef: MultiAnimationPlayback | null = null
    let currentRestPlayback: LoopPlayback | null = null
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

      if (newState === 'entering' || newState === 'walking') {
        setupMovementAnimation(scenePlayback.currentSegmentAnimationId)
        // Démarrage du cycle de marche à la frame "pas naturel" choisie par l'admin.
        if (newState === 'walking' && scene.walkTrapezoid) {
          const startFrame = scene.walkTrapezoid.walkStartFrame ?? 0
          if (startFrame > 0) {
            if (activeBodyPlayback && 'seekFrame' in activeBodyPlayback) {
              (activeBodyPlayback as LoopPlayback).seekFrame(startFrame)
            }
            if (activeZonePlaybacks) {
              for (const zp of activeZonePlaybacks) {
                if ('seekFrame' in zp.playback) (zp.playback as LoopPlayback).seekFrame(startFrame)
              }
            }
          }
        }
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

      beginCrossfade(400, false)
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
      beginCrossfade(400, false)
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

    // --- Pointer interactions (zones tactiles + clic pour marche libre) ---
    const onPointerDown = (e: PointerEvent) => {
      // Marche en cours : on ignore complètement les clics jusqu'à l'arrivée.
      if (scenePlayback.currentState === 'walking') return
      if (scenePlayback.currentState !== 'interaction') return

      // Tente d'abord un hit sur une zone corporelle (oneshot via mapping)
      const img = screenToImage(e.offsetX, e.offsetY)
      const zoneId = detectTouchedZone(
        { x: img.x, y: img.y },
        latestPositions,
        mesh.triangles,
        triangleZoneMap,
      )
      if (zoneId) {
        const rp = scenePlayback.currentRestPoint
        const mapping = rp?.zoneAnimationMappings?.find(m => m.zoneId === zoneId)
        if (mapping) {
          if (currentMultiPlaybackRef) {
            currentMultiPlaybackRef.requestOneshot(mapping.animationId)
          } else {
            triggerZoneOneshot(mapping.animationId)
          }
          return
        }
      }

      // Pas de zone touchée : tente une marche libre si la scène a un trapèze
      if (scene.walkTrapezoid) {
        const bgX = e.offsetX / bgScale + scenePlayback.backgroundOffsetX
        const bgY = e.offsetY / bgScale
        scenePlayback.requestWalkTo(bgX, bgY)
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
        const segCrossfade = 400

        // State change OR segment→segment animation change within the same transition
        const stateChanged = newState !== prevSceneState
        const segmentBoundary = newState === 'segment'
          && prevSceneState === 'entering'
          && newSegAnimId !== lastSegmentAnimId

        if (stateChanged || segmentBoundary) {
          // Choose crossfade duration: outgoing segment if we're leaving one,
          // otherwise incoming segment, otherwise default 400ms.
          let durationMs: number
          if (prevSceneState === 'entering' && (newState === 'interaction' || newState === 'blend')) {
            // Segment → rest point : priorité au fondu d'arrivée propre au rest point
            const arrivalMs = scenePlayback.currentRestPoint?.arrivalCrossfadeMs
            durationMs = arrivalMs ?? lastSegmentCrossfadeMs ?? 400
          } else if (prevSceneState === 'entering' && lastSegmentCrossfadeMs != null) {
            durationMs = lastSegmentCrossfadeMs
          } else if (newState === 'segment') {
            durationMs = segCrossfade
          } else if (newState === 'walking') {
            // Transition courte vers la marche : on évite de blender le rest pose avec
            // les premières frames du cycle, ce qui rend le départ du pas naturel.
            durationMs = 120
          } else {
            durationMs = 400
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

      // Update character X/Y/scale based on current scene position (perspective during walk).
      // Si un trapèze de marche est défini, le personnage est positionné via currentX/Y
      // (snappé dans le trap dès l'init) — la perspective s'applique aussi au repos.
      // Sinon, layout standard (centré vertical + characterY).
      const walkScaleMul = scenePlayback.walkScaleMul
      charScale = baseCharScale * walkScaleMul
      charW = refW * charScale
      charH = refH * charScale
      if (scene.walkTrapezoid) {
        // currentY = position bg de l'ORIGINE → charOffsetY tel que originV*charH + charOffsetY = currentY*bgScale
        charOffsetY = scenePlayback.currentY * bgScale - originV * charH
      } else {
        charOffsetY = (viewH - charH) / 2 + scene.characterY * bgScale
      }
      charOffsetX = computeCharOffsetX(scenePlayback)

      // Transforms pivot-aware sur characterContainer : flip + rotation + skew autour de l'origine.
      const pivotX = charOffsetX + originU * charW
      const pivotY = charOffsetY + originV * charH
      characterContainer.pivot.set(pivotX, pivotY)
      characterContainer.position.set(pivotX, pivotY)
      characterContainer.rotation = scenePlayback.walkTiltRad
      characterContainer.skew.y = scenePlayback.walkSkewY
      characterContainer.scale.x = scenePlayback.walkFlipX
      characterContainer.scale.y = 1
      characterContainer.alpha = scenePlayback.walkAlpha
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
              const zoneId = hflm.zoneId
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
        // Construit le mapping zone → positions courantes (avec crossfade) :
        // 'body' + chaque zone patte (walkZoneFrames). null si pas d'anim active.
        let byZone: Record<string, Point2D[]> | null = null
        if (bodyPositionsForOverlays) {
          byZone = { body: bodyPositionsForOverlays }
          if (activeZonePlaybacks) {
            for (const zp of activeZonePlaybacks) {
              let pts = zp.playback.getPositions()
              if (fadeActive && prevZonePlaybacks) {
                const prev = prevZonePlaybacks.find(z => z.zoneId === zp.zoneId)
                if (prev) pts = blendPts(prev.playback.getPositions(), pts, fadeT)
              }
              byZone[zp.zoneId] = pts
            }
          }
        }
        // Offsets pupille depuis cotrackerEyePupilFrames de l'anim active + prev
        // (pour crossfader le mouvement de la pupille pendant les transitions).
        const pickPupilOffsets = (
          animId: string | null,
          pb: LoopPlayback | OncePlayback | null,
        ): Record<string, Point2D> | null => {
          if (!animId || !pb || !('currentFrame' in pb)) return null
          const anim = project.animations.find(a => a.id === animId)
          const epf = anim?.mesh?.cotrackerEyePupilFrames
          if (!epf) return null
          const fr = pb.currentFrame
          const out: Record<string, Point2D> = {}
          for (const eyeId of Object.keys(epf)) {
            const fs = epf[eyeId]
            if (fs && fs.length > 0) out[eyeId] = fs[Math.min(fr, fs.length - 1)]
          }
          return Object.keys(out).length > 0 ? out : null
        }
        const pupilOffsets = pickPupilOffsets(activeWalkZoneAnimId, activeBodyPlayback)
        const prevPupilOffsets = fadeActive ? pickPupilOffsets(prevWalkZoneAnimId, prevBodyPlayback) : null
        eyeOverlay.update(
          positions, byZone, charScale, charOffsetX, charOffsetY, (delta / 60) * 1000,
          pupilOffsets, prevPupilOffsets, fadeT,
        )
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
        // Construit la liste des (animation, frame) qui pilotent le rendu courant.
        const mpb = currentMultiPlaybackRef
        const activeFrames: Array<{ animId: string; frame: number }> = []
        if (mpb) {
          const ref = mpb.getActiveFrameRef()
          const mainId = ref.animId ?? restAnim?.id
          if (mainId) activeFrames.push({ animId: mainId, frame: ref.frame })
          if (ref.overlayAnimId) activeFrames.push({ animId: ref.overlayAnimId, frame: ref.overlayFrame })
        }
        if (activeWalkZoneAnimId && activeBodyPlayback && 'currentFrame' in activeBodyPlayback) {
          activeFrames.push({ animId: activeWalkZoneAnimId, frame: activeBodyPlayback.currentFrame })
        } else if (!mpb && restAnim) {
          if (currentRestPlayback) {
            activeFrames.push({ animId: restAnim.id, frame: currentRestPlayback.currentFrame })
          } else if (activeBodyPlayback && 'currentFrame' in activeBodyPlayback) {
            activeFrames.push({ animId: restAnim.id, frame: activeBodyPlayback.currentFrame })
          }
        }
        // Jaw = max des cotrackerJawOpennessFrames de toutes les anims actives.
        let jawOpenness = 0
        for (const { animId, frame } of activeFrames) {
          const frames = animMap.current.get(animId)?.mesh?.cotrackerJawOpennessFrames
          if (frames && frames.length > 0) {
            jawOpenness = Math.max(jawOpenness, frames[Math.min(frame, frames.length - 1)] ?? 0)
          }
        }
        const openness = Math.max(rms, jawOpenness)
        mouthOpennessRef.current = openness
        // DEBUG JAW
        if ((globalThis as any).__jawDbg !== false) {
          const _w = globalThis as any
          _w.__jawDbgCount = (_w.__jawDbgCount ?? 0) + 1
          if (_w.__jawDbgCount % 60 === 1) {
            const allAnims = project.animations.map(a => ({
              id: a.id.slice(0, 8),
              name: a.name,
              type: a.type,
              hasJaw: !!a.mesh?.cotrackerJawOpennessFrames,
              jawLen: a.mesh?.cotrackerJawOpennessFrames?.length ?? 0,
              hasJawBone: !!(a.mesh as any)?.cotrackerSkeleton?.jaw,
              lbsValidated: !!(a.mesh as any)?.cotrackerLBSValidated,
            }))
            const activeDbg = activeFrames.map(({ animId, frame }) => {
              const a = animMap.current.get(animId)
              const jf = a?.mesh?.cotrackerJawOpennessFrames
              return {
                id: animId.slice(0, 8),
                name: a?.name,
                type: a?.type,
                frame,
                jawLen: jf?.length ?? 0,
                jawValAtFrame: jf && jf.length > 0 ? jf[Math.min(frame, jf.length - 1)] : null,
              }
            })
            console.log('[JAW]',
              'rest=', restAnim?.id?.slice(0, 8), restAnim?.type,
              'mpb=', !!mpb,
              'walkZone=', activeWalkZoneAnimId?.slice(0, 8) ?? null,
              'jawOpenness=', jawOpenness, 'rms=', rms,
              'mouthOnProj=', !!project.projectMouth,
              'activeFrames=', JSON.stringify(activeDbg),
              'allAnims=', JSON.stringify(allAnims),
            )
          }
        }
        mouthOverlay.update(bodyForMouth, charScale, charOffsetX, charOffsetY, openness)
      }

      // Scroll synchrone arrière-plan + avant-plan (mêmes dimensions, suivent le perso 1:1).
      const offsetPx = scenePlayback.backgroundOffsetX * bgScale
      if (backgroundSprite) backgroundSprite.x = -offsetPx
      if (foregroundSprite) foregroundSprite.x = -offsetPx

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
        // Les contours doivent suivre EXACTEMENT les vertices du maillage, qui sont
        // positionnés en coords brutes (pt * charScale + offset). `contentAlignment`
        // ne sert qu'aux UV de texture, PAS à la géométrie — l'appliquer ici décalait
        // le halo de contour par rapport à la texture en play (scan 2048 + alignment).
        const mapPoint = (pt: Point2D) => ({ x: pt.x * charScale + charOffsetX, y: pt.y * charScale + charOffsetY })
        const polylines = computeZoneOutlinePolylines(
          triForOutline,
          { body: bodyPositions, limbs: limbPositions },
          mapPoint,
          mouthHolePolygon && project.projectMouth
            ? { polygon: mouthHolePolygon, zoneId: project.projectMouth.attachZoneId ?? 'body', mouth: project.projectMouth }
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
  }, [project, scanCanvas, contentAlignment, scene, restAnim, imgRefReady, cardSize.w, cardSize.h]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleExitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      onClose()
    }
  }, [onClose])

  const handleActionByIndex = useCallback(async (actionIndex: number) => {
    const rp = scene.restPoint
    const actions = rp?.actions ?? []
    const action = actions[actionIndex]
    if (!action || action.steps.length === 0) return
    const playable = action.steps.every(s => {
      const anim = project.animations.find(x => x.id === s.animationId)
      return anim != null && animationHasFrames(anim)
    })
    if (!playable) return

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

    // Durée totale = somme des frames des steps / 24 fps
    const totalFrames = action.steps.reduce((acc, s) => {
      const anim = project.animations.find(x => x.id === s.animationId)
      const n = anim?.mesh?.videoFramesMesh?.length
        ?? anim?.mesh?.walkBodyFrames?.length
        ?? 0
      return acc + n
    }, 0)
    startBtnTimer(`action-${actionIndex}`, (totalFrames / 24) * 1000)
  }, [scene, project.animations, project.projectMouth, startBtnTimer])

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
            setActiveBtn(null)
          },
        })
        mouthAudioRef.current = player
        await player.play()
        const dur = (player as unknown as { duration?: number }).duration
        startBtnTimer('speak', (typeof dur === 'number' && dur > 0 ? dur : 2) * 1000)
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
    audio.onloadedmetadata = () => {
      const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 2
      startBtnTimer('speak', dur * 1000)
    }
    audio.onended = () => { URL.revokeObjectURL(url); speakAudioRef.current = null; setActiveBtn(null) }
  }, [scene, project.projectMouth, startBtnTimer])

  const handleHelp = useCallback(() => {
    const rp = scene.restPoint
    const texts = rp?.helpTexts ?? []
    if (texts.length === 0) return
    setCurrentHelpText(texts[Math.floor(Math.random() * texts.length)])
    setShowHelpBubble(true)
    startBtnTimer('help', 4000)
  }, [scene.restPoint, startBtnTimer])

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
  const rpActions = currentRp?.actions ?? []
  const actionButtons = Array.from({ length: 3 }, (_, i) => {
    const a = rpActions[i]
    const enabled = !!a && a.steps.length > 0 && a.steps.every(s => {
      const anim = project.animations.find(x => x.id === s.animationId)
      return anim != null && (anim.mesh?.videoFramesMesh != null || (anim.mesh?.walkZoneFrames != null && anim.mesh?.walkBodyFrames != null))
    })
    return { index: i, label: a?.name ?? `Action ${i + 1}`, enabled }
  })
  const hasSpeakSounds = (currentRp?.speakSoundIds ?? []).length > 0
  const hasHelpTexts = (currentRp?.helpTexts ?? []).length > 0

  const isInteraction = sceneState === 'interaction'
  const isWalking = sceneState === 'walking'
  const buttonsVisible = sceneState !== 'entering'
  // Boutons grisés + non cliquables pendant la marche libre.
  const anyActive = activeBtn != null || isWalking
  const RING_R = 46
  const RING_C = 2 * Math.PI * RING_R
  function Ring({ progress, active }: { progress: number; active: boolean }) {
    return (
      <svg className="action-btn-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={RING_R} className="action-btn-ring-track" />
        {active && (
          <circle
            cx="50" cy="50" r={RING_R}
            className="action-btn-ring-progress"
            strokeDasharray={RING_C}
            strokeDashoffset={RING_C * (1 - progress)}
            transform="rotate(-90 50 50)"
          />
        )}
      </svg>
    )
  }

  return (
    <div className={`animation-player scene-player${!modal ? ' scene-player--framed' : ''}`} ref={playerRef}>
      <div
        ref={containerRef}
        className="animation-canvas"
        style={!modal && cardSize.w ? { width: cardSize.w, height: cardSize.h } : undefined}
      />

      {modal ? (
        <button className="preview-modal-close" onClick={onClose} title="Fermer">&times;</button>
      ) : (
        <LongPressCloseButton onComplete={handleExitFullscreen} />
      )}

      {/* LEFT side buttons — toujours montés, fade pendant l'entrée */}
      <div
        className="scene-player-left-buttons"
        style={{
          opacity: buttonsVisible ? 1 : 0,
          pointerEvents: isInteraction && !anyActive ? 'auto' : 'none',
          transition: 'opacity 400ms ease',
        }}
      >
        {actionButtons.map(b => {
          const id = `action-${b.index}`
          const isActive = activeBtn === id
          return (
            <button
              key={b.index}
              className="scene-player-action-btn"
              onClick={() => handleActionByIndex(b.index)}
              disabled={!b.enabled || anyActive}
              aria-label={b.label}
            >
              <Ring progress={isActive ? btnProgress : 0} active={isActive} />
              <span className="action-btn-label">{b.index + 1}</span>
            </button>
          )
        })}
        {hasSpeakSounds && (
          <button
            className="scene-player-action-btn scene-player-action-btn--speak"
            onClick={handleSpeak}
            disabled={anyActive}
            aria-label="Parler"
          >
            <Ring progress={activeBtn === 'speak' ? btnProgress : 0} active={activeBtn === 'speak'} />
            <span className="action-btn-label">💬</span>
          </button>
        )}
      </div>

      {/* RIGHT side - help button */}
      {hasHelpTexts && (
        <button
          className="scene-player-help-btn"
          onClick={handleHelp}
          disabled={anyActive}
          style={{ opacity: buttonsVisible ? 1 : 0, transition: 'opacity 400ms ease' }}
        >
          <Ring progress={activeBtn === 'help' ? btnProgress : 0} active={activeBtn === 'help'} />
          <span className="action-btn-label">?</span>
        </button>
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
