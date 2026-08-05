import { useCallback, useEffect, useRef, useState } from 'react'
import type { Animation, FilmPlanTimeline, FilmSound } from '../../../../types/project'
import { exclusiveTrackBounds } from '../../../../utils/filmTimeline'
import { FILM_COLORS, formatMs } from '../filmEditorShared'

/**
 * Timeline d'un plan de film : règle + piste Déplacement + piste Animation +
 * N pistes Sons + playhead scrubbable. Clips draggables (corps = déplacer,
 * poignées = redimensionner). Les pistes motion/anim sont EXCLUSIVES
 * (clamp contre les voisins), les pistes sons libres.
 */

export type TimelineSelection =
  | { kind: 'motion' | 'anim'; id: string }
  | { kind: 'sound'; id: string; trackIndex: number }
  | null

export interface TimelineEditorProps {
  timeline: FilmPlanTimeline
  animations: Animation[]
  sounds: FilmSound[]
  selection: TimelineSelection
  onSelect: (sel: TimelineSelection) => void
  /** Mutation d'un clip (drag/resize). `commit` = fin de geste (pointerup). */
  onPatchClip: (sel: NonNullable<TimelineSelection>, partial: { startMs?: number; durationMs?: number }) => void
  onRemoveClip: (sel: NonNullable<TimelineSelection>) => void
  /** Double-clic sur une piste son : poser un clip à cet instant. */
  onAddSoundAt: (trackIndex: number, atMs: number) => void
  onAddSoundTrack: () => void
  playheadMs: number
  onScrub: (ms: number) => void
  /** Lecture éditeur (Espace) : géré par le parent ; ici juste l'affichage. */
  playing?: boolean
}

const TRACK_H = 34
const RULER_H = 22
const LABEL_W = 92

