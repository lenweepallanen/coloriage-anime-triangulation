import type { FilmPlanTransition, Scene, SceneAction, SceneFilm, SceneFilmPlan, SceneSound } from '../types/project'
import type { FilmTravelOpts, SceneState } from './scenePlayback'

export type FilmPhase = 'idle' | 'travel' | 'action' | 'pause' | 'planSwitch' | 'settle' | 'ending' | 'done'

/** Durées par défaut des transitions de plan (partagées player ↔ estimation). */
export function transitionDurationMs(t: FilmPlanTransition): number {
  switch (t.kind) {
    case 'cut': return 0
    case 'iris': return t.durationMs ?? 700
    default: return t.durationMs ?? 500
  }
}

/**
 * Plans JOUABLES du film (≥ 1 point), avec le fallback décor appliqué : un plan
 * sans background propre utilise le décor de la scène (background ET foreground,
 * en bloc). Même filtre que buildFilmSegments → les `planIndex`/`toPlanIndex`
 * des segments indexent ce tableau.
 */
export function resolveFilmPlans(film: SceneFilm, scene: Scene): SceneFilmPlan[] {
  return (film.plans ?? [])
    .filter(p => (p.points?.length ?? 0) > 0)
    .map(p => p.background != null ? p : { ...p, background: scene.background, foreground: scene.foreground })
}

/**
 * Pont entre le director (pur) et les primitives du ScenePlayer (closures du
 * useEffect PIXI). Le director ne connaît ni React ni PIXI.
 */
export interface FilmDirectorAdapter {
  startTravel(target: { x: number; y: number } | null, opts: FilmTravelOpts): void
  /** Son de trajet : HTMLAudio empilé dans animSoundAudiosRef (la pause film le gèle). */
  playTravelSound(sound: SceneSound): void
  /** Coupe les sons de trajet en cours (à l'arrivée à un point). */
  stopTravelSounds(): void
  playAction(action: SceneAction, btnId: string): void
  isActionPlaying(): boolean
  isActionPlayable(action: SceneAction): boolean
  /** Lance le changement de plan (transition visuelle + swap décor/caméra). */
  startPlanSwitch(toPlanIndex: number, transition: FilmPlanTransition): void
  /** true quand la transition est finie ET le décor du nouveau plan est prêt. */
  isPlanSwitchDone(): boolean
  /** true quand MultiAnimationPlayback est revenu au rest (pas en transition). */
  isPlaybackSettled(): boolean
  getSceneState(): SceneState
  isExited(): boolean
  /** Alpha du fade de fin [0,1] appliqué au rendu par le ScenePlayer. */
  setFilmFade(alpha01: number): void
  /** Fin de film — appelé une seule fois. */
  onEnd(): void
}

export interface FilmProgress {
  segmentIndex: number
  segmentElapsedMs: number
  totalElapsedMs: number
  /** Progression globale [0,1] basée sur les durées estimées (ne recule jamais). */
  ratio: number
}

/** Timeout anti-deadlock de la phase settle (un overlay physics peut traîner). */
const SETTLE_TIMEOUT_MS = 1500
/** Petit délai de grâce après le settle, avant le segment suivant. */
const SETTLE_GRACE_MS = 120
/** Durée du fade de fin de film. */
const ENDING_FADE_MS = 400

/**
 * Segment interne du chemin : le film (tous plans confondus) est aplati en une
 * séquence [entryTravel, action?, pause?, departureTravel?, …, planSwitch, …,
 * endingTravel? ]. `planIndex` = index du plan du segment (progression, edges).
 */
export type FilmSegment =
  | { kind: 'travel'; planIndex: number; target: { x: number; y: number } | null; opts: FilmTravelOpts; sound?: SceneSound }
  | { kind: 'action'; planIndex: number; action: SceneAction }
  | { kind: 'pause'; planIndex: number; durationMs: number }
  | { kind: 'planSwitch'; planIndex: number; toPlanIndex: number; transition: FilmPlanTransition }

function phaseForSegment(seg: FilmSegment): FilmPhase {
  switch (seg.kind) {
    case 'travel': return 'travel'
    case 'action': return 'action'
    case 'pause': return 'pause'
    case 'planSwitch': return 'planSwitch'
  }
}

/**
 * Machine d'états du mode film v2 (chemin de points) : entrée hors-champ → pour
 * chaque point : trajet puis action éventuelle → fin (sortie de champ ou sur
 * place) → fade → onEnd(). Fins détectées par polling (pattern maison).
 *
 * `update(deltaMs)` doit être appelé chaque frame du ticker UNIQUEMENT quand le
 * player est en lecture — la pause gèle donc le director par construction.
 */
export class FilmDirector {
  private segments: FilmSegment[]
  private adapter: FilmDirectorAdapter
  private _phase: FilmPhase = 'idle'
  private segIndex = 0
  private launched = false
  private segmentElapsedMs = 0
  private settleElapsedMs = 0
  private settleGraceMs = 0
  private endingElapsedMs = 0
  private terminalTravel = false
  private estimatedSegMs: number[] | null = null
  private endedOnce = false

