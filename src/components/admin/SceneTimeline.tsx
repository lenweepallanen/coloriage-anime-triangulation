import { useRef, useState, useCallback, useEffect } from 'react'
import type { SceneRestPoint, SceneTransition } from '../../types/project'

export type TimelineSelection =
  | { type: 'restPoint'; index: number }
  | { type: 'startPoint' }
  | { type: 'segment'; transitionIndex: number; segmentIndex: number }

interface Props {
  backgroundImageUrl: string | null
  backgroundWidth: number
  backgroundHeight: number
  restPoints: SceneRestPoint[]
  transitions: SceneTransition[]
  startMode: 'rest' | 'transition'
  startX?: number
  startTransition?: SceneTransition
  selection: TimelineSelection | null
  onSelect: (selection: TimelineSelection | null) => void
  onMoveRestPoint: (index: number, backgroundX: number) => void
  onMoveStartPoint: (backgroundX: number) => void
  onMoveWaypoint: (transitionIndex: number, waypointIndex: number, backgroundX: number) => void
  onAddWaypoint: (transitionIndex: number, backgroundX: number) => void
  onDeleteRestPoint: (index: number) => void
  onDeleteWaypoint: (transitionIndex: number, waypointIndex: number) => void
  onAddRestPoint: (backgroundX: number) => void
}

const MIN_TIMELINE_HEIGHT = 100
const DEFAULT_TIMELINE_HEIGHT = 200
const MAX_TIMELINE_HEIGHT = 800
const REST_POINT_RADIUS = 12
const WAYPOINT_RADIUS = 7
const START_POINT_SIZE = 14
const MIN_DISTANCE = 20

type DragTarget =
  | { type: 'restPoint'; index: number }
  | { type: 'startPoint' }
  | { type: 'waypoint'; transitionIndex: number; waypointIndex: number }

