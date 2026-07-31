import type { SceneAction, SceneFilm, SceneSound } from '../types/project'
import type { FilmTravelOpts, SceneState } from './scenePlayback'

export type FilmPhase = 'idle' | 'travel' | 'action' | 'settle' | 'ending' | 'done'

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
 * Segment interne du chemin : le film est aplati en une séquence
 * [entryTravel, action?, travel, action?, …, endingTravel? ] au constructeur.
 */
type FilmSegment =
  | { kind: 'travel'; target: { x: number; y: number } | null; opts: FilmTravelOpts; sound?: SceneSound }
  | { kind: 'action'; action: SceneAction }

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
    this._phase = this.segments[0].kind === 'travel' ? 'travel' : 'action'
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
        this.updateSegment(deltaMs)
        return
    }
  }

  private updateSegment(deltaMs: number): void {
    const seg = this.segments[this.segIndex]
    if (!seg) { this.beginEnding(); return }
    this.segmentElapsedMs += deltaMs

    if (seg.kind === 'travel') {
      if (!this.launched) {
        this.launched = true
        this.terminalTravel = seg.opts.offscreenEnd != null
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
      this._phase = this.segments[this.segIndex].kind === 'travel' ? 'travel' : 'action'
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

/** Aplatit un SceneFilm v2 en segments jouables. Exporté pour l'estimation de durées. */
export function buildFilmSegments(film: SceneFilm): FilmSegment[] {
  const segments: FilmSegment[] = []
  const points = film.points ?? []
  if (points.length === 0) return segments

  const resolveOpts = (
    travel: import('../types/project').FilmTravel,
    scaleFrom: number,
    scaleTo: number,
  ): FilmTravelOpts => ({
    speedPxPerSec: Math.max(1, travel.speedPxPerSec ?? film.moveSpeedPxPerSec),
    scaleFrom,
    scaleTo,
    ...((travel.animationId ?? film.moveAnimationId) != null && { animationId: travel.animationId ?? film.moveAnimationId }),
    ...(travel.animSpeedMul != null && { animSpeedMul: travel.animSpeedMul }),
  })

  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const scaleFrom = i === 0 ? p.scale : points[i - 1].scale
    segments.push({
      kind: 'travel',
      target: { x: p.x, y: p.y },
      opts: {
        ...resolveOpts(p.travel, scaleFrom, p.scale),
        ...(i === 0 && { offscreenStart: film.entrySide }),
      },
      ...(p.travel.sound != null && { sound: p.travel.sound }),
    })
    if (p.action && p.action.steps.length > 0) {
      segments.push({ kind: 'action', action: p.action })
    }
  }

  if (film.ending.kind === 'exit') {
    const lastScale = points[points.length - 1].scale
    segments.push({
      kind: 'travel',
      target: null,
      opts: {
        ...resolveOpts(film.ending.travel, lastScale, lastScale),
        offscreenEnd: film.ending.side,
      },
      ...(film.ending.travel.sound != null && { sound: film.ending.travel.sound }),
    })
  }

  return segments
}
