import { useState, useEffect, useRef, useCallback } from 'react'
import type { Project, SAM2Zone, RLEMask, Point2D, CannyParams } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { decodeRLEMinusRLEs } from '../../utils/rleMask'
import { smoothPolygonGaussian, bridgeContourAtLegs } from '../../utils/sam2Contour'
import { flowMaskToContour, flowCannySegmentZones } from '../../utils/perspectiveCorrection'
import { rasterizePolygonToMaskRLE } from '../../utils/cannyZoneContours'

const DEFAULT_CANNY: CannyParams = { lowThreshold: 50, highThreshold: 150, blurSize: 5 }

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/** Zone body initiale, créée par défaut si aucune zone n'existe encore. */
const DEFAULT_BODY_ZONE: SAM2Zone = { id: 'body', label: 'Body', color: '#22c55e' }

/** Palette pour assigner automatiquement une couleur aux nouveaux membres. */
const MEMBER_COLOR_PALETTE = [
  '#f59e0b', '#ef4444', '#3b82f6', '#a855f7',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316',
  '#14b8a6', '#eab308', '#8b5cf6', '#10b981',
]

function pickColor(existing: SAM2Zone[]): string {
  const used = new Set(existing.map(z => z.color.toLowerCase()))
  for (const c of MEMBER_COLOR_PALETTE) if (!used.has(c.toLowerCase())) return c
  // Fallback : random pastel
  const h = Math.floor(Math.random() * 360)
  return `hsl(${h}, 70%, 55%)`
}

