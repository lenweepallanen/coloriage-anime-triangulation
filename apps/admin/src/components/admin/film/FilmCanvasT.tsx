import { useEffect, useRef, useState } from 'react'
import type { FilmMotionClip, FilmTimelinePlan, FilmWaypoint, Point2D } from '../../../types/project'
import { CAMERA_HANDLE_H, extractVideoFrame0Url, FILM_COLORS } from './filmEditorShared'

/**
 * Canvas SPATIAL du plan actif (mode timeline) : décor (vidéo live) + cadre
 * caméra draggable + waypoints numérotés (clic = ajouter, drag = déplacer,
 * clic droit = supprimer) + chemins des MotionClips (celui sélectionné en
 * surbrillance, CPs draggables) + silhouette du perso à la position du playhead.
 */
export default function FilmCanvasT({
  plan, selectedWaypointId, onSelectWaypoint, onAddWaypoint, onRemoveWaypoint, onPatchWaypoint,
  onPatchPlan, selectedMotionClip, onSelectTravel, onPatchMotionClip, motionGeom, previewPose,
  characterImageUrl, characterImageSize, characterScale, characterOriginU, characterOriginV, characterFacing,
}: {
  plan: FilmTimelinePlan
  selectedWaypointId: string | null
  onSelectWaypoint: (id: string | null) => void
  onAddWaypoint: (p: Point2D) => void
  onRemoveWaypoint: (id: string) => void
  onPatchWaypoint: (id: string, partial: Partial<FilmWaypoint>) => void
  onPatchPlan: (partial: Partial<FilmTimelinePlan>) => void
  selectedMotionClip: FilmMotionClip | null
  /** Clic sur le pointillé d'un trajet → le sélectionner (inspecteur trajet). */
  onSelectTravel: (id: string) => void
  onPatchMotionClip: (id: string, partial: Partial<FilmMotionClip>) => void
  /** Géométrie résolue des clips motion (via le sampler, cohérente avec le moteur). */
  motionGeom: { id: string; from: Point2D; to: Point2D; controlPoints?: Point2D[]; kind: FilmMotionClip['kind'] }[]
  /** Pose du perso au playhead (scrub) : silhouette. null = pas d'aperçu. */
  previewPose: { x: number; y: number; scaleMul: number; flip: 1 | -1 } | null
  characterImageUrl: string | null
  characterImageSize: { w: number; h: number }
  characterScale: number
  characterOriginU: number
  characterOriginV: number
  characterFacing: 'left' | 'right'
}) {
  const waypoints = plan.timeline.waypoints
  const layerW = plan.backdrop?.width ?? 0
  const layerH = plan.backdrop?.height ?? 0

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [canvasW, setCanvasW] = useState(800)
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null)
  const [charImg, setCharImg] = useState<HTMLImageElement | null>(null)
  const dragRef = useRef<
    | { mode: 'waypoint'; id: string }
    | { mode: 'camera' }
    | { mode: 'cp'; clipId: string; cpIndex: number }
    | { mode: 'from'; clipId: string }
    | { mode: 'to'; clipId: string }
    | null
  >(null)

  // Décor : image directe, ou VIDÉO jouée en boucle (frame 0 en placeholder).
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

  // Marge « hors décor » : points plaçables hors du cadre de la vidéo.
  const OUT_M = layerH > 0 ? Math.round(layerH * 0.35) : 0
  const fullW = layerW + 2 * OUT_M
  const fullH = layerH + 2 * OUT_M
  const aspect = fullH > 0 && fullW > 0 ? fullH / fullW : 9 / 16
  const canvasH = Math.round(canvasW * aspect)
  const sX = fullW > 0 ? canvasW / fullW : 1
  const sY = fullH > 0 ? canvasH / fullH : 1
  const toScreen = (p: Point2D) => ({ x: (p.x + OUT_M) * sX, y: (p.y + OUT_M) * sY })
  const toLayer = (sx: number, sy: number): Point2D => ({ x: sx / sX - OUT_M, y: sy / sY - OUT_M })

  const frameHalf = Math.max(1, Math.min(layerW > 0 ? layerW : Number.POSITIVE_INFINITY, layerH * (16 / 9)) / 2)
  const frameLeft = plan.cameraX - frameHalf
  const frameRight = plan.cameraX + frameHalf

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
    const dx = OUT_M * sX
    const dy = OUT_M * sY
    const dw = layerW * sX
    const dh = layerH * sY
    ctx.fillStyle = '#222'
    ctx.fillRect(dx, dy, dw, dh)
    if (bgVideo && bgVideo.readyState >= 2) ctx.drawImage(bgVideo, dx, dy, dw, dh)
    else if (bgImg) ctx.drawImage(bgImg, dx, dy, dw, dh)
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(dx, dy, dw, dh)
    ctx.setLineDash([])

    // Hors-champ assombri + cadre caméra + poignée
    const fl = (frameLeft + OUT_M) * sX
    const fr = (frameRight + OUT_M) * sX
    const ft = dy
    const fb = dy + dh
    ctx.fillStyle = 'rgba(0,0,0,0.45)'
    if (fl > 0) ctx.fillRect(0, 0, fl, canvasH)
    if (fr < canvasW) ctx.fillRect(fr, 0, canvasW - fr, canvasH)
    ctx.fillRect(fl, 0, fr - fl, ft)
    ctx.fillRect(fl, fb, fr - fl, canvasH - fb)
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

    // Silhouette du perso au playhead (scrub) — pose exacte du sampler.
    if (previewPose && charImg && characterImageSize.w > 0) {
      const charHBg = layerH * characterScale * previewPose.scaleMul
      const charWBg = charHBg * (characterImageSize.w / characterImageSize.h)
      const topLeft = toScreen({ x: previewPose.x - characterOriginU * charWBg, y: previewPose.y - characterOriginV * charHBg })
      ctx.save()
      ctx.globalAlpha = 0.6
      // flip -1 = miroir autour de l'ancrage (même convention que le player).
      if (previewPose.flip === -1) {
        const pivotX = toScreen({ x: previewPose.x, y: 0 }).x
        ctx.translate(pivotX, 0)
        ctx.scale(-1, 1)
        ctx.translate(-pivotX, 0)
      }
      ctx.drawImage(charImg, topLeft.x, topLeft.y, charWBg * sX, charHBg * sY)
      ctx.restore()
    }

    // Chemins des clips motion (sélectionné en surbrillance)
    const drawPath = (from: Point2D, to: Point2D, cpsIn: Point2D[] | undefined, color: string, width: number) => {
      const a = toScreen(from)
      const b = toScreen(to)
      const cps = (cpsIn ?? []).map(toScreen)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = width
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
    for (const g of motionGeom) {
      if (g.kind === 'appear') continue
      const isSel = selectedMotionClip?.id === g.id
      drawPath(g.from, g.to, g.controlPoints, isSel ? FILM_COLORS.pointSelected : FILM_COLORS.travel, isSel ? 3 : 2)
      if (isSel && g.controlPoints?.length) {
        for (const c of g.controlPoints) {
          const scp = toScreen(c)
          ctx.beginPath()
          ctx.arc(scp.x, scp.y, 6, 0, Math.PI * 2)
          ctx.fillStyle = FILM_COLORS.controlPoint
          ctx.fill()
          ctx.strokeStyle = '#333'
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
      }
    }

    // Losange « départ » du trajet sélectionné (origine libre, draggable)
    if (selectedMotionClip?.from?.kind === 'free') {
      const f = selectedMotionClip.from
      const sd = toScreen({ x: f.x, y: f.y })
      ctx.beginPath()
      ctx.moveTo(sd.x, sd.y - 9)
      ctx.lineTo(sd.x + 9, sd.y)
      ctx.lineTo(sd.x, sd.y + 9)
      ctx.lineTo(sd.x - 9, sd.y)
      ctx.closePath()
      ctx.fillStyle = FILM_COLORS.travel
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 10px system-ui'
      ctx.textAlign = 'center'
      ctx.fillText('départ', sd.x, sd.y - 13)
      ctx.textAlign = 'left'
    }

    // Losange « sortie » du trajet sélectionné (cible libre, draggable)
    if (selectedMotionClip?.to.kind === 'free') {
      const t = selectedMotionClip.to
      const st = toScreen({ x: t.x, y: t.y })
      ctx.beginPath()
      ctx.moveTo(st.x, st.y - 9)
      ctx.lineTo(st.x + 9, st.y)
      ctx.lineTo(st.x, st.y + 9)
      ctx.lineTo(st.x - 9, st.y)
      ctx.closePath()
      ctx.fillStyle = FILM_COLORS.departure
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 10px system-ui'
      ctx.textAlign = 'center'
      ctx.fillText('sortie', st.x, st.y - 13)
      ctx.textAlign = 'left'
    }

    // Waypoints numérotés
    waypoints.forEach((w, i) => {
      const s = toScreen(w)
      ctx.beginPath()
      ctx.arc(s.x, s.y, 12, 0, Math.PI * 2)
      ctx.fillStyle = w.id === selectedWaypointId ? FILM_COLORS.pointSelected : FILM_COLORS.point
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = w.id === selectedWaypointId ? '#222' : '#fff'
      ctx.font = 'bold 12px system-ui'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), s.x, s.y)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    })
  }, [plan, waypoints, selectedWaypointId, selectedMotionClip, motionGeom, previewPose, bgImg, bgVideo, videoTick, charImg, canvasW, canvasH, sX, sY, characterScale, characterOriginU, characterOriginV, characterFacing, characterImageSize, layerH]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- Interactions ---
  const pointerToCanvas = (e: React.PointerEvent<HTMLCanvasElement>): { sx: number; sy: number } => {
    const el = canvasRef.current
    const rect = (el ?? (e.target as HTMLCanvasElement)).getBoundingClientRect()
    const kx = rect.width > 0 ? canvasW / rect.width : 1
    const ky = rect.height > 0 ? canvasH / rect.height : 1
    return { sx: (e.clientX - rect.left) * kx, sy: (e.clientY - rect.top) * ky }
  }

  const waypointAt = (sx: number, sy: number): FilmWaypoint | null => {
    for (let i = waypoints.length - 1; i >= 0; i--) {
      const s = toScreen(waypoints[i])
      if (Math.hypot(s.x - sx, s.y - sy) <= 15) return waypoints[i]
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { sx, sy } = pointerToCanvas(e)
    const capture = () => (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    if (e.button === 2) {
      const target = waypointAt(sx, sy)
      if (target) onRemoveWaypoint(target.id)
      return
    }
    if (e.button !== 0) return
    // CPs du clip sélectionné
    if (selectedMotionClip?.controlPoints?.length) {
      for (let ci = 0; ci < selectedMotionClip.controlPoints.length; ci++) {
        const scp = toScreen(selectedMotionClip.controlPoints[ci])
        if (Math.hypot(scp.x - sx, scp.y - sy) <= 10) {
          dragRef.current = { mode: 'cp', clipId: selectedMotionClip.id, cpIndex: ci }
          capture()
          return
        }
      }
    }
    // Losange « départ » du trajet sélectionné (origine libre)
    if (selectedMotionClip?.from?.kind === 'free') {
      const f = selectedMotionClip.from
      const sd = toScreen({ x: f.x, y: f.y })
      if (Math.hypot(sd.x - sx, sd.y - sy) <= 12) {
        dragRef.current = { mode: 'from', clipId: selectedMotionClip.id }
        capture()
        return
      }
    }
    if (selectedMotionClip?.to.kind === 'free') {
      const t = selectedMotionClip.to
      const st = toScreen({ x: t.x, y: t.y })
      if (Math.hypot(st.x - sx, st.y - sy) <= 12) {
        dragRef.current = { mode: 'to', clipId: selectedMotionClip.id }
        capture()
        return
      }
    }
    const hit = waypointAt(sx, sy)
    if (hit) {
      onSelectWaypoint(hit.id)
      dragRef.current = { mode: 'waypoint', id: hit.id }
      capture()
      return
    }
    // Clic sur le POINTILLÉ d'un trajet → sélection du trajet (inspecteur).
    {
      const distToSeg = (p: Point2D, a: Point2D, b: Point2D): number => {
        const dx = b.x - a.x, dy = b.y - a.y
        const len2 = dx * dx + dy * dy
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
      }
      const bez = (a: Point2D, cps: Point2D[], b: Point2D, t: number): Point2D => {
        const pts = [a, ...cps, b]
        let work = pts
        while (work.length > 1) {
          const next: Point2D[] = []
          for (let i = 0; i < work.length - 1; i++) {
            next.push({ x: work[i].x + (work[i + 1].x - work[i].x) * t, y: work[i].y + (work[i + 1].y - work[i].y) * t })
          }
          work = next
        }
        return work[0]
      }
      for (const g of motionGeom) {
        if (g.kind === 'appear') continue
        const a = toScreen(g.from)
        const b = toScreen(g.to)
        const cps = (g.controlPoints ?? []).map(toScreen)
        let minD = Number.POSITIVE_INFINITY
        let prev = a
        const steps = cps.length > 0 ? 24 : 1
        for (let i = 1; i <= steps; i++) {
          const pt = cps.length > 0 ? bez(a, cps, b, i / steps) : b
          minD = Math.min(minD, distToSeg({ x: sx, y: sy }, prev, pt))
          prev = pt
        }
        if (minD <= 8) {
          onSelectTravel(g.id)
          return
        }
      }
    }
    // Poignée caméra (bandeau au sommet du décor)
    const camTop = OUT_M * sY
    if (sy >= camTop && sy <= camTop + CAMERA_HANDLE_H
      && sx >= (frameLeft + OUT_M) * sX && sx <= (frameRight + OUT_M) * sX) {
      dragRef.current = { mode: 'camera' }
      capture()
      return
    }
    // Clic dans le vide : nouveau waypoint
    const p = toLayer(sx, sy)
    onAddWaypoint({
      x: Math.round(Math.max(-OUT_M, Math.min(layerW + OUT_M, p.x))),
      y: Math.round(Math.max(-OUT_M, Math.min(layerH + OUT_M, p.y))),
    })
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
    if (drag.mode === 'waypoint') {
      onPatchWaypoint(drag.id, { x: px, y: py })
    } else if (drag.mode === 'from') {
      onPatchMotionClip(drag.clipId, { from: { kind: 'free', x: px, y: py } })
    } else if (drag.mode === 'to') {
      onPatchMotionClip(drag.clipId, { to: { kind: 'free', x: px, y: py } })
    } else if (drag.mode === 'cp') {
      const cps = [...(selectedMotionClip?.controlPoints ?? [])]
      if (selectedMotionClip && drag.cpIndex < cps.length) {
        cps[drag.cpIndex] = { x: px, y: py }
        onPatchMotionClip(drag.clipId, { controlPoints: cps })
      }
    } else {
      const clamped = layerW > frameHalf * 2
        ? Math.max(frameHalf, Math.min(layerW - frameHalf, p.x))
        : layerW / 2
      onPatchPlan({ cameraX: Math.round(clamped) })
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId) } catch { /* */ }
  }

  if (plan.backdrop == null) {
    return (
      <div style={{
        border: '1px dashed var(--border)', borderRadius: 4, padding: '48px 16px',
        textAlign: 'center', fontSize: 13, opacity: 0.75,
      }}>
        Importez l'arrière-plan de ce plan pour poser les points et les clips du film.
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
