import { useEffect, useMemo, useRef, useState } from 'react'
import type { Animation, Point2D, Scene, SceneWalkTrapezoid } from '../../types/project'
import { defaultTrapezoid } from '../../utils/sceneTrapezoid'

/** Preview wireframe d'un cycle de marche : démarre à `startFrame`, joue 1 cycle, pause 2s, repeat. */
function WalkCyclePreview({ anim, startFrame }: { anim: Animation | undefined; startFrame: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)

  // Aplatit les frames du body + zones en un seul tableau de points par frame.
  const flatFrames = useMemo<Point2D[][] | null>(() => {
    const m = anim?.mesh
    if (!m) return null
    if (m.videoFramesMesh && m.videoFramesMesh.length > 0) return m.videoFramesMesh
    const body = m.walkBodyFrames
    const zones = m.walkZoneFrames
    if (!body || body.length === 0) return null
    const out: Point2D[][] = []
    for (let f = 0; f < body.length; f++) {
      const arr: Point2D[] = [...body[f]]
      if (zones) {
        for (const zid of Object.keys(zones)) {
          const zf = zones[zid]?.[f]
          if (zf) arr.push(...zf)
        }
      }
      out.push(arr)
    }
    return out
  }, [anim])

  useEffect(() => {
    const c = canvasRef.current
    if (!c || !flatFrames || flatFrames.length === 0) return
    const fps = 24
    const cycleMs = (flatFrames.length / fps) * 1000
    const pauseMs = 2000
    const period = cycleMs + pauseMs
    const start = performance.now()
    const sf = ((startFrame % flatFrames.length) + flatFrames.length) % flatFrames.length

    const tick = (t: number) => {
      const elapsed = (t - start) % period
      let idx: number
      if (elapsed < cycleMs) {
        idx = (sf + Math.floor((elapsed / 1000) * fps)) % flatFrames.length
      } else {
        idx = sf // pause sur la frame de départ
      }
      const pts = flatFrames[idx]
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of pts) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
      const w = Math.max(1, maxX - minX)
      const h = Math.max(1, maxY - minY)
      const s = Math.min(c.width / (w * 1.2), c.height / (h * 1.2))
      const ox = (c.width - w * s) / 2 - minX * s
      const oy = (c.height - h * s) / 2 - minY * s
      const ctx = c.getContext('2d')
      if (!ctx) return
      ctx.fillStyle = '#161616'
      ctx.fillRect(0, 0, c.width, c.height)
      // Points
      ctx.fillStyle = elapsed < cycleMs ? '#4caf50' : '#ffb74d'
      for (const p of pts) {
        ctx.beginPath()
        ctx.arc(p.x * s + ox, p.y * s + oy, 1.6, 0, Math.PI * 2)
        ctx.fill()
      }
      // Frame index
      ctx.fillStyle = '#fff'
      ctx.font = '11px monospace'
      ctx.fillText(`f=${idx}${elapsed >= cycleMs ? ' (pause)' : ''}`, 6, 14)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [flatFrames, startFrame])

  if (!anim) return <div style={{ fontSize: 12, opacity: 0.7 }}>Sélectionne une animation marche pour voir la preview.</div>
  if (!flatFrames) return <div style={{ fontSize: 12, opacity: 0.7 }}>Animation pas encore calculée.</div>

  return (
    <canvas
      ref={canvasRef}
      width={260}
      height={180}
      style={{ display: 'block', width: 260, height: 180, borderRadius: 4, border: '1px solid #333', background: '#161616' }}
    />
  )
}

interface Props {
  scene: Scene
  animations: Animation[]
  backgroundUrl: string | null
  layerWidth: number
  layerHeight: number
  onChange: (trap: SceneWalkTrapezoid | null) => void
}

type CornerKey = 'topLeft' | 'topRight' | 'bottomRight' | 'bottomLeft'

const CORNERS: CornerKey[] = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']

/**
 * Éditeur du trapèze de marche : drag des 4 coins + sliders perspective + sélecteur anim 'marche'.
 */
export default function SceneWalkZoneEditor({ scene, animations, backgroundUrl, layerWidth, layerHeight, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null)
  const [drag, setDrag] = useState<CornerKey | null>(null)
  const [canvasW, setCanvasW] = useState(800)
  const trap = scene.walkTrapezoid ?? null

  const marcheAnims = animations.filter(a => a.type === 'marche')

  useEffect(() => {
    if (!backgroundUrl) { setBgImg(null); return }
    const img = new Image()
    img.src = backgroundUrl
    img.onload = () => setBgImg(img)
    return () => { /* */ }
  }, [backgroundUrl])

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setCanvasW(Math.max(200, e.contentRect.width))
    })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const aspect = layerHeight > 0 && layerWidth > 0 ? layerHeight / layerWidth : 9 / 16
  const canvasH = Math.round(canvasW * aspect)
  const sX = layerWidth > 0 ? canvasW / layerWidth : 1
  const sY = layerHeight > 0 ? canvasH / layerHeight : 1
  const toScreen = (p: Point2D) => ({ x: p.x * sX, y: p.y * sY })
  const toLayer = (sx: number, sy: number): Point2D => ({ x: sx / sX, y: sy / sY })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = canvasW
    canvas.height = canvasH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#222'
    ctx.fillRect(0, 0, canvasW, canvasH)
    if (bgImg) ctx.drawImage(bgImg, 0, 0, canvasW, canvasH)
    if (!trap) return
    const tl = toScreen(trap.topLeft)
    const tr = toScreen(trap.topRight)
    const br = toScreen(trap.bottomRight)
    const bl = toScreen(trap.bottomLeft)
    ctx.fillStyle = 'rgba(80, 160, 255, 0.18)'
    ctx.beginPath()
    ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = '#3a8eff'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])
    // Marque le "haut" (loin) et "bas" (proche)
    ctx.fillStyle = '#fff'
    ctx.font = '11px system-ui'
    ctx.fillText('loin (top)', (tl.x + tr.x) / 2 - 22, tl.y - 4)
    ctx.fillText('proche (bottom)', (bl.x + br.x) / 2 - 40, br.y + 14)
    // Coins
    for (const key of CORNERS) {
      const p = toScreen(trap[key])
      ctx.fillStyle = drag === key ? '#ffeb3b' : '#3a8eff'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }, [bgImg, canvasW, canvasH, trap, drag, sX, sY])

  function getCornerAt(sx: number, sy: number): CornerKey | null {
    if (!trap) return null
    for (const key of CORNERS) {
      const p = toScreen(trap[key])
      if (Math.hypot(p.x - sx, p.y - sy) <= 14) return key
    }
    return null
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!trap) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const k = getCornerAt(sx, sy)
    if (k) {
      setDrag(k)
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
    }
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag || !trap) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const p = toLayer(Math.max(0, Math.min(canvasW, sx)), Math.max(0, Math.min(canvasH, sy)))
    onChange({ ...trap, [drag]: p })
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    setDrag(null)
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId) } catch { /* */ }
  }

  const enabled = trap != null
  const update = (partial: Partial<SceneWalkTrapezoid>) => {
    if (!trap) return
    onChange({ ...trap, ...partial })
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              if (e.target.checked) {
                const animId = marcheAnims[0]?.id ?? ''
                onChange(defaultTrapezoid(layerWidth, layerHeight, animId))
              } else {
                onChange(null)
              }
            }}
          />
          <span>Activer la marche libre</span>
        </label>
      </div>

      {enabled && trap && (
        <>
          <div className="scene-editor-section-grid" style={{ marginBottom: 12 }}>
            <div className="scene-editor-field">
              <label>Animation marche</label>
              <select
                value={trap.walkAnimationId}
                onChange={e => update({ walkAnimationId: e.target.value })}
              >
                <option value="">(Aucune)</option>
                {marcheAnims.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              {marcheAnims.length === 0 && (
                <span className="scene-config-panel-empty">Aucune animation type 'marche' dans le projet.</span>
              )}
            </div>
            <div className="scene-editor-field">
              <label>Seuil pente (°) — {trap.walkSteepAngleThresholdDeg ?? 20}</label>
              <input
                type="range" min={0} max={89} step={1}
                value={trap.walkSteepAngleThresholdDeg ?? 20}
                onChange={e => update({ walkSteepAngleThresholdDeg: parseInt(e.target.value, 10) })}
              />
              <span style={{ fontSize: 11, opacity: 0.7 }}>Au-delà de cet angle (depuis l'horizontale), le trajet passe par un wrap edge→edge.</span>
            </div>
            <div className="scene-editor-field">
              <label>Vitesse (px/s) — {trap.walkSpeedPxPerSec}</label>
              <input
                type="range" min={50} max={1200} step={10}
                value={trap.walkSpeedPxPerSec}
                onChange={e => update({ walkSpeedPxPerSec: parseInt(e.target.value, 10) })}
              />
            </div>
            <div className="scene-editor-field" style={{ gridColumn: '1 / -1' }}>
              <label>Frame de démarrage du cycle — {trap.walkStartFrame ?? 0}</label>
              <input
                type="range" min={0} max={120} step={1}
                value={trap.walkStartFrame ?? 0}
                onChange={e => update({ walkStartFrame: parseInt(e.target.value, 10) })}
              />
              <span style={{ fontSize: 11, opacity: 0.7 }}>Aligne le départ sur une frame "pas naturel" (jambe qui se lève). La preview joue 1 cycle puis pause 2 s.</span>
              <div style={{ marginTop: 8 }}>
                <WalkCyclePreview
                  anim={animations.find(a => a.id === trap.walkAnimationId)}
                  startFrame={trap.walkStartFrame ?? 0}
                />
              </div>
            </div>
            <div className="scene-editor-field">
              <label>Scale au sommet (loin) — {trap.scaleAtTop.toFixed(2)}×</label>
              <input
                type="range" min={0.3} max={1.2} step={0.01}
                value={trap.scaleAtTop}
                onChange={e => update({ scaleAtTop: parseFloat(e.target.value) })}
              />
            </div>
            <div className="scene-editor-field">
              <label>Scale en bas (proche) — {trap.scaleAtBottom.toFixed(2)}×</label>
              <input
                type="range" min={0.5} max={2.0} step={0.01}
                value={trap.scaleAtBottom}
                onChange={e => update({ scaleAtBottom: parseFloat(e.target.value) })}
              />
            </div>
            <div className="scene-editor-field">
              <label>Inclinaison max (°) — {trap.tiltDegMax.toFixed(1)}</label>
              <input
                type="range" min={0} max={20} step={0.5}
                value={trap.tiltDegMax}
                onChange={e => update({ tiltDegMax: parseFloat(e.target.value) })}
              />
            </div>
            <div className="scene-editor-field">
              <label>Skew vertical max — {trap.skewYMax.toFixed(2)}</label>
              <input
                type="range" min={0} max={0.3} step={0.01}
                value={trap.skewYMax}
                onChange={e => update({ skewYMax: parseFloat(e.target.value) })}
              />
            </div>
          </div>

          <div ref={wrapRef} style={{ width: '100%' }}>
            <canvas
              ref={canvasRef}
              style={{ display: 'block', width: '100%', height: canvasH, cursor: drag ? 'grabbing' : 'default', borderRadius: 4, border: '1px solid #333' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
          <p style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            Glisse les 4 coins pour ajuster la zone de marche. Le sommet (top) = loin, le bas (bottom) = proche.
          </p>
        </>
      )}
    </div>
  )
}
