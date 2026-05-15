import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { ProjectStepView, SAM2Prompt, SAM2Zone, RLEMask } from '../../types/project'
import type { StepUploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { requestSam2Segmentation } from '../../utils/sam2Segmentation'
import type { SAM2Phase } from '../../utils/sam2Segmentation'
import { maskToImageData } from '../../utils/rleMask'
import FrameNavigator from '../keyframes/FrameNavigator'
import LocalServerHelp from './LocalServerHelp'

const VIDEO_FPS = 24

interface Props {
  project: ProjectStepView
  onSave: (project: ProjectStepView, uploadOnly?: StepUploadHint[]) => Promise<void>
}

/** Default 5 zones (body + 4 legs) — created once for a fresh members-bones animation. */
const DEFAULT_ZONES: SAM2Zone[] = [
  { id: 'body',   label: 'Body',     color: '#22c55e' }, // green
  { id: 'leg-fl', label: 'Patte AVG', color: '#f59e0b' }, // amber
  { id: 'leg-fr', label: 'Patte AVD', color: '#ef4444' }, // red
  { id: 'leg-bl', label: 'Patte ARG', color: '#3b82f6' }, // blue
  { id: 'leg-br', label: 'Patte ARD', color: '#a855f7' }, // purple
]

const OVERLAY_ALPHA = 90  // 0-255 alpha for the mask overlay (frame 0 preview)

export default function MembersBonesZonesStep({ project, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [computing, setComputing] = useState(false)
  const [computePhase, setComputePhase] = useState<SAM2Phase | 'idle'>('idle')

  // Zones (hardcoded 5; restored from mesh if present)
  const [zones] = useState<SAM2Zone[]>(() => project.mesh?.sam2Zones ?? DEFAULT_ZONES)

  // Active zone for new clicks
  const [activeZoneId, setActiveZoneId] = useState<string>(() => project.mesh?.sam2Zones?.[0]?.id ?? DEFAULT_ZONES[0].id)
  const [activeLabel, setActiveLabel] = useState<0 | 1>(1) // 1 = foreground by default

  // Prompts (clicks)
  const [prompts, setPrompts] = useState<SAM2Prompt[]>(() => project.mesh?.sam2Prompts ?? [])
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  // Computed masks (loaded from mesh or computed by SAM 2 call)
  const [masks, setMasks] = useState<Record<string, RLEMask[]> | null>(() => project.mesh?.sam2MasksRLE ?? null)
  const [sam2VideoDims, setSam2VideoDims] = useState<{ w: number; h: number } | null>(() => {
    const m = project.mesh
    if (m?.sam2VideoWidth && m?.sam2VideoHeight) return { w: m.sam2VideoWidth, h: m.sam2VideoHeight }
    return null
  })

  // Frame 0 video state
  const [videoReady, setVideoReady] = useState(false)
  const [videoSize, setVideoSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })

  // Mask preview navigation : after SAM 2 ran, the user can scrub through frames to
  // verify segmentation quality. currentMaskFrame seeks the video AND rebuilds the
  // overlay canvases for that frame's masks.
  const [currentMaskFrame, setCurrentMaskFrame] = useState(0)
  const totalMaskFrames = useMemo(() => {
    if (!masks) return 0
    const firstZone = Object.values(masks)[0]
    return firstZone?.length ?? 0
  }, [masks])

  // Cached mask overlay images for the currently displayed frame
  const overlayImagesRef = useRef<Map<string, HTMLCanvasElement>>(new Map())

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const draggingIdx = useRef<number | null>(null)
  const fittedRef = useRef(false)

  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)

  // ---------- Load video frame 0 ----------
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

  // ---------- Fit canvas after video ready ----------
  useEffect(() => {
    if (!videoReady || fittedRef.current) return
    fitToCanvas(videoSize.w, videoSize.h)
    fittedRef.current = true
  }, [videoReady, videoSize, fitToCanvas])

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

  // ---------- Reset current frame to 0 whenever a new set of masks lands ----------
  useEffect(() => {
    setCurrentMaskFrame(0)
  }, [masks])

  // ---------- Build mask overlay canvases for the current frame ----------
  // Rebuilt every time the frame changes (or masks change). Costs ~50-100 ms for
  // 5 zones at 720x480 — fast enough for interactive scrubbing.
  useEffect(() => {
    overlayImagesRef.current.clear()
    if (!masks) return
    const safeFrame = Math.max(0, Math.min(totalMaskFrames - 1, currentMaskFrame))
    for (const z of zones) {
      const zoneMasks = masks[z.id]
      if (!zoneMasks || zoneMasks.length === 0) continue
      const rle = zoneMasks[safeFrame] ?? zoneMasks[0]
      const [r, g, b] = hexToRgb(z.color)
      const imageData = maskToImageData(rle, [r, g, b, OVERLAY_ALPHA])
      const off = document.createElement('canvas')
      off.width = imageData.width
      off.height = imageData.height
      off.getContext('2d')!.putImageData(imageData, 0, 0)
      overlayImagesRef.current.set(z.id, off)
    }
  }, [masks, zones, currentMaskFrame, totalMaskFrames])

  // ---------- Seek the underlying video element on frame change ----------
  // The draw loop calls ctx.drawImage(video, ...) every frame, so once the seek
  // completes the new frame is picked up automatically.
  useEffect(() => {
    if (!videoReady) return
    const video = videoRef.current
    if (!video) return
    video.currentTime = currentMaskFrame / VIDEO_FPS
  }, [currentMaskFrame, videoReady])

  // ---------- Draw loop ----------
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

      // Draw video frame 0 (image-coord = video-coord here)
      ctx.drawImage(video, 0, 0)

      // Draw mask overlays (image is at native video size, masks are in video coords)
      if (sam2VideoDims) {
        for (const z of zones) {
          const overlay = overlayImagesRef.current.get(z.id)
          if (!overlay) continue
          // Overlay is in sam2VideoDims; we draw scaled to current video size
          const sx = videoSize.w / sam2VideoDims.w
          const sy = videoSize.h / sam2VideoDims.h
          ctx.drawImage(overlay, 0, 0, overlay.width * sx, overlay.height * sy)
        }
      }

      // Prompts are only valid on frame 0 (they define the SAM 2 input).
      // Skip drawing them on other frames so the user doesn't get confused.
      const showPrompts = currentMaskFrame === 0

      // Draw prompts
      const pr = 7 / t.scale
      const hr = 11 / t.scale
      const labelSize = Math.max(8, 11 / t.scale)

      for (let i = 0; showPrompts && i < prompts.length; i++) {
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
          // White outline for contrast
          ctx.lineWidth = 1 / t.scale
          ctx.strokeStyle = 'white'
          ctx.stroke()
        }

        // Zone label letter (B/AVG/AVD/ARG/ARD)
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
  }, [videoReady, prompts, hoveredIdx, transformRef, zones, sam2VideoDims, videoSize, currentMaskFrame])

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

  // Prompts can only be edited on frame 0 — they define the SAM 2 input.
  // When scrubbing the timeline (currentMaskFrame > 0), the canvas becomes
  // a read-only preview of the propagated masks.
  const isPromptsEditable = currentMaskFrame === 0

  // ---------- Mouse handlers ----------
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (spaceDown.current || isPanning.current) return
    if (!isPromptsEditable) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const idx = hitTest(imgPos)
    if (idx !== null) {
      draggingIdx.current = idx
    } else {
      // Add new prompt at active zone with active label (shift = background override)
      const label: 0 | 1 = e.shiftKey ? (activeLabel === 1 ? 0 : 1) : activeLabel
      setPrompts(prev => [...prev, { x: imgPos.x, y: imgPos.y, zoneId: activeZoneId, label }])
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const imgPos = screenToImage(e.clientX, e.clientY)
    if (draggingIdx.current !== null) {
      if (!isPromptsEditable) {
        draggingIdx.current = null
        return
      }
      const idx = draggingIdx.current
      setPrompts(prev => {
        const next = [...prev]
        next[idx] = { ...next[idx], x: imgPos.x, y: imgPos.y }
        return next
      })
      return
    }
    setHoveredIdx(isPromptsEditable ? hitTest(imgPos) : null)
  }

  function handleMouseUp() {
    draggingIdx.current = null
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (spaceDown.current || isPanning.current) return
    if (!isPromptsEditable) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const idx = hitTest(imgPos)
    if (idx !== null) {
      setPrompts(prev => prev.filter((_, i) => i !== idx))
      setHoveredIdx(null)
    }
  }

  // ---------- Compute SAM 2 masks ----------
  async function handleComputeMasks() {
    if (!project.videoBlob) return
    if (prompts.length === 0) {
      alert('Placez au moins un prompt par zone avant de calculer les masques.')
      return
    }
    // Image coords here = video coords for members-bones (autonomous)
    const imageWidth = videoSize.w
    const imageHeight = videoSize.h

    setComputing(true)
    setComputePhase('warmup')
    try {
      const result = await requestSam2Segmentation(
        project.videoBlob,
        zones,
        prompts,
        imageWidth,
        imageHeight,
        { onPhase: setComputePhase }
      )
      setMasks(result.masks)
      setSam2VideoDims({ w: result.videoWidth, h: result.videoHeight })
      console.log(`[SAM2] Computed ${result.numFrames} frames × ${zones.length} zones`)
    } catch (err) {
      console.error('SAM 2 failed:', err)
      alert('Erreur SAM 2 : ' + (err instanceof Error ? err.message : err))
    }
    setComputing(false)
    setComputePhase('idle')
  }

  // ---------- Save ----------
  async function handleSave() {
    if (!project.mesh) return
    if (!masks || !sam2VideoDims) {
      alert('Calculez d\'abord les masques avant de valider.')
      return
    }
    setSaving(true)
    try {
      const mesh = {
        ...project.mesh,
        sam2Zones: zones,
        sam2Prompts: prompts,
        sam2MasksRLE: masks,
        sam2VideoWidth: sam2VideoDims.w,
        sam2VideoHeight: sam2VideoDims.h,
        sam2Validated: true,
        // Invalidate downstream tagging + tracking
        anchorPointZoneIds: undefined,
        anchorTrackingValidated: false,
        anchorKeyframes: [],
        anchorFrames: null,
      }
      await onSave({ ...project, mesh }, ['sam2MasksRLE'])
    } catch (err) {
      console.error('Failed to save zones:', err)
      alert('Erreur lors de la sauvegarde : ' + (err instanceof Error ? err.message : err))
    }
    setSaving(false)
  }

  if (!project.videoBlob) {
    return (
      <div className="placeholder">
        Importez d'abord une vidéo (étape 1).
      </div>
    )
  }

  // Group prompts by zone for the summary
  const promptCountByZone: Record<string, number> = {}
  for (const z of zones) promptCountByZone[z.id] = 0
  for (const p of prompts) promptCountByZone[p.zoneId] = (promptCountByZone[p.zoneId] ?? 0) + 1

  return (
    <div className="triangulation-step">
      {/* Toolbar — zone selector */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold', marginRight: 4 }}>Zone active :</span>
        {zones.map(z => {
          const isActive = z.id === activeZoneId
          return (
            <button
              key={z.id}
              onClick={() => setActiveZoneId(z.id)}
              style={{
                background: isActive ? z.color : 'transparent',
                color: isActive ? '#fff' : z.color,
                border: `2px solid ${z.color}`,
                padding: '4px 10px',
                borderRadius: 4,
                fontWeight: isActive ? 'bold' : 'normal',
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              {z.label} ({promptCountByZone[z.id]})
            </button>
          )
        })}
      </div>

      {/* Toolbar — label + actions */}
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold', marginRight: 4 }}>Label clic :</span>
        <button
          onClick={() => setActiveLabel(1)}
          style={{
            background: activeLabel === 1 ? '#22c55e' : 'transparent',
            color: activeLabel === 1 ? '#fff' : '#22c55e',
            border: '2px solid #22c55e',
            padding: '4px 10px',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ● Foreground
        </button>
        <button
          onClick={() => setActiveLabel(0)}
          style={{
            background: activeLabel === 0 ? '#ef4444' : 'transparent',
            color: activeLabel === 0 ? '#fff' : '#ef4444',
            border: '2px solid #ef4444',
            padding: '4px 10px',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ✕ Background
        </button>

        <span className="toolbar-separator" />

        <button
          className="btn-primary"
          onClick={handleComputeMasks}
          disabled={computing || prompts.length === 0}
        >
          {computing
            ? computePhase === 'warmup' ? 'Démarrage Cloud...'
              : computePhase === 'uploading' ? 'Upload vidéo...'
              : 'Segmentation SAM 2...'
            : 'Calculer masques (SAM 2)'}
        </button>

        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || computing || !masks}
        >
          {saving ? 'Sauvegarde...' : 'Valider'}
        </button>

        <button
          className="btn-danger"
          onClick={() => { setPrompts([]); setMasks(null); overlayImagesRef.current.clear() }}
          disabled={prompts.length === 0 && !masks}
        >
          Tout effacer
        </button>

        <span className="toolbar-info">
          {prompts.length} prompt{prompts.length !== 1 ? 's' : ''}
          {masks ? ` | Masques: ✓` : ''}
        </span>
      </div>

      <div className="triangulation-help">
        <span>
          Sélectionnez la zone active, puis cliquez sur la frame 0 pour ajouter des prompts |
          Shift+clic = inverser FG/BG | Glisser = déplacer | Clic droit = supprimer |
          Espace + glisser = pan | Molette = zoom
        </span>
      </div>

      <LocalServerHelp service="sam2" />

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1 }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
          style={{
            cursor: !isPromptsEditable
              ? 'default'
              : hoveredIdx !== null ? 'grab' : 'crosshair',
          }}
        />
      </div>

      {masks && totalMaskFrames > 0 && (
        <>
          <div
            style={{
              padding: '6px 16px',
              fontSize: '0.8rem',
              color: 'var(--color-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontWeight: 'bold', color: 'var(--color-text)' }}>
              Preview masques SAM 2
            </span>
            <span>Frame {currentMaskFrame + 1} / {totalMaskFrames}</span>
            {currentMaskFrame > 0 && (
              <span style={{ color: '#f59e0b' }}>
                ⚠ Édition prompts désactivée — repassez à la frame 1 pour modifier
              </span>
            )}
          </div>
          <FrameNavigator
            currentFrame={currentMaskFrame}
            totalFrames={totalMaskFrames}
            editedFrames={EMPTY_EDITED_FRAMES}
            onNavigate={setCurrentMaskFrame}
          />
        </>
      )}
    </div>
  )
}

const EMPTY_EDITED_FRAMES: Set<number> = new Set()

/** Convert "#rrggbb" hex string to [r, g, b]. */
function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!m) return [255, 255, 255]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}