  constructor(film: SceneFilm, adapter: FilmDirectorAdapter) {
    this.adapter = adapter
    this.segments = buildFilmSegments(film)
  }

  /** Durées estimées par segment (via estimateFilmDurations), pour la progression. */
  setEstimatedDurations(segMs: number[]): void {
    this.estimatedSegMs = segMs
  }

  /** À appeler quand la scène est prête (état 'interaction' initial). Idempotent. */
  start(): void {
    if (this._phase !== 'idle') return
    if (this.segments.length === 0) {
      this.beginEnding()
      return
    }
    this.segIndex = 0
    this.launched = false
    this.segmentElapsedMs = 0
    this._phase = phaseForSegment(this.segments[0])
  }

  get phase(): FilmPhase {
    return this._phase
  }

  get progress(): FilmProgress {
    const est = this.estimatedSegMs
    let totalElapsedMs = this.segmentElapsedMs
    let ratio = 0
    if (est && est.length === this.segments.length) {
      const totalMs = est.reduce((a, b) => a + b, 0)
      let doneMs = 0
      for (let i = 0; i < this.segIndex && i < est.length; i++) doneMs += est[i]
      const inSeg = (this._phase === 'done' || this._phase === 'ending')
        ? 0
        : Math.min(this.segmentElapsedMs, est[this.segIndex] ?? 0)
      totalElapsedMs = (this._phase === 'done' || this._phase === 'ending') ? doneMs + (est[this.segIndex] ?? 0) : doneMs + inSeg
      ratio = totalMs > 0 ? Math.min(1, totalElapsedMs / totalMs) : 0
    }
    if (this._phase === 'done') ratio = 1
    return { segmentIndex: this.segIndex, segmentElapsedMs: this.segmentElapsedMs, totalElapsedMs, ratio }
  }

  update(deltaMs: number): void {
    switch (this._phase) {
      case 'idle':
      case 'done':
        return
      case 'ending': {
        this.endingElapsedMs += deltaMs
        const t = Math.min(1, this.endingElapsedMs / ENDING_FADE_MS)
        this.adapter.setFilmFade(1 - t)
        if (t >= 1) this.finish()
        return
      }
      case 'settle': {
        this.settleElapsedMs += deltaMs
        const settled = this.adapter.isPlaybackSettled() || this.settleElapsedMs >= SETTLE_TIMEOUT_MS
        if (!settled) return
        this.settleGraceMs += deltaMs
        if (this.settleGraceMs < SETTLE_GRACE_MS) return
        this.advance()
        return
      }
      case 'travel':
      case 'action':
      case 'pause':
      case 'planSwitch':
        this.updateSegment(deltaMs)
        return
    }
  }

  private updateSegment(deltaMs: number): void {
    const seg = this.segments[this.segIndex]
    if (!seg) { this.beginEnding(); return }
    this.segmentElapsedMs += deltaMs

    if (seg.kind === 'pause') {
      // Attente idle au point : le perso reste en interaction, rien à lancer.
      if (this.segmentElapsedMs >= seg.durationMs) this.advance()
      return
    }

    if (seg.kind === 'planSwitch') {
      // Changement de plan : transition visuelle + swap décor. Fin par polling
      // (attend aussi le chargement du décor du nouveau plan).
      if (!this.launched) {
        this.launched = true
        this.adapter.startPlanSwitch(seg.toPlanIndex, seg.transition)
        return
      }
      if (this.adapter.isPlanSwitchDone()) this.advance()
      return
    }

    if (seg.kind === 'travel') {
      if (!this.launched) {
        this.launched = true
        this.terminalTravel = seg.opts.offscreenEnd != null && seg.opts.terminal !== false
        this.adapter.startTravel(seg.target, seg.opts)
        if (seg.sound) this.adapter.playTravelSound(seg.sound)
        return
      }
      const arrived = this.terminalTravel
        ? this.adapter.isExited()
        : this.adapter.getSceneState() === 'interaction'
      if (arrived) {
        this.adapter.stopTravelSounds()
        if (this.terminalTravel) this.beginEnding()
        else this.advance()
      }
      return
    }

    // seg.kind === 'action'
    if (!this.launched) {
      if (!this.adapter.isActionPlayable(seg.action)) {
        console.warn(`[FilmDirector] action "${seg.action.name}" non jouable (animation manquante) — ignorée`)
        this.advance()
        return
      }
      this.launched = true
      this.adapter.playAction(seg.action, 'film')
      return
    }
    // Fin = expiration du timer d'action (actionPlayingRef repasse à false),
    // puis settle (trans-in du MultiAnimationPlayback) avant le segment suivant.
    if (!this.adapter.isActionPlaying()) this.beginSettle()
  }

  private beginSettle(): void {
    this._phase = 'settle'
    this.settleElapsedMs = 0
    this.settleGraceMs = 0
  }

  private advance(): void {
    this.segIndex += 1
    this.segmentElapsedMs = 0
    this.launched = false
    if (this.segIndex >= this.segments.length) {
      this.beginEnding()
    } else {
      this._phase = phaseForSegment(this.segments[this.segIndex])
    }
  }

