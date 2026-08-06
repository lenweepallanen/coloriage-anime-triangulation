import { useCallback, useEffect, useRef, useState } from 'react'
import { getSharedAudioContext } from '../../../../utils/mouthAudioAnalyser'
import type { Animation, FilmPlanTimeline, FilmSound } from '../../../../types/project'
import { exclusiveTrackBounds, FILM_FPS } from '../../../../utils/filmTimeline'
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
  /** ⧉ : duplique le clip (anim/son), copie posée juste après l'original. */
  onDuplicateClip: (sel: NonNullable<TimelineSelection>) => void
  /** Double-clic sur une piste son : poser un clip à cet instant. */
  onAddSoundAt: (trackIndex: number, atMs: number) => void
  onAddSoundTrack: () => void
  /** Drag du marqueur rouge « Fin du plan » (durée du plan). */
  onSetPlanDuration: (ms: number) => void
  playheadMs: number
  onScrub: (ms: number) => void
  /** Lecture éditeur (Espace) : géré par le parent ; ici juste l'affichage. */
  playing?: boolean
}

const TRACK_H = 34
/** Pistes SONS plus hautes : la forme d'onde y est dessinée (aide au montage). */
const SOUND_TRACK_H = 52
const RULER_H = 22
const LABEL_W = 92

// --- Crêtes audio (cache par soundId, décodage via le ctx partagé) ---
const peaksCache = new Map<string, Promise<{ peaks: Float32Array; durationMs: number } | null>>()
function getPeaks(soundId: string, blob: Blob): Promise<{ peaks: Float32Array; durationMs: number } | null> {
  let entry = peaksCache.get(soundId)
  if (!entry) {
    entry = (async () => {
      try {
        const ctx = getSharedAudioContext()
        const buf: AudioBuffer = await new Promise((resolve, reject) => {
          blob.arrayBuffer().then(ab => {
            try {
              const ret = ctx.decodeAudioData(ab, b => resolve(b), e => reject(e))
              if (ret && typeof (ret as Promise<AudioBuffer>).then === 'function') (ret as Promise<AudioBuffer>).then(resolve, reject)
            } catch (e) { reject(e) }
          }, reject)
        })
        const data = buf.getChannelData(0)
        const buckets = 240
        const peaks = new Float32Array(buckets)
        const step = Math.max(1, Math.floor(data.length / buckets))
        let maxAll = 0
        for (let b = 0; b < buckets; b++) {
          let m = 0
          const start = b * step
          for (let i = start; i < Math.min(start + step, data.length); i += 4) {
            const v = Math.abs(data[i])
            if (v > m) m = v
          }
          peaks[b] = m
          if (m > maxAll) maxAll = m
        }
        if (maxAll > 0) for (let b = 0; b < buckets; b++) peaks[b] /= maxAll
        return { peaks, durationMs: buf.duration * 1000 }
      } catch {
        return null
      }
    })()
    peaksCache.set(soundId, entry)
  }
  return entry
}

/** Forme d'onde dessinée DANS un clip son (tuiles répétées si boucle, vitesse ×rate). */
function Waveform({ soundId, blob, clipMs, rate, loop, widthPx, heightPx }: {
  soundId: string
  blob: Blob | null
  clipMs: number
  rate: number
  loop: boolean
  widthPx: number
  heightPx: number
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (!blob) return
    let dead = false
    void getPeaks(soundId, blob).then(res => {
      const canvas = ref.current
      if (dead || !res || !canvas) return
      const w = Math.max(2, Math.round(widthPx))
      const h = Math.max(2, Math.round(heightPx))
      canvas.width = w
      canvas.height = h
      const ctx2d = canvas.getContext('2d')
      if (!ctx2d) return
      ctx2d.clearRect(0, 0, w, h)
      ctx2d.fillStyle = 'rgba(255,255,255,0.5)'
      const tileMs = res.durationMs / Math.max(0.01, rate)
      const tilePx = (tileMs / Math.max(1, clipMs)) * w
      const tiles = loop ? Math.ceil(w / Math.max(1, tilePx)) : 1
      const mid = h / 2
      for (let t = 0; t < tiles; t++) {
        const x0 = t * tilePx
        for (let x = 0; x < Math.min(tilePx, w - x0); x += 2) {
          const bucket = Math.min(res.peaks.length - 1, Math.floor((x / tilePx) * res.peaks.length))
          const amp = Math.max(0.06, res.peaks[bucket]) * (mid - 2)
          ctx2d.fillRect(x0 + x, mid - amp, 1.4, amp * 2)
        }
      }
    })
    return () => { dead = true }
  }, [soundId, blob, clipMs, rate, loop, widthPx, heightPx])
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.9 }} />
}

