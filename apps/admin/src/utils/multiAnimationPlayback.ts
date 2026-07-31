import type { Point2D } from '../types/project'
import { LoopPlayback } from './loopPlayback'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

function linear(t: number): number {
  return Math.max(0, Math.min(1, t))
}

export type TransitionEasing = 'smoothstep' | 'linear'

const EASING_FUNCTIONS: Record<TransitionEasing, (t: number) => number> = {
  smoothstep,
  linear,
}

export type PlaybackState = 'rest' | 'wait' | 'trans-out' | 'oneshot' | 'trans-in'

export interface OneshotAnimation {
  id: string
  name: string
  frames: Point2D[][]
  overlay?: boolean
  transitionEasing?: TransitionEasing  // per-animation override
}

export interface MultiAnimationPlaybackOptions {
  fps?: number
  crossfadeFrames?: number
  transitionFrames?: number
  transitionEasing?: TransitionEasing  // default easing for all transitions
  speed?: number
  onOneshotStart?: (animId: string) => void
  onOverlayStart?: (animId: string) => void
}

export class MultiAnimationPlayback {
  private restPlayback: LoopPlayback
  private oneshotData: Map<string, Point2D[][]>
  private oneshotNames: Map<string, string>
  private oneshotEasings: Map<string, TransitionEasing>
  private _state: PlaybackState = 'rest'
  private pendingOneshotId: string | null = null
  private activeOneshotId: string | null = null
  /** Queue d'animations à enchaîner après l'oneshot courant (sans repasser par la rest). */
  private oneshotQueue: string[] = []
  /** Multiplicateurs de vitesse de lecture par oneshot, posés à requestSequence (défaut 1). */
  private oneshotPlaySpeeds: Map<string, number> = new Map()

  // Transition state
  private transitionFrames: number
  private defaultEasing: TransitionEasing
  private activeEasing: (t: number) => number = smoothstep
  private transitionCursor: number = 0
  private transitionFrom: Point2D[] = []
  private transitionTo: Point2D[] = []

  // Oneshot playback state
  private oneshotCursor: number = 0
  private oneshotTotalFrames: number = 0
  private fps: number
  private _speed: number

  // Overlay state (physics animations that play on top of rest)
  private overlayIds: Set<string> = new Set()
  private overlayBasePositions: Map<string, Point2D[]> = new Map() // frame 0 of overlay anim
  private activeOverlayId: string | null = null
  private overlayCursor: number = 0
  private overlayTotalFrames: number = 0

  // Audio callbacks
  private onOneshotStart?: (animId: string) => void
  private onOverlayStart?: (animId: string) => void

  constructor(
    restFrames: Point2D[][],
    oneshotAnimations: OneshotAnimation[],
    options?: MultiAnimationPlaybackOptions,
  ) {
    this.fps = options?.fps ?? 24
    this._speed = options?.speed ?? 1.0
    this.transitionFrames = options?.transitionFrames ?? 7
    this.defaultEasing = options?.transitionEasing ?? 'smoothstep'
    this.onOneshotStart = options?.onOneshotStart
    this.onOverlayStart = options?.onOverlayStart

    this.restPlayback = new LoopPlayback(restFrames, {
      fps: this.fps,
      crossfadeFrames: options?.crossfadeFrames ?? 7,
      speed: this._speed,
    })

    this.oneshotData = new Map()
    this.oneshotNames = new Map()
    this.oneshotEasings = new Map()
    for (const anim of oneshotAnimations) {
      this.oneshotData.set(anim.id, anim.frames)
      this.oneshotNames.set(anim.id, anim.name)
      if (anim.transitionEasing) {
        this.oneshotEasings.set(anim.id, anim.transitionEasing)
      }
      if (anim.overlay) {
        this.overlayIds.add(anim.id)
        this.overlayBasePositions.set(anim.id, anim.frames[0])
      }
    }
  }

  requestOneshot(animId: string): void {
    this.requestSequence([animId])
  }

