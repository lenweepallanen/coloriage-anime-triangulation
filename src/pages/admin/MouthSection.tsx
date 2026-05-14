import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminContext } from './AdminLayout'
import {
  DEFAULT_MOUTH_MAX_OPEN_DEG,
  type BarycentricRef,
  type BezierNode,
  type MouthDefinition,
  type Point2D,
  type Project,
} from '../../types/project'
import { findContainingAnchorTriangle, interpolateInternalPoint } from '../../utils/barycentricUtils'
import { flattenClosedBezier } from '../../utils/bezierUtils'
import { getEyeBodyMeshData } from '../../utils/eyeBlinkOverlay'
import { loadMouthAudio, type MouthAudioPlayer } from '../../utils/mouthAudioAnalyser'
import MouthPixiPreview from '../../components/admin/MouthPixiPreview'
import { useCanvasInteraction } from '../../components/triangulation/useCanvasInteraction'

type Phase = 'contour' | 'hinge'

const SAMPLES_PER_SEGMENT = 24
const NODE_RADIUS = 6
const HANDLE_RADIUS = 4
const HIT_RADIUS_SQ = 12 * 12

interface DraftMouth {
  nodes: BezierNode[]
  hinge: Point2D | null
  maxOpenAngleDeg: number
  rotationSign: 1 | -1
}

function defaultDraftFromMouth(m: MouthDefinition | null): DraftMouth {
  return {
    nodes: m?.bezierNodes.map(n => ({
      anchor: { ...n.anchor },
      handleIn: { ...n.handleIn },
      handleOut: { ...n.handleOut },
      smooth: n.smooth,
    })) ?? [],
    hinge: null,
    maxOpenAngleDeg: m?.maxOpenAngleDeg ?? DEFAULT_MOUTH_MAX_OPEN_DEG,
    rotationSign: m?.rotationSign ?? 1,
  }
}

function distSq(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x, dy = a.y - b.y
  return dx * dx + dy * dy
}

function rotatePoint(p: Point2D, pivot: Point2D, angleRad: number): Point2D {
  const c = Math.cos(angleRad), s = Math.sin(angleRad)
  const dx = p.x - pivot.x, dy = p.y - pivot.y
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c }
}

