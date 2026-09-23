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
 *  `zoneIds` : ne considérer que ces pattes (bipède : pattes arrière seules).
 *  `mode` : 'low' (défaut) = point le PLUS BAS du vertex extrême de la zone (pied
 *  posé, fin de battement d'aile vers le bas) ; 'high' = point le plus HAUT
 *  (haut du battement). Même algorithme, série inversée. */
export function detectFootstepFrames(anim: Animation, zoneIds?: string[], mode: 'low' | 'high' = 'low'): number[] {
  const mesh = anim.mesh
  if (!mesh) return []
  const events: number[] = []

  const collectFromSeries = (ysIn: number[]): void => {
    const ys = mode === 'high' ? ysIn.map(v => -v) : ysIn
    const n = ys.length
    if (n < 6) return
    // Lissage circulaire (moyenne 3) pour tuer le bruit des plateaux.
    const z = ys.map((_, i) => (ys[(i - 1 + n) % n] + ys[i] + ys[(i + 1) % n]) / 3)
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const y of z) { min = Math.min(min, y); max = Math.max(max, y) }
    const amp = max - min
    if (amp < 2) return // patte quasi immobile : pas de pas
    // Pics circulaires proches du sol (y écran vers le bas = pied posé), puis
    // déduplication par distance minimale (≥ 1/6 de cycle) en gardant le plus
    // bas. Robuste aux levées FAIBLES (pattes arrière d'un bipède) comme aux
    // plateaux (pied posé plusieurs frames).
    const thr = max - amp * 0.3
    const candidates: { i: number; y: number }[] = []
    for (let i = 0; i < n; i++) {
      const prev = z[(i - 1 + n) % n]
      const next = z[(i + 1) % n]
      if (z[i] >= thr && z[i] >= prev && z[i] > next) candidates.push({ i, y: z[i] })
    }
    candidates.sort((a, b) => b.y - a.y)
    const minDist = Math.max(3, Math.floor(n / 6))
    const kept: number[] = []
    for (const c of candidates) {
      const tooClose = kept.some(k => {
        const d = Math.abs(k - c.i)
        return Math.min(d, n - d) < minDist
      })
      if (!tooClose) kept.push(c.i)
    }
    events.push(...kept)
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
  /** Durée max jouée du fichier (ms). Pas : 450 (un pas = un impact) ; sons de
   *  cycle d'un idle (battement d'ailes, whoosh) : 1500. Absent = 450. */
  maxMs?: number
}

/** Clé de son one-shot pour le pas n (1|2) d'une animation — référencée par les
 *  one-shots et résolue via `extraSounds` du FilmAudioScheduler. */
export function footstepSoundKey(animId: string, n: 1 | 2): string {
  return `anim:${animId}:${n}`
}

/** Map clé → blob des sons de pas attachés aux animations du projet, à passer
 *  au FilmAudioScheduler (`extraSounds`) pour le pré-décodage. */
export function collectFootstepSoundBlobs(animations: Animation[]): Map<string, Blob> {
  const out = new Map<string, Blob>()
  for (const a of animations) {
    if (a.footstepSound1Blob) out.set(footstepSoundKey(a.id, 1), a.footstepSound1Blob)
    if (a.footstepSound2Blob) out.set(footstepSoundKey(a.id, 2), a.footstepSound2Blob)
  }
  return out
}

/**
 * Planning des bruits de pas du film : parcourt les clips motion (anim de marche
 * du trajet) et les AnimClips, et pose un one-shot à chaque contact au sol
 * (cycles bouclés sur la durée du clip). Les réglages viennent de l'ANIMATION :
 * `mesh.footstepFrames` (frames validées à l'étape « Bruits de pas »),
 * `footstepVolume`/`footstepOffsetMs`, sons `footstepSound1/2Blob` alternés.
 * Sans frames validées : fallback heuristique `detectFootstepFrames` UNIQUEMENT
 * si l'animation a des sons de pas attachés. Le film ne porte plus qu'un toggle
 * `footstepsEnabled` (défaut true).
 * `planStartMs` = offsets absolus des plans (NaN = plan inactif), cf. sampler.
 */
export function computeFootstepSchedule(
  film: FilmT,
  animations: Animation[],
  planStartMs: number[],
): FootstepOneShot[] {
  if (film.footstepsEnabled === false) return []
  // Gain FILM (réglé dans l'éditeur) × volume réglé sur l'animation.
  const filmGain = Math.max(0, film.footstepsVolume ?? 1)
  interface AnimFootsteps {
    events: number[]
    total: number
    soundKeys: string[]
    volume?: number
    offsetMs: number
    /** Marche : impact court (450 ms) ; idle en boucle (ailes…) : son plus long (1,5 s). */
    maxMs: number
  }
  const framesCache = new Map<string, AnimFootsteps>()
  const entryOf = (animId: string): AnimFootsteps => {
    let entry = framesCache.get(animId)
    if (!entry) {
      const anim = animations.find(a => a.id === animId)
      const soundKeys: string[] = []
      if (anim?.footstepSound1Blob) soundKeys.push(footstepSoundKey(anim.id, 1))
      if (anim?.footstepSound2Blob) soundKeys.push(footstepSoundKey(anim.id, 2))
      const raw = anim?.mesh?.walkBodyFrames?.length ?? anim?.mesh?.videoFramesMesh?.length ?? 0
      // Cycle VISUEL de la LoopPlayback : les crossfadeFrames de fin sont
      // fondues dans le début → la boucle affichée est plus courte que `raw`.
      const total = Math.max(1, raw - (anim?.mesh?.crossfadeFrames ?? 7))
      const validated = anim?.mesh?.footstepFrames
      const events = (soundKeys.length === 0 ? []
        : (validated != null && validated.length > 0 ? [...validated] : (anim ? detectFootstepFrames(anim) : []))
      ).filter(e => e >= 0 && e < total).sort((a, b) => a - b)
      entry = {
        events,
        total,
        soundKeys,
        ...(anim?.mesh?.footstepVolume != null && { volume: anim.mesh.footstepVolume }),
        offsetMs: anim?.mesh?.footstepOffsetMs ?? 0,
        maxMs: (anim?.type === 'marche' || anim?.type === 'walk') ? 450 : 1500,
      }
      framesCache.set(animId, entry)
      if (import.meta.env.DEV && soundKeys.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[Pas] "${anim?.name ?? animId.slice(0, 8)}" (${validated?.length ? 'frames validées' : 'auto-détection'}) : ${events.length} contact(s)/cycle aux frames [${events.join(', ')}] — cycle ${total} frames ≈ ${Math.round((total / FILM_FPS) * 1000)} ms`)
      }
    }
    return entry
  }

  const out: FootstepOneShot[] = []
  let stepCounter = 0
  /** Pose les contacts d'un cycle démarré à `originMs` (phase de l'animation),
   *  limités à la fenêtre [winStartMs, winEndMs) — même phasage que le sampler. */
  const emit = (base: number, originMs: number, winStartMs: number, winEndMs: number, animId: string, speedMul: number) => {
    if (winEndMs <= winStartMs) return
    const { events, total, soundKeys, volume, offsetMs, maxMs } = entryOf(animId)
    if (events.length === 0 || soundKeys.length === 0 || total === 0) return
    const mul = Math.max(0.01, speedMul)
    const msPerFrame = 1000 / (FILM_FPS * mul)
    const cycleMs = total * msPerFrame
    const spanMs = winEndMs - originMs
    for (let k = 0; k * cycleMs < spanMs; k++) {
      for (const e of events) {
        const t = originMs + (e + k * total) * msPerFrame
        if (t >= winEndMs) break
        if (t < winStartMs) continue
        out.push({
          timeMs: Math.max(0, base + t + offsetMs),
          soundId: soundKeys[stepCounter++ % soundKeys.length],
          volume: (volume ?? 1) * filmGain,
          maxMs,
        })
      }
    }
  }

  film.plans.forEach((plan, idx) => {
    const base = planStartMs[idx]
    if (base == null || Number.isNaN(base)) return
    // Intervalles couverts par un AnimClip : le sampler y joue l'anim du clip,
    // PAS celle du trajet → les sons de cycle du trajet y sont exclus (sinon
    // les deux calendriers se superposaient : chaque son joué deux fois).
    const animSpans = plan.timeline.anim
      .filter(a => a.durationMs > 0)
      .map(a => [a.startMs, a.startMs + a.durationMs] as const)
      .sort((a, b) => a[0] - b[0])
    for (const c of plan.timeline.motion) {
      if (c.kind === 'appear' || c.durationMs <= 0) continue
      const animId = c.animationId ?? film.moveAnimationId
      if (animId == null) continue
      const mul = c.animSpeedMul ?? 1
      let cursor = c.startMs
      const end = c.startMs + c.durationMs
      for (const [as, ae] of animSpans) {
        if (ae <= cursor) continue
        if (as >= end) break
        if (as > cursor) emit(base, c.startMs, cursor, Math.min(as, end), animId, mul)
        cursor = Math.max(cursor, ae)
        if (cursor >= end) break
      }
      if (cursor < end) emit(base, c.startMs, cursor, end, animId, mul)
    }
    for (const a of plan.timeline.anim) {
      emit(base, a.startMs, a.startMs, a.startMs + a.durationMs, a.animationId, a.speedMul ?? 1)
    }
  })
  // Dédoublonnage : deux contacts à < 60 ms l'un de l'autre = même impact.
  out.sort((a, b) => a.timeMs - b.timeMs)
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].timeMs - out[i - 1].timeMs < 60) out.splice(i, 1)
  }
  out.sort((a, b) => a.timeMs - b.timeMs)
  return out
}
