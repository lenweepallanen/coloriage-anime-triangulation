import type { Scene, SceneRestPoint } from '../types/project'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

export type SceneState = 'entering' | 'interaction' | 'blend'

export interface ScenePlaybackConfig {
  scene: Scene
  viewportWidth: number
  viewportHeight: number
  onRestPointArrival?: (restPoint: SceneRestPoint) => void
}

/**
 * Machine d'états simplifiée pour la lecture d'une scène :
 *   - `entering` (uniquement si `scene.entry === 'moving'`) : trajet de `entryStartX`
 *     vers `restPoint.backgroundX` sur `entryDurationMs`, easing smoothstep.
 *   - `blend` : court fondu (7/24 s) entre la fin du trajet et l'idle.
 *   - `interaction` : idle, position figée au rest point, boutons ☆ actifs.
 */
export class ScenePlayback {
  private scene: Scene
  private _state: SceneState = 'interaction'
  private viewportWidth: number

  // Entering state
  private enterProgress: number = 0
  private enterDurationSec: number = 1.5
  private enterStartRawX: number = 0
  private enterEndRawX: number = 0
  private enterStartOffsetX: number = 0
  private enterEndOffsetX: number = 0

  private _backgroundOffsetX: number = 0
  private _currentX: number = 0

  private blendProgress: number = 0
  private blendDuration: number = 7 / 24

  private onRestPointArrival?: (restPoint: SceneRestPoint) => void

  constructor(config: ScenePlaybackConfig) {
    this.scene = config.scene
    this.viewportWidth = config.viewportWidth
    this.onRestPointArrival = config.onRestPointArrival

    const rp = this.scene.restPoint
    if (!rp) return

    if (this.scene.entry === 'moving' && this.scene.entryStartX != null) {
      this.enterStartRawX = this.scene.entryStartX
      this.enterEndRawX = rp.backgroundX
      this.enterStartOffsetX = this.computeOffsetForX(this.enterStartRawX)
      this.enterEndOffsetX = this.computeOffsetForX(this.enterEndRawX)
      this.enterDurationSec = Math.max(0.1, (this.scene.entryDurationMs ?? 1500) / 1000)
      this.enterProgress = 0
      this._currentX = this.enterStartRawX
      this._backgroundOffsetX = this.enterStartOffsetX
      this._state = 'entering'
    } else {
      this._currentX = rp.backgroundX
      this._backgroundOffsetX = this.computeOffsetForX(rp.backgroundX)
      this._state = 'interaction'
    }
  }

  private computeOffsetForX(x: number): number {
    const raw = x - this.viewportWidth / 2
    return this.clampOffset(raw)
  }

  private clampOffset(offset: number): number {
    const maxOffset = Math.max(0, this.getBgWidth() - this.viewportWidth)
    return Math.max(0, Math.min(maxOffset, offset))
  }

  private getBgWidth(): number {
    let w = 0
    for (const l of this.scene.backgroundLayers) {
      if (l.imageBlob && l.width > w) w = l.width
    }
    return w
  }

  /** No-op kept for backwards compatibility with callers (was used to advance multi-rest). */
  advance(): void {
    /* no-op : pas de multi-rest dans le nouveau modèle */
  }

  update(deltaSeconds: number): void {
    switch (this._state) {
      case 'interaction':
        break

      case 'entering': {
        if (this.enterDurationSec <= 0) {
          this.arriveAtRestPoint()
          break
        }
        this.enterProgress += deltaSeconds / this.enterDurationSec
        if (this.enterProgress >= 1) {
          this.enterProgress = 1
          this._backgroundOffsetX = this.enterEndOffsetX
          this._currentX = this.enterEndRawX
          this.arriveAtRestPoint()
        } else {
          const t = smoothstep(this.enterProgress)
          this._backgroundOffsetX = this.clampOffset(
            this.enterStartOffsetX + (this.enterEndOffsetX - this.enterStartOffsetX) * t
          )
          this._currentX = this.enterStartRawX + (this.enterEndRawX - this.enterStartRawX) * t
        }
        break
      }

      case 'blend': {
        this.blendProgress += deltaSeconds / this.blendDuration
        if (this.blendProgress >= 1) {
          this._state = 'interaction'
          this.blendProgress = 0
        }
        break
      }
    }
  }

  private arriveAtRestPoint(): void {
    const rp = this.scene.restPoint
    if (!rp) {
      this._state = 'interaction'
      return
    }
    this._currentX = rp.backgroundX
    this._backgroundOffsetX = this.computeOffsetForX(rp.backgroundX)
    this.onRestPointArrival?.(rp)
    this._state = 'blend'
    this.blendProgress = 0
  }

  // --- Public getters ---

  get backgroundOffsetX(): number {
    return this._backgroundOffsetX
  }

  get currentX(): number {
    return this._currentX
  }

  get currentState(): SceneState {
    return this._state
  }

  get currentRestPoint(): SceneRestPoint | null {
    return this.scene.restPoint ?? null
  }

  get isComplete(): boolean {
    return this._state === 'interaction'
  }

  get characterScale(): number {
    return this.scene.characterScale
  }

  get characterY(): number {
    return this.scene.characterY
  }

  /** Animation jouée pendant la phase d'entrée : entryAnimationId si défini, sinon idle du restPoint. */
  get currentSegmentAnimationId(): string | undefined {
    if (this._state !== 'entering') return undefined
    return this.scene.entryAnimationId ?? this.scene.restPoint?.restAnimationId
  }

  get interactionRestAnimationId(): string | undefined {
    if (this._state !== 'interaction' && this._state !== 'blend') return undefined
    return this.currentRestPoint?.restAnimationId
  }

  /**
   * Animations disponibles (déclenchables) au rest point courant — utilisé pour le
   * gating UI du bouton ☆. Retourne le flatmap des actions, fallback legacy
   * `randomAnimationIds` si présent.
   */
  get interactionAnimationIds(): string[] {
    if (this._state !== 'interaction' && this._state !== 'blend') return []
    const rp = this.currentRestPoint
    if (!rp) return []
    if (rp.actions && rp.actions.length > 0) {
      return rp.actions.flatMap(a => a.steps.map(s => s.animationId))
    }
    return rp.randomAnimationIds ?? []
  }

  get blendAlpha(): number {
    if (this._state !== 'blend') return 0
    return smoothstep(this.blendProgress)
  }

  /** Progression du trajet d'entrée [0,1], 0 hors phase 'entering'. */
  get segmentAlpha(): number {
    if (this._state !== 'entering') return 0
    return this.enterProgress
  }

  setViewportWidth(width: number): void {
    this.viewportWidth = width
    if (this._state === 'interaction') {
      const rp = this.scene.restPoint
      if (rp) this._backgroundOffsetX = this.computeOffsetForX(rp.backgroundX)
    }
  }

  get bgWidth(): number {
    return this.getBgWidth()
  }
}
