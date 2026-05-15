import type { Scene, SceneRestPoint, SceneTransition, SceneSegment, SegmentEasing } from '../types/project'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

function linear(t: number): number {
  return Math.max(0, Math.min(1, t))
}

/** Cubique de Hermite f(0)=0, f(1)=1 avec dérivées prescrites m0, m1. */
function hermite(m0: number, m1: number): (t: number) => number {
  return (t: number) => {
    const c = Math.max(0, Math.min(1, t))
    const c2 = c * c
    const c3 = c2 * c
    return m0 * (c3 - 2 * c2 + c) + (-2 * c3 + 3 * c2) + m1 * (c3 - c2)
  }
}

/** Dérivée intrinsèque de l'easing à une borne, pour le matching de vitesse au voisin.
 *  Pour ease-out/ease-in à la borne "matching", on retourne 1 (vitesse linéaire) afin
 *  d'éviter la circularité — le matching réel se fait côté segment courant. */
function intrinsicSlope(easing: SegmentEasing | undefined, side: 'start' | 'end'): number {
  switch (easing ?? 'smoothstep') {
    case 'smoothstep': return 0
    case 'linear': return 1
    case 'ease-out': return side === 'start' ? 1 : 0
    case 'ease-in':  return side === 'start' ? 0 : 1
  }
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
  private _currentSegmentEasing: (t: number) => number = smoothstep

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

  /** Construit l'easing du segment courant, avec matching de vitesse aux voisins
   *  pour les types 'ease-out' (départ ← vitesse du segment précédent) et
   *  'ease-in' (fin → vitesse du segment suivant). */
  private buildSegmentEasing(transition: SceneTransition, segmentIndex: number, xPositions: number[]): (t: number) => number {
    const segment = transition.segments[segmentIndex]
    const easing: SegmentEasing = segment.easing ?? 'smoothstep'
    if (easing === 'smoothstep') return smoothstep
    if (easing === 'linear') return linear

    const dxCur = xPositions[segmentIndex + 1] - xPositions[segmentIndex]
    const durCur = segment.duration

    if (easing === 'ease-out') {
      // m0 = pente normalisée à l'entrée qui matche la vitesse pixel de fin du segment précédent
      let m0 = 1
      const prev = transition.segments[segmentIndex - 1]
      if (prev && Math.abs(dxCur) > 1e-6 && durCur > 0 && prev.duration > 0) {
        const dxPrev = xPositions[segmentIndex] - xPositions[segmentIndex - 1]
        const prevEndSlope = intrinsicSlope(prev.easing, 'end')
        // vitesse pixel fin prev = prevEndSlope * dxPrev / prev.duration
        // pente normalisée requise à t=0 : m0 * dxCur / durCur = vitesse pixel
        m0 = (prevEndSlope * dxPrev / prev.duration) * durCur / dxCur
      }
      return hermite(m0, 0)
    }

    // ease-in
    let m1 = 1
    const next = transition.segments[segmentIndex + 1]
    if (next && Math.abs(dxCur) > 1e-6 && durCur > 0 && next.duration > 0) {
      const dxNext = xPositions[segmentIndex + 2] - xPositions[segmentIndex + 1]
      const nextStartSlope = intrinsicSlope(next.easing, 'start')
      m1 = (nextStartSlope * dxNext / next.duration) * durCur / dxCur
    }
    return hermite(0, m1)
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
    this._currentSegmentEasing = this.buildSegmentEasing(transition, segmentIndex, xPositions)
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
          const t = this._currentSegmentEasing(this.segmentProgress)
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

  /** Current segment object (during movement) */
  get currentSegment(): SceneSegment | undefined {
    if (this._state !== 'segment') return undefined
    const transition = this.getTransition(this._currentTransitionIndex)
    return transition?.segments[this._currentSegmentIndex]
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
    return this.getBgWidth()
  }
}
