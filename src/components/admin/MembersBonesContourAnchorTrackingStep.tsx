import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import type { ProjectStepView, Point2D, SAM2Zone } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import {
  pointToArcLength,
  arcLengthToPoint,
  computeSam2SubdivisionFramesAllZones,
} from '../../utils/sam2Contour'
import { detectGlobalCurvatureExtrema } from '../../utils/curvatureScaleSpace'
import type { CSSCandidate } from '../../utils/curvatureScaleSpace'
import FrameNavigator from '../keyframes/FrameNavigator'

// Number of CSS curvature extrema detected per frame for anchor snap.
// Matches ContourTrackingStep's N_EXTREMA from the Canny-based pipeline.
const N_EXTREMA = 20

// Tick length (canvas px) for the violet perpendicular tick at each extremum
const EXTREMUM_TICK_HALF_LEN = 12
const DRAG_SNAP_RADIUS_VIDEO = 50  // max drag snap distance in video coords

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

const VIDEO_FPS = 24

type Phase = 'preview' | 'validated'

/**
 * Étape 8 du pipeline members-bones : preview interactive + validation du tracking
 * des anchors sur contours SAM 2 lissés.
 *
 * Phases :
 *  - preview : scrub frames, drag anchors avec snap extrema, toggles zones, "Preview
 *              contour complet" (affiche subdivisions via {segmentIndex, t}).
 *  - validated : anchors + subdivisions sauvegardés, boutons Rééditer/Réinitialiser.
 *
 * Pas de calcul d'optical flow — tout est déterministe :
 *   1. Initial compute : anchors samplés à s_i fixe sur chaque frame, snappés aux extrema
 *   2. Drag manuel : modifie uniquement la frame courante (frame-local edit)
 *   3. "Propager avant" : recalcule depuis la frame éditée, avec les nouveaux s_i
 *   4. "Preview contour complet" : calcule les subdivisions relatives (segmentIndex, t)
 *      et affiche le polygone fermé par zone
 */
