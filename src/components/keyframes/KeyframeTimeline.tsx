import type { KeyframeData } from '../../types/project'

interface Props {
  keyframes: KeyframeData[]
  totalFrames: number
  selectedIndex: number | null
  onSelect: (index: number) => void
}

export default function KeyframeTimeline({ keyframes, totalFrames, selectedIndex, onSelect }: Props) {
  if (keyframes.length === 0 || totalFrames === 0) return null

  return (
    <div className="keyframe-timeline">
      <div className="timeline-bar">
        {keyframes.map((kf, i) => {
          const left = (kf.frameIndex / (totalFrames - 1)) * 100
          const isSelected = selectedIndex === i
          return (
            <button
              key={i}
              className={`timeline-marker ${isSelected ? 'selected' : ''}`}
              style={{ left: `${left}%` }}
              onClick={() => onSelect(i)}
              title={`Frame ${kf.frameIndex}`}
            >
              <span className="marker-dot" />
              <span className="marker-label">{kf.frameIndex}</span>
            </button>
          )
        })}
      </div>
      <div className="timeline-labels">
        <span>0</span>
        <span>{totalFrames - 1}</span>
      </div>
    </div>
  )
}