export default function ProjectTriangZonesStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [computing, setComputing] = useState(false)

  // Zones (dynamiques : body obligatoire + 0..N membres custom)
  const [zones, setZones] = useState<SAM2Zone[]>(() => {
    const saved = project.projectTriangulation?.zones
    if (saved && saved.length > 0) {
      // Garantit qu'une zone body existe en tête.
      if (saved.some(z => z.id === 'body')) return saved
      return [DEFAULT_BODY_ZONE, ...saved]
    }
    return [DEFAULT_BODY_ZONE]
  })

  const memberZones = zones.filter(z => z.id !== 'body')
  const memberZoneIds = memberZones.map(z => z.id)

  const [activeZoneId, setActiveZoneId] = useState<string>(() => zones[0]?.id ?? 'body')
  const [renamingZoneId, setRenamingZoneId] = useState<string | null>(null)

  // Smoothing params
  const [sigma, setSigma] = useState<number>(
    () => project.projectTriangulation?.contourSmoothSigma ?? 3
  )
  const [bridgeThreshold, setBridgeThreshold] = useState<number>(
    () => project.projectTriangulation?.bridgeThreshold ?? 8
  )
  const [zoneSigmas, setZoneSigmas] = useState<Record<string, number>>({})
  const sigmaFor = useCallback((zoneId: string) => zoneSigmas[zoneId] ?? sigma, [zoneSigmas, sigma])

  // Canny params
  const [cannyParams, setCannyParams] = useState<CannyParams>(
    () => project.projectTriangulation?.cannyParams ?? DEFAULT_CANNY
  )
  const [inflate, setInflate] = useState<number>(12)

  // ---- Canny interactive state ----
  const [legSeeds, setLegSeeds] = useState<Record<string, Point2D[]>>({})
  const [legLoops, setLegLoops] = useState<Record<string, Point2D[]>>({})
  const [bodySilhouette, setBodySilhouette] = useState<Point2D[] | null>(null)
  const [cannyComputing, setCannyComputing] = useState(false)
  const draggingSeedRef = useRef<{ zoneId: string; index: number } | null>(null)
  const cannyComputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Image state
  const [imageReady, setImageReady] = useState(false)
  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fittedRef = useRef(false)

  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)

  // ---------- Load reference image ----------
  const refImageBlob = project.projectTriangulation?.referenceImageBlob ?? null
  useEffect(() => {
    if (!refImageBlob) return
    const url = URL.createObjectURL(refImageBlob)
    const img = new Image()
    img.src = url
    img.onload = () => {
      imageRef.current = img
      setImageSize({ w: img.naturalWidth, h: img.naturalHeight })
      setImageReady(true)
    }
    return () => {
      URL.revokeObjectURL(url)
      imageRef.current = null
      fittedRef.current = false
    }
  }, [refImageBlob])

  useEffect(() => {
    if (!imageReady || fittedRef.current) return
    fitToCanvas(imageSize.w, imageSize.h)
    fittedRef.current = true
  }, [imageReady, imageSize, fitToCanvas])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const observer = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect
      if (width === 0 || height === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // ---------- Debounced flood-fill compute ----------
  const cannyParamsKey = `${cannyParams.lowThreshold}|${cannyParams.highThreshold}|${cannyParams.blurSize}`
  const recomputeCannyZones = useCallback(async (seedsSnapshot: Record<string, Point2D[]>) => {
    if (!imageRef.current) return
    const img = imageRef.current
    const w = img.naturalWidth, h = img.naturalHeight
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    off.getContext('2d')!.drawImage(img, 0, 0)
    const imgData = off.getContext('2d')!.getImageData(0, 0, w, h)
    const seeds = memberZoneIds
      .filter(id => (seedsSnapshot[id]?.length ?? 0) > 0)
      .map(id => ({ id, waypoints: seedsSnapshot[id].map(p => ({ x: p.x, y: p.y })) }))
    setCannyComputing(true)
    try {
      const result = await flowCannySegmentZones(
        imgData, seeds,
        cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize,
        inflate,
      )
      const nextLoops: Record<string, Point2D[]> = {}
      for (const legId of memberZoneIds) {
        const c = result.zoneContours[legId]
        if (c && c.length >= 3) nextLoops[legId] = c
      }
      setLegLoops(nextLoops)

      if (result.silhouette && result.silhouette.length >= 3) {
        const legContoursForBridge = memberZoneIds
          .map(id => nextLoops[id])
          .filter((c): c is Point2D[] => c != null && c.length >= 3)
        if (legContoursForBridge.length === 0) {
          setBodySilhouette(result.silhouette)
        } else {
          try {
            const bodyRLE = rasterizePolygonToMaskRLE(result.silhouette, w, h)
            const legRLEs = legContoursForBridge.map(c => rasterizePolygonToMaskRLE(c, w, h))
            const bodyMinusLegs = decodeRLEMinusRLEs(bodyRLE, legRLEs)
            const rawBody = await flowMaskToContour(bodyMinusLegs, w, h)
            const bridged = bridgeContourAtLegs(rawBody, legContoursForBridge, bridgeThreshold)
            setBodySilhouette(bridged.length >= 3 ? bridged : result.silhouette)
          } catch (err) {
            console.error('Body subtract/bridge failed:', err)
            setBodySilhouette(result.silhouette)
          }
        }
      }
    } catch (err) {
      console.error('Canny flood-fill failed:', err)
    } finally {
      setCannyComputing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize, inflate, bridgeThreshold, memberZoneIds.join('|')])

  const scheduleCannyRecompute = useCallback((seedsSnapshot: Record<string, Point2D[]>) => {
    if (cannyComputeTimerRef.current) clearTimeout(cannyComputeTimerRef.current)
    cannyComputeTimerRef.current = setTimeout(() => recomputeCannyZones(seedsSnapshot), 150)
  }, [recomputeCannyZones])

  useEffect(() => {
    if (!imageReady) return
    scheduleCannyRecompute(legSeeds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageReady, cannyParamsKey, inflate, bridgeThreshold])

  // ---------- Draw loop ----------
  useEffect(() => {
    let running = true
    let rafId = 0

    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      const img = imageRef.current
      if (!canvas || !img || !imageReady) {
        rafId = requestAnimationFrame(draw)
        return
      }

      const ctx = canvas.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas.width / dpr
      const cssH = canvas.height / dpr
      ctx.fillStyle = '#1a1a1a'
      ctx.fillRect(0, 0, cssW, cssH)

      const t = transformRef.current
      ctx.save()
      ctx.translate(t.offsetX, t.offsetY)
      ctx.scale(t.scale, t.scale)
      ctx.drawImage(img, 0, 0)

      if (bodySilhouette && bodySilhouette.length >= 3) {
        const bodyZone = zones.find(z => z.id === 'body')!
        const sm = smoothPolygonGaussian(bodySilhouette, sigmaFor('body'))
        ctx.strokeStyle = bodyZone.color
        ctx.lineWidth = 3 / t.scale
        ctx.beginPath()
        ctx.moveTo(sm[0].x, sm[0].y)
        for (let i = 1; i < sm.length; i++) ctx.lineTo(sm[i].x, sm[i].y)
        ctx.closePath()
        ctx.stroke()
      }
      for (const legId of memberZoneIds) {
        const loop = legLoops[legId]
        if (!loop || loop.length < 3) continue
        const zone = zones.find(z => z.id === legId)
        if (!zone) continue
        const sm = smoothPolygonGaussian(loop, sigmaFor(legId))
        ctx.strokeStyle = zone.color
        ctx.lineWidth = 3 / t.scale
        ctx.beginPath()
        ctx.moveTo(sm[0].x, sm[0].y)
        for (let i = 1; i < sm.length; i++) ctx.lineTo(sm[i].x, sm[i].y)
        ctx.closePath()
        ctx.stroke()
      }
      const sr = 6 / t.scale
      for (const legId of memberZoneIds) {
        const seeds = legSeeds[legId]
        if (!seeds) continue
        const zone = zones.find(z => z.id === legId)
        if (!zone) continue
        for (const p of seeds) {
          ctx.fillStyle = zone.color
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2 / t.scale
          ctx.beginPath()
          ctx.arc(p.x, p.y, sr, 0, Math.PI * 2)
          ctx.fill(); ctx.stroke()
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [imageReady, transformRef, zones, bodySilhouette, legLoops, legSeeds, zoneSigmas, sigma, sigmaFor])

  // ---------- Hit test seed ----------
  const hitTestWaypoint = useCallback((p: Point2D): { zoneId: string; index: number } | null => {
    const hitRadius = 14 / transformRef.current.scale
    const hitRadiusSq = hitRadius * hitRadius
    for (const z of zones) {
      const wps = legSeeds[z.id]
      if (!wps) continue
      for (let i = wps.length - 1; i >= 0; i--) {
        const dx = p.x - wps[i].x, dy = p.y - wps[i].y
        if (dx * dx + dy * dy <= hitRadiusSq) return { zoneId: z.id, index: i }
      }
    }
    return null
  }, [legSeeds, zones, transformRef])

  // ---------- Body silhouette one-shot ----------
  async function handleCannyBodyClick() {
    if (!refImageBlob || !imageRef.current) return
    setComputing(true)
    try {
      const img = imageRef.current
      const w = img.naturalWidth, h = img.naturalHeight
      const off = document.createElement('canvas')
      off.width = w; off.height = h
      off.getContext('2d')!.drawImage(img, 0, 0)
      const imgData = off.getContext('2d')!.getImageData(0, 0, w, h)
      const result = await flowCannySegmentZones(
        imgData, [], cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize,
      )
      if (result.silhouette && result.silhouette.length >= 3) {
        setBodySilhouette(result.silhouette)
      } else {
        alert('Aucune silhouette détectée. Ajustez les seuils Canny.')
      }
    } catch (err) {
      console.error('Body silhouette failed:', err)
      alert('Erreur silhouette : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
  }

  function addLegSeed(legId: string, imgPos: Point2D) {
    const seed = { x: Math.round(imgPos.x), y: Math.round(imgPos.y) }
    setLegSeeds(prev => {
      const next = { ...prev, [legId]: [...(prev[legId] ?? []), seed] }
      scheduleCannyRecompute(next)
      return next
    })
  }

  function removeLegSeed(zoneId: string, index: number) {
    setLegSeeds(prev => {
      const next = { ...prev, [zoneId]: (prev[zoneId] ?? []).filter((_, i) => i !== index) }
      if (next[zoneId].length === 0) {
        setLegLoops(prevLoops => { const n = { ...prevLoops }; delete n[zoneId]; return n })
      }
      scheduleCannyRecompute(next)
      return next
    })
  }

  // ---------- Mouse handlers ----------
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (spaceDown.current || isPanning.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const hit = hitTestWaypoint(imgPos)
    if (hit) {
      draggingSeedRef.current = hit
      return
    }
    if (activeZoneId === 'body') {
      handleCannyBodyClick()
    } else if (memberZoneIds.includes(activeZoneId)) {
      addLegSeed(activeZoneId, imgPos)
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const dragSeed = draggingSeedRef.current
    if (!dragSeed) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    setLegSeeds(prev => {
      const seeds = [...(prev[dragSeed.zoneId] ?? [])]
      seeds[dragSeed.index] = { x: Math.round(imgPos.x), y: Math.round(imgPos.y) }
      const next = { ...prev, [dragSeed.zoneId]: seeds }
      scheduleCannyRecompute(next)
      return next
    })
  }

  function handleMouseUp() {
    draggingSeedRef.current = null
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (spaceDown.current || isPanning.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    if (activeZoneId === 'body') {
      setBodySilhouette(null)
      return
    }
    const hit = hitTestWaypoint(imgPos)
    if (hit) removeLegSeed(hit.zoneId, hit.index)
  }

  // ---------- Finalize masks + contours from interactive state ----------
  function finalizeCannyZones(): { masks: Record<string, RLEMask[]>; contours: Record<string, Point2D[]>; dims: { w: number; h: number } } | null {
    if (!imageRef.current) return null
    const w = imageRef.current.naturalWidth, h = imageRef.current.naturalHeight
    if (!bodySilhouette || bodySilhouette.length < 3) {
      alert('Cliquez sur le body pour détecter sa silhouette.')
      return null
    }
    const missing = memberZoneIds.filter(id => !legLoops[id] || legLoops[id].length < 3)
    if (missing.length > 0) {
      const names = missing.map(id => zones.find(z => z.id === id)?.label ?? id).join(', ')
      alert(`Placez au moins 2 clics par membre pour fermer la boucle : ${names}`)
      return null
    }
    const rawByZone: Record<string, Point2D[]> = { body: bodySilhouette }
    for (const id of memberZoneIds) rawByZone[id] = legLoops[id]
    const smoothed: Record<string, Point2D[]> = {}
    const newMasks: Record<string, RLEMask[]> = {}
    for (const z of zones) {
      const r = rawByZone[z.id]
      if (!r || r.length < 3) continue
      const s = smoothPolygonGaussian(r, sigmaFor(z.id))
      smoothed[z.id] = s
      newMasks[z.id] = [rasterizePolygonToMaskRLE(s, w, h)]
    }
    return { masks: newMasks, contours: smoothed, dims: { w, h } }
  }

  // ---------- Save ----------
  async function handleSave() {
    const finalized = finalizeCannyZones()
    if (!finalized) return
    setSaving(true)
    try {
      const pt = project.projectTriangulation ?? {
        referenceImageBlob: null,
        zones: [],
        prompts: [],
        masksRLE: null,
        maskWidth: 0,
        maskHeight: 0,
        contours: null,
        contourSmoothSigma: 3,
        bridgeThreshold: 8,
        step1Validated: false,
        zoneContourCount: {}, zoneContourPoints: {}, zoneContourValidated: {},
        zonePoints: {},
        zoneTriangles: {},
        zoneDensity: {},
        bodyPoints: [],
        bodyTriangles: [],
        step2Validated: false,
        hiddenFaceZones: [],
        hiddenFaceLimbZones: [],
        step3Validated: false,
      }

      const updated: Project = {
        ...project,
        projectTriangulation: {
          ...pt,
          zones,
          prompts: [],
          masksRLE: finalized.masks,
          maskWidth: finalized.dims.w,
          maskHeight: finalized.dims.h,
          contours: finalized.contours,
          contourSmoothSigma: sigma,
          bridgeThreshold,
          segmentationMode: 'canny',
          cannyParams,
          step1Validated: true,
          // Invalidate downstream steps
          zoneContourCount: {}, zoneContourPoints: {}, zoneContourValidated: {},
          step2Validated: false,
          zonePoints: {},
          zoneTriangles: {},
          zoneDensity: {},
          bodyPoints: [],
          bodyTriangles: [],
          step3Validated: false,
          hiddenFaceZones: [],
          hiddenFaceLimbZones: [],
        },
      }

      await onSave(updated, ['triangulationMasks', 'triangulationContours'])
    } catch (err) {
      console.error('Failed to save zones:', err)
      alert('Erreur lors de la sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!refImageBlob) {
    return (
      <div className="placeholder">
        Importez d'abord une image de référence colorée (étape 1 — Image référence).
      </div>
    )
  }

  return (
    <div className="triangulation-step">
      {/* Zone selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '10px 0' }}>
        <span style={{ fontWeight: 'bold', fontSize: '0.95rem' }}>Zone active :</span>
        {zones.map(z => {
          const isActive = z.id === activeZoneId
          const isBody = z.id === 'body'
          if (renamingZoneId === z.id) {
            return (
              <input
                key={z.id}
                autoFocus
                defaultValue={z.label}
                onBlur={e => {
                  const v = e.currentTarget.value.trim()
                  if (v) setZones(zs => zs.map(x => x.id === z.id ? { ...x, label: v } : x))
                  setRenamingZoneId(null)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenamingZoneId(null)
                }}
                style={{
                  border: `2px solid ${z.color}`, padding: '4px 10px', borderRadius: 6,
                  fontWeight: 'bold', fontSize: '0.95rem', background: '#fff', color: z.color,
                }}
              />
            )
          }
          return (
            <span key={z.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button
                onClick={() => setActiveZoneId(z.id)}
                onDoubleClick={() => setRenamingZoneId(z.id)}
                title={isBody ? 'Zone body (obligatoire). Double-clic pour renommer.' : 'Double-clic pour renommer'}
                style={{
                  background: isActive ? z.color : `${z.color}22`,
                  color: isActive ? '#fff' : z.color,
                  border: `2px solid ${z.color}`,
                  padding: '6px 14px',
                  borderRadius: 6,
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  fontSize: '0.95rem',
                  boxShadow: isActive ? `0 0 8px ${z.color}88` : 'none',
                  transition: 'all 0.15s',
                }}
              >
                {z.label}
              </button>
              {!isBody && (
                <button
                  onClick={() => {
                    if (!confirm(`Supprimer la zone "${z.label}" ?`)) return
                    setZones(zs => zs.filter(x => x.id !== z.id))
                    setLegSeeds(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    setLegLoops(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    if (activeZoneId === z.id) setActiveZoneId('body')
                  }}
                  title="Supprimer ce membre"
                  style={{
                    border: 'none', background: 'transparent', color: '#94a3b8',
                    cursor: 'pointer', fontSize: '1rem', padding: '0 4px',
                  }}
                >×</button>
              )}
            </span>
          )
        })}
        <button
          onClick={() => {
            const idx = memberZones.length + 1
            const newZone: SAM2Zone = {
              id: `member-${crypto.randomUUID().slice(0, 8)}`,
              label: `Membre ${idx}`,
              color: pickColor(zones),
            }
            setZones(zs => [...zs, newZone])
            setActiveZoneId(newZone.id)
            setRenamingZoneId(newZone.id)
          }}
          title="Ajouter un membre (tête, patte, queue, aile…)"
          style={{
            border: '2px dashed #94a3b8', background: 'transparent', color: '#94a3b8',
            padding: '6px 12px', borderRadius: 6, fontWeight: 'bold', cursor: 'pointer',
            fontSize: '0.95rem',
          }}
        >+ Ajouter un membre</button>
      </div>

      {/* Actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="toolbar-info">
          {cannyComputing ? 'Calcul flood-fill...' : computing ? 'Calcul silhouette...' : 'Clic Body = silhouette, clic Membre = ajouter une région (clics multiples = union)'}
        </span>

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || computing || !bodySilhouette || memberZoneIds.some(id => !legLoops[id])}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>

        <button
          className="btn-danger"
          onClick={() => {
            setBodySilhouette(null)
            setLegSeeds({})
            setLegLoops({})
          }}
          disabled={!bodySilhouette && Object.keys(legSeeds).length === 0}
        >
          Tout effacer
        </button>
      </div>

      {/* Canny params */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
          Canny low:
          <input type="range" min={10} max={200} step={1}
            value={cannyParams.lowThreshold}
            onChange={e => setCannyParams(p => ({ ...p, lowThreshold: parseInt(e.target.value) }))}
            style={{ width: 100 }} />
          <span style={{ minWidth: 28, textAlign: 'center' }}>{cannyParams.lowThreshold}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
          Canny high:
          <input type="range" min={50} max={400} step={1}
            value={cannyParams.highThreshold}
            onChange={e => setCannyParams(p => ({ ...p, highThreshold: parseInt(e.target.value) }))}
            style={{ width: 100 }} />
          <span style={{ minWidth: 28, textAlign: 'center' }}>{cannyParams.highThreshold}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
          Blur:
          <select
            value={cannyParams.blurSize}
            onChange={e => setCannyParams(p => ({ ...p, blurSize: parseInt(e.target.value) }))}
          >
            <option value={3}>3</option>
            <option value={5}>5</option>
            <option value={7}>7</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}
          title="Dilatation appliquée à chaque région cliquée. Engulfe le trait noir et, si deux dilatations se touchent, elles fusionnent automatiquement.">
          Inflate:
          <input type="range" min={0} max={80} step={1}
            value={inflate}
            onChange={e => setInflate(parseInt(e.target.value))}
            style={{ width: 100 }} />
          <span style={{ minWidth: 28, textAlign: 'center' }}>{inflate}</span>
        </label>
      </div>

      {/* Smoothing controls */}
      {(bodySilhouette || Object.keys(legLoops).length > 0) && (
        <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
            Lissage global:
            <input
              type="range" min={1} max={30} step={0.5}
              value={sigma}
              onChange={e => setSigma(parseFloat(e.target.value))}
              style={{ width: 100 }}
            />
            <span style={{ minWidth: 28, textAlign: 'center' }}>{sigma}</span>
          </label>
          {(() => {
            const activeZone = zones.find(z => z.id === activeZoneId)
            if (!activeZone) return null
            const val = zoneSigmas[activeZoneId] ?? sigma
            return (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
                <span style={{ color: activeZone.color, fontWeight: 'bold' }}>{activeZone.label} :</span>
                <input
                  type="range" min={1} max={30} step={0.5}
                  value={val}
                  onChange={e => setZoneSigmas(prev => ({ ...prev, [activeZoneId]: parseFloat(e.target.value) }))}
                  style={{ width: 100 }}
                />
                <span style={{ minWidth: 28, textAlign: 'center' }}>{val}</span>
                {zoneSigmas[activeZoneId] != null && (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => setZoneSigmas(prev => { const n = { ...prev }; delete n[activeZoneId]; return n })}
                    title="Réinitialiser au lissage global"
                  >↺</button>
                )}
              </label>
            )
          })()}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}
            title="Seuil de bridging du contour body au-dessus des pattes (px).">
            Seuil bridge:
            <input
              type="range" min={1} max={20} step={1}
              value={bridgeThreshold}
              onChange={e => setBridgeThreshold(parseInt(e.target.value))}
              style={{ width: 100 }}
            />
            <span style={{ minWidth: 28, textAlign: 'center' }}>{bridgeThreshold}</span>
          </label>
        </div>
      )}

      <div className="triangulation-help">
        <span>
          Body actif : clic = détecter la silhouette globale, clic droit = effacer.
          Membre actif : clic dans une région colorée (patte, tête, queue…) = flood-fill bounded par les traits noirs.
          Plusieurs clics = union des régions. Glisser une graine = déplacer,
          clic droit sur une graine = la supprimer. Espace + glisser = pan | Molette = zoom.
          Double-clic sur le nom d'une zone pour la renommer.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          style={{ cursor: 'crosshair' }}
        />
      </div>
    </div>
  )
}
