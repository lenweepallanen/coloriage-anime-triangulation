/**
 * Shared PDF layout constants used by both pdfGenerator (generation)
 * and ScanProcessor (perspective correction crop).
 */

// A4 dimensions in mm
export const A4_W = 210
export const A4_H = 297
export const MARGIN = 15       // mm margin for content on A4

// L-marker geometry in mm
export const MARKER_SIZE = 15  // size of L marker arms
export const MARKER_THICK = 4  // thickness of L marker arms
export const MARKER_MARGIN = 2 // mm gap between image edge and marker reference corner

/**
 * Compute how far (in mm) the centroid of an L-shaped marker sits
 * INSIDE the actual image edge.
 *
 * The L has two arms (horizontal: S×T, vertical: T×S) overlapping at (T×T).
 * Its centroid is at ~5.17mm from the reference corner.
 * The reference corner is MARKER_MARGIN mm outside the image edge.
 * So the centroid is (5.17 - 2) ≈ 3.17mm inside the image.
 */
export function computeLMarkerCentroidOffset(): number {
  const S = MARKER_SIZE
  const T = MARKER_THICK
  const combinedArea = 2 * S * T - T * T
  const centroidFromCorner = (S * S * T + S * T * T - T * T * T) / (2 * combinedArea)
  return centroidFromCorner - MARKER_MARGIN
}

/**
 * Compute the physical printed image dimensions (in mm) on an A4 page,
 * given the image aspect ratio.
 */
export function computePrintedImageSize(imgAspect: number): { imgW_mm: number; imgH_mm: number } {
  const contentW = A4_W - MARGIN * 2  // 180mm
  const contentH = A4_H - MARGIN * 2  // 267mm

  if (imgAspect > contentW / contentH) {
    return { imgW_mm: contentW, imgH_mm: contentW / imgAspect }
  } else {
    return { imgW_mm: contentH * imgAspect, imgH_mm: contentH }
  }
}

/**
 * Compute the pixel insets for the scan texture.
 *
 * The scan crop is centered on L-marker centroids, which are ~3.17mm inside
 * the actual image edges. This means the scan texture is slightly zoomed in:
 * it shows the image from (insetX, insetY) to (imgW - insetX, imgH - insetY).
 *
 * Returns insets in image pixel coordinates, to be used for UV correction
 * in AnimationPlayer and mesh overlay in ScanProcessor.
 */
export function computeScanInsets(
  imgWidth: number,
  imgHeight: number
): { insetX: number; insetY: number } {
  const imgAspect = imgWidth / imgHeight
  const { imgW_mm, imgH_mm } = computePrintedImageSize(imgAspect)
  const centroidOffset = computeLMarkerCentroidOffset() // ~3.173mm

  // Convert mm offset to image pixel coordinates
  const insetX = centroidOffset / imgW_mm * imgWidth
  const insetY = centroidOffset / imgH_mm * imgHeight

  return { insetX, insetY }
}
