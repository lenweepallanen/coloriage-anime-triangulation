import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { Project, SAM2Zone, RLEMask, Point2D, CannyParams, BezierNode } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { decodeRLEMinusRLEs } from '../../utils/rleMask'
import { smoothPolygonGaussian, bridgeContourAtLegs } from '../../utils/sam2Contour'
import { flowMaskToContour, flowCannySegmentZones } from '../../utils/perspectiveCorrection'
import { rasterizePolygonToMaskRLE } from '../../utils/cannyZoneContours'
import { polygonToBezierNodes, flattenClosedBezier, evaluateCubicBezier } from '../../utils/bezierUtils'
import { fitBezierToClosedPolygon } from '../../utils/bezierFit'

const DEFAULT_CANNY: CannyParams = { lowThreshold: 50, highThreshold: 150, blurSize: 5 }
/** Sous-échantillonne un polygone à `max` points (stride uniforme en index).
 *  Indispensable pour le body Canny qui peut avoir 5–10k points → Schneider
 *  devient impraticable à 60fps sinon. */
function subsamplePolygon(polygon: Point2D[], max: number): Point2D[] {
  if (polygon.length <= max) return polygon
  const stride = polygon.length / max
  const out: Point2D[] = []
  for (let i = 0; i < max; i++) out.push(polygon[Math.floor(i * stride)])
  return out
}

