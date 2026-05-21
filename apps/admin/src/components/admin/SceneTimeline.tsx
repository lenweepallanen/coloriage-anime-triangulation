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

const REST_POINT_RADIUS = 12
const ENTRY_POINT_SIZE = 14
// Hauteur en vh — proportions plus généreuses pour bien voir la scène
const TIMELINE_HEIGHT_VH = 45

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
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<'restPoint' | 'entryStart' | null>(null)
  const [wrapperWidth, setWrapperWidth] = useState(0)

  useEffect(() => {
    const update = () => setWrapperWidth(wrapperRef.current?.clientWidth ?? 0)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Ratio du preview modal (70vw × 75vh) — recalculé au resize de la fenêtre.
  const [previewAspect, setPreviewAspect] = useState(() => {
    if (typeof window === 'undefined') return 16 / 9
    return (window.innerWidth * 0.7) / (window.innerHeight * 0.75)
  })
  useEffect(() => {
    const handle = () => setPreviewAspect((window.innerWidth * 0.7) / (window.innerHeight * 0.75))
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [])

  // Le centre représente le viewport visible à l'écran (ratio = previewAspect).
  // Total timeline = 2 × viewport width → 50% hachuré à gauche + 50% hachuré à droite.
  // Hauteur = en vh pour donner de l'air. La largeur centre découle de previewAspect.
  const viewportHeightPx = Math.round((window.innerHeight * TIMELINE_HEIGHT_VH) / 100)
  const viewportWidthPx = Math.round(viewportHeightPx * previewAspect)
  const totalWidth = viewportWidthPx * 2
  const centerLeftPx = viewportWidthPx / 2  // début du viewport dans la timeline
  const centerRightPx = centerLeftPx + viewportWidthPx

  // Conversion bg coords ↔ écran. Le viewport représente `viewportBgWidth` en bg coords,
  // centré sur restPointX (clampé pour ne pas sortir du décor).
  const viewportBgWidth = backgroundHeight * previewAspect
  const viewportLeftBg = Math.max(0, Math.min(backgroundWidth - viewportBgWidth, restPointX - viewportBgWidth / 2))
  const screenPerBg = viewportWidthPx / viewportBgWidth

  const bgToScreen = useCallback((bgX: number) => {
    return centerLeftPx + (bgX - viewportLeftBg) * screenPerBg
  }, [centerLeftPx, viewportLeftBg, screenPerBg])

  const screenToBg = useCallback((screenX: number) => {
    return viewportLeftBg + (screenX - centerLeftPx) / screenPerBg
  }, [centerLeftPx, viewportLeftBg, screenPerBg])

  // Position du rest point sur le viewport central : restPointX en bg coords mappé sur l'écran.
  // Quand le viewport est clampé (restPointX près d'un bord), restPoint ≠ centre exact.
  const restXScreen = bgToScreen(restPointX)
  const entryXScreen = entryStartX != null ? bgToScreen(entryStartX) : null

  // Bornes drag (en bg coords) : 50% hors écran de chaque côté = ±viewport_bg
  // Donc entryStartX ∈ [restPointX - 1.5×vw_bg/2, restPointX + 1.5×vw_bg/2] approx,
  // ou plus simplement : drag clampé au screen [0, totalWidth] puis converti.
  const handleDrag = useCallback((e: MouseEvent) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const screenX = Math.max(0, Math.min(totalWidth, e.clientX - rect.left))
    const bgX = screenToBg(screenX)
    if (dragging === 'restPoint') {
      onMoveRestPoint(Math.max(0, Math.min(backgroundWidth, bgX)))
    } else if (dragging === 'entryStart') {
      onMoveEntryStart(bgX)
    }
  }, [dragging, totalWidth, screenToBg, onMoveRestPoint, onMoveEntryStart, backgroundWidth])

  useEffect(() => {
    if (!dragging) return
    const onUp = () => {
      setDragging(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', handleDrag)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', handleDrag)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, handleDrag])

  // Personnage : on calque exactement la logique du player final (ScenePlayer.tsx).
  // Final : charFitScale = viewH/scanCanvas.height, charH = scanCanvas.height*charFitScale*charScale = viewH*charScale
  //         charW = scanCanvas.width*charFitScale*charScale = viewH*charScale*(width/height)
  //         charCenterY = viewH/2 + characterY * (viewH/backgroundHeight)
  const charPx = characterImageWidth && characterImageHeight && characterImageWidth > 0
    ? {
        h: viewportHeightPx * charScale,
        w: viewportHeightPx * charScale * (characterImageWidth / characterImageHeight),
        y: viewportHeightPx / 2 + (charY * viewportHeightPx / Math.max(1, backgroundHeight)),
      }
    : null

  // Position de la frame du bg dans le viewport central : on shift l'image pour que la
  // partie centrée sur viewportLeftBg apparaisse au début du viewport.
  // bg image natural ratio: backgroundWidth × backgroundHeight, scaled so height = viewportHeightPx.
  const bgImageHeightPx = viewportHeightPx
  const bgImageWidthPx = (backgroundWidth / backgroundHeight) * bgImageHeightPx
  const bgImageLeftInViewportPx = -viewportLeftBg * screenPerBg  // négatif si on est plus à droite

  const hatchBg = 'repeating-linear-gradient(45deg, rgba(120,120,120,0.20) 0 8px, rgba(80,80,80,0.30) 8px 16px)'

  // Width du wrapper : si totalWidth > wrapperWidth, scroll horizontal. Sinon centre.
  const useScroll = wrapperWidth > 0 && totalWidth > wrapperWidth

  return (
    <div
      ref={wrapperRef}
      className="scene-timeline-wrapper"
      style={{
        position: 'relative',
        overflowX: useScroll ? 'auto' : 'visible',
        overflowY: 'visible',
        padding: '8px 0',
      }}
    >
      <div
        ref={containerRef}
        className="scene-timeline"
        style={{
          width: totalWidth,
          height: viewportHeightPx,
          position: 'relative',
          margin: useScroll ? '0' : '0 auto',
          border: '1px solid var(--color-border, #444)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          background: '#222',
        }}
      >
        {/* Hachures gauche/droite (hors champ) */}
        <div style={{
          position: 'absolute', left: 0, top: 0, width: centerLeftPx, height: '100%',
          background: hatchBg, pointerEvents: 'none',
        }}>
          <span style={{ position: 'absolute', left: 8, top: 8, fontSize: 11, color: 'rgba(255,255,255,0.7)', textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>↙ Hors champ</span>
        </div>
        <div style={{
          position: 'absolute', left: centerRightPx, top: 0, width: centerLeftPx, height: '100%',
          background: hatchBg, pointerEvents: 'none',
        }}>
          <span style={{ position: 'absolute', right: 8, top: 8, fontSize: 11, color: 'rgba(255,255,255,0.7)', textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>Hors champ ↘</span>
        </div>

        {/* Viewport central : frame 0 du bg, shiftée selon restPointX */}
        <div style={{
          position: 'absolute',
          left: centerLeftPx,
          top: 0,
          width: viewportWidthPx,
          height: viewportHeightPx,
          overflow: 'hidden',
          border: '2px solid rgba(66,165,245,0.65)',
          boxSizing: 'border-box',
          background: '#111',
        }}>
          {backgroundImageUrl && (
            <img
              src={backgroundImageUrl}
              alt=""
              draggable={false}
              style={{
                position: 'absolute',
                left: bgImageLeftInViewportPx,
                top: 0,
                width: bgImageWidthPx,
                height: bgImageHeightPx,
                userSelect: 'none',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Arrow entry → rest */}
        {entry === 'moving' && entryXScreen != null && (
          <svg
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          >
            <line
              x1={entryXScreen} y1={viewportHeightPx / 2}
              x2={restXScreen} y2={viewportHeightPx / 2}
              stroke="rgba(255,255,255,0.55)"
              strokeWidth={2}
              strokeDasharray="6 4"
              markerEnd="url(#tl-arrow)"
            />
            <defs>
              <marker id="tl-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.75)" />
              </marker>
            </defs>
          </svg>
        )}

        {/* Character preview at rest point */}
        {characterImageUrl && charPx && (
          <img
            src={characterImageUrl}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              left: restXScreen - charPx.w / 2,
              top: charPx.y - charPx.h / 2,
              width: charPx.w, height: charPx.h,
              pointerEvents: 'none',
              opacity: 0.9,
              filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.5))',
            }}
          />
        )}

        {/* Entry handle (orange diamond) */}
        {entry === 'moving' && entryXScreen != null && (
          <div
            onMouseDown={(e) => { e.stopPropagation(); setDragging('entryStart'); onSelect({ type: 'entryStart' }) }}
            style={{
              position: 'absolute',
              left: entryXScreen - ENTRY_POINT_SIZE / 2,
              top: viewportHeightPx / 2 - ENTRY_POINT_SIZE / 2,
              width: ENTRY_POINT_SIZE, height: ENTRY_POINT_SIZE,
              background: selection?.type === 'entryStart' ? '#ffa726' : 'rgba(255,167,38,0.6)',
              border: '2px solid #fff',
              cursor: 'grab',
              transform: 'rotate(45deg)',
              boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
            }}
            title="Position de départ (drag pour déplacer, peut sortir du viewport)"
          />
        )}

        {/* Rest point handle (blue circle) */}
        <div
          onMouseDown={(e) => { e.stopPropagation(); setDragging('restPoint'); onSelect({ type: 'restPoint' }) }}
          style={{
            position: 'absolute',
            left: restXScreen - REST_POINT_RADIUS,
            top: viewportHeightPx / 2 - REST_POINT_RADIUS,
            width: REST_POINT_RADIUS * 2,
            height: REST_POINT_RADIUS * 2,
            borderRadius: '50%',
            background: selection?.type === 'restPoint' ? '#42a5f5' : 'rgba(66,165,245,0.6)',
            border: '2px solid #fff',
            cursor: 'grab',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
          }}
          title="Rest point (drag pour pan camera dans le décor)"
        />
      </div>
    </div>
  )
}
