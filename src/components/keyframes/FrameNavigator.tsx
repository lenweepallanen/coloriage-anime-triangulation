import { useCallback, useEffect, useMemo } from 'react'

interface Props {
  currentFrame: number
  totalFrames: number
  editedFrames: Set<number>
  onNavigate: (frame: number) => void
  /** When true, navigation jumps between keyframeIndices only */
  keyframeOnly?: boolean
  /** List of keyframe frame indices (required when keyframeOnly=true) */
  keyframeIndices?: number[]
}

export default function FrameNavigator({ currentFrame, totalFrames, editedFrames, onNavigate, keyframeOnly, keyframeIndices }: Props) {
  const lastFrame = totalFrames - 1

  // Sorted keyframe indices for keyframe-only navigation
  const sortedKF = useMemo(() => {
    if (!keyframeOnly || !keyframeIndices) return null
    return [...keyframeIndices].sort((a, b) => a - b)
  }, [keyframeOnly, keyframeIndices])

  // Current keyframe index within sortedKF
  const currentKFIdx = useMemo(() => {
    if (!sortedKF) return -1
    return sortedKF.indexOf(currentFrame)
  }, [sortedKF, currentFrame])

  const go = useCallback((delta: number) => {
    if (sortedKF) {
      // Keyframe-only: jump between keyframes
      const newIdx = Math.max(0, Math.min(sortedKF.length - 1, currentKFIdx + delta))
      onNavigate(sortedKF[newIdx])
    } else {
      onNavigate(Math.max(0, Math.min(lastFrame, currentFrame + delta)))
    }
  }, [currentFrame, lastFrame, onNavigate, sortedKF, currentKFIdx])

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (sortedKF) {
        // Keyframe-only: arrows jump between keyframes, shift skips 3
        if (e.key === 'ArrowLeft' && e.shiftKey) { go(-3); e.preventDefault() }
        else if (e.key === 'ArrowLeft') { go(-1); e.preventDefault() }
        else if (e.key === 'ArrowRight' && e.shiftKey) { go(3); e.preventDefault() }
        else if (e.key === 'ArrowRight') { go(1); e.preventDefault() }
      } else {
        if (e.key === 'ArrowLeft' && e.shiftKey) { go(-5); e.preventDefault() }
        else if (e.key === 'ArrowLeft') { go(-1); e.preventDefault() }
        else if (e.key === 'ArrowRight' && e.shiftKey) { go(5); e.preventDefault() }
        else if (e.key === 'ArrowRight') { go(1); e.preventDefault() }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [go, sortedKF])

  if (totalFrames === 0) return null

  // Build edited frame markers for the slider track
  const markers = Array.from(editedFrames).sort((a, b) => a - b)

  // Keyframe-only mode
  if (sortedKF && sortedKF.length > 0) {
    return (
      <div className="frame-navigator">
        <div className="frame-nav-buttons">
          <button onClick={() => go(-1)} disabled={currentKFIdx <= 0} title="Keyframe précédente (←)">
            &#x2190;
          </button>
          <span className="frame-nav-display">
            <span className="frame-nav-current">KF {currentKFIdx + 1}</span>
            <span className="frame-nav-separator"> / </span>
            <span className="frame-nav-total">{sortedKF.length}</span>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-muted)', marginLeft: 4 }}>
              (frame {currentFrame})
            </span>
            {editedFrames.has(currentFrame) && (
              <span className="frame-nav-edited-badge" title="Keyframe éditée">&#9679;</span>
            )}
          </span>
          <button onClick={() => go(1)} disabled={currentKFIdx >= sortedKF.length - 1} title="Keyframe suivante (→)">
            &#x2192;
          </button>
          <span className="frame-nav-hint">
            {editedFrames.size} / {sortedKF.length} keyframe{editedFrames.size !== 1 ? 's' : ''} éditée{editedFrames.size !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="frame-nav-slider-wrap">
          <input
            type="range"
            className="frame-nav-slider"
            min={0}
            max={sortedKF.length - 1}
            value={currentKFIdx >= 0 ? currentKFIdx : 0}
            onChange={e => onNavigate(sortedKF[Number(e.target.value)])}
          />
          <div className="frame-nav-markers">
            {sortedKF.map((f, idx) => (
              <button
                key={f}
                className={`frame-nav-marker ${f === currentFrame ? 'active' : ''} ${editedFrames.has(f) ? 'edited' : ''}`}
                style={{ left: `${(idx / (sortedKF.length - 1)) * 100}%` }}
                onClick={() => onNavigate(f)}
                title={`Keyframe ${idx + 1} (frame ${f})`}
              />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Standard frame-by-frame mode
  return (
    <div className="frame-navigator">
      <div className="frame-nav-buttons">
        <button onClick={() => go(-5)} disabled={currentFrame < 1} title="-5 frames (Shift+←)">
          &#x21E4;
        </button>
        <button onClick={() => go(-1)} disabled={currentFrame < 1} title="-1 frame (←)">
          &#x2190;
        </button>
        <span className="frame-nav-display">
          <span className="frame-nav-current">{currentFrame}</span>
          <span className="frame-nav-separator"> / </span>
          <span className="frame-nav-total">{lastFrame}</span>
          {editedFrames.has(currentFrame) && (
            <span className="frame-nav-edited-badge" title="Frame éditée">&#9679;</span>
          )}
        </span>
        <button onClick={() => go(1)} disabled={currentFrame >= lastFrame} title="+1 frame (→)">
          &#x2192;
        </button>
        <button onClick={() => go(5)} disabled={currentFrame >= lastFrame} title="+5 frames (Shift+→)">
          &#x21E5;
        </button>
        <span className="frame-nav-hint">
          {editedFrames.size} frame{editedFrames.size !== 1 ? 's' : ''} éditée{editedFrames.size !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="frame-nav-slider-wrap">
        <input
          type="range"
          className="frame-nav-slider"
          min={0}
          max={lastFrame}
          value={currentFrame}
          onChange={e => onNavigate(Number(e.target.value))}
        />
        <div className="frame-nav-markers">
          {markers.map(f => (
            <button
              key={f}
              className={`frame-nav-marker ${f === currentFrame ? 'active' : ''}`}
              style={{ left: `${(f / lastFrame) * 100}%` }}
              onClick={() => onNavigate(f)}
              title={`Frame ${f} (éditée)`}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
