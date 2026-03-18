import type { Point2D } from '../types/project'

export interface PhysicsConfig {
  /** Force maximale d'attraction en pixels image */
  force: number
  /** Rayon caractéristique : à cette distance, l'effet est à 50% */
  radius: number
  /** Concentration : exposant du falloff (plus haut = plus concentré) */
  concentration: number
  /** Vitesse de retour au relâchement (0 = instantané, 1 = jamais) */
  returnSpeed: number
}

export interface TouchState {
  active: boolean
  /** Touch position in IMAGE coordinates (not screen) */
  imageX: number
  imageY: number
}

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  force: 40,
  radius: 150,
  concentration: 2,
  returnSpeed: 0.85,
}

export class MeshPhysicsEffect {
  private displacementX: Float32Array
  private displacementY: Float32Array
  config: PhysicsConfig
  private numVertices: number

  constructor(numVertices: number, config?: Partial<PhysicsConfig>) {
    this.numVertices = numVertices
    this.config = { ...DEFAULT_PHYSICS_CONFIG, ...config }
    this.displacementX = new Float32Array(numVertices)
    this.displacementY = new Float32Array(numVertices)
  }

  update(basePositions: Point2D[], touch: TouchState, deltaTicks: number): void {
    const { force, radius, concentration, returnSpeed } = this.config
    const n = Math.min(this.numVertices, basePositions.length)

    if (touch.active) {
      // Attract speed: converge at ~12% per frame at 60fps
      const rate = 1 - Math.pow(0.88, deltaTicks)

      // Compute mesh centroid
      let cx = 0, cy = 0
      for (let i = 0; i < n; i++) {
        cx += basePositions[i].x
        cy += basePositions[i].y
      }
      cx /= n
      cy /= n

      // Global direction: centroid → touch point
      const gdx = touch.imageX - cx
      const gdy = touch.imageY - cy
      const gDist = Math.sqrt(gdx * gdx + gdy * gdy)
      const dirX = gDist > 0.001 ? gdx / gDist : 0
      const dirY = gDist > 0.001 ? gdy / gDist : 0

      for (let i = 0; i < n; i++) {
        // Per-vertex distance to touch for magnitude falloff
        const dx = touch.imageX - basePositions[i].x
        const dy = touch.imageY - basePositions[i].y
        const dist = Math.sqrt(dx * dx + dy * dy)

        // Soft falloff based on per-vertex distance
        const strength = 1 / (1 + Math.pow(dist / Math.max(radius, 1), concentration))
        const targetMag = strength * force

        // Use global direction for all vertices
        const targetDX = dirX * targetMag
        const targetDY = dirY * targetMag

        this.displacementX[i] += (targetDX - this.displacementX[i]) * rate
        this.displacementY[i] += (targetDY - this.displacementY[i]) * rate
      }
    } else {
      const decay = Math.pow(returnSpeed, deltaTicks)

      for (let i = 0; i < n; i++) {
        this.displacementX[i] *= decay
        this.displacementY[i] *= decay

        if (Math.abs(this.displacementX[i]) < 0.01) this.displacementX[i] = 0
        if (Math.abs(this.displacementY[i]) < 0.01) this.displacementY[i] = 0
      }
    }
  }

  apply(basePositions: Point2D[], out: Point2D[]): void {
    const n = Math.min(this.numVertices, basePositions.length, out.length)
    for (let i = 0; i < n; i++) {
      out[i].x = basePositions[i].x + this.displacementX[i]
      out[i].y = basePositions[i].y + this.displacementY[i]
    }
  }

  isIdle(): boolean {
    for (let i = 0; i < this.numVertices; i++) {
      if (this.displacementX[i] !== 0 || this.displacementY[i] !== 0) return false
    }
    return true
  }

  reset(): void {
    this.displacementX.fill(0)
    this.displacementY.fill(0)
  }
}