export default function MembersBonesContourAnchorTrackingStep({ project, onSave }: Props) {
  const mesh = project.mesh
  const zones: SAM2Zone[] = useMemo(() => mesh?.sam2Zones ?? [], [mesh?.sam2Zones])
  const contoursAll = mesh?.sam2Contours ?? null
  const anchorsAll = useMemo(() => mesh?.sam2ContourAnchors ?? {}, [mesh?.sam2ContourAnchors])
  const subdivisionParams = useMemo(
    () => mesh?.sam2ContourSubdivisionParams ?? {},
    [mesh?.sam2ContourSubdivisionParams]
  )
  const sam2W = mesh?.sam2VideoWidth ?? 0
  const sam2H = mesh?.sam2VideoHeight ?? 0

  const totalFrames = useMemo(() => {
    if (!contoursAll) return 0
    const first = Object.values(contoursAll)[0]
    return first?.length ?? 0
  }, [contoursAll])

  // ----- Phase + toggles -----
  const initialPhase: Phase = mesh?.sam2ContourAnchorTrackingValidated ? 'validated' : 'preview'
  const [phase, setPhase] = useState<Phase>(initialPhase)
  const [showFullContour, setShowFullContour] = useState(false)
  const [snapExtrema, setSnapExtrema] = useState(true)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [computing, setComputing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [hasEdited, setHasEdited] = useState(false)

  // Bumping renderTick forces the draw loop to pick up mutations to refs (drag, propagate).
  const [renderTick, setRenderTick] = useState(0)
  const forceRender = useCallback(() => setRenderTick(t => t + 1), [])

  // Zone visibility map (all visible by default)
  const [visibleZones, setVisibleZones] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {}
    for (const z of zones) init[z.id] = true
    return init
  })

  // Re-initialize visibleZones when zones list changes (e.g. mesh reload)
  useEffect(() => {
    setVisibleZones(prev => {
      const next: Record<string, boolean> = {}
      for (const z of zones) next[z.id] = prev[z.id] ?? true
      return next
    })
  }, [zones])

  // Drag state
  const [draggingIdx, setDraggingIdx] = useState<{ zoneId: string; anchorIdx: number } | null>(null)

  // ----- Refs (mutable without re-render) -----
  // Per-frame anchor positions in VIDEO coords, mutable by drag/propagate
  const anchorFramesRef = useRef<Record<string, Point2D[][]> | null>(null)
  // Per-frame subdivision positions in VIDEO coords, computed on demand
  const subdivFramesRef = useRef<Record<string, Point2D[][]> | null>(null)
  // Cached curvature extrema keyed by `${zoneId}:${frameIdx}` (lazy fill)
  const extremaCacheRef = useRef<Map<string, CSSCandidate[]>>(new Map())
  // Set of anchor indices edited manually per zone (used to highlight visually)
  const editedIndicesRef = useRef<Record<string, Set<number>>>({})

  // ----- Video element + canvas -----
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fittedRef = useRef(false)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)

  useEffect(() => {
    if (!project.videoBlob) return
    const url = URL.createObjectURL(project.videoBlob)
    const video = document.createElement('video')
    video.src = url
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.onloadeddata = () => {
      video.currentTime = 0
      video.onseeked = () => {
        videoRef.current = video
        setVideoSize({ w: video.videoWidth, h: video.videoHeight })
        setVideoReady(true)
      }
    }
    video.load()
    return () => {
      video.pause()
      URL.revokeObjectURL(url)
      videoRef.current = null
      fittedRef.current = false
    }
  }, [project.videoBlob])

  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

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

  useEffect(() => {
    if (!videoReady) return
    const video = videoRef.current
    if (!video) return
    video.currentTime = currentFrame / VIDEO_FPS
  }, [currentFrame, videoReady])

  // Reset extrema cache when contours change (step navigation or recompute)
  useEffect(() => {
    extremaCacheRef.current = new Map()
  }, [contoursAll])

  // ----- Extrema cache accessor -----
  const getExtremaForFrame = useCallback(
    (zoneId: string, frameIdx: number): CSSCandidate[] => {
      const key = `${zoneId}:${frameIdx}`
      const cached = extremaCacheRef.current.get(key)
      if (cached) return cached
      const poly = contoursAll?.[zoneId]?.[frameIdx]
      if (!poly || poly.length < 10) {
        extremaCacheRef.current.set(key, [])
        return []
      }
      const extrema = detectGlobalCurvatureExtrema(poly, N_EXTREMA)
      extremaCacheRef.current.set(key, extrema)
      return extrema
    },
    [contoursAll]
  )

  // ----- Compute initial anchor frames -----
  // Samples each anchor at its fixed s_i on every frame and snaps to the nearest
  // curvature extremum in arc-length (circular distance).
  const runCompute = useCallback((): Record<string, Point2D[][]> | null => {
    if (!contoursAll) return null
    if (videoSize.w === 0 || videoSize.h === 0) return null
    if (sam2W === 0 || sam2H === 0) return null

    const sx = videoSize.w / sam2W
    const sy = videoSize.h / sam2H
    const newAnchorFrames: Record<string, Point2D[][]> = {}

    for (const z of zones) {
      const polys = contoursAll[z.id]
      if (!polys || polys.length === 0) continue
      const anchorsVideo = anchorsAll[z.id] ?? []
      if (anchorsVideo.length < 2) {
        console.warn(`[anchor-tracking] zone ${z.id}: only ${anchorsVideo.length} anchors, skipped`)
        continue
      }

      const anchorsMask = anchorsVideo.map(p => ({ x: p.x / sx, y: p.y / sy }))
      const frame0 = polys[0]
      if (!frame0 || frame0.length < 2) continue
      const anchorS = anchorsMask.map(p => pointToArcLength(p, frame0))

      const aFrames: Point2D[][] = polys.map((poly, fIdx) => {
        if (!poly || poly.length < 2) return anchorsVideo
        const frameExtrema = getExtremaForFrame(z.id, fIdx)
        return anchorS.map(s => {
          let snappedMask: Point2D
          if (frameExtrema.length > 0) {
            let bestExt = frameExtrema[0]
            let bestArcDist = Infinity
            for (const ext of frameExtrema) {
              let d = Math.abs(ext.arcLengthNorm - s)
              if (d > 0.5) d = 1 - d
              if (d < bestArcDist) {
                bestArcDist = d
                bestExt = ext
              }
            }
            snappedMask = bestExt.position
          } else {
            snappedMask = arcLengthToPoint(s, poly)
          }
          return { x: snappedMask.x * sx, y: snappedMask.y * sy }
        })
      })
      newAnchorFrames[z.id] = aFrames
    }
    return newAnchorFrames
  }, [contoursAll, videoSize, sam2W, sam2H, zones, anchorsAll, getExtremaForFrame])

  // Initialize anchorFramesRef on mount (or load from mesh if already computed)
  useEffect(() => {
    if (!videoReady) return
    if (anchorFramesRef.current) return  // already initialized
    // Prefer stored data if present
    if (mesh?.sam2ContourAnchorFrames) {
      anchorFramesRef.current = mesh.sam2ContourAnchorFrames
      subdivFramesRef.current = mesh.sam2ContourSubdivisionFrames ?? null
      forceRender()
      return
    }
    // Otherwise auto-compute
    const computed = runCompute()
    if (computed) {
      anchorFramesRef.current = computed
      forceRender()
    }
  }, [videoReady, mesh?.sam2ContourAnchorFrames, mesh?.sam2ContourSubdivisionFrames, runCompute, forceRender])

  async function handleRecompute() {
    setComputing(true)
    try {
      const result = runCompute()
      if (result) {
        anchorFramesRef.current = result
        subdivFramesRef.current = null
        editedIndicesRef.current = {}
        setHasEdited(false)
        setShowFullContour(false)
        forceRender()
      }
    } finally {
      setComputing(false)
    }
  }

  // ----- Zone toggle with Alt+click solo -----
  function handleZoneToggle(zoneId: string, e: React.MouseEvent) {
    if (e.altKey) {
      // Solo mode: check if already solo
      const visibleIds = Object.keys(visibleZones).filter(id => visibleZones[id])
      const isAlreadySolo = visibleIds.length === 1 && visibleIds[0] === zoneId
      setVisibleZones(() => {
        const next: Record<string, boolean> = {}
        if (isAlreadySolo) {
          // Reset to all visible
          for (const z of zones) next[z.id] = true
        } else {
          // Only this zone visible
          for (const z of zones) next[z.id] = z.id === zoneId
        }
        return next
      })
    } else {
      setVisibleZones(prev => ({ ...prev, [zoneId]: !prev[zoneId] }))
    }
  }

  // ----- Draw loop -----
  useEffect(() => {
    let running = true
    let rafId = 0
    function draw() {
      if (!running) return
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video || !videoReady) {
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

      // Video frame
      ctx.drawImage(video, 0, 0)

      const safeFrame = Math.min(currentFrame, totalFrames - 1)
      if (contoursAll && sam2W > 0 && sam2H > 0) {
        const sx = videoSize.w / sam2W
        const sy = videoSize.h / sam2H

        for (const z of zones) {
          if (!visibleZones[z.id]) continue
          const polys = contoursAll[z.id]
          if (!polys || polys.length === 0) continue
          const poly = polys[safeFrame]
          if (!poly || poly.length < 2) continue

          // Faded zone contour (background reference)
          ctx.strokeStyle = z.color
          ctx.globalAlpha = 0.3
          ctx.lineWidth = 1 / t.scale
          ctx.beginPath()
          for (let i = 0; i < poly.length; i++) {
            const v = { x: poly[i].x * sx, y: poly[i].y * sy }
            if (i === 0) ctx.moveTo(v.x, v.y)
            else ctx.lineTo(v.x, v.y)
          }
          ctx.closePath()
          ctx.stroke()
          ctx.globalAlpha = 1

          // Violet perpendicular ticks at curvature extrema (if snapExtrema toggle ON)
          if (snapExtrema) {
            const extrema = getExtremaForFrame(z.id, safeFrame)
            ctx.strokeStyle = 'rgba(168, 85, 247, 0.9)'  // violet
            ctx.lineWidth = 2 / t.scale
            const halfLen = EXTREMUM_TICK_HALF_LEN / t.scale
            const n = poly.length
            for (let ei = 0; ei < extrema.length; ei++) {
              const ext = extrema[ei]
              const ep = ext.position  // mask coords
              // Find nearest contour pixel index to compute local tangent
              let bestIdx = 0
              let bestDist = Infinity
              for (let i = 0; i < n; i++) {
                const d = Math.hypot(poly[i].x - ep.x, poly[i].y - ep.y)
                if (d < bestDist) {
                  bestDist = d
                  bestIdx = i
                }
              }
              const prev = poly[(bestIdx - 3 + n) % n]
              const next = poly[(bestIdx + 3) % n]
              // Tangent in video coords (apply scale per axis)
              const tx = (next.x - prev.x) * sx
              const ty = (next.y - prev.y) * sy
              const tLen = Math.hypot(tx, ty)
              if (tLen < 0.01) continue
              const nx = -ty / tLen
              const ny = tx / tLen
              const ex = ep.x * sx
              const ey = ep.y * sy
              ctx.beginPath()
              ctx.moveTo(ex - nx * halfLen, ey - ny * halfLen)
              ctx.lineTo(ex + nx * halfLen, ey + ny * halfLen)
              ctx.stroke()
            }
          }

          // Anchors for this zone (video coords)
          const aFrames = anchorFramesRef.current?.[z.id]
          const anchorsF = aFrames?.[safeFrame] ?? null
          const sFrames = subdivFramesRef.current?.[z.id]
          const subsF = sFrames?.[safeFrame] ?? null

          // If showFullContour, draw the closed polygon linking anchors + subdivisions in order
          if (showFullContour && anchorsF && subsF && subdivisionParams[z.id]) {
            const params = subdivisionParams[z.id]
            const numSegments = anchorsF.length
            const fullList: Point2D[] = []
            for (let i = 0; i < numSegments; i++) {
              fullList.push(anchorsF[i])
              // Subdivision points with segmentIndex === i, sorted by t
              const segPts: { p: Point2D; t: number }[] = []
              for (let k = 0; k < params.length; k++) {
                if (params[k].segmentIndex === i) {
                  segPts.push({ p: subsF[k], t: params[k].t })
                }
              }
              segPts.sort((a, b) => a.t - b.t)
              for (const sp of segPts) fullList.push(sp.p)
            }
            ctx.strokeStyle = z.color
            ctx.lineWidth = 2 / t.scale
            ctx.beginPath()
            for (let i = 0; i < fullList.length; i++) {
              const p = fullList[i]
              if (i === 0) ctx.moveTo(p.x, p.y)
              else ctx.lineTo(p.x, p.y)
            }
            ctx.closePath()
            ctx.stroke()
          }

          // Draw anchors (red dots, editable when !showFullContour)
          if (anchorsF) {
            const editedSet = editedIndicesRef.current[z.id] ?? new Set<number>()
            const r = 5 / t.scale
            for (let i = 0; i < anchorsF.length; i++) {
              const p = anchorsF[i]
              const isEdited = editedSet.has(i)
              const isDragging =
                draggingIdx?.zoneId === z.id && draggingIdx?.anchorIdx === i
              ctx.fillStyle = isDragging ? '#22c55e' : isEdited ? '#fbbf24' : '#ef4444'
              ctx.strokeStyle = '#fff'
              ctx.lineWidth = 1.5 / t.scale
              ctx.beginPath()
              ctx.arc(p.x, p.y, isDragging ? r * 1.4 : r, 0, Math.PI * 2)
              ctx.fill()
              ctx.stroke()
            }
          }

          // Draw subdivision points (green, smaller) when showFullContour is ON
          if (showFullContour && subsF) {
            ctx.fillStyle = '#22c55e'
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 1 / t.scale
            for (const p of subsF) {
              const r = 3 / t.scale
              ctx.beginPath()
              ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
              ctx.fill()
              ctx.stroke()
            }
          }
        }
      }

      ctx.restore()
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => { running = false; cancelAnimationFrame(rafId) }
  }, [
    videoReady, contoursAll, zones, currentFrame, transformRef, sam2W, sam2H, videoSize,
    totalFrames, visibleZones, snapExtrema, showFullContour, subdivisionParams,
    getExtremaForFrame, draggingIdx, renderTick,
  ])

  // ----- Reset frame to 0 when contours change (React compare-during-render pattern) -----
  const [prevContoursKey, setPrevContoursKey] = useState(contoursAll)
  if (prevContoursKey !== contoursAll) {
    setPrevContoursKey(contoursAll)
    setCurrentFrame(0)
  }

  // ----- Mouse handlers (drag anchors) -----
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (spaceDown.current || isPanning.current) return
    if (showFullContour || phase !== 'preview') return
    if (!anchorFramesRef.current) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    // Hit-test on visible zones only
    let best: { zoneId: string; anchorIdx: number } | null = null
    let bestDist = 12 / transformRef.current.scale
    for (const z of zones) {
      if (!visibleZones[z.id]) continue
      const anchors = anchorFramesRef.current[z.id]?.[currentFrame]
      if (!anchors) continue
      for (let i = 0; i < anchors.length; i++) {
        const dx = anchors[i].x - imgPos.x
        const dy = anchors[i].y - imgPos.y
        const d = Math.hypot(dx, dy)
        if (d < bestDist) {
          bestDist = d
          best = { zoneId: z.id, anchorIdx: i }
        }
      }
    }
    if (best) setDraggingIdx(best)
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!draggingIdx) return
    if (!anchorFramesRef.current) return
    if (sam2W === 0 || videoSize.w === 0) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const sx = videoSize.w / sam2W
    const sy = videoSize.h / sam2H
    let newPos = imgPos

    if (snapExtrema) {
      // Snap to nearest curvature extremum in 2D (rayon 50 px video coords)
      const extrema = getExtremaForFrame(draggingIdx.zoneId, currentFrame)
      let bestDist = DRAG_SNAP_RADIUS_VIDEO
      let bestExt: Point2D | null = null
      for (const ext of extrema) {
        const ex = ext.position.x * sx
        const ey = ext.position.y * sy
        const d = Math.hypot(imgPos.x - ex, imgPos.y - ey)
        if (d < bestDist) {
          bestDist = d
          bestExt = { x: ex, y: ey }
        }
      }
      if (bestExt) newPos = bestExt
    } else {
      // Snap to nearest contour pixel (video coords)
      const poly = contoursAll?.[draggingIdx.zoneId]?.[currentFrame]
      if (poly) {
        let bestDist = DRAG_SNAP_RADIUS_VIDEO
        let bestPt: Point2D | null = null
        for (let i = 0; i < poly.length; i++) {
          const px = poly[i].x * sx
          const py = poly[i].y * sy
          const d = Math.hypot(imgPos.x - px, imgPos.y - py)
          if (d < bestDist) {
            bestDist = d
            bestPt = { x: px, y: py }
          }
        }
        if (bestPt) newPos = bestPt
      }
    }

    // Mutate the position for this frame ONLY
    anchorFramesRef.current[draggingIdx.zoneId][currentFrame][draggingIdx.anchorIdx] = newPos
    if (!editedIndicesRef.current[draggingIdx.zoneId]) {
      editedIndicesRef.current[draggingIdx.zoneId] = new Set()
    }
    editedIndicesRef.current[draggingIdx.zoneId].add(draggingIdx.anchorIdx)
    setHasEdited(true)
    subdivFramesRef.current = null  // invalidate cache
    forceRender()
  }

  function handleMouseUp() {
    setDraggingIdx(null)
  }

  // ----- Propagate forward from current frame -----
  // Recomputes s_i from the (possibly edited) anchors at currentFrame, then re-samples
  // frames currentFrame+1..totalFrames-1 with snap to extrema.
  const handlePropagateForward = useCallback(() => {
    if (!anchorFramesRef.current || !contoursAll) return
    if (sam2W === 0 || videoSize.w === 0) return
    const sx = videoSize.w / sam2W
    const sy = videoSize.h / sam2H
    const startFrame = currentFrame

    for (const z of zones) {
      const polys = contoursAll[z.id]
      const aFrames = anchorFramesRef.current[z.id]
      if (!polys || !aFrames) continue

      const anchorsAtStartVideo = aFrames[startFrame]
      if (!anchorsAtStartVideo) continue
      const polyStart = polys[startFrame]
      if (!polyStart || polyStart.length < 2) continue

      // Compute s_i from edited positions at startFrame
      const anchorsMask = anchorsAtStartVideo.map(p => ({ x: p.x / sx, y: p.y / sy }))
      const anchorS = anchorsMask.map(p => pointToArcLength(p, polyStart))

      // Re-sample all frames > startFrame
      for (let f = startFrame + 1; f < polys.length; f++) {
        const poly = polys[f]
        if (!poly || poly.length < 2) continue
        const extrema = getExtremaForFrame(z.id, f)
        const newPositions = anchorS.map(s => {
          let snappedMask: Point2D
          if (extrema.length > 0) {
            let bestExt = extrema[0]
            let bestArcDist = Infinity
            for (const ext of extrema) {
              let d = Math.abs(ext.arcLengthNorm - s)
              if (d > 0.5) d = 1 - d
              if (d < bestArcDist) {
                bestArcDist = d
                bestExt = ext
              }
            }
            snappedMask = bestExt.position
          } else {
            snappedMask = arcLengthToPoint(s, poly)
          }
          return { x: snappedMask.x * sx, y: snappedMask.y * sy }
        })
        aFrames[f] = newPositions
      }
    }
    subdivFramesRef.current = null
    setHasEdited(true)
    forceRender()
    console.log(`[anchor-tracking] propagated from frame ${startFrame}`)
  }, [contoursAll, zones, currentFrame, sam2W, sam2H, videoSize, getExtremaForFrame, forceRender])

  // ----- Toggle "Preview contour complet" -----
  const handleToggleFullContour = useCallback(() => {
    if (showFullContour) {
      setShowFullContour(false)
      return
    }
    if (!anchorFramesRef.current || !contoursAll || !subdivisionParams) return
    if (!subdivFramesRef.current || hasEdited) {
      const result = computeSam2SubdivisionFramesAllZones(
        contoursAll,
        anchorFramesRef.current,
        subdivisionParams,
        sam2W,
        sam2H,
        videoSize.w,
        videoSize.h,
      )
      subdivFramesRef.current = result
      setHasEdited(false)
    }
    setShowFullContour(true)
    forceRender()
  }, [showFullContour, contoursAll, subdivisionParams, sam2W, sam2H, videoSize, hasEdited, forceRender])

  // ----- Save & validate -----
  async function handleSave() {
    if (!mesh || !anchorFramesRef.current) return
    setSaving(true)
    try {
      // Ensure subdivFrames computed (fresh if edited)
      if (!subdivFramesRef.current || hasEdited) {
        if (!contoursAll) throw new Error('contoursAll missing')
        subdivFramesRef.current = computeSam2SubdivisionFramesAllZones(
          contoursAll,
          anchorFramesRef.current,
          subdivisionParams,
          sam2W,
          sam2H,
          videoSize.w,
          videoSize.h,
        )
      }
      const updated = {
        ...mesh,
        sam2ContourAnchorFrames: anchorFramesRef.current,
        sam2ContourSubdivisionFrames: subdivFramesRef.current,
        sam2ContourAnchorTrackingValidated: true,
        // Invalidate downstream step 9 (bones) when tracking is recomputed
        sam2BonesValidated: false,
      }
      await onSave(
        { ...project, mesh: updated },
        ['sam2ContourAnchorFrames', 'sam2ContourSubdivisionFrames']
      )
      setPhase('validated')
    } catch (err) {
      console.error('[anchor-tracking] save failed:', err)
      alert('Erreur sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  function handleReEdit() {
    setPhase('preview')
  }

  function handleResetFromScratch() {
    if (!confirm('Réinitialiser le tracking depuis zéro ? Toutes les éditions manuelles seront perdues.')) return
    anchorFramesRef.current = null
    subdivFramesRef.current = null
    editedIndicesRef.current = {}
    setHasEdited(false)
    setShowFullContour(false)
    setPhase('preview')
    // Re-run compute
    setTimeout(() => {
      const result = runCompute()
      if (result) {
        anchorFramesRef.current = result
        forceRender()
      }
    }, 0)
  }

  // ----- Prerequisites -----
  if (!project.videoBlob) return <div className="placeholder">Importez d'abord une vidéo (étape 1).</div>
  if (!mesh?.sam2ContourSubdivisionValidated) {
    return <div className="placeholder">Validez d'abord la subdivision (étape précédente).</div>
  }

  const editedCount = Object.values(editedIndicesRef.current).reduce((sum, set) => sum + set.size, 0)
  const visibleZoneCount = Object.values(visibleZones).filter(Boolean).length

  // ----- Validated phase UI -----
  if (phase === 'validated') {
    return (
      <div className="triangulation-step">
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ color: 'var(--color-success)', fontWeight: 'bold', fontSize: '1.1rem' }}>
            ✓ Tracking anchors + subdivision validé
          </div>
          <div style={{ color: 'var(--color-muted)', fontSize: '0.9rem' }}>
            {zones.length} zones × {totalFrames} frames sauvegardées en Storage.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={handleReEdit}>
              Rééditer
            </button>
            <button className="btn-danger" onClick={handleResetFromScratch}>
              Réinitialiser depuis zéro
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ----- Preview phase UI -----
  return (
    <div className="triangulation-step">
      {/* Toolbar line 1 : main actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Tracking anchors (preview)</span>
        <button
          className="btn-secondary"
          onClick={handleRecompute}
          disabled={computing}
          title="Recalculer le tracking depuis zéro (écrase les éditions manuelles)"
        >
          {computing ? 'Calcul...' : 'Recalculer tracking'}
        </button>
        <button
          className="btn-secondary"
          onClick={handlePropagateForward}
          disabled={computing || showFullContour || currentFrame >= totalFrames - 1}
          title="Re-propage le tracking depuis la frame courante en utilisant les positions actuelles comme nouvelles références"
        >
          Propager avant (depuis frame {currentFrame + 1})
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={snapExtrema}
            onChange={e => setSnapExtrema(e.target.checked)}
          />
          Snap extrema (traits violets)
        </label>
        <button
          className="btn-secondary"
          onClick={handleToggleFullContour}
          disabled={!anchorFramesRef.current}
        >
          {showFullContour ? 'Preview anchors seuls' : 'Preview contour complet'}
        </button>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || computing || !anchorFramesRef.current}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>
      </div>

      {/* Toolbar line 2 : zone toggles */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 6 }}>
        <span style={{ fontWeight: 'bold', fontSize: '0.85rem', marginRight: 4 }}>
          Zones visibles :
        </span>
        {zones.map(z => {
          const isVisible = visibleZones[z.id] ?? true
          return (
            <button
              key={z.id}
              onClick={e => handleZoneToggle(z.id, e)}
              title={`${isVisible ? 'Masquer' : 'Afficher'} ${z.label} — Alt+clic = solo`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                background: isVisible ? z.color : 'transparent',
                color: isVisible ? '#fff' : z.color,
                border: `2px solid ${z.color}`,
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: '0.8rem',
                fontWeight: isVisible ? 'bold' : 'normal',
                cursor: 'pointer',
                opacity: isVisible ? 1 : 0.6,
              }}
            >
              <span style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: z.color,
                border: isVisible ? '1px solid #fff' : 'none',
              }} />
              {z.label}
            </button>
          )
        })}
      </div>

      <div className="triangulation-help">
        <span>
          Scrubber le slider pour vérifier frame par frame. Drag un anchor pour le corriger (snap auto sur extremum violet).
          Clic sur une zone pour l'afficher/masquer. <kbd>Alt</kbd>+clic = solo (isoler une seule zone).
          {editedCount > 0 ? ` | ✏ ${editedCount} anchors édités` : ''}
          {visibleZoneCount < zones.length ? ` | ${visibleZoneCount}/${zones.length} zones visibles` : ''}
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            cursor: showFullContour ? 'default' : (draggingIdx ? 'grabbing' : 'crosshair'),
          }}
        />
      </div>

      {totalFrames > 0 && (
        <>
          <div style={{
            padding: '6px 16px',
            fontSize: '0.8rem',
            color: 'var(--color-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}>
            <span style={{ fontWeight: 'bold', color: 'var(--color-text)' }}>
              {showFullContour ? 'Preview contour complet' : 'Preview tracking anchors'}
            </span>
            <span>Frame {currentFrame + 1} / {totalFrames}</span>
          </div>
          <FrameNavigator
            currentFrame={currentFrame}
            totalFrames={totalFrames}
            editedFrames={EMPTY_SET}
            onNavigate={setCurrentFrame}
          />
        </>
      )}
    </div>
  )
}

const EMPTY_SET: Set<number> = new Set()
