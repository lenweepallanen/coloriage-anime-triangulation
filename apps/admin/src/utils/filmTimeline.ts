import type {
  FilmMotionClip, FilmMotionRef, FilmPlanTimeline, FilmSoundClip, FilmT,
  FilmTimelinePlan, Point2D,
} from '../types/project'
import { transitionDurationMs } from './filmDirector'

/**
 * Helpers PURS du modèle FILM TIMELINE (v4) : géométrie du cadre caméra,
 * résolution des refs spatiales, ancrages ⚓ des sons, invariants de pistes,
 * durée totale. Aucun side-effect, aucun accès DOM/PIXI.
 */

export const FILM_FPS = 24
/** Durée du fade de fin de film (identique au moteur v3). */
export const FILM_ENDING_FADE_MS = 400

/** OUVERTURE du film résolue (fallback legacy introFadeMs → fondu noir ; sinon cut). */
export function filmIntroTransition(film: Pick<FilmT, 'intro' | 'introFadeMs'>): import('../types/project').FilmPlanTransition {
  if (film.intro) return film.intro
  const ms = film.introFadeMs ?? 0
  return ms > 0 ? { kind: 'fadeBlack', durationMs: ms } : { kind: 'cut' }
}

/** FERMETURE du film résolue (fallback legacy outroFadeMs ; défaut fondu noir 400 ms). */
export function filmOutroTransition(film: Pick<FilmT, 'outro' | 'outroFadeMs'>): import('../types/project').FilmPlanTransition {
  if (film.outro) return film.outro
  return { kind: 'fadeBlack', durationMs: film.outroFadeMs ?? FILM_ENDING_FADE_MS }
}

/** Métriques du personnage nécessaires au placement hors-champ précis.
 *  Absentes (éditeur) → approximation au bord du cadre caméra. */
export interface FilmCharMetrics {
  /** Largeur/hauteur de l'image du coloriage. */
  aspect: number
  /** Origine U normalisée (0..1) du perso dans son image. */
  originU: number
  /** Échelle de base du perso (FilmCharacter.scale). */
  baseScale: number
}

type PlanLike = Pick<FilmTimelinePlan, 'backdrop' | 'cameraX'>

/** Demi-largeur du cadre caméra 16:9 dans le décor (même formule que le moteur). */
export function planFrameHalfWidthBg(plan: PlanLike): number {
  const bgW = plan.backdrop?.width ?? 0
  const bgH = plan.backdrop?.height ?? 800
  return Math.max(1, Math.min(bgW > 0 ? bgW : Number.POSITIVE_INFINITY, bgH * (16 / 9)) / 2)
}

/** Bords gauche/droit de la VUE caméra, clampés au décor (comme clampOffset). */
export function frameEdgesBg(plan: PlanLike): { left: number; right: number } {
  const half = planFrameHalfWidthBg(plan)
  const bgW = plan.backdrop?.width ?? 0
  const maxLeft = Math.max(0, bgW - 2 * half)
  const left = Math.max(0, Math.min(maxLeft, plan.cameraX - half))
  return { left, right: left + 2 * half }
}

/** X hors-champ : perso (échelle donnée) tout juste hors du cadre. Sans métriques
 *  perso → bord du cadre (approximation éditeur/estimation, comme aujourd'hui). */
export function offscreenXBg(
  plan: PlanLike,
  side: 'left' | 'right',
  scaleMul: number,
  metrics: FilmCharMetrics | null,
): number {
  const { left, right } = frameEdgesBg(plan)
  if (!metrics) return side === 'left' ? left : right
  const bgH = plan.backdrop?.height ?? 800
  const charW = bgH * metrics.baseScale * scaleMul * metrics.aspect
  const eps = 2
  return side === 'left'
    ? left - (1 - metrics.originU) * charW - eps
    : right + metrics.originU * charW + eps
}

/** Position + échelle résolues d'une FilmMotionRef. `fallbackY`/`fallbackScale`
 *  servent aux refs offscreen (pas de y ni d'échelle propres). */
export function resolveMotionRef(
  ref: FilmMotionRef,
  plan: PlanLike,
  timeline: Pick<FilmPlanTimeline, 'waypoints'>,
  metrics: FilmCharMetrics | null,
  fallbackY: number,
  fallbackScale: number,
): { x: number; y: number; scale: number } {
  if (ref.kind === 'waypoint') {
    const wp = timeline.waypoints.find(w => w.id === ref.id)
    if (wp) return { x: wp.x, y: wp.y, scale: wp.scale }
    return { x: 0, y: fallbackY, scale: fallbackScale }
  }
  if (ref.kind === 'free') {
    return { x: ref.x, y: ref.y, scale: ref.scale ?? fallbackScale }
  }
  return { x: offscreenXBg(plan, ref.side, fallbackScale, metrics), y: fallbackY, scale: fallbackScale }
}

/** Recalcule les startMs DÉRIVÉS des clips sons ancrés ⚓ (immutabe : retourne
 *  une nouvelle timeline si au moins un startMs change, sinon la même). À appeler
 *  après CHAQUE mutation de clips motion/anim. */
export function resolveSoundAnchors(timeline: FilmPlanTimeline): FilmPlanTimeline {
  const edgeOf = (clipId: string, edge: 'start' | 'end'): number | null => {
    const target: { startMs: number; durationMs: number } | undefined =
      timeline.motion.find(c => c.id === clipId) ?? timeline.anim.find(c => c.id === clipId)
    if (!target) return null
    return edge === 'start' ? target.startMs : target.startMs + target.durationMs
  }
  let changed = false
  const soundTracks = timeline.soundTracks.map(track => track.map(clip => {
    if (!clip.anchor) return clip
    const base = edgeOf(clip.anchor.clipId, clip.anchor.edge)
    if (base == null) return clip
    const startMs = Math.max(0, Math.round(base + clip.anchor.offsetMs))
    if (startMs === clip.startMs) return clip
    changed = true
    return { ...clip, startMs }
  }))
  return changed ? { ...timeline, soundTracks } : timeline
}