  /**
   * Joue une séquence d'animations à la suite (sans retour rest entre les éléments).
   * - Si une seule animation : équivalent à l'ancien `requestOneshot`.
   * - Si plusieurs : la 1ʳᵉ démarre via le pipeline rest→trans-out→oneshot habituel,
   *   les suivantes s'enchaînent directement par un court blend `trans-out` entre la
   *   dernière frame de l'oneshot précédent et la frame 0 de l'oneshot suivant.
   * Le 1ᵉʳ id de la séquence peut être un overlay : dans ce cas il démarre
   *   immédiatement et les éventuelles suivantes sont ignorées (overlay ≠ séquence).
   */
  requestSequence(animIds: string[], playSpeeds?: number[]): void {
    if (animIds.length === 0) return
    // `playSpeeds[i]` = multiplicateur de vitesse de lecture de animIds[i] (défaut 1).
    const entries = animIds
      .map((id, i) => ({ id, speed: playSpeeds?.[i] ?? 1 }))
      .filter(e => this.oneshotData.has(e.id))
    if (entries.length === 0) return
    for (const e of entries) this.oneshotPlaySpeeds.set(e.id, e.speed)
    const validIds = entries.map(e => e.id)

    const firstId = validIds[0]

    // Overlay : démarrage immédiat, pas de queue
    if (this.overlayIds.has(firstId)) {
      this.activeOverlayId = firstId
      this.overlayCursor = 0
      this.overlayTotalFrames = this.oneshotData.get(firstId)!.length
      this.onOverlayStart?.(firstId)
      return
    }

    const rest = validIds.slice(1)

    if (this._state === 'rest') {
      this.pendingOneshotId = firstId
      this.oneshotQueue = rest
      this._state = 'wait'
    } else if (this._state === 'wait') {
      this.pendingOneshotId = firstId
      this.oneshotQueue = rest
    }
    // Si on est en oneshot/transition : on ignore (la séquence courante doit finir)
  }

  advance(deltaTicks: number): void {
    const deltaSeconds = deltaTicks / 60

    // Advance overlay independently
    if (this.activeOverlayId) {
      const advance = this.fps * this._speed * (this.oneshotPlaySpeeds.get(this.activeOverlayId) ?? 1) * deltaSeconds
      this.overlayCursor += advance
      if (this.overlayCursor >= this.overlayTotalFrames - 1) {
        this.activeOverlayId = null
        this.overlayCursor = 0
      }
    }

    switch (this._state) {
      case 'rest':
        this.restPlayback.advance(deltaTicks)
        break

      case 'wait': {
        // Keep playing rest, detect loop point (cursor wraps back to beginning)
        const prevFrame = this.restPlayback.currentFrame
        this.restPlayback.advance(deltaTicks)
        const curFrame = this.restPlayback.currentFrame

        // Detect loop: frame number decreased (wrapped around)
        if (curFrame < prevFrame) {
          this.startTransitionOut()
        }
        break
      }

      case 'trans-out': {
        const advance = this.fps * this._speed * deltaSeconds
        this.transitionCursor += advance
        if (this.transitionCursor >= this.transitionFrames) {
          this._state = 'oneshot'
          this.oneshotCursor = 0
          this.onOneshotStart?.(this.activeOneshotId!)
        }
        break
      }

      case 'oneshot': {
        const playMul = this.activeOneshotId ? (this.oneshotPlaySpeeds.get(this.activeOneshotId) ?? 1) : 1
        const advance = this.fps * this._speed * playMul * deltaSeconds
        this.oneshotCursor += advance
        if (this.oneshotCursor >= this.oneshotTotalFrames - 1) {
          this.oneshotCursor = this.oneshotTotalFrames - 1
          // Si la queue n'est pas vide, chaîner directement sur le prochain oneshot
          // sans repasser par la rest (court blend entre last frame courant → frame 0 suivant).
          if (this.oneshotQueue.length > 0) {
            this.startNextInQueue()
          } else {
            this.startTransitionIn()
          }
        }
        break
      }

      case 'trans-in': {
        const advance = this.fps * this._speed * deltaSeconds
        this.transitionCursor += advance
        if (this.transitionCursor >= this.transitionFrames) {
          this._state = 'rest'
          this.restPlayback.seekFrame(0)
          this.activeOneshotId = null
        }
        break
      }
    }
  }

  getPositions(): Point2D[] {
    let positions: Point2D[]

    switch (this._state) {
      case 'rest':
      case 'wait':
        positions = this.restPlayback.getPositions()
        break

      case 'trans-out':
        positions = this.blend(
          this.transitionFrom,
          this.transitionTo,
          this.activeEasing(this.transitionCursor / this.transitionFrames)
        )
        break

      case 'oneshot': {
        const frames = this.oneshotData.get(this.activeOneshotId!)!
        const f0 = Math.min(Math.floor(this.oneshotCursor), frames.length - 1)
        const f1 = Math.min(f0 + 1, frames.length - 1)
        const frac = this.oneshotCursor - Math.floor(this.oneshotCursor)
        positions = this.blend(frames[f0], frames[f1], frac)
        break
      }

      case 'trans-in':
        positions = this.blend(
          this.transitionFrom,
          this.transitionTo,
          this.activeEasing(this.transitionCursor / this.transitionFrames)
        )
        break
    }

    // Apply overlay displacement on top
    if (this.activeOverlayId) {
      positions = this.applyOverlay(positions)
    }

    return positions
  }

  get currentState(): PlaybackState {
    return this._state
  }

  get isPlayingOneshot(): boolean {
    return this._state === 'oneshot' || this._state === 'trans-out' || this._state === 'trans-in'
  }

  get activeOneshotName(): string | null {
    if (!this.activeOneshotId) return null
    return this.oneshotNames.get(this.activeOneshotId) ?? null
  }