export default function TimelineEditor({
  timeline, animations, sounds, selection, onSelect, onPatchClip, onRemoveClip, onDuplicateClip,
  onAddSoundAt, onAddSoundTrack, onSetPlanDuration, playheadMs, onScrub, playing,
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
    | { mode: 'planEnd' }
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

  /** Applique l'état de drag courant pour une position pointeur donnée — appelé
   *  par onPointerMove ET par la boucle d'auto-scroll (pointeur immobile au bord). */
  const applyDragAt = useCallback((clientX: number, altKey: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    const x = localX({ clientX })
    if (drag.mode === 'scrub') {
      onScrub(Math.max(0, Math.min(contentMs, pxToMs(x))))
      return
    }
    if (drag.mode === 'planEnd') {
      // Snap sur les bords de clips / secondes / playhead (sans la durée elle-même).
      const targets = collectSnapTargets('').filter(t => t !== timeline.durationMs)
      onSetPlanDuration(Math.max(500, Math.round(snapMs(pxToMs(x), targets, altKey))))
      return
    }
    const deltaMs = pxToMs(x - drag.grabPx)
    const sel = drag.sel
    const exclusive = sel.kind !== 'sound'
    const clips = clipsOf(sel)
    const bounds = exclusive
      ? exclusiveTrackBounds(clips, sel.id)
      : { minStartMs: 0, maxEndMs: Number.POSITIVE_INFINITY }
    const noSnap = altKey
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

  const applyDragAtRef = useRef(applyDragAt)
  applyDragAtRef.current = applyDragAt
  const lastPointerRef = useRef<{ clientX: number; altKey: boolean } | null>(null)
  const autoScrollRafRef = useRef<number | null>(null)

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    lastPointerRef.current = { clientX: e.clientX, altKey: e.altKey }
    applyDragAtRef.current(e.clientX, e.altKey)
  }, [])

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current != null) {
      cancelAnimationFrame(autoScrollRafRef.current)
      autoScrollRafRef.current = null
    }
  }, [])

  /** Pendant un drag, pointeur près d'un bord → la timeline défile toute seule
   *  (indispensable pour étirer un clip au-delà de la zone visible en un geste). */
  const startAutoScroll = useCallback(() => {
    stopAutoScroll()
    const step = () => {
      autoScrollRafRef.current = null
      const el = scrollRef.current
      if (!el || !dragRef.current) return
      const lp = lastPointerRef.current
      if (lp) {
        const rect = el.getBoundingClientRect()
        const M = 42
        let dx = 0
        if (lp.clientX > rect.right - M) dx = Math.min(26, (lp.clientX - (rect.right - M)) * 0.5 + 4)
        else if (lp.clientX < rect.left + LABEL_W + M) dx = -Math.min(26, ((rect.left + LABEL_W + M) - lp.clientX) * 0.5 + 4)
        if (dx !== 0) {
          el.scrollLeft += dx
          applyDragAtRef.current(lp.clientX, lp.altKey)
        }
      }
      autoScrollRafRef.current = requestAnimationFrame(step)
    }
    autoScrollRafRef.current = requestAnimationFrame(step)
  }, [stopAutoScroll])

  useEffect(() => stopAutoScroll, [stopAutoScroll])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null
      lastPointerRef.current = null
      stopAutoScroll()
      try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* */ }
    }
  }, [stopAutoScroll])

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
    lastPointerRef.current = { clientX: e.clientX, altKey: e.altKey }
    startAutoScroll()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  // --- Rendu d'un clip ---
  const renderClip = (
    sel: NonNullable<TimelineSelection>,
    clip: { id: string; startMs: number; durationMs: number },
    color: string,
    label: string,
    extra?: string,
    titleHint?: string,
    rowH: number = TRACK_H,
    wave?: React.ReactNode,
    pointMode?: boolean,
  ) => {
    const isSel = selection != null && selection.kind === sel.kind && selection.id === sel.id
    return (
      <div
        key={clip.id}
        onPointerDown={(e) => startClipDrag(e, sel, 'move')}
        onContextMenu={(e) => e.preventDefault()}
        title={`${label}${extra ? ` · ${extra}` : ''} — ${formatMs(clip.startMs)} → ${formatMs(clip.startMs + clip.durationMs)}${titleHint ? ` · ${titleHint}` : ''} (clic droit : supprimer)`}
        style={{
          position: 'absolute',
          left: pointMode ? msToPx(clip.startMs) - 9 : msToPx(clip.startMs),
          width: pointMode ? 18 : Math.max(6, msToPx(clip.durationMs)),
          top: 3,
          height: rowH - 6,
          background: color,
          opacity: isSel ? 1 : 0.8,
          border: isSel ? '2px solid #fff' : '1px solid rgba(0,0,0,0.4)',
          borderRadius: 4,
          color: '#fff',
          fontSize: 10,
          lineHeight: `${rowH - 8}px`,
          padding: '0 6px',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          cursor: 'grab',
          userSelect: 'none',
          boxSizing: 'border-box',
        }}
      >
        {wave}
        <span style={{ position: 'relative', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>{label}</span>
        {isSel && sel.kind !== 'motion' && (
          <div
            onPointerDown={(e) => { e.stopPropagation(); onDuplicateClip(sel) }}
            title="Dupliquer ce clip (copie posée à la suite)"
            style={{ position: 'absolute', right: 10, top: 0, bottom: 0, display: 'flex', alignItems: 'center', cursor: 'copy', fontSize: 12, padding: '0 3px' }}
          >⧉</div>
        )}
        {/* Poignées de resize (pas pour les marqueurs ponctuels ✨) */}
        {!pointMode && (
          <div
            onPointerDown={(e) => startClipDrag(e, sel, 'resize-l')}
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }}
          />
        )}
        {!pointMode && (
          <div
            onPointerDown={(e) => startClipDrag(e, sel, 'resize-r')}
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 6, cursor: 'ew-resize' }}
          />
        )}
      </div>
    )
  }

  const animName = (id: string) => animations.find(a => a.id === id)?.name ?? id.slice(0, 6)

  /** Repères des CYCLES internes d'un clip animation : traits verticaux à chaque
   *  reprise de boucle ; en « 1× puis figé », trait de fin de passe + zone
   *  hachurée « figé ». Permet de suivre où en est l'animation dans le bloc. */
  const animCycleOverlay = (c: { animationId: string; durationMs: number; speedMul?: number; fillMode: 'loop' | 'once-hold' }) => {
    const a = animations.find(x => x.id === c.animationId)
    const raw = a?.mesh?.videoFramesMesh?.length ?? a?.mesh?.walkBodyFrames?.length ?? 0
    if (!raw) return undefined
    const mul = Math.max(0.01, c.speedMul ?? 1)
    // Boucle : cycle VISUEL (crossfade de fin fondu dans le début).
    const effFrames = c.fillMode === 'loop' ? Math.max(1, raw - (a?.mesh?.crossfadeFrames ?? 7)) : raw
    const cycleMs = (effFrames / (FILM_FPS * mul)) * 1000
    const w = Math.max(6, msToPx(c.durationMs))
    const cyclePx = msToPx(cycleMs)
    if (cyclePx < 4) return undefined
    const els: React.ReactNode[] = []
    if (c.fillMode === 'loop') {
      for (let x = cyclePx, i = 0; x < w - 2 && i < 200; x += cyclePx, i++) {
        els.push(<div key={i} style={{ position: 'absolute', left: x, top: 2, bottom: 2, width: 1, background: 'rgba(255,255,255,0.55)' }} title="Reprise de la boucle" />)
      }
    } else if (cyclePx < w - 2) {
      els.push(<div key="end" style={{ position: 'absolute', left: cyclePx, top: 2, bottom: 2, width: 2, background: 'rgba(255,255,255,0.7)' }} />)
      els.push(
        <div
          key="frozen"
          style={{
            position: 'absolute', left: cyclePx + 2, right: 0, top: 0, bottom: 0,
            background: 'repeating-linear-gradient(45deg, rgba(0,0,0,0.3) 0 4px, transparent 4px 8px)',
            fontSize: 8, color: 'rgba(255,255,255,0.75)', display: 'flex', alignItems: 'flex-end',
            justifyContent: 'flex-end', padding: '0 4px 2px 0',
          }}
        >{msToPx(c.durationMs - cycleMs) > 34 ? 'figé' : ''}</div>,
      )
    }
    if (els.length === 0) return undefined
    return <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>{els}</div>
  }
  const soundName = (id: string) => sounds.find(x => x.id === id)?.name ?? id.slice(0, 6)

  // Graduations : pas adapté au zoom (1 s / 2 s / 5 s).
  const stepSec = pxPerSec >= 90 ? 1 : pxPerSec >= 35 ? 2 : 5
  const ticks: number[] = []
  for (let t = 0; t <= contentMs / 1000 + stepSec; t += stepSec) ticks.push(t)

  const trackRow = (label: string, children: React.ReactNode, onDblClick?: (atMs: number) => void, rowH: number = TRACK_H) => (
    <div style={{ display: 'flex', borderTop: '1px solid #2c2c2c' }}>
      <div style={{
        width: LABEL_W, minWidth: LABEL_W, fontSize: 10, opacity: 0.75, padding: '0 6px',
        lineHeight: `${rowH}px`, background: '#1c1c1c', position: 'sticky', left: 0, zIndex: 3,
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      }}>{label}</div>
      <div
        style={{ position: 'relative', height: rowH, width: contentW, flexShrink: 0 }}
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
              lastPointerRef.current = { clientX: e.clientX, altKey: e.altKey }
              startAutoScroll()
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              onScrub(Math.max(0, Math.min(contentMs, pxToMs(localX(e)))))
            }}
          >
            {ticks.map(t => (
              <div key={t} style={{ position: 'absolute', left: msToPx(t * 1000), top: 0, bottom: 0, borderLeft: '1px solid #3a3a3a', fontSize: 9, color: '#888', paddingLeft: 3, lineHeight: `${RULER_H}px` }}>
                {t}s
              </div>
            ))}
            {/* Fin du plan : poignée DRAGGABLE (la durée s'étend seule avec les clips,
                mais on peut la tirer pour ajouter du temps ou raccourcir). */}
            <div
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                dragRef.current = { mode: 'planEnd' }
                lastPointerRef.current = { clientX: e.clientX, altKey: e.altKey }
                startAutoScroll()
                ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              }}
              style={{ position: 'absolute', left: msToPx(timeline.durationMs) - 4, top: 0, bottom: 0, width: 9, cursor: 'ew-resize', zIndex: 2 }}
              title={`Fin du plan (${formatMs(timeline.durationMs)}) — glisser pour ajuster la durée`}
            >
              <div style={{ position: 'absolute', left: 3, top: 0, bottom: 0, width: 2, background: '#ef5350' }} />
              <div style={{ position: 'absolute', left: -1, top: 0, width: 10, height: 8, background: '#ef5350', borderRadius: '0 0 4px 4px' }} />
            </div>
          </div>
        </div>

        {/* Pistes */}
        {trackRow('Déplacement', (() => {
          const wpIdx = (id: string) => timeline.waypoints.findIndex(w => w.id === id)
          const toLabel = (c: (typeof timeline.motion)[number]) =>
            c.to.kind === 'waypoint' ? `📍${wpIdx(c.to.id) + 1}`
              : c.to.kind === 'offscreen' ? (c.to.side === 'left' ? 'hors-champ ←' : 'hors-champ →')
                : 'sortie libre'
          const sorted = [...timeline.motion].sort((a, b) => a.startMs - b.startMs)
          // Blocs « au point » (informatifs) entre l'arrivée d'un trajet et le départ du suivant.
          const pointBlocks = sorted.map((c, i) => {
            const start = c.startMs + c.durationMs
            const end = sorted[i + 1]?.startMs ?? timeline.durationMs
            if (end - start < 80) return null
            return { key: `pb-${c.id}`, start, end, label: c.to.kind === 'waypoint' ? `au ${toLabel(c)}` : '(hors point)' }
          }).filter((b): b is NonNullable<typeof b> => b != null)
          return (
            <>
              {pointBlocks.map(b => (
                <div key={b.key} style={{
                  position: 'absolute', left: msToPx(b.start), width: Math.max(4, msToPx(b.end - b.start)),
                  top: 6, height: TRACK_H - 12, border: '1px dashed #4a4a4a', borderRadius: 4,
                  color: '#9a9a9a', fontSize: 9, lineHeight: `${TRACK_H - 14}px`, padding: '0 6px',
                  overflow: 'hidden', whiteSpace: 'nowrap', pointerEvents: 'none', boxSizing: 'border-box',
                }}>{b.label}</div>
              ))}
              {timeline.motion.map(c => renderClip(
                { kind: 'motion', id: c.id }, c, FILM_COLORS.travel,
                c.kind === 'appear' ? '✨' : c.kind === 'exit' ? `sortie ${toLabel(c)}` : `🚶 → ${toLabel(c)}`,
                c.kind === 'appear' ? `apparition ${toLabel(c)} — INSTANTANÉE, glisser pour changer le moment (à gauche = dès le début)` : undefined,
                c.kind === 'appear' ? undefined : 'bord gauche = Départ · bord droit = Arrivée',
                TRACK_H,
                undefined,
                c.kind === 'appear',
              ))}
            </>
          )
        })())}
        {trackRow('Animation', timeline.anim.map(c => renderClip(
          { kind: 'anim', id: c.id }, c, FILM_COLORS.action,
          animName(c.animationId), c.fillMode === 'loop' ? '🔁' : '1×',
          undefined,
          undefined,
          TRACK_H,
          animCycleOverlay(c),
        )))}
        {timeline.soundTracks.map((track, ti) => trackRow(
          `Son ${ti + 1}`,
          track.map(c => renderClip(
            { kind: 'sound', id: c.id, trackIndex: ti }, c, c.isSpoken ? '#26a69a' : FILM_COLORS.departure,
            `${c.isSpoken ? '🗣 ' : '🔊 '}${soundName(c.soundId)}${c.loop ? ' 🔁' : ''}${c.anchor ? ' ⚓' : ''}`,
            undefined,
            undefined,
            SOUND_TRACK_H,
            <Waveform
              soundId={c.soundId}
              blob={sounds.find(x => x.id === c.soundId)?.blob ?? null}
              clipMs={c.durationMs}
              rate={c.rate ?? 1}
              loop={c.loop === true}
              widthPx={Math.max(6, msToPx(c.durationMs))}
              heightPx={SOUND_TRACK_H - 6}
            />,
          )),
          (atMs) => onAddSoundAt(ti, Math.round(atMs)),
          SOUND_TRACK_H,
        ))}
        <div style={{ display: 'flex', borderTop: '1px solid #2c2c2c' }}>
          <button
            className="btn-ghost btn-sm"
            style={{ margin: 4, fontSize: 11, position: 'sticky', left: 4 }}
            onClick={onAddSoundTrack}
          >+ piste son</button>
        </div>

        {/* Fin du plan : ligne pleine hauteur (repère visuel sur toutes les pistes) */}
        <div style={{
          position: 'absolute', top: RULER_H, bottom: 0, left: LABEL_W + msToPx(timeline.durationMs),
          width: 2, background: 'rgba(239,83,80,0.55)', zIndex: 1, pointerEvents: 'none',
        }} />

        {/* Playhead */}
        <div style={{
          position: 'absolute', top: 0, bottom: 0, left: LABEL_W + msToPx(playheadMs),
          width: 2, background: '#ffeb3b', zIndex: 4, pointerEvents: 'none',
        }} />
      </div>
    </div>
  )
}
