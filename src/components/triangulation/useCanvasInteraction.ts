import { useRef, useCallback, useEffect } from 'react'
import type { Point2D } from '../../types/project'

export interface Transform {
  offsetX: number
  offsetY: number
  scale: number
}

export function useCanvasInteraction(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const transformRef = useRef<Transform>({ offsetX: 0, offsetY: 0, scale: 1 })
  const isPanning = useRef(false)
  const lastPan = useRef({ x: 0, y: 0 })
  const spaceDown = useRef(false)

  // Convert screen coordinates to image coordinates
  const screenToImage = useCallback(
    (screenX: number, screenY: number): Point2D => {
      const canvas = canvasRef.current
      if (!canvas) return { x: screenX, y: screenY }

      const rect = canvas.getBoundingClientRect()
      const t = transformRef.current
      const canvasX = screenX - rect.left
      const canvasY = screenY - rect.top

      return {
        x: (canvasX - t.offsetX) / t.scale,
        y: (canvasY - t.offsetY) / t.scale,
      }
    },
    [canvasRef]
  )

  // Convert image coordinates to screen coordinates
  const imageToScreen = useCallback(
    (imgX: number, imgY: number): Point2D => {
      const t = transformRef.current
      return {
        x: imgX * t.scale + t.offsetX,
        y: imgY * t.scale + t.offsetY,
      }
    },
    []
  )

  // Fit image to canvas (uses CSS pixel dimensions, not physical pixels)
  const fitToCanvas = useCallback(
    (imageWidth: number, imageHeight: number) => {
      const canvas = canvasRef.current
      if (!canvas) return

      // Use CSS dimensions (getBoundingClientRect), not canvas.width (which includes DPR)
      const rect = canvas.getBoundingClientRect()
      const cssW = rect.width
      const cssH = rect.height

      const padding = 20
      const availW = cssW - padding * 2
      const availH = cssH - padding * 2
      const scale = Math.min(availW / imageWidth, availH / imageHeight)

      transformRef.current = {
        scale,
        offsetX: (cssW - imageWidth * scale) / 2,
        offsetY: (cssH - imageHeight * scale) / 2,
      }
    },
    [canvasRef]
  )

  // Zoom handler
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const t = transformRef.current
      const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9
      const newScale = Math.max(0.1, Math.min(10, t.scale * zoomFactor))

      // Zoom around cursor position
      t.offsetX = mouseX - (mouseX - t.offsetX) * (newScale / t.scale)
      t.offsetY = mouseY - (mouseY - t.offsetY) * (newScale / t.scale)
      t.scale = newScale
    },
    [canvasRef]
  )

  // Pan handlers (middle click OR Space + left click)
  const startPan = useCallback((e: MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      isPanning.current = true
      lastPan.current = { x: e.clientX, y: e.clientY }
      e.preventDefault()
    }
  }, [])

  const movePan = useCallback((e: MouseEvent) => {
    if (!isPanning.current) return
    const t = transformRef.current
    t.offsetX += e.clientX - lastPan.current.x
    t.offsetY += e.clientY - lastPan.current.y
    lastPan.current = { x: e.clientX, y: e.clientY }
  }, [])

  const endPan = useCallback(() => {
    isPanning.current = false
  }, [])

  // Attach wheel listener with passive: false
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
        spaceDown.current = true
        if (canvas) canvas.style.cursor = 'grab'
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false
        isPanning.current = false
        if (canvas) canvas.style.cursor = ''
      }
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false })
    canvas.addEventListener('mousedown', startPan)
    window.addEventListener('mousemove', movePan)
    window.addEventListener('mouseup', endPan)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      canvas.removeEventListener('wheel', handleWheel)
      canvas.removeEventListener('mousedown', startPan)
      window.removeEventListener('mousemove', movePan)
      window.removeEventListener('mouseup', endPan)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [canvasRef, handleWheel, startPan, movePan, endPan])

  return {
    transformRef,
    screenToImage,
    imageToScreen,
    fitToCanvas,
    isPanning,
    spaceDown,
  }
}
