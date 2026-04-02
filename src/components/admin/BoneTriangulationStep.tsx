/**
 * BoneTriangulationStep — Step 7 for bone-type animations.
 * Computes videoFramesMesh using bone deformation (instead of ARAP).
 * Topology is inherited from rest — no editing, only compute + preview.
 */

import { useState, useEffect, useRef } from 'react'
import type { Project, Animation, Point2D, MeshData } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { batchSolveBone, computeBoneEndpoint, getElbowParams, solveElbowIK } from '../../utils/boneSolver'
import { applyTemporalSmoothing } from '../../utils/trackingConstraints'
import { LoopPlayback } from '../../utils/loopPlayback'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

type ViewMode = 'video' | 'wireframe' | 'gradient'

export default function BoneTriangulationStep({ project, animation, onSave }: Props) {
  const [computing, setComputing] = useState(false)
  const [animProgress, setAnimProgress] = useState('')
  const [playing, setPlaying] = useState(false)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>('video')
  const [smoothingWindow, setSmoothingWindow] = useState(3)
  const [crossfadeFrames, setCrossfadeFrames] = useState(7)

  const animCanvasRef = useRef<HTMLCanvasElement>(null)
  const animContainerRef = useRef<HTMLDivElement>(null)
  const animFrameRef = useRef(0)
  const playbackRef = useRef<LoopPlayback | null>(null)
  const gradientColors = useRef<string[]>([])
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [videoReady, setVideoReady] = useState(false)
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null)

  const mesh = animation.mesh
  const hasAnimation = !!(mesh?.videoFramesMesh && mesh.videoFramesMesh.length > 0)

  // Load image for dimensions
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => { setImageDims({ w: img.width, h: img.height }); URL.revokeObjectURL(url) }
    img.src = url
  }, [project.originalImageBlob])

  // Load video for "video" view mode
  useEffect(() => {
    if (!animation.videoBlob) { videoRef.current = null; setVideoReady(false); return }
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    const url = URL.createObjectURL(animation.videoBlob)
    video.src = url
    video.onloadeddata = () => setVideoReady(true)
    videoRef.current = video
    return () => { video.pause(); URL.revokeObjectURL(url); videoRef.current = null; setVideoReady(false) }
  }, [animation.videoBlob])

  // ResizeObserver for animation canvas — re-run when hasAnimation changes (canvas is conditional)
  useEffect(() => {
    const container = animContainerRef.current
    const canvas = animCanvasRef.current
    if (!container || !canvas) return
    const dpr = window.devicePixelRatio || 1
    // Set initial size immediately
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }
    const observer = new ResizeObserver(() => {
      const r = container.getBoundingClientRect()
      canvas.width = r.width * dpr
      canvas.height = r.height * dpr
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [hasAnimation])

  // Precompute gradient colors
  useEffect(() => {
    if (!hasAnimation || !mesh) return
    const pts0 = mesh.videoFramesMesh![0]
    const tris = mesh.triangles
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const p of pts0) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
    }
    const w = maxX - minX || 1, h = maxY - minY || 1
    gradientColors.current = tris.map(([a, b, c]) => {
      if (a >= pts0.length || b >= pts0.length || c >= pts0.length) return '#6b7084'
      const cx = (pts0[a].x + pts0[b].x + pts0[c].x) / 3
      const cy = (pts0[a].y + pts0[b].y + pts0[c].y) / 3
      const nx = (cx - minX) / w, ny = (cy - minY) / h
      const hue = (nx * 300 + ny * 60) % 360
      return `hsl(${hue}, ${70 + ny * 20}%, ${45 + nx * 20}%)`
    })
  }, [hasAnimation, mesh])

  // Initialize playback
  useEffect(() => {
    if (!hasAnimation) { playbackRef.current = null; return }
    playbackRef.current = new LoopPlayback(mesh!.videoFramesMesh!, { crossfadeFrames })
  }, [hasAnimation, mesh, crossfadeFrames])

  // Animation loop
  useEffect(() => {
    if (!hasAnimation || !playing || !playbackRef.current) return
    let lastTime = performance.now()
    function tick(now: number) {
      const dt = now - lastTime
      lastTime = now
      playbackRef.current!.advanceMs(dt)
      const f = playbackRef.current!.currentFrame
      setCurrentFrame(prev => prev !== f ? f : prev)
      animFrameRef.current = requestAnimationFrame(tick)
    }
    animFrameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [hasAnimation, playing])

  // ─── Drawing helpers ────────────────────────────────────────────────

  const BONE_COLORS = [
    '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7',
    '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
  ]

  function drawBonesOverlay(
    ctx: CanvasRenderingContext2D,
    toCanvas: (p: Point2D) => Point2D,
    frame: number,
  ) {
    if (!mesh) return
    const bones = mesh.bones ?? []
    if (bones.length === 0) return
    const contourAnchorFrames = mesh.contourAnchorFrames
    const ancFrames = mesh.anchorFrames
    if (!contourAnchorFrames || frame >= contourAnchorFrames.length) return

    const trackedPositions = [
      ...contourAnchorFrames[frame],
      ...(ancFrames?.[frame] ?? mesh.anchorPoints),
    ]
    // Rest = tracked frame 0 (not editor positions, to avoid micro-shift)
    const restTracked = [
      ...contourAnchorFrames[0],
      ...(ancFrames?.[0] ?? mesh.anchorPoints),
    ]

    // Draw tracked anchor points
    const nCA = mesh.contourAnchors.length
    for (let i = 0; i < trackedPositions.length; i++) {
      const p = toCanvas(trackedPositions[i])
      const isContour = i < nCA
      ctx.fillStyle = isContour ? 'rgba(255, 60, 60, 0.9)' : 'rgba(0, 200, 255, 0.9)'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1
      ctx.stroke()
      // Anchor number
      ctx.fillStyle = 'white'
      ctx.font = '10px monospace'
      ctx.textAlign = 'center'
      ctx.fillText(`${i}`, p.x, p.y - 7)
    }

    // Draw bones
    for (let bi = 0; bi < bones.length; bi++) {
      const bone = bones[bi]
      const color = BONE_COLORS[bi % BONE_COLORS.length]
      const head = computeBoneEndpoint(bone.head, trackedPositions)
      let tail = computeBoneEndpoint(bone.tail, trackedPositions)

      // Fixed length (only for bones without elbow — elbow handles its own lengths)
      if (bone.fixedLength && !bone.elbowPos) {
        const restHead = computeBoneEndpoint(bone.head, restTracked)
        const restTail = computeBoneEndpoint(bone.tail, restTracked)
        const restLen = Math.hypot(restTail.x - restHead.x, restTail.y - restHead.y)
        const dx = tail.x - head.x, dy = tail.y - head.y
        const currLen = Math.hypot(dx, dy)
        if (currLen > 0) {
          const sc = restLen / currLen
          tail = { x: head.x + dx * sc, y: head.y + dy * sc }
        }
      }

      // Elbow IK
      let elbowScreen: Point2D | null = null
      if (bone.elbowPos) {
        const restHead = computeBoneEndpoint(bone.head, restTracked)
        const restTail = computeBoneEndpoint(bone.tail, restTracked)
        const params = getElbowParams(restHead, restTail, bone.elbowPos)
        const elbow = solveElbowIK(head, tail, params.len1, params.len2, params.bendSide)
        elbowScreen = toCanvas(elbow)

        const headPos = toCanvas(head)
        const tailPos = toCanvas(tail)

        // Segment head → elbow
        ctx.strokeStyle = color
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(headPos.x, headPos.y)
        ctx.lineTo(elbowScreen.x, elbowScreen.y)
        ctx.stroke()

        // Segment elbow → tail (lighter)
        ctx.globalAlpha = 0.7
        ctx.beginPath()
        ctx.moveTo(elbowScreen.x, elbowScreen.y)
        ctx.lineTo(tailPos.x, tailPos.y)
        ctx.stroke()
        ctx.globalAlpha = 1

        // Elbow square
        ctx.fillStyle = '#fbbf24'
        ctx.fillRect(elbowScreen.x - 4, elbowScreen.y - 4, 8, 8)
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 1
        ctx.strokeRect(elbowScreen.x - 4, elbowScreen.y - 4, 8, 8)
      } else {
        const headPos = toCanvas(head)
        const tailPos = toCanvas(tail)

        // Single bone line
        ctx.strokeStyle = color
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(headPos.x, headPos.y)
        ctx.lineTo(tailPos.x, tailPos.y)
        ctx.stroke()
      }

      const headPos = toCanvas(head)
      const tailPos = toCanvas(tail)

      // Head circle
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(headPos.x, headPos.y, 5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1
      ctx.stroke()

      // Tail diamond
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(tailPos.x, tailPos.y - 4)
      ctx.lineTo(tailPos.x + 4, tailPos.y)
      ctx.lineTo(tailPos.x, tailPos.y + 4)
      ctx.lineTo(tailPos.x - 4, tailPos.y)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1
      ctx.stroke()

      // Bone name
      const midPos = elbowScreen ?? { x: (headPos.x + tailPos.x) / 2, y: (headPos.y + tailPos.y) / 2 }
      const midX = midPos.x
      const midY = midPos.y
      ctx.fillStyle = color
      ctx.font = 'bold 10px sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(bone.name, midX, midY - 8)
    }
  }

  // Draw frame
  useEffect(() => {
    if (!hasAnimation || !mesh) return
    if (viewMode === 'video' && !videoReady) return
    const canvas = animCanvasRef.current
    const video = videoRef.current
    if (!canvas) return
    const frames = mesh.videoFramesMesh!
    const tris = mesh.triangles
    if (currentFrame >= frames.length) return

    if (canvas.width === 0 || canvas.height === 0) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const dpr = window.devicePixelRatio || 1
        canvas.width = rect.width * dpr
        canvas.height = rect.height * dpr
      }
    }

    const frame = currentFrame
    const mode = viewMode
    const colors = gradientColors.current

    function draw() {
      const ctx = canvas!.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas!.width, canvas!.height)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const cssW = canvas!.width / dpr
      const cssH = canvas!.height / dpr
      if (cssW === 0 || cssH === 0) return

      const vw = video?.videoWidth ?? imageDims?.w ?? 800
      const vh = video?.videoHeight ?? imageDims?.h ?? 600
      const s = Math.min(cssW / vw, cssH / vh) * 0.95
      const ox = (cssW - vw * s) / 2, oy = (cssH - vh * s) / 2
      const imgW = imageDims?.w ?? vw, imgH = imageDims?.h ?? vh

      const toCanvas = (p: Point2D) => ({
        x: (p.x / imgW) * vw * s + ox,
        y: (p.y / imgH) * vh * s + oy,
      })

      // Background
      if (mode === 'video' && video) {
        ctx.drawImage(video, ox, oy, vw * s, vh * s)
      } else {
        ctx.fillStyle = '#1a1a2e'
        ctx.fillRect(ox, oy, vw * s, vh * s)
      }

      if (mode === 'video') {
        // Video mode: only anchors + bones overlay, no mesh wireframe
        drawBonesOverlay(ctx, toCanvas, frame)
      } else {
        // Wireframe / Gradient modes: draw mesh + bones
        const points = playbackRef.current ? playbackRef.current.getPositions() : frames[frame]

        if (mode === 'gradient') {
          for (let ti = 0; ti < tris.length; ti++) {
            const [a, b, c] = tris[ti]
            if (a >= points.length || b >= points.length || c >= points.length) continue
            const pa = toCanvas(points[a]), pb = toCanvas(points[b]), pc = toCanvas(points[c])
            ctx.fillStyle = colors[ti] ?? '#6b7084'
            ctx.beginPath()
            ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
            ctx.closePath(); ctx.fill()
          }
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
          ctx.lineWidth = 0.5
        } else {
          ctx.strokeStyle = 'rgba(0, 255, 200, 0.7)'
          ctx.lineWidth = 1.2
        }

        for (const [a, b, c] of tris) {
          if (a >= points.length || b >= points.length || c >= points.length) continue
          const pa = toCanvas(points[a]), pb = toCanvas(points[b]), pc = toCanvas(points[c])
          ctx.beginPath()
          ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.lineTo(pc.x, pc.y)
          ctx.closePath(); ctx.stroke()
        }

        // Vertices
        const nCA = mesh!.contourAnchors.length
        const nSub = mesh!.contourSubdivisionPoints.length
        const nAP = mesh!.anchorPoints.length
        for (let i = 0; i < points.length; i++) {
          const p = toCanvas(points[i])
          let color: string, radius: number
          if (i < nCA) { color = 'rgba(255, 60, 60, 0.9)'; radius = 3.5 }
          else if (i < nCA + nSub) { color = 'rgba(255, 220, 50, 0.8)'; radius = 2 }
          else if (i < nCA + nSub + nAP) { color = 'rgba(0, 200, 255, 0.9)'; radius = 3.5 }
          else { color = 'rgba(255, 255, 255, 0.7)'; radius = 2 }
          ctx.beginPath()
          ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
        }

        // Bones overlay on mesh views too
        drawBonesOverlay(ctx, toCanvas, frame)
      }

      // Frame counter
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(8, 8, 120, 24)
      ctx.fillStyle = '#fff'
      ctx.font = '12px monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`Frame ${frame} / ${frames.length - 1}`, 14, 24)
    }

    if (mode === 'video' && video) {
      const targetTime = frame / 24
      const handleSeeked = () => draw()
      video.addEventListener('seeked', handleSeeked)
      video.currentTime = targetTime
      if (Math.abs(video.currentTime - targetTime) < 0.02) draw()
      return () => video.removeEventListener('seeked', handleSeeked)
    } else {
      draw()
    }
  }, [hasAnimation, videoReady, currentFrame, mesh, imageDims, viewMode])

  // ─── Compute bone animation ────────────────────────────────────────

  async function handleComputeBone() {
    if (!mesh || !mesh.bones || mesh.bones.length === 0) return
    if (!mesh.boneWeights) return
    if (!mesh.contourAnchorFrames) return

    const contourAnchorFrames = mesh.contourAnchorFrames
    const ancFrames = mesh.anchorFrames ?? []
    const totalF = ancFrames.length > 0
      ? Math.min(contourAnchorFrames.length, ancFrames.length)
      : contourAnchorFrames.length
    if (totalF === 0) return

    setComputing(true)
    try {
      setAnimProgress('Préparation...')
      await new Promise(r => setTimeout(r, 0))

      // Rest pose: all mesh points at frame 0 (original static positions)
      const allRestPoints: Point2D[] = [
        ...mesh.contourAnchors,
        ...mesh.contourSubdivisionPoints,
        ...mesh.anchorPoints,
        ...mesh.internalPoints,
      ]

      // Tracked positions per frame
      const trackedFrames: Point2D[][] = []
      for (let f = 0; f < totalF; f++) {
        trackedFrames.push([
          ...contourAnchorFrames[f],
          ...(ancFrames[f] ?? mesh.anchorPoints),
        ])
      }

      // Rest pose = tracked frame 0 (not editor positions, to avoid micro-shift)
      const restTrackedPositions = trackedFrames[0]

      setAnimProgress('Calcul déformation bones...')
      await new Promise(r => setTimeout(r, 0))

      let videoFramesMesh = batchSolveBone(
        mesh.bones,
        mesh.boneWeights,
        allRestPoints,
        trackedFrames,
        restTrackedPositions,
        (frame, total) => setAnimProgress(`Bone frame ${frame + 1} / ${total}`)
      )

      // Temporal smoothing
      if (smoothingWindow > 1) {
        setAnimProgress('Lissage temporel...')
        await new Promise(r => setTimeout(r, 0))
        videoFramesMesh = applyTemporalSmoothing(videoFramesMesh, smoothingWindow)
      }

      setAnimProgress('Sauvegarde...')
      await new Promise(r => setTimeout(r, 0))

      const updatedMesh: MeshData = {
        ...mesh,
        videoFramesMesh,
        crossfadeFrames,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave({ ...project, animations: updatedAnims })
      setComputing(false)
      setAnimProgress('')
    } catch (err) {
      console.error('Bone computation failed:', err)
      alert('Erreur Bone : ' + (err instanceof Error ? err.message : err))
      setComputing(false)
      setAnimProgress('')
    }
  }

  // ─── Prerequisites check ──────────────────────────────────────────

  if (!mesh?.bonesValidated) {
    return (
      <div className="placeholder">
        Validez d'abord les bones (étape précédente).
      </div>
    )
  }

  if (!mesh.contourAnchorFrames) {
    return (
      <div className="placeholder">
        Validez d'abord le tracking des ancres contour.
      </div>
    )
  }

  const contourAnchors = mesh.contourAnchors
  const contourSubPts = mesh.contourSubdivisionPoints
  const anchorPoints = mesh.anchorPoints

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar">
        <span style={{ color: 'var(--color-type-bone)', fontWeight: 'bold', marginRight: 8 }}>
          Déformation par bones
        </span>
        <span className="toolbar-info">
          Contour: {contourAnchors.length}+{contourSubPts.length} |
          Ancres: {anchorPoints.length} |
          Internes: {mesh.internalPoints.length} |
          Triangles: {mesh.triangles.length} |
          Bones: {mesh.bones.length}
        </span>
      </div>

      {/* Smoothing & crossfade controls */}
      <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          Lissage: {smoothingWindow}
        </label>
        <input
          type="range" min={1} max={15} value={smoothingWindow}
          onChange={e => setSmoothingWindow(Number(e.target.value))}
          style={{ width: 100 }}
        />
        <label style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          Crossfade: {crossfadeFrames}
        </label>
        <input
          type="range" min={0} max={20} value={crossfadeFrames}
          onChange={e => setCrossfadeFrames(Number(e.target.value))}
          style={{ width: 100 }}
        />
      </div>

      {/* Compute section */}
      <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 8 }}>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          {!hasAnimation ? (
            <>
              <button
                onClick={handleComputeBone}
                disabled={computing}
                className="btn-primary"
              >
                {computing ? 'Calcul en cours...' : 'Calculer Animation (Bone)'}
              </button>
              {computing && (
                <span style={{ fontFamily: 'monospace', color: 'var(--color-muted)' }}>{animProgress}</span>
              )}
            </>
          ) : (
            <>
              <span style={{ color: 'var(--color-success)', fontWeight: 'bold' }}>Animation calculée</span>
              <span style={{ color: 'var(--color-muted)' }}>
                {mesh.videoFramesMesh!.length} frames, {mesh.videoFramesMesh![0]?.length ?? 0} pts/frame
              </span>
              <button className="btn-icon" onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Play'}</button>
              <button onClick={() => { setPlaying(false); setCurrentFrame(f => Math.max(0, f - 1)) }}>&#9664;</button>
              <button onClick={() => { setPlaying(false); setCurrentFrame(f => Math.min(mesh!.videoFramesMesh!.length - 1, f + 1)) }}>&#9654;</button>
              <button className="btn-icon" onClick={() => { setPlaying(false); setCurrentFrame(0) }}>Rewind</button>
              <button className="btn-primary" onClick={handleComputeBone} disabled={computing} style={{ marginLeft: 'auto' }}>
                Recalculer
              </button>
            </>
          )}
        </div>

        {computing && (
          <div style={{ padding: '0 16px' }}>
            <div style={{ width: '100%', height: 4, background: 'var(--color-surface-3)', borderRadius: 2 }}>
              <div style={{ width: '50%', height: '100%', background: 'var(--color-type-bone)', borderRadius: 2 }} />
            </div>
          </div>
        )}

        {hasAnimation && (
          <>
            <div style={{ padding: '4px 16px 8px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--color-muted)', fontSize: 12 }}>Vue :</span>
              <button className={`btn-sm ${viewMode === 'video' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('video')}>Vidéo + Tracking</button>
              <button className={`btn-sm ${viewMode === 'wireframe' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('wireframe')}>Wireframe</button>
              <button className={`btn-sm ${viewMode === 'gradient' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setViewMode('gradient')}>Gradient</button>
              <span style={{ flex: 1 }} />
              <input
                type="range"
                min={0}
                max={(playbackRef.current?.effectiveLength ?? mesh.videoFramesMesh!.length) - 1}
                value={currentFrame}
                onChange={e => { setPlaying(false); const f = Number(e.target.value); setCurrentFrame(f); playbackRef.current?.seekFrame(f) }}
                style={{ width: 200 }}
              />
              <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--color-text-secondary)', minWidth: 80 }}>
                {currentFrame} / {(playbackRef.current?.effectiveLength ?? mesh.videoFramesMesh!.length) - 1}
              </span>
            </div>
            <div ref={animContainerRef} style={{ height: 400, position: 'relative' }}>
              <canvas ref={animCanvasRef} style={{ width: '100%', height: '100%' }} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