export default function MouthSection() {
  const { project, save } = useAdminContext()
  // Stable ref : getEyeBodyMeshData renvoie un objet neuf à chaque appel.
  // Sans memo, le re-render audio (RAF setLiveOpenness) recrée bodyMesh →
  // MouthPixiPreview détruit/recrée l'app PIXI à chaque frame → flicker blanc.
  const bodyMesh = useMemo(
    () => getEyeBodyMeshData(project),
    [project.projectTriangulation, project.animations],
  )
  const hasBodyMesh = bodyMesh != null && bodyMesh.bodyTriangles.length > 0
  const imageBlob = project.originalImageBlob

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasContainerRef = useRef<HTMLDivElement | null>(null)
  const [imageBitmap, setImageBitmap] = useState<HTMLImageElement | null>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const fittedRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('contour')
  const [draft, setDraft] = useState<DraftMouth>(() => {
    const m = project.projectMouth
    const d = defaultDraftFromMouth(m)
    if (!m || !bodyMesh) return d
    const ref = m.hingeBodyAnchor ?? m.hingeAnchor
    if (ref && bodyMesh.bodyTriangles[ref.anchorTriangleIndex]) {
      d.hinge = interpolateInternalPoint(ref, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)
    }
    return d
  })
  const [showPreview, setShowPreview] = useState(false)

  // Audio test
  const playerRef = useRef<MouthAudioPlayer | null>(null)
  const rafRef = useRef<number | null>(null)
  const [audioName, setAudioName] = useState<string | null>(null)
  const [audioLoading, setAudioLoading] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [manualOpenness, setManualOpenness] = useState(0)
  const [liveOpenness, setLiveOpenness] = useState(0)

  const dragRef = useRef<{ type: 'anchor' | 'handleIn' | 'handleOut'; index: number } | null>(null)

  // Load image
  useEffect(() => {
    if (!imageBlob) { setImageBitmap(null); return }
    const url = URL.createObjectURL(imageBlob)
    const img = new Image()
    img.onload = () => setImageBitmap(img)
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [imageBlob])

  // Resize canvas : observe le CONTAINER (pas le canvas), redimensionne le
  // drawing buffer et la taille CSS du canvas. NE TOUCHE PAS au transform.
  useEffect(() => {
    const container = canvasContainerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const resize = () => {
      const { width, height } = container.getBoundingClientRect()
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Fit initial : une seule fois quand l'image est chargée. Ensuite le pan/zoom
  // utilisateur prend le relais — on ne refit jamais sauf changement d'image.
  useEffect(() => {
    if (!imageBitmap) { fittedRef.current = false; return }
    if (fittedRef.current) return
    fitToCanvas(imageBitmap.naturalWidth, imageBitmap.naturalHeight)
    fittedRef.current = true
  }, [imageBitmap, fitToCanvas])

  const openness = isPlaying ? liveOpenness : manualOpenness
  const angleRad = (openness * draft.maxOpenAngleDeg * draft.rotationSign * Math.PI) / 180

  const flattened = useMemo(() => {
    if (draft.nodes.length < 2) return [] as Point2D[]
    return flattenClosedBezier(draft.nodes, SAMPLES_PER_SEGMENT)
  }, [draft.nodes])

  const rotatedFlattened = useMemo(() => {
    if (!draft.hinge || flattened.length === 0 || Math.abs(angleRad) < 1e-4) return null
    return flattened.map(p => rotatePoint(p, draft.hinge!, angleRad))
  }, [flattened, draft.hinge, angleRad])

  // Refs lues par la boucle RAF (évite de re-créer la boucle à chaque draft).
  const drawStateRef = useRef({ imageBitmap, bodyMesh, flattened, rotatedFlattened, draft, phase })
  drawStateRef.current = { imageBitmap, bodyMesh, flattened, rotatedFlattened, draft, phase }

  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { imageBitmap, bodyMesh, flattened, rotatedFlattened, draft, phase } = drawStateRef.current
    if (!imageBitmap) return
    if (canvas.width === 0 || canvas.height === 0) return
    const ctx = canvas.getContext('2d')!
    const t = transformRef.current
    const s = t.scale
    const dpr = window.devicePixelRatio || 1
    // setTransform absolu : DPR appliqué, le ctx repart de zéro à chaque frame.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cssW = canvas.width / dpr
    const cssH = canvas.height / dpr
    ctx.clearRect(0, 0, cssW, cssH)
    ctx.save()
    // Pan/zoom utilisateur (en CSS px), puis dessin en coords image.
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(s, s)
    ctx.drawImage(imageBitmap, 0, 0)

    // Tailles écran constantes : on divise par s pour les rayons / line widths / fonts.
    const inv = 1 / s

    if (bodyMesh && bodyMesh.bodyTriangles.length > 0) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.10)'
      ctx.lineWidth = 1 * inv
      for (const [a, b, c] of bodyMesh.bodyTriangles) {
        const pa = bodyMesh.bodyPoints[a], pb = bodyMesh.bodyPoints[b], pc = bodyMesh.bodyPoints[c]
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.lineTo(pc.x, pc.y)
        ctx.closePath()
        ctx.stroke()
      }
    }

    if (flattened.length > 2) {
      ctx.beginPath()
      flattened.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
      })
      ctx.closePath()
      ctx.fillStyle = rotatedFlattened ? 'rgba(255, 100, 180, 0.06)' : 'rgba(255, 100, 180, 0.18)'
      ctx.strokeStyle = rotatedFlattened ? 'rgba(214, 33, 127, 0.4)' : '#d6217f'
      ctx.lineWidth = 2 * inv
      ctx.setLineDash(rotatedFlattened ? [4 * inv, 4 * inv] : [])
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (rotatedFlattened) {
      ctx.beginPath()
      rotatedFlattened.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y)
      })
      ctx.closePath()
      ctx.fillStyle = 'rgba(255, 160, 80, 0.35)'
      ctx.strokeStyle = '#d96a00'
      ctx.lineWidth = 2 * inv
      ctx.fill()
      ctx.stroke()
    }

    draft.nodes.forEach((node, i) => {
      const ax = node.anchor.x, ay = node.anchor.y
      if (node.smooth && phase === 'contour') {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'
        ctx.lineWidth = 1 * inv
        ctx.beginPath()
        ctx.moveTo(node.handleIn.x, node.handleIn.y)
        ctx.lineTo(ax, ay)
        ctx.lineTo(node.handleOut.x, node.handleOut.y)
        ctx.stroke()
        for (const h of [node.handleIn, node.handleOut]) {
          ctx.beginPath()
          ctx.arc(h.x, h.y, HANDLE_RADIUS * inv, 0, Math.PI * 2)
          ctx.fillStyle = '#999'
          ctx.fill()
        }
      }
      ctx.beginPath()
      ctx.arc(ax, ay, NODE_RADIUS * inv, 0, Math.PI * 2)
      ctx.fillStyle = '#d6217f'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5 * inv
      ctx.stroke()
      ctx.fillStyle = '#222'
      ctx.font = `${11 * inv}px sans-serif`
      ctx.fillText(String(i), ax + 8 * inv, ay - 8 * inv)
    })

    if (draft.hinge) {
      const hx = draft.hinge.x, hy = draft.hinge.y
      ctx.beginPath()
      ctx.arc(hx, hy, 8 * inv, 0, Math.PI * 2)
      ctx.fillStyle = '#22c55e'
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2 * inv
      ctx.stroke()
      ctx.fillStyle = '#22c55e'
      ctx.font = `bold ${11 * inv}px sans-serif`
      ctx.fillText('charnière', hx + 12 * inv, hy - 6 * inv)
    }
    ctx.restore()
  }, [transformRef])

  // Boucle RAF continue : lit transformRef + drawStateRef à chaque frame.
  // Pas besoin de bumper sur pan/zoom — le prochain frame voit la nouvelle transform.
  useEffect(() => {
    let running = true
    let rafId = 0
    const loop = () => {
      if (!running) return
      rafId = requestAnimationFrame(loop)
      drawFrame()
    }
    rafId = requestAnimationFrame(loop)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [drawFrame])

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      setLiveOpenness(0)
      return
    }
    const tick = () => {
      const p = playerRef.current
      if (p) setLiveOpenness(p.getRMS())
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [isPlaying])

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    playerRef.current?.cleanup()
  }, [])

  function canvasPoint(ev: React.MouseEvent<HTMLCanvasElement>): Point2D {
    return screenToImage(ev.clientX, ev.clientY)
  }

  function hitTestNode(p: Point2D): { type: 'anchor' | 'handleIn' | 'handleOut'; index: number } | null {
    const s = transformRef.current.scale
    const r2 = HIT_RADIUS_SQ / (s * s)
    for (let i = 0; i < draft.nodes.length; i++) {
      const n = draft.nodes[i]
      if (distSq(p, n.anchor) < r2) return { type: 'anchor', index: i }
      if (n.smooth) {
        if (distSq(p, n.handleIn) < r2) return { type: 'handleIn', index: i }
        if (distSq(p, n.handleOut) < r2) return { type: 'handleOut', index: i }
      }
    }
    return null
  }

  function handleMouseDown(ev: React.MouseEvent<HTMLCanvasElement>) {
    // Pan : bouton milieu OU espace + clic gauche (géré par useCanvasInteraction).
    // On ignore le clic ici pour ne pas créer de nœud.
    if (ev.button === 1 || (ev.button === 0 && spaceDown.current)) return
    if (ev.button === 2) return
    const p = canvasPoint(ev)
    if (phase === 'contour') {
      const hit = hitTestNode(p)
      if (hit) { dragRef.current = hit; return }
      const newNode: BezierNode = {
        anchor: { ...p },
        handleIn: { x: p.x - 20, y: p.y },
        handleOut: { x: p.x + 20, y: p.y },
        smooth: false,
      }
      setDraft(d => ({ ...d, nodes: [...d.nodes, newNode] }))
      return
    }
    if (phase === 'hinge') {
      setDraft(d => ({ ...d, hinge: p }))
      return
    }
  }

  function handleMouseMove(ev: React.MouseEvent<HTMLCanvasElement>) {
    // Pan en cours : la boucle RAF redessine déjà, on skip juste le drag node.
    if (isPanning.current) return
    const drag = dragRef.current
    if (!drag) return
    const p = canvasPoint(ev)
    setDraft(d => {
      const nodes = d.nodes.map((n, i) => {
        if (i !== drag.index) return n
        if (drag.type === 'anchor') {
          const dx = p.x - n.anchor.x, dy = p.y - n.anchor.y
          return {
            ...n,
            anchor: { ...p },
            handleIn: { x: n.handleIn.x + dx, y: n.handleIn.y + dy },
            handleOut: { x: n.handleOut.x + dx, y: n.handleOut.y + dy },
          }
        }
        if (drag.type === 'handleIn') {
          const mirrored = { x: 2 * n.anchor.x - p.x, y: 2 * n.anchor.y - p.y }
          return { ...n, handleIn: { ...p }, handleOut: mirrored }
        }
        const mirrored = { x: 2 * n.anchor.x - p.x, y: 2 * n.anchor.y - p.y }
        return { ...n, handleOut: { ...p }, handleIn: mirrored }
      })
      return { ...d, nodes }
    })
  }

  function handleMouseUp() { dragRef.current = null }

  function handleDoubleClick(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (phase !== 'contour') return
    const p = canvasPoint(ev)
    const hit = hitTestNode(p)
    if (!hit || hit.type !== 'anchor') return
    setDraft(d => ({
      ...d,
      nodes: d.nodes.map((n, i) => {
        if (i !== hit.index) return n
        if (!n.smooth) {
          const prev = d.nodes[(i - 1 + d.nodes.length) % d.nodes.length].anchor
          const next = d.nodes[(i + 1) % d.nodes.length].anchor
          const tx = (next.x - prev.x) * 0.25
          const ty = (next.y - prev.y) * 0.25
          return {
            ...n,
            smooth: true,
            handleIn: { x: n.anchor.x - tx, y: n.anchor.y - ty },
            handleOut: { x: n.anchor.x + tx, y: n.anchor.y + ty },
          }
        }
        return { ...n, smooth: false }
      }),
    }))
  }

  function handleContextMenu(ev: React.MouseEvent<HTMLCanvasElement>) {
    ev.preventDefault()
    if (phase !== 'contour') return
    const p = canvasPoint(ev)
    const hit = hitTestNode(p)
    if (!hit || hit.type !== 'anchor') return
    setDraft(d => ({ ...d, nodes: d.nodes.filter((_, i) => i !== hit.index) }))
  }

  async function handleAudioFile(file: File) {
    playerRef.current?.cleanup()
    playerRef.current = null
    setIsPlaying(false)
    setAudioError(null)
    setAudioLoading(true)
    setAudioName(file.name)
    try {
      const player = await loadMouthAudio(file, { onEnded: () => setIsPlaying(false) })
      playerRef.current = player
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Mouth] decode audio failed', err)
      setAudioError('Décodage audio impossible : ' + msg)
      setAudioName(null)
    } finally {
      setAudioLoading(false)
    }
  }

  async function togglePlay() {
    const player = playerRef.current
    if (!player) return
    if (isPlaying) {
      player.stop()
      setIsPlaying(false)
      return
    }
    try {
      await player.play()
      setIsPlaying(true)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[Mouth] audio play failed', err)
      setAudioError('Lecture audio impossible : ' + msg)
    }
  }

  const canSave = draft.nodes.length >= 3 && draft.hinge != null && hasBodyMesh

  // Preview live: si la bouche est sauvegardée OU si le draft est complet → construire MouthDefinition partiel
  const previewMouth: MouthDefinition | null = useMemo(() => {
    if (!canSave || !bodyMesh) return project.projectMouth
    const contourBodyAnchors = draft.nodes.map(n =>
      findContainingAnchorTriangle(n.anchor, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)!
    )
    const hingeBodyAnchor = findContainingAnchorTriangle(draft.hinge!, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)!
    return {
      bezierNodes: draft.nodes,
      contourAnchors: contourBodyAnchors,
      contourBodyAnchors,
      hingeAnchor: hingeBodyAnchor,
      hingeBodyAnchor,
      maxOpenAngleDeg: draft.maxOpenAngleDeg,
      rotationSign: draft.rotationSign,
    }
  }, [canSave, bodyMesh, draft, project.projectMouth])

  async function handleSave() {
    if (!canSave || !bodyMesh) return
    const contourBodyAnchors: BarycentricRef[] = draft.nodes.map(n =>
      findContainingAnchorTriangle(n.anchor, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)!
    )
    const hingeBodyAnchor = findContainingAnchorTriangle(draft.hinge!, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)!
    const mouth: MouthDefinition = {
      bezierNodes: draft.nodes,
      contourAnchors: contourBodyAnchors,
      contourBodyAnchors,
      hingeAnchor: hingeBodyAnchor,
      hingeBodyAnchor,
      maxOpenAngleDeg: draft.maxOpenAngleDeg,
      rotationSign: draft.rotationSign,
    }
    const next: Project = { ...project, projectMouth: mouth }
    await save(next)
  }

  async function handleClear() {
    if (!confirm('Supprimer la bouche définie ?')) return
    setDraft(defaultDraftFromMouth(null))
    if (project.projectMouth) {
      await save({ ...project, projectMouth: null })
    }
  }

  if (!imageBlob) {
    return (
      <div className="admin-section-disabled" style={{ padding: 16 }}>
        <p>Importez d'abord une image de coloriage dans Paramètres.</p>
      </div>
    )
  }

  if (!hasBodyMesh) {
    return (
      <div style={{ padding: 16 }}>
        <h2>Bouche</h2>
        <p style={{ color: 'var(--color-danger,#c00)' }}>
          La triangulation projet doit être complète avant de définir la bouche.
          Complétez l'onglet "Triangulation" (ou définissez une animation walk).
        </p>
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ padding: 16 }}>
      <h2>Bouche animée</h2>
      <p style={{ opacity: 0.8, fontSize: 14 }}>
        Dessinez le contour de la <strong>mâchoire basse</strong> par une courbe Bézier fermée,
        puis placez la <strong>charnière</strong> autour de laquelle elle pivote. La mâchoire
        s'ouvre en rotation rigide quand un son de voix joue.
      </p>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 600px', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            {(['contour', 'hinge'] as Phase[]).map(p => (
              <button
                key={p}
                className={`btn-sm ${phase === p ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setPhase(p)}
              >
                {p === 'contour' && '1. Contour mâchoire basse'}
                {p === 'hinge' && '2. Charnière'}
              </button>
            ))}
          </div>

          <div
            ref={canvasContainerRef}
            style={{
              width: '100%',
              height: '70vh',
              boxSizing: 'border-box',
              border: '1px solid var(--color-border,#ccc)',
              overflow: 'hidden',
              background: '#fff',
              position: 'relative',
            }}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onDoubleClick={handleDoubleClick}
              onContextMenu={handleContextMenu}
              style={{
                cursor: 'crosshair',
                display: 'block',
                userSelect: 'none',
              }}
            />
          </div>

          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.7 }}>
            {phase === 'contour' && 'Clic = ajouter nœud · Double-clic = lisse/anguleux · Drag = déplacer · Clic droit = supprimer'}
            {phase === 'hinge' && 'Cliquez à l\'endroit où la mâchoire pivote (commissure / articulation).'}
          </div>
        </div>

        <div style={{ flex: '0 0 320px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <h3 style={{ margin: '4px 0' }}>Paramètres</h3>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <span>Angle d'ouverture max (°): <strong>{draft.maxOpenAngleDeg}</strong></span>
              <input type="range" min={2} max={60} step={1} value={draft.maxOpenAngleDeg}
                onChange={e => setDraft(d => ({ ...d, maxOpenAngleDeg: parseInt(e.target.value, 10) }))} />
            </label>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={draft.rotationSign === -1}
                onChange={e => setDraft(d => ({ ...d, rotationSign: e.target.checked ? -1 : 1 }))} />
              <span>Inverser le sens de rotation</span>
            </label>
          </div>

          <div style={{ borderTop: '1px solid #eee', paddingTop: 12 }}>
            <h3 style={{ margin: '4px 0' }}>Test</h3>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <span>Ouverture manuelle: <strong>{(manualOpenness * 100).toFixed(0)}%</strong></span>
              <input type="range" min={0} max={1} step={0.01} value={manualOpenness}
                disabled={isPlaying}
                onChange={e => setManualOpenness(parseFloat(e.target.value))} />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <span>Son de test:</span>
              <input type="file" accept="audio/*"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) handleAudioFile(f)
                }} />
            </label>

            {audioLoading && <div style={{ fontSize: 12, opacity: 0.7 }}>Décodage en cours…</div>}
            {audioError && <div style={{ fontSize: 12, color: 'var(--color-danger,#c00)' }}>{audioError}</div>}

            {audioName && playerRef.current && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>{audioName}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn-primary btn-sm" onClick={togglePlay}>
                    {isPlaying ? 'Stop' : 'Lecture'}
                  </button>
                  <div style={{ flex: 1, fontSize: 12, opacity: 0.8 }}>
                    RMS: {(liveOpenness * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid #eee', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button className="btn-secondary btn-sm" onClick={() => setShowPreview(p => !p)} disabled={!previewMouth}>
              {showPreview ? 'Masquer preview' : 'Afficher preview texture'}
            </button>
            <button className="btn-primary" onClick={handleSave} disabled={!canSave}>
              Sauvegarder
            </button>
            {!canSave && (
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                Pour sauvegarder : ≥ 3 nœuds + charnière placée.
              </div>
            )}
            <button className="btn-danger btn-sm" onClick={handleClear}>
              Tout effacer
            </button>
          </div>
        </div>
      </div>

      {showPreview && previewMouth && bodyMesh && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 16 }}>
          <h3 style={{ margin: '0 0 8px' }}>Preview texture (live)</h3>
          <p style={{ fontSize: 13, opacity: 0.7, marginTop: 0 }}>
            Mâchoire basse texturée par-dessus le maillage body. L'ouverture suit le slider manuel
            ou le son joué dans le panneau Test.
          </p>
          <MouthPixiPreview
            imageBlob={imageBlob}
            bodyMesh={bodyMesh}
            mouth={previewMouth}
            openness={openness}
          />
        </div>
      )}
    </div>
  )
}
