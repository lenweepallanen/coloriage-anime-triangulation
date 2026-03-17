import { useState, useCallback } from 'react'
import type { Project } from '../../types/project'
import type { Point2D } from '../../types/project'
import { processCapturedImage } from '../../utils/perspectiveCorrection'
import { computeScanInsets } from '../../utils/pdfLayout'
import { createScan } from '../../db/scansStore'

// Hook version for cleaner integration
export interface DebugImages {
  capturedUrl: string       // Photo brute prise par la caméra
  raw2048Url: string        // Image 2048x2048 après correction perspective (avec marges)
  rectifiedUrl: string      // Image croppée aux dimensions originales
  meshOverlayUrl: string    // Image croppée + overlay triangulation frame 0
}

export function useScanProcessor(project: Project) {
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rectifiedCanvas, setRectifiedCanvas] = useState<HTMLCanvasElement | null>(null)
  const [debugImages, setDebugImages] = useState<DebugImages | null>(null)

  const handleCapture = useCallback(
    async (blob: Blob, corners: Point2D[] | null) => {
      setProcessing(true)
      setError(null)

      try {
        // 1. Photo brute capturée
        const capturedUrl = URL.createObjectURL(blob)

        // Process via worker: detection + perspective correction -> 2048x2048
        const result = await processCapturedImage(blob, corners)

        // 2. Image 2048x2048 brute (avec marges)
        const raw2048Canvas = document.createElement('canvas')
        raw2048Canvas.width = result.imageData.width
        raw2048Canvas.height = result.imageData.height
        raw2048Canvas.getContext('2d')!.putImageData(result.imageData, 0, 0)
        const raw2048Url = raw2048Canvas.toDataURL()

        // Get original image dimensions to resize for UV mapping compatibility
        const imgDims = await getImageDimensions(project.originalImageBlob!)

        // Create canvas at original image dimensions (preserves UV mapping in AnimationPlayer)
        const canvas = document.createElement('canvas')
        canvas.width = imgDims.width
        canvas.height = imgDims.height
        const ctx = canvas.getContext('2d')!

        // Draw the corrected 2048x2048 image scaled to original dimensions.
        // The homography maps L-marker centroids to (margin, margin) in the 2048 space.
        // The centroid of an L-shape is ~3.17mm INSIDE the actual image edge,
        // so the scan content is slightly zoomed in compared to the full image.
        // This zoom is compensated in UV mapping (AnimationPlayer) and mesh overlay below.
        const margin = 64
        const srcSize = result.imageData.width // 2048
        const contentSize = srcSize - 2 * margin // 1920
        ctx.drawImage(raw2048Canvas, margin, margin, contentSize, contentSize, 0, 0, imgDims.width, imgDims.height)

        // Enhance contrast: push dark lines to true black, light areas to white
        enhanceContrast(ctx, imgDims.width, imgDims.height)

        // 3. Image redressée croppée
        const rectifiedUrl = canvas.toDataURL()

        // 4. Image redressée + overlay maillage frame 0
        const meshOverlayUrl = buildMeshOverlay(canvas, project)

        setDebugImages({ capturedUrl, raw2048Url, rectifiedUrl, meshOverlayUrl })

        // Save scan to Firebase
        const scanBlob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            b => b ? resolve(b) : reject(new Error('Failed to convert canvas to blob')),
            'image/png'
          )
        })
        await createScan(project.id, scanBlob)

        setRectifiedCanvas(canvas)
      } catch (err) {
        console.error('Scan processing failed:', err)
        setError(err instanceof Error ? err.message : 'Erreur de traitement')
      }

      setProcessing(false)
    },
    [project]
  )

  const reset = useCallback(() => {
    setRectifiedCanvas(null)
    setDebugImages(null)
    setError(null)
  }, [])

  return { handleCapture, processing, error, rectifiedCanvas, debugImages, reset }
}

/**
 * Levels adjustment: remap pixel values so that dark contour lines become
 * true black and the paper background becomes true white.
 * blackPoint / whitePoint are auto-detected from the image histogram.
 */
function enhanceContrast(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data

  // Build luminance histogram
  const hist = new Uint32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    hist[lum]++
  }

  // Auto-detect black/white points at 0.5% and 99.5% percentiles
  const totalPixels = w * h
  const lowThreshold = totalPixels * 0.005
  const highThreshold = totalPixels * 0.995

  let blackPoint = 0
  let whitePoint = 255
  let cumulative = 0
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i]
    if (cumulative >= lowThreshold) { blackPoint = i; break }
  }
  cumulative = 0
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i]
    if (cumulative >= highThreshold) { whitePoint = i; break }
  }

  // Ensure a minimum range
  if (whitePoint - blackPoint < 30) {
    blackPoint = Math.max(0, blackPoint - 15)
    whitePoint = Math.min(255, whitePoint + 15)
  }

  // Build lookup table
  const lut = new Uint8Array(256)
  const range = whitePoint - blackPoint
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.max(0, Math.min(255, Math.round(((i - blackPoint) / range) * 255)))
  }

  // Apply LUT to each channel
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]]
    data[i + 1] = lut[data[i + 1]]
    data[i + 2] = lut[data[i + 2]]
  }

  ctx.putImageData(imageData, 0, 0)
}

function buildMeshOverlay(rectifiedCanvas: HTMLCanvasElement, project: Project): string {
  const mesh = project.mesh
  if (!mesh) return rectifiedCanvas.toDataURL()

  const overlay = document.createElement('canvas')
  overlay.width = rectifiedCanvas.width
  overlay.height = rectifiedCanvas.height
  const ctx = overlay.getContext('2d')!

  // Draw the rectified image as background
  ctx.drawImage(rectifiedCanvas, 0, 0)

  // The scan texture is slightly zoomed in (L-marker centroids are inside the image edges).
  // Transform mesh points (image coords) → scan canvas coords.
  const { insetX, insetY } = computeScanInsets(rectifiedCanvas.width, rectifiedCanvas.height)
  const scaleX = rectifiedCanvas.width / (rectifiedCanvas.width - 2 * insetX)
  const scaleY = rectifiedCanvas.height / (rectifiedCanvas.height - 2 * insetY)
  const toScanX = (x: number) => (x - insetX) * scaleX
  const toScanY = (y: number) => (y - insetY) * scaleY

  // Get frame 0 points (or static points if no animation)
  const allPoints = [...mesh.contourAnchors, ...mesh.contourSubdivisionPoints, ...mesh.anchorPoints, ...mesh.internalPoints]
  const framePoints = mesh.videoFramesMesh && mesh.videoFramesMesh.length > 0
    ? mesh.videoFramesMesh[0]
    : allPoints

  // Draw triangles
  ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)'
  ctx.lineWidth = 1
  for (const tri of mesh.triangles) {
    const a = framePoints[tri[0]]
    const b = framePoints[tri[1]]
    const c = framePoints[tri[2]]
    ctx.beginPath()
    ctx.moveTo(toScanX(a.x), toScanY(a.y))
    ctx.lineTo(toScanX(b.x), toScanY(b.y))
    ctx.lineTo(toScanX(c.x), toScanY(c.y))
    ctx.closePath()
    ctx.stroke()
  }

  // Draw anchor points (red) and internal points (blue)
  for (let i = 0; i < framePoints.length; i++) {
    const p = framePoints[i]
    const isAnchor = i < mesh.anchorPoints.length
    ctx.fillStyle = isAnchor ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 100, 255, 0.8)'
    ctx.beginPath()
    ctx.arc(toScanX(p.x), toScanY(p.y), isAnchor ? 4 : 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  return overlay.toDataURL()
}

function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}
