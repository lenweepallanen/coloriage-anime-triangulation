import { useRef, useEffect, useState, useCallback } from 'react'
import type { Point2D } from '../../types/project'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'

interface Props {
  videoBlob: Blob
  imageWidth: number
  imageHeight: number
  frameIndex: number
  anchorPositions: Point2D[]
  referencePositions?: Point2D[]
  totalFrames: number
  onUpdatePositions: (positions: Point2D[]) => void
  onPropagateForwardOne: () => void
  onPropagateForwardAll: () => void
  onPropagateBidiOne: () => void
  onPropagateBidiAll: () => void
  onValidateOnly?: () => void
  propagating?: boolean
  isFirstKeyframe?: boolean
  isLastKeyframe?: boolean
}

export default function KeyframeEditor({
  videoBlob,
  imageWidth,
  imageHeight,
  frameIndex,
  anchorPositions,
  totalFrames,
  onUpdatePositions,
  onPropagateForwardOne,
  onPropagateForwardAll,
  onPropagateBidiOne,
  onPropagateBidiAll,
  onValidateOnly,
  propagating,
  referencePositions,
  isFirstKeyframe,
  isLastKeyframe,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const refCanvasRef = useRef<HTMLCanvasElement>(null)
  const refContainerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoReady, setVideoReady] = useState(false)
  const { transformRef, screenToImage, fitToCanvas } = useCanvasInteraction(canvasRef)
  const draggingIdx = useRef<number | null>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  // Load video
  useEffect(() => {
    const url = URL.createObjectURL(videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      videoRef.current = video
      setVideoReady(true)
    }
    video.load()

    return () => {
      video.pause()
      URL.revokeObjectURL(url)
    }
  }, [videoBlob])

  // Seek video to frame
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady) return
    video.currentTime = frameIndex / 24
  }, [frameIndex, videoReady])

  // Fit to canvas on video load
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoReady) return
    fitToCanvas(video.videoWidth, video.videoHeight)
  }, [videoReady, fitToCanvas])

  // Resize canvas
  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Draw loop
  useEffect(() => {
    let running = true
    let rafId = 0

    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video || !videoReady) {
        rafId = requestAnimationFrame(draw)
        return
      }

      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr
      ctx.clearRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)

      // Draw video frame
      ctx.drawImage(video, 0, 0)

      // Convert anchor positions from image coords to video coords and draw
      const vw = video.videoWidth
      const vh = video.videoHeight
      const pr = 6 / t.scale
      const hr = 10 / t.scale

      const labelSize = Math.max(8, 11 / t.scale)
      for (let i = 0; i < anchorPositions.length; i++) {
        const p = anchorPositions[i]
        // image coords → video coords
        const vx = (p.x / imageWidth) * vw
        const vy = (p.y / imageHeight) * vh
        const isHovered = hoveredIdx === i
        const isDragging = draggingIdx.current === i
        const r = isHovered || isDragging ? hr : pr

        ctx.fillStyle = isDragging ? '#22c55e' : isHovered ? '#fbbf24' : '#f59e0b'
        ctx.beginPath()
        ctx.arc(vx, vy, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 1.5 / t.scale
        ctx.stroke()

        // Number label
        const label = String(i)
        ctx.font = `bold ${labelSize}px sans-serif`
        const tw = ctx.measureText(label).width
        const pad = 2 / t.scale
        const bx = vx + r + 2 / t.scale
        const by = vy - r
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        ctx.fillRect(bx - pad, by - labelSize + pad, tw + pad * 2, labelSize + pad)
        ctx.fillStyle = '#fff'
        ctx.fillText(label, bx, by)
      }

      // Frame info
      ctx.restore()
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(8, 8, 130, 24)
      ctx.fillStyle = '#fff'
      ctx.font = '12px monospace'
      ctx.fillText(`Keyframe ${frameIndex} / ${totalFrames - 1}`, 14, 24)

      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [videoReady, anchorPositions, hoveredIdx, frameIndex, totalFrames, imageWidth, imageHeight, transformRef])

  // Resize reference canvas
  useEffect(() => {
    const container = refContainerRef.current
    const canvas = refCanvasRef.current
    if (!container || !canvas) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Draw reference canvas with video frame 0
  useEffect(() => {
    if (!videoReady || !referencePositions) return
    const video = videoRef.current
    const canvas = refCanvasRef.current
    if (!video || !canvas) return

    // Create a separate video element for frame 0
    const refVideo = document.createElement('video')
    const url = URL.createObjectURL(videoBlob)
    refVideo.src = url
    refVideo.muted = true
    refVideo.preload = 'auto'

    refVideo.onloadeddata = () => {
      refVideo.currentTime = 0
      refVideo.onseeked = () => {
        drawRefFrame(canvas, refVideo, referencePositions!, imageWidth, imageHeight)
        URL.revokeObjectURL(url)
      }
    }
    refVideo.load()

    return () => URL.revokeObjectURL(url)
  }, [videoReady, referencePositions, videoBlob, imageWidth, imageHeight])

  // Convert screen coords to image coords (via video coords)
  const screenToImageCoords = useCallback((clientX: number, clientY: number): Point2D => {
    const video = videoRef.current
    if (!video) return { x: 0, y: 0 }
    // screenToImage gives video coordinates
    const vidCoords = screenToImage(clientX, clientY)
    return {
      x: (vidCoords.x / video.videoWidth) * imageWidth,
      y: (vidCoords.y / video.videoHeight) * imageHeight,
    }
  }, [screenToImage, imageWidth, imageHeight])

  const hitTest = useCallback((imgPos: Point2D): number | null => {
    const video = videoRef.current
    if (!video) return null
    const hitRadius = 10 / transformRef.current.scale
    const hitRadiusSq = hitRadius * hitRadius

    for (let i = anchorPositions.length - 1; i >= 0; i--) {
      const p = anchorPositions[i]
      const vx = (p.x / imageWidth) * video.videoWidth
      const vy = (p.y / imageHeight) * video.videoHeight
      const pvx = (imgPos.x / imageWidth) * video.videoWidth
      const pvy = (imgPos.y / imageHeight) * video.videoHeight
      const dx = pvx - vx
      const dy = pvy - vy
      if (dx * dx + dy * dy <= hitRadiusSq) return i
    }
    return null
  }, [anchorPositions, imageWidth, imageHeight, transformRef])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    const imgPos = screenToImageCoords(e.clientX, e.clientY)
    const idx = hitTest(imgPos)
    if (idx !== null) {
      draggingIdx.current = idx
    }
  }, [screenToImageCoords, hitTest])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const imgPos = screenToImageCoords(e.clientX, e.clientY)

    if (draggingIdx.current !== null) {
      const idx = draggingIdx.current
      const newPositions = [...anchorPositions]
      newPositions[idx] = imgPos
      onUpdatePositions(newPositions)
      return
    }

    setHoveredIdx(hitTest(imgPos))
  }, [screenToImageCoords, hitTest, anchorPositions, onUpdatePositions])

  const handleMouseUp = useCallback(() => {
    draggingIdx.current = null
  }, [])

  return (
    <div className="keyframe-editor">
      <div className="keyframe-editor-toolbar">
        {!isLastKeyframe && (
          <button
            onClick={onPropagateForwardOne}
            disabled={propagating}
            style={{ background: '#22c55e', color: 'white' }}
          >
            {propagating ? 'Propagation...' : 'Propager avant'}
          </button>
        )}
        {!isLastKeyframe && (
          <button
            onClick={onPropagateForwardAll}
            disabled={propagating}
            style={{ background: '#16a34a', color: 'white' }}
          >
            Propager avant (tout)
          </button>
        )}
        <button
          onClick={onPropagateBidiOne}
          disabled={propagating || (isFirstKeyframe && isLastKeyframe)}
          style={{ background: '#2563eb', color: 'white' }}
        >
          Bidi (1 pas)
        </button>
        <button
          onClick={onPropagateBidiAll}
          disabled={propagating || (isFirstKeyframe && isLastKeyframe)}
          style={{ background: '#1d4ed8', color: 'white' }}
        >
          Bidi (tout)
        </button>
        {onValidateOnly && (
          <button onClick={onValidateOnly} disabled={propagating}>
            Passer
          </button>
        )}
        <span style={{ fontSize: '0.75rem', color: '#888' }}>
          Glissez les points pour corriger | Avant = vers keyframes suivantes | Bidi = avant + arrière
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flex: 1, minHeight: 0 }}>
        <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 3 }}>
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            style={{ cursor: hoveredIdx !== null ? 'grab' : 'default' }}
          />
        </div>
        {referencePositions && (
          <div ref={refContainerRef} className="keyframe-editor-canvas-container" style={{ flex: 1, minWidth: 200 }}>
            <canvas ref={refCanvasRef} style={{ cursor: 'default' }} />
          </div>
        )}
      </div>
    </div>
  )
}

