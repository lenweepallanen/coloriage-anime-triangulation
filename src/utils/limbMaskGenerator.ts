/**
 * Limb Mask Generator — Generates a binary mask from walk limb zones
 * for LaMa inpainting. White pixels = areas to inpaint (limbs),
 * black pixels = areas to preserve.
 */

import type { WalkLimbZone } from '../types/project'
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
