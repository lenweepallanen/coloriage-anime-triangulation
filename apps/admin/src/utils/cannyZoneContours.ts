/**
 * Zone selection + rasterization helpers for the Canny segmentation mode of the
 * Triangulation Projet pipeline (alternative to SAM 2).
 *
 * Pipeline summary:
 *  1. Worker returns silhouette + N candidate regions (closed white loops bounded
 *     by the black trace of the coloring book).
 *  2. For each user-clicked seed (1 per leg zone), pick the region containing the
 *     seed (or the nearest one if the click landed on the black trace).
 *  3. Body zone is always the silhouette (largest external contour).
 *  4. Rasterize each picked polygon to a binary mask and encode it as RLE so the
 *     downstream pipeline (overlays, ProjectTriangMeshStep) stays unchanged.
 */

import type { Point2D, RLEMask } from '../types/project'
import { pointInPolygon, distanceSq } from './geometry'
import { encodeRLE } from './rleMask'

function polygonArea(poly: Point2D[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  }
  return Math.abs(a) / 2
}

function distancePointToSegmentSq(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) return distanceSq(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return (p.x - cx) ** 2 + (p.y - cy) ** 2
}

function minDistanceSqToPolygon(p: Point2D, poly: Point2D[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distancePointToSegmentSq(p, poly[j], poly[i])
    if (d < best) best = d
  }
  return best
}

/**
 * Among the candidate polygons that contain `p`, return the one with the
 * smallest area (handles nested contours: prefer the tightest enclosing region).
 */
export function pickContourContainingPoint(
  contours: Point2D[][],
  p: Point2D,
): Point2D[] | null {
  let best: Point2D[] | null = null
  let bestArea = Infinity
  for (const c of contours) {
    if (c.length < 3) continue
    if (!pointInPolygon(p, c)) continue
    const a = polygonArea(c)
    if (a < bestArea) {
      bestArea = a
      best = c
    }
  }
  return best
}

/**
 * Return the polygon whose boundary is closest to `p`. Used as a fallback when
 * the click landed outside any candidate region (e.g. directly on the black
 * trace of the coloring book).
 */
export function pickNearestContour(
  contours: Point2D[][],
  p: Point2D,
): Point2D[] | null {
  let best: Point2D[] | null = null
  let bestDist = Infinity
  for (const c of contours) {
    if (c.length < 3) continue
    const d = minDistanceSqToPolygon(p, c)
    if (d < bestDist) {
      bestDist = d
      best = c
    }
  }
  return best
}

/**
 * Pick the region representing a given zone:
 *  - body : caller should pass the silhouette directly (not via this function)
 *  - leg  : returns the smallest enclosing region for the seed click,
 *           else the nearest region boundary.
 */
export function pickContourForLeg(
  candidateRegions: Point2D[][],
  seed: Point2D,
): Point2D[] | null {
  return pickContourContainingPoint(candidateRegions, seed)
       ?? pickNearestContour(candidateRegions, seed)
}

/**
 * Rasterize a closed polygon into a binary mask of size (w, h), then encode it
 * to RLE. The polygon coordinates must already be in mask space.
 */
export function rasterizePolygonToMaskRLE(
  polygon: Point2D[],
  w: number,
  h: number,
): RLEMask {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  if (polygon.length >= 3) {
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.moveTo(polygon[0].x, polygon[0].y)
    for (let i = 1; i < polygon.length; i++) {
      ctx.lineTo(polygon[i].x, polygon[i].y)
    }
    ctx.closePath()
    ctx.fill()
  }
  const imgData = ctx.getImageData(0, 0, w, h)
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = imgData.data[i * 4] > 127 ? 1 : 0
  }
  return encodeRLE(mask, h, w)
}
