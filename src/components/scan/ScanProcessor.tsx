import { useState, useCallback } from 'react'
import type { Project } from '../../types/project'
import type { DetectedMarkers } from '../../utils/markerDetector'
import { loadOpenCV } from '../../utils/opencvLoader'
import { rectifyImage } from '../../utils/homography'
import { createScan } from '../../db/scansStore'

interface Props {
  project: Project
  onRectified: (scanCanvas: HTMLCanvasElement) => void
}

export default function ScanProcessor({ project, onRectified }: Props) {
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCapture = useCallback(
    async (captureCanvas: HTMLCanvasElement, markers: DetectedMarkers) => {
      setProcessing(true)
      setError(null)

      try {
        const cv = await loadOpenCV()

        // Get original image dimensions for the target rectification size
        const imgDims = await getImageDimensions(project.originalImageBlob!)

        // Rectify the captured image
        const { canvas: rectifiedCanvas, blob } = await rectifyImage(
          cv,
          captureCanvas,
          markers,
          imgDims.width,
          imgDims.height
        )

        // Save scan to IndexedDB
        await createScan(project.id, blob)

        onRectified(rectifiedCanvas)
      } catch (err) {
        console.error('Scan processing failed:', err)
        setError(err instanceof Error ? err.message : 'Erreur de traitement')
        setProcessing(false)
      }
    },
    [project, onRectified]
  )

  return { handleCapture, processing, error }
}

// Hook version for cleaner integration
export function useScanProcessor(project: Project) {
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rectifiedCanvas, setRectifiedCanvas] = useState<HTMLCanvasElement | null>(null)

  const handleCapture = useCallback(
    async (captureCanvas: HTMLCanvasElement, markers: DetectedMarkers) => {
      setProcessing(true)
      setError(null)

      try {
        const cv = await loadOpenCV()
        const imgDims = await getImageDimensions(project.originalImageBlob!)

        const { canvas, blob } = await rectifyImage(
          cv,
          captureCanvas,
          markers,
          imgDims.width,
          imgDims.height
        )

        await createScan(project.id, blob)
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
