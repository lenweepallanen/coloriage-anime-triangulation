import { useCallback, useEffect, useRef, useState } from 'react'
import { animationHasFrames, type Animation, type FilmPoint, type FilmTravel, type Point2D, type Scene, type SceneFilm, type SceneSound } from '../../types/project'
import { estimateFilmDurations, type FilmDurationEstimate } from '../../utils/sceneActionDuration'
import { buildFilmSegments } from '../../utils/filmDirector'
import { ActionCard } from './SceneConfigPanel'

interface Props {
  scene: Scene
  animations: Animation[]
  backgroundUrl: string | null
  layerWidth: number
  layerHeight: number
  /** Silhouette du perso (image du coloriage) pour la preview d'échelle au point sélectionné. */
  characterImageUrl: string | null
  characterImageSize: { w: number; h: number }
  onChange: (film: SceneFilm) => void
  onSceneSoundImported: (soundId: string) => void
  onSceneSoundDeleted: (soundId: string) => void
}

const COLOR_TRAVEL = '#42a5f5'
const COLOR_ACTION = '#7e57c2'
const COLOR_POINT = '#42a5f5'
const COLOR_POINT_SELECTED = '#ffeb3b'
const COLOR_POINT_OUT = '#ef5350'
const CAMERA_HANDLE_H = 18

