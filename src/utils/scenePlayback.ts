import type { Scene, SceneRestPoint, SceneTransition, SceneSegment } from '../types/project'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

function easeInOut(t: number): number {
  return smoothstep(t)
}

export type SceneState = 'interaction' | 'segment' | 'blend'

export interface ScenePlaybackConfig {
  scene: Scene
  viewportWidth: number
  viewportHeight: number
  onRestPointArrival?: (restPointIndex: number, restPoint: SceneRestPoint) => void
  onSegmentStart?: (transitionIndex: number, segmentIndex: number) => void
}

/**
 * Resolves all X positions for a transition path (from → waypoints → to).
 */
function getTransitionXPositions(fromX: number, toX: number, transition: SceneTransition): number[] {
  return [fromX, ...transition.waypoints, toX]
}

/**
 * Pure state machine for scene playback with rest points + transitions.
 * Manages background scroll position and progression through rest points.
 */
export class ScenePlayback {
  private scene: Scene
  private _currentRestIndex: number = 0
  private _state: SceneState = 'interaction'
  private viewportWidth: number

  // Segment state (movement between two X positions)
  private segmentProgress: number = 0
  private segmentStartX: number = 0
  private segmentEndX: number = 0
  private segmentStartRawX: number = 0  // un-clamped X position at segment start
  private segmentEndRawX: number = 0    // un-clamped X position at segment end
  private segmentDuration: number = 0
  private _currentTransitionIndex: number = -1  // -1 = startTransition
  private _currentSegmentIndex: number = 0
  private _currentSegmentAnimationId?: string

  private _backgroundOffsetX: number = 0
  private _currentX: number = 0  // current character position on background (not clamped)

  // Blend state (brief transition between segment and interaction animations)
  private blendProgress: number = 0
  private blendDuration: number = 7 / 24

  // Callbacks
  private onRestPointArrival?: (restPointIndex: number, restPoint: SceneRestPoint) => void
  private onSegmentStart?: (transitionIndex: number, segmentIndex: number) => void

  constructor(config: ScenePlaybackConfig) {
    this.scene = config.scene
    this.viewportWidth = config.viewportWidth
    this.onRestPointArrival = config.onRestPointArrival
    this.onSegmentStart = config.onSegmentStart

    // Initialize based on startMode
    if (this.scene.restPoints.length === 0) return

    if (this.scene.startMode === 'transition' && this.scene.startTransition && this.scene.startX != null) {
      // Start in movement: traverse startTransition segments → restPoints[0]
      this._currentX = this.scene.startX
      this._backgroundOffsetX = this.computeOffsetForX(this.scene.startX)
      this._currentTransitionIndex = -1
      this.startTransitionSegments(-1)
    } else {
      // Start at rest point 0
      this._currentX = this.scene.restPoints[0]?.backgroundX ?? 0
      this._backgroundOffsetX = this.computeOffsetForRestPoint(0)
      this._state = 'interaction'
    }
  }

  private computeOffsetForRestPoint(index: number): number {
    const rp = this.scene.restPoints[index]
    if (!rp) return 0
    return this.computeOffsetForX(rp.backgroundX)
  }

  private computeOffsetForX(x: number): number {
    const raw = x - this.viewportWidth / 2
    return this.clampOffset(raw)
  }

  private clampOffset(offset: number): number {
    const maxOffset = Math.max(0, this.scene.backgroundLayers[2].width - this.viewportWidth)
    return Math.max(0, Math.min(maxOffset, offset))
  }

  /** Get the transition object for a given transitionIndex (-1 = startTransition) */
  private getTransition(transitionIndex: number): SceneTransition | undefined {
    if (transitionIndex === -1) return this.scene.startTransition
    return this.scene.transitions[transitionIndex]
  }

  /** Get fromX and toX for a transition */
  private getTransitionEndpoints(transitionIndex: number): { fromX: number; toX: number } {
    if (transitionIndex === -1) {
      return {
        fromX: this.scene.startX ?? this.scene.restPoints[0]?.backgroundX ?? 0,
        toX: this.scene.restPoints[0]?.backgroundX ?? 0,
      }
    }
    return {
      fromX: this.scene.restPoints[transitionIndex]?.backgroundX ?? 0,
      toX: this.scene.restPoints[transitionIndex + 1]?.backgroundX ?? 0,
    }
  }

  /** Start traversing segments of a transition */
  private startTransitionSegments(transitionIndex: number): void {
    const transition = this.getTransition(transitionIndex)
    if (!transition || transition.segments.length === 0) {
      // No segments — jump to destination
      if (transitionIndex === -1) {
        this.arriveAtRestPoint(0)
      } else {
        this.arriveAtRestPoint(transitionIndex + 1)
      }
      return
    }

    this._currentTransitionIndex = transitionIndex
    this._currentSegmentIndex = 0
    this.startSegment(transitionIndex, 0)
  }

