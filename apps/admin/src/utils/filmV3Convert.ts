import type {
  Animation, FilmAnimClip, FilmMotionClip, FilmMotionRef, FilmPlanTimeline,
  FilmSound, FilmSoundClip, FilmT, FilmTimelinePlan, FilmV3, SceneAction, SceneSound,
} from '../types/project'
import { buildFilmSegments, resolveFilmPlans } from './filmDirector'
import { buildFilmScene, filmToSceneFilm } from './filmScene'
import { ACTION_SETTLE_MS, estimateFilmDurations, getAudioDurationMs } from './sceneActionDuration'
import { FILM_FPS } from './filmTimeline'

/**
 * Convertit un film v3 (séquence de points à durées implicites) vers le modèle
 * TIMELINE (v4, clips à durées explicites). Réutilise les briques du moteur v3
 * (`buildFilmSegments` + `estimateFilmDurations`) pour MATÉRIALISER les durées
 * telles qu'elles étaient estimées — le film converti joue au même rythme
 * (± le settle post-action de 290 ms, supprimé : les crossfades suffisent).
 *
 * Async : les durées des sons non bouclés sont lues dans leurs métadonnées audio.
 */
export async function convertFilmV3ToTimeline(filmV3: FilmV3, animations: Animation[]): Promise<FilmT> {
  const sceneFilm = filmToSceneFilm(filmV3)
  const scene = buildFilmScene(filmV3)
  const segs = buildFilmSegments(sceneFilm)
  const est = await estimateFilmDurations(sceneFilm, scene, animations)

  // Les segments indexent les plans JOUABLES (resolveFilmPlans filtre les plans
  // sans point). On mappe playableIndex → plan v3 d'origine par id.
  const playable = resolveFilmPlans(sceneFilm, scene)
  const v3PlanById = new Map(filmV3.plans.map(pl => [pl.id, pl]))

  // Bibliothèque de sons (ids conservés → chemins Storage film/sounds/{id} inchangés).
  const library = new Map<string, FilmSound>()
  const registerSound = (snd: SceneSound): void => {
    if (!library.has(snd.id)) {
      library.set(snd.id, { id: snd.id, name: snd.name, blob: snd.blob, ...(snd.volume != null && { volume: snd.volume }) })
    }
  }
  const soundNativeMs = async (snd: SceneSound): Promise<number> => {
    if (!snd.blob) return 1000
    const d = await getAudioDurationMs(snd.blob)
    return (d > 0 ? d : 1000) / Math.max(0.01, snd.rate ?? 1)
  }

  // Sorties par plan v3 (les plans sans point gardent une timeline vide).
  const outPlans = new Map<string, FilmTimelinePlan>(filmV3.plans.map(pl => [pl.id, {
    id: pl.id,
    ...(pl.name != null && { name: pl.name }),
    backdrop: pl.backdrop,
    overlay: pl.overlay,
    cameraX: pl.cameraX,
    ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
    timeline: {
      durationMs: 0,
      waypoints: pl.points.map(p => ({
        id: p.id, x: p.x, y: p.y, scale: p.scale,
        ...(p.facing != null && { facing: p.facing }),
      })),
      motion: [],
      anim: [],
      soundTracks: [],
    } satisfies FilmPlanTimeline,
  }]))

  let clipSeq = 0
  const newId = (): string => {
    try { return crypto.randomUUID() } catch { return `v3clip-${++clipSeq}` }
  }

  /** Pose un clip son sur la première piste libre (pas de chevauchement). */
  const placeSound = (timeline: FilmPlanTimeline, clip: FilmSoundClip): void => {
    for (const track of timeline.soundTracks) {
      const overlaps = track.some(c =>
        clip.startMs < c.startMs + c.durationMs && c.startMs < clip.startMs + clip.durationMs)
      if (!overlaps) {
        track.push(clip)
        return
      }
    }
    timeline.soundTracks.push([clip])
  }

  const soundClipFrom = (snd: SceneSound, startMs: number, durationMs: number, isSpoken?: boolean): FilmSoundClip => {
    registerSound(snd)
    return {
      id: newId(),
      startMs: Math.round(startMs),
      durationMs: Math.max(1, Math.round(durationMs)),
      soundId: snd.id,
      ...(snd.volume != null && { volume: snd.volume }),
      ...(snd.rate != null && { rate: snd.rate }),
      ...(snd.loop === true && { loop: true }),
      ...(isSpoken === true && { isSpoken: true }),
    }
  }

  /** Frames d'une animation (même résolution que estimateActionDurationMs). */
  const animFrames = (animId: string): number => {
    const anim = animations.find(a => a.id === animId)
    return anim?.mesh?.videoFramesMesh?.length ?? anim?.mesh?.walkBodyFrames?.length ?? 0
  }

  /** Étale une action v3 en AnimClips/SoundClips (mêmes offsets que le moteur). */
  const emitAction = async (timeline: FilmPlanTimeline, action: SceneAction, tMs: number, actionMs: number): Promise<void> => {
    let cumMs = 0
    for (const step of action.steps) {
      const stepStart = cumMs
      const n = animFrames(step.animationId)
      const mul = Math.max(0.01, step.animSpeedMul ?? 1)
      const stepMs = (n / FILM_FPS / mul) * 1000
      const clip: FilmAnimClip = {
        id: newId(),
        startMs: Math.round(tMs + stepStart),
        durationMs: Math.max(1, Math.round(step.loop === true ? Math.max(stepMs, actionMs - stepStart) : stepMs)),
        animationId: step.animationId,
        ...(step.animSpeedMul != null && { speedMul: step.animSpeedMul }),
        fillMode: step.loop === true ? 'loop' : 'once-hold',
      }
      timeline.anim.push(clip)
      if (step.sound?.blob) {
        const durMs = step.sound.loop === true
          ? Math.max(1, actionMs - stepStart)
          : await soundNativeMs(step.sound)
        placeSound(timeline, soundClipFrom(step.sound, tMs + stepStart, durMs, step.isSpoken))
      }
      cumMs += stepMs
    }
    if (action.sound?.blob) {
      const durMs = action.sound.loop === true ? actionMs : await soundNativeMs(action.sound)
      placeSound(timeline, soundClipFrom(action.sound, tMs, durMs, action.isSpoken))
    }
  }

  // --- Parcours des segments, curseur temporel par plan ---
  let curPlanId = playable[0]?.id ?? null
  let t = 0
  const timelineOf = (planId: string | null): FilmPlanTimeline | null =>
    planId != null ? outPlans.get(planId)?.timeline ?? null : null

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const dur = est.segments[i] ?? 0
    const planId = playable[seg.planIndex]?.id ?? null
    if (planId !== curPlanId && seg.kind !== 'planSwitch') {
      curPlanId = planId
      t = 0
    }
    const timeline = timelineOf(curPlanId)
    if (!timeline) continue

    if (seg.kind === 'planSwitch') {
      timeline.durationMs = Math.round(t)
      curPlanId = playable[seg.toPlanIndex]?.id ?? null
      t = 0
      continue
    }
    if (seg.kind === 'pause') {
      t += dur
      continue
    }
    if (seg.kind === 'action') {
      const actionMs = Math.max(0, dur - ACTION_SETTLE_MS)
      await emitAction(timeline, seg.action, t, actionMs)
      t += actionMs
      continue
    }

    // seg.kind === 'travel'
    const v3Plan = v3PlanById.get(curPlanId!)
    const wpByCoords = new Map((v3Plan?.points ?? []).map(p => [`${p.x},${p.y}`, p.id]))
    const isAppear = seg.opts.startAt != null && seg.target != null
      && seg.opts.startAt.x === seg.target.x && seg.opts.startAt.y === seg.target.y
    const travelMs = isAppear ? 0 : dur

    let to: FilmMotionRef
    if (seg.opts.offscreenEnd) {
      to = { kind: 'offscreen', side: seg.opts.offscreenEnd }
    } else if (seg.target) {
      const wpId = wpByCoords.get(`${seg.target.x},${seg.target.y}`)
      to = wpId != null
        ? { kind: 'waypoint', id: wpId }
        : { kind: 'free', x: seg.target.x, y: seg.target.y, scale: seg.opts.scaleTo }
    } else {
      continue
    }
    let from: FilmMotionRef | undefined
    if (!isAppear && seg.opts.startAt) {
      from = { kind: 'free', x: seg.opts.startAt.x, y: seg.opts.startAt.y, scale: seg.opts.scaleFrom }
    } else if (seg.opts.offscreenStart) {
      from = { kind: 'offscreen', side: seg.opts.offscreenStart }
    }

    const motion: FilmMotionClip = {
      id: newId(),
      startMs: Math.round(t),
      durationMs: Math.max(0, Math.round(travelMs)),
      kind: isAppear ? 'appear' : (seg.opts.offscreenEnd ? 'exit' : 'travel'),
      ...(from != null && { from }),
      to,
      ...(seg.opts.controlPoints != null && seg.opts.controlPoints.length > 0 && { controlPoints: seg.opts.controlPoints }),
      ...(seg.opts.easing != null && { easing: seg.opts.easing }),
      // L'anim de déplacement est portée par le trajet lui-même (le sampler la
      // joue pendant le trajet ; un AnimClip par-dessus aurait priorité).
      ...(!isAppear && seg.opts.animationId != null && { animationId: seg.opts.animationId }),
      ...(!isAppear && seg.opts.animSpeedMul != null && { animSpeedMul: seg.opts.animSpeedMul }),
    }
    timeline.motion.push(motion)
    if (seg.sound?.blob) {
      const durMs = seg.sound.loop === true ? Math.max(1, travelMs) : await soundNativeMs(seg.sound)
      if (travelMs > 0) placeSound(timeline, soundClipFrom(seg.sound, t, durMs))
    }
    t += travelMs
  }
  // Dernier plan jouable : durée = curseur final.
  const lastTimeline = timelineOf(curPlanId)
  if (lastTimeline) lastTimeline.durationMs = Math.round(t)

  if (filmV3.music) registerSound({ id: filmV3.music.id, name: filmV3.music.name, blob: filmV3.music.blob, volume: filmV3.music.volume })

  return {
    version: 4,
    plans: filmV3.plans.map(pl => outPlans.get(pl.id)!),
    character: { ...filmV3.character },
    sounds: Array.from(library.values()),
    ...(filmV3.music != null && { music: { ...filmV3.music } }),
    ...(filmV3.moveAnimationId != null && { moveAnimationId: filmV3.moveAnimationId }),
    moveSpeedPxPerSec: filmV3.moveSpeedPxPerSec,
    ...(filmV3.idleSpeedMul != null && { idleSpeedMul: filmV3.idleSpeedMul }),
  }
}
