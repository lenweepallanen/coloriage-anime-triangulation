import type { Animation, Scene, SceneAction, SceneFilm } from '../types/project'
import { buildFilmSegments, resolveFilmPlans, transitionDurationMs } from './filmDirector'
import { sampleFilmPath } from './filmPath'

/** Lit la durée (ms) d'un blob audio via ses métadonnées. 0 si indéterminé. */
export function getAudioDurationMs(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const a = new Audio()
    a.preload = 'metadata'
    const done = (ms: number) => { try { URL.revokeObjectURL(url) } catch { /* */ } resolve(ms) }
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration * 1000 : 0)
    a.onerror = () => done(0)
    a.src = url
  })
}

/**
 * Durée totale d'une action = max entre :
 *  - la durée cumulée des animations des steps (frames / fps),
 *  - la fin de l'audio général d'action (lancé à t=0),
 *  - la fin du dernier audio d'étape (lancé au démarrage de son animation).
 */
export async function estimateActionDurationMs(action: SceneAction, animations: Animation[], fps = 24): Promise<number> {
  // `cumFrames` en frames ÉQUIVALENTES à vitesse 1 : un step joué à animSpeedMul 2
  // dure moitié moins → n / mul.
  let cumFrames = 0
  const stepStartMs: number[] = []
  for (const s of action.steps) {
    stepStartMs.push((cumFrames / fps) * 1000)
    const anim = animations.find(x => x.id === s.animationId)
    const n = anim?.mesh?.videoFramesMesh?.length
      ?? anim?.mesh?.walkBodyFrames?.length
      ?? 0
    cumFrames += n / Math.max(0.01, s.animSpeedMul ?? 1)
  }
  const animMs = (cumFrames / fps) * 1000
  // Les sons en LOOP ne définissent pas de fin (ils suivent l'animation et sont
  // coupés à la fin de l'action) : exclus du calcul de durée. Les autres durent
  // durée_native / rate (vitesse de lecture du son).
  const [actionSoundMs, stepSoundEndsMs] = await Promise.all([
    action.sound?.blob && !action.sound.loop
      ? getAudioDurationMs(action.sound.blob).then(d => d / Math.max(0.01, action.sound?.rate ?? 1))
      : Promise.resolve(0),
    Promise.all(action.steps.map(async (s, i) => {
      if (!s.sound?.blob || s.sound.loop) return 0
      const d = await getAudioDurationMs(s.sound.blob)
      return stepStartMs[i] + d / Math.max(0.01, s.sound.rate ?? 1)
    })),
  ])
  const lastStepAudioMs = stepSoundEndsMs.length ? Math.max(...stepSoundEndsMs) : 0
  return Math.max(animMs, actionSoundMs, lastStepAudioMs)
}

export interface FilmDurationEstimate {
  /** Durée estimée par segment (ms), même ordre que `buildFilmSegments(film)`. */
  segments: number[]
  totalMs: number
}

/** Marge forfaitaire après une action : trans-in MultiAnimationPlayback (~7 frames). */
const ACTION_SETTLE_MS = 290
/** Durée du fade de fin de film. */
const ENDING_FADE_MS = 400

/**
 * Durées estimées des segments d'un film v2 (indicatif : règle temporelle admin +
 * barre de progression du player). Basées sur les MÊMES segments que le director
 * (`buildFilmSegments`) pour rester alignées. Les positions hors-champ sont
 * approximées au bord du cadre caméra 16:9 (largeur = hauteur du décor × 16/9,
 * bornée à la largeur du décor — même formule que le player et l'éditeur).
 */
export async function estimateFilmDurations(film: SceneFilm, scene: Scene, animations: Animation[]): Promise<FilmDurationEstimate> {
  const segments = buildFilmSegments(film)
  const plans = resolveFilmPlans(film, scene)
  // Bords du cadre 16:9 PAR PLAN (le décor et le cadrage changent à chaque plan).
  const edgeX = (planIndex: number, side: 'left' | 'right') => {
    const plan = plans[planIndex]
    const bgW = plan?.background?.width ?? 0
    const bgH = plan?.background?.height ?? 800
    const frameHalfW = Math.max(1, Math.min(bgW > 0 ? bgW : Number.POSITIVE_INFINITY, bgH * (16 / 9)) / 2)
    const camX = plan?.cameraX ?? 0
    return side === 'left' ? camX - frameHalfW : camX + frameHalfW
  }

  let pos = { x: edgeX(0, plans[0]?.entrySide ?? 'left'), y: plans[0]?.points[0]?.y ?? 0 }
  const out: number[] = []
  for (const seg of segments) {
    if (seg.kind === 'action') {
      out.push((await estimateActionDurationMs(seg.action, animations)) + ACTION_SETTLE_MS)
      continue
    }
    if (seg.kind === 'pause') {
      out.push(seg.durationMs)
      continue
    }
    if (seg.kind === 'planSwitch') {
      out.push(transitionDurationMs(seg.transition))
      // Le plan suivant démarre hors-champ par son côté d'entrée.
      const next = plans[seg.toPlanIndex]
      pos = { x: edgeX(seg.toPlanIndex, next?.entrySide ?? 'left'), y: next?.points[0]?.y ?? 0 }
      continue
    }
    const target = seg.opts.offscreenEnd
      ? { x: edgeX(seg.planIndex, seg.opts.offscreenEnd), y: pos.y }
      : seg.target ?? pos
    if (seg.opts.startAt) pos = { x: seg.opts.startAt.x, y: seg.opts.startAt.y }
    else if (seg.opts.offscreenStart) pos = { x: edgeX(seg.planIndex, seg.opts.offscreenStart), y: target.y }
    // Longueur du chemin via la même table arc-length que le playback (courbes incluses).
    const dist = sampleFilmPath(pos, target, seg.opts.controlPoints).totalLen
    pos = target
    out.push((dist / seg.opts.speedPxPerSec) * 1000)
  }

  return { segments: out, totalMs: out.reduce((a, b) => a + b, 0) + ENDING_FADE_MS }
}