  /** Start a single segment within a transition */
  private startSegment(transitionIndex: number, segmentIndex: number): void {
    const transition = this.getTransition(transitionIndex)!
    const segment = transition.segments[segmentIndex]
    const { fromX, toX } = this.getTransitionEndpoints(transitionIndex)
    const xPositions = getTransitionXPositions(fromX, toX, transition)

    this._state = 'segment'
    this.segmentProgress = 0
    this.segmentStartRawX = xPositions[segmentIndex]
    this.segmentEndRawX = xPositions[segmentIndex + 1]
    this.segmentStartX = this.computeOffsetForX(xPositions[segmentIndex])
    this.segmentEndX = this.computeOffsetForX(xPositions[segmentIndex + 1])
    this.segmentDuration = segment.duration
    this._currentSegmentAnimationId = segment.animationId
    this._currentTransitionIndex = transitionIndex
    this._currentSegmentIndex = segmentIndex

    this.onSegmentStart?.(transitionIndex, segmentIndex)
  }

  /** Called by the user pressing "Continue" */
  advance(): void {
    if (this._state !== 'interaction') return
    if (this._currentRestIndex >= this.scene.restPoints.length - 1) return

    this.startTransitionSegments(this._currentRestIndex)
  }

  /** Called each frame with delta in seconds */
  update(deltaSeconds: number): void {
    switch (this._state) {
      case 'interaction':
        break

      case 'segment': {
        if (this.segmentDuration <= 0) {
          this.finishSegment()
          break
        }
        this.segmentProgress += deltaSeconds / this.segmentDuration
        if (this.segmentProgress >= 1) {
          this.segmentProgress = 1
          this._backgroundOffsetX = this.segmentEndX
          this._currentX = this.segmentEndRawX
          this.finishSegment()
        } else {
          const t = easeInOut(this.segmentProgress)
          this._backgroundOffsetX = this.clampOffset(
            this.segmentStartX + (this.segmentEndX - this.segmentStartX) * t
          )
          this._currentX = this.segmentStartRawX + (this.segmentEndRawX - this.segmentStartRawX) * t
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

  /** Finish current segment — advance to next segment or arrive at rest point */
  private finishSegment(): void {
    const transition = this.getTransition(this._currentTransitionIndex)!
    const nextSegmentIndex = this._currentSegmentIndex + 1

    if (nextSegmentIndex < transition.segments.length) {
      // More segments in this transition
      this.startSegment(this._currentTransitionIndex, nextSegmentIndex)
    } else {
      // Transition complete — arrive at destination rest point
      const destIndex = this._currentTransitionIndex === -1 ? 0 : this._currentTransitionIndex + 1
      this.arriveAtRestPoint(destIndex)
    }
  }

  private arriveAtRestPoint(index: number): void {
    this._currentRestIndex = index
    const rp = this.scene.restPoints[index]
    if (!rp) {
      this._state = 'interaction'
      return
    }

    this._currentX = rp.backgroundX
    this._backgroundOffsetX = this.computeOffsetForRestPoint(index)
    this.onRestPointArrival?.(index, rp)

    // Enter blend state briefly, then interaction
    this._state = 'blend'
    this.blendProgress = 0
  }

  // --- Public getters ---

  get backgroundOffsetX(): number {
    return this._backgroundOffsetX
  }

  /** Current character X position on the background (not clamped by viewport) */
  get currentX(): number {
    return this._currentX
  }

  get currentState(): SceneState {
    return this._state
  }

  get currentRestIndex(): number {
    return this._currentRestIndex
  }

  get currentRestPoint(): SceneRestPoint | null {
    return this.scene.restPoints[this._currentRestIndex] ?? null
  }

  get isComplete(): boolean {
    return this._currentRestIndex >= this.scene.restPoints.length - 1 && this._state === 'interaction'
  }

  get characterScale(): number {
    return this.scene.characterScale
  }

  get characterY(): number {
    return this.scene.characterY
  }

  /** Animation ID for the current segment (during movement) */
  get currentSegmentAnimationId(): string | undefined {
    if (this._state !== 'segment') return undefined
    return this._currentSegmentAnimationId
  }

  /** Rest animation ID for the current rest point */
  get interactionRestAnimationId(): string | undefined {
    if (this._state !== 'interaction' && this._state !== 'blend') return undefined
    return this.currentRestPoint?.restAnimationId
  }

  /** Available animation IDs for the current rest point */
  get interactionAnimationIds(): string[] {
    if (this._state !== 'interaction' && this._state !== 'blend') return []
    return this.currentRestPoint?.randomAnimationIds ?? []
  }

  /** Blend progress [0,1] when in blend state */
  get blendAlpha(): number {
    if (this._state !== 'blend') return 0
    return smoothstep(this.blendProgress)
  }

  /** Segment progress [0,1] when in segment state */
  get segmentAlpha(): number {
    if (this._state !== 'segment') return 0
    return this.segmentProgress
  }

  /** Update viewport width (on resize) */
  setViewportWidth(width: number): void {
    this.viewportWidth = width
    if (this._state === 'interaction') {
      this._backgroundOffsetX = this.computeOffsetForRestPoint(this._currentRestIndex)
    }
  }

  /** Background width in pixels */
  get bgWidth(): number {
    return this.scene.backgroundLayers[2].width
  }
}
