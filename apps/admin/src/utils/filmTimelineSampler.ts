import type { Animation, FilmMotionClip, FilmT, FilmTimelinePlan } from '../types/project'
import { pointAtLen, sampleFilmPath, applyFilmEasing, type FilmPathTable } from './filmPath'
import { transitionDurationMs } from './filmDirector'
import {
  FILM_ENDING_FADE_MS, FILM_FPS, offscreenXBg, resolveMotionRef, sortClips,
  type FilmCharMetrics,
} from './filmTimeline'

/**
 * Échantillonneur PUR du film timeline : `evaluate(tMs)` retourne l'état complet
 * (position, échelle, flip, animation + frame, plan actif, fade) sans AUCUN état
 * interne ni side-effect. Toute la géométrie est précalculée au constructeur
 * (tables arc-length par clip + poses cumulées) → seek exact, scrubbing, replay.
 *
 * Les side-effects (montage décor, transitions PIXI, audio) sont déclenchés par
 * la couche impérative du player en comparant t_prev/t_now aux bornes.
 */

export interface TimelineSample {
  /** Index du plan dans film.plans (plans inactifs inclus dans la numérotation). */
  planIndex: number
  planLocalMs: number
  x: number
  y: number
  /** Échelle du perso (waypoints/clips) — à multiplier par character.scale. */
  scaleMul: number
  flip: 1 | -1
  /** null = idle rest implicite (le player joue la rest animation). */
  animationId: string | null
  /** Frame FRACTIONNAIRE. Pour l'idle (animationId null) : frame brute non modulée. */
  animFrame: number
  animSpeedMul: number
  /** 1 → 0 pendant le fade de fin de film. */
  fadeAlpha: number
  phase: 'travel' | 'idle' | 'action' | 'transition' | 'ended'
  /** Renseigné pendant une fenêtre de transition inter-plans. */
  transition?: { toPlanIndex: number; t01: number }
}

interface PreparedMotion {
  clip: FilmMotionClip
  startMs: number
  endMs: number
  fromX: number
  fromY: number
  toX: number
  toY: number
  fromScale: number
  toScale: number
  table: FilmPathTable
  /** Flip à la FIN du clip (tangente de fin, ou facing du waypoint cible). */
  endFlip: 1 | -1
  /** Flip au DÉBUT du clip (tangente de départ). */
  startFlip: 1 | -1
}

interface PreparedPlan {
  planIndex: number
  plan: FilmTimelinePlan
  durationMs: number
  motion: PreparedMotion[]
  /** Pose avant le premier clip motion. */
  initial: { x: number; y: number; scale: number; flip: 1 | -1 }
  active: boolean
}

type Window =
  | { kind: 'plan'; startMs: number; endMs: number; prepared: PreparedPlan }
  | { kind: 'transition'; startMs: number; endMs: number; prepared: PreparedPlan; toPlanIndex: number }
  | { kind: 'endFade'; startMs: number; endMs: number; prepared: PreparedPlan }

export class FilmTimelineSampler {
  readonly totalMs: number
  /** Début absolu (ms) de chaque plan de film.plans (NaN pour les plans inactifs). */
  readonly planStartMs: number[]

  private film: FilmT
  private preparedByIndex: PreparedPlan[]
  private windows: Window[]
  private animFrameCount: Map<string, number>
  private nativeRight: boolean

  constructor(film: FilmT, animations: Animation[], opts?: { charMetrics?: FilmCharMetrics | null }) {
    this.film = film
    this.nativeRight = film.character.facing !== 'left'
    this.animFrameCount = new Map(animations.map(a => [
      a.id,
      a.mesh?.videoFramesMesh?.length ?? a.mesh?.walkBodyFrames?.length ?? 0,
    ]))
    const metrics = opts?.charMetrics ?? null

    this.preparedByIndex = film.plans.map((plan, planIndex) => this.preparePlan(plan, planIndex, metrics))

    // Fenêtres globales : [plan][transition]…[dernier plan][fade fin]. Les plans
    // inactifs (aucun clip, durée 0) sont sautés, transition incluse (parité v3).
    const actives = this.preparedByIndex.filter(p => p.active)
    this.planStartMs = film.plans.map(() => Number.NaN)
    const windows: Window[] = []
    let t = 0
    actives.forEach((p, i) => {
      this.planStartMs[p.planIndex] = t
      windows.push({ kind: 'plan', startMs: t, endMs: t + p.durationMs, prepared: p })
      t += p.durationMs
      if (i < actives.length - 1) {
        const trans = transitionDurationMs(p.plan.transitionToNext ?? { kind: 'cut' })
        if (trans > 0) {
          windows.push({ kind: 'transition', startMs: t, endMs: t + trans, prepared: p, toPlanIndex: actives[i + 1].planIndex })
          t += trans
        }
      }
    })
    const last = actives[actives.length - 1]
    if (last) {
      windows.push({ kind: 'endFade', startMs: t, endMs: t + FILM_ENDING_FADE_MS, prepared: last })
      t += FILM_ENDING_FADE_MS
    }
    this.windows = windows
    this.totalMs = t
  }