export default function SceneTimeline({
  backgroundImageUrl,
  backgroundWidth,
  backgroundHeight,
  restPoints,
  transitions,
  startMode,
  startX,
  startTransition,
  selection,
  onSelect,
  onMoveRestPoint,
  onMoveStartPoint,
  onMoveWaypoint,
  onAddWaypoint,
  onDeleteRestPoint,
  onDeleteWaypoint,
  onAddRestPoint,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<DragTarget | null>(null)
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE_HEIGHT)
  const [resizing, setResizing] = useState(false)

  // Compute scale from height, then clamp width to wrapper
  const aspectRatio = backgroundHeight > 0 ? backgroundWidth / backgroundHeight : 1
  const wrapperWidth = wrapperRef.current?.clientWidth ?? Infinity
  const rawWidth = timelineHeight * aspectRatio
  const timelineWidth = Math.min(rawWidth, wrapperWidth)
  // If width-clamped, recompute effective height to keep ratio
  const effectiveHeight = rawWidth > wrapperWidth
    ? wrapperWidth / aspectRatio
    : timelineHeight
  const scale = backgroundHeight > 0 ? effectiveHeight / backgroundHeight : 1

  const toTimelineX = useCallback((bgX: number) => bgX * scale, [scale])
  const toBackgroundX = useCallback((tlX: number) => Math.round(tlX / scale), [scale])

  // Get all X positions for a transition (fromX, waypoints..., toX)
  const getTransitionXPositions = useCallback((transitionIndex: number): number[] => {
    if (transitionIndex === -1) {
      // startTransition
      const fromX = startX ?? 0
      const toX = restPoints[0]?.backgroundX ?? 0
      return [fromX, ...(startTransition?.waypoints ?? []), toX]
    }
    const fromX = restPoints[transitionIndex]?.backgroundX ?? 0
    const toX = restPoints[transitionIndex + 1]?.backgroundX ?? 0
    const transition = transitions[transitionIndex]
    return [fromX, ...(transition?.waypoints ?? []), toX]
  }, [restPoints, transitions, startMode, startX, startTransition])

  // Resize handle drag
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

  // Click on timeline background
  const handleTimelineClick = useCallback((e: React.MouseEvent) => {
    if (dragging) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX - rect.left + (e.currentTarget as HTMLElement).scrollLeft
    const bgX = toBackgroundX(x)

    // Check if clicking on a transition line segment
    // For simplicity, add a rest point at click position
    const tooClose = restPoints.some(rp => Math.abs(toTimelineX(rp.backgroundX) - x) < MIN_DISTANCE)
    if (!tooClose) {
      onAddRestPoint(Math.max(0, Math.min(backgroundWidth, bgX)))
    }
  }, [dragging, restPoints, toBackgroundX, toTimelineX, backgroundWidth, onAddRestPoint])

  // Drag handling
  useEffect(() => {
    if (!dragging) return
    const container = containerRef.current
    if (!container) return

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect()
      const x = e.clientX - rect.left + container.scrollLeft
      const bgX = toBackgroundX(Math.max(0, Math.min(timelineWidth, x)))
      const clampedBgX = Math.max(0, Math.min(backgroundWidth, bgX))

      if (dragging.type === 'restPoint') {
        onMoveRestPoint(dragging.index, clampedBgX)
      } else if (dragging.type === 'startPoint') {
        onMoveStartPoint(clampedBgX)
      } else if (dragging.type === 'waypoint') {
        onMoveWaypoint(dragging.transitionIndex, dragging.waypointIndex, clampedBgX)
      }
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
  }, [dragging, toBackgroundX, timelineWidth, backgroundWidth, onMoveRestPoint, onMoveStartPoint, onMoveWaypoint])

  // Handle click on a transition line to add a waypoint
  const handleLineClick = useCallback((e: React.MouseEvent, transitionIndex: number) => {
    e.stopPropagation()
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left + (containerRef.current?.scrollLeft ?? 0)
    const bgX = toBackgroundX(x)
    onAddWaypoint(transitionIndex, Math.max(0, Math.min(backgroundWidth, bgX)))
  }, [toBackgroundX, backgroundWidth, onAddWaypoint])

  // Render a transition (lines + waypoints)
  const renderTransition = (transitionIndex: number) => {
    const xPositions = getTransitionXPositions(transitionIndex)
    const transition = transitionIndex === -1 ? startTransition : transitions[transitionIndex]
    if (!transition || xPositions.length < 2) return null

    const elements: React.ReactNode[] = []

    // Lines between consecutive X positions (each is a segment)
    for (let i = 0; i < xPositions.length - 1; i++) {
      const x1 = toTimelineX(xPositions[i])
      const x2 = toTimelineX(xPositions[i + 1])
      const isSelected = selection?.type === 'segment'
        && selection.transitionIndex === transitionIndex
        && selection.segmentIndex === i

      elements.push(
        <line
          key={`line-${transitionIndex}-${i}`}
          x1={x1} y1={effectiveHeight / 2}
          x2={x2} y2={effectiveHeight / 2}
          stroke={isSelected ? 'var(--color-primary-hover)' : 'var(--color-primary)'}
          strokeWidth={isSelected ? 4 : 2.5}
          opacity={0.8}
          style={{ cursor: 'pointer' }}
          onClick={(e) => {
            e.stopPropagation()
            onSelect({ type: 'segment', transitionIndex, segmentIndex: i })
          }}
          onDoubleClick={(e) => handleLineClick(e, transitionIndex)}
        />
      )
    }

    // Waypoints
    const waypoints = transition.waypoints
    for (let wi = 0; wi < waypoints.length; wi++) {
      const wx = toTimelineX(waypoints[wi])
      elements.push(
        <g key={`wp-${transitionIndex}-${wi}`}>
          <circle
            cx={wx} cy={effectiveHeight / 2}
            r={WAYPOINT_RADIUS}
            fill="var(--color-primary)"
            stroke="white"
            strokeWidth={1.5}
            style={{ cursor: 'grab' }}
            onMouseDown={(e) => {
              e.stopPropagation()
              setDragging({ type: 'waypoint', transitionIndex, waypointIndex: wi })
            }}
            onClick={(e) => e.stopPropagation()}
          />
          {/* Delete button for waypoint on right-click or via context */}
        </g>
      )
    }

    return elements
  }

  const isRestPointSelected = (index: number) =>
    selection?.type === 'restPoint' && selection.index === index

  const isStartPointSelected = selection?.type === 'startPoint'

  return (
    <div className="scene-timeline-wrapper" ref={wrapperRef}>
      <div
        ref={containerRef}
        className="scene-timeline"
        style={{ width: timelineWidth, height: effectiveHeight }}
        onClick={handleTimelineClick}
      >
        {backgroundImageUrl && (
          <img
            src={backgroundImageUrl}
            alt="Scene background"
            className="scene-timeline-bg"
            style={{ width: timelineWidth, height: effectiveHeight }}
            draggable={false}
          />
        )}

        <svg className="scene-timeline-lines" style={{ width: timelineWidth, height: effectiveHeight }}>
          {/* Start transition (if startMode='transition') */}
          {startMode === 'transition' && startTransition && restPoints.length > 0 && (
            renderTransition(-1)
          )}

          {/* Transitions between rest points */}
          {transitions.map((_, i) => (
            <g key={`transition-${i}`}>{renderTransition(i)}</g>
          ))}
        </svg>

        {/* Start point (triangle) */}
        {startMode === 'transition' && startX != null && (
          <div
            className={`scene-timeline-start ${isStartPointSelected ? 'scene-timeline-start--selected' : ''}`}
            style={{ left: toTimelineX(startX) - START_POINT_SIZE / 2 }}
            onMouseDown={(e) => {
              e.stopPropagation()
              setDragging({ type: 'startPoint' })
              onSelect({ type: 'startPoint' })
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <svg viewBox="0 0 24 24" width={START_POINT_SIZE} height={START_POINT_SIZE}>
              <polygon points="4,2 20,12 4,22" fill="var(--color-type-physics)" stroke="white" strokeWidth="1.5" />
            </svg>
          </div>
        )}

        {/* Rest point markers */}
        {restPoints.map((rp, index) => {
          const x = toTimelineX(rp.backgroundX)
          const selected = isRestPointSelected(index)
          return (
            <div
              key={rp.id}
              className={`scene-timeline-restpoint ${selected ? 'scene-timeline-restpoint--selected' : ''}`}
              style={{ left: x - REST_POINT_RADIUS }}
              onMouseDown={(e) => {
                e.stopPropagation()
                setDragging({ type: 'restPoint', index })
                onSelect({ type: 'restPoint', index })
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (restPoints.length > 1) {
                  onDeleteRestPoint(index)
                }
              }}
            >
              <div className="scene-timeline-restpoint-circle">
                {index + 1}
              </div>
              {selected && restPoints.length > 1 && (
                <button
                  className="scene-timeline-restpoint-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDeleteRestPoint(index)
                  }}
                  title="Supprimer"
                >
                  ×
                </button>
              )}
            </div>
          )
        })}

        {restPoints.length === 0 && backgroundImageUrl && (
          <div className="scene-timeline-hint">
            Cliquez sur le panorama pour ajouter des rest points
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        className="scene-timeline-resize-handle"
        onMouseDown={(e) => {
          e.preventDefault()
          setResizing(true)
        }}
      />
    </div>
  )
}
