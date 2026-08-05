import { useEffect, useRef, useState } from 'react'
import type { FilmPlan, FilmPoint, Point2D } from '../../../types/project'
import { CAMERA_HANDLE_H, extractVideoFrame0Url, FILM_COLORS, planFrameWidth, planGeometry } from './filmEditorShared'

/**
 * Canvas d'édition du plan actif : décor + cadre caméra 16:9 draggable +
 * points numérotés (clic = ajouter, drag = déplacer) + chemins droits/courbes +
 * marqueurs draggables (origine libre, cible de sortie, points de contrôle Bézier).
 */
export default function FilmCanvas({
  plan, selectedId, onSelectPoint, onAddPoint, onRemovePoint, onPatchPlan, onPatchPoint,
  characterImageUrl, characterImageSize, characterScale, characterOriginU, characterOriginV, characterFacing,
}: {
  plan: FilmPlan
  selectedId: string | null
  onSelectPoint: (id: string | null) => void
  onAddPoint: (p: Point2D, scale: number) => void
  /** Suppression demandée par clic droit sur un point (la confirmation est gérée par l'appelant). */
  onRemovePoint: (pointId: string) => void
  onPatchPlan: (partial: Partial<FilmPlan>) => void
  onPatchPoint: (pointId: string, partial: Partial<FilmPoint>) => void
  characterImageUrl: string | null
  characterImageSize: { w: number; h: number }
  characterScale: number
  characterOriginU: number
  characterOriginV: number
  /** Sens dans lequel le coloriage est dessiné (pour prévisualiser le regard du point). */
  characterFacing: 'left' | 'right'
}) {
  const points = plan.points
  const layerW = plan.backdrop?.width ?? 0
  const layerH = plan.backdrop?.height ?? 0

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [canvasW, setCanvasW] = useState(800)
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null)
  const [charImg, setCharImg] = useState<HTMLImageElement | null>(null)
  const [, forceRedraw] = useState(0)
  const dragRef = useRef<
    | { mode: 'point'; id: string }
    | { mode: 'camera' }
    | { mode: 'origin'; id: string }
    | { mode: 'departure'; id: string }
    | { mode: 'cp'; role: 'travel' | 'departure' | 'ending'; id: string | null; cpIndex: number }
    | null
  >(null)

  // Décor du plan : image directe, ou VIDÉO jouée en boucle dans le canvas
  // (frame 0 extraite en placeholder le temps que la vidéo soit prête).
  const backdropImageBlob = plan.backdrop?.imageBlob ?? null
  const backdropVideoBlob = plan.backdrop?.videoBlob ?? null
  const [bgVideo, setBgVideo] = useState<HTMLVideoElement | null>(null)
  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    if (!backdropImageBlob && !backdropVideoBlob) {
      const t = window.setTimeout(() => { if (!cancelled) setBgImg(null) }, 0)
      return () => { cancelled = true; window.clearTimeout(t) }
    }
    const setup = async () => {
      try {
        url = backdropImageBlob
          ? URL.createObjectURL(backdropImageBlob)
          : await extractVideoFrame0Url(backdropVideoBlob!)
        const img = new Image()
        img.src = url
        img.onload = () => { if (!cancelled) setBgImg(img) }
      } catch {
        if (!cancelled) setBgImg(null)
      }
    }
    setup()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [backdropImageBlob, backdropVideoBlob])

  useEffect(() => {
    if (!backdropVideoBlob) {
      setBgVideo(null)
      return
    }
    const url = URL.createObjectURL(backdropVideoBlob)
    const vid = document.createElement('video')
    vid.muted = true
    vid.loop = true
    vid.playsInline = true
    vid.src = url
    const onReady = () => {
      setBgVideo(vid)
      vid.play().catch(() => {})
    }
    vid.addEventListener('loadeddata', onReady)
    return () => {
      vid.removeEventListener('loadeddata', onReady)
      vid.pause()
      vid.src = ''
      URL.revokeObjectURL(url)
      setBgVideo(null)
    }
  }, [backdropVideoBlob])

  // Rafraîchit le canvas ~24 fps tant qu'une vidéo de décor joue.
  const [videoTick, setVideoTick] = useState(0)
  useEffect(() => {
    if (!bgVideo) return
    const id = window.setInterval(() => setVideoTick(t => (t + 1) % 1_000_000), 1000 / 24)
    return () => window.clearInterval(id)
  }, [bgVideo])

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

  // L'observation doit se (re)brancher quand le canvas apparaît : sans décor, le
  // composant rend un prompt (pas de wrapRef) — un effect monté une seule fois
  // n'observerait jamais et la largeur resterait figée (clics décalés).
  const hasBackdrop = plan.backdrop != null
  useEffect(() => {
    const el = wrapRef.current
    if (!hasBackdrop || !el) return
    setCanvasW(Math.max(200, el.clientWidth))
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setCanvasW(Math.max(200, e.contentRect.width))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasBackdrop])

  // Marge « hors décor » autour du décor : permet de poser des points HORS du
  // cadre de la vidéo (perso au premier plan, très grand, partiellement visible).
  const OUT_M = layerH > 0 ? Math.round(layerH * 0.35) : 0
  const fullW = layerW + 2 * OUT_M
  const fullH = layerH + 2 * OUT_M
  // Mapping coords backdrop ↔ écran canvas (le canvas couvre décor + marges).
  const aspect = fullH > 0 && fullW > 0 ? fullH / fullW : 9 / 16
  const canvasH = Math.round(canvasW * aspect)
  const sX = fullW > 0 ? canvasW / fullW : 1
  const sY = fullH > 0 ? canvasH / fullH : 1
  const toScreen = (p: Point2D) => ({ x: (p.x + OUT_M) * sX, y: (p.y + OUT_M) * sY })
  const toLayer = (sx: number, sy: number): Point2D => ({ x: sx / sX - OUT_M, y: sy / sY - OUT_M })

  const frameW = planFrameWidth(plan)
  const geo = planGeometry(plan)
  const isOutOfFrame = (p: FilmPoint) => p.x < geo.frameLeft || p.x > geo.frameRight

  // --- Rendu ---
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = canvasW
    canvas.height = canvasH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#161616'
    ctx.fillRect(0, 0, canvasW, canvasH)
    // Décor dessiné dans sa zone — le canvas inclut la marge « hors décor ».
    const dx = OUT_M * sX
    const dy = OUT_M * sY
    const dw = layerW * sX
    const dh = layerH * sY
    ctx.fillStyle = '#222'
    ctx.fillRect(dx, dy, dw, dh)
    if (bgVideo && bgVideo.readyState >= 2) ctx.drawImage(bgVideo, dx, dy, dw, dh)
    else if (bgImg) ctx.drawImage(bgImg, dx, dy, dw, dh)
    // Bord du décor (pointillé) : au-delà = hors décor (points autorisés).
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(dx, dy, dw, dh)
    ctx.setLineDash([])

    // Hors-champ assombri (tout ce qui est hors du cadre caméra 16:9)
    const fl = (geo.frameLeft + OUT_M) * sX
    const fr = (geo.frameRight + OUT_M) * sX
    const ft = dy
    const fb = dy + dh
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    if (fl > 0) ctx.fillRect(0, 0, fl, canvasH)
    if (fr < canvasW) ctx.fillRect(fr, 0, canvasW - fr, canvasH)
    ctx.fillRect(fl, 0, fr - fl, ft)
    ctx.fillRect(fl, fb, fr - fl, canvasH - fb)

    // Cadre caméra + poignée de drag en haut
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 2
    ctx.strokeRect(fl, ft + 1, fr - fl, fb - ft - 2)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillRect(fl, ft, fr - fl, CAMERA_HANDLE_H)
    ctx.fillStyle = '#222'
    ctx.font = 'bold 11px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText('◂ CADRE CAMÉRA (glisser) ▸', (fl + fr) / 2, ft + 13)
    ctx.textAlign = 'left'

    // Silhouette du perso au point sélectionné : échelle DU POINT + regard du
    // point (miroir autour de l'ancrage si le regard diffère du sens du dessin).
    const selected = points.find(p => p.id === selectedId)
    if (selected && charImg && characterImageSize.w > 0) {
      const charHBg = layerH * characterScale * selected.scale
      const charWBg = charHBg * (characterImageSize.w / characterImageSize.h)
      const topLeft = toScreen({ x: selected.x - characterOriginU * charWBg, y: selected.y - characterOriginV * charHBg })
      const mirrored = selected.facing != null && selected.facing !== characterFacing
      ctx.save()
      ctx.globalAlpha = 0.55
      if (mirrored) {
        const pivotX = toScreen({ x: selected.x, y: 0 }).x
        ctx.translate(pivotX, 0)
        ctx.scale(-1, 1)
        ctx.translate(-pivotX, 0)
      }
      ctx.drawImage(charImg, topLeft.x, topLeft.y, charWBg * sX, charHBg * sY)
      ctx.restore()
    }

    // Chemin : trajet droit ou courbe Bézier (pointillés) + flèche orientée par la tangente finale.
    const drawTravelPath = (from: Point2D, to: Point2D, controlPoints: Point2D[] | undefined, color: string) => {
      const a = toScreen(from)
      const b = toScreen(to)
      const cps = (controlPoints ?? []).map(toScreen)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 2
      ctx.setLineDash([7, 5])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      if (cps.length === 1) ctx.quadraticCurveTo(cps[0].x, cps[0].y, b.x, b.y)
      else if (cps.length >= 2) ctx.bezierCurveTo(cps[0].x, cps[0].y, cps[1].x, cps[1].y, b.x, b.y)
      else ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      const tangentFrom = cps.length > 0 ? cps[cps.length - 1] : a
      const ang = Math.atan2(b.y - tangentFrom.y, b.x - tangentFrom.x)
      ctx.beginPath()
      ctx.moveTo(b.x, b.y)
      ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4))
      ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4))
      ctx.closePath()
      ctx.fill()
    }
    const drawDiamond = (p: Point2D, color: string, label: string) => {
      const s = toScreen(p)
      ctx.beginPath()
      ctx.moveTo(s.x, s.y - 9)
      ctx.lineTo(s.x + 9, s.y)
      ctx.lineTo(s.x, s.y + 9)
      ctx.lineTo(s.x - 9, s.y)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 10px system-ui'
      ctx.textAlign = 'center'
      ctx.fillText(label, s.x, s.y - 13)
      ctx.textAlign = 'left'
    }
    const drawControlPoints = (from: Point2D, to: Point2D, controlPoints: Point2D[] | undefined) => {
      const cps = controlPoints ?? []
      if (cps.length === 0) return
      const a = toScreen(from)
      const b = toScreen(to)
      const s = cps.map(toScreen)
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(s[0].x, s[0].y)
      if (s.length >= 2) {
        ctx.moveTo(s[0].x, s[0].y)
        ctx.lineTo(s[1].x, s[1].y)
        ctx.moveTo(s[1].x, s[1].y)
      } else {
        ctx.moveTo(s[0].x, s[0].y)
      }
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      for (const c of s) {
        ctx.beginPath()
        ctx.arc(c.x, c.y, 6, 0, Math.PI * 2)
        ctx.fillStyle = FILM_COLORS.controlPoint
        ctx.fill()
        ctx.strokeStyle = '#333'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    if (points.length > 0) {
      // Trajets entrants (+ sorties de point) — la discontinuité (origine
      // hors-champ/libre sans sortie) apparaît naturellement.
      points.forEach((p, i) => {
        if (p.travel.origin?.kind !== 'appear') {
          drawTravelPath(geo.travelFrom(i), p, p.travel.controlPoints, FILM_COLORS.travel)
        }
        const depTo = geo.departureTo(i)
        if (depTo && p.departure) {
          drawTravelPath(p, depTo, p.departure.travel.controlPoints, FILM_COLORS.departure)
        }
      })
      const lastCursor = geo.cursorAfterPoint(points.length - 1)
      if (plan.ending.kind === 'exit') {
        const endTarget = { x: geo.edgeXFor(plan.ending.side), y: lastCursor.y }
        drawTravelPath(lastCursor, endTarget, plan.ending.travel.controlPoints, FILM_COLORS.pointOut)
        if (plan.ending.travel.controlPoints?.length) {
          drawControlPoints(lastCursor, endTarget, plan.ending.travel.controlPoints)
        }
      } else {
        // Fin sur place : symbole ⏹ à côté du dernier point
        const ls = toScreen(points[points.length - 1])
        ctx.fillStyle = FILM_COLORS.pointOut
        ctx.fillRect(ls.x + 14, ls.y - 20, 11, 11)
      }

      // Marqueurs éditables du point sélectionné : origine libre, cible de sortie, CPs.
      const selIdx = points.findIndex(pt => pt.id === selectedId)
      if (selIdx >= 0) {
        const sp = points[selIdx]
        if (sp.travel.origin?.kind === 'custom') {
          drawDiamond({ x: sp.travel.origin.x, y: sp.travel.origin.y }, FILM_COLORS.travel, 'départ')
        }
        if (sp.departure?.target.kind === 'custom') {
          drawDiamond({ x: sp.departure.target.x, y: sp.departure.target.y }, FILM_COLORS.departure, 'sortie')
        }
        if (sp.travel.controlPoints?.length && sp.travel.origin?.kind !== 'appear') {
          drawControlPoints(geo.travelFrom(selIdx), sp, sp.travel.controlPoints)
        }
        const depTo = geo.departureTo(selIdx)
        if (depTo && sp.departure?.travel.controlPoints?.length) {
          drawControlPoints(sp, depTo, sp.departure.travel.controlPoints)
        }
      }
    }

    // Points numérotés
    points.forEach((p, i) => {
      const s = toScreen(p)
      const out = isOutOfFrame(p)
      ctx.beginPath()
      ctx.arc(s.x, s.y, 12, 0, Math.PI * 2)
      ctx.fillStyle = out ? FILM_COLORS.pointOut : (p.id === selectedId ? FILM_COLORS.pointSelected : FILM_COLORS.point)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      if (p.travel.origin?.kind === 'appear') {
        ctx.font = '12px system-ui'
        ctx.textAlign = 'center'
        ctx.fillStyle = '#fff'
        ctx.fillText('✨', s.x - 16, s.y - 12)
        ctx.textAlign = 'left'
      }
      if (p.action && p.action.steps.length > 0) {
        ctx.beginPath()
        ctx.arc(s.x + 10, s.y - 10, 5, 0, Math.PI * 2)
        ctx.fillStyle = FILM_COLORS.action
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
  }, [plan, points, selectedId, bgImg, bgVideo, videoTick, charImg, canvasW, canvasH, sX, sY, characterScale, characterOriginU, characterOriginV, characterFacing, characterImageSize, layerH]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Interactions ---
  const getPointAt = (sx: number, sy: number): FilmPoint | null => {
    for (let i = points.length - 1; i >= 0; i--) {
      const s = toScreen(points[i])
      if (Math.hypot(s.x - sx, s.y - sy) <= 15) return points[i]
    }
    return null
  }

  const hitAt = (p: Point2D, sx: number, sy: number, r: number): boolean => {
    const s = toScreen(p)
    return Math.hypot(s.x - sx, s.y - sy) <= r
  }

  /** Coords pointeur → coords BUFFER du canvas (robuste à tout écart CSS/buffer). */
  const pointerToCanvas = (e: React.PointerEvent<HTMLCanvasElement>): { sx: number; sy: number } => {
    const el = canvasRef.current
    const rect = (el ?? (e.target as HTMLCanvasElement)).getBoundingClientRect()
    const kx = rect.width > 0 ? canvasW / rect.width : 1
    const ky = rect.height > 0 ? canvasH / rect.height : 1
    return { sx: (e.clientX - rect.left) * kx, sy: (e.clientY - rect.top) * ky }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy } = pointerToCanvas(e)
    const capture = () => (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    // Clic droit : supprimer le point visé (confirmation côté éditeur). Jamais d'ajout.
    if (e.button === 2) {
      const target = getPointAt(sx, sy)
      if (target) onRemovePoint(target.id)
      return
    }
    if (e.button !== 0) return
    const hit = getPointAt(sx, sy)
    if (hit) {
      onSelectPoint(hit.id)
      dragRef.current = { mode: 'point', id: hit.id }
      capture()
      return
    }
    // Marqueurs du point sélectionné : CPs, origine libre, cible de sortie.
    const selIdx = points.findIndex(pt => pt.id === selectedId)
    if (selIdx >= 0) {
      const sp = points[selIdx]
      const travelCps = sp.travel.controlPoints ?? []
      for (let ci = 0; ci < travelCps.length; ci++) {
        if (hitAt(travelCps[ci], sx, sy, 10)) {
          dragRef.current = { mode: 'cp', role: 'travel', id: sp.id, cpIndex: ci }
          capture()
          return
        }
      }
      const depCps = sp.departure?.travel.controlPoints ?? []
      for (let ci = 0; ci < depCps.length; ci++) {
        if (hitAt(depCps[ci], sx, sy, 10)) {
          dragRef.current = { mode: 'cp', role: 'departure', id: sp.id, cpIndex: ci }
          capture()
          return
        }
      }
      if (sp.travel.origin?.kind === 'custom' && hitAt({ x: sp.travel.origin.x, y: sp.travel.origin.y }, sx, sy, 12)) {
        dragRef.current = { mode: 'origin', id: sp.id }
        capture()
        return
      }
      if (sp.departure?.target.kind === 'custom' && hitAt({ x: sp.departure.target.x, y: sp.departure.target.y }, sx, sy, 12)) {
        dragRef.current = { mode: 'departure', id: sp.id }
        capture()
        return
      }
    }
    // CPs du trajet de sortie du plan.
    if (plan.ending.kind === 'exit') {
      const endCps = plan.ending.travel.controlPoints ?? []
      for (let ci = 0; ci < endCps.length; ci++) {
        if (hitAt(endCps[ci], sx, sy, 10)) {
          dragRef.current = { mode: 'cp', role: 'ending', id: null, cpIndex: ci }
          capture()
          return
        }
      }
    }
    // Poignée caméra (bandeau en haut du cadre, au sommet du décor)
    const camTop = OUT_M * sY
    if (sy >= camTop && sy <= camTop + CAMERA_HANDLE_H
      && sx >= (geo.frameLeft + OUT_M) * sX && sx <= (geo.frameRight + OUT_M) * sX) {
      dragRef.current = { mode: 'camera' }
      capture()
      return
    }
    // Clic dans le vide : ajouter un point en fin de chemin
    const p = toLayer(sx, sy)
    onAddPoint(
      { x: Math.round(Math.max(-OUT_M, Math.min(layerW + OUT_M, p.x))), y: Math.round(Math.max(-OUT_M, Math.min(layerH + OUT_M, p.y))) },
      points.length > 0 ? points[points.length - 1].scale : 1,
    )
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const raw = pointerToCanvas(e)
    const sx = Math.max(0, Math.min(canvasW, raw.sx))
    const sy = Math.max(0, Math.min(canvasH, raw.sy))
    const p = toLayer(sx, sy)
    const px = Math.round(p.x)
    const py = Math.round(p.y)
    if (drag.mode === 'point') {
      onPatchPoint(drag.id, { x: px, y: py })
    } else if (drag.mode === 'origin') {
      const pt = points.find(x => x.id === drag.id)
      if (pt) onPatchPoint(drag.id, { travel: { ...pt.travel, origin: { kind: 'custom', x: px, y: py } } })
    } else if (drag.mode === 'departure') {
      const pt = points.find(x => x.id === drag.id)
      if (pt?.departure && pt.departure.target.kind === 'custom') {
        onPatchPoint(drag.id, { departure: { ...pt.departure, target: { ...pt.departure.target, x: px, y: py } } })
      }
    } else if (drag.mode === 'cp') {
      if (drag.role === 'ending') {
        if (plan.ending.kind === 'exit') {
          const cps = [...(plan.ending.travel.controlPoints ?? [])]
          if (drag.cpIndex < cps.length) {
            cps[drag.cpIndex] = { x: px, y: py }
            onPatchPlan({ ending: { ...plan.ending, travel: { ...plan.ending.travel, controlPoints: cps } } })
          }
        }
      } else {
        const pt = points.find(x => x.id === drag.id)
        if (!pt) return
        if (drag.role === 'travel') {
          const cps = [...(pt.travel.controlPoints ?? [])]
          if (drag.cpIndex < cps.length) {
            cps[drag.cpIndex] = { x: px, y: py }
            onPatchPoint(pt.id, { travel: { ...pt.travel, controlPoints: cps } })
          }
        } else if (pt.departure) {
          const cps = [...(pt.departure.travel.controlPoints ?? [])]
          if (drag.cpIndex < cps.length) {
            cps[drag.cpIndex] = { x: px, y: py }
            onPatchPoint(pt.id, { departure: { ...pt.departure, travel: { ...pt.departure.travel, controlPoints: cps } } })
          }
        }
      }
    } else {
      const half = frameW / 2
      const clamped = layerW > frameW
        ? Math.max(half, Math.min(layerW - half, p.x))
        : layerW / 2
      onPatchPlan({ cameraX: Math.round(clamped) })
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null
    forceRedraw(n => n + 1)
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId) } catch { /* */ }
  }

  if (plan.backdrop == null) {
    return (
      <div style={{
        border: '1px dashed var(--border)', borderRadius: 4, padding: '48px 16px',
        textAlign: 'center', fontSize: 13, opacity: 0.75,
      }}>
        Importez l'arrière-plan de ce plan (bouton « Importer l'arrière-plan » ci-dessus)
        pour poser le chemin de points du film.
      </div>
    )
  }

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', borderRadius: 4, border: '1px solid #333', cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  )
}
