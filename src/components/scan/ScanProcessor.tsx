import { useState, useCallback } from 'react'
import type { Project } from '../../types/project'
import type { Point2D } from '../../types/project'
import { processCapturedImage } from '../../utils/perspectiveCorrection'
import { createScan } from '../../db/scansStore'

// Hook version for cleaner integration
export function useScanProcessor(project: Project) {
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rectifiedCanvas, setRectifiedCanvas] = useState<HTMLCanvasElement | null>(null)

  const handleCapture = useCallback(
    async (blob: Blob, corners: Point2D[] | null) => {
      setProcessing(true)
      setError(null)

      try {
        // Process via worker: detection + perspective correction -> 2048x2048
        const result = await processCapturedImage(blob, corners)

        // Get original image dimensions to resize for UV mapping compatibility
        const imgDims = await getImageDimensions(project.originalImageBlob!)

        // Create canvas at original image dimensions (preserves UV mapping in AnimationPlayer)
        const canvas = document.createElement('canvas')
        canvas.width = imgDims.width
        canvas.height = imgDims.height
        const ctx = canvas.getContext('2d')!

        // Draw the corrected 2048x2048 image scaled to original dimensions
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = result.imageData.width
        tempCanvas.height = result.imageData.height
        tempCanvas.getContext('2d')!.putImageData(result.imageData, 0, 0)
        ctx.drawImage(tempCanvas, 0, 0, imgDims.width, imgDims.height)

        // Save scan to IndexedDB
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
    setError(null)
  }, [])

  return { handleCapture, processing, error, rectifiedCanvas, reset }
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
