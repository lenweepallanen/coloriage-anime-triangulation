import type { Point2D } from '../types/project'

export function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export function distanceSq(a: Point2D, b: Point2D): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.sqrt(distanceSq(a, b))
}

export function triangleCentroid(
  a: Point2D,
  b: Point2D,
  c: Point2D
): Point2D {
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3,
  }
}
