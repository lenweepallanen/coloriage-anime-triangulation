import type { Point2D } from '../types/project'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

export interface LoopPlaybackOptions {
  fps?: number
  crossfadeFrames?: number
  speed?: number
}

export class LoopPlayback {
  private frames: Point2D[][]
  private totalFrames: number
  private crossfadeN: number
  private effectiveLen: number
  private fps: number
  private _speed: number
  private cursor: number // fractional position in [0, effectiveLen)

  constructor(frames: Point2D[][], options?: LoopPlaybackOptions) {
    this.frames = frames
    this.totalFrames = frames.length
    this.fps = options?.fps ?? 24
    this._speed = options?.speed ?? 1.0

    const requestedN = options?.crossfadeFrames ?? 7
    // Clamp so effective length is at least 1
    this.crossfadeN = Math.min(requestedN, Math.floor(this.totalFrames / 2))
    this.effectiveLen = this.totalFrames - this.crossfadeN

    this.cursor = 0
  }

  /** Advance by PIXI ticker delta (in frames at 60fps) */
  advance(deltaTicks: number): void {
    if (this.totalFrames <= 1) return
    const deltaSeconds = deltaTicks / 60
    this.cursor += this.fps * this._speed * deltaSeconds
    if (this.effectiveLen > 0) {
      this.cursor = ((this.cursor % this.effectiveLen) + this.effectiveLen) % this.effectiveLen
    }
  }

  /** Advance by milliseconds (for requestAnimationFrame) */
  advanceMs(deltaMs: number): void {
    if (this.totalFrames <= 1) return
    const deltaSeconds = deltaMs / 1000
    this.cursor += this.fps * this._speed * deltaSeconds
    if (this.effectiveLen > 0) {
      this.cursor = ((this.cursor % this.effectiveLen) + this.effectiveLen) % this.effectiveLen
    }
  }

  /** Get blended positions for the current cursor */
  getPositions(): Point2D[] {
    const L = this.totalFrames
    if (L === 0) return []
    if (L === 1) return this.frames[0]

    const N = this.crossfadeN
    const f0 = Math.floor(this.cursor)
    const frac = this.cursor - f0

    // Clamp f0 within bounds
    const i0 = Math.min(f0, this.effectiveLen - 1)
    const i1 = (i0 + 1) % L // next frame (can reach into tail for sub-frame interp)

    const numPoints = this.frames[0].length

    // No crossfade: simple sub-frame interpolation
    if (N === 0) {
      const a = this.frames[i0]
      const b = this.frames[i1 % L]
      const out: Point2D[] = new Array(numPoints)
      for (let i = 0; i < numPoints; i++) {
        out[i] = {
          x: a[i].x + (b[i].x - a[i].x) * frac,
          y: a[i].y + (b[i].y - a[i].y) * frac,
        }
      }
      return out
    }

    // With crossfade
    // For frame index f in [0, N): blend tail frame (L-N+f) with primary frame (f)
    // alpha = smoothstep(f / N): 0 = full tail, 1 = full primary
    const out: Point2D[] = new Array(numPoints)

    // Get blended position for a single integer frame
    const blendAt = (idx: number): Point2D[] => {
      if (idx >= N) return this.frames[idx]
      const alpha = smoothstep(idx / N)
      const primary = this.frames[idx]
      const tail = this.frames[L - N + idx]
      const result: Point2D[] = new Array(numPoints)
      for (let i = 0; i < numPoints; i++) {
        result[i] = {
          x: tail[i].x * (1 - alpha) + primary[i].x * alpha,
          y: tail[i].y * (1 - alpha) + primary[i].y * alpha,
        }
      }
      return result
    }

    const b0 = blendAt(i0)
    const b1 = blendAt(i1 < this.effectiveLen ? i1 : i1 % this.effectiveLen)

    for (let i = 0; i < numPoints; i++) {
      out[i] = {
        x: b0[i].x + (b1[i].x - b0[i].x) * frac,
        y: b0[i].y + (b1[i].y - b0[i].y) * frac,
      }
    }
    return out
  }

  get currentFrame(): number {
    return Math.floor(this.cursor)
  }

  get effectiveLength(): number {
    return this.effectiveLen
  }

  set speed(v: number) {
    this._speed = v
  }

  get speed(): number {
    return this._speed
  }

  seekFrame(frame: number): void {
    this.cursor = Math.max(0, Math.min(frame, this.effectiveLen - 1))
  }

  reset(): void {
    this.cursor = 0
  }
}
