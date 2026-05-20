import { useRef, useState, useCallback, useEffect } from 'react'

export type TimelineSelection =
  | { type: 'restPoint' }
  | { type: 'entryStart' }

interface Props {
  backgroundImageUrl: string | null
  backgroundWidth: number
  backgroundHeight: number
  restPointX: number
  entry: 'fixed' | 'moving'
  entryStartX?: number
  selection: TimelineSelection | null
  onSelect: (selection: TimelineSelection | null) => void
  onMoveRestPoint: (backgroundX: number) => void
  onMoveEntryStart: (backgroundX: number) => void
  // Character preview
  characterImageUrl?: string | null
  characterImageWidth?: number
  characterImageHeight?: number
  characterScale?: number
  characterY?: number
}

const MIN_TIMELINE_HEIGHT = 100
const DEFAULT_TIMELINE_HEIGHT = 200
const MAX_TIMELINE_HEIGHT = 800
const REST_POINT_RADIUS = 12
const ENTRY_POINT_SIZE = 14

type DragTarget = 'restPoint' | 'entryStart'

export default function SceneTimeline({
  backgroundImageUrl,
  backgroundWidth,
  backgroundHeight,
  restPointX,
  entry,
  entryStartX,
  selection,
  onSelect,
  onMoveRestPoint,
  onMoveEntryStart,
  characterImageUrl,
  characterImageWidth,
  characterImageHeight,
  characterScale: charScale = 1,
  characterY: charY = 0,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<DragTarget | null>(null)
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT)
  const [resizing, setResizing] = useState(false)

  const aspectRatio = backgroundHeight > 0 ? backgroundWidth / backgroundHeight : 1
  const wrapperWidth = wrapperRef.current?.clientWidth ?? Infinity
  const rawWidth = timelineHeight * aspectRatio
  const timelineWidth = Math.min(rawWidth, wrapperWidth)
  const effectiveHeight = rawWidth > wrapperWidth ? wrapperWidth / aspectRatio : timelineHeight
  const scale = backgroundHeight > 0 ? effectiveHeight / backgroundHeight : 1

  const toTimelineX = useCallback((bgX: number) => bgX * scale, [scale])
  const toBackgroundX = useCallback((tlX: number) => Math.round(tlX / scale), [scale])

  useEffect(() => {
    if (!resizing) return
    const onMouseMove = (e: MouseEvent) => {
      const wrapper = wrapperRef.current
      if (!wrapper) return
      const wrapperRect = wrapper.getBoundingClientRect()
      const newHeight = Math.max(MIN_TIMELINE_HEIGHT, Math.min(MAX_TIMELINE_HEIGHT, e.clientY - wrapperRect.top))
      setTimelineHeight(newHeight)
    }
    const onMouseUp = () => {
      setResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [resizing])

  useEffect(() => {
    if (!dragging) return
    const container = containerRef.current
    if (!container) return

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left + container.scrollLeft
      const bgX = toBackgroundX(Math.max(0, Math.min(timelineWidth, x)))
      const clampedBgX = Math.max(0, Math.min(backgroundWidth, bgX))
      if (dragging === 'restPoint') onMoveRestPoint(clampedBgX)
      else if (dragging === 'entryStart') onMoveEntryStart(clampedBgX)
    }
    const onMouseUp = () => {
      setDragging(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [dragging, toBackgroundX, timelineWidth, backgroundWidth, onMoveRestPoint, onMoveEntryStart])

  const restX = toTimelineX(restPointX)
  const entryX = entryStartX != null ? toTimelineX(entryStartX) : null

  // Character preview at rest point
  const charPx = characterImageWidth && characterImageHeight && characterImageWidth > 0
    ? {
        w: characterImageWidth * scale * charScale,
        h: characterImageHeight * scale * charScale,
        y: effectiveHeight / 2 - (charY * scale),
      }
    : null

  return (
    <div ref={wrapperRef} className="scene-timeline-wrapper">
      <div
        ref={containerRef}
        className="scene-timeline"
        style={{
          width: timelineWidth,
          height: effectiveHeight,
          backgroundImage: backgroundImageUrl ? `url(${backgroundImageUrl})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          position: 'relative',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
        }}
      >
        {/* Entry start (fantôme) */}
        {entry === 'moving' && entryX != null && (
          <>
            {/* Arrow line entryStart → restPoint */}
            <svg
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            >
              <line
                x1={entryX} y1={effectiveHeight / 2}
                x2={restX} y2={effectiveHeight / 2}
                stroke="rgba(255,255,255,0.5)"
                strokeWidth={2}
                strokeDasharray="6 4"
                markerEnd="url(#tl-arrow)"
              />
              <defs>
                <marker id="tl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.7)" />
                </marker>
              </defs>
            </svg>
            <div
              onMouseDown={(e) => { e.stopPropagation(); setDragging('entryStart'); onSelect({ type: 'entryStart' }) }}
              style={{
                position: 'absolute',
                left: entryX - ENTRY_POINT_SIZE / 2,
                top: effectiveHeight / 2 - ENTRY_POINT_SIZE / 2,
                width: ENTRY_POINT_SIZE, height: ENTRY_POINT_SIZE,
                background: selection?.type === 'entryStart' ? '#ffa726' : 'rgba(255,167,38,0.5)',
                border: '2px solid #fff',
                cursor: 'grab',
                transform: 'rotate(45deg)',
              }}
              title="Position de départ"
            />
          </>
        )}

        {/* Character preview at rest point */}
        {characterImageUrl && charPx && (
          <img
            src={characterImageUrl}
            alt=""
            style={{
              position: 'absolute',
              left: restX - charPx.w / 2,
              top: charPx.y - charPx.h / 2,
              width: charPx.w, height: charPx.h,
              pointerEvents: 'none',
              opacity: 0.85,
            }}
          />
        )}

        {/* Rest point handle */}
        <div
          onMouseDown={(e) => { e.stopPropagation(); setDragging('restPoint'); onSelect({ type: 'restPoint' }) }}
          style={{
            position: 'absolute',
            left: restX - REST_POINT_RADIUS,
            top: effectiveHeight / 2 - REST_POINT_RADIUS,
            width: REST_POINT_RADIUS * 2,
            height: REST_POINT_RADIUS * 2,
            borderRadius: '50%',
            background: selection?.type === 'restPoint' ? '#42a5f5' : 'rgba(66,165,245,0.5)',
            border: '2px solid #fff',
            cursor: 'grab',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          }}
          title="Rest point (position au repos)"
        />
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={() => setResizing(true)}
        style={{
          height: 6,
          cursor: 'ns-resize',
          background: 'transparent',
          borderTop: '1px dashed var(--border)',
          marginTop: 4,
        }}
      />
    </div>
  )
}
