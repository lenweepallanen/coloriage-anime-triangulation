import type { Animation, FilmT } from '../types/project'
import { FILM_FPS } from './filmTimeline'

/**
 * Bruits de pas synchronisés : détection des CONTACTS AU SOL dans une animation
 * de marche (frames où le pied de chaque patte atteint son point le plus bas),
 * puis génération du planning des sons de pas sur la timeline du film (un
 * one-shot par contact, en alternant pas1/pas2). Tout est pur — le
 * FilmAudioScheduler joue les one-shots.
 */

/** Frames (entières) des contacts au sol d'une animation de marche. */
export function detectFootstepFrames(anim: Animation): number[] {
  const mesh = anim.mesh
  if (!mesh) return []
  const events: number[] = []

  const collectFromSeries = (ys: number[]): void => {
    const n = ys.length
    if (n < 6) return
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const y of ys) { min = Math.min(min, y); max = Math.max(max, y) }
    const amp = max - min
    if (amp < 2) return // patte quasi immobile : pas de pas
    // Maxima locaux (y écran vers le bas = pied au sol) proches du sol.
    const threshold = max - amp * 0.25
    for (let i = 1; i < n - 1; i++) {
      if (ys[i] >= ys[i - 1] && ys[i] >= ys[i + 1] && ys[i] >= threshold) {
        events.push(i)
        i += 2 // évite les doubles détections sur un plateau
      }
    }
  }

  const zoneFrames = mesh.walkZoneFramesSmoothed ?? mesh.walkZoneFrames
  if (zoneFrames) {
    // Zone-based (marche / members-bones / walk) : 1 série par patte,
    // pied = vertex le plus bas de la zone à la frame 0.
    for (const zoneId of Object.keys(zoneFrames)) {
      const frames = zoneFrames[zoneId]
      if (!frames || frames.length < 6 || !frames[0]?.length) continue
      let footIdx = 0
      for (let i = 1; i < frames[0].length; i++) {
        if (frames[0][i].y > frames[0][footIdx].y) footIdx = i
      }
      collectFromSeries(frames.map(f => f[footIdx]?.y ?? 0))
    }
  } else if (mesh.videoFramesMesh && mesh.videoFramesMesh.length >= 6) {
    // Fallback mesh unique : moyenne des 5 vertices les plus bas (approximation).
    const frames = mesh.videoFramesMesh
    const idx = frames[0]
      .map((p, i) => ({ i, y: p.y }))
      .sort((a, b) => b.y - a.y)
      .slice(0, 5)
      .map(e => e.i)
    collectFromSeries(frames.map(f => idx.reduce((acc, i) => acc + (f[i]?.y ?? 0), 0) / idx.length))
  }

  // Fusion des contacts trop proches (pattes quasi synchrones) + tri.
  events.sort((a, b) => a - b)
  const merged: number[] = []
  for (const e of events) {
    if (merged.length === 0 || e - merged[merged.length - 1] >= 3) merged.push(e)
  }
  return merged
}

export interface FootstepOneShot {
  /** Temps ABSOLU film (ms). */
  timeMs: number
  soundId: string
  volume?: number
}

/**
 * Planning des bruits de pas du film : parcourt les clips motion (anim de marche
 * du trajet) et les AnimClips utilisant une animation liée, et pose un one-shot
 * à chaque contact au sol (cycles bouclés sur la durée du clip).
 * `planStartMs` = offsets absolus des plans (NaN = plan inactif), cf. sampler.
 */
export function computeFootstepSchedule(
  film: FilmT,
  animations: Animation[],
  planStartMs: number[],
): FootstepOneShot[] {
  const configs = new Map((film.footstepSounds ?? [])
    .filter(c => c.soundIds.length > 0)
    .map(c => [c.animationId, c]))
  if (configs.size === 0) return []
  const framesCache = new Map<string, { events: number[]; total: number }>()
  const eventsOf = (animId: string) => {
    let entry = framesCache.get(animId)
    if (!entry) {
      const anim = animations.find(a => a.id === animId)
      const total = anim?.mesh?.walkBodyFrames?.length ?? anim?.mesh?.videoFramesMesh?.length ?? 0
      entry = { events: anim ? detectFootstepFrames(anim) : [], total }
      framesCache.set(animId, entry)
    }
    return entry
  }

  const out: FootstepOneShot[] = []
  let stepCounter = 0
  const emit = (base: number, startMs: number, durationMs: number, animId: string, speedMul: number) => {
    const cfg = configs.get(animId)
    if (!cfg || durationMs <= 0) return
    const { events, total } = eventsOf(animId)
    if (events.length === 0 || total === 0) return
    const mul = Math.max(0.01, speedMul)
    const msPerFrame = 1000 / (FILM_FPS * mul)
    const cycleMs = total * msPerFrame
    for (let k = 0; k * cycleMs < durationMs; k++) {
      for (const e of events) {
        const t = (e + k * total) * msPerFrame
        if (t >= durationMs) break
        out.push({
          timeMs: base + startMs + t,
          soundId: cfg.soundIds[stepCounter++ % cfg.soundIds.length],
          ...(cfg.volume != null && { volume: cfg.volume }),
        })
      }
    }
  }

  film.plans.forEach((plan, idx) => {
    const base = planStartMs[idx]
    if (base == null || Number.isNaN(base)) return
    for (const c of plan.timeline.motion) {
      if (c.kind === 'appear' || c.durationMs <= 0) continue
      const animId = c.animationId ?? film.moveAnimationId
      if (animId != null) emit(base, c.startMs, c.durationMs, animId, c.animSpeedMul ?? 1)
    }
    for (const a of plan.timeline.anim) {
      emit(base, a.startMs, a.durationMs, a.animationId, a.speedMul ?? 1)
    }
  })
  out.sort((a, b) => a.timeMs - b.timeMs)
  return out
}