function formatMs(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Éditeur du Mode Film v2 : un film = un chemin de points sur le décor.
 * Canvas : cadre caméra fixe draggable + points numérotés (clic = ajouter,
 * drag = déplacer) + chemin entrée → 1 → … → sortie. Panneau par point
 * (échelle, trajet entrant, action) + réglages globaux + règle temporelle.
 */
export default function SceneFilmEditor({
  scene, animations, backgroundUrl, layerWidth, layerHeight,
  characterImageUrl, characterImageSize,
  onChange, onSceneSoundImported, onSceneSoundDeleted,
}: Props) {
  const film = scene.film
  const points = film?.points ?? []
  const readyAnimations = animations.filter(a => animationHasFrames(a))

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [canvasW, setCanvasW] = useState(800)
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null)
  const [charImg, setCharImg] = useState<HTMLImageElement | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const dragRef = useRef<{ mode: 'point'; id: string } | { mode: 'camera' } | null>(null)
  const [, forceRedraw] = useState(0)
  const [estimate, setEstimate] = useState<FilmDurationEstimate | null>(null)

  // Largeur du cadre caméra en coords background : le play est en paysage plein
  // écran 16:9 → cadre = hauteur du décor × 16/9, borné à la largeur du décor
  // (même formule que le player et l'estimation de durées).
  const frameW = Math.min(layerWidth, layerHeight * (16 / 9))

  useEffect(() => {
    let cancelled = false
    if (!backgroundUrl) {
      const t = window.setTimeout(() => { if (!cancelled) setBgImg(null) }, 0)
      return () => { cancelled = true; window.clearTimeout(t) }
    }
    const img = new Image()
    img.src = backgroundUrl
    img.onload = () => { if (!cancelled) setBgImg(img) }
    return () => { cancelled = true }
  }, [backgroundUrl])

  useEffect(() => {
    let cancelled = false
    if (!characterImageUrl) {
      const t = window.setTimeout(() => { if (!cancelled) setCharImg(null) }, 0)
      return () => { cancelled = true; window.clearTimeout(t) }
    }
    const img = new Image()
    img.src = characterImageUrl
    img.onload = () => { if (!cancelled) setCharImg(img) }
    return () => { cancelled = true }
  }, [characterImageUrl])

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setCanvasW(Math.max(200, e.contentRect.width))
    })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  // Règle temporelle : recalcul debounced.
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!film || film.points.length === 0) {
        if (!cancelled) setEstimate(null)
        return
      }
      estimateFilmDurations(film, scene, animations)
        .then(d => { if (!cancelled) setEstimate(d) })
        .catch(() => { if (!cancelled) setEstimate(null) })
    }, 300)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [film, scene, animations])

  const updateFilm = useCallback((partial: Partial<SceneFilm>) => {
    if (!film) return
    onChange({ ...film, ...partial })
  }, [film, onChange])

  const patchPoint = useCallback((id: string, partial: Partial<FilmPoint>) => {
    if (!film) return
    onChange({ ...film, points: film.points.map(p => p.id === id ? { ...p, ...partial } : p) })
  }, [film, onChange])

  // Mapping coords background ↔ écran canvas.
  const aspect = layerHeight > 0 && layerWidth > 0 ? layerHeight / layerWidth : 9 / 16
  const canvasH = Math.round(canvasW * aspect)
  const sX = layerWidth > 0 ? canvasW / layerWidth : 1
  const sY = layerHeight > 0 ? canvasH / layerHeight : 1
  const toScreen = (p: Point2D) => ({ x: p.x * sX, y: p.y * sY })
  const toLayer = (sx: number, sy: number): Point2D => ({ x: sx / sX, y: sy / sY })

  const cameraX = film?.cameraX ?? layerWidth / 2
  const frameLeft = cameraX - frameW / 2
  const frameRight = cameraX + frameW / 2
  const isOutOfFrame = (p: FilmPoint) => p.x < frameLeft || p.x > frameRight

  // --- Rendu canvas ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !film) return
    canvas.width = canvasW
    canvas.height = canvasH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#222'
    ctx.fillRect(0, 0, canvasW, canvasH)
    if (bgImg) ctx.drawImage(bgImg, 0, 0, canvasW, canvasH)

    // Hors-champ hachuré (hors cadre caméra)
    const fl = frameLeft * sX
    const fr = frameRight * sX
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    if (fl > 0) ctx.fillRect(0, 0, fl, canvasH)
    if (fr < canvasW) ctx.fillRect(fr, 0, canvasW - fr, canvasH)

    // Cadre caméra + poignée de drag en haut
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2
    ctx.strokeRect(fl, 1, fr - fl, canvasH - 2)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(fl, 0, fr - fl, CAMERA_HANDLE_H)
    ctx.fillStyle = '#222'
    ctx.font = 'bold 11px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText('◂ CADRE CAMÉRA (glisser) ▸', (fl + fr) / 2, 13)
    ctx.textAlign = 'left'

    // Silhouette du perso au point sélectionné (échelle du point)
    const selected = points.find(p => p.id === selectedId)
    if (selected && charImg && characterImageSize.w > 0) {
      const originU = scene.characterOriginU ?? 0.5
      const originV = scene.characterOriginV ?? 1.0
      const charHBg = layerHeight * scene.characterScale * selected.scale
      const charWBg = charHBg * (characterImageSize.w / characterImageSize.h)
      const topLeft = toScreen({ x: selected.x - originU * charWBg, y: selected.y - originV * charHBg })
      ctx.globalAlpha = 0.55
      ctx.drawImage(charImg, topLeft.x, topLeft.y, charWBg * sX, charHBg * sY)
      ctx.globalAlpha = 1
    }

    // Chemin : entrée → points → sortie
    const drawArrow = (from: Point2D, to: Point2D, color: string) => {
      const a = toScreen(from)
      const b = toScreen(to)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 2
      ctx.setLineDash([7, 5])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      const ang = Math.atan2(b.y - a.y, b.x - a.x)
      ctx.beginPath()
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4))
      ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4))
      ctx.closePath()
      ctx.fill()
    }
    if (points.length > 0) {
      const p0 = points[0]
      const entryX = film.entrySide === 'left' ? frameLeft : frameRight
      drawArrow({ x: entryX, y: p0.y }, p0, COLOR_TRAVEL)
      for (let i = 1; i < points.length; i++) drawArrow(points[i - 1], points[i], COLOR_TRAVEL)
      const last = points[points.length - 1]
      if (film.ending.kind === 'exit') {
        const exitX = film.ending.side === 'left' ? frameLeft : frameRight
        drawArrow(last, { x: exitX, y: last.y }, COLOR_POINT_OUT)
      } else {
        // Fin sur place : symbole ⏹ à côté du dernier point
        const ls = toScreen(last)
        ctx.fillStyle = COLOR_POINT_OUT
        ctx.fillRect(ls.x + 14, ls.y - 20, 11, 11)
      }
    }

    // Points numérotés
    points.forEach((p, i) => {
      const s = toScreen(p)
      const out = isOutOfFrame(p)
      ctx.beginPath()
      ctx.arc(s.x, s.y, 12, 0, Math.PI * 2)
      ctx.fillStyle = out ? COLOR_POINT_OUT : (p.id === selectedId ? COLOR_POINT_SELECTED : COLOR_POINT)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      // Badge action (violet) si le point a une action
      if (p.action && p.action.steps.length > 0) {
        ctx.beginPath()
        ctx.arc(s.x + 10, s.y - 10, 5, 0, Math.PI * 2)
        ctx.fillStyle = COLOR_ACTION
        ctx.fill()
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1
        ctx.stroke()
      }
      ctx.fillStyle = p.id === selectedId ? '#222' : '#fff'
      ctx.font = 'bold 12px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), s.x, s.y)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    })
  }, [film, points, selectedId, bgImg, charImg, canvasW, canvasH, sX, sY, frameLeft, frameRight, scene.characterScale, scene.characterOriginU, scene.characterOriginV, characterImageSize, layerHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Interactions canvas ---
  const getPointAt = (sx: number, sy: number): FilmPoint | null => {
    for (let i = points.length - 1; i >= 0; i--) {
      const s = toScreen(points[i])
      if (Math.hypot(s.x - sx, s.y - sy) <= 15) return points[i]
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!film) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const hit = getPointAt(sx, sy)
    if (hit) {
      setSelectedId(hit.id)
      dragRef.current = { mode: 'point', id: hit.id }
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
      return
    }
    // Poignée caméra (bandeau en haut du cadre)
    if (sy <= CAMERA_HANDLE_H && sx >= frameLeft * sX && sx <= frameRight * sX) {
      dragRef.current = { mode: 'camera' }
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
      return
    }
    // Clic dans le vide : ajouter un point en fin de chemin
    const p = toLayer(sx, sy)
    const newPoint: FilmPoint = {
      id: crypto.randomUUID(),
      x: Math.round(Math.max(0, Math.min(layerWidth, p.x))),
      y: Math.round(Math.max(0, Math.min(layerHeight, p.y))),
      scale: points.length > 0 ? points[points.length - 1].scale : 1,
      travel: {},
    }
    updateFilm({ points: [...points, newPoint] })
    setSelectedId(newPoint.id)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || !film) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const sx = Math.max(0, Math.min(canvasW, e.clientX - rect.left))
    const sy = Math.max(0, Math.min(canvasH, e.clientY - rect.top))
    const p = toLayer(sx, sy)
    if (drag.mode === 'point') {
      patchPoint(drag.id, { x: Math.round(p.x), y: Math.round(p.y) })
    } else {
      const half = frameW / 2
      const clamped = layerWidth > frameW
        ? Math.max(half, Math.min(layerWidth - half, p.x))
        : layerWidth / 2
      updateFilm({ cameraX: Math.round(clamped) })
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null
    forceRedraw(n => n + 1)
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId) } catch { /* */ }
  }

  // --- Mutations points ---
  const movePoint = (id: string, dir: -1 | 1) => {
    const i = points.findIndex(p => p.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= points.length) return
    const next = [...points]
    ;[next[i], next[j]] = [next[j], next[i]]
    updateFilm({ points: next })
  }

  const removePoint = (id: string) => {
    const p = points.find(x => x.id === id)
    if (!p) return
    if (p.travel.sound) onSceneSoundDeleted(p.travel.sound.id)
    if (p.action) {
      if (p.action.sound) onSceneSoundDeleted(p.action.sound.id)
      for (const s of p.action.steps) if (s.sound) onSceneSoundDeleted(s.sound.id)
    }
    updateFilm({ points: points.filter(x => x.id !== id) })
    if (selectedId === id) setSelectedId(null)
  }

  if (!film) return null

  const selected = points.find(p => p.id === selectedId) ?? null
  const selectedIndex = selected ? points.findIndex(p => p.id === selected.id) : -1
  const outOfFrameCount = points.filter(isOutOfFrame).length
  const segments = buildFilmSegments(film)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={{ fontSize: 12, opacity: 0.7 }}>
        Cliquez sur le décor pour poser un point (le chemin les relie dans l'ordre) ;
        glissez un point pour le déplacer, glissez le bandeau blanc pour choisir le cadrage.
        À chaque point : échelle du perso, trajet entrant (animation, vitesse, son) et action jouée à l'arrivée.
      </span>

      {/* Réglages globaux (le côté d'entrée s'édite sur le trajet entrant du point 1) */}
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
        <div className="scene-editor-field">
          <label>Fin du film</label>
          <div className="scene-config-panel-type-toggle">
            <button
              className={`btn-sm ${film.ending.kind === 'exit' && film.ending.side === 'left' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateFilm({ ending: { kind: 'exit', side: 'left', travel: film.ending.kind === 'exit' ? film.ending.travel : {} } })}
            >← Sortie</button>
            <button
              className={`btn-sm ${film.ending.kind === 'exit' && film.ending.side === 'right' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateFilm({ ending: { kind: 'exit', side: 'right', travel: film.ending.kind === 'exit' ? film.ending.travel : {} } })}
            >Sortie →</button>
            <button
              className={`btn-sm ${film.ending.kind === 'stay' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                if (film.ending.kind === 'exit' && film.ending.travel.sound) onSceneSoundDeleted(film.ending.travel.sound.id)
                updateFilm({ ending: { kind: 'stay' } })
              }}
            >⏹ Sur place</button>
          </div>
        </div>
      </div>

      {/* Trajet de sortie (si fin = sortie) */}
      {film.ending.kind === 'exit' && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Trajet de sortie</div>
          <TravelFields
            travel={film.ending.travel}
            readyAnimations={readyAnimations}
            defaultSpeed={film.moveSpeedPxPerSec}
            onChange={(travel) => updateFilm({ ending: { kind: 'exit', side: (film.ending as { side: 'left' | 'right' }).side, travel } })}
            onSceneSoundImported={onSceneSoundImported}
            onSceneSoundDeleted={onSceneSoundDeleted}
          />
        </div>
      )}

      {/* Avertissements */}
      {points.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-danger, #ef5350)' }}>
          ⚠ Film vide : cliquez sur le décor pour poser le premier point du chemin.
        </div>
      )}
      {outOfFrameCount > 0 && (
        <div style={{ fontSize: 13, color: 'var(--color-danger, #ef5350)' }}>
          ⚠ {outOfFrameCount} point{outOfFrameCount > 1 ? 's' : ''} hors du cadre caméra (en rouge) : le personnage y sera invisible.
        </div>
      )}
      {points.length > 0 && !film.moveAnimationId && points.some(p => !p.travel.animationId) && (
        <div style={{ fontSize: 13, color: 'var(--color-warning, #ffa726)' }}>
          ⚠ Aucune animation de déplacement (défaut ou par trajet) : le personnage glissera sans marcher.
        </div>
      )}

      {/* Canvas du décor */}
      <div ref={wrapRef} style={{ width: '100%' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', width: '100%', borderRadius: 4, border: '1px solid #333', cursor: 'crosshair', touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      </div>

      {/* Panneau du point sélectionné */}
      {selected && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>Point {selectedIndex + 1}</span>
            <span style={{ fontSize: 12, opacity: 0.6 }}>({selected.x}, {selected.y})</span>
            {isOutOfFrame(selected) && <span style={{ fontSize: 12, color: 'var(--color-danger, #ef5350)' }}>hors cadre</span>}
            <div style={{ flex: 1 }} />
            <button className="btn-icon btn-sm" onClick={() => movePoint(selected.id, -1)} disabled={selectedIndex === 0} title="Plus tôt dans le chemin">↑</button>
            <button className="btn-icon btn-sm" onClick={() => movePoint(selected.id, +1)} disabled={selectedIndex === points.length - 1} title="Plus tard dans le chemin">↓</button>
            <button className="btn-icon btn-sm btn-danger" onClick={() => removePoint(selected.id)} title="Supprimer le point">&times;</button>
          </div>

          <div className="scene-editor-field" style={{ maxWidth: 360 }}>
            <label>Échelle du personnage : {selected.scale.toFixed(2)}×</label>
            <input
              type="range" min={0.2} max={3} step={0.05}
              value={selected.scale}
              onChange={(e) => patchPoint(selected.id, { scale: parseFloat(e.target.value) })}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              {selectedIndex === 0 ? 'Entrée en scène (trajet hors-champ → point 1)' : `Trajet entrant (depuis le point ${selectedIndex})`}
            </div>
            {selectedIndex === 0 && (
              <div className="scene-editor-field" style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12 }}>Le personnage entre par</label>
                <div className="scene-config-panel-type-toggle">
                  <button className={`btn-sm ${film.entrySide === 'left' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateFilm({ entrySide: 'left' })}>← Gauche</button>
                  <button className={`btn-sm ${film.entrySide === 'right' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateFilm({ entrySide: 'right' })}>Droite →</button>
                </div>
              </div>
            )}
            <TravelFields
              travel={selected.travel}
              readyAnimations={readyAnimations}
              defaultSpeed={film.moveSpeedPxPerSec}
              onChange={(travel) => patchPoint(selected.id, { travel })}
              onSceneSoundImported={onSceneSoundImported}
              onSceneSoundDeleted={onSceneSoundDeleted}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Action à l'arrivée</div>
            {selected.action ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ActionCard
                  action={selected.action}
                  readyAnimations={readyAnimations}
                  onChange={(partial) => patchPoint(selected.id, { action: { ...selected.action!, ...partial } })}
                  onSceneSoundImported={onSceneSoundImported}
                  onSceneSoundDeleted={onSceneSoundDeleted}
                />
                <button
                  className="btn-sm btn-ghost btn-danger"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => {
                    if (selected.action?.sound) onSceneSoundDeleted(selected.action.sound.id)
                    for (const s of selected.action?.steps ?? []) if (s.sound) onSceneSoundDeleted(s.sound.id)
                    patchPoint(selected.id, { action: undefined })
                  }}
                >
                  Retirer l'action (point de passage)
                </button>
              </div>
            ) : (
              <button
                className="btn-sm btn-secondary"
                onClick={() => patchPoint(selected.id, { action: { id: crypto.randomUUID(), name: `Action point ${selectedIndex + 1}`, steps: [] } })}
              >
                + Ajouter une action
              </button>
            )}
          </div>
        </div>
      )}
      {!selected && points.length > 0 && (
        <span style={{ fontSize: 12, opacity: 0.6 }}>Cliquez sur un point pour éditer son échelle, son trajet et son action.</span>
      )}

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
                : seg.opts.offscreenStart ? 'Entrée' : seg.opts.offscreenEnd ? 'Sortie' : 'Trajet'
              return (
                <div
                  key={i}
                  title={`${label} — ~${formatMs(ms)}`}
                  style={{
                    width: `${(ms / estimate.totalMs) * 100}%`,
                    background: seg.kind === 'action' ? COLOR_ACTION : (seg.opts.offscreenEnd ? COLOR_POINT_OUT : COLOR_TRAVEL),
                    opacity: 0.75,
                    borderRight: '1px solid rgba(0,0,0,0.4)',
                  }}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Champs d'un trajet (anim + vitesse + son) ---

function TravelFields({ travel, readyAnimations, defaultSpeed, onChange, onSceneSoundImported, onSceneSoundDeleted }: {
  travel: FilmTravel
  readyAnimations: Animation[]
  defaultSpeed: number
  onChange: (travel: FilmTravel) => void
  onSceneSoundImported: (soundId: string) => void
  onSceneSoundDeleted: (soundId: string) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <div className="scene-editor-field">
        <label style={{ fontSize: 12 }}>Animation</label>
        <select
          value={travel.animationId ?? ''}
          onChange={(e) => {
            const next = { ...travel }
            if (e.target.value) next.animationId = e.target.value
            else delete next.animationId
            onChange(next)
          }}
        >
          <option value="">(défaut du film)</option>
          {readyAnimations.map(a => (
            <option key={a.id} value={a.id}>{a.name} ({a.type})</option>
          ))}
        </select>
      </div>
      <div className="scene-editor-field">
        <label style={{ fontSize: 12 }}>Vitesse (px/s)</label>
        <input
          type="number" min={10} step={10}
          placeholder={String(defaultSpeed)}
          value={travel.speedPxPerSec ?? ''}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            const next = { ...travel }
            if (Number.isFinite(v) && v > 0) next.speedPxPerSec = v
            else delete next.speedPxPerSec
            onChange(next)
          }}
          style={{ width: 90 }}
        />
      </div>
      <div className="scene-editor-field" title="Multiplicateur de vitesse de lecture de l'animation (ex. déplacement 2× plus rapide → 2 pour que les jambes suivent)">
        <label style={{ fontSize: 12 }}>Anim ×</label>
        <input
          type="number" min={0.1} step={0.1}
          placeholder="1"
          value={travel.animSpeedMul ?? ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            const next = { ...travel }
            if (Number.isFinite(v) && v > 0) next.animSpeedMul = v
            else delete next.animSpeedMul
            onChange(next)
          }}
          style={{ width: 90 }}
        />
      </div>
      <TravelSoundRow
        sound={travel.sound}
        onImport={(file) => {
          if (travel.sound) onSceneSoundDeleted(travel.sound.id)
          const id = crypto.randomUUID()
          onChange({ ...travel, sound: { id, name: file.name, blob: file } })
          onSceneSoundImported(id)
        }}
        onDelete={() => {
          if (!travel.sound) return
          onSceneSoundDeleted(travel.sound.id)
          const next = { ...travel }
          delete next.sound
          onChange(next)
        }}
        onVolume={(v) => {
          if (!travel.sound) return
          onChange({ ...travel, sound: { ...travel.sound, volume: v } })
        }}
        onToggleLoop={(loop) => {
          if (!travel.sound) return
          onChange({ ...travel, sound: { ...travel.sound, loop: loop || undefined } })
        }}
        onRate={(rate) => {
          if (!travel.sound) return
          onChange({ ...travel, sound: { ...travel.sound, rate } })
        }}
      />
    </div>
  )
}

// --- Ligne son de trajet (import / preview / volume / delete) ---

function TravelSoundRow({ sound, onImport, onDelete, onVolume, onToggleLoop, onRate }: {
  sound: SceneSound | undefined
  onImport: (file: File) => void
  onDelete: () => void
  onVolume: (v: number) => void
  onToggleLoop: (loop: boolean) => void
  onRate: (rate: number | undefined) => void
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
    if (!sound?.blob) return
    const url = URL.createObjectURL(sound.blob)
    const audio = new Audio(url)
    audio.volume = sound.volume ?? 1
    audio.playbackRate = sound.rate ?? 1
    audioRef.current = audio
    setPlaying(true)
    audio.play().catch(() => {})
    audio.onended = () => { URL.revokeObjectURL(url); setPlaying(false); audioRef.current = null }
  }, [sound])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span style={{ opacity: 0.7 }}>Son :</span>
      {sound ? (
        <>
          <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sound.name}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11 }} title="Boucle pendant tout le trajet, coupé à l'arrivée (ex. bruit de pas)">
            <input
              type="checkbox"
              checked={sound.loop ?? false}
              onChange={(e) => onToggleLoop(e.target.checked)}
            />
            loop
          </label>
          <input
            type="number" min={0.1} step={0.1}
            placeholder="×1"
            value={sound.rate ?? ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              onRate(Number.isFinite(v) && v > 0 ? v : undefined)
            }}
            style={{ width: 64 }}
            title="Vitesse de lecture du son (synchro son ↔ animation ; modifie la hauteur)"
          />
          <input
            type="range" min={0} max={1} step={0.05}
            value={sound.volume ?? 1}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              onVolume(v)
              if (audioRef.current) audioRef.current.volume = v
            }}
            style={{ width: 70 }}
            title={`Volume : ${Math.round((sound.volume ?? 1) * 100)}%`}
          />
          <button className="btn-icon btn-sm" onClick={togglePreview} disabled={!sound.blob} title={playing ? 'Stop' : 'Écouter'}>
            {playing ? '⏹' : '▶'}
          </button>
          <button className="btn-icon btn-sm btn-danger" onClick={onDelete} title="Retirer">&times;</button>
        </>
      ) : (
        <>
          <button className="btn-sm btn-ghost" onClick={() => fileInputRef.current?.click()}>+ son</button>
          <input
            ref={fileInputRef} type="file" accept="audio/*" style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onImport(file)
              e.target.value = ''
            }}
          />
        </>
      )}
    </div>
  )
}
