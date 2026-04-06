/**
 * Limb Mask Generator — Generates a binary mask from walk limb zones
 * for LaMa inpainting. White pixels = areas to inpaint (limbs),
 * black pixels = areas to preserve.
 */

import type { Point2D, WalkLimbZone } from '../types/project'
import type { ContentAlignment } from './textureExtractor'
import { flattenClosedBezier, expandPolygon } from './bezierUtils'
import { imageToScanPixel } from './hiddenFaceTexture'

/**
 * Generate a binary mask canvas from walk limb zone Bézier polygons.
 * White = limb areas to inpaint, black = preserve.
 */
export function generateLimbMask(
  zones: WalkLimbZone[],
  scanW: number,
  scanH: number,
  imageW: number,
  imageH: number,
  contentAlignment?: ContentAlignment,
  dilationPx = 8,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = scanW
  canvas.height = scanH
  const ctx = canvas.getContext('2d')!

  // Black background (preserve)
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, scanW, scanH)

  // White fill for each dilated limb zone polygon
  ctx.fillStyle = '#ffffff'
  for (const zone of zones) {
    if (!zone.bezierNodes || zone.bezierNodes.length < 2) continue

    // Flatten Bézier curve to polygon in image coordinates
    const polygon = flattenClosedBezier(zone.bezierNodes, 50)
    if (polygon.length < 3) continue

    // Dilate polygon outward
    const dilated = dilationPx > 0 ? expandPolygon(polygon, dilationPx) : polygon

    // Convert image coords → scan canvas pixel coords
    const scanPolygon = dilated.map(p =>
      imageToScanPixel(p, imageW, imageH, scanW, scanH, contentAlignment)
    )

    // Draw filled polygon
    ctx.beginPath()
    ctx.moveTo(scanPolygon[0].x, scanPolygon[0].y)
    for (let i = 1; i < scanPolygon.length; i++) {
      ctx.lineTo(scanPolygon[i].x, scanPolygon[i].y)
    }
    ctx.closePath()
    ctx.fill()
  }

  return canvas
}

/**
 * Generate a binary mask for a limb extension zone (hidden face limb).
 * White = extension area to inpaint, black = preserve.
 * The mask covers only the extension triangles of the specified zone.
 */
export function generateLimbExtensionMask(
  zonePoints: Point2D[],
  zoneTriangles: [number, number, number][],
  extensionTriangleIndices: number[],
  scanW: number,
  scanH: number,
  imageW: number,
  imageH: number,
  contentAlignment?: ContentAlignment,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = scanW
  canvas.height = scanH
  const ctx = canvas.getContext('2d')!

  // Black background (preserve)
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, scanW, scanH)

  // White fill for extension triangles
  ctx.fillStyle = '#ffffff'
  for (const ti of extensionTriangleIndices) {
    const tri = zoneTriangles[ti]
    if (!tri) continue
    const [a, b, c] = tri
    const pa = zonePoints[a], pb = zonePoints[b], pc = zonePoints[c]
    if (!pa || !pb || !pc) continue

    const sa = imageToScanPixel(pa, imageW, imageH, scanW, scanH, contentAlignment)
    const sb = imageToScanPixel(pb, imageW, imageH, scanW, scanH, contentAlignment)
    const sc = imageToScanPixel(pc, imageW, imageH, scanW, scanH, contentAlignment)

    ctx.beginPath()
    ctx.moveTo(sa.x, sa.y)
    ctx.lineTo(sb.x, sb.y)
    ctx.lineTo(sc.x, sc.y)
    ctx.closePath()
    ctx.fill()
  }

  return canvas
}

/**
 * Convert a mask canvas to a PNG Blob for upload.
 */
export function maskCanvasToBlob(maskCanvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    maskCanvas.toBlob(blob => {
      if (blob) resolve(blob)
      else reject(new Error('Failed to convert mask canvas to blob'))
    }, 'image/png')
  })
}