  private flipFor(movingRight: boolean): 1 | -1 {
    return movingRight === this.nativeRight ? 1 : -1
  }

  private flipForFacing(facing: 'left' | 'right'): 1 | -1 {
    return this.flipFor(facing === 'right')
  }

  /** Signe de la tangente x du chemin à la longueur `len` (fallback : flip fourni). */
  private tangentFlip(table: FilmPathTable, len: number, fallback: 1 | -1): 1 | -1 {
    const eps = Math.max(1, table.totalLen * 0.01)
    const a = pointAtLen(table, Math.max(0, len - eps))
    const b = pointAtLen(table, Math.min(table.totalLen, len + eps))
    const dx = b.x - a.x
    if (Math.abs(dx) < 1e-3) return fallback
    return this.flipFor(dx > 0)
  }

  private preparePlan(plan: FilmTimelinePlan, planIndex: number, metrics: FilmCharMetrics | null): PreparedPlan {
    const timeline = plan.timeline
    const clips = sortClips(timeline.motion)
    const defaultY = timeline.waypoints[0]?.y ?? (plan.backdrop?.height ?? 800) * 0.7
    const prepared: PreparedMotion[] = []
    let prev: { x: number; y: number; scale: number; flip: 1 | -1 } | null = null

    for (const clip of clips) {
      // 1. Cible (sauf offscreen, résolue après le départ pour hériter y/échelle).
      let toRes = clip.to.kind !== 'offscreen'
        ? resolveMotionRef(clip.to, plan, timeline, metrics, prev?.y ?? defaultY, prev?.scale ?? 1)
        : null
      // 2. Départ.
      let fromRes: { x: number; y: number; scale: number }
      if (clip.kind === 'appear') {
        fromRes = toRes ?? { x: 0, y: defaultY, scale: prev?.scale ?? 1 }
      } else if (clip.from == null) {
        fromRes = prev ?? toRes ?? { x: 0, y: defaultY, scale: 1 }
      } else if (clip.from.kind === 'offscreen') {
        // Entrée hors-champ : y + échelle hérités de la CIBLE (sémantique v3).
        const y = toRes?.y ?? prev?.y ?? defaultY
        const scale = toRes?.scale ?? prev?.scale ?? 1
        fromRes = { x: offscreenXBg(plan, clip.from.side, scale, metrics), y, scale }
      } else {
        fromRes = resolveMotionRef(clip.from, plan, timeline, metrics, toRes?.y ?? defaultY, toRes?.scale ?? prev?.scale ?? 1)
      }
      // 3. Cible offscreen : y + échelle hérités du départ (sémantique v3 exit).
      if (toRes == null) {
        const side = (clip.to as { side: 'left' | 'right' }).side
        toRes = { x: offscreenXBg(plan, side, fromRes.scale, metrics), y: fromRes.y, scale: fromRes.scale }
      }

      const table = sampleFilmPath({ x: fromRes.x, y: fromRes.y }, { x: toRes.x, y: toRes.y }, clip.controlPoints)
      const startFlip = this.tangentFlip(table, 0, prev?.flip ?? 1)
      let endFlip = this.tangentFlip(table, table.totalLen, startFlip)
      // Regard imposé à l'idle sur le waypoint cible.
      if (clip.to.kind === 'waypoint') {
        const wp = timeline.waypoints.find(w => w.id === (clip.to as { id: string }).id)
        if (wp?.facing != null) endFlip = this.flipForFacing(wp.facing)
      }
      prepared.push({
        clip,
        startMs: clip.startMs,
        endMs: clip.startMs + clip.durationMs,
        fromX: fromRes.x, fromY: fromRes.y,
        toX: toRes.x, toY: toRes.y,
        fromScale: fromRes.scale, toScale: toRes.scale,
        table,
        startFlip,
        endFlip,
      })
      prev = { x: toRes.x, y: toRes.y, scale: toRes.scale, flip: endFlip }
    }

    const first = prepared[0]
    const wp0 = timeline.waypoints[0]
    const initial = first
      ? { x: first.fromX, y: first.fromY, scale: first.fromScale, flip: first.startFlip }
      : wp0
        ? { x: wp0.x, y: wp0.y, scale: wp0.scale, flip: wp0.facing != null ? this.flipForFacing(wp0.facing) : (1 as const) }
        : { x: plan.cameraX, y: defaultY, scale: 1, flip: 1 as const }

    const active = timeline.durationMs > 0
      || timeline.motion.length > 0 || timeline.anim.length > 0
      || timeline.soundTracks.some(tr => tr.length > 0)
    return { planIndex, plan, durationMs: Math.max(0, timeline.durationMs), motion: prepared, initial, active }
  }

