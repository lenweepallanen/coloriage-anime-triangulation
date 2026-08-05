import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { animationHasFrames, filmIsPlayable, type Film, type FilmPlan, type FilmPoint, type Point2D, type Project } from '../../../types/project'
import type { UploadHint } from '../../../db/projectsStore'
import { buildFilmScene, filmToSceneFilm } from '../../../utils/filmScene'
import { estimateFilmDurations, type FilmDurationEstimate } from '../../../utils/sceneActionDuration'
import { buildFilmSegments } from '../../../utils/filmDirector'
import ScenePlayer from '../../scan/ScenePlayer'
import { PreviewModalShell } from '../PreviewModal'
import CharacterOriginEditor from '../CharacterOriginEditor'
import FilmStoryboard from './FilmStoryboard'
import FilmCanvas from './FilmCanvas'
import FilmPointPanel from './FilmPointPanel'
import FilmTravelFields from './FilmTravelFields'
import { fileToDecorLayer, FILM_COLORS, formatMs, planGeometry, transitionFromKey } from './filmEditorShared'

/**
 * Éditeur de FILM — l'entité de niveau projet, totalement indépendante de la
 * scène interactive. Structure : header (preview/save) → storyboard des plans →
 * canvas du plan actif → panneau du point (échelle, regard, trajets, action) →
 * réglages du film → musique → règle temporelle. Tout se règle AU POINT ; les
 * seuls réglages « image » (sens du dessin, origine) sont repliés dans Réglages.
 */

/** L'échelle se règle PAR POINT : l'ancienne « échelle de base » du perso est
 *  repliée dans les échelles des points (rendu identique), puis figée à 1. */
