import { useState, useEffect, useRef, useCallback } from 'react'
import type { Project, SAM2Prompt, SAM2Zone, RLEMask, Point2D, CannyParams } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { encodePngAsFakeMp4, requestSam2Segmentation } from '../../utils/sam2Segmentation'
import type { SAM2Phase } from '../../utils/sam2Segmentation'
import { maskToImageData, decodeRLEMinusRLEs } from '../../utils/rleMask'
import { rleToContour, smoothPolygonGaussian, bridgeContourAtLegs } from '../../utils/sam2Contour'
import { flowMaskToContour, flowCannySegmentZones } from '../../utils/perspectiveCorrection'
import { rasterizePolygonToMaskRLE } from '../../utils/cannyZoneContours'
import LocalServerHelp from './LocalServerHelp'

type SegMode = 'sam2' | 'canny'
const DEFAULT_CANNY: CannyParams = { lowThreshold: 50, highThreshold: 150, blurSize: 5 }

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/** Default 5 zones (body + 4 legs). */
const DEFAULT_ZONES: SAM2Zone[] = [
  { id: 'body',   label: 'Body',      color: '#22c55e' },
  { id: 'leg-fl', label: 'Patte AVG', color: '#f59e0b' },
  { id: 'leg-fr', label: 'Patte AVD', color: '#ef4444' },
  { id: 'leg-bl', label: 'Patte ARG', color: '#3b82f6' },
  { id: 'leg-br', label: 'Patte ARD', color: '#a855f7' },
]

const LEG_IDS = ['leg-fl', 'leg-fr', 'leg-bl', 'leg-br']
const OVERLAY_ALPHA = 90

