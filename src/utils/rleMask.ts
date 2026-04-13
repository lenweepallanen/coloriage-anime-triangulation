/**
 * RLE COCO uncompressed mask utilities (TypeScript implementation, no external deps).
 *
 * Format spec: { size: [H, W], counts: [bg, fg, bg, fg, ...] }
 *   - counts is column-major (Fortran order) — matches what the Python serveur encode
 *   - counts always starts with a background run length (may be 0)
 *   - sum(counts) === H * W
 *
 * This is the format produced by `sam2/main.py:encode_rle_uncompressed` and consumed
 * by the client to perform: point-in-mask test, mask overlay rendering, point clamp.
 */

import type { Point2D, RLEMask } from '../types/project'

/**
 * Decode an RLE mask to a row-major Uint8Array of size H*W (0 = background, 1 = foreground).
 * Internally we walk counts column-major then transpose.
 */
export function decodeRLE(rle: RLEMask): Uint8Array {
  const [h, w] = rle.size
  const total = h * w
  const colMajor = new Uint8Array(total)
  let idx = 0
  let value: 0 | 1 = 0
  for (const run of rle.counts) {
    for (let i = 0; i < run && idx < total; i++) {
      colMajor[idx++] = value
    }
    value = (value === 0 ? 1 : 0)
  }
  // Transpose column-major → row-major
  const rowMajor = new Uint8Array(total)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      rowMajor[y * w + x] = colMajor[x * h + y]
    }
  }
  return rowMajor
}

/**
 * Décode un masque RLE "cible" puis soustrait pixel-par-pixel les masques RLE fournis.
 * Retourne un Uint8Array row-major 0/1 prêt à être passé à flowMaskToContour.
 *
 * Utilisé par le pipeline members-bones (étape 3 Lissage) pour obtenir un masque body
 * "propre" où les pattes ont été retirées.
 */
export function decodeRLEMinusRLEs(target: RLEMask, toSubtract: RLEMask[]): Uint8Array {
  const result = decodeRLE(target)
  const [h, w] = target.size
  for (const sub of toSubtract) {
    if (sub.size[0] !== h || sub.size[1] !== w) {
      console.warn('[decodeRLEMinusRLEs] size mismatch, skipping', sub.size, 'vs', target.size)
      continue
    }
    const subMask = decodeRLE(sub)
    for (let i = 0; i < result.length; i++) {
      if (subMask[i]) result[i] = 0
    }
  }
  return result
}

/**
 * Encode a row-major Uint8Array binary mask to RLE.
 */
export function encodeRLE(mask: Uint8Array, h: number, w: number): RLEMask {
  // Convert to column-major
  const colMajor = new Uint8Array(h * w)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      colMajor[x * h + y] = mask[y * w + x] ? 1 : 0
    }
  }
  const counts: number[] = []
  let current: 0 | 1 = 0
  let run = 0
  for (let i = 0; i < colMajor.length; i++) {
    const v = colMajor[i] ? 1 : 0
    if (v === current) {
      run++
    } else {
      counts.push(run)
      current = v as 0 | 1
      run = 1
    }
  }
  counts.push(run)
  // Ensure starts with background
  if (colMajor.length > 0 && colMajor[0] !== 0) {
    counts.unshift(0)
  }
  return { size: [h, w], counts }
}

/**
 * Test if a pixel (x, y) in mask coordinates is inside the foreground.
 * Uses incremental RLE walk — does NOT decode the whole mask.
 *
 * x, y are in mask pixel coordinates (must already be in the same space as rle.size).
 * x is the column index, y is the row index.
 */
export function pointInMask(rle: RLEMask, x: number, y: number): boolean {
  const [h, w] = rle.size
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi < 0 || xi >= w || yi < 0 || yi >= h) return false

  // Column-major target index : col * h + row
  const targetIdx = xi * h + yi

  let cursor = 0
  let value: 0 | 1 = 0
  for (const run of rle.counts) {
    if (cursor + run > targetIdx) {
      return value === 1
    }
    cursor += run
    value = (value === 0 ? 1 : 0)
  }
  return false
}

/**
 * Render an RLE mask as an ImageData with a tinted RGBA color.
 * Pixels inside the mask take the given color, pixels outside are transparent.
 */
export function maskToImageData(
  rle: RLEMask,
  color: [number, number, number, number]
): ImageData {
  const [h, w] = rle.size
  const data = new Uint8ClampedArray(w * h * 4)
  const decoded = decodeRLE(rle)
  const [r, g, b, a] = color
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i]) {
      const di = i * 4
      data[di] = r
      data[di + 1] = g
      data[di + 2] = b
      data[di + 3] = a
    }
  }
  return new ImageData(data, w, h)
}

/**
 * Find the nearest pixel inside the mask to a given point.
 * Uses a spiral / expanding-ring search up to maxRadius pixels.
 * Returns null if no pixel inside the mask is found within maxRadius.
 */
export function clampPointToMask(
  p: Point2D,
  rle: RLEMask,
  maxRadius = 80
): Point2D | null {
  if (pointInMask(rle, p.x, p.y)) {
    return { x: Math.round(p.x), y: Math.round(p.y) }
  }
  const cx = Math.round(p.x)
  const cy = Math.round(p.y)
  // Expanding rings
  for (let r = 1; r <= maxRadius; r++) {
    // Top + bottom edges
    for (let dx = -r; dx <= r; dx++) {
      if (pointInMask(rle, cx + dx, cy - r)) return { x: cx + dx, y: cy - r }
      if (pointInMask(rle, cx + dx, cy + r)) return { x: cx + dx, y: cy + r }
    }
    // Left + right edges (skip corners already checked)
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      if (pointInMask(rle, cx - r, cy + dy)) return { x: cx - r, y: cy + dy }
      if (pointInMask(rle, cx + r, cy + dy)) return { x: cx + r, y: cy + dy }
    }
  }
  return null
}

/**
 * Test which zone (if any) contains the given point in image coordinates.
 * Converts image → video coords using the stored sam2 video dimensions.
 * Returns the first matching zoneId, or null if the point is outside all zones.
 */
export function findZoneContainingPoint(
  pImage: Point2D,
  imageWidth: number,
  imageHeight: number,
  sam2VideoWidth: number,
  sam2VideoHeight: number,
  masksFrame0: Record<string, RLEMask>
): string | null {
  const vx = (pImage.x / imageWidth) * sam2VideoWidth
  const vy = (pImage.y / imageHeight) * sam2VideoHeight
  for (const zoneId of Object.keys(masksFrame0)) {
    if (pointInMask(masksFrame0[zoneId], vx, vy)) {
      return zoneId
    }
  }
  return null
}
