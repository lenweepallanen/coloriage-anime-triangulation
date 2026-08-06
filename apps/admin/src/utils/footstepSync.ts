import type { Animation, FilmT } from '../types/project'
import { FILM_FPS } from './filmTimeline'

/**
 * Bruits de pas synchronisés : détection des CONTACTS AU SOL dans une animation
 * de marche (frames où le pied de chaque patte atteint son point le plus bas),
 * puis génération du planning des sons de pas sur la timeline du film (un
 * one-shot par contact, en alternant pas1/pas2). Tout est pur — le
 * FilmAudioScheduler joue les one-shots.
 */

/** Frames (entières) des contacts au sol d'une animation de marche.
 *  `zoneIds` : ne considérer que ces pattes (bipède : pattes arrière seules). */
export function detectFootstepFrames(anim: Animation, zoneIds?: string[]): number[] {
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
    // Machine à états avec HYSTÉRÉSIS : UN événement par appui, au moment où le
    // pied TOUCHE le sol (franchit le seuil bas en descendant). Le plateau du
    // pied posé ne redéclenche pas, il faut d'abord repasser en l'air.
    const groundAt = max - amp * 0.18
    const airAt = max - amp * 0.45
    let onGround = ys[0] >= groundAt
    for (let i = 1; i < n; i++) {
      if (!onGround && ys[i] >= groundAt) {
        onGround = true
        events.push(i)
      } else if (onGround && ys[i] <= airAt) {
        onGround = false
      }
    }
  }

  const zoneFrames = mesh.walkZoneFramesSmoothed ?? mesh.walkZoneFrames
  if (zoneFrames) {
    // Zone-based (marche / members-bones / walk) : 1 série par patte,
    // pied = vertex le plus bas de la zone à la frame 0.
    for (const zoneId of Object.keys(zoneFrames)) {
      if (zoneIds != null && zoneIds.length > 0 && !zoneIds.includes(zoneId)) continue
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
  const eventsOf = (animId: string, zoneIds?: string[]) => {
    const key = animId + '|' + (zoneIds?.join(',') ?? '*')
    let entry = framesCache.get(key)
    if (!entry) {
      const anim = animations.find(a => a.id === animId)
      const raw = anim?.mesh?.walkBodyFrames?.length ?? anim?.mesh?.videoFramesMesh?.length ?? 0
      // Cycle VISUEL de la LoopPlayback : les crossfadeFrames de fin sont
      // fondues dans le début → la boucle affichée est plus courte que `raw`.
      const total = Math.max(1, raw - (anim?.mesh?.crossfadeFrames ?? 7))
      const events = (anim ? detectFootstepFrames(anim, zoneIds) : []).filter(e => e < total)
      entry = { events, total }
      framesCache.set(key, entry)
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.log(`[Pas] "${anim?.name ?? animId.slice(0, 8)}" (pattes: ${zoneIds?.join(', ') ?? 'toutes'}) : ${events.length} contact(s)/cycle aux frames [${events.join(', ')}] — cycle ${total} frames ≈ ${Math.round((total / FILM_FPS) * 1000)} ms`)
      }
    }
    return entry
  }

  const out: FootstepOneShot[] = []
  let stepCounter = 0
  const emit = (base: number, startMs: number, durationMs: number, animId: string, speedMul: number) => {
    const cfg = configs.get(animId)
    if (!cfg || durationMs <= 0) return
    const { events, total } = eventsOf(animId, cfg.zoneIds)
    if (events.length === 0 || total === 0) return
    const mul = Math.max(0.01, speedMul)
    const msPerFrame = 1000 / (FILM_FPS * mul)
    const cycleMs = total * msPerFrame
    for (let k = 0; k * cycleMs < durationMs; k++) {
      for (const e of events) {
        const t = (e + k * total) * msPerFrame
        if (t >= durationMs) break
        out.push({
          timeMs: Math.max(0, base + startMs + t + (cfg.offsetMs ?? 0)),
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
