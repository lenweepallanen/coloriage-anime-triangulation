import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  animationHasFrames, filmTIsPlayable,
  type FilmMotionClip, type FilmAnimClip, type FilmSoundClip, type FilmPlanTimeline,
  type FilmT, type FilmTimelinePlan, type FilmWaypoint, type Point2D, type Project,
} from '../../../types/project'
import type { UploadHint } from '../../../db/projectsStore'
import { buildFilmTScene } from '../../../utils/filmScene'
import { FilmTimelineSampler } from '../../../utils/filmTimelineSampler'
import { sampleFilmPath } from '../../../utils/filmPath'
import { resolveSoundAnchors, timelineContentEndMs } from '../../../utils/filmTimeline'
import { getAudioDurationMs } from '../../../utils/sceneActionDuration'
import ScenePlayer from '../../scan/ScenePlayer'
import { PreviewModalShell } from '../PreviewModal'
import CharacterOriginEditor from '../CharacterOriginEditor'
import FilmCanvasT from './FilmCanvasT'
import TimelineEditor, { type TimelineSelection } from './timeline/TimelineEditor'
import ClipInspector from './timeline/ClipInspector'
import { defaultControlPoints, fileToDecorLayer, formatMs, transitionFromKey, transitionToKey } from './filmEditorShared'
import { FilmAudioScheduler } from '../../../utils/filmAudioScheduler'

/**
 * Éditeur de FILM TIMELINE (v4) : canvas spatial (waypoints, caméra, chemins) en
 * haut, bandeau de plans, TIMELINE du plan actif (déplacement / animation / sons)
 * en bas, inspecteur du clip ou du waypoint sélectionné à droite. Le QUAND est la
 * donnée maîtresse : tout est clip positionné en millisecondes.
 */
