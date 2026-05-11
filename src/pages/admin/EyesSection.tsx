import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminContext } from './AdminLayout'
import {
  DEFAULT_PROJECT_EYES,
  getGeometryOwner,
  type EyeRegion,
  type Point2D,
  type Project,
  type ProjectEyes,
} from '../../types/project'
import { getEyeBodyMeshData } from '../../utils/eyeBlinkOverlay'
import { detectEyeContour } from '../../utils/perspectiveCorrection'
import { computeAllBarycentrics } from '../../utils/barycentricUtils'

function ensureEyes(p: Project): ProjectEyes {
  return p.projectEyes ?? { ...DEFAULT_PROJECT_EYES, regions: [] }
}

function buildFrame0TrackedPositions(mesh: NonNullable<Project['animations'][number]['mesh']>): Point2D[] {
  const nCA = mesh.contourAnchors.length
  const nCS = mesh.contourSubdivisionPoints.length
  const nAP = mesh.anchorPoints.length
  const frames = mesh.videoFramesMesh
  if (frames && frames.length > 0) {
    const f0 = frames[0]
    const out: Point2D[] = []
    for (let i = 0; i < nCA; i++) out.push(f0[i])
    for (let i = 0; i < nAP; i++) out.push(f0[nCA + nCS + i])
    return out
  }
  // Fallback : positions d'édition (frame 0 implicite = positions statiques)
  return [...mesh.contourAnchors, ...mesh.anchorPoints]
}