export default function TimelineEditor({
  timeline, animations, sounds, selection, onSelect, onPatchClip, onRemoveClip,
  onAddSoundAt, onAddSoundTrack, playheadMs, onScrub, playing,
}: TimelineEditorProps) {
  const [pxPerSec, setPxPerSec] = useState(60)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const msToPx = useCallback((ms: number) => (ms / 1000) * pxPerSec, [pxPerSec])
  const pxToMs = useCallback((px: number) => (px / pxPerSec) * 1000, [pxPerSec])

  const contentMs = Math.max(
    timeline.durationMs,
    ...timeline.motion.map(c => c.startMs + c.durationMs),
    ...timeline.anim.map(c => c.startMs + c.durationMs),
    ...timeline.soundTracks.flatMap(tr => tr.map(c => c.startMs + c.durationMs)),
    4000,
  )
  const contentW = msToPx(contentMs) + 160

  // Zoom à la molette (Ctrl/Cmd ou molette simple sur la règle), centré curseur.
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cursorPx = e.clientX - rect.left + el.scrollLeft - LABEL_W
    const cursorMs = pxToMs(cursorPx)
    const next = Math.min(400, Math.max(12, pxPerSec * (e.deltaY < 0 ? 1.25 : 0.8)))
    setPxPerSec(next)
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollLeft = (cursorMs / 1000) * next - (e.clientX - rect.left - LABEL_W)
      }
    })
  }, [pxPerSec, pxToMs])

  // wheel non-passif (preventDefault pour le zoom).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const fn = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [])

  // --- Drag clip / poignées / playhead ---
  const dragRef = useRef<
    | { mode: 'move' | 'resize-l' | 'resize-r'; sel: NonNullable<TimelineSelection>; grabPx: number; origStart: number; origDur: number; snapTargets: number[] }
    | { mode: 'scrub' }
    | null
  >(null)

  /** Bords de tous les clips (toutes pistes) sauf celui-ci + secondes + playhead. */
  const collectSnapTargets = (excludeId: string): number[] => {
    const out: number[] = [0, playheadMs, timeline.durationMs]
    const eat = (clips: { id: string; startMs: number; durationMs: number }[]) => {
      for (const c of clips) {
        if (c.id === excludeId) continue
        out.push(c.startMs, c.startMs + c.durationMs)
      }
    }
    eat(timeline.motion)
    eat(timeline.anim)
    for (const tr of timeline.soundTracks) eat(tr)
    const stepSec = pxPerSec >= 90 ? 1 : pxPerSec >= 35 ? 2 : 5
    for (let t = 0; t <= contentMs; t += stepSec * 1000) out.push(t)
    return out
  }

  /** Snap une valeur ms sur la cible la plus proche (seuil 6 px écran). Alt désactive. */
  const snapMs = (ms: number, targets: number[], disabled: boolean): number => {
    if (disabled) return ms
    const thresholdMs = pxToMs(6)
    let best = ms
    let bestDist = thresholdMs
    for (const t of targets) {
      const d = Math.abs(t - ms)
      if (d < bestDist) { bestDist = d; best = t }
    }
    return best
  }

  const clipsOf = (sel: NonNullable<TimelineSelection>) =>
    sel.kind === 'motion' ? timeline.motion
      : sel.kind === 'anim' ? timeline.anim
        : timeline.soundTracks[sel.trackIndex] ?? []

  const localX = (e: { clientX: number }): number => {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return e.clientX - rect.left + el.scrollLeft - LABEL_W
  }

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    const x = localX(e)
    if (drag.mode === 'scrub') {
      onScrub(Math.max(0, Math.min(contentMs, pxToMs(x))))
      return
    }
    const deltaMs = pxToMs(x - drag.grabPx)
    const sel = drag.sel
    const exclusive = sel.kind !== 'sound'
    const clips = clipsOf(sel)
    const bounds = exclusive
      ? exclusiveTrackBounds(clips, sel.id)
      : { minStartMs: 0, maxEndMs: Number.POSITIVE_INFINITY }
    const noSnap = e.altKey
    if (drag.mode === 'move') {
      let start = Math.round(drag.origStart + deltaMs)
      // Snap sur le bord le plus attiré (début OU fin du clip déplacé).
      const snappedStart = snapMs(start, drag.snapTargets, noSnap)
      const snappedEnd = snapMs(start + drag.origDur, drag.snapTargets, noSnap) - drag.origDur
      start = Math.abs(snappedStart - start) <= Math.abs(snappedEnd - start) ? snappedStart : snappedEnd
      start = Math.max(bounds.minStartMs, Math.min(bounds.maxEndMs - drag.origDur, start))
      start = Math.max(0, start)
      onPatchClip(sel, { startMs: Math.round(start) })
    } else if (drag.mode === 'resize-l') {
      let start = snapMs(Math.round(drag.origStart + deltaMs), drag.snapTargets, noSnap)
      start = Math.max(bounds.minStartMs, Math.min(drag.origStart + drag.origDur - 100, start))
      start = Math.max(0, start)
      onPatchClip(sel, { startMs: Math.round(start), durationMs: Math.round(drag.origStart + drag.origDur - start) })
    } else {
      const end = snapMs(Math.round(drag.origStart + drag.origDur + deltaMs), drag.snapTargets, noSnap)
      let dur = end - drag.origStart
      dur = Math.max(100, Math.min(bounds.maxEndMs - drag.origStart, dur))
      onPatchClip(sel, { durationMs: Math.round(dur) })
    }
  }, [contentMs, onPatchClip, onScrub, pxToMs, timeline]) // eslint-disable-line react-hooks/exhaustive-deps

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null
      try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* */ }
    }
  }, [])

  const startClipDrag = (e: React.PointerEvent, sel: NonNullable<TimelineSelection>, mode: 'move' | 'resize-l' | 'resize-r') => {
    e.stopPropagation()
    if (e.button === 2) {
      onRemoveClip(sel)
      return
    }
    if (e.button !== 0) return
    onSelect(sel)
    const clip = clipsOf(sel).find(c => c.id === sel.id)
    if (!clip) return
    dragRef.current = { mode, sel, grabPx: localX(e), origStart: clip.startMs, origDur: clip.durationMs, snapTargets: collectSnapTargets(sel.id) }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  // --- Rendu d'un clip ---
  const renderClip = (
    sel: NonNullable<TimelineSelection>,
    clip: { id: string; startMs: number; durationMs: number },
    color: string,
    label: string,
    extra?: string,
  ) => {
    const isSel = selection != null && selection.kind === sel.kind && selection.id === sel.id
    return (
      <div
        key={clip.id}
        onPointerDown={(e) => startClipDrag(e, sel, 'move')}
        onContextMenu={(e) => e.preventDefault()}
        title={`${label}${extra ? ` · ${extra}` : ''} — ${formatMs(clip.startMs)} → ${formatMs(clip.startMs + clip.durationMs)} (clic droit : supprimer)`}
        style={{
          position: 'absolute',
          left: msToPx(clip.startMs),
          width: Math.max(6, msToPx(clip.durationMs)),
          top: 3,
          height: TRACK_H - 6,
          background: color,
          opacity: isSel ? 1 : 0.8,
          border: isSel ? '2px solid #fff' : '1px solid rgba(0,0,0,0.4)',
          borderRadius: 4,
          color: '#fff',
          fontSize: 10,
          lineHeight: `${TRACK_H - 8}px`,
          padding: '0 6px',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          cursor: 'grab',
          userSelect: 'none',
          boxSizing: 'border-box',
        }}
      >
        {label}
        {/* Poignées de resize */}
        <div
          onPointerDown={(e) => startClipDrag(e, sel, 'resize-l')}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }}
        />
        <div
          onPointerDown={(e) => startClipDrag(e, sel, 'resize-r')}
          style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }}
        />
      </div>
    )
  }

  const animName = (id: string) => animations.find(a => a.id === id)?.name ?? id.slice(0, 6)
  const soundName = (id: string) => sounds.find(x => x.id === id)?.name ?? id.slice(0, 6)

  // Graduations : pas adapté au zoom (1 s / 2 s / 5 s).
  const stepSec = pxPerSec >= 90 ? 1 : pxPerSec >= 35 ? 2 : 5
  const ticks: number[] = []
  for (let t = 0; t <= contentMs / 1000 + stepSec; t += stepSec) ticks.push(t)

  const trackRow = (label: string, children: React.ReactNode, onDblClick?: (atMs: number) => void) => (
    <div style={{ display: 'flex', borderTop: '1px solid #2c2c2c' }}>
      <div style={{
        width: LABEL_W, minWidth: LABEL_W, fontSize: 10, opacity: 0.75, padding: '0 6px',
        lineHeight: `${TRACK_H}px`, background: '#1c1c1c', position: 'sticky', left: 0, zIndex: 3,
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      }}>{label}</div>
      <div
        style={{ position: 'relative', height: TRACK_H, width: contentW, flexShrink: 0 }}
        onDoubleClick={onDblClick ? (e) => onDblClick(Math.max(0, pxToMs(localX(e)))) : undefined}
      >
        {children}
      </div>
    </div>
  )

  return (
    <div
      ref={scrollRef}
      onWheel={handleWheel}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        overflowX: 'auto', overflowY: 'hidden', background: '#181818',
        border: '1px solid #333', borderRadius: 6, position: 'relative', userSelect: 'none',
      }}
    >
      <div style={{ width: LABEL_W + contentW, position: 'relative' }}>
        {/* Règle */}
        <div style={{ display: 'flex' }}>
          <div style={{
            width: LABEL_W, minWidth: LABEL_W, height: RULER_H, background: '#1c1c1c',
            position: 'sticky', left: 0, zIndex: 3, fontSize: 9, opacity: 0.6,
            lineHeight: `${RULER_H}px`, padding: '0 6px',
          }}>
            {playing ? '▶' : '⏸'} {formatMs(playheadMs)}
          </div>
          <div
            style={{ position: 'relative', height: RULER_H, width: contentW, flexShrink: 0, cursor: 'col-resize' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              dragRef.current = { mode: 'scrub' }
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              onScrub(Math.max(0, Math.min(contentMs, pxToMs(localX(e)))))
            }}
          >
            {ticks.map(t => (
              <div key={t} style={{ position: 'absolute', left: msToPx(t * 1000), top: 0, bottom: 0, borderLeft: '1px solid #3a3a3a', fontSize: 9, color: '#888', paddingLeft: 3, lineHeight: `${RULER_H}px` }}>
                {t}s
              </div>
            ))}
            {/* Fin du plan */}
            <div style={{ position: 'absolute', left: msToPx(timeline.durationMs), top: 0, bottom: 0, borderLeft: '2px solid #ef5350' }} title={`Fin du plan (${formatMs(timeline.durationMs)})`} />
          </div>
        </div>

        {/* Pistes */}
        {trackRow('Déplacement', timeline.motion.map(c => renderClip(
          { kind: 'motion', id: c.id }, c, FILM_COLORS.travel,
          c.kind === 'appear' ? '✨ apparition' : c.kind === 'exit' ? 'sortie' : 'trajet',
        )))}
        {trackRow('Animation', timeline.anim.map(c => renderClip(
          { kind: 'anim', id: c.id }, c, FILM_COLORS.action,
          animName(c.animationId), c.fillMode === 'loop' ? '🔁' : '1×',
        )))}
        {timeline.soundTracks.map((track, ti) => trackRow(
          `Son ${ti + 1}`,
          track.map(c => renderClip(
            { kind: 'sound', id: c.id, trackIndex: ti }, c, c.isSpoken ? '#26a69a' : FILM_COLORS.departure,
            `${c.isSpoken ? '🗣 ' : '🔊 '}${soundName(c.soundId)}${c.loop ? ' 🔁' : ''}${c.anchor ? ' ⚓' : ''}`,
          )),
          (atMs) => onAddSoundAt(ti, Math.round(atMs)),
        ))}
        <div style={{ display: 'flex', borderTop: '1px solid #2c2c2c' }}>
          <button
            className="btn-ghost btn-sm"
            style={{ margin: 4, fontSize: 11, position: 'sticky', left: 4 }}
            onClick={onAddSoundTrack}
          >+ piste son</button>
        </div>

        {/* Playhead */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: LABEL_W + msToPx(playheadMs),
          width: 2, background: '#ffeb3b', zIndex: 4, pointerEvents: 'none',
        }} />
      </div>
    </div>
  )
}