export default function ProjectTriangZonesStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [computing, setComputing] = useState(false)
  const [computePhase, setComputePhase] = useState<SAM2Phase | 'idle'>('idle')
  const [extractingContours, setExtractingContours] = useState(false)

  // Zones (hardcoded 5)
  const [zones] = useState<SAM2Zone[]>(
    () => {
      const saved = project.projectTriangulation?.zones
      return saved && saved.length > 0 ? saved : DEFAULT_ZONES
    }
  )

  // Active zone for new clicks
  const [activeZoneId, setActiveZoneId] = useState<string>(
    () => project.projectTriangulation?.zones?.[0]?.id ?? DEFAULT_ZONES[0].id
  )
  // Prompts (clicks) — always in image coordinates
  const [prompts, setPrompts] = useState<SAM2Prompt[]>(
    () => project.projectTriangulation?.prompts ?? []
  )
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  // Computed masks (loaded from project or computed by SAM 2)
  const [masks, setMasks] = useState<Record<string, RLEMask[]> | null>(
    () => project.projectTriangulation?.masksRLE ?? null
  )
  const [maskDims, setMaskDims] = useState<{ w: number; h: number } | null>(() => {
    const pt = project.projectTriangulation
    if (pt?.maskWidth && pt?.maskHeight) return { w: pt.maskWidth, h: pt.maskHeight }
    return null
  })

  // Contours (extracted from masks)
  const [contours, setContours] = useState<Record<string, Point2D[]> | null>(
    () => project.projectTriangulation?.contours ?? null
  )

  // Smoothing params
  const [sigma, setSigma] = useState<number>(
    () => project.projectTriangulation?.contourSmoothSigma ?? 3
  )
  const [bridgeThreshold, setBridgeThreshold] = useState<number>(
    () => project.projectTriangulation?.bridgeThreshold ?? 8
  )
  // Per-zone smoothing sigma (canny mode). Falls back to global `sigma` when unset.
  const [zoneSigmas, setZoneSigmas] = useState<Record<string, number>>({})
  const sigmaFor = useCallback((zoneId: string) => zoneSigmas[zoneId] ?? sigma, [zoneSigmas, sigma])

  // Segmentation mode + Canny params
  const [mode, setMode] = useState<SegMode>(
    () => project.projectTriangulation?.segmentationMode ?? 'sam2'
  )
  const [cannyParams, setCannyParams] = useState<CannyParams>(
    () => project.projectTriangulation?.cannyParams ?? DEFAULT_CANNY
  )
  const [inflate, setInflate] = useState<number>(12)
  // Cache of raw (un-smoothed) contours per zone in IMAGE coords, used by the
  // Canny branch so that moving the sigma slider re-smooths instantly without
  // re-running OpenCV.
  const rawZoneContoursRef = useRef<Record<string, Point2D[]> | null>(null)

  // ---- Canny interactive mode state ----
  // Seeds clicked per leg zone (raw image coords, inside the zone).
  const [legSeeds, setLegSeeds] = useState<Record<string, Point2D[]>>({})
  // Loops produced by the worker flood-fill+union (one polygon per leg).
  const [legLoops, setLegLoops] = useState<Record<string, Point2D[]>>({})
  const [bodySilhouette, setBodySilhouette] = useState<Point2D[] | null>(null)
  const [cannyComputing, setCannyComputing] = useState(false)
  const draggingSeedRef = useRef<{ zoneId: string; index: number } | null>(null)
  const cannyComputeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Image state
  const [imageReady, setImageReady] = useState(false)
  const [imageSize, setImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Cached mask overlay images
  const overlayImagesRef = useRef<Map<string, HTMLCanvasElement>>(new Map())

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const draggingIdx = useRef<number | null>(null)
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

  // ---------- Fit canvas after image ready ----------
  useEffect(() => {
    if (!imageReady || fittedRef.current) return
    fitToCanvas(imageSize.w, imageSize.h)
    fittedRef.current = true
  }, [imageReady, imageSize, fitToCanvas])

  // ---------- Resize canvas ----------
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

  // ---------- Debounced flood-fill compute (canny mode) ----------
  // Rebuilds body silhouette + per-leg union contours via `flowCannySegmentZones`
  // whenever seeds or canny params change.
  const cannyParamsKey = `${cannyParams.lowThreshold}|${cannyParams.highThreshold}|${cannyParams.blurSize}`
  const recomputeCannyZones = useCallback(async (seedsSnapshot: Record<string, Point2D[]>) => {
    if (!imageRef.current) return
    const img = imageRef.current
    const w = img.naturalWidth, h = img.naturalHeight
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    off.getContext('2d')!.drawImage(img, 0, 0)
    const imgData = off.getContext('2d')!.getImageData(0, 0, w, h)
    const seeds = LEG_IDS
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
      for (const legId of LEG_IDS) {
        const c = result.zoneContours[legId]
        if (c && c.length >= 3) nextLoops[legId] = c
      }
      setLegLoops(nextLoops)

      // Body silhouette : subtract leg masks + bridge contour over legs, same
      // as SAM 2 mode. Falls back to the raw silhouette when no legs are set.
      if (result.silhouette && result.silhouette.length >= 3) {
        const legContoursForBridge = LEG_IDS
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
  }, [cannyParams.lowThreshold, cannyParams.highThreshold, cannyParams.blurSize, inflate, bridgeThreshold])

  const scheduleCannyRecompute = useCallback((seedsSnapshot: Record<string, Point2D[]>) => {
    if (cannyComputeTimerRef.current) clearTimeout(cannyComputeTimerRef.current)
    cannyComputeTimerRef.current = setTimeout(() => recomputeCannyZones(seedsSnapshot), 150)
  }, [recomputeCannyZones])

  useEffect(() => {
    if (mode !== 'canny' || !imageReady) return
    scheduleCannyRecompute(legSeeds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, imageReady, cannyParamsKey, inflate, bridgeThreshold])

  // ---------- Build mask overlay canvases ----------
  useEffect(() => {
    overlayImagesRef.current.clear()
    if (!masks) return
    for (const z of zones) {
      const zoneMasks = masks[z.id]
      if (!zoneMasks || zoneMasks.length === 0) continue
      const rle = zoneMasks[0] // single image = 1 frame
      const [r, g, b] = hexToRgb(z.color)
      const imageData = maskToImageData(rle, [r, g, b, OVERLAY_ALPHA])
      const off = document.createElement('canvas')
      off.width = imageData.width
      off.height = imageData.height
      off.getContext('2d')!.putImageData(imageData, 0, 0)
      overlayImagesRef.current.set(z.id, off)
    }
  }, [masks, zones])

  // ---------- Extract contours from masks ----------
  const extractContours = useCallback(async (
    currentMasks: Record<string, RLEMask[]>,
    currentMaskDims: { w: number; h: number },
    currentSigma: number,
    currentBridgeThreshold: number,
  ) => {
    setExtractingContours(true)
    try {
      const imgW = imageSize.w
      const imgH = imageSize.h
      const mW = currentMaskDims.w
      const mH = currentMaskDims.h
      const scaleX = imgW / mW
      const scaleY = imgH / mH

      // 1. Extract raw contours for each leg zone
      const legContours: Record<string, Point2D[]> = {}
      const legRawContours: Point2D[][] = []
      for (const legId of LEG_IDS) {
        const zoneMasks = currentMasks[legId]
        if (!zoneMasks || zoneMasks.length === 0) continue
        const raw = await rleToContour(zoneMasks[0])
        const smoothed = smoothPolygonGaussian(raw, currentSigma)
        // Convert mask coords to image coords
        const converted = smoothed.map(p => ({
          x: p.x * scaleX,
          y: p.y * scaleY,
        }))
        legContours[legId] = converted
        legRawContours.push(smoothed) // keep in mask coords for body bridging
      }

      // 2. Extract body contour: subtract all legs, then bridge, then smooth
      const bodyMasks = currentMasks['body']
      if (bodyMasks && bodyMasks.length > 0) {
        const legRLEs = LEG_IDS
          .map(id => currentMasks[id]?.[0])
          .filter((m): m is RLEMask => m != null)
        // Subtract leg masks from body
        const bodyMask = decodeRLEMinusRLEs(bodyMasks[0], legRLEs)
        const [h, w] = bodyMasks[0].size
        // Extract contour from the subtracted mask via OpenCV
        const rawBody = await flowMaskToContour(bodyMask, w, h)
        // Bridge at legs (skip portions of body contour adjacent to leg contours)
        const bridged = bridgeContourAtLegs(rawBody, legRawContours, currentBridgeThreshold)
        const smoothedBody = smoothPolygonGaussian(bridged, currentSigma)
        // Convert mask coords to image coords
        legContours['body'] = smoothedBody.map(p => ({
          x: p.x * scaleX,
          y: p.y * scaleY,
        }))
      }

      setContours(legContours)
    } catch (err) {
      console.error('Contour extraction failed:', err)
      alert('Erreur extraction contours : ' + (err instanceof Error ? err.message : err))
    }
    setExtractingContours(false)
  }, [imageSize])

  // ---------- Re-extract contours when sigma or bridgeThreshold changes ----------
  const sigmaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (sigmaTimerRef.current) clearTimeout(sigmaTimerRef.current)
    sigmaTimerRef.current = setTimeout(() => {
      if (mode === 'sam2') {
        if (!masks || !maskDims) return
        extractContours(masks, maskDims, sigma, bridgeThreshold)
      } else {
        // Canny mode: re-smooth the cached raw contours + re-rasterize masks
        const raw = rawZoneContoursRef.current
        if (!raw || !maskDims) return
        const smoothed: Record<string, Point2D[]> = {}
        const newMasks: Record<string, RLEMask[]> = {}
        for (const z of zones) {
          const r = raw[z.id]
          if (!r || r.length < 3) continue
          const s = smoothPolygonGaussian(r, sigma)
          smoothed[z.id] = s
          newMasks[z.id] = [rasterizePolygonToMaskRLE(s, maskDims.w, maskDims.h)]
        }
        setContours(smoothed)
        setMasks(newMasks)
      }
    }, 300)
    return () => {
      if (sigmaTimerRef.current) clearTimeout(sigmaTimerRef.current)
    }
  }, [sigma, bridgeThreshold, masks, maskDims, extractContours, mode, zones])

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

      // Draw image
      ctx.drawImage(img, 0, 0)

      // Canny mode: draw body silhouette + leg loops + seed dots
      if (mode === 'canny') {
        // Body silhouette (smoothed live with per-zone sigma)
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
        // Leg loops (smoothed live with per-zone sigma)
        for (const legId of LEG_IDS) {
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
        // Leg seeds (filled dots inside the zone, one per click)
        const sr = 6 / t.scale
        for (const legId of LEG_IDS) {
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
        return
      }

      // Draw mask overlays (masks are in mask coords, scale to image coords)
      if (maskDims) {
        for (const z of zones) {
          const overlay = overlayImagesRef.current.get(z.id)
          if (!overlay) continue
          const sx = imageSize.w / maskDims.w
          const sy = imageSize.h / maskDims.h
          ctx.drawImage(overlay, 0, 0, overlay.width * sx, overlay.height * sy)
        }
      }

      // Draw contour polylines (in image coords)
      if (contours) {
        for (const z of zones) {
          const contour = contours[z.id]
          if (!contour || contour.length < 3) continue
          ctx.strokeStyle = z.color
          ctx.lineWidth = 2 / t.scale
          ctx.beginPath()
          ctx.moveTo(contour[0].x, contour[0].y)
          for (let i = 1; i < contour.length; i++) {
            ctx.lineTo(contour[i].x, contour[i].y)
          }
          ctx.closePath()
          ctx.stroke()
        }
      }

      // Draw prompts (image coords)
      const pr = 7 / t.scale
      const hr = 11 / t.scale
      const labelSize = Math.max(8, 11 / t.scale)

      for (let i = 0; i < prompts.length; i++) {
        const p = prompts[i]
        const zone = zones.find(z => z.id === p.zoneId)
        if (!zone) continue
        const isHovered = hoveredIdx === i
        const isDragging = draggingIdx.current === i
        const r = isHovered || isDragging ? hr : pr

        ctx.fillStyle = zone.color
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 2 / t.scale

        if (p.label === 1) {
          // Foreground = filled circle
          ctx.beginPath()
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.stroke()
        } else {
          // Background = X mark
          ctx.lineWidth = 3 / t.scale
          ctx.strokeStyle = zone.color
          ctx.beginPath()
          ctx.moveTo(p.x - r, p.y - r)
          ctx.lineTo(p.x + r, p.y + r)
          ctx.moveTo(p.x + r, p.y - r)
          ctx.lineTo(p.x - r, p.y + r)
          ctx.stroke()
          ctx.lineWidth = 1 / t.scale
          ctx.strokeStyle = 'white'
          ctx.stroke()
        }

        // Zone label letter
        const label = zone.label.split(' ').pop()?.charAt(0).toUpperCase() ?? '?'
        ctx.font = `bold ${labelSize}px sans-serif`
        const tw = ctx.measureText(label).width
        const pad = 2 / t.scale
        const bx = p.x + r + 2 / t.scale
        const by = p.y - r
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'
        ctx.fillRect(bx - pad, by - labelSize + pad, tw + pad * 2, labelSize + pad)
        ctx.fillStyle = '#fff'
        ctx.fillText(label, bx, by)
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }

    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [imageReady, prompts, hoveredIdx, transformRef, zones, maskDims, imageSize, contours, mode, bodySilhouette, legLoops, legSeeds, zoneSigmas, sigma, sigmaFor])

  // ---------- Hit test ----------
  const hitTest = useCallback((p: { x: number; y: number }): number | null => {
    const hitRadius = 12 / transformRef.current.scale
    const hitRadiusSq = hitRadius * hitRadius
    for (let i = prompts.length - 1; i >= 0; i--) {
      const dx = p.x - prompts[i].x
      const dy = p.y - prompts[i].y
      if (dx * dx + dy * dy <= hitRadiusSq) return i
    }
    return null
  }, [prompts, transformRef])

  // ---------- Hit test waypoint (canny mode) ----------
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

  // ---------- Canny mode click handlers ----------
  async function handleCannyBodyClick() {
    if (!refImageBlob || !imageRef.current) return
    setComputing(true)
    setComputePhase('segmenting')
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
    setComputePhase('idle')
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

    if (mode === 'canny') {
      const hit = hitTestWaypoint(imgPos)
      if (hit) {
        draggingSeedRef.current = hit
        return
      }
      if (activeZoneId === 'body') {
        handleCannyBodyClick()
      } else if (LEG_IDS.includes(activeZoneId)) {
        addLegSeed(activeZoneId, imgPos)
      }
      return
    }

    const idx = hitTest(imgPos)
    if (idx !== null) {
      draggingIdx.current = idx
    } else {
      const label: 0 | 1 = e.shiftKey ? 0 : 1
      setPrompts(prev => [...prev, { x: imgPos.x, y: imgPos.y, zoneId: activeZoneId, label }])
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const imgPos = screenToImage(e.clientX, e.clientY)
    if (mode === 'canny') {
      const dragSeed = draggingSeedRef.current
      if (dragSeed) {
        setLegSeeds(prev => {
          const seeds = [...(prev[dragSeed.zoneId] ?? [])]
          seeds[dragSeed.index] = { x: Math.round(imgPos.x), y: Math.round(imgPos.y) }
          const next = { ...prev, [dragSeed.zoneId]: seeds }
          scheduleCannyRecompute(next)
          return next
        })
      }
      return
    }

    if (draggingIdx.current !== null) {
      const idx = draggingIdx.current
      setPrompts(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], x: imgPos.x, y: imgPos.y }
        return next
      })
      return
    }
    setHoveredIdx(hitTest(imgPos))
  }

  function handleMouseUp() {
    draggingIdx.current = null
    draggingSeedRef.current = null
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (spaceDown.current || isPanning.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    if (mode === 'canny') {
      if (activeZoneId === 'body') {
        setBodySilhouette(null)
        return
      }
      const hit = hitTestWaypoint(imgPos)
      if (hit) removeLegSeed(hit.zoneId, hit.index)
      return
    }
    const idx = hitTest(imgPos)
    if (idx !== null) {
      setPrompts(prev => prev.filter((_, i) => i !== idx))
      setHoveredIdx(null)
    }
  }

  // ---------- Compute SAM 2 masks ----------
  async function handleComputeMasks() {
    if (!refImageBlob) return
    if (prompts.length === 0) {
      alert('Placez au moins un prompt par zone avant de calculer les masques.')
      return
    }

    setComputing(true)
    setComputePhase('warmup')
    try {
      // Encode the reference image as a 1-frame video for SAM 2
      const fakeVideo = await encodePngAsFakeMp4(refImageBlob)

      const result = await requestSam2Segmentation(
        fakeVideo,
        zones,
        prompts,
        imageSize.w,
        imageSize.h,
        {
          onPhase: setComputePhase,
          videoDimensions: { width: imageSize.w, height: imageSize.h },
        }
      )
      setMasks(result.masks)
      setMaskDims({ w: result.videoWidth, h: result.videoHeight })
      console.log(`[SAM2] Computed 1 frame x ${zones.length} zones (mask ${result.videoWidth}x${result.videoHeight})`)

      // Auto-extract contours after segmentation
      await extractContours(result.masks, { w: result.videoWidth, h: result.videoHeight }, sigma, bridgeThreshold)
    } catch (err) {
      console.error('SAM 2 failed:', err)
      alert('Erreur SAM 2 : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
    setComputePhase('idle')
  }

  // ---------- Build masks + contours from canny mode interactive state ----------
  function finalizeCannyZones(): { masks: Record<string, RLEMask[]>; contours: Record<string, Point2D[]>; dims: { w: number; h: number } } | null {
    if (!imageRef.current) return null
    const w = imageRef.current.naturalWidth, h = imageRef.current.naturalHeight
    if (!bodySilhouette || bodySilhouette.length < 3) {
      alert('Cliquez sur le body pour détecter sa silhouette.')
      return null
    }
    const missing = LEG_IDS.filter(id => !legLoops[id] || legLoops[id].length < 3)
    if (missing.length > 0) {
      const names = missing.map(id => zones.find(z => z.id === id)?.label ?? id).join(', ')
      alert(`Placez au moins 2 clics par patte pour fermer la boucle : ${names}`)
      return null
    }
    const rawByZone: Record<string, Point2D[]> = { body: bodySilhouette }
    for (const id of LEG_IDS) rawByZone[id] = legLoops[id]
    const smoothed: Record<string, Point2D[]> = {}
    const newMasks: Record<string, RLEMask[]> = {}
    for (const z of zones) {
      const r = rawByZone[z.id]
      if (!r || r.length < 3) continue
      const s = smoothPolygonGaussian(r, sigmaFor(z.id))
      smoothed[z.id] = s
      newMasks[z.id] = [rasterizePolygonToMaskRLE(s, w, h)]
    }
    rawZoneContoursRef.current = rawByZone
    return { masks: newMasks, contours: smoothed, dims: { w, h } }
  }

  // ---------- Save ----------
  async function handleSave() {
    let effectiveMasks = masks
    let effectiveDims = maskDims
    let effectiveContours = contours
    if (mode === 'canny') {
      const finalized = finalizeCannyZones()
      if (!finalized) return
      effectiveMasks = finalized.masks
      effectiveDims = finalized.dims
      effectiveContours = finalized.contours
      setMasks(finalized.masks)
      setMaskDims(finalized.dims)
      setContours(finalized.contours)
    }
    if (!effectiveMasks || !effectiveDims) {
      alert('Calculez d\'abord les masques avant de valider.')
      return
    }
    if (!effectiveContours) {
      alert('Les contours n\'ont pas pu etre extraits. Recalculez les masques.')
      return
    }
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
          prompts,
          masksRLE: effectiveMasks,
          maskWidth: effectiveDims.w,
          maskHeight: effectiveDims.h,
          contours: effectiveContours,
          contourSmoothSigma: sigma,
          bridgeThreshold,
          segmentationMode: mode,
          cannyParams: mode === 'canny' ? cannyParams : (pt.cannyParams ?? null),
          step1Validated: true,
          // Invalidate downstream steps if geometry changed
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

  // Group prompts by zone for the summary
  const promptCountByZone: Record<string, number> = {}
  for (const z of zones) promptCountByZone[z.id] = 0
  for (const p of prompts) promptCountByZone[p.zoneId] = (promptCountByZone[p.zoneId] ?? 0) + 1

  return (
    <div className="triangulation-step">
      {/* Toolbar -- zone selector */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', padding: '10px 0' }}>
        <span style={{ fontWeight: 'bold', fontSize: '0.95rem' }}>Zone active :</span>
        {zones.map(z => {
          const isActive = z.id === activeZoneId
          const count = promptCountByZone[z.id]
          return (
            <button
              key={z.id}
              onClick={() => setActiveZoneId(z.id)}
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
              {z.label}{count > 0 ? ` (${count})` : ''}
            </button>
          )
        })}
      </div>

      {/* Toolbar -- mode toggle */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Méthode :</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="radio" name="seg-mode" checked={mode === 'sam2'}
            onChange={() => setMode('sam2')} disabled={computing} />
          SAM 2
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="radio" name="seg-mode" checked={mode === 'canny'}
            onChange={() => setMode('canny')} disabled={computing} />
          Détection contour (Canny)
        </label>
      </div>

      {/* Toolbar -- actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        {mode === 'sam2' ? (
          <button
            className="btn-primary"
            onClick={handleComputeMasks}
            disabled={computing || prompts.length === 0}
          >
            {computing
              ? computePhase === 'warmup' ? 'Demarrage Cloud...'
                : computePhase === 'uploading' ? 'Upload image...'
                : 'Segmentation SAM 2...'
              : 'Calculer masques (SAM 2)'}
          </button>
        ) : (
          <span className="toolbar-info">
            {cannyComputing ? 'Calcul flood-fill...' : computing ? 'Calcul silhouette...' : 'Mode flood-fill : clic Body = silhouette, clic Patte = ajouter une région (clics multiples = union)'}
          </span>
        )}

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || computing || (mode === 'sam2' ? (!masks || !contours) : (!bodySilhouette || LEG_IDS.some(id => !legLoops[id])))}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>

        <button
          className="btn-danger"
          onClick={() => {
            setPrompts([])
            setMasks(null)
            setMaskDims(null)
            setContours(null)
            setBodySilhouette(null)
            setLegWaypoints({})
            setLegLoops({})
            overlayImagesRef.current.clear()
          }}
          disabled={prompts.length === 0 && !masks && !bodySilhouette && Object.keys(legSeeds).length === 0}
        >
          Tout effacer
        </button>

        <span className="toolbar-info">
          {prompts.length} prompt{prompts.length !== 1 ? 's' : ''}
          {masks ? ' | Masques: OK' : ''}
          {contours ? ' | Contours: OK' : ''}
          {extractingContours ? ' | Extraction contours...' : ''}
        </span>
      </div>

      {/* Canny params (mode canny only) */}
      {mode === 'canny' && (
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
            title="Dilatation appliquée à chaque région cliquée. Engulfe le trait noir et, si deux dilatations se touchent, elles fusionnent automatiquement (ex : sabot + patte). Trop haut : englobe le body.">
            Inflate:
            <input type="range" min={0} max={80} step={1}
              value={inflate}
              onChange={e => setInflate(parseInt(e.target.value))}
              style={{ width: 100 }} />
            <span style={{ minWidth: 28, textAlign: 'center' }}>{inflate}</span>
          </label>
        </div>
      )}

      {/* Smoothing controls */}
      {(masks || (mode === 'canny' && (bodySilhouette || Object.keys(legLoops).length > 0))) && (
        <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}>
            Lissage global:
            <input
              type="range"
              min={1}
              max={30}
              step={0.5}
              value={sigma}
              onChange={e => setSigma(parseFloat(e.target.value))}
              style={{ width: 100 }}
            />
            <span style={{ minWidth: 28, textAlign: 'center' }}>{sigma}</span>
          </label>
          {mode === 'canny' && (() => {
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
          {(mode === 'sam2' || mode === 'canny') && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem' }}
              title="Seuil de bridging du contour body au-dessus des pattes (px). Plus haut = saute des portions plus longues.">
              Seuil bridge:
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={bridgeThreshold}
                onChange={e => setBridgeThreshold(parseInt(e.target.value))}
                style={{ width: 100 }}
              />
              <span style={{ minWidth: 28, textAlign: 'center' }}>{bridgeThreshold}</span>
            </label>
          )}
        </div>
      )}

      <div className="triangulation-help">
        {mode === 'canny' ? (
          <span>
            Body actif : clic = détecter la silhouette globale, clic droit = effacer.
            Patte active : clic dans une région colorée (patte, sabot...) = flood-fill bounded par les traits noirs.
            Plusieurs clics = union des régions (ex : patte + sabot). Glisser une graine = déplacer,
            clic droit sur une graine = la supprimer. Espace + glisser = pan | Molette = zoom.
          </span>
        ) : (
          <span>
            Sélectionnez la zone (Body, Patte...) puis cliquez sur l'image pour marquer cette zone |
            Shift+clic = exclure de la zone | Glisser = déplacer | Clic droit = supprimer |
            Espace + glisser = pan | Molette = zoom
          </span>
        )}
      </div>

      {mode === 'sam2' && <LocalServerHelp service="sam2" />}

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          style={{
            cursor: hoveredIdx !== null ? 'grab' : 'crosshair',
          }}
        />
      </div>
    </div>
  )
}

/** Convert "#rrggbb" hex string to [r, g, b]. */
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return [255, 255, 255]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}
