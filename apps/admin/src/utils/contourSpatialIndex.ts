import type { Point2D } from '../types/project'

/**
 * Bucket-based spatial index for fast nearest-point lookup on a contour.
 * Built once per frame from the detected contour pixels.
 */
export class ContourSpatialIndex {
  private buckets: Map<string, { point: Point2D; index: number }[]>
  private bucketSize: number

  constructor(contourPixels: Point2D[], bucketSize = 8) {
    this.bucketSize = bucketSize
    this.buckets = new Map()
    for (let i = 0; i < contourPixels.length; i++) {
      const p = contourPixels[i]
      const key = `${Math.floor(p.x / bucketSize)},${Math.floor(p.y / bucketSize)}`
      let bucket = this.buckets.get(key)
      if (!bucket) {
        bucket = []
        this.buckets.set(key, bucket)
      }
      bucket.push({ point: p, index: i })
    }
  }

  nearest(point: Point2D, maxDist: number): { point: Point2D; dist: number } | null {
    const result = this.nearestWithIndex(point, maxDist)
    return result ? { point: result.point, dist: result.dist } : null
  }

  nearestWithIndex(point: Point2D, maxDist: number): { point: Point2D; dist: number; index: number } | null {
    const bx = Math.floor(point.x / this.bucketSize)
    const by = Math.floor(point.y / this.bucketSize)
    const radius = Math.ceil(maxDist / this.bucketSize) + 1

    let best: { point: Point2D; index: number } | null = null
    let bestDist = Infinity

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const candidates = this.buckets.get(`${bx + dx},${by + dy}`)
        if (!candidates) continue
        for (const c of candidates) {
          const d = Math.hypot(c.point.x - point.x, c.point.y - point.y)
          if (d < bestDist) {
            bestDist = d
            best = c
          }
        }
      }
    }

    return best && bestDist <= maxDist ? { point: best.point, dist: bestDist, index: best.index } : null
  }

  /**
   * Find the nearest contour point with no distance limit.
   * Expands search radius until a point is found.
   */
  nearestUnbounded(point: Point2D): { point: Point2D; dist: number } | null {
    const bx = Math.floor(point.x / this.bucketSize)
    const by = Math.floor(point.y / this.bucketSize)

    // Expand in rings until we find something
    for (let radius = 0; radius < 500; radius++) {
      let best: { point: Point2D; index: number } | null = null
      let bestDist = Infinity

      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          // Only check the outer ring for radius > 0
          if (radius > 0 && Math.abs(dx) < radius && Math.abs(dy) < radius) continue
          const candidates = this.buckets.get(`${bx + dx},${by + dy}`)
          if (!candidates) continue
          for (const c of candidates) {
            const d = Math.hypot(c.point.x - point.x, c.point.y - point.y)
            if (d < bestDist) {
              bestDist = d
              best = c
            }
          }
        }
      }

      if (best) return { point: best.point, dist: bestDist }
    }
    return null
  }
}