function dist2(a: Point2D, b: Point2D): number {
  const dx = a.x - b.x, dy = a.y - b.y
  return dx * dx + dy * dy
}

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
  const [zoneSigmas, setZoneSigmas] = useState<Record<string, number>>(
    () => project.projectTriangulation?.zoneSmoothSigmas ?? {}
  )
  const sigmaFor = useCallback((zoneId: string) => zoneSigmas[zoneId] ?? sigma, [zoneSigmas, sigma])

  // Canny params
  const [cannyParams, setCannyParams] = useState<CannyParams>(
    () => project.projectTriangulation?.cannyParams ?? DEFAULT_CANNY
  )
  const [inflate, setInflate] = useState<number>(12)
  const [zoneInflates, setZoneInflates] = useState<Record<string, number>>(
    () => project.projectTriangulation?.zoneInflates ?? {}
  )
  const inflateFor = useCallback((zoneId: string) => zoneInflates[zoneId] ?? inflate, [zoneInflates, inflate])

  // ---- Canny interactive state ----
  const [legSeeds, setLegSeeds] = useState<Record<string, Point2D[]>>(
    () => project.projectTriangulation?.zoneSeeds ?? {}
  )
  // One zone can hold several disconnected loops while editing. Inflate must
  // be large enough to merge them into a single loop before validating.
  // À l'init, on hydrate depuis `tri.contours` pour que les zones lissées
  // sauvegardées s'affichent immédiatement au reload (sans avoir à recalculer).
  const [legLoops, setLegLoops] = useState<Record<string, Point2D[][]>>(() => {
    const saved = project.projectTriangulation?.contours
    if (!saved) return {}
    const out: Record<string, Point2D[][]> = {}
    for (const [zoneId, contour] of Object.entries(saved)) {
      if (zoneId === 'body' || !contour || contour.length < 3) continue
      out[zoneId] = [contour.map(p => ({ x: p.x, y: p.y }))]
    }
    return out
  })
  const [bodySilhouette, setBodySilhouette] = useState<Point2D[] | null>(() => {
    const body = project.projectTriangulation?.contours?.body
    return body && body.length >= 3 ? body.map(p => ({ x: p.x, y: p.y })) : null
  })

  // ─── Bézier edition par zone ────────────────────────────────────
  // Si `zoneBeziers[zoneId]` existe pour une zone, c'est la courbe Bézier
  // qui fait foi — le contour rendu et envoyé downstream est la Bézier aplatie.
  // `bezierEditing[zoneId]` (local, non persisté) active l'édition (anchors +
  // handles visibles, drag activé).
  const [zoneBeziers, setZoneBeziers] = useState<Record<string, BezierNode[]>>(
    () => project.projectTriangulation?.zoneBeziers ?? {}
  )
  const [zoneCannyRefs, setZoneCannyRefs] = useState<Record<string, Point2D[]>>(
    () => project.projectTriangulation?.zoneCannyRefs ?? {}
  )
  /** Compte d'anchors en cours de réglage (preview legacy resampling uniforme). */
  const [bezierPreviewCount, setBezierPreviewCount] = useState<Record<string, number>>({})
  /** Paramètres du fit Schneider en preview (slider tolérance + seuil coin). */
  const [bezierFitParams, setBezierFitParams] = useState<Record<string, { tolerance: number; cornerDeg: number }>>({})
  const [bezierEditing, setBezierEditing] = useState<Record<string, boolean>>({})
  const draggingBezierRef = useRef<
    | { zoneId: string; index: number; kind: 'anchor' }
    | { zoneId: string; index: number; kind: 'handleIn' | 'handleOut'; symmetric: boolean }
    | { zoneId: string; kind: 'group'; startMouse: Point2D; snapshot: Map<number, { anchor: Point2D; handleIn: Point2D; handleOut: Point2D }> }
    | null
  >(null)
  /** Anchors sélectionnés (multi-sélection). Clés : `${zoneId}:${index}`. */
  const [selectedAnchors, setSelectedAnchors] = useState<Set<string>>(new Set())
  /** Rectangle de sélection en cours (coords image). */
  const [rectSelect, setRectSelect] = useState<{ zoneId: string; start: Point2D; end: Point2D; additive: boolean } | null>(null)

  const anchorKey = (zoneId: string, index: number) => `${zoneId}:${index}`
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

  // ─── Cache mémoïsé des previews auto-fit Bézier ───
  // Le fit Schneider est lourd (récursion + LSQ). Sans cache, il tournait
  // à chaque frame de rAF → freeze sur le body (5–10k points avant subsample).
  const bezierFitPreviews = useMemo(() => {
    const out: Record<string, BezierNode[]> = {}
    for (const zoneId of zones.map(z => z.id)) {
      const ref = zoneCannyRefs[zoneId]
      const fitParams = bezierFitParams[zoneId]
      if (!fitParams || !ref || ref.length < 3) continue
      try {
        out[zoneId] = fitBezierToClosedPolygon(ref, {
          tolerance: fitParams.tolerance,
          cornerThresholdDeg: fitParams.cornerDeg,
          cornerSmoothWindow: 3,
        })
      } catch (err) {
        console.error(`[Bézier fit ${zoneId}]`, err)
        out[zoneId] = []
      }
    }
    return out
  }, [zones, zoneCannyRefs, bezierFitParams])

  // ---------- Bézier → legLoops / bodySilhouette sync ----------
  // Pour chaque zone avec une courbe Bézier, on synchronise son contour rendu
  // sur la version aplatie. `body` met à jour `bodySilhouette`, les membres
  // mettent à jour `legLoops[zoneId]`.
  useEffect(() => {
    if (Object.keys(zoneBeziers).length === 0) return
    setLegLoops(prev => {
      const next = { ...prev }
      for (const [zoneId, nodes] of Object.entries(zoneBeziers)) {
        if (zoneId === 'body') continue
        if (!nodes || nodes.length < 2) continue
        next[zoneId] = [flattenClosedBezier(nodes, 30)]
      }
      return next
    })
    const bodyBz = zoneBeziers['body']
    if (bodyBz && bodyBz.length >= 2) {
      setBodySilhouette(flattenClosedBezier(bodyBz, 30))
    }
  }, [zoneBeziers])

  // ---------- Persistance live (debounced) ----------
  // À chaque modif des zones / seeds / sliders per-zone, on sauve la
  // partie "édition" de la triangulation (sans toucher aux masks/contours/
  // step1Validated). Permet de quitter la page à tout moment sans perdre
  // le travail en cours et sans devoir cliquer « Sauvegarder ».
  const firstRunRef = useRef(true)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const pt = project.projectTriangulation
      if (!pt) return
      const updatedTri = {
        ...pt,
        zones,
        zoneSeeds: { ...legSeeds },
        zoneSmoothSigmas: { ...zoneSigmas },
        zoneInflates: { ...zoneInflates },
        zoneBeziers: { ...zoneBeziers },
        zoneCannyRefs: { ...zoneCannyRefs },
        contourSmoothSigma: sigma,
        bridgeThreshold,
        segmentationMode: 'canny' as const,
        cannyParams,
      }
      const updated: Project = {
        ...project,
        projectTriangulation: updatedTri,
      }
      // Pas de hint : seul le doc Firestore est mis à jour, pas les blobs.
      onSave(updated).catch(err => console.warn('[Zones] auto-save failed:', err))
    }, 600)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones, legSeeds, zoneSigmas, zoneInflates, zoneBeziers, zoneCannyRefs, sigma, bridgeThreshold, cannyParams])

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

  // ─── Refs miroirs (état toujours frais dans les closures setTimeout) ───
  // `recomputeCannyZones` est appelé via setTimeout(150ms) — la closure peut
  // être périmée si un état clé a changé entre-temps (ex: validation Bézier
  // body après un drag membre). On lit via ref pour garantir un état frais.
  const zoneBeziersRef = useRef(zoneBeziers)
  const legLoopsRef = useRef(legLoops)
  useEffect(() => { zoneBeziersRef.current = zoneBeziers }, [zoneBeziers])
  useEffect(() => { legLoopsRef.current = legLoops }, [legLoops])

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
    // État frais (anti-staleness des closures setTimeout 150ms)
    const curBeziers = zoneBeziersRef.current
    const curLegLoops = legLoopsRef.current
    // Skip les zones gérées en Bézier — leur contour fait foi sur la flatten.
    const activeZoneIds = memberZoneIds.filter(id =>
      (seedsSnapshot[id]?.length ?? 0) > 0 && !curBeziers[id]
    )
    setCannyComputing(true)
    try {
      const nextLoops: Record<string, Point2D[][]> = {}
      // 1) Silhouette : toujours détectée pour permettre le bridge body même
      //    quand tous les membres sont en Bézier (et donc activeZoneIds vide).
      //    Skip si le body est lui-même en Bézier (figé manuellement).
      let silhouette: Point2D[] | null = null
      if (!curBeziers['body']) {
        const sil = await flowCannySegmentZones(
          imgData, [],
          cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize,
        )
        if (sil.silhouette && sil.silhouette.length >= 3) silhouette = sil.silhouette
      }

      // 2) Pour chaque membre Canny actif : flood-fill.
      for (const zoneId of activeZoneIds) {
        const result = await flowCannySegmentZones(
          imgData,
          [{ id: zoneId, waypoints: seedsSnapshot[zoneId].map(p => ({ x: p.x, y: p.y })) }],
          cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize,
          inflateFor(zoneId),
        )
        const loops = (result.zoneContours[zoneId] ?? []).filter(l => l.length >= 3)
        if (loops.length > 0) nextLoops[zoneId] = loops
      }
      // Préserve les loops Bézier (zones où l'admin a basculé en édition manuelle).
      setLegLoops(prev => {
        const merged: Record<string, Point2D[][]> = { ...nextLoops }
        for (const [zoneId, nodes] of Object.entries(curBeziers)) {
          if (zoneId === 'body') continue
          if (nodes && nodes.length >= 2) {
            merged[zoneId] = prev[zoneId] ?? [flattenClosedBezier(nodes, 30)]
          }
        }
        return merged
      })

      // 3) Bridge body : skip si body en Bézier (édition manuelle figée).
      if (silhouette && silhouette.length >= 3 && !curBeziers['body']) {
        const legContoursForBridge = memberZoneIds
          .flatMap(id => {
            const bz = curBeziers[id]
            if (bz && bz.length >= 2) return [flattenClosedBezier(bz, 30)]
            return nextLoops[id] ?? curLegLoops[id] ?? []
          })
          .filter((c): c is Point2D[] => c != null && c.length >= 3)
        if (legContoursForBridge.length === 0) {
          setBodySilhouette(silhouette)
        } else {
          try {
            const bodyRLE = rasterizePolygonToMaskRLE(silhouette, w, h)
            const legRLEs = legContoursForBridge.map(c => rasterizePolygonToMaskRLE(c, w, h))
            const bodyMinusLegs = decodeRLEMinusRLEs(bodyRLE, legRLEs)
            const rawBody = await flowMaskToContour(bodyMinusLegs, w, h)
            const bridged = bridgeContourAtLegs(rawBody, legContoursForBridge, bridgeThreshold)
            setBodySilhouette(bridged.length >= 3 ? bridged : silhouette)
          } catch (err) {
            console.error('Body subtract/bridge failed:', err)
            setBodySilhouette(silhouette)
          }
        }
      }
    } catch (err) {
      console.error('Canny flood-fill failed:', err)
    } finally {
      setCannyComputing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize, inflateFor, bridgeThreshold, memberZoneIds.join('|')])

  const scheduleCannyRecompute = useCallback((seedsSnapshot: Record<string, Point2D[]>) => {
    if (cannyComputeTimerRef.current) clearTimeout(cannyComputeTimerRef.current)
    cannyComputeTimerRef.current = setTimeout(() => recomputeCannyZones(seedsSnapshot), 150)
  }, [recomputeCannyZones])

  // Re-bridge body live quand un Bézier membre bouge (drag anchor/handle, valider auto-fit, etc).
  // Skip si le body est lui-même en Bézier (bridge figé).
  useEffect(() => {
    if (!imageReady) return
    if (zoneBeziers['body']) return
    scheduleCannyRecompute(legSeeds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneBeziers])

  useEffect(() => {
    if (!imageReady) return
    scheduleCannyRecompute(legSeeds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageReady, cannyParamsKey, inflate, JSON.stringify(zoneInflates), bridgeThreshold])

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
        const loops = legLoops[legId]
        if (!loops || loops.length === 0) continue
        const zone = zones.find(z => z.id === legId)
        if (!zone) continue
        const multi = loops.length > 1
        for (const loop of loops) {
          if (loop.length < 3) continue
          const sm = smoothPolygonGaussian(loop, sigmaFor(legId))
          // Dashed stroke when the zone has several disconnected pieces — a
          // visual warning that the user must raise `inflate` to merge them
          // (the curviligne mesh pipeline downstream needs a single contour).
          ctx.strokeStyle = zone.color
          ctx.lineWidth = 3 / t.scale
          if (multi) ctx.setLineDash([8 / t.scale, 6 / t.scale])
          ctx.beginPath()
          ctx.moveTo(sm[0].x, sm[0].y)
          for (let i = 1; i < sm.length; i++) ctx.lineTo(sm[i].x, sm[i].y)
          ctx.closePath()
          ctx.stroke()
          if (multi) ctx.setLineDash([])
        }
      }
      const sr = 6 / t.scale
      for (const legId of memberZoneIds) {
        if (zoneBeziers[legId]) continue // les seeds Canny ne servent plus pour cette zone
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

      // ── Bézier overlay (anchors + handles) pour les zones en édition ──
      for (const legId of zones.map(z => z.id)) {
        const ref = zoneCannyRefs[legId]
        const fitParams = bezierFitParams[legId]
        const zone = zones.find(z => z.id === legId)
        if (!zone) continue

        // Preview du fit auto Schneider — affichée même sans Bézier matérialisé.
        if (fitParams && ref && ref.length >= 3) {
          const previewNodes = bezierFitPreviews[legId] ?? []
          if (previewNodes.length >= 2) {
            const previewFlat = flattenClosedBezier(previewNodes, 30)
            ctx.strokeStyle = '#22d3ee'   // cyan = preview auto-fit
            ctx.lineWidth = 2.5 / t.scale
            ctx.setLineDash([4 / t.scale, 4 / t.scale])
            ctx.beginPath()
            ctx.moveTo(previewFlat[0].x, previewFlat[0].y)
            for (let i = 1; i < previewFlat.length; i++) ctx.lineTo(previewFlat[i].x, previewFlat[i].y)
            ctx.closePath()
            ctx.stroke()
            ctx.setLineDash([])
            const pr = 4 / t.scale
            for (const pn of previewNodes) {
              ctx.fillStyle = pn.smooth ? '#22d3ee' : '#f97316'   // corners en orange
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath(); ctx.arc(pn.anchor.x, pn.anchor.y, pr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            }
          }
        }

        const nodes = zoneBeziers[legId]
        if (!nodes || nodes.length < 2) continue
        const editing = bezierEditing[legId]
        if (!editing) continue // courbe déjà rendue via legLoops (flattened)

        // Handles : lignes anchor↔handle
        ctx.strokeStyle = '#888'
        ctx.lineWidth = 1 / t.scale
        ctx.setLineDash([3 / t.scale, 3 / t.scale])
        for (const n of nodes) {
          ctx.beginPath()
          ctx.moveTo(n.handleIn.x, n.handleIn.y)
          ctx.lineTo(n.anchor.x, n.anchor.y)
          ctx.lineTo(n.handleOut.x, n.handleOut.y)
          ctx.stroke()
        }
        ctx.setLineDash([])

        // Handles : cercles
        const hr = 4 / t.scale
        ctx.fillStyle = '#fff'
        ctx.strokeStyle = '#888'
        ctx.lineWidth = 1 / t.scale
        for (const n of nodes) {
          ctx.beginPath(); ctx.arc(n.handleIn.x, n.handleIn.y, hr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
          ctx.beginPath(); ctx.arc(n.handleOut.x, n.handleOut.y, hr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        }

        // Anchors : carrés colorés ; jaune si sélectionné.
        const ar = 6 / t.scale
        ctx.lineWidth = 2 / t.scale
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]
          const sel = selectedAnchors.has(anchorKey(legId, i))
          ctx.fillStyle = sel ? '#facc15' : zone.color
          ctx.strokeStyle = sel ? '#facc15' : '#fff'
          ctx.fillRect(n.anchor.x - ar, n.anchor.y - ar, ar * 2, ar * 2)
          ctx.lineWidth = (sel ? 3 : 2) / t.scale
          ctx.strokeRect(n.anchor.x - ar, n.anchor.y - ar, ar * 2, ar * 2)
        }

        // ── Preview du resampling Canny → Bézier (slider non validé) ──
        const previewN = bezierPreviewCount[legId]
        if (previewN != null && previewN !== nodes.length && ref && ref.length >= 3) {
          const previewNodes = polygonToBezierNodes(ref, Math.max(3, Math.min(128, previewN)))
          const previewFlat = flattenClosedBezier(previewNodes, 30)
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2 / t.scale
          ctx.setLineDash([6 / t.scale, 4 / t.scale])
          ctx.beginPath()
          ctx.moveTo(previewFlat[0].x, previewFlat[0].y)
          for (let i = 1; i < previewFlat.length; i++) ctx.lineTo(previewFlat[i].x, previewFlat[i].y)
          ctx.closePath()
          ctx.stroke()
          ctx.setLineDash([])
          const pr = 3 / t.scale
          ctx.fillStyle = '#fff'
          for (const pn of previewNodes) {
            ctx.beginPath(); ctx.arc(pn.anchor.x, pn.anchor.y, pr, 0, Math.PI * 2); ctx.fill()
          }
        }

      }

      // ── Rectangle de sélection en cours ──
      if (rectSelect) {
        const x = Math.min(rectSelect.start.x, rectSelect.end.x)
        const y = Math.min(rectSelect.start.y, rectSelect.end.y)
        const w = Math.abs(rectSelect.end.x - rectSelect.start.x)
        const h = Math.abs(rectSelect.end.y - rectSelect.start.y)
        ctx.fillStyle = 'rgba(250, 204, 21, 0.15)'
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = '#facc15'
        ctx.lineWidth = 1.5 / t.scale
        ctx.setLineDash([5 / t.scale, 3 / t.scale])
        ctx.strokeRect(x, y, w, h)
        ctx.setLineDash([])
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [imageReady, transformRef, zones, bodySilhouette, legLoops, legSeeds, zoneSigmas, sigma, sigmaFor, zoneBeziers, bezierEditing, bezierPreviewCount, bezierFitParams, zoneCannyRefs, selectedAnchors, rectSelect, bezierFitPreviews])

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

  // ---------- Bézier multi-selection : Delete / Backspace ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // Ignore si focus est sur un input/textarea (rename etc.)
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (selectedAnchors.size === 0) return
      e.preventDefault()
      // Regroupe par zone : indices à supprimer (en ordre desc pour stabilité)
      const byZone = new Map<string, number[]>()
      for (const key of selectedAnchors) {
        const [zoneId, idxStr] = key.split(':')
        const arr = byZone.get(zoneId) ?? []
        arr.push(parseInt(idxStr))
        byZone.set(zoneId, arr)
      }
      setZoneBeziers(prev => {
        const next = { ...prev }
        for (const [zoneId, indices] of byZone) {
          const nodes = next[zoneId]
          if (!nodes) continue
          // Empêche de descendre en dessous de 3 anchors (sinon courbe dégénérée).
          const keep = nodes.filter((_, i) => !indices.includes(i))
          if (keep.length >= 3) next[zoneId] = keep
        }
        return next
      })
      setSelectedAnchors(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedAnchors])

  // ---------- Bézier helpers ----------
  async function toggleBezierMode(zoneId: string) {
    setActiveZoneId(zoneId)
    const willEdit = !bezierEditing[zoneId]
    setBezierEditing(prev => ({ ...prev, [zoneId]: willEdit }))
    if (!willEdit || zoneBeziers[zoneId]) return

    // Source du contour à snapshoter :
    // - body  → bodySilhouette (déjà subtracté + bridgé)
    // - autre → legLoops[id][0]
    let source: Point2D[] | null = zoneId === 'body'
      ? bodySilhouette
      : (legLoops[zoneId]?.[0] ?? null)

    // Fallback body : si pas de silhouette en mémoire, on la détecte inline.
    if (zoneId === 'body' && (!source || source.length < 3) && imageRef.current) {
      try {
        const img = imageRef.current
        const w = img.naturalWidth, h = img.naturalHeight
        const off = document.createElement('canvas')
        off.width = w; off.height = h
        off.getContext('2d')!.drawImage(img, 0, 0)
        const imgData = off.getContext('2d')!.getImageData(0, 0, w, h)
        const result = await flowCannySegmentZones(
          imgData, [],
          cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize,
        )
        if (result.silhouette && result.silhouette.length >= 3) {
          source = result.silhouette
          setBodySilhouette(result.silhouette)
        }
      } catch (err) {
        console.error('[Bézier body] silhouette auto-detect failed:', err)
      }
    }

    if (source && source.length >= 3) {
      const sm = smoothPolygonGaussian(source, sigmaFor(zoneId))
      const sub = subsamplePolygon(sm.map(pt => ({ x: pt.x, y: pt.y })), 600)
      setZoneCannyRefs(p => ({ ...p, [zoneId]: sub }))
      // Auto-fit Schneider immédiat avec paramètres par défaut (2 px / 60°) —
      // place les anchors aux changements de courbure et marque les coins.
      const fitted = fitBezierToClosedPolygon(sub, {
        tolerance: 2,
        cornerThresholdDeg: 60,
        cornerSmoothWindow: 3,
      })
      if (fitted.length >= 2) {
        setZoneBeziers(p => ({ ...p, [zoneId]: fitted }))
      }
    } else {
      alert(zoneId === 'body'
        ? 'Impossible de détecter le contour du body. Cliquez d’abord pour le détecter (Body actif + clic sur le canvas), puis réessayez.'
        : 'Aucun contour Canny disponible pour cette zone. Placez d’abord des seeds (clics) pour la détecter.')
      setBezierEditing(prev => ({ ...prev, [zoneId]: false }))
    }
  }
  function clearBezier(zoneId: string) {
    setZoneBeziers(prev => { const n = { ...prev }; delete n[zoneId]; return n })
    setZoneCannyRefs(prev => { const n = { ...prev }; delete n[zoneId]; return n })
    setBezierPreviewCount(prev => { const n = { ...prev }; delete n[zoneId]; return n })
    setBezierFitParams(prev => { const n = { ...prev }; delete n[zoneId]; return n })
    setBezierEditing(prev => ({ ...prev, [zoneId]: false }))
    setLegLoops(prev => { const n = { ...prev }; delete n[zoneId]; return n })
  }

  /** Refresh le snapshot Canny depuis le contour Canny courant (au cas où
   *  les seeds / sigma / inflate ont changé depuis le 1er toggle Bézier). */
  function refreshBezierCannyRef(zoneId: string) {
    const source = zoneId === 'body' ? bodySilhouette : legLoops[zoneId]?.[0]
    if (!source || source.length < 3) return
    const sm = smoothPolygonGaussian(source, sigmaFor(zoneId))
    const sub = subsamplePolygon(sm.map(pt => ({ x: pt.x, y: pt.y })), 600)
    setZoneCannyRefs(p => ({ ...p, [zoneId]: sub }))
  }

  /** Resample N anchors directement sur le contour Canny snapshoté (uniforme). */
  function validateBezierResample(zoneId: string) {
    const ref = zoneCannyRefs[zoneId]
    const target = bezierPreviewCount[zoneId]
    if (!ref || ref.length < 3 || target == null) return
    const next = polygonToBezierNodes(ref, Math.max(3, Math.min(128, target)))
    setZoneBeziers(p => ({ ...p, [zoneId]: next }))
    setBezierPreviewCount(p => { const n = { ...p }; delete n[zoneId]; return n })
    setSelectedAnchors(new Set())
  }

  /** Auto-fit Schneider sur le contour Canny snapshoté.
   *  Place les anchors là où la courbure varie + détecte les coins durs.
   *  Si la référence Canny n'existe pas encore, on la calcule inline depuis
   *  bodySilhouette / legLoops[id][0]. */
  function validateBezierAutoFit(zoneId: string) {
    const params = bezierFitParams[zoneId]
    if (!params) return
    let ref = zoneCannyRefs[zoneId]
    if (!ref || ref.length < 3) {
      const source = zoneId === 'body' ? bodySilhouette : legLoops[zoneId]?.[0]
      if (!source || source.length < 3) {
        alert('Aucun contour Canny disponible — détectez d’abord la zone.')
        return
      }
      const smSrc = smoothPolygonGaussian(source, sigmaFor(zoneId))
      ref = subsamplePolygon(smSrc.map(pt => ({ x: pt.x, y: pt.y })), 600)
      setZoneCannyRefs(p => ({ ...p, [zoneId]: ref! }))
    }
    const next = fitBezierToClosedPolygon(ref, {
      tolerance: params.tolerance,
      cornerThresholdDeg: params.cornerDeg,
      cornerSmoothWindow: 3,
    })
    if (next.length < 2) {
      alert('L’auto-fit n’a produit aucune courbe (réduire le seuil coin, augmenter la tolérance, ou vérifier le contour source).')
      return
    }
    setZoneBeziers(p => ({ ...p, [zoneId]: next }))
    setBezierFitParams(p => { const n = { ...p }; delete n[zoneId]; return n })
    setSelectedAnchors(new Set())
  }

  /** Test si le clic touche un anchor/handle d'une zone Bézier en édition.
   *  Retourne null si aucune zone est en édition ou aucun hit. */
  function hitTestBezier(p: Point2D):
    | { zoneId: string; index: number; kind: 'anchor' | 'handleIn' | 'handleOut' }
    | null {
    const r = 10 / transformRef.current.scale
    const r2 = r * r
    for (const zoneId of zones.map(z => z.id)) {
      if (!bezierEditing[zoneId]) continue
      const nodes = zoneBeziers[zoneId]
      if (!nodes) continue
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        if (dist2(p, n.anchor) <= r2) return { zoneId, index: i, kind: 'anchor' }
        if (dist2(p, n.handleIn) <= r2) return { zoneId, index: i, kind: 'handleIn' }
        if (dist2(p, n.handleOut) <= r2) return { zoneId, index: i, kind: 'handleOut' }
      }
    }
    return null
  }

  /** Trouve le segment Bézier d'une zone éditée le plus proche du clic + son t. */
  function nearestBezierSegment(zoneId: string, p: Point2D, maxDist: number):
    | { segIndex: number; t: number; point: Point2D; dist: number } | null {
    const nodes = zoneBeziers[zoneId]
    if (!nodes || nodes.length < 2) return null
    let best: { segIndex: number; t: number; point: Point2D; dist: number } | null = null
    const N = nodes.length
    for (let i = 0; i < N; i++) {
      const a = nodes[i], b = nodes[(i + 1) % N]
      // sample 30 points + take closest
      for (let s = 0; s <= 30; s++) {
        const t = s / 30
        const pt = evaluateCubicBezier(a.anchor, a.handleOut, b.handleIn, b.anchor, t)
        const d = Math.hypot(pt.x - p.x, pt.y - p.y)
        if (!best || d < best.dist) best = { segIndex: i, t, point: pt, dist: d }
      }
    }
    return best && best.dist <= maxDist ? best : null
  }

  function insertBezierAnchor(zoneId: string, segIndex: number, t: number) {
    setZoneBeziers(prev => {
      const nodes = prev[zoneId]
      if (!nodes) return prev
      const N = nodes.length
      const a = nodes[segIndex], b = nodes[(segIndex + 1) % N]
      const pt = evaluateCubicBezier(a.anchor, a.handleOut, b.handleIn, b.anchor, t)
      // Tangent local : dérivée du Bézier (approx)
      const eps = 0.01
      const pt2 = evaluateCubicBezier(a.anchor, a.handleOut, b.handleIn, b.anchor, Math.min(1, t + eps))
      const tx = (pt2.x - pt.x) / eps, ty = (pt2.y - pt.y) / eps
      const len = Math.hypot(tx, ty) || 1
      // Espacement des handles ~ longueur du segment / 4
      const segLen = Math.hypot(b.anchor.x - a.anchor.x, b.anchor.y - a.anchor.y)
      const h = segLen / 4
      const ux = tx / len, uy = ty / len
      const newNode: BezierNode = {
        anchor: { x: pt.x, y: pt.y },
        handleIn:  { x: pt.x - ux * h, y: pt.y - uy * h },
        handleOut: { x: pt.x + ux * h, y: pt.y + uy * h },
        smooth: true,
      }
      const next = [...nodes]
      next.splice(segIndex + 1, 0, newNode)
      return { ...prev, [zoneId]: next }
    })
    setSelectedAnchors(new Set())
  }

  function removeBezierAnchor(zoneId: string, index: number) {
    setZoneBeziers(prev => {
      const nodes = prev[zoneId]
      if (!nodes || nodes.length <= 3) return prev   // garde au moins un triangle
      const next = nodes.filter((_, i) => i !== index)
      return { ...prev, [zoneId]: next }
    })
    setSelectedAnchors(new Set())
  }

  /** Bascule un anchor Bézier entre "lisse" (handles symétriques tangents
   *  aux voisins, style Catmull-Rom) et "anguleux" (handles collapsés sur
   *  l'anchor → coin dur). Déclenché par double-clic sur l'anchor. */
  function toggleBezierNodeSmooth(zoneId: string, index: number) {
    setZoneBeziers(prev => {
      const nodes = prev[zoneId]
      if (!nodes) return prev
      const N = nodes.length
      const n = nodes[index]
      const becomeSmooth = !n.smooth
      const a = n.anchor
      let updated: BezierNode
      if (becomeSmooth) {
        // Tangente Catmull-Rom uniforme à partir des voisins.
        const prevA = nodes[(index - 1 + N) % N].anchor
        const nextA = nodes[(index + 1) % N].anchor
        const dx = (nextA.x - prevA.x) / 6
        const dy = (nextA.y - prevA.y) / 6
        updated = {
          anchor: { x: a.x, y: a.y },
          handleIn:  { x: a.x - dx, y: a.y - dy },
          handleOut: { x: a.x + dx, y: a.y + dy },
          smooth: true,
        }
      } else {
        // Coin dur : handles collapsés sur l'anchor.
        updated = {
          anchor: { x: a.x, y: a.y },
          handleIn:  { x: a.x, y: a.y },
          handleOut: { x: a.x, y: a.y },
          smooth: false,
        }
      }
      const next = [...nodes]
      next[index] = updated
      return { ...prev, [zoneId]: next }
    })
  }

  function handleDoubleClick(e: React.MouseEvent) {
    if (e.button !== 0) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const bezHit = hitTestBezier(imgPos)
    if (bezHit && bezHit.kind === 'anchor') {
      e.preventDefault()
      e.stopPropagation()
      toggleBezierNodeSmooth(bezHit.zoneId, bezHit.index)
    }
  }

  // ---------- Mouse handlers ----------
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (spaceDown.current || isPanning.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)

    // 1. Priorité : hit-test Bézier (anchor / handle)
    const bezHit = hitTestBezier(imgPos)
    if (bezHit) {
      if (bezHit.kind === 'anchor') {
        const key = anchorKey(bezHit.zoneId, bezHit.index)
        // Shift+clic = toggle de la sélection sans drag
        if (e.shiftKey) {
          setSelectedAnchors(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
          return
        }
        // Si l'anchor est dans la sélection multi → drag groupé
        if (selectedAnchors.has(key) && selectedAnchors.size > 1) {
          const nodes = zoneBeziers[bezHit.zoneId]
          if (nodes) {
            const snapshot = new Map<number, { anchor: Point2D; handleIn: Point2D; handleOut: Point2D }>()
            for (const k of selectedAnchors) {
              const [zid, idxStr] = k.split(':')
              if (zid !== bezHit.zoneId) continue
              const idx = parseInt(idxStr)
              const n = nodes[idx]
              if (!n) continue
              snapshot.set(idx, {
                anchor: { ...n.anchor },
                handleIn: { ...n.handleIn },
                handleOut: { ...n.handleOut },
              })
            }
            draggingBezierRef.current = { zoneId: bezHit.zoneId, kind: 'group', startMouse: imgPos, snapshot }
            return
          }
        }
        // Clic simple sur un anchor non sélectionné → drag single, sélection écrasée par cet anchor
        setSelectedAnchors(new Set([key]))
        draggingBezierRef.current = { zoneId: bezHit.zoneId, index: bezHit.index, kind: 'anchor' }
      } else {
        draggingBezierRef.current = {
          zoneId: bezHit.zoneId, index: bezHit.index, kind: bezHit.kind,
          symmetric: !e.altKey,
        }
      }
      return
    }

    // 2. Si la zone active est en édition Bézier (membre OU body)
    if (bezierEditing[activeZoneId]) {
      // Clic sur la courbe : insertion d'anchor
      const onCurve = nearestBezierSegment(activeZoneId, imgPos, 14 / transformRef.current.scale)
      if (onCurve) {
        insertBezierAnchor(activeZoneId, onCurve.segIndex, onCurve.t)
        return
      }
      // Sinon : démarre une sélection rectangle. Shift = additif, sinon écrase la sélection.
      if (!e.shiftKey) setSelectedAnchors(new Set())
      setRectSelect({ zoneId: activeZoneId, start: imgPos, end: imgPos, additive: e.shiftKey })
      return
    }

    // 3. Fallback : hit-test seed Canny
    const hit = hitTestWaypoint(imgPos)
    if (hit) {
      draggingSeedRef.current = hit
      return
    }
    if (activeZoneId === 'body') {
      // Ne pas écraser un body Bézier validé : si zoneBeziers['body'] existe
      // mais qu'on n'est pas en édition Bézier, on ignore le clic.
      if (!zoneBeziers['body']) handleCannyBodyClick()
    } else if (memberZoneIds.includes(activeZoneId)) {
      addLegSeed(activeZoneId, imgPos)
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    // Rectangle de sélection en cours ?
    if (rectSelect) {
      const imgPos = screenToImage(e.clientX, e.clientY)
      setRectSelect(r => r ? { ...r, end: imgPos } : null)
      return
    }
    // Drag Bézier ?
    const bz = draggingBezierRef.current
    if (bz) {
      const imgPos = screenToImage(e.clientX, e.clientY)
      // Group drag : applique le delta à tous les anchors du snapshot
      if (bz.kind === 'group') {
        const dx = imgPos.x - bz.startMouse.x
        const dy = imgPos.y - bz.startMouse.y
        setZoneBeziers(prev => {
          const nodes = prev[bz.zoneId]
          if (!nodes) return prev
          const next = nodes.map((n, i) => {
            const snap = bz.snapshot.get(i)
            if (!snap) return n
            return {
              ...n,
              anchor: { x: snap.anchor.x + dx, y: snap.anchor.y + dy },
              handleIn: { x: snap.handleIn.x + dx, y: snap.handleIn.y + dy },
              handleOut: { x: snap.handleOut.x + dx, y: snap.handleOut.y + dy },
            }
          })
          return { ...prev, [bz.zoneId]: next }
        })
        return
      }
      setZoneBeziers(prev => {
        const nodes = prev[bz.zoneId]
        if (!nodes) return prev
        const next = nodes.map((n, i) => {
          if (i !== bz.index) return n
          if (bz.kind === 'anchor') {
            const dx = imgPos.x - n.anchor.x
            const dy = imgPos.y - n.anchor.y
            return {
              ...n,
              anchor: { x: imgPos.x, y: imgPos.y },
              handleIn:  { x: n.handleIn.x + dx, y: n.handleIn.y + dy },
              handleOut: { x: n.handleOut.x + dx, y: n.handleOut.y + dy },
            }
          }
          if (bz.kind === 'handleOut') {
            if (bz.symmetric && n.smooth) {
              return {
                ...n,
                handleOut: { x: imgPos.x, y: imgPos.y },
                handleIn:  { x: 2 * n.anchor.x - imgPos.x, y: 2 * n.anchor.y - imgPos.y },
              }
            }
            return { ...n, handleOut: { x: imgPos.x, y: imgPos.y }, smooth: !bz.symmetric ? false : n.smooth }
          }
          // handleIn
          if (bz.symmetric && n.smooth) {
            return {
              ...n,
              handleIn: { x: imgPos.x, y: imgPos.y },
              handleOut: { x: 2 * n.anchor.x - imgPos.x, y: 2 * n.anchor.y - imgPos.y },
            }
          }
          return { ...n, handleIn: { x: imgPos.x, y: imgPos.y }, smooth: !bz.symmetric ? false : n.smooth }
        })
        return { ...prev, [bz.zoneId]: next }
      })
      return
    }

    // Drag seed Canny
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
    draggingBezierRef.current = null
    // Finalise la sélection rectangle
    if (rectSelect) {
      const minX = Math.min(rectSelect.start.x, rectSelect.end.x)
      const maxX = Math.max(rectSelect.start.x, rectSelect.end.x)
      const minY = Math.min(rectSelect.start.y, rectSelect.end.y)
      const maxY = Math.max(rectSelect.start.y, rectSelect.end.y)
      const nodes = zoneBeziers[rectSelect.zoneId]
      const hit = new Set<string>()
      if (nodes) {
        for (let i = 0; i < nodes.length; i++) {
          const p = nodes[i].anchor
          if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
            hit.add(anchorKey(rectSelect.zoneId, i))
          }
        }
      }
      // Click bref (rectangle dégénéré) sans Shift = clear sans rien sélectionner.
      const degenerate = (maxX - minX) < 2 && (maxY - minY) < 2
      if (!degenerate) {
        setSelectedAnchors(prev => {
          if (rectSelect.additive) {
            const next = new Set(prev)
            for (const k of hit) next.add(k)
            return next
          }
          return hit
        })
      }
      setRectSelect(null)
    }
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (spaceDown.current || isPanning.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    // Bézier : clic droit sur un anchor = suppression
    const bezHit = hitTestBezier(imgPos)
    if (bezHit && bezHit.kind === 'anchor') {
      removeBezierAnchor(bezHit.zoneId, bezHit.index)
      return
    }
    if (activeZoneId === 'body') {
      // Préserve un body Bézier validé (sinon perte de tout le travail manuel).
      if (!zoneBeziers['body']) setBodySilhouette(null)
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
    const missing = memberZoneIds.filter(id => !legLoops[id] || legLoops[id].length === 0)
    if (missing.length > 0) {
      const names = missing.map(id => zones.find(z => z.id === id)?.label ?? id).join(', ')
      alert(`Placez au moins un clic dans chaque membre : ${names}`)
      return null
    }
    const disconnected = memberZoneIds.filter(id => (legLoops[id]?.length ?? 0) > 1)
    if (disconnected.length > 0) {
      const names = disconnected.map(id => zones.find(z => z.id === id)?.label ?? id).join(', ')
      alert(`Plusieurs zones déconnectées détectées (${names}). Augmente l'inflate pour les fusionner en une seule, ou retire un clic.`)
      return null
    }
    const rawByZone: Record<string, Point2D[]> = { body: bodySilhouette }
    for (const id of memberZoneIds) rawByZone[id] = legLoops[id][0]
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

      const updatedTri = {
        ...pt,
        zones,
        prompts: [],
        masksRLE: finalized.masks,
        maskWidth: finalized.dims.w,
        maskHeight: finalized.dims.h,
        contours: finalized.contours,
        contourSmoothSigma: sigma,
        bridgeThreshold,
        segmentationMode: 'canny' as const,
        cannyParams,
        // Persiste les seeds + overrides + courbes Bézier pour reprise d'édition
        zoneSeeds: { ...legSeeds },
        zoneSmoothSigmas: { ...zoneSigmas },
        zoneInflates: { ...zoneInflates },
        zoneBeziers: { ...zoneBeziers },
        zoneCannyRefs: { ...zoneCannyRefs },
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
      }

      const updated: Project = {
        ...project,
        projectTriangulation: updatedTri,
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
              <button
                onClick={() => toggleBezierMode(z.id)}
                title={bezierEditing[z.id]
                  ? 'Quitter l’édition Bézier (la courbe reste appliquée).'
                  : zoneBeziers[z.id]
                    ? 'Reprendre l’édition Bézier (anchors + handles).'
                    : isBody
                      ? 'Convertir le body en Bézier éditable. Le bridge auto sera désactivé une fois validé.'
                      : 'Convertir le contour en courbe Bézier éditable manuellement.'}
                style={{
                  border: `2px solid ${zoneBeziers[z.id] ? z.color : '#94a3b8'}`,
                  background: bezierEditing[z.id] ? z.color : (zoneBeziers[z.id] ? `${z.color}33` : 'transparent'),
                  color: bezierEditing[z.id] ? '#fff' : (zoneBeziers[z.id] ? z.color : '#94a3b8'),
                  cursor: 'pointer', fontSize: '0.7rem', padding: '2px 6px',
                  borderRadius: 4, fontWeight: 'bold',
                }}
              >📐 BÉZIER</button>
              {zoneBeziers[z.id] && (
                <button
                  onClick={() => { if (confirm(`Réinitialiser la courbe Bézier de "${z.label}"${isBody ? ' (le bridge auto sera ré-activé)' : ' (retour au contour Canny)'} ?`)) clearBezier(z.id) }}
                  title={isBody
                    ? 'Supprimer la courbe Bézier body et réactiver le bridge auto'
                    : 'Supprimer la courbe Bézier et reprendre le contour Canny'}
                  style={{
                    border: 'none', background: 'transparent', color: '#94a3b8',
                    cursor: 'pointer', fontSize: '0.85rem', padding: '0 2px',
                  }}
                >↺</button>
              )}
              {!isBody && (
                <button
                  onClick={() => {
                    if (!confirm(`Supprimer la zone "${z.label}" ?`)) return
                    setZones(zs => zs.filter(x => x.id !== z.id))
                    setLegSeeds(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    setLegLoops(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    setZoneBeziers(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    setZoneCannyRefs(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    setBezierPreviewCount(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    setBezierEditing(prev => { const n = { ...prev }; delete n[z.id]; return n })
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
          {bezierEditing[activeZoneId]
            ? `Bézier : drag anchor/handle · Alt+drag handle = asymétrique · clic courbe = ajouter · clic droit anchor = supprimer · drag vide = sélection rectangle · Shift+clic = multi · Suppr/Backspace = supprimer sélection${selectedAnchors.size > 0 ? `  (${selectedAnchors.size} sélectionné${selectedAnchors.size > 1 ? 's' : ''})` : ''}`
            : cannyComputing ? 'Calcul flood-fill...'
            : computing ? 'Calcul silhouette...'
            : 'Clic Body = silhouette, clic Membre = ajouter une région (clics multiples = union)'}
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
          title="Dilatation globale appliquée par défaut à chaque zone. Engulfe le trait noir et, si deux dilatations se touchent, elles fusionnent automatiquement.">
          Inflate global:
          <input type="range" min={0} max={80} step={1}
            value={inflate}
            onChange={e => setInflate(parseInt(e.target.value))}
            style={{ width: 100 }} />
          <span style={{ minWidth: 28, textAlign: 'center' }}>{inflate}</span>
        </label>
        {(() => {
          const activeZone = zones.find(z => z.id === activeZoneId)
          if (!activeZone || activeZone.id === 'body') return null
          const val = zoneInflates[activeZoneId] ?? inflate
          return (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}
              title={`Inflate spécifique à la zone "${activeZone.label}". Override de l'inflate global.`}>
              <span style={{ color: activeZone.color, fontWeight: 'bold' }}>Inflate {activeZone.label} :</span>
              <input type="range" min={0} max={80} step={1}
                value={val}
                onChange={e => setZoneInflates(prev => ({ ...prev, [activeZoneId]: parseInt(e.target.value) }))}
                style={{ width: 100 }} />
              <span style={{ minWidth: 28, textAlign: 'center' }}>{val}</span>
              {zoneInflates[activeZoneId] != null && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setZoneInflates(prev => { const n = { ...prev }; delete n[activeZoneId]; return n })}
                  title="Réinitialiser à l'inflate global"
                >↺</button>
              )}
            </label>
          )
        })()}
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
          {/* Bézier : sliders auto-fit Schneider (tolérance + seuil coin) */}
          {(() => {
            const activeZone = zones.find(z => z.id === activeZoneId)
            if (!activeZone) return null
            const editing = bezierEditing[activeZoneId]
            const nodes = zoneBeziers[activeZoneId]
            if (!nodes && !editing) return null
            const hasRef = (zoneCannyRefs[activeZoneId]?.length ?? 0) >= 3
            const fit = bezierFitParams[activeZoneId]
            const fitTol = fit?.tolerance ?? 2
            const fitCorner = fit?.cornerDeg ?? 60
            const fitDirty = fit != null
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', flexWrap: 'wrap' }}
                title="Auto-fit Schneider : place les anchors là où la courbure change. Tolérance px = fidélité (petit = précis, beaucoup d'anchors). Seuil coin = angle au-delà duquel un anchor devient un coin dur (smooth=false).">
                <span style={{ color: activeZone.color, fontWeight: 'bold' }}>🎯 Auto-fit :</span>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Tol
                  <input
                    type="range" min={0.5} max={10} step={0.1}
                    value={fitTol}
                    disabled={!hasRef}
                    onChange={e => setBezierFitParams(p => ({ ...p, [activeZoneId]: { tolerance: parseFloat(e.target.value), cornerDeg: fitCorner } }))}
                    style={{ width: 90 }}
                  />
                  <span style={{ minWidth: 30 }}>{fitTol.toFixed(1)} px</span>
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  Coin
                  <input
                    type="range" min={10} max={150} step={5}
                    value={fitCorner}
                    disabled={!hasRef}
                    onChange={e => setBezierFitParams(p => ({ ...p, [activeZoneId]: { tolerance: fitTol, cornerDeg: parseFloat(e.target.value) } }))}
                    style={{ width: 90 }}
                  />
                  <span style={{ minWidth: 28 }}>{fitCorner}°</span>
                </label>
                {fitDirty && (
                  <button
                    className="btn-primary btn-sm"
                    onClick={() => validateBezierAutoFit(activeZoneId)}
                    title="Appliquer le fit auto"
                  >Valider</button>
                )}
                {fitDirty && (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => setBezierFitParams(p => { const n = { ...p }; delete n[activeZoneId]; return n })}
                    title="Annuler le preview"
                  >✕</button>
                )}
              </span>
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
          onDoubleClick={handleDoubleClick}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          style={{ cursor: 'crosshair' }}
        />
      </div>
    </div>
  )
}
