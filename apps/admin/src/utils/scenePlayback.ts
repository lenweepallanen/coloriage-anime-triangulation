import type { FilmTravelEasing, Scene, SceneRestPoint, Point2D } from '../types/project'
import { clampPointToTrapezoid, isInsideTrapezoid, scaleAtY, segmentTrapezoidExit } from './sceneTrapezoid'
import { applyFilmEasing, pointAtLen, sampleFilmPath, type FilmPathTable } from './filmPath'

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t))
  return c * c * (3 - 2 * c)
}

export type SceneState = 'entering' | 'interaction' | 'blend' | 'walking'

/** Options d'un trajet de film (mode film v2 — chemin de points, sans trapèze). */
export interface FilmTravelOpts {
  speedPxPerSec: number
  /** Échelle du perso au départ / à l'arrivée (interpolée par distance parcourue). */
  scaleFrom: number
  scaleTo: number
  /** Animation de déplacement (déjà résolue : trajet ?? défaut film). */
  animationId?: string
  /** Multiplicateur de vitesse de lecture de l'animation de déplacement (défaut 1). */
  animSpeedMul?: number
  /** Téléporte d'abord le perso hors-champ de ce côté (entrée de film). */
  offscreenStart?: 'left' | 'right'
  /** Cible = hors-champ de ce côté (sortie). Trajet TERMINAL par défaut : reste
   *  figé, isExited=true — sauf si `terminal: false` (departure : arrive normalement). */
  offscreenEnd?: 'left' | 'right'
  /** Téléporte le perso à ce point avant le trajet (origin custom / cut sec).
   *  Exclusif avec offscreenStart. */
  startAt?: Point2D
  /** false = offscreenEnd NON terminal (trajet de sortie de point, le film continue). */
  terminal?: boolean
  /** Points de contrôle Bézier (1 = quadratique, 2 = cubique) en coords background.
   *  Vitesse constante en espace (table arc-length). */
  controlPoints?: Point2D[]
  /** Easing temporel du trajet (défaut linear, durée totale inchangée). */
  easing?: FilmTravelEasing
  /** Sens du regard imposé à l'ARRIVÉE au point (absent = garde le sens du trajet). */
  arriveFacing?: 'left' | 'right'
}

export interface ScenePlaybackConfig {
  scene: Scene
  viewportWidth: number
  viewportHeight: number
  onRestPointArrival?: (restPoint: SceneRestPoint) => void
  /** Appelé quand le state passe en/sort de 'walking'. */
  onWalkStateChange?: (walking: boolean) => void
  /** Y initial du personnage en coords background front (baseline = position des pieds au rest). */
  initialFeetBgY?: number
  /** Largeur du personnage à scale=1 (sans perspective), en coords background.
   *  Utilisée pour positionner les waypoints de sortie/rentrée juste hors écran. */
  characterBaseWidthBg?: number
  /** Origine U normalisée [0,1] du personnage dans l'image (0 = bord gauche, 1 = bord droit). */
  characterOriginU?: number
  /** MODE FILM : centre du cadre caméra FIXE (coords background). Si défini :
   *  caméra jamais déplacée, entrée `scene.entry` bypassée (le film gère la sienne),
   *  position initiale hors-champ (cf. filmInitial). */
  filmCameraX?: number
  /** Position initiale du perso en mode film : hors-champ côté `side`, à `y`, échelle `scale`. */
  filmInitial?: { side: 'left' | 'right'; y: number; scale: number }
}

