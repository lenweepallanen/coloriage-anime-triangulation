import type { Point2D } from '../types/project'
import { LoopPlayback } from './loopPlayback'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

export type PlaybackState = 'rest' | 'wait' | 'trans-out' | 'oneshot' | 'trans-in'

export interface OneshotAnimation {
  id: string
  name: string
  frames: Point2D[][]
}

export interface MultiAnimationPlaybackOptions {
  fps?: number
  crossfadeFrames?: number
  transitionFrames?: number
  speed?: number
}

export class MultiAnimationPlayback {
  private restPlayback: LoopPlayback
  private oneshotData: Map<string, Point2D[][]>
  private oneshotNames: Map<string, string>
  private _state: PlaybackState = 'rest'
  private pendingOneshotId: string | null = null
  private activeOneshotId: string | null = null

  // Transition state
  private transitionFrames: number
  private transitionCursor: number = 0
  private transitionFrom: Point2D[] = []
  private transitionTo: Point2D[] = []

  // Oneshot playback state
  private oneshotCursor: number = 0
  private oneshotTotalFrames: number = 0
  private fps: number
  private _speed: number

  constructor(
    restFrames: Point2D[][],
    oneshotAnimations: OneshotAnimation[],
    options?: MultiAnimationPlaybackOptions,
  ) {
    this.fps = options?.fps ?? 24
    this._speed = options?.speed ?? 1.0
    this.transitionFrames = options?.transitionFrames ?? 7

    this.restPlayback = new LoopPlayback(restFrames, {
      fps: this.fps,
      crossfadeFrames: options?.crossfadeFrames ?? 7,
      speed: this._speed,
    })

    this.oneshotData = new Map()
    this.oneshotNames = new Map()
    for (const anim of oneshotAnimations) {
      this.oneshotData.set(anim.id, anim.frames)
      this.oneshotNames.set(anim.id, anim.name)
    }
  }

  requestOneshot(animId: string): void {
    if (!this.oneshotData.has(animId)) return
    // If already playing or transitioning, queue
    if (this._state === 'rest') {
      this.pendingOneshotId = animId
      this._state = 'wait'
    } else if (this._state === 'wait') {
      // Replace pending
      this.pendingOneshotId = animId
    }
    // If playing oneshot or transitioning, ignore (current oneshot must finish)
  }

  advance(deltaTicks: number): void {
    const deltaSeconds = deltaTicks / 60

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
        }
        break
      }

      case 'oneshot': {
        const advance = this.fps * this._speed * deltaSeconds
        this.oneshotCursor += advance
        if (this.oneshotCursor >= this.oneshotTotalFrames - 1) {
          this.oneshotCursor = this.oneshotTotalFrames - 1
          this.startTransitionIn()
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
    switch (this._state) {
      case 'rest':
      case 'wait':
        return this.restPlayback.getPositions()

      case 'trans-out':
        return this.blend(
          this.transitionFrom,
          this.transitionTo,
          smoothstep(this.transitionCursor / this.transitionFrames)
        )

      case 'oneshot': {
        const frames = this.oneshotData.get(this.activeOneshotId!)!
        const f0 = Math.min(Math.floor(this.oneshotCursor), frames.length - 1)
        const f1 = Math.min(f0 + 1, frames.length - 1)
        const frac = this.oneshotCursor - Math.floor(this.oneshotCursor)
        return this.blend(frames[f0], frames[f1], frac)
      }

      case 'trans-in':
        return this.blend(
          this.transitionFrom,
          this.transitionTo,
          smoothstep(this.transitionCursor / this.transitionFrames)
        )
    }
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
  }

  private startTransitionIn(): void {
    const oneshotFrames = this.oneshotData.get(this.activeOneshotId!)!
    this._state = 'trans-in'
    this.transitionCursor = 0
    this.transitionFrom = oneshotFrames[oneshotFrames.length - 1]
    // Transition back to rest frame 0
    this.transitionTo = this.restPlayback.getPositions() // will be frame 0 area after seekFrame
    // Actually, get rest frame 0 positions directly
    this.restPlayback.seekFrame(0)
    this.transitionTo = this.restPlayback.getPositions()
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