/**
 * MIGRATION : retire les clips Animation qui DUPLIQUENT l'anim d'un trajet
 * (même animation, mêmes bornes ±60 ms) — reliquats des premières conversions
 * v3→timeline, avant que l'anim de marche soit portée par le trajet lui-même.
 * Sans ça, le clip dupliqué a priorité et les réglages du trajet (vitesse
 * anim…) semblent sans effet. Retourne le film inchangé s'il n'y a rien à faire.
 */
export function dedupeTravelAnimClips(film: FilmT): FilmT {
  let changed = false
  const plans = film.plans.map(pl => {
    const tl = pl.timeline
    const anim = tl.anim.filter(a => {
      const dup = tl.motion.some(m => m.kind !== 'appear'
        && (m.animationId ?? film.moveAnimationId) === a.animationId
        && Math.abs(m.startMs - a.startMs) <= 60
        && Math.abs(m.durationMs - a.durationMs) <= 60)
      if (dup) changed = true
      return !dup
    })
    return anim.length === tl.anim.length ? pl : { ...pl, timeline: { ...tl, anim } }
  })
  return changed ? { ...film, plans } : film
}

/** Tri par startMs (nouvelle array). */
export function sortClips<T extends { startMs: number }>(clips: T[]): T[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs)
}

/** Piste EXCLUSIVE (motion/anim) : résout les chevauchements en POUSSANT vers la
 *  droite les clips suivants (ripple, comme un logiciel de montage) — étirer ou
 *  déplacer un clip ne bloque plus contre son voisin, il le décale. Retourne le
 *  même tableau si rien ne chevauche. */
export function pushExclusiveOverlaps<T extends { startMs: number; durationMs: number }>(clips: T[]): T[] {
  const sorted = sortClips(clips)
  let prevEnd = Number.NEGATIVE_INFINITY
  let changed = false
  const out = sorted.map(c => {
    // Marqueurs PONCTUELS (durée 0, ✨ apparition) : instantanés, ils ne poussent
    // ni ne sont poussés (une apparition peut coïncider avec un début de trajet).
    if (c.durationMs <= 0) return c
    let s = c.startMs
    if (s < prevEnd) { s = prevEnd; changed = true }
    prevEnd = s + c.durationMs
    return s === c.startMs ? c : { ...c, startMs: Math.round(s) }
  })
  return changed ? out : clips
}

/** Clampe le déplacement/resize d'un clip d'une piste EXCLUSIVE (motion/anim)
 *  contre ses voisins : jamais de chevauchement, jamais < 0. Retourne les bornes
 *  autorisées pour ce clip. */
export function exclusiveTrackBounds(
  clips: { id: string; startMs: number; durationMs: number }[],
  clipId: string,
): { minStartMs: number; maxEndMs: number } {
  const sorted = sortClips(clips)
  const i = sorted.findIndex(c => c.id === clipId)
  const prev = i > 0 ? sorted[i - 1] : null
  const next = i >= 0 && i < sorted.length - 1 ? sorted[i + 1] : null
  return {
    minStartMs: prev ? prev.startMs + prev.durationMs : 0,
    maxEndMs: next ? next.startMs : Number.POSITIVE_INFINITY,
  }
}

/** Bord droit réel du contenu d'une timeline (dernier clip toutes pistes). */
export function timelineContentEndMs(timeline: FilmPlanTimeline): number {
  let end = 0
  const eat = (clips: { startMs: number; durationMs: number }[]) => {
    for (const c of clips) end = Math.max(end, c.startMs + c.durationMs)
  }
  eat(timeline.motion)
  eat(timeline.anim)
  for (const track of timeline.soundTracks) eat(track)
  return end
}

/** Durée totale du film : ouverture + plans + transitions inter-plans + fermeture. */
export function filmTotalMs(film: FilmT): number {
  let total = transitionDurationMs(filmIntroTransition(film)) + transitionDurationMs(filmOutroTransition(film))
  film.plans.forEach((pl, i) => {
    total += pl.timeline.durationMs
    if (i < film.plans.length - 1) total += transitionDurationMs(pl.transitionToNext ?? { kind: 'cut' })
  })
  return total
}

/** Vitesse dérivée d'un MotionClip (px/s) pour affichage éditeur. */
export function motionClipSpeed(pathLen: number, clip: FilmMotionClip): number {
  return clip.durationMs > 0 ? (pathLen / clip.durationMs) * 1000 : 0
}

let clipCounter = 0
function newId(): string {
  // crypto.randomUUID côté navigateur ; fallback compteur (tests).
  try { return crypto.randomUUID() } catch { return `clip-${++clipCounter}` }
}

export function newMotionClip(partial: Omit<FilmMotionClip, 'id'>): FilmMotionClip {
  return { id: newId(), ...partial }
}
export function newAnimClip(partial: Omit<import('../types/project').FilmAnimClip, 'id'>): import('../types/project').FilmAnimClip {
  return { id: newId(), ...partial }
}
export function newSoundClip(partial: Omit<FilmSoundClip, 'id'>): FilmSoundClip {
  return { id: newId(), ...partial }
}

/** Point2D re-export utilitaire pour les consommateurs du module. */
export type { Point2D }