function drawRefFrame(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  positions: Point2D[],
  imageWidth: number,
  imageHeight: number
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const cssW = canvas.width / dpr
  const cssH = canvas.height / dpr
  ctx.clearRect(0, 0, cssW, cssH)

  const vw = video.videoWidth
  const vh = video.videoHeight
  const scaleX = cssW / vw
  const scaleY = cssH / vh
  const s = Math.min(scaleX, scaleY) * 0.95
  const ox = (cssW - vw * s) / 2
  const oy = (cssH - vh * s) / 2

  ctx.drawImage(video, ox, oy, vw * s, vh * s)

  // Header
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(8, 8, 100, 24)
  ctx.fillStyle = '#fff'
  ctx.font = '12px monospace'
  ctx.fillText('Frame 0 (ref)', 14, 24)

  // Draw anchor positions
  const pr = 4
  const labelSize = 9
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i]
    const vx = (p.x / imageWidth) * vw * s + ox
    const vy = (p.y / imageHeight) * vh * s + oy

    ctx.fillStyle = '#f59e0b'
    ctx.beginPath()
    ctx.arc(vx, vy, pr, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'white'
    ctx.lineWidth = 1
    ctx.stroke()

    const label = String(i)
    ctx.font = `bold ${labelSize}px sans-serif`
    const tw = ctx.measureText(label).width
    const pad = 1
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
    ctx.fillRect(vx + pr + 1 - pad, vy - pr - labelSize + pad, tw + pad * 2, labelSize + pad)
    ctx.fillStyle = '#fff'
    ctx.fillText(label, vx + pr + 1, vy - pr)
  }
}
