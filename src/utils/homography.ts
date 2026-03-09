import type { Point2D } from '../types/project'

interface RectifyResult {
  canvas: HTMLCanvasElement
  blob: Blob
}

/**
 * Apply perspective transform to rectify the scanned image.
 * Maps detected marker corners to a rectangle.
 */
export async function rectifyImage(
  cv: any,
  sourceCanvas: HTMLCanvasElement,
  detectedCorners: {
    topLeft: Point2D
    topRight: Point2D
    bottomLeft: Point2D
    bottomRight: Point2D
  },
  targetWidth: number,
  targetHeight: number
): Promise<RectifyResult> {
  const src = cv.imread(sourceCanvas)

  // Source points (detected marker positions)
  const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    detectedCorners.topLeft.x, detectedCorners.topLeft.y,
    detectedCorners.topRight.x, detectedCorners.topRight.y,
    detectedCorners.bottomRight.x, detectedCorners.bottomRight.y,
    detectedCorners.bottomLeft.x, detectedCorners.bottomLeft.y,
  ])

  // Destination points (rectangle)
  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    targetWidth, 0,
    targetWidth, targetHeight,
    0, targetHeight,
  ])

  const M = cv.getPerspectiveTransform(srcPoints, dstPoints)
  const dst = new cv.Mat()
  const dsize = new cv.Size(targetWidth, targetHeight)
  cv.warpPerspective(src, dst, M, dsize)

  // Render to canvas
  const outCanvas = document.createElement('canvas')
  outCanvas.width = targetWidth
  outCanvas.height = targetHeight
  cv.imshow(outCanvas, dst)

  // Convert to blob
  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      b => b ? resolve(b) : reject(new Error('Failed to convert canvas to blob')),
      'image/png'
    )
  })

  // Cleanup
  src.delete()
  srcPoints.delete()
  dstPoints.delete()
  M.delete()
  dst.delete()

  return { canvas: outCanvas, blob }
}