function normalizeFilmScale(film: Film | null): Film | null {
  if (!film || film.character.scale === 1) return film
  const k = film.character.scale
  const round2 = (x: number) => Math.round(x * 100) / 100
  return {
    ...film,
    character: { ...film.character, scale: 1 },
    plans: film.plans.map(pl => ({
      ...pl,
      points: pl.points.map(p => ({
        ...p,
        scale: round2(p.scale * k),
        ...(p.departure != null && p.departure.target.kind === 'custom' && p.departure.target.scale != null
          ? { departure: { ...p.departure, target: { ...p.departure.target, scale: round2(p.departure.target.scale * k) } } }
          : {}),
      })),
    })),
  }
}
export default function FilmEditor({ project, onSave }: {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}) {
  const [film, setFilm] = useState<Film | null>(normalizeFilmScale(project.film))
  const [activePlanId, setActivePlanId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [estimate, setEstimate] = useState<FilmDurationEstimate | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewCanvas, setPreviewCanvas] = useState<HTMLCanvasElement | null>(null)
  const previewProjectRef = useRef<Project | null>(null)
  const pendingSoundHintsRef = useRef<UploadHint[]>([])

  useEffect(() => {
    setFilm(normalizeFilmScale(project.film))
  }, [project.film])

  const plans = film?.plans ?? []
  const plan = plans.find(pl => pl.id === activePlanId) ?? plans[0] ?? null
  const points = plan?.points ?? []
  const selected = points.find(p => p.id === selectedId) ?? null
  const selectedIndex = selected ? points.findIndex(p => p.id === selected.id) : -1
  const readyAnimations = project.animations.filter(a => animationHasFrames(a))
  const canPreview = project.originalImageBlob != null && readyAnimations.length > 0 && filmIsPlayable(film)

  // Image du coloriage (silhouette canvas + éditeur d'origine).
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

  // Règle temporelle : recalcul debounced sur la pseudo-scène du film.
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!film || !film.plans.some(pl => pl.points.length > 0)) {
        if (!cancelled) setEstimate(null)
        return
      }
      estimateFilmDurations(filmToSceneFilm(film), buildFilmScene(film), project.animations)
        .then(d => { if (!cancelled) setEstimate(d) })
        .catch(() => { if (!cancelled) setEstimate(null) })
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [film, project.animations])

  // --- Patchers ---
  const updateFilm = useCallback((partial: Partial<Film>) => {
    setFilm(prev => prev ? { ...prev, ...partial } : prev)
  }, [])

  const patchPlan = useCallback((planId: string, partial: Partial<FilmPlan>) => {
    setFilm(prev => prev
      ? { ...prev, plans: prev.plans.map(pl => pl.id === planId ? { ...pl, ...partial } : pl) }
      : prev)
  }, [])

  const patchPoint = useCallback((planId: string, pointId: string, partial: Partial<FilmPoint>) => {
    setFilm(prev => prev
      ? {
          ...prev,
          plans: prev.plans.map(pl => pl.id === planId
            ? { ...pl, points: pl.points.map(p => p.id === pointId ? { ...p, ...partial } : p) }
            : pl),
        }
      : prev)
  }, [])

  const onFilmSoundImported = useCallback((soundId: string) => {
    pendingSoundHintsRef.current.push({ filmSoundId: soundId })
  }, [])
  const onFilmSoundDeleted = useCallback((soundId: string) => {
    pendingSoundHintsRef.current.push({ deleteFilmSoundId: soundId })
  }, [])

  // --- Création du film ---
  const createFilm = useCallback(() => {
    const newFilm: Film = {
      plans: [{
        id: crypto.randomUUID(),
        backdrop: null,
        overlay: null,
        cameraX: 0,
        entrySide: 'left',
        points: [],
        ending: { kind: 'stay' },
      }],
      character: {
        scale: 1,
        // Sens du dessin : hérite de la config scène si elle existe (souvent déjà
        // calibrée) — sinon 'right'. Un sens faux = perso qui marche à reculons.
        facing: project.scene?.characterFacing ?? 'right',
        originU: project.scene?.characterOriginU ?? 0.5,
        originV: project.scene?.characterOriginV ?? 1.0,
      },
      moveSpeedPxPerSec: 260,
    }
    setFilm(newFilm)
  }, [project.scene])

  // --- Mutations plans ---
  const selectPlan = (id: string) => {
    setActivePlanId(id)
    setSelectedId(null)
  }

  const addPlan = () => {
    if (!film || !plan) return
    // Le nouveau plan démarre avec une COPIE du décor du plan actif (mêmes blobs,
    // uploadés sous le chemin du nouveau plan à la sauvegarde), remplaçable en un clic.
    const newPlan: FilmPlan = {
      id: crypto.randomUUID(),
      backdrop: plan.backdrop ? { ...plan.backdrop } : null,
      overlay: plan.overlay ? { ...plan.overlay } : null,
      cameraX: plan.backdrop ? Math.round(plan.backdrop.width / 2) : 0,
      entrySide: 'left',
      points: [],
      ending: { kind: 'stay' },
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

  const releasePointSounds = (p: FilmPoint) => {
    if (p.travel.sound) onFilmSoundDeleted(p.travel.sound.id)
    if (p.departure?.travel.sound) onFilmSoundDeleted(p.departure.travel.sound.id)
    if (p.action) {
      if (p.action.sound) onFilmSoundDeleted(p.action.sound.id)
      for (const s of p.action.steps) if (s.sound) onFilmSoundDeleted(s.sound.id)
    }
  }

  const removePlan = (id: string) => {
    if (plans.length <= 1) return
    const pl = plans.find(x => x.id === id)
    if (!pl) return
    if (!window.confirm(`Supprimer le plan « ${pl.name ?? `Plan ${plans.indexOf(pl) + 1}`} » et ses ${pl.points.length} point(s) ?`)) return
    for (const p of pl.points) releasePointSounds(p)
    if (pl.ending.kind === 'exit' && pl.ending.travel.sound) onFilmSoundDeleted(pl.ending.travel.sound.id)
    updateFilm({ plans: plans.filter(x => x.id !== id) })
    if (activePlanId === id) selectPlan(plans.find(x => x.id !== id)!.id)
  }

  const importDecor = async (file: File, kind: 'backdrop' | 'overlay') => {
    if (!plan) return
    if (kind === 'backdrop') {
      const backdrop = await fileToDecorLayer(file, 'backdrop')
      patchPlan(plan.id, { backdrop, cameraX: Math.round(backdrop.width / 2) })
    } else {
      const overlay = await fileToDecorLayer(file, 'overlay')
      patchPlan(plan.id, { overlay })
    }
  }

  // --- Mutations points ---
  const addPoint = (pos: Point2D, scale: number) => {
    if (!plan) return
    const newPoint: FilmPoint = {
      id: crypto.randomUUID(),
      x: pos.x,
      y: pos.y,
      scale,
      travel: {},
    }
    patchPlan(plan.id, { points: [...points, newPoint] })
    setSelectedId(newPoint.id)
  }

  const movePoint = (id: string, dir: -1 | 1) => {
    if (!plan) return
    const i = points.findIndex(p => p.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= points.length) return
    const next = [...points]
    ;[next[i], next[j]] = [next[j], next[i]]
    patchPlan(plan.id, { points: next })
  }

  const removePoint = (id: string) => {
    if (!plan) return
    const i = points.findIndex(x => x.id === id)
    if (i < 0) return
    const p = points[i]
    const details = [
      p.action && p.action.steps.length > 0 ? 'son action' : null,
      p.departure ? 'son trajet de sortie' : null,
    ].filter(Boolean).join(' et ')
    if (!window.confirm(`Supprimer le point ${i + 1}${details ? ` (avec ${details})` : ''} ?`)) return
    releasePointSounds(p)
    patchPlan(plan.id, { points: points.filter(x => x.id !== id) })
    if (selectedId === id) setSelectedId(null)
  }

  // --- Sauvegarde : diff des décors par plan + sons en attente ---
  const handleSave = useCallback(async () => {
    if (!film) return
    setSaving(true)
    try {
      const hints: UploadHint[] = [...pendingSoundHintsRef.current]
      const fullUpload = project.filmNeedsFullUpload === true || project.film == null
      const oldPlans = new Map((fullUpload ? [] : project.film?.plans ?? []).map(pl => [pl.id, pl]))
      const soundIds = new Set(hints.flatMap(h => typeof h === 'object' && 'filmSoundId' in h ? [h.filmSoundId] : []))
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
        // Conversion legacy / premier enregistrement : TOUS les sons du film
        // partent vers film/sounds/ (musique + trajets + actions).
        const seen = new Set<string>()
        const pushSound = (id: string, blob: Blob | null) => {
          if (!blob || seen.has(id) || soundIds.has(id)) return
          seen.add(id)
          hints.push({ filmSoundId: id })
        }
        if (film.music) pushSound(film.music.id, film.music.blob)
        for (const pl of film.plans) {
          for (const p of pl.points) {
            if (p.travel.sound) pushSound(p.travel.sound.id, p.travel.sound.blob)
            if (p.departure?.travel.sound) pushSound(p.departure.travel.sound.id, p.departure.travel.sound.blob)
            if (p.action) {
              if (p.action.sound) pushSound(p.action.sound.id, p.action.sound.blob)
              for (const s of p.action.steps) if (s.sound) pushSound(s.sound.id, s.sound.blob)
            }
          }
          if (pl.ending.kind === 'exit' && pl.ending.travel.sound) pushSound(pl.ending.travel.sound.id, pl.ending.travel.sound.blob)
        }
      }
      const updated: Project = { ...project, film, filmNeedsFullUpload: undefined }
      await onSave(updated, hints.length > 0 ? hints : undefined)
      pendingSoundHintsRef.current = []
    } finally {
      setSaving(false)
    }
  }, [film, project, onSave])

  // --- Preview (image originale, sans scan) — film complet ou UN SEUL plan ---
  const openPreview = useCallback(async (previewFilm: Film) => {
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
        previewProjectRef.current = { ...project, film: previewFilm, scene: buildFilmScene(previewFilm) }
        setPreviewCanvas(canvas)
        setPreviewing(true)
        resolve()
      }
    })
  }, [project])

  const handlePreview = useCallback(() => {
    if (film) void openPreview(film)
  }, [film, openPreview])

  /** Preview d'un plan isolé : film réduit à ce plan (sans transition sortante). */
  const handlePreviewPlan = useCallback((planId: string) => {
    if (!film) return
    const pl = film.plans.find(x => x.id === planId)
    if (!pl || pl.backdrop == null || pl.points.length === 0) return
    void openPreview({ ...film, plans: [{ ...pl, transitionToNext: undefined }] })
  }, [film, openPreview])

  const handleClosePreview = useCallback(() => {
    setPreviewing(false)
    setPreviewCanvas(null)
    previewProjectRef.current = null
  }, [])

  const segments = useMemo(() => film ? buildFilmSegments(filmToSceneFilm(film)) : [], [film])

  // --- Projet sans film : création ---
  if (!film) {
    return (
      <div className="scene-editor">
        <div className="scene-editor-header">
          <h3>🎬 Film</h3>
        </div>
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 'var(--radius-sm)',
          padding: '56px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center',
        }}>
          <span style={{ fontSize: 14, opacity: 0.75 }}>
            Ce coloriage n'a pas encore de film. Un film = une séquence de plans
            (décor + chemin de points + actions) jouée automatiquement après le scan.
          </span>
          <button className="btn-primary" onClick={createFilm}>Créer le film</button>
        </div>
      </div>
    )
  }

  const defaultSpeed = plan?.moveSpeedPxPerSec ?? film.moveSpeedPxPerSec
  const planIndex = plan ? plans.indexOf(plan) : -1

  return (
    <div className="scene-editor">
      {/* Header : preview + save */}
      <div className="scene-editor-header">
        <h3>🎬 Film</h3>
        <div className="scene-editor-header-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={handlePreview}
            disabled={saving || !canPreview}
            title={canPreview ? 'Jouer le film avec l’image originale (sans scan)' : 'Il faut une animation calculée, une image et au moins un plan avec décor + point'}
          >
            ▶ Prévisualiser
          </button>
          <button className="btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? 'Sauvegarde...' : 'Sauvegarder'}
          </button>
        </div>
      </div>

      {/* Storyboard des plans + décor du plan actif */}
      {plan && (
        <div className="scene-editor-section-card">
          <FilmStoryboard
            film={film}
            plan={plan}
            onSelectPlan={selectPlan}
            onAddPlan={addPlan}
            onMovePlan={movePlan}
            onRemovePlan={removePlan}
            onRenamePlan={(id, name) => patchPlan(id, name ? { name } : { name: undefined })}
            onTransitionChange={(planId, key, durationMs) => patchPlan(planId, { transitionToNext: transitionFromKey(key, durationMs) })}
            onImportDecor={importDecor}
            onRemoveOverlay={() => plan && patchPlan(plan.id, { overlay: null })}
            onPreviewPlan={handlePreviewPlan}
          />
        </div>
      )}

      {/* Canvas du plan actif */}
      {plan && (
        <div className="scene-editor-section-card">
          <span style={{ fontSize: 12, opacity: 0.7, display: 'block', marginBottom: 8 }}>
            <strong>Clic</strong> : ajouter un point · <strong>Glisser</strong> : déplacer
            (point, marqueur, cadrage caméra) · <strong>Clic droit sur un point</strong> : supprimer.
            La zone sombre autour du décor permet de poser des points <strong>hors du cadre</strong>
            (perso au premier plan, partiellement visible).
          </span>
          <FilmCanvas
            plan={plan}
            selectedId={selectedId}
            onSelectPoint={setSelectedId}
            onAddPoint={addPoint}
            onRemovePoint={removePoint}
            onPatchPlan={(partial) => patchPlan(plan.id, partial)}
            onPatchPoint={(pointId, partial) => patchPoint(plan.id, pointId, partial)}
            characterImageUrl={charImageUrl}
            characterImageSize={charImageSize}
            characterScale={film.character.scale}
            characterOriginU={film.character.originU}
            characterOriginV={film.character.originV}
            characterFacing={film.character.facing}
          />
          {plan.backdrop != null && points.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--color-danger, #ef5350)', marginTop: 6 }}>
              ⚠ Plan vide : cliquez sur le décor pour poser le premier point du chemin.
            </div>
          )}
          {points.length > 0 && !film.moveAnimationId && !plan.moveAnimationId && points.some(p => !p.travel.animationId) && (
            <div style={{ fontSize: 13, color: 'var(--color-warning, #ffa726)', marginTop: 6 }}>
              ⚠ Aucune animation de déplacement (défaut ou par trajet) : le personnage glissera sans marcher.
            </div>
          )}
        </div>
      )}

      {/* Panneau du point sélectionné */}
      {plan && selected && (
        <FilmPointPanel
          plan={plan}
          point={selected}
          pointIndex={selectedIndex}
          readyAnimations={readyAnimations}
          defaultSpeed={defaultSpeed}
          onPatchPlan={(partial) => patchPlan(plan.id, partial)}
          onPatchPoint={(pointId, partial) => patchPoint(plan.id, pointId, partial)}
          onMovePoint={movePoint}
          onRemovePoint={removePoint}
          onFilmSoundImported={onFilmSoundImported}
          onFilmSoundDeleted={onFilmSoundDeleted}
        />
      )}
      {plan && !selected && points.length > 0 && (
        <span style={{ fontSize: 12, opacity: 0.6 }}>Cliquez sur un point pour éditer son échelle, son trajet et son action.</span>
      )}

      {/* Réglages du film + fin du plan */}
      {plan && (
        <div className="scene-editor-section-card">
          <h4 className="scene-editor-section-title">Réglages du film</h4>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="scene-editor-field">
              <label>Animation de déplacement (défaut)</label>
              <select
                value={film.moveAnimationId ?? ''}
                onChange={(e) => updateFilm(e.target.value ? { moveAnimationId: e.target.value } : { moveAnimationId: undefined })}
              >
                <option value="">— Aucune —</option>
                {readyAnimations.map(a => (
                  <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
                ))}
              </select>
            </div>
            <div className="scene-editor-field">
              <label>Vitesse (défaut) : {film.moveSpeedPxPerSec} px/s</label>
              <input
                type="range" min={40} max={1200} step={10}
                value={film.moveSpeedPxPerSec}
                onChange={(e) => updateFilm({ moveSpeedPxPerSec: parseInt(e.target.value, 10) })}
              />
            </div>
            <div className="scene-editor-field" title="Multiplicateur de vitesse de lecture de l'animation idle jouée aux points (0.5 = 2× plus lent)">
              <label>Vitesse idle : ×{(film.idleSpeedMul ?? 1).toFixed(2)}</label>
              <input
                type="range" min={0.1} max={3} step={0.05}
                value={film.idleSpeedMul ?? 1}
                onChange={(e) => updateFilm({ idleSpeedMul: parseFloat(e.target.value) })}
              />
            </div>
            <div className="scene-editor-field" title="CALIBRATION du retournement automatique : le sens dans lequel le coloriage est DESSINÉ. Pendant les trajets, le perso regarde toujours dans sa direction de marche — s'il marche à reculons, inversez ce réglage.">
              <label>Le dessin regarde vers</label>
              <div className="scene-config-panel-type-toggle">
                <button
                  className={`btn-sm ${film.character.facing === 'left' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateFilm({ character: { ...film.character, facing: 'left' } })}
                >← Gauche</button>
                <button
                  className={`btn-sm ${film.character.facing === 'right' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateFilm({ character: { ...film.character, facing: 'right' } })}
                >Droite →</button>
              </div>
            </div>
            <div className="scene-editor-field">
              <label>{plans.length > 1 ? `Fin du plan ${planIndex + 1}${planIndex === plans.length - 1 ? ' (fin du film)' : ' (→ plan suivant)'}` : 'Fin du film'}</label>
              <div className="scene-config-panel-type-toggle">
                <button
                  className={`btn-sm ${plan.ending.kind === 'exit' && plan.ending.side === 'left' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => patchPlan(plan.id, { ending: { kind: 'exit', side: 'left', travel: plan.ending.kind === 'exit' ? plan.ending.travel : {} } })}
                >← Sortie</button>
                <button
                  className={`btn-sm ${plan.ending.kind === 'exit' && plan.ending.side === 'right' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => patchPlan(plan.id, { ending: { kind: 'exit', side: 'right', travel: plan.ending.kind === 'exit' ? plan.ending.travel : {} } })}
                >Sortie →</button>
                <button
                  className={`btn-sm ${plan.ending.kind === 'stay' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => {
                    if (plan.ending.kind === 'exit' && plan.ending.travel.sound) onFilmSoundDeleted(plan.ending.travel.sound.id)
                    patchPlan(plan.id, { ending: { kind: 'stay' } })
                  }}
                >⏹ Sur place</button>
              </div>
            </div>
          </div>
          {plan.ending.kind === 'exit' && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8, marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Trajet de sortie du plan</div>
              <FilmTravelFields
                travel={plan.ending.travel}
                readyAnimations={readyAnimations}
                defaultSpeed={defaultSpeed}
                onChange={(travel) => patchPlan(plan.id, { ending: { kind: 'exit', side: (plan.ending as { side: 'left' | 'right' }).side, travel } })}
                onFilmSoundImported={onFilmSoundImported}
                onFilmSoundDeleted={onFilmSoundDeleted}
                {...(points.length > 0 && (() => {
                  const geo = planGeometry(plan)
                  const from = geo.cursorAfterPoint(points.length - 1)
                  return { curveFromTo: { from, to: { x: geo.edgeXFor((plan.ending as { side: 'left' | 'right' }).side), y: from.y } } }
                })())}
              />
            </div>
          )}
        </div>
      )}

      {/* Point d'ancrage (rarement modifié) — replié. */}
      <div className="scene-editor-section-card">
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Point d'ancrage du personnage (défaut : les pieds)
          </summary>
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
              Posé exactement sur chaque point du chemin — pivot du flip et de l'échelle.
            </label>
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
        <FilmMusicRow
          music={film.music}
          onImport={(file) => {
            if (film.music) onFilmSoundDeleted(film.music.id)
            const id = crypto.randomUUID()
            updateFilm({ music: { id, name: file.name, blob: file } })
            onFilmSoundImported(id)
          }}
          onDelete={() => {
            if (film.music) onFilmSoundDeleted(film.music.id)
            updateFilm({ music: undefined })
          }}
          onVolume={(v) => film.music && updateFilm({ music: { ...film.music, volume: v } })}
        />
      </div>

      {/* Règle temporelle (lecture seule) */}
      {estimate && estimate.totalMs > 0 && segments.length === estimate.segments.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12, opacity: 0.7 }}>Durée estimée (indicatif)</span>
            <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{formatMs(estimate.totalMs)}</span>
          </div>
          <div style={{ display: 'flex', height: 18, borderRadius: 4, overflow: 'hidden', border: '1px solid var(--border)' }}>
            {segments.map((seg, i) => {
              const ms = estimate.segments[i] ?? 0
              if (ms <= 0) return null
              const label = seg.kind === 'action'
                ? `Action — ${seg.action.name}`
                : seg.kind === 'pause'
                  ? `Pause — ${(seg.durationMs / 1000).toFixed(1)}s`
                  : seg.kind === 'planSwitch'
                    ? `Transition → plan ${seg.toPlanIndex + 1}`
                    : seg.opts.offscreenStart
                      ? 'Entrée'
                      : seg.opts.offscreenEnd
                        ? (seg.opts.terminal !== false ? 'Sortie' : 'Sortie de point')
                        : 'Trajet'
              const bgColor = seg.kind === 'action'
                ? FILM_COLORS.action
                : seg.kind === 'pause'
                  ? FILM_COLORS.pause
                  : seg.kind === 'planSwitch'
                    ? FILM_COLORS.planSwitch
                    : (seg.opts.offscreenEnd && seg.opts.terminal !== false ? FILM_COLORS.pointOut : FILM_COLORS.travel)
              return (
                <div
                  key={i}
                  title={`${label} — ~${formatMs(ms)}`}
                  style={{
                    width: `${(ms / estimate.totalMs) * 100}%`,
                    background: bgColor,
                    opacity: 0.75,
                    borderRight: '1px solid rgba(0,0,0,0.4)',
                  }}
                />
              )
            })}
          </div>
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

/** Ligne musique du film (import / volume / préécoute / suppression). */
function FilmMusicRow({ music, onImport, onDelete, onVolume }: {
  music: import('../../../types/project').FilmSound | undefined
  onImport: (file: File) => void
  onDelete: () => void
  onVolume: (v: number) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [playing, setPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const togglePreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      try { URL.revokeObjectURL(audioRef.current.src) } catch { /* */ }
      audioRef.current = null
      setPlaying(false)
      return
    }
    if (!music?.blob) return
    const url = URL.createObjectURL(music.blob)
    const audio = new Audio(url)
    audio.volume = music.volume ?? 1
    audioRef.current = audio
    setPlaying(true)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null }
  }, [music])

  if (music) {
    const volume = music.volume ?? 1
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{music.name}</span>
        <input
          type="range" min={0} max={1} step={0.05}
          value={volume}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            onVolume(v)
            if (audioRef.current) audioRef.current.volume = v
          }}
          style={{ width: 90 }}
          title={`Volume : ${Math.round(volume * 100)}%`}
        />
        <span style={{ fontSize: 11, opacity: 0.7, minWidth: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {Math.round(volume * 100)}%
        </span>
        <button className="btn-icon btn-sm" onClick={togglePreview} disabled={!music.blob} title={playing ? 'Stop' : 'Écouter'}>
          {playing ? '⏹' : '▶'}
        </button>
        <button className="btn-icon btn-sm btn-danger" onClick={onDelete} title="Retirer">&times;</button>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button className="btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>+ Importer la musique</button>
      <input
        ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onImport(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