  /** Échantillonne un plan à un temps LOCAL (utilisé par l'éditeur pour le scrub). */
  evaluatePlanLocal(planIndex: number, localMs: number): TimelineSample {
    const p = this.preparedByIndex[planIndex] ?? this.preparedByIndex[0]
    return this.samplePlan(p, localMs, 1)
  }

  /** Échantillonne le film à un temps GLOBAL (ms depuis le début). */
  evaluate(tMs: number): TimelineSample {
    const windows = this.windows
    if (windows.length === 0) {
      return {
        planIndex: 0, planLocalMs: 0, x: 0, y: 0, scaleMul: 1, flip: 1,
        animationId: null, animFrame: 0, animSpeedMul: 1, fadeAlpha: 1, phase: 'ended',
      }
    }
    const t = Math.max(0, tMs)
    const last = windows[windows.length - 1]
    if (t >= last.endMs) {
      const s = this.samplePlan(last.prepared, last.prepared.durationMs, 0)
      return { ...s, phase: 'ended', fadeAlpha: 0 }
    }
    let w = windows[0]
    for (const cand of windows) {
      if (t < cand.endMs) { w = cand; break }
    }
    if (w.kind === 'plan') {
      return this.samplePlan(w.prepared, t - w.startMs, 1)
    }
    if (w.kind === 'transition') {
      const t01 = (t - w.startMs) / Math.max(1, w.endMs - w.startMs)
      const s = this.samplePlan(w.prepared, w.prepared.durationMs, 1)
      return { ...s, phase: 'transition', transition: { toPlanIndex: w.toPlanIndex, t01 } }
    }
    // endFade
    const t01 = (t - w.startMs) / Math.max(1, w.endMs - w.startMs)
    const s = this.samplePlan(w.prepared, w.prepared.durationMs, 1 - t01)
    return { ...s, fadeAlpha: 1 - t01 }
  }

  private samplePlan(p: PreparedPlan, localMs: number, fadeAlpha: number): TimelineSample {
    const local = Math.max(0, localMs)
    const timeline = p.plan.timeline

    // --- Position/échelle/flip depuis la piste motion ---
    let x = p.initial.x
    let y = p.initial.y
    let scale = p.initial.scale
    let flip = p.initial.flip
    let travelling = false
    let lastEnded: PreparedMotion | null = null
    for (const m of p.motion) {
      if (local >= m.endMs) {
        lastEnded = m
        continue
      }
      if (local >= m.startMs) {
        // Clip actif.
        if (m.clip.durationMs <= 0 || m.table.totalLen <= 1e-6) {
          x = m.toX; y = m.toY; scale = m.toScale; flip = m.endFlip
        } else {
          const tRaw = Math.min(1, (local - m.startMs) / m.clip.durationMs)
          const sFrac = applyFilmEasing(m.clip.easing, tRaw)
          const covered = m.table.totalLen * sFrac
          const pos = pointAtLen(m.table, covered)
          x = pos.x; y = pos.y
          scale = m.fromScale + (m.toScale - m.fromScale) * sFrac
          flip = this.tangentFlip(m.table, covered, m.startFlip)
          travelling = m.clip.kind !== 'appear'
        }
        break
      }
      break // trou avant ce clip : on reste sur lastEnded/initial.
    }
    if (!travelling && lastEnded && (p.motion.every(m => local < m.startMs || local >= m.endMs))) {
      x = lastEnded.toX; y = lastEnded.toY; scale = lastEnded.toScale; flip = lastEnded.endFlip
    }

    // --- Animation depuis la piste anim ---
    let animationId: string | null = null
    let animFrame = 0
    let animSpeedMul = 1
    let inAnimClip = false
    for (const a of timeline.anim) {
      if (local >= a.startMs && local < a.startMs + a.durationMs) {
        const mul = Math.max(0.01, a.speedMul ?? 1)
        const raw = (FILM_FPS * mul * (local - a.startMs)) / 1000
        const n = this.animFrameCount.get(a.animationId) ?? 0
        animationId = a.animationId
        animSpeedMul = mul
        animFrame = n > 0
          ? (a.fillMode === 'loop' ? raw % n : Math.min(raw, n - 1))
          : 0
        inAnimClip = true
        break
      }
    }
    if (!inAnimClip) {
      const idleMul = Math.max(0.01, this.film.idleSpeedMul ?? 1)
      animSpeedMul = idleMul
      animFrame = (FILM_FPS * idleMul * local) / 1000
    }

    const phase: TimelineSample['phase'] = travelling ? 'travel' : (inAnimClip ? 'action' : 'idle')
    return {
      planIndex: p.planIndex,
      planLocalMs: local,
      x, y,
      scaleMul: scale,
      flip,
      animationId,
      animFrame,
      animSpeedMul,
      fadeAlpha,
      phase,
    }
  }
}