export default function FilmEditorT({ project, onSave }: {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}) {
  const [film, setFilm] = useState<FilmT | null>(project.filmT ?? null)
  const [converting, setConverting] = useState(false)
  const [activePlanId, setActivePlanId] = useState<string | null>(null)
  const [selection, setSelection] = useState<TimelineSelection>(null)
  const [selectedWaypointId, setSelectedWaypointId] = useState<string | null>(null)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [editorPlaying, setEditorPlaying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null)
  const previewProjectRef = useRef<Project | null>(null)
  const pendingSoundHintsRef = useRef<UploadHint[]>([])
  const soundImportRef = useRef<HTMLInputElement | null>(null)
  const pendingSoundTargetRef = useRef<{ trackIndex: number; atMs: number } | null>(null)

  // Chargement : filmT du projet, sinon conversion v3 → timeline (une fois).
  useEffect(() => {
    if (project.filmT) {
      setFilm(project.filmT)
      return
    }
    if (!project.film) {
      setFilm(null)
      return
    }
    let cancelled = false
    setConverting(true)
    import('../../../utils/filmV3Convert')
      .then(({ convertFilmV3ToTimeline }) => convertFilmV3ToTimeline(project.film!, project.animations))
      .then(t => { if (!cancelled) setFilm(t) })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.error('[Film] conversion v3 → timeline échouée', err)
      })
      .finally(() => { if (!cancelled) setConverting(false) })
    return () => { cancelled = true }
  }, [project.filmT, project.film, project.animations])

  const plans = film?.plans ?? []
  const plan = plans.find(pl => pl.id === activePlanId) ?? plans[0] ?? null
  const planIndex = plan ? plans.indexOf(plan) : -1
  const readyAnimations = project.animations.filter(a => animationHasFrames(a))
  const canPreview = project.originalImageBlob != null && readyAnimations.length > 0 && filmTIsPlayable(film)

  // Image du coloriage (silhouette + origine).
  const [charImageUrl, setCharImageUrl] = useState<string | null>(null)
  const [charImageSize, setCharImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  useEffect(() => {
    if (!project.originalImageBlob) {
      setCharImageUrl(null)
      setCharImageSize({ w: 0, h: 0 })
      return
    }
    const url = URL.createObjectURL(project.originalImageBlob)
    setCharImageUrl(url)
    const img = new Image()
    img.src = url
    img.onload = () => setCharImageSize({ w: img.naturalWidth, h: img.naturalHeight })
    return () => { URL.revokeObjectURL(url); setCharImageUrl(null) }
  }, [project.originalImageBlob])

  // Sampler : source de vérité géométrique (scrub, chemins, durées).
  const sampler = useMemo(
    () => (film ? new FilmTimelineSampler(film, project.animations) : null),
    [film, project.animations],
  )

  const motionGeom = useMemo(() => {
    if (!sampler || !plan || planIndex < 0) return []
    return plan.timeline.motion.map(c => {
      const a = sampler.evaluatePlanLocal(planIndex, c.startMs + Math.min(1, c.durationMs))
      const b = sampler.evaluatePlanLocal(planIndex, c.startMs + Math.max(c.durationMs - 1, 0))
      const from = { x: a.x, y: a.y }
      const to = { x: b.x, y: b.y }
      return {
        id: c.id,
        kind: c.kind,
        from,
        to,
        pathLen: sampleFilmPath(from, to, c.controlPoints).totalLen,
        ...(c.controlPoints != null && { controlPoints: c.controlPoints }),
      }
    })
  }, [sampler, plan, planIndex])

  const previewPose = useMemo(() => {
    if (!sampler || planIndex < 0) return null
    const s = sampler.evaluatePlanLocal(planIndex, playheadMs)
    return { x: s.x, y: s.y, scaleMul: s.scaleMul, flip: s.flip }
  }, [sampler, planIndex, playheadMs])

  // --- Lecture ÉDITEUR (Espace) : playhead animé + sons du plan via le scheduler ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      e.preventDefault()
      setEditorPlaying(p => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Le plan actif change ou est édité → on stoppe la lecture (les sons re-partiraient faux).
  useEffect(() => { setEditorPlaying(false) }, [activePlanId])

  const editorPlayFilmRef = useRef<{ film: FilmT; planIndex: number; fromMs: number } | null>(null)
  useEffect(() => {
    if (!editorPlaying) return
    if (!film || !plan || planIndex < 0) { setEditorPlaying(false); return }
    editorPlayFilmRef.current = {
      film,
      planIndex,
      fromMs: playheadMs >= plan.timeline.durationMs - 20 ? 0 : playheadMs,
    }
    const ctx = editorPlayFilmRef.current
    const planStartMs = ctx.film.plans.map((_, i) => (i === ctx.planIndex ? 0 : Number.NaN))
    const durationMs = ctx.film.plans[ctx.planIndex].timeline.durationMs
    const sched = new FilmAudioScheduler(ctx.film, planStartMs, durationMs)
    let disposed = false
    let raf = 0
    sched.ready.then(async () => {
      if (disposed) return
      await sched.unlock()
      sched.start(ctx.fromMs)
      const tick = () => {
        if (disposed) return
        const t = sched.currentTimeMs()
        if (t >= durationMs) {
          setPlayheadMs(durationMs)
          setEditorPlaying(false)
          return
        }
        setPlayheadMs(t)
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    })
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      sched.stop()
      sched.dispose()
    }
    // Volontairement PAS de dep sur film/plan : les éditions pendant la lecture
    // ne re-planifient pas l'audio (rejouer pour les entendre).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorPlaying])

  // --- Patchers (toute mutation de clips repasse par resolveSoundAnchors) ---
  const patchPlanT = useCallback((planId: string, partial: Partial<FilmTimelinePlan>) => {
    setFilm(prev => prev
      ? { ...prev, plans: prev.plans.map(pl => pl.id === planId ? { ...pl, ...partial } : pl) }
      : prev)
  }, [])

  /** 🔒 Vitesse verrouillée : après une mutation géométrique, les clips lockés
   *  retrouvent durationMs = longueur du chemin ÷ vitesse. Les positions des
   *  endpoints ne dépendent pas des durées → une seule passe suffit. */
  const applyLockedSpeeds = useCallback((f: FilmT): FilmT => {
    const anyLocked = f.plans.some(pl => pl.timeline.motion.some(c => c.lockedSpeedPxPerSec != null && c.kind !== 'appear'))
    if (!anyLocked) return f
    const smp = new FilmTimelineSampler(f, project.animations)
    let changed = false
    const plans = f.plans.map((pl, pi) => {
      const motion = pl.timeline.motion.map(c => {
        if (c.lockedSpeedPxPerSec == null || c.kind === 'appear') return c
        const a = smp.evaluatePlanLocal(pi, c.startMs + Math.min(1, c.durationMs))
        const b = smp.evaluatePlanLocal(pi, c.startMs + Math.max(c.durationMs - 1, 0))
        const len = sampleFilmPath({ x: a.x, y: a.y }, { x: b.x, y: b.y }, c.controlPoints).totalLen
        const dur = Math.max(100, Math.round((len / Math.max(1, c.lockedSpeedPxPerSec)) * 1000))
        if (dur === c.durationMs) return c
        changed = true
        return { ...c, durationMs: dur }
      })
      return motion === pl.timeline.motion ? pl : { ...pl, timeline: resolveSoundAnchors({ ...pl.timeline, motion }) }
    })
    return changed ? { ...f, plans } : f
  }, [project.animations])

  const patchTimeline = useCallback((planId: string, mut: (tl: FilmPlanTimeline) => FilmPlanTimeline) => {
    setFilm(prev => {
      if (!prev) return prev
      const next = {
        ...prev,
        plans: prev.plans.map(pl => {
          if (pl.id !== planId) return pl
          let tl = mut(pl.timeline)
          // Le plan s'étend automatiquement pour contenir ses clips.
          const contentEnd = timelineContentEndMs(tl)
          if (contentEnd > tl.durationMs) tl = { ...tl, durationMs: contentEnd }
          return { ...pl, timeline: resolveSoundAnchors(tl) }
        }),
      }
      return applyLockedSpeeds(next)
    })
  }, [applyLockedSpeeds])

  const updateFilm = useCallback((partial: Partial<FilmT>) => {
    setFilm(prev => prev ? { ...prev, ...partial } : prev)
  }, [])

  const onFilmSoundImported = useCallback((soundId: string) => {
    pendingSoundHintsRef.current.push({ filmSoundId: soundId })
  }, [])
  const onFilmSoundDeleted = useCallback((soundId: string) => {
    pendingSoundHintsRef.current.push({ deleteFilmSoundId: soundId })
  }, [])

  // --- Clips : mutations depuis la timeline / l'inspecteur ---
  const patchClip = useCallback((sel: NonNullable<TimelineSelection>, partial: { startMs?: number; durationMs?: number }) => {
    if (!plan) return
    patchTimeline(plan.id, tl => {
      if (sel.kind === 'motion') return { ...tl, motion: tl.motion.map(c => c.id === sel.id ? { ...c, ...partial } : c) }
      if (sel.kind === 'anim') return { ...tl, anim: tl.anim.map(c => c.id === sel.id ? { ...c, ...partial } : c) }
      return {
        ...tl,
        soundTracks: tl.soundTracks.map((tr, i) => i === sel.trackIndex
          ? tr.map(c => {
              if (c.id !== sel.id) return c
              // Clip ancré ⚓ : déplacer le clip édite l'OFFSET (l'ancrage est conservé).
              if (partial.startMs != null && c.anchor != null) {
                const delta = partial.startMs - c.startMs
                return { ...c, ...partial, anchor: { ...c.anchor, offsetMs: c.anchor.offsetMs + delta } }
              }
              return { ...c, ...partial }
            })
          : tr),
      }
    })
  }, [plan, patchTimeline])

  const removeClip = useCallback((sel: NonNullable<TimelineSelection>) => {
    if (!plan) return
    patchTimeline(plan.id, tl => {
      if (sel.kind === 'motion') return { ...tl, motion: tl.motion.filter(c => c.id !== sel.id) }
      if (sel.kind === 'anim') return { ...tl, anim: tl.anim.filter(c => c.id !== sel.id) }
      return { ...tl, soundTracks: tl.soundTracks.map((tr, i) => i === sel.trackIndex ? tr.filter(c => c.id !== sel.id) : tr) }
    })
    setSelection(cur => (cur && cur.kind === sel.kind && cur.id === sel.id ? null : cur))
  }, [plan, patchTimeline])

  const patchMotion = useCallback((id: string, partial: Partial<FilmMotionClip>) => {
    if (!plan) return
    patchTimeline(plan.id, tl => ({ ...tl, motion: tl.motion.map(c => c.id === id ? { ...c, ...partial } : c) }))
  }, [plan, patchTimeline])
  const patchAnim = useCallback((id: string, partial: Partial<FilmAnimClip>) => {
    if (!plan) return
    patchTimeline(plan.id, tl => ({ ...tl, anim: tl.anim.map(c => c.id === id ? { ...c, ...partial } : c) }))
  }, [plan, patchTimeline])
  const setMotionCurve = useCallback((id: string, count: 0 | 1 | 2) => {
    if (!plan) return
    const geom = motionGeom.find(g => g.id === id)
    patchTimeline(plan.id, tl => ({
      ...tl,
      motion: tl.motion.map(c => c.id === id
        ? { ...c, controlPoints: count === 0 || !geom ? undefined : defaultControlPoints(geom.from, geom.to, count) }
        : c),
    }))
  }, [plan, patchTimeline, motionGeom])

  const patchSound = useCallback((trackIndex: number, id: string, partial: Partial<FilmSoundClip>) => {
    if (!plan) return
    patchTimeline(plan.id, tl => ({
      ...tl,
      soundTracks: tl.soundTracks.map((tr, i) => i === trackIndex ? tr.map(c => c.id === id ? { ...c, ...partial } : c) : tr),
    }))
  }, [plan, patchTimeline])

  // --- Ajouts de clips ---
  const freeSlotStart = (clips: { startMs: number; durationMs: number }[], atMs: number): number => {
    // Décale au bord du clip suivant si atMs tombe dans un clip existant.
    for (const c of clips) {
      if (atMs >= c.startMs && atMs < c.startMs + c.durationMs) return c.startMs + c.durationMs
    }
    return atMs
  }

  const addMotionClip = (kind: 'travel' | 'appear') => {
    if (!film || !plan) return
    const wp = plan.timeline.waypoints.find(w => w.id === selectedWaypointId)
      ?? plan.timeline.waypoints[plan.timeline.waypoints.length - 1]
    if (!wp) {
      window.alert('Posez d’abord un point sur le canvas (clic sur le décor).')
      return
    }
    const start = freeSlotStart(plan.timeline.motion, Math.round(playheadMs))
    const dur = kind === 'appear' ? 0 : 2000
    const id = crypto.randomUUID()
    patchTimeline(plan.id, tl => ({
      ...tl,
      motion: [...tl.motion, { id, startMs: start, durationMs: dur, kind, to: { kind: 'waypoint', id: wp.id } }],
      // Confort : un trajet ajoute son clip d'animation de déplacement par défaut.
      anim: kind === 'travel' && film.moveAnimationId
        ? [...tl.anim, { id: crypto.randomUUID(), startMs: start, durationMs: dur, animationId: film.moveAnimationId, fillMode: 'loop' as const }]
        : tl.anim,
    }))
    setSelection({ kind: 'motion', id })
  }

  const addAnimClip = () => {
    if (!film || !plan) return
    const animId = film.moveAnimationId ?? readyAnimations[0]?.id
    if (!animId) return
    const start = freeSlotStart(plan.timeline.anim, Math.round(playheadMs))
    const id = crypto.randomUUID()
    patchTimeline(plan.id, tl => ({
      ...tl,
      anim: [...tl.anim, { id, startMs: start, durationMs: 2000, animationId: animId, fillMode: 'loop' as const }],
    }))
    setSelection({ kind: 'anim', id })
  }

  // Double-clic sur une piste son → import d'un fichier → clip posé à cet instant.
  const addSoundAt = (trackIndex: number, atMs: number) => {
    pendingSoundTargetRef.current = { trackIndex, atMs }
    soundImportRef.current?.click()
  }
  const handleSoundFile = async (file: File) => {
    const target = pendingSoundTargetRef.current
    if (!film || !plan || !target) return
    pendingSoundTargetRef.current = null
    const soundId = crypto.randomUUID()
    const durMs = Math.max(200, Math.round(await getAudioDurationMs(file)))
    updateFilm({ sounds: [...film.sounds, { id: soundId, name: file.name, blob: file }] })
    onFilmSoundImported(soundId)
    const clipId = crypto.randomUUID()
    patchTimeline(plan.id, tl => ({
      ...tl,
      soundTracks: tl.soundTracks.map((tr, i) => i === target.trackIndex
        ? [...tr, { id: clipId, startMs: target.atMs, durationMs: durMs, soundId }]
        : tr),
    }))
    setSelection({ kind: 'sound', id: clipId, trackIndex: target.trackIndex })
  }

  const addSoundTrack = () => {
    if (!plan) return
    patchTimeline(plan.id, tl => ({ ...tl, soundTracks: [...tl.soundTracks, []] }))
  }

  // --- Waypoints ---
  const addWaypoint = (pos: Point2D) => {
    if (!plan) return
    const wp: FilmWaypoint = {
      id: crypto.randomUUID(),
      x: pos.x,
      y: pos.y,
      scale: plan.timeline.waypoints[plan.timeline.waypoints.length - 1]?.scale ?? 1,
    }
    patchTimeline(plan.id, tl => ({ ...tl, waypoints: [...tl.waypoints, wp] }))
    setSelectedWaypointId(wp.id)
    setSelection(null)
  }
  const removeWaypoint = (id: string) => {
    if (!plan) return
    const idx = plan.timeline.waypoints.findIndex(w => w.id === id)
    const used = plan.timeline.motion.some(c =>
      (c.to.kind === 'waypoint' && c.to.id === id) || (c.from?.kind === 'waypoint' && c.from.id === id))
    if (used) {
      window.alert(`Le point ${idx + 1} est utilisé par un clip de déplacement — supprimez d'abord le clip.`)
      return
    }
    if (!window.confirm(`Supprimer le point ${idx + 1} ?`)) return
    patchTimeline(plan.id, tl => ({ ...tl, waypoints: tl.waypoints.filter(w => w.id !== id) }))
    if (selectedWaypointId === id) setSelectedWaypointId(null)
  }
  const patchWaypoint = (id: string, partial: Partial<FilmWaypoint>) => {
    if (!plan) return
    patchTimeline(plan.id, tl => ({ ...tl, waypoints: tl.waypoints.map(w => w.id === id ? { ...w, ...partial } : w) }))
  }

  // --- Plans ---
  const selectPlan = (id: string) => {
    setActivePlanId(id)
    setSelection(null)
    setSelectedWaypointId(null)
    setPlayheadMs(0)
  }
  const addPlan = () => {
    if (!film || !plan) return
    const newPlan: FilmTimelinePlan = {
      id: crypto.randomUUID(),
      backdrop: plan.backdrop ? { ...plan.backdrop } : null,
      overlay: plan.overlay ? { ...plan.overlay } : null,
      cameraX: plan.backdrop ? Math.round(plan.backdrop.width / 2) : 0,
      timeline: { durationMs: 5000, waypoints: [], motion: [], anim: [], soundTracks: [[]] },
    }
    updateFilm({ plans: [...plans, newPlan] })
    selectPlan(newPlan.id)
  }
  const movePlan = (id: string, dir: -1 | 1) => {
    const i = plans.findIndex(pl => pl.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= plans.length) return
    const next = [...plans]
    ;[next[i], next[j]] = [next[j], next[i]]
    updateFilm({ plans: next })
  }
  const removePlan = (id: string) => {
    if (!film || plans.length <= 1) return
    const pl = plans.find(x => x.id === id)
    if (!pl) return
    if (!window.confirm(`Supprimer le plan « ${pl.name ?? `Plan ${plans.indexOf(pl) + 1}`} » et tous ses clips ?`)) return
    // Les sons de la bibliothèque restent (partagés entre plans).
    updateFilm({ plans: plans.filter(x => x.id !== id) })
    if (activePlanId === id) selectPlan(plans.find(x => x.id !== id)!.id)
  }
  const importDecor = async (file: File, kind: 'backdrop' | 'overlay') => {
    if (!plan) return
    if (kind === 'backdrop') {
      const backdrop = await fileToDecorLayer(file, 'backdrop')
      patchPlanT(plan.id, { backdrop, cameraX: Math.round(backdrop.width / 2) })
    } else {
      const overlay = await fileToDecorLayer(file, 'overlay')
      patchPlanT(plan.id, { overlay })
    }
  }

  // --- Création ---
  const createFilm = useCallback(() => {
    setFilm({
      version: 4,
      plans: [{
        id: crypto.randomUUID(),
        backdrop: null,
        overlay: null,
        cameraX: 0,
        timeline: { durationMs: 5000, waypoints: [], motion: [], anim: [], soundTracks: [[]] },
      }],
      character: {
        scale: 1,
        facing: project.scene?.characterFacing ?? 'right',
        originU: project.scene?.characterOriginU ?? 0.5,
        originV: project.scene?.characterOriginV ?? 1.0,
      },
      sounds: [],
      moveSpeedPxPerSec: 260,
    })
  }, [project.scene])

  // --- RESET : repartir de zéro (utile sur une copie dupliquée) ---
  const handleReset = useCallback(() => {
    if (!film) return
    const ok = window.confirm(
      'Repartir de ZÉRO ?\n\n'
      + 'Tous les plans, clips, points, sons et la musique de ce film seront supprimés '
      + '(les réglages du dessin — sens du regard, point d\'ancrage — sont conservés).\n\n'
      + 'Le nettoyage ne devient définitif qu\'à la SAUVEGARDE.',
    )
    if (!ok) return
    // Programme la suppression Storage des décors + sons actuels (appliquée à la sauvegarde).
    for (const pl of film.plans) {
      if (pl.backdrop) pendingSoundHintsRef.current.push({ deleteFilmPlanBackdrop: pl.id })
      if (pl.overlay) pendingSoundHintsRef.current.push({ deleteFilmPlanOverlay: pl.id })
    }
    for (const snd of film.sounds) pendingSoundHintsRef.current.push({ deleteFilmSoundId: snd.id })
    if (film.music) pendingSoundHintsRef.current.push({ deleteFilmSoundId: film.music.id })
    setFilm({
      version: 4,
      plans: [{
        id: crypto.randomUUID(),
        backdrop: null,
        overlay: null,
        cameraX: 0,
        timeline: { durationMs: 5000, waypoints: [], motion: [], anim: [], soundTracks: [[]] },
      }],
      character: { ...film.character },
      sounds: [],
      ...(film.moveAnimationId != null && { moveAnimationId: film.moveAnimationId }),
      moveSpeedPxPerSec: film.moveSpeedPxPerSec,
      ...(film.idleSpeedMul != null && { idleSpeedMul: film.idleSpeedMul }),
    })
    setActivePlanId(null)
    setSelection(null)
    setSelectedWaypointId(null)
    setPlayheadMs(0)
    setEditorPlaying(false)
  }, [film])

  // --- Sauvegarde : diff décors + sons en attente ; 1ʳᵉ sauvegarde = upload complet ---
  const handleSave = useCallback(async () => {
    if (!film) return
    setSaving(true)
    try {
      const hints: UploadHint[] = [...pendingSoundHintsRef.current]
      const fullUpload = project.filmT == null
      const oldPlans = new Map((fullUpload ? [] : project.filmT?.plans ?? []).map(pl => [pl.id, pl]))
      const hintedSoundIds = new Set(hints.flatMap(h => typeof h === 'object' && 'filmSoundId' in h ? [h.filmSoundId] : []))
      for (const pl of film.plans) {
        const old = oldPlans.get(pl.id)
        const curBd = pl.backdrop?.videoBlob ?? pl.backdrop?.imageBlob ?? null
        const oldBd = old?.backdrop?.videoBlob ?? old?.backdrop?.imageBlob ?? null
        if (curBd && curBd !== oldBd) hints.push({ filmPlanBackdrop: pl.id })
        else if (!pl.backdrop && old?.backdrop) hints.push({ deleteFilmPlanBackdrop: pl.id })
        const curOv = pl.overlay?.videoBlob ?? pl.overlay?.imageBlob ?? null
        const oldOv = old?.overlay?.videoBlob ?? old?.overlay?.imageBlob ?? null
        if (curOv && curOv !== oldOv) hints.push({ filmPlanOverlay: pl.id })
        else if (!pl.overlay && old?.overlay) hints.push({ deleteFilmPlanOverlay: pl.id })
      }
      for (const [planId, old] of oldPlans) {
        if (film.plans.some(pl => pl.id === planId)) continue
        if (old.backdrop) hints.push({ deleteFilmPlanBackdrop: planId })
        if (old.overlay) hints.push({ deleteFilmPlanOverlay: planId })
      }
      if (fullUpload) {
        // Conversion v3 / premier enregistrement : tous les sons de la bibliothèque.
        if (film.music?.blob && !hintedSoundIds.has(film.music.id)) hints.push({ filmSoundId: film.music.id })
        for (const snd of film.sounds) {
          if (snd.blob && !hintedSoundIds.has(snd.id)) hints.push({ filmSoundId: snd.id })
        }
      }
      const updated: Project = { ...project, filmT: film, filmNeedsFullUpload: undefined }
      await onSave(updated, hints.length > 0 ? hints : undefined)
      pendingSoundHintsRef.current = []
    } finally {
      setSaving(false)
    }
  }, [film, project, onSave])

  // --- Preview (film complet ou un plan) ---
  const openPreview = useCallback(async (previewFilm: FilmT) => {
    if (!project.originalImageBlob) return
    const img = new Image()
    const url = URL.createObjectURL(project.originalImageBlob)
    img.src = url
    await new Promise<void>((resolve) => {
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        URL.revokeObjectURL(url)
        previewProjectRef.current = { ...project, filmT: previewFilm, scene: buildFilmTScene(previewFilm) }
        setPreviewCanvas(canvas)
        setPreviewing(true)
        resolve()
      }
    })
  }, [project])
  const handlePreview = useCallback(() => { if (film) void openPreview(film) }, [film, openPreview])
  const handlePreviewPlan = useCallback((planId: string) => {
    if (!film) return
    const pl = film.plans.find(x => x.id === planId)
    if (!pl || pl.backdrop == null) return
    void openPreview({ ...film, plans: [{ ...pl, transitionToNext: undefined }] })
  }, [film, openPreview])
  const handleClosePreview = useCallback(() => {
    setPreviewing(false)
    setPreviewCanvas(null)
    previewProjectRef.current = null
  }, [])

  // --- Rendus ---
  if (converting) {
    return (
      <div className="scene-editor">
        <div className="scene-editor-header"><h3>🎬 Film</h3></div>
        <div style={{ padding: '48px 24px', textAlign: 'center', opacity: 0.7 }}>Conversion du film vers la timeline…</div>
      </div>
    )
  }

  if (!film) {
    return (
      <div className="scene-editor">
        <div className="scene-editor-header"><h3>🎬 Film</h3></div>
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)',
          padding: '56px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center',
        }}>
          <span style={{ fontSize: 14, opacity: 0.75 }}>
            Ce coloriage n'a pas encore de film. Un film = des plans (décor + timeline
            de déplacements, d'animations et de sons) joués automatiquement après le scan.
          </span>
          <button className="btn-primary" onClick={createFilm}>Créer le film</button>
        </div>
      </div>
    )
  }

  const selectedWp = plan?.timeline.waypoints.find(w => w.id === selectedWaypointId) ?? null
  const selectedMotionClip = selection?.kind === 'motion'
    ? plan?.timeline.motion.find(c => c.id === selection.id) ?? null
    : null

  return (
    <div className="scene-editor">
      <input
        ref={soundImportRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void handleSoundFile(file)
        }}
      />

      {/* Header */}
      <div className="scene-editor-header">
        <h3>🎬 Film <span style={{ fontSize: 11, opacity: 0.55, fontWeight: 400 }}>timeline</span></h3>
        <div className="scene-editor-header-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={handlePreview}
            disabled={saving || !canPreview}
            title={canPreview ? 'Jouer le film avec l’image originale (sans scan)' : 'Il faut une animation calculée, une image et au moins un plan avec décor + clips'}
          >▶ Prévisualiser</button>
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Sauvegarde...' : 'Sauvegarder'}
          </button>
          <button
            className="btn-ghost btn-sm btn-danger"
            onClick={handleReset}
            disabled={saving}
            title="Vider le film (plans, clips, sons, musique) pour repartir de zéro — définitif à la sauvegarde"
          >Reset</button>
        </div>
      </div>

      {/* Bandeau des plans + décor du plan actif */}
      <div className="scene-editor-section-card">
        <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
          {plans.map((pl, i) => {
            const active = pl.id === plan?.id
            return (
              <div key={pl.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div
                  onClick={() => selectPlan(pl.id)}
                  style={{
                    border: active ? '2px solid var(--color-primary, #42a5f5)' : '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)', padding: 8, minWidth: 130, cursor: 'pointer',
                    background: active ? 'rgba(66,165,245,0.08)' : 'transparent',
                    display: 'flex', flexDirection: 'column', gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 12 }}>🎬 {i + 1}</span>
                    <input
                      value={pl.name ?? ''}
                      placeholder={`Plan ${i + 1}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patchPlanT(pl.id, e.target.value ? { name: e.target.value } : { name: undefined })}
                      style={{ width: 76, fontSize: 12, border: 'none', background: 'transparent', borderBottom: '1px dashed var(--border)' }}
                    />
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.7 }}>
                    {formatMs(pl.timeline.durationMs)}
                    {pl.backdrop == null && <span style={{ color: 'var(--color-warning, #ffa726)' }}> · sans décor</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    <button className="btn-icon btn-sm" onClick={() => handlePreviewPlan(pl.id)} disabled={pl.backdrop == null} title="Prévisualiser CE plan uniquement">▶</button>
                    <button className="btn-icon btn-sm" onClick={() => movePlan(pl.id, -1)} disabled={i === 0} title="Plan plus tôt">◀</button>
                    <button className="btn-icon btn-sm" onClick={() => movePlan(pl.id, +1)} disabled={i === plans.length - 1} title="Plan plus tard">▶</button>
                    <button className="btn-icon btn-sm btn-danger" onClick={() => removePlan(pl.id)} disabled={plans.length <= 1} title="Supprimer le plan">&times;</button>
                  </div>
                </div>
                {i < plans.length - 1 && (
                  <select
                    value={transitionToKey(pl.transitionToNext)}
                    onChange={(e) => patchPlanT(pl.id, { transitionToNext: transitionFromKey(e.target.value) })}
                    style={{ fontSize: 11 }}
                    title="Transition vers le plan suivant"
                  >
                    <option value="cut">Cut</option>
                    <option value="fadeBlack">Fondu noir</option>
                    <option value="crossfade">Fondu enchaîné</option>
                    <option value="wipe-left">Volet ←</option>
                    <option value="wipe-right">Volet →</option>
                    <option value="wipe-up">Volet ↑</option>
                    <option value="wipe-down">Volet ↓</option>
                    <option value="iris">Iris</option>
                  </select>
                )}
              </div>
            )
          })}
          <button className="btn-secondary btn-sm" onClick={addPlan} style={{ alignSelf: 'center', whiteSpace: 'nowrap' }}>+ Plan</button>
        </div>
        {plan && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Décor du plan :</span>
            <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              {plan.backdrop ? 'Changer l’arrière-plan' : 'Importer l’arrière-plan'}
              <input
                type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) void importDecor(file, 'backdrop')
                }}
              />
            </label>
            {plan.backdrop && (
              <>
                <span className="scene-editor-dimensions">{plan.backdrop.width}×{plan.backdrop.height}{plan.backdrop.videoBlob ? ' (vidéo)' : ''}</span>
                <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }} title="Calque devant le personnage (PNG transparent ou vidéo chroma key)">
                  {plan.overlay ? 'Changer l’avant-plan' : '+ Avant-plan'}
                  <input
                    type="file" accept="image/png,image/webp,video/mp4,video/webm" style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      e.target.value = ''
                      if (file) void importDecor(file, 'overlay')
                    }}
                  />
                </label>
                {plan.overlay && (
                  <button className="btn-icon btn-sm btn-danger" onClick={() => patchPlanT(plan.id, { overlay: null })} title="Retirer l’avant-plan">FG &times;</button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Canvas spatial + inspecteur */}
      {plan && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 520px', minWidth: 380 }}>
            <span style={{ fontSize: 12, opacity: 0.7, display: 'block', marginBottom: 6 }}>
              <strong>Clic</strong> : poser un point · <strong>Glisser</strong> : déplacer (point, CP, caméra) ·
              <strong> Clic droit</strong> : supprimer. La zone sombre = hors décor (autorisé).
              Glissez le playhead de la timeline pour voir le perso à cet instant.
            </span>
            <FilmCanvasT
              plan={plan}
              selectedWaypointId={selectedWaypointId}
              onSelectWaypoint={(id) => { setSelectedWaypointId(id); if (id) setSelection(null) }}
              onAddWaypoint={addWaypoint}
              onRemoveWaypoint={removeWaypoint}
              onPatchWaypoint={patchWaypoint}
              onPatchPlan={(partial) => patchPlanT(plan.id, partial)}
              selectedMotionClip={selectedMotionClip}
              onPatchMotionClip={patchMotion}
              motionGeom={motionGeom}
              previewPose={previewPose}
              characterImageUrl={charImageUrl}
              characterImageSize={charImageSize}
              characterScale={film.character.scale}
              characterOriginU={film.character.originU}
              characterOriginV={film.character.originV}
              characterFacing={film.character.facing}
            />
          </div>
          <div style={{ flex: '0 1 300px', minWidth: 260, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
            {selection && plan ? (
              <ClipInspector
                timeline={plan.timeline}
                selection={selection}
                animations={readyAnimations}
                sounds={film.sounds}
                onPatchMotion={patchMotion}
                onSetMotionCurve={setMotionCurve}
                onPatchAnim={patchAnim}
                onPatchSound={patchSound}
                onRemove={() => removeClip(selection)}
                anchorTargets={[
                  ...plan.timeline.motion.map((c, i) => ({
                    id: c.id,
                    label: c.kind === 'appear' ? `✨ Apparition ${i + 1}` : c.kind === 'exit' ? `Sortie ${i + 1}` : `Trajet ${i + 1}`,
                  })),
                  ...plan.timeline.anim.map((c, i) => ({
                    id: c.id,
                    label: `Anim ${i + 1} — ${readyAnimations.find(a => a.id === c.animationId)?.name ?? '?'}`,
                  })),
                ]}
                motionPathLen={(id) => motionGeom.find(g => g.id === id)?.pathLen ?? 0}
              />
            ) : selectedWp ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>
                    Point {plan.timeline.waypoints.indexOf(selectedWp) + 1}
                  </span>
                  <span style={{ fontSize: 11, opacity: 0.6 }}>({selectedWp.x}, {selectedWp.y})</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn-icon btn-sm btn-danger" onClick={() => removeWaypoint(selectedWp.id)} title="Supprimer le point">&times;</button>
                </div>
                <div className="scene-editor-field">
                  <label style={{ fontSize: 11 }}>Échelle : {selectedWp.scale.toFixed(2)}×</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range" min={0.05} max={4} step={0.05}
                      value={Math.min(4, selectedWp.scale)}
                      onChange={(e) => patchWaypoint(selectedWp.id, { scale: parseFloat(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number" min={0.05} max={30} step={0.05}
                      value={selectedWp.scale}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (Number.isFinite(v) && v > 0) patchWaypoint(selectedWp.id, { scale: Math.min(30, v) })
                      }}
                      style={{ width: 68 }}
                      title="Échelle libre jusqu'à 30× (perso au premier plan)"
                    />
                  </div>
                </div>
                <div className="scene-editor-field" title="Regard à l'idle sur ce point. Auto = sens du dernier trajet.">
                  <label style={{ fontSize: 11 }}>Regard au point</label>
                  <div className="scene-config-panel-type-toggle">
                    <button className={`btn-sm ${selectedWp.facing == null ? 'btn-primary' : 'btn-secondary'}`} onClick={() => patchWaypoint(selectedWp.id, { facing: undefined })}>Auto</button>
                    <button className={`btn-sm ${selectedWp.facing === 'left' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => patchWaypoint(selectedWp.id, { facing: 'left' })}>◀ Gauche</button>
                    <button className={`btn-sm ${selectedWp.facing === 'right' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => patchWaypoint(selectedWp.id, { facing: 'right' })}>Droite ▶</button>
                  </div>
                </div>
              </div>
            ) : (
              <span style={{ fontSize: 12, opacity: 0.6 }}>
                Sélectionnez un clip de la timeline ou un point du canvas pour l'éditer.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Timeline du plan actif */}
      {plan && (
        <div className="scene-editor-section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <h4 className="scene-editor-section-title" style={{ margin: 0 }}>Timeline du plan {planIndex + 1}</h4>
            <div style={{ flex: 1 }} />
            <button className="btn-ghost btn-sm" onClick={() => addMotionClip('travel')} title="Trajet vers le point sélectionné, posé au playhead">+ Trajet</button>
            <button className="btn-ghost btn-sm" onClick={() => addMotionClip('appear')} title="Apparition directe sur le point sélectionné">+ ✨ Apparition</button>
            <button className="btn-ghost btn-sm" onClick={addAnimClip} title="Clip d'animation du corps au playhead">+ Anim</button>
            <span style={{ fontSize: 10, opacity: 0.55 }}>Espace = lecture avec sons · Double-clic sur une piste son = poser un son · Ctrl+molette = zoom · Alt = sans snap</span>
          </div>
          <TimelineEditor
            timeline={plan.timeline}
            animations={readyAnimations}
            sounds={film.sounds}
            selection={selection}
            onSelect={(sel) => { setSelection(sel); if (sel) setSelectedWaypointId(null) }}
            onPatchClip={patchClip}
            onRemoveClip={removeClip}
            onAddSoundAt={addSoundAt}
            onAddSoundTrack={addSoundTrack}
            playheadMs={playheadMs}
            onScrub={(ms) => { setEditorPlaying(false); setPlayheadMs(ms) }}
            playing={editorPlaying}
          />
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <div className="scene-editor-field" style={{ maxWidth: 180 }}>
              <label style={{ fontSize: 11 }}>Durée du plan (s)</label>
              <input
                type="number" min={0.5} step={0.5}
                value={plan.timeline.durationMs / 1000}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isFinite(v) && v > 0) {
                    patchTimeline(plan.id, tl => ({ ...tl, durationMs: Math.round(v * 1000) }))
                  }
                }}
                title="Bord droit de la timeline (s'étend automatiquement avec les clips)"
              />
            </div>
          </div>
        </div>
      )}

      {/* Réglages du film */}
      <div className="scene-editor-section-card">
        <h4 className="scene-editor-section-title">Réglages du film</h4>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="scene-editor-field" title="Animation proposée par défaut pour les nouveaux clips de trajet">
            <label>Animation de déplacement (défaut)</label>
            <select
              value={film.moveAnimationId ?? ''}
              onChange={(e) => updateFilm(e.target.value ? { moveAnimationId: e.target.value } : { moveAnimationId: undefined })}
            >
              <option value="">— Aucune —</option>
              {readyAnimations.map(a => <option key={a.id} value={a.id}>{a.name} ({a.type})</option>)}
            </select>
          </div>
          <div className="scene-editor-field" title="Multiplicateur de vitesse de lecture de l'idle joué entre les clips (0.5 = 2× plus lent)">
            <label>Vitesse idle : ×{(film.idleSpeedMul ?? 1).toFixed(2)}</label>
            <input
              type="range" min={0.1} max={3} step={0.05}
              value={film.idleSpeedMul ?? 1}
              onChange={(e) => updateFilm({ idleSpeedMul: parseFloat(e.target.value) })}
            />
          </div>
          <div className="scene-editor-field" title="CALIBRATION du retournement automatique : le sens dans lequel le coloriage est DESSINÉ.">
            <label>Le dessin regarde vers</label>
            <div className="scene-config-panel-type-toggle">
              <button className={`btn-sm ${film.character.facing === 'left' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateFilm({ character: { ...film.character, facing: 'left' } })}>← Gauche</button>
              <button className={`btn-sm ${film.character.facing === 'right' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateFilm({ character: { ...film.character, facing: 'right' } })}>Droite →</button>
            </div>
          </div>
        </div>
      </div>

      {/* Ancrage (rarement modifié) */}
      <div className="scene-editor-section-card">
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Point d'ancrage du personnage (défaut : les pieds)
          </summary>
          <div style={{ marginTop: 10 }}>
            <CharacterOriginEditor
              imageUrl={charImageUrl}
              originU={film.character.originU}
              originV={film.character.originV}
              onChange={(u, v) => updateFilm({ character: { ...film.character, originU: u, originV: v } })}
            />
          </div>
        </details>
      </div>

      {/* Musique du film */}
      <div className="scene-editor-section-card">
        <h4 className="scene-editor-section-title">Musique du film (boucle continue)</h4>
        {film.music ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{film.music.name}</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={film.music.volume ?? 1}
              onChange={(e) => film.music && updateFilm({ music: { ...film.music, volume: parseFloat(e.target.value) } })}
              style={{ width: 90 }}
              title={`Volume : ${Math.round((film.music.volume ?? 1) * 100)}%`}
            />
            <button
              className="btn-icon btn-sm btn-danger"
              onClick={() => {
                if (film.music) onFilmSoundDeleted(film.music.id)
                updateFilm({ music: undefined })
              }}
              title="Retirer la musique"
            >&times;</button>
          </div>
        ) : (
          <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
            + Importer la musique
            <input
              type="file" accept="audio/*" style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                const id = crypto.randomUUID()
                updateFilm({ music: { id, name: file.name, blob: file } })
                onFilmSoundImported(id)
              }}
            />
          </label>
        )}
      </div>

      {/* Durée totale */}
      {sampler && sampler.totalMs > 0 && (
        <div style={{ fontSize: 12, opacity: 0.7, textAlign: 'right' }}>
          Durée totale du film : <strong>{formatMs(sampler.totalMs)}</strong>
        </div>
      )}

      <PreviewModalShell open={previewing && !!previewCanvas && !!previewProjectRef.current} onClose={handleClosePreview}>
        {previewCanvas && previewProjectRef.current && (
          <ScenePlayer
            project={previewProjectRef.current}
            scanCanvas={previewCanvas}
            onClose={handleClosePreview}
            modal
          />
        )}
      </PreviewModalShell>
    </div>
  )
}