  private beginEnding(): void {
    this._phase = 'ending'
    this.endingElapsedMs = 0
  }

  private finish(): void {
    this._phase = 'done'
    if (!this.endedOnce) {
      this.endedOnce = true
      this.adapter.onEnd()
    }
  }
}

/** Aplatit un SceneFilm (tous plans) en segments jouables. Exporté pour l'estimation de durées. */
export function buildFilmSegments(film: SceneFilm): FilmSegment[] {
  const segments: FilmSegment[] = []
  const plans = (film.plans ?? []).filter(pl => (pl.points?.length ?? 0) > 0)

  plans.forEach((plan, k) => {
    const points = plan.points
    const isLastPlan = k === plans.length - 1

    const resolveOpts = (
      travel: import('../types/project').FilmTravel,
      scaleFrom: number,
      scaleTo: number,
    ): FilmTravelOpts => ({
      speedPxPerSec: Math.max(1, travel.speedPxPerSec ?? plan.moveSpeedPxPerSec ?? film.moveSpeedPxPerSec),
      scaleFrom,
      scaleTo,
      ...((travel.animationId ?? plan.moveAnimationId ?? film.moveAnimationId) != null
        && { animationId: travel.animationId ?? plan.moveAnimationId ?? film.moveAnimationId }),
      ...(travel.animSpeedMul != null && { animSpeedMul: travel.animSpeedMul }),
      ...(travel.controlPoints != null && travel.controlPoints.length > 0 && { controlPoints: travel.controlPoints }),
      ...(travel.easing != null && { easing: travel.easing }),
    })

    // Échelle "cursor" = échelle du perso à la fin du segment précédent.
    let cursorScale = points[0].scale

    for (let i = 0; i < points.length; i++) {
      const p = points[i]
      const origin = p.travel.origin
      // Origine résolue du trajet entrant : téléportation (offscreen/custom) →
      // scaleFrom = échelle du point (pas d'interpolation après téléport).
      let scaleFrom = cursorScale
      const originOpts: Partial<FilmTravelOpts> = {}
      if (origin?.kind === 'offscreen') {
        originOpts.offscreenStart = origin.side
        scaleFrom = p.scale
      } else if (origin?.kind === 'custom') {
        originOpts.startAt = { x: origin.x, y: origin.y }
        scaleFrom = p.scale
      } else if (origin?.kind === 'appear') {
        // Apparition : trajet de longueur nulle — le perso est posé sur le point.
        originOpts.startAt = { x: p.x, y: p.y }
        scaleFrom = p.scale
      } else if (i === 0) {
        // Entrée du plan : hors-champ par le côté d'entrée du plan.
        originOpts.offscreenStart = plan.entrySide
        scaleFrom = p.scale
      }
      segments.push({
        kind: 'travel',
        planIndex: k,
        target: { x: p.x, y: p.y },
        opts: {
          ...resolveOpts(p.travel, scaleFrom, p.scale),
          ...originOpts,
          ...(p.facing != null && { arriveFacing: p.facing }),
        },
        ...(p.travel.sound != null && { sound: p.travel.sound }),
      })
      cursorScale = p.scale
      if (p.action && p.action.steps.length > 0) {
        segments.push({ kind: 'action', planIndex: k, action: p.action })
      }
      if (p.pauseMs != null && p.pauseMs > 0) {
        segments.push({ kind: 'pause', planIndex: k, durationMs: p.pauseMs })
      }
      if (p.departure) {
        const target = p.departure.target
        if (target.kind === 'offscreen') {
          segments.push({
            kind: 'travel',
            planIndex: k,
            target: null,
            opts: { ...resolveOpts(p.departure.travel, p.scale, p.scale), offscreenEnd: target.side, terminal: false },
            ...(p.departure.travel.sound != null && { sound: p.departure.travel.sound }),
          })
        } else {
          const depScale = target.scale ?? p.scale
          segments.push({
            kind: 'travel',
            planIndex: k,
            target: { x: target.x, y: target.y },
            opts: resolveOpts(p.departure.travel, p.scale, depScale),
            ...(p.departure.travel.sound != null && { sound: p.departure.travel.sound }),
          })
          cursorScale = depScale
        }
      }
    }

    if (plan.ending.kind === 'exit') {
      // Sortie du plan : TERMINALE uniquement sur le dernier plan (fade + Bravo) ;
      // sinon le perso sort du champ puis la transition enchaîne le plan suivant.
      segments.push({
        kind: 'travel',
        planIndex: k,
        target: null,
        opts: {
          ...resolveOpts(plan.ending.travel, cursorScale, cursorScale),
          offscreenEnd: plan.ending.side,
          ...(!isLastPlan && { terminal: false }),
        },
        ...(plan.ending.travel.sound != null && { sound: plan.ending.travel.sound }),
      })
    }

    if (!isLastPlan) {
      segments.push({
        kind: 'planSwitch',
        planIndex: k,
        toPlanIndex: k + 1,
        transition: plan.transitionToNext ?? { kind: 'cut' },
      })
    }
  })

  return segments
}
