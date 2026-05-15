import type { Point2D } from '../types/project'

export interface OncePlaybackOptions {
  fps?: number
  speed?: number
}

/** Linear, non-looping playback. Holds the last frame and exposes `isFinished`. */
export class OncePlayback {
  private frames: Point2D[][]
  private fps: number
  private _speed: number
  private cursor: number
  private _finished: boolean

  constructor(frames: Point2D[][], options?: OncePlaybackOptions) {
    this.frames = frames
    this.fps = options?.fps ?? 24
    this._speed = options?.speed ?? 1
    this.cursor = 0
    this._finished = frames.length <= 1
  }

  advance(deltaTicks: number): void {
    if (this._finished) return
    const last = this.frames.length - 1
    this.cursor += this.fps * this._speed * (deltaTicks / 60)
    if (this.cursor >= last) {
      this.cursor = last
      this._finished = true
    }
  }

  getPositions(): Point2D[] {
    if (this.frames.length === 0) return []
    const last = this.frames.length - 1
    const f0 = Math.min(Math.floor(this.cursor), last)
    const f1 = Math.min(f0 + 1, last)
    const frac = this.cursor - f0
    const a = this.frames[f0]
    if (f0 === f1 || frac === 0) return a
    const b = this.frames[f1]
    const out: Point2D[] = new Array(a.length)
    for (let i = 0; i < a.length; i++) {
      out[i] = { x: a[i].x * (1 - frac) + b[i].x * frac, y: a[i].y * (1 - frac) + b[i].y * frac }
    }
    return out
  }

  get isFinished(): boolean { return this._finished }
}