export default function EyesSection() {
  const { project, save } = useAdminContext()
  const owner = getGeometryOwner(project.animations)
  const mesh = owner?.mesh ?? null
  const hasTracking = !!mesh && mesh.trackedTriangles.length > 0
  const imageBlob = project.originalImageBlob

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [imageBitmap, setImageBitmap] = useState<HTMLImageElement | null>(null)
  const [tolerance, setTolerance] = useState(30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const blinkRafRef = useRef<number | null>(null)

  const eyes = ensureEyes(project)

  // Load image once
  useEffect(() => {
    if (!imageBlob) { setImageBitmap(null); return }
    const url = URL.createObjectURL(imageBlob)
    const img = new Image()
    img.onload = () => setImageBitmap(img)
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [imageBlob])

  const redraw = useCallback((blinkProgress: number) => {
    const canvas = canvasRef.current
    if (!canvas || !imageBitmap) return
    const s = scale
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height)
    for (const eye of eyes.regions) {
      // outline + faint fill
      ctx.beginPath()
      eye.contourPoints.forEach((p, i) => {
        const sx = p.x * s, sy = p.y * s
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
      })
      ctx.closePath()
      ctx.fillStyle = 'rgba(80,160,255,0.25)'
      ctx.strokeStyle = '#0a6cff'
      ctx.lineWidth = 2
      ctx.fill()
      ctx.stroke()
      // black "curtain" fill clipped to blinkProgress
      if (blinkProgress > 0.001) {
        let minY = Infinity, maxY = -Infinity
        for (const p of eye.contourPoints) {
          const sy = p.y * s
          if (sy < minY) minY = sy
          if (sy > maxY) maxY = sy
        }
        const half = (maxY - minY) * (blinkProgress / 2)
        const topCutY = minY + half
        const bottomCutY = maxY - half
        ctx.save()
        ctx.beginPath()
        eye.contourPoints.forEach((p, i) => {
          const sx = p.x * s, sy = p.y * s
          if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy)
        })
        ctx.closePath()
        ctx.clip()
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, topCutY)
        ctx.fillRect(0, bottomCutY, canvas.width, canvas.height - bottomCutY)
        ctx.restore()
      }
      // seed marker
      ctx.beginPath()
      ctx.arc(eye.seed.x * s, eye.seed.y * s, 4, 0, Math.PI * 2)
      ctx.fillStyle = '#ff3b3b'
      ctx.fill()
    }
  }, [imageBitmap, eyes.regions, scale])

  // Setup canvas size when image loads
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !imageBitmap) return
    const container = containerRef.current
    const maxW = container ? container.clientWidth - 32 : 800
    const s = Math.min(1, maxW / imageBitmap.naturalWidth)
    canvas.width = Math.round(imageBitmap.naturalWidth * s)
    canvas.height = Math.round(imageBitmap.naturalHeight * s)
    setScale(s)
  }, [imageBitmap])

  // Redraw when state changes
  useEffect(() => {
    redraw(0)
  }, [redraw])

  const testBlink = useCallback(() => {
    if (blinkRafRef.current != null) cancelAnimationFrame(blinkRafRef.current)
    const halfMs = eyes.blinkDurationMs / 2
    const start = performance.now()
    const ease = (t: number) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    const tick = (now: number) => {
      const elapsed = now - start
      let progress = 0
      if (elapsed < halfMs) progress = ease(elapsed / halfMs)
      else if (elapsed < halfMs * 2) progress = 1 - ease((elapsed - halfMs) / halfMs)
      else progress = 0
      redraw(progress)
      if (elapsed < halfMs * 2) {
        blinkRafRef.current = requestAnimationFrame(tick)
      } else {
        blinkRafRef.current = null
      }
    }
    blinkRafRef.current = requestAnimationFrame(tick)
  }, [eyes.blinkDurationMs, redraw])

  useEffect(() => () => {
    if (blinkRafRef.current != null) cancelAnimationFrame(blinkRafRef.current)
  }, [])

  async function handleCanvasClick(ev: React.MouseEvent<HTMLCanvasElement>) {
    if (!imageBitmap) return
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    // Use rect (CSS) dimensions, not canvas.width (drawing buffer), to handle CSS scaling.
    const seed = {
      x: (ev.clientX - rect.left) * (imageBitmap.naturalWidth / rect.width),
      y: (ev.clientY - rect.top) * (imageBitmap.naturalHeight / rect.height),
    }
    console.log('[Eyes] click seed (image coords):', seed, 'rect:', rect.width, rect.height, 'natural:', imageBitmap.naturalWidth, imageBitmap.naturalHeight)
    setBusy(true)
    setError(null)
    try {
      // Build ImageData from natural-size image
      const off = document.createElement('canvas')
      off.width = imageBitmap.naturalWidth
      off.height = imageBitmap.naturalHeight
      const octx = off.getContext('2d')!
      octx.drawImage(imageBitmap, 0, 0)
      const imageData = octx.getImageData(0, 0, off.width, off.height)
      const contourPoints = await detectEyeContour(imageData, seed, tolerance)
      if (!contourPoints || contourPoints.length < 3) {
        setError('Zone invalide ou trop petite/grande. Cliquez à l\'intérieur du blanc de l\'œil.')
        return
      }
      const barycentricRefs = hasTracking && mesh
        ? computeAllBarycentrics(contourPoints, buildFrame0TrackedPositions(mesh), mesh.trackedTriangles)
        : []
      const bodyMesh = getEyeBodyMeshData(project)
      const bodyBarycentricRefs = bodyMesh
        ? computeAllBarycentrics(contourPoints, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)
        : undefined
      const eye: EyeRegion = {
        id: crypto.randomUUID(),
        contourPoints,
        barycentricRefs,
        bodyBarycentricRefs,
        seed,
      }
      const next: Project = {
        ...project,
        projectEyes: { ...ensureEyes(project), regions: [...eyes.regions, eye] },
      }
      await save(next)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError('Échec détection: ' + msg)
    } finally {
      setBusy(false)
    }
  }

  async function removeEye(id: string) {
    const next: Project = {
      ...project,
      projectEyes: { ...eyes, regions: eyes.regions.filter(r => r.id !== id) },
    }
    await save(next)
  }

  async function updateConfig(patch: Partial<ProjectEyes>) {
    const next: Project = { ...project, projectEyes: { ...eyes, ...patch } }
    await save(next)
  }

  if (!imageBlob) {
    return (
      <div className="admin-section-disabled">
        <p>Importez d'abord une image de coloriage dans Paramètres.</p>
      </div>
    )
  }
  return (
    <div ref={containerRef} style={{ padding: 16 }}>
      <h2>Yeux qui clignent</h2>
      <p style={{ opacity: 0.8, fontSize: 14 }}>
        Cliquez sur le blanc d'un œil dans l'image. La forme est détectée automatiquement par flood-fill.
        Les yeux clignent aléatoirement pendant le scan et les scènes.
        {hasTracking
          ? ' Ils suivront la déformation du maillage.'
          : ' (Topologie non verrouillée : position fixe pendant les animations.)'}
      </p>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 600px' }}>
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            style={{ cursor: busy ? 'wait' : 'crosshair', maxWidth: '100%', border: '1px solid var(--color-border,#ccc)' }}
          />
          {busy && <div style={{ marginTop: 8 }}>Détection en cours…</div>}
          {error && <div style={{ marginTop: 8, color: 'var(--color-danger,#c00)' }}>{error}</div>}
        </div>

        <div style={{ flex: '0 0 280px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Sensibilité Canny: <strong>{tolerance}</strong></span>
            <input type="range" min={5} max={80} value={tolerance} onChange={e => setTolerance(parseInt(e.target.value, 10))} />
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={eyes.blinkEnabled}
              onChange={e => updateConfig({ blinkEnabled: e.target.checked })}
            />
            <span>Activer le clignement</span>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Durée clignement (ms): <strong>{eyes.blinkDurationMs}</strong></span>
            <input type="range" min={80} max={400} step={10} value={eyes.blinkDurationMs}
              onChange={e => updateConfig({ blinkDurationMs: parseInt(e.target.value, 10) })} />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Intervalle min (ms): <strong>{eyes.blinkIntervalMinMs}</strong></span>
            <input type="range" min={500} max={10000} step={100} value={eyes.blinkIntervalMinMs}
              onChange={e => updateConfig({ blinkIntervalMinMs: parseInt(e.target.value, 10) })} />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Intervalle max (ms): <strong>{eyes.blinkIntervalMaxMs}</strong></span>
            <input type="range" min={1000} max={15000} step={100} value={eyes.blinkIntervalMaxMs}
              onChange={e => updateConfig({ blinkIntervalMaxMs: parseInt(e.target.value, 10) })} />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Probabilité double clignement: <strong>{eyes.doubleBlinkProbability.toFixed(2)}</strong></span>
            <input type="range" min={0} max={1} step={0.05} value={eyes.doubleBlinkProbability}
              onChange={e => updateConfig({ doubleBlinkProbability: parseFloat(e.target.value) })} />
          </label>

          <button
            className="btn-primary"
            onClick={testBlink}
            disabled={eyes.regions.length === 0}
            style={{ marginTop: 8 }}
          >
            Tester le clignement
          </button>

          <div>
            <h3 style={{ margin: '8px 0' }}>Yeux ({eyes.regions.length})</h3>
            {eyes.regions.length === 0 && <div style={{ opacity: 0.6 }}>Aucun œil défini.</div>}
            {eyes.regions.map((r, i) => (
              <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                <span>Œil {i + 1} ({r.contourPoints.length} pts)</span>
                <button className="btn-danger btn-sm" onClick={() => removeEye(r.id)}>Supprimer</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
