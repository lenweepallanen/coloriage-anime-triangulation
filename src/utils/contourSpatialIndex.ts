import type { Point2D } from '../types/project'

/**
 * Bucket-based spatial index for fast nearest-point lookup on a contour.
 * Built once per frame from the detected contour pixels.
 */
export class ContourSpatialIndex {
  private buckets: Map<string, Point2D[]>
  private bucketSize: number

  constructor(contourPixels: Point2D[], bucketSize = 8) {
    this.bucketSize = bucketSize
    this.buckets = new Map()
    for (const p of contourPixels) {
      const key = `${Math.floor(p.x / bucketSize)},${Math.floor(p.y / bucketSize)}`
      let bucket = this.buckets.get(key)
      if (!bucket) {
        bucket = []
        this.buckets.set(key, bucket)
      }
      bucket.push(p)
    }
  }

  nearest(point: Point2D, maxDist: number): { point: Point2D; dist: number } | null {
    const bx = Math.floor(point.x / this.bucketSize)
    const by = Math.floor(point.y / this.bucketSize)
    const radius = Math.ceil(maxDist / this.bucketSize) + 1

    let best: Point2D | null = null
    let bestDist = Infinity

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const candidates = this.buckets.get(`${bx + dx},${by + dy}`)
        if (!candidates) continue
        for (const c of candidates) {
          const d = Math.hypot(c.x - point.x, c.y - point.y)
          if (d < bestDist) {
            bestDist = d
            best = c
          }
        }
      }
    }

    return best && bestDist <= maxDist ? { point: best, dist: bestDist } : null
  }
}