  /**
   * Pour un consommateur externe (ex: openness mâchoire) qui doit lire une
   * valeur par-frame indexée sur l'animation actuellement en lecture.
   * Renvoie l'id de l'animation active (rest si null) et son frame courant.
   * Pendant une transition, on retourne l'animation cible (trans-out → oneshot,
   * trans-in → rest) pour éviter les sauts de mâchoire au début/fin d'oneshot.
   */
  getActiveFrameRef(): { animId: string | null; frame: number; overlayAnimId: string | null; overlayFrame: number } {
    let animId: string | null = null
    let frame = 0
    switch (this._state) {
      case 'rest':
      case 'wait':
      case 'trans-in':
        animId = null
        frame = this.restPlayback.currentFrame
        break
      case 'trans-out':
      case 'oneshot':
        animId = this.activeOneshotId
        frame = Math.max(0, Math.floor(this.oneshotCursor))
        break
    }
    return {
      animId,
      frame,
      overlayAnimId: this.activeOverlayId,
      overlayFrame: Math.max(0, Math.floor(this.overlayCursor)),
    }
  }

  set speed(v: number) {
    this._speed = v
    this.restPlayback.speed = v
  }

  get speed(): number {
    return this._speed
  }

  private startTransitionOut(): void {
    const oneshotId = this.pendingOneshotId!
    const oneshotFrames = this.oneshotData.get(oneshotId)!

    this.activeOneshotId = oneshotId
    this.pendingOneshotId = null
    this._state = 'trans-out'
    this.transitionCursor = 0
    this.transitionFrom = this.restPlayback.getPositions()
    this.transitionTo = oneshotFrames[0]
    this.oneshotTotalFrames = oneshotFrames.length
    // Resolve easing: per-animation override → global default
    const easingName = this.oneshotEasings.get(oneshotId) ?? this.defaultEasing
    this.activeEasing = EASING_FUNCTIONS[easingName]
  }

  private startNextInQueue(): void {
    const nextId = this.oneshotQueue.shift()!
    const nextFrames = this.oneshotData.get(nextId)
    if (!nextFrames) {
      // Skip si manquante, essaie le suivant
      if (this.oneshotQueue.length > 0) {
        this.startNextInQueue()
      } else {
        this.startTransitionIn()
      }
      return
    }
    const prevFrames = this.oneshotData.get(this.activeOneshotId!)!
    this.activeOneshotId = nextId
    this._state = 'trans-out'
    this.transitionCursor = 0
    this.transitionFrom = prevFrames[prevFrames.length - 1]
    this.transitionTo = nextFrames[0]
    this.oneshotTotalFrames = nextFrames.length
    const easingName = this.oneshotEasings.get(nextId) ?? this.defaultEasing
    this.activeEasing = EASING_FUNCTIONS[easingName]
  }

  private startTransitionIn(): void {
    const oneshotFrames = this.oneshotData.get(this.activeOneshotId!)!
    this._state = 'trans-in'
    this.transitionCursor = 0
    this.transitionFrom = oneshotFrames[oneshotFrames.length - 1]
    // Easing stays the same as trans-out (same animation)
    this.restPlayback.seekFrame(0)
    this.transitionTo = this.restPlayback.getPositions()
  }

  get isOverlayActive(): boolean {
    return this.activeOverlayId !== null
  }

  private applyOverlay(positions: Point2D[]): Point2D[] {
    const overlayFrames = this.oneshotData.get(this.activeOverlayId!)!
    const basePos = this.overlayBasePositions.get(this.activeOverlayId!)!
    const f0 = Math.min(Math.floor(this.overlayCursor), overlayFrames.length - 1)
    const f1 = Math.min(f0 + 1, overlayFrames.length - 1)
    const frac = this.overlayCursor - Math.floor(this.overlayCursor)

    const len = Math.min(positions.length, basePos.length)
    const out: Point2D[] = new Array(len)
    for (let i = 0; i < len; i++) {
      // Interpolate overlay frame
      const ox = overlayFrames[f0][i].x * (1 - frac) + overlayFrames[f1][i].x * frac
      const oy = overlayFrames[f0][i].y * (1 - frac) + overlayFrames[f1][i].y * frac
      // displacement = overlay position - base position
      out[i] = {
        x: positions[i].x + (ox - basePos[i].x),
        y: positions[i].y + (oy - basePos[i].y),
      }
    }
    return out
  }

  private blend(a: Point2D[], b: Point2D[], t: number): Point2D[] {
    const len = Math.min(a.length, b.length)
    const out: Point2D[] = new Array(len)
    const oneMinusT = 1 - t
    for (let i = 0; i < len; i++) {
      out[i] = {
        x: a[i].x * oneMinusT + b[i].x * t,
        y: a[i].y * oneMinusT + b[i].y * t,
      }
    }
    return out
  }
}
