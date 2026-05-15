import { useState, useEffect, useRef, useCallback } from 'react'
import type { Point2D } from '../../types/project'

interface Props {
  imageBlob: Blob
  initialCorners: Point2D[] | null
  onConfirm: (adjustedCorners: Point2D[]) => void
  onRetake: () => void
}

export default function CornerAdjustment({ imageBlob, initialCorners, onConfirm, onRetake }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null)
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null)
  const [corners, setCorners] = useState<Point2D[] | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)

  // Convert blob to object URL
  useEffect(() => {
    if (!imageBlob) return
    const url = URL.createObjectURL(imageBlob)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageBlob])

  // Get natural image size once loaded
  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const natW = img.naturalWidth
    const natH = img.naturalHeight
    setImageSize({ w: natW, h: natH })

    const rect = img.getBoundingClientRect()
    setDisplaySize({ w: rect.width, h: rect.height })

    if (initialCorners && initialCorners.length === 4) {
      setCorners(initialCorners.map(c => ({ ...c })))
    } else {
      const m = 0.1
      setCorners([
        { x: natW * m, y: natH * m },
        { x: natW * (1 - m), y: natH * m },
        { x: natW * (1 - m), y: natH * (1 - m) },
        { x: natW * m, y: natH * (1 - m) },
      ])
    }
  }, [initialCorners])

  // Update displaySize on resize
  useEffect(() => {
    if (!containerRef.current) return
    const obs = new ResizeObserver(() => {
      const img = containerRef.current?.querySelector('img')
      if (img) {
        const rect = img.getBoundingClientRect()
        setDisplaySize({ w: rect.width, h: rect.height })
      }
    })
    obs.observe(containerRef.current)
    return () => obs.disconnect()
  }, [])

  const toDisplay = useCallback((pt: Point2D): Point2D => {
    if (!imageSize || !displaySize) return { x: 0, y: 0 }
    const ratio = displaySize.w / imageSize.w
    return { x: pt.x * ratio, y: pt.y * ratio }
  }, [imageSize, displaySize])

  const toFullRes = useCallback((dx: number, dy: number): Point2D => {
    if (!imageSize || !displaySize) return { x: 0, y: 0 }
    const ratio = imageSize.w / displaySize.w
    return { x: dx * ratio, y: dy * ratio }
  }, [imageSize, displaySize])

  const handlePointerDown = useCallback((e: React.PointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setActiveIndex(index)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (activeIndex < 0 || !corners || !imageSize || !displaySize) return
    e.preventDefault()

    const svg = e.currentTarget
    const rect = svg.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top

    const clampedX = Math.max(0, Math.min(dx, displaySize.w))
    const clampedY = Math.max(0, Math.min(dy, displaySize.h))

    const fullRes = toFullRes(clampedX, clampedY)
    setCorners(prev => {
      if (!prev) return prev
      const next = [...prev]
      next[activeIndex] = fullRes
      return next
    })
  }, [activeIndex, corners, imageSize, displaySize, toFullRes])

  const handlePointerUp = useCallback(() => {
    setActiveIndex(-1)
  }, [])

  const handleResetCorners = useCallback(() => {
    if (initialCorners && initialCorners.length === 4) {
      setCorners(initialCorners.map(c => ({ ...c })))
    }
  }, [initialCorners])

  if (!imageUrl) return null

  const displayCorners = corners ? corners.map(toDisplay) : []
  const polygonPoints = displayCorners.map(c => `${c.x},${c.y}`).join(' ')

  return (
    <div className="corner-adjustment">
      <div ref={containerRef} className="corner-adjustment-image-area">
        <div className="corner-adjustment-photo">
          <img
            src={imageUrl}
            alt="Photo capturée"
            onLoad={handleImageLoad}
            className="corner-adjustment-img"
            draggable={false}
          />

          {corners && displaySize && (
            <svg
              className="corner-adjustment-svg"
              viewBox={`0 0 ${displaySize.w} ${displaySize.h}`}
              style={{ touchAction: 'none' }}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <defs>
                <mask id="corner-mask">
                  <rect width={displaySize.w} height={displaySize.h} fill="white" />
                  <polygon points={polygonPoints} fill="black" />
                </mask>
              </defs>
              <rect
                width={displaySize.w}
                height={displaySize.h}
                fill="rgba(0,0,0,0.5)"
                mask="url(#corner-mask)"
              />

              {displayCorners.map((c, i) => {
                const next = displayCorners[(i + 1) % 4]
                return (
                  <line
                    key={`line-${i}`}
                    x1={c.x} y1={c.y}
                    x2={next.x} y2={next.y}
                    stroke="white"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                )
              })}

              {displayCorners.map((c, i) => (
                <circle
                  key={`corner-${i}`}
                  cx={c.x}
                  cy={c.y}
                  r={activeIndex === i ? 26 : 22}
                  fill="rgba(59, 130, 246, 0.8)"
                  stroke="white"
                  strokeWidth="3"
                  style={{
                    cursor: 'grab',
                    filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
                    transition: activeIndex === i ? 'none' : 'r 0.15s ease',
                  }}
                  onPointerDown={(e) => handlePointerDown(e, i)}
                />
              ))}
            </svg>
          )}
        </div>
      </div>

      <div className="corner-adjustment-buttons">
        <button onClick={onRetake} className="btn-retake">
          Reprendre
        </button>
        {initialCorners && initialCorners.length === 4 && (
          <button onClick={handleResetCorners} className="btn-auto-detect">
            Auto-détecter
          </button>
        )}
        <button onClick={() => corners && onConfirm(corners)} className="btn-validate">
          Valider
        </button>
      </div>
    </div>
  )
}
