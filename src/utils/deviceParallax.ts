/**
 * DeviceParallax — wrapper for DeviceOrientation API with iOS permission
 * handling and exponential moving average smoothing.
 *
 * Provides normalized [-1, 1] offsets from device tilt for parallax effects.
 */

export interface ParallaxState {
  offsetX: number  // [-1, 1] left-right tilt
  offsetY: number  // [-1, 1] front-back tilt
}

interface ParallaxOptions {
  /** Max tilt angle (degrees) that maps to offset ±1. Default: 15 */
  sensitivity?: number
  /** EMA smoothing factor (0 = no smoothing, 1 = frozen). Default: 0.85 */
  smoothing?: number
}

export class DeviceParallax {
  private sensitivity: number
  private smoothing: number
  private rawX = 0
  private rawY = 0
  private smoothX = 0
  private smoothY = 0
  private listening = false
  private handler: ((e: DeviceOrientationEvent) => void) | null = null
  private permissionGranted = false

  constructor(options?: ParallaxOptions) {
    this.sensitivity = options?.sensitivity ?? 15
    this.smoothing = options?.smoothing ?? 0.85
  }

  /**
   * Request permission for device orientation (required on iOS 13+).
   * Must be called from a user gesture (click/tap handler).
   * Returns true if permission granted or not needed.
   */
  async requestPermission(): Promise<boolean> {
    // Check if DeviceOrientationEvent.requestPermission exists (iOS 13+)
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    if (typeof DOE.requestPermission === 'function') {
      try {
        const result = await DOE.requestPermission()
        this.permissionGranted = result === 'granted'
        return this.permissionGranted
      } catch {
        this.permissionGranted = false
        return false
      }
    }
    // No permission needed (Android, desktop)
    this.permissionGranted = true
    return true
  }

  /** Start listening to device orientation events. */
  start(): void {
    if (this.listening) return

    this.handler = (e: DeviceOrientationEvent) => {
      // gamma: left-right tilt (-90 to 90)
      // beta: front-back tilt (-180 to 180)
      const gamma = e.gamma ?? 0
      const beta = e.beta ?? 0

      // Detect landscape orientation: swap axes so parallax matches screen
      const angle = (screen.orientation?.angle ?? (window.orientation as number) ?? 0)
      const isLandscape = angle === 90 || angle === -90 || angle === 270

      if (isLandscape) {
        // In landscape, beta controls left-right and gamma controls up-down
        const sign = angle === 90 ? 1 : -1
        this.rawX = Math.max(-1, Math.min(1, (beta - 45) / this.sensitivity * sign))
        this.rawY = Math.max(-1, Math.min(1, -gamma / this.sensitivity * sign))
      } else {
        this.rawX = Math.max(-1, Math.min(1, gamma / this.sensitivity))
        this.rawY = Math.max(-1, Math.min(1, (beta - 45) / this.sensitivity))
      }
    }

    window.addEventListener('deviceorientation', this.handler)
    this.listening = true
  }

  /** Stop listening. */
  stop(): void {
    if (this.handler) {
      window.removeEventListener('deviceorientation', this.handler)
      this.handler = null
    }
    this.listening = false
  }

  /**
   * Get the current smoothed parallax offset.
   * Call this each frame in the render loop.
   */
  getOffset(): ParallaxState {
    // EMA: smooth = smooth * factor + raw * (1 - factor)
    const f = this.smoothing
    this.smoothX = this.smoothX * f + this.rawX * (1 - f)
    this.smoothY = this.smoothY * f + this.rawY * (1 - f)

    return { offsetX: this.smoothX, offsetY: this.smoothY }
  }

  /** Whether permission has been granted (or is not needed). */
  get hasPermission(): boolean {
    return this.permissionGranted
  }

  /** Whether the API is available at all. */
  static get isAvailable(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window
  }

  /** Whether iOS permission is required. */
  static get needsPermission(): boolean {
    const DOE = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>
    }
    return typeof DOE.requestPermission === 'function'
  }

  /** Clean up everything. */
  destroy(): void {
    this.stop()
    this.smoothX = 0
    this.smoothY = 0
    this.rawX = 0
    this.rawY = 0
  }
}