/**
 * Machine d'états simplifiée pour la lecture d'une scène :
 *   - `entering` (uniquement si `scene.entry === 'moving'`) : trajet de `entryStartX`
 *     vers `restPoint.backgroundX` sur `entryDurationMs`, easing smoothstep.
 *   - `blend` : court fondu (7/24 s) entre la fin du trajet et l'idle.
 *   - `interaction` : idle, position figée au rest point, boutons ☆ actifs.
 *   - `walking` : déplacement libre vers un target sur le trapèze (clic utilisateur).
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
  /** Y courant en coords background front (utilisé seulement en walking). */
  private _currentY: number = 0
  /** Y de base (au rest point ou avant marche), pour interpolation lors du retour. */
  private _baseY: number = 0

  // Walking state
  private walkTargetX: number = 0
  private walkTargetY: number = 0
  /** File d'attente de waypoints. `teleport=true` = snap instantané ; `pauseAfterMs` = délai
   *  d'attente après ce snap avant de reprendre la marche (laisser le perso hors écran). */
  private walkPath: Array<{ x: number; y: number; teleport?: boolean; pauseAfterMs?: number }> = []
  private _pauseSec: number = 0
  private _walkAlpha: number = 1
  // _walkScaleMul retiré : `walkScaleMul` est désormais un getter live dérivé de currentY.
  private _walkTiltRad: number = 0
  private _walkSkewY: number = 0
  private _walkFlipX: 1 | -1 = 1
  /** Direction la plus récente non-nulle, pour figer flip au moment de l'arrêt. */
  private _lastFlipX: 1 | -1 = 1

  private blendProgress: number = 0
  private blendDuration: number = 7 / 24

  /** Mode sortie de champ (film) : le trajet en cours est terminal, pas de retour au rest point. */
  private _exitMode: boolean = false
  /** true quand le trajet de sortie est terminé (perso hors écran, immobile). */
  private _exited: boolean = false

  // --- Mode film v2 (chemin de points, caméra fixe, échelle par point) ---
  private _filmMode: boolean = false
  /** Échelle courante du perso (échelle du dernier point atteint, interpolée en trajet). */
  private _filmScale: number = 1
  /** Trajet film en cours (null hors trajet). Position pilotée par le temps
   *  (elapsedSec) sur une table arc-length (courbe ou droite) + easing. */
  private _filmTravel: {
    speed: number
    scaleFrom: number
    scaleTo: number
    totalDist: number
    elapsedSec: number
    path: FilmPathTable
    easing?: FilmTravelEasing
    arriveFacing?: 'left' | 'right'
    animId?: string
    animSpeedMul?: number
  } | null = null

  private onRestPointArrival?: (restPoint: SceneRestPoint) => void
  private onWalkStateChange?: (walking: boolean) => void
  private characterBaseWidthBg: number = 0
  private characterOriginU: number = 0.5

  constructor(config: ScenePlaybackConfig) {
    this.scene = config.scene
    this.viewportWidth = config.viewportWidth
    this.onRestPointArrival = config.onRestPointArrival
    this.onWalkStateChange = config.onWalkStateChange
    this.characterBaseWidthBg = config.characterBaseWidthBg ?? 0
    this.characterOriginU = config.characterOriginU ?? 0.5

    // MODE FILM : caméra fixe (jamais déplacée) + position initiale hors-champ.
    // L'entrée `scene.entry` et le snap trapèze sont bypassés — le film gère son
    // propre chemin (FilmDirector → startFilmTravel).
    if (config.filmCameraX != null) {
      this._filmMode = true
      this._filmScale = config.filmInitial?.scale ?? 1
      this._backgroundOffsetX = this.clampOffset(config.filmCameraX - this.viewportWidth / 2)
      this._currentY = config.filmInitial?.y ?? config.initialFeetBgY ?? 0
      this._baseY = this._currentY
      this._currentX = this.filmOffscreenX(config.filmInitial?.side ?? 'left', this._filmScale)
      this._state = 'interaction'
      this._lastFlipX = 1
      this.recomputeWalkVisuals()
      return
    }

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
    this._currentY = config.initialFeetBgY ?? 0
    this._baseY = this._currentY
    // Si un trapèze de marche est défini, on snap la position initiale du
    // personnage à l'intérieur du trapèze (sa zone de "vie"). Cela évite que
    // la marche démarre depuis un point hors zone, avec un trajet visuellement
    // incohérent vers le clic.
    if (this.scene.walkTrapezoid) {
      const p: Point2D = { x: this._currentX, y: this._currentY }
      if (!isInsideTrapezoid(p, this.scene.walkTrapezoid)) {
        const snapped = clampPointToTrapezoid(p, this.scene.walkTrapezoid)
        this._currentX = snapped.x
        this._currentY = snapped.y
      }
    }
    // Flip initial = aucun (le coloriage est rendu tel que dessiné).
    // Pendant la marche, on flip si le mouvement va à l'inverse de la direction native.
    this._lastFlipX = 1
    this.recomputeWalkVisuals()
    // Perspective au repos si on est déjà dans le trap
    this.recomputePerspectiveAtCurrent()
  }

  /** Met à jour la baseline Y (utile si layout change). N'affecte pas un walking en cours. */
  setBaselineFeetBgY(y: number): void {
    this._baseY = y
    if (this._state !== 'walking') this._currentY = y
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
    return this.scene.background?.width ?? 0
  }

  /** No-op kept for backwards compatibility with callers (was used to advance multi-rest). */
  advance(): void {
    /* no-op : pas de multi-rest dans le nouveau modèle */
  }

  /**
   * Demande un déplacement vers (clickBgX, clickBgY) en coords background front.
   * Si le trapèze n'est pas défini → no-op. Si target hors trapèze, déplace jusqu'au bord.
   * Re-clic pendant walking : nouveau target immédiat.
   */
  requestWalkTo(clickBgX: number, clickBgY: number): boolean {
    const trap = this.scene.walkTrapezoid
    if (!trap) return false

    const origin: Point2D = { x: this._currentX, y: this._currentY }
    const safeOrigin = clampPointToTrapezoid(origin, trap)
    const click: Point2D = { x: clickBgX, y: clickBgY }
    const exit = segmentTrapezoidExit(safeOrigin, click, trap)

    if (!isInsideTrapezoid(origin, trap)) {
      this._currentX = safeOrigin.x
      this._currentY = safeOrigin.y
    }

    // --- Détermine si le trajet est trop pentu → wrap edge→edge ---
    const startX = this._currentX
    const startY = this._currentY
    const dx = exit.x - startX
    const dy = exit.y - startY
    const threshold = trap.walkSteepAngleThresholdDeg ?? 20
    const angleDeg = Math.atan2(Math.abs(dy), Math.abs(dx) + 1e-6) * 180 / Math.PI

    if (angleDeg > threshold && Math.abs(dy) > 1e-3) {
      // Trajet pentu : juste assez pour que le perso sorte entièrement → pause → rentre par l'autre bord.
      const viewLeftBg = this._backgroundOffsetX
      const viewRightBg = this._backgroundOffsetX + this.viewportWidth
      const viewMidBg = viewLeftBg + this.viewportWidth / 2
      const exitLeft = startX < viewMidBg
      const eps = 2 // petit dépassement pour être strictement hors champ
      // Largeur du personnage à la position du Y de sortie/rentrée (avec la perspective courante).
      const charWAtStart = this.characterBaseWidthBg * scaleAtY(startY, trap)
      const charWAtTarget = this.characterBaseWidthBg * scaleAtY(exit.y, trap)
      const u = this.characterOriginU
      // Sortie : origin tel que le BORD ARRIÈRE du perso atteint juste le bord viewport.
      // En allant à gauche → bord arrière = côté droit → originX = viewLeftBg - (1-u)*W - eps
      // En allant à droite → bord arrière = côté gauche → originX = viewRightBg + u*W + eps
      const exitOffscreenX = exitLeft
        ? viewLeftBg - (1 - u) * charWAtStart - eps
        : viewRightBg + u * charWAtStart + eps
      // Rentrée : origin tel que le BORD AVANT du perso est juste à l'extérieur de l'autre bord viewport.
      const reappearOffscreenX = exitLeft
        ? viewRightBg + u * charWAtTarget + eps
        : viewLeftBg - (1 - u) * charWAtTarget - eps
      this.walkPath = [
        { x: exitOffscreenX, y: startY },                                      // sort tout juste de l'écran
        { x: reappearOffscreenX, y: exit.y, teleport: true, pauseAfterMs: 400 }, // téléport opposé hors écran, pause
        { x: exit.x, y: exit.y },                                              // rentre en marchant vers le clic
      ]
    } else {
      // Trajet plat : un seul segment.
      this.walkPath = [{ x: exit.x, y: exit.y }]
    }

    this.walkTargetX = this.walkPath[0].x
    this.walkTargetY = this.walkPath[0].y

    if (this._state !== 'walking') {
      const wasInteracting = this._state === 'interaction' || this._state === 'blend'
      this._state = 'walking'
      this.blendProgress = 0
      this._walkAlpha = 1
      this._pauseSec = 0
      if (wasInteracting) this.onWalkStateChange?.(true)
    }
    return true
  }

  /** X hors-champ tel que le perso (à l'échelle donnée) soit tout juste hors du cadre fixe. */
  private filmOffscreenX(side: 'left' | 'right', scale: number): number {
    const viewLeftBg = this._backgroundOffsetX
    const viewRightBg = this._backgroundOffsetX + this.viewportWidth
    const eps = 2
    const charW = this.characterBaseWidthBg * scale
    const u = this.characterOriginU
    return side === 'left'
      ? viewLeftBg - (1 - u) * charW - eps
      : viewRightBg + u * charW + eps
  }

  /**
   * Démarre un trajet de film (mode film v2) : déplacement rectiligne vers `target`
   * (coords background), sans trapèze — vitesse et animation fournies, échelle
   * interpolée `scaleFrom → scaleTo` par distance parcourue.
   * - `offscreenStart` : téléporte d'abord le perso hors-champ de ce côté (entrée).
   * - `offscreenEnd` : la cible devient hors-champ de ce côté ; trajet TERMINAL
   *   (le perso reste figé hors écran, `isExited` passe à true).
   */
  startFilmTravel(target: Point2D | null, opts: FilmTravelOpts): void {
    // [Film DEBUG] — à retirer une fois le moonwalk résolu.
    // eslint-disable-next-line no-console
    console.log('[Film DEBUG] travel ' + JSON.stringify({
      from: { x: Math.round(this._currentX), y: Math.round(this._currentY) },
      target: target ? { x: Math.round(target.x), y: Math.round(target.y) } : null,
      startAt: opts.startAt ? { x: Math.round(opts.startAt.x), y: Math.round(opts.startAt.y) } : null,
      offStart: opts.offscreenStart ?? null,
      offEnd: opts.offscreenEnd ?? null,
      scaleFrom: opts.scaleFrom,
      scaleTo: opts.scaleTo,
      facing: this.scene.characterFacing ?? '(undefined→right)',
      arriveFacing: opts.arriveFacing ?? null,
    }))
    this._exited = false
    this._exitMode = false
    if (opts.startAt) {
      this._currentX = opts.startAt.x
      this._currentY = opts.startAt.y
    } else if (opts.offscreenStart) {
      if (target) this._currentY = target.y
      this._currentX = this.filmOffscreenX(opts.offscreenStart, opts.scaleFrom)
    }
    let tx: number
    let ty: number
    if (opts.offscreenEnd) {
      tx = this.filmOffscreenX(opts.offscreenEnd, opts.scaleTo)
      ty = this._currentY
      this._exitMode = opts.terminal !== false
    } else if (target) {
      tx = target.x
      ty = target.y
    } else {
      return
    }
    this._filmScale = opts.scaleFrom
    const path = sampleFilmPath({ x: this._currentX, y: this._currentY }, { x: tx, y: ty }, opts.controlPoints)
    this._filmTravel = {
      speed: Math.max(1, opts.speedPxPerSec),
      scaleFrom: opts.scaleFrom,
      scaleTo: opts.scaleTo,
      totalDist: path.totalLen,
      elapsedSec: 0,
      path,
      ...(opts.easing != null && { easing: opts.easing }),
      ...(opts.arriveFacing != null && { arriveFacing: opts.arriveFacing }),
      ...(opts.animationId != null && { animId: opts.animationId }),
      ...(opts.animSpeedMul != null && { animSpeedMul: opts.animSpeedMul }),
    }
    this.walkPath = [{ x: tx, y: ty }]
    this.walkTargetX = tx
    this.walkTargetY = ty
    if (this._state !== 'walking') {
      const wasInteracting = this._state === 'interaction' || this._state === 'blend'
      this._state = 'walking'
      this.blendProgress = 0
      this._walkAlpha = 1
      this._pauseSec = 0
      if (wasInteracting) this.onWalkStateChange?.(true)
    }
  }

  /** Avance un trajet film : position par temps → easing → distance → table arc-length.
   *  Vitesse constante en espace hors easing ; le flip suit la tangente du chemin. */
  private updateFilmTravel(deltaSeconds: number): void {
    const ft = this._filmTravel
    if (!ft) return
    ft.elapsedSec += deltaSeconds
    const durationSec = ft.totalDist > 1e-6 ? ft.totalDist / ft.speed : 0
    const tRaw = durationSec > 0 ? Math.min(1, ft.elapsedSec / durationSec) : 1
    const sFrac = applyFilmEasing(ft.easing, tRaw)
    const covered = ft.totalDist * sFrac
    const prevX = this._currentX
    const prevY = this._currentY
    const pos = pointAtLen(ft.path, covered)
    this._currentX = pos.x
    this._currentY = pos.y
    this._filmScale = ft.scaleFrom + (ft.scaleTo - ft.scaleFrom) * sFrac
    const invDt = 1 / Math.max(deltaSeconds, 1e-6)
    this.recomputeWalkVisualsFromVelocity((this._currentX - prevX) * invDt, (this._currentY - prevY) * invDt)
    if (tRaw >= 1) {
      this.recomputeWalkVisualsFromVelocity(0, 0)
      if (this._exitMode) {
        // Sortie de champ terminale : reste figé en 'walking', hors écran.
        this._filmScale = ft.scaleTo
        this._filmTravel = null
        this._exited = true
      } else {
        this.filmArrive()
      }
    }
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

      case 'walking': {
        // Mode film : trajet piloté par le temps (courbe arc-length + easing).
        // Un film sorti (_exited) reste figé en 'walking' sans trajet.
        if (this._filmMode) {
          if (this._filmTravel) this.updateFilmTravel(deltaSeconds)
          break
        }
        const trap = this.scene.walkTrapezoid
        if (!trap) { this.arriveAtRestPoint(); break }

        // Pause hors écran (après un téléport).
        if (this._pauseSec > 0) {
          this._pauseSec -= deltaSeconds
          if (this._pauseSec > 0) {
            this.recomputeWalkVisualsFromVelocity(0, 0)
            break
          }
          this._pauseSec = 0
        }

        // Si le prochain waypoint est un téléport, on snap immédiatement (instantané, pas de fade).
        const head = this.walkPath[0]
        if (head && head.teleport) {
          this._currentX = head.x
          this._currentY = head.y
          this._pauseSec = (head.pauseAfterMs ?? 0) / 1000
          this.walkPath.shift()
          const next = this.walkPath[0]
          if (next) {
            this.walkTargetX = next.x
            this.walkTargetY = next.y
          } else {
            this.recomputeWalkVisualsFromVelocity(0, 0)
            this.arriveAtRestPoint()
          }
          this.recomputeWalkVisualsFromVelocity(0, 0)
          break
        }

        // Branche trapèze uniquement (le mode film est traité par updateFilmTravel ci-dessus).
        const dx = this.walkTargetX - this._currentX
        const dy = this.walkTargetY - this._currentY
        const dist = Math.hypot(dx, dy)
        const step = Math.max(1, trap!.walkSpeedPxPerSec) * deltaSeconds
        let vx = 0, vy = 0
        if (dist <= step || dist < 0.5) {
          this._currentX = this.walkTargetX
          this._currentY = this.walkTargetY
          this.walkPath.shift()
          const next = this.walkPath[0]
          if (next) {
            this.walkTargetX = next.x
            this.walkTargetY = next.y
          } else {
            this.recomputeWalkVisualsFromVelocity(0, 0)
            this.arriveAtRestPoint()
          }
          break
        }
        vx = dx / dist
        vy = dy / dist
        this._currentX += vx * step
        this._currentY += vy * step
        this.recomputeWalkVisualsFromVelocity(vx, vy)
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

  private recomputeWalkVisuals(): void {
    this._walkTiltRad = 0
    this._walkSkewY = 0
    this._walkFlipX = this._lastFlipX
  }

  /** No-op désormais (walkScaleMul est un getter live), gardé pour compat init. */
  private recomputePerspectiveAtCurrent(): void { /* */ }

  /** Arrivée d'un trajet film : blend vers l'idle SANS re-snap au rest point
   *  (le perso reste au point du chemin, l'échelle est figée à scaleTo). */
  private filmArrive(): void {
    const ft = this._filmTravel
    this._filmScale = ft?.scaleTo ?? this._filmScale
    // Sens du regard imposé au point (réglage par point du film) : flip calculé
    // depuis le sens natif du dessin, figé pour toute la phase idle.
    if (ft?.arriveFacing) {
      const nativeRight = this.scene.characterFacing !== 'left'
      const flip: 1 | -1 = ((ft.arriveFacing === 'right') === nativeRight) ? 1 : -1
      this._lastFlipX = flip
    }
    this._filmTravel = null
    this.recomputeWalkVisuals()
    this._walkAlpha = 1
    this._pauseSec = 0
    this.walkPath = []
    this._state = 'blend'
    this.blendProgress = 0
    this.onWalkStateChange?.(false)
  }

  private recomputeWalkVisualsFromVelocity(vx: number, vy: number): void {
    // Mode film : flip auto selon la direction, pas de tilt/skew (pas de trapèze).
    if (this._filmMode) {
      if (Math.abs(vx) > 1e-3) {
        const nativeRight = this.scene.characterFacing !== 'left'
        const flip: 1 | -1 = ((vx >= 0) === nativeRight) ? 1 : -1
        this._walkFlipX = flip
        this._lastFlipX = flip
      } else {
        this._walkFlipX = this._lastFlipX
      }
      this._walkTiltRad = 0
      this._walkSkewY = 0
      return
    }
    const trap = this.scene.walkTrapezoid
    if (!trap) { this.recomputeWalkVisuals(); return }
    if (Math.abs(vx) > 1e-3 || Math.abs(vy) > 1e-3) {
      // Le coloriage est dessiné dans une direction native (`characterFacing`).
      // On flip si le sens du déplacement est opposé à cette direction.
      const nativeRight = this.scene.characterFacing !== 'left'
      const movingRight = vx >= 0
      const flip: 1 | -1 = (movingRight === nativeRight) ? 1 : -1
      this._walkFlipX = flip
      this._lastFlipX = flip
      // θ = angle entre direction et axe horizontal +x (signé)
      // En coords écran, vy > 0 = vers le bas. On utilise l'angle direct.
      const horizontalSpeed = Math.abs(vx) // pondère par la composante horizontale
      const theta = Math.atan2(vy, Math.abs(vx) + 1e-6)
      // sin θ ∈ [-1,1] : -1 = monte verticalement, +1 = descend verticalement
      const s = Math.max(-1, Math.min(1, Math.sin(theta)))
      // Tilt : si vy<0 (monte) le perso se penche en arrière, sinon en avant.
      // Le signe dépend aussi de flip (cohérence visuelle).
      this._walkTiltRad = s * trap.tiltDegMax * (Math.PI / 180) * flip * horizontalSpeed
      this._walkSkewY = s * trap.skewYMax * flip * horizontalSpeed
    } else {
      this._walkTiltRad = 0
      this._walkSkewY = 0
    }
  }

  private arriveAtRestPoint(): void {
    const rp = this.scene.restPoint
    if (!rp) {
      const wasWalking = this._state === 'walking'
      this._state = 'interaction'
      this.recomputeWalkVisuals()
      if (wasWalking) this.onWalkStateChange?.(false)
      return
    }
    const wasWalking = this._state === 'walking'
    if (wasWalking) {
      this.recomputeWalkVisuals()
      this._walkAlpha = 1
      this._pauseSec = 0
      this.walkPath = []
      this._state = 'blend'
      this.blendProgress = 0
      this.onRestPointArrival?.(rp)
      this.onWalkStateChange?.(false)
      return
    }
    this._currentX = rp.backgroundX
    this._currentY = this._baseY
    this._baseY = 0
    this._backgroundOffsetX = this.computeOffsetForX(rp.backgroundX)
    this.recomputeWalkVisuals()
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

  /** Y courant en coords background front (delta par rapport au layout normal). */
  get currentY(): number {
    return this._currentY
  }

  /** Multiplicateur d'échelle. Mode film : échelle du point courant (interpolée en
   *  trajet). Sinon : perspective trapèze dérivée du Y courant. */
  get walkScaleMul(): number {
    if (this._filmMode) return this._filmScale
    const trap = this.scene.walkTrapezoid
    if (!trap) return 1
    return scaleAtY(this._currentY, trap)
  }

  get walkTiltRad(): number {
    return this._walkTiltRad
  }

  get walkSkewY(): number {
    return this._walkSkewY
  }

  get walkFlipX(): 1 | -1 {
    return this._walkFlipX
  }

  /** Alpha de fade du personnage (1 = visible, 0 = invisible, pendant un téléport edge). */
  get walkAlpha(): number {
    return this._walkAlpha
  }

  get isWalking(): boolean {
    return this._state === 'walking'
  }

  /** true quand un trajet de sortie (requestExit) est terminé — perso hors écran. */
  get isExited(): boolean {
    return this._exited
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

  /** Animation jouée pendant la phase d'entrée ou de marche. */
  get currentSegmentAnimationId(): string | undefined {
    if (this._state === 'entering') {
      return this.scene.entryAnimationId ?? this.scene.restPoint?.restAnimationId
    }
    if (this._state === 'walking') {
      if (this._filmMode) return this._filmTravel?.animId
      return this.scene.walkTrapezoid?.walkAnimationId
    }
    return undefined
  }

  /** Multiplicateur de vitesse de LECTURE de l'animation du trajet film en cours (1 hors film). */
  get currentSegmentAnimSpeedMul(): number {
    if (this._filmMode && this._state === 'walking') return this._filmTravel?.animSpeedMul ?? 1
    return 1
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
