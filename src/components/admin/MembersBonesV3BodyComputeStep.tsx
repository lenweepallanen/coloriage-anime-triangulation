/**
 * MembersBonesV3BodyComputeStep — V3 étape "Calcul Corps".
 *
 * Mode principal (projectTriangulation.step3Validated + zoneContourLength['body']) :
 *   - Topologie héritée : projectTriangulation.bodyPoints / bodyTriangles
 *   - Animation ARAP : les N premiers vertices (contour) sont pinnés aux positions
 *     trackées+lissées par frame, les internes déforment via ARAP.
 *   - walkBodyFrames stocké en coords IMAGE.
 *
 * Mode legacy fallback (projectTriangulation absent ou non validée) :
 *   - Maillage body = Delaunay du contour seul (anchors+subdivision), sans internes.
 *   - walkBodyFrames = positions du contour frame par frame.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { triangulateZone } from '../../utils/limbSeparation'
import { buildV3BoundaryFrames, buildV3BoundaryFrame0 } from '../../utils/membersBonesBodyMesh'
import { computeBodyAnimationARAP } from '../../utils/membersBonesTriangSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function MembersBonesV3BodyComputeStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh

  const [saving, setSaving] = useState(false)
  const [computing, setComputing] = useState(false)
  const [bodyFrames, setBodyFrames] = useState<Point2D[][] | null>(() => mesh?.walkBodyFrames ?? null)
  const [bodyTriangles, setBodyTriangles] = useState<[number, number, number][] | null>(
    () => mesh?.v3BodyTriangles ?? null,
  )

  // ─── Image setup ────────────────────────────────────────────────────────
  const [imgSize, setImgSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const imageRef = useRef<HTMLImageElement | null>(null)
  const fittedRef = useRef(false)

  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = url
    return () => { URL.revokeObjectURL(url); imageRef.current = null }
  }, [project.originalImageBlob])

  // ─── Compute mode ──────────────────────────────────────────────────────
  // Mode héritage projectTriangulation : ARAP sur bodyPoints/bodyTriangles
  // Mode fallback : Delaunay du contour seul (legacy)
  const tri = project.projectTriangulation
  const useInheritedTopology = !!(
    tri?.step3Validated &&
    tri.bodyPoints?.length &&
    tri.bodyTriangles?.length &&
    tri.zoneContourLength?.['body']
  )

  // ─── Boundary (frame 0 + per-frame) in IMAGE coords ─────────────────────
  // V3 hérité : frame 0 vient de projectTriangulation (déjà en coords image),
  // les N premiers indices de bodyPoints = contour P0+anchors+subdivisions.
  // Fallback legacy : helper qui lit sam2ContourAnchors/Subdivision (V1/V2).
  const boundary0 = useMemo(() => {
    if (!mesh || imgSize.w === 0) return null
    if (useInheritedTopology && tri) {
      const nContour = tri.zoneContourLength!['body']!
      return tri.bodyPoints.slice(0, nContour)
    }
    return buildV3BoundaryFrame0(mesh, imgSize.w, imgSize.h)
  }, [mesh, imgSize, useInheritedTopology, tri])

  const boundaryFrames = useMemo(() => {
    if (!mesh || imgSize.w === 0) return null
    // Pass subParams pour produire l'ordre interleavé matchant tri.bodyPoints[0..nContour]
    const subParams = useInheritedTopology ? tri?.zoneSubdivisionParams?.['body'] : undefined
    return buildV3BoundaryFrames(mesh, imgSize.w, imgSize.h, subParams)
  }, [mesh, imgSize, useInheritedTopology, tri])

  const totalFrames = boundaryFrames?.length ?? 0
  const hasResult = bodyFrames != null && bodyFrames.length > 0 && bodyTriangles != null

  // ─── Preview state ──────────────────────────────────────────────────────
  const [currentFrame, setCurrentFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [showImage, setShowImage] = useState(true)
  const [showWireframe, setShowWireframe] = useState(true)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)

  useEffect(() => {
    if (imgSize.w > 0 && !fittedRef.current) {
      fittedRef.current = true
      fitToCanvas(imgSize.w, imgSize.h)
    }
  }, [imgSize, fitToCanvas])

  const handleCompute = useCallback(async () => {
    if (!boundary0 || !boundaryFrames || boundaryFrames.length === 0) return
    setComputing(true)
    try {
      if (useInheritedTopology && tri) {
        // V3 mode héritage : ARAP avec topologie projet
        const nContour = tri.zoneContourLength!['body']!
        const expectedLen = nContour
        if (boundary0.length !== expectedLen) {
          throw new Error(
            `Contour body tracké (${boundary0.length} pts) != contour Triangulation projet (${expectedLen} pts). Refaire le tracking anchors body.`
          )
        }
        const frames = computeBodyAnimationARAP(tri, boundaryFrames)
        setBodyTriangles(tri.bodyTriangles)
        setBodyFrames(frames)
      } else {
        // Mode legacy : Delaunay du contour seul
        const { triangles } = triangulateZone(boundary0, [], boundary0)
        const frames = boundaryFrames.map(f => f.map(p => ({ x: p.x, y: p.y })))
        setBodyTriangles(triangles)
        setBodyFrames(frames)
      }
      setCurrentFrame(0)
    } catch (err) {
      console.error('[MBV3BodyCompute] compute failed:', err)
      alert(`Erreur calcul : ${err instanceof Error ? err.message : err}`)
    } finally {
      setComputing(false)
    }
  }, [boundary0, boundaryFrames, useInheritedTopology, tri])

  // ─── Save ──────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!bodyFrames || !bodyTriangles || !mesh) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        v3BodyTriangles: bodyTriangles,
        v3BodyTriangulationValidated: true,
        walkBodyFrames: bodyFrames,
        // Silent downstream invalidation
        walkBodyFramesSmoothed: null,
        walkBodyFramesSmoothingValidated: false,
        walkZoneFrames: null,
        walkZoneFramesSmoothed: null,
        walkZoneFramesSmoothingValidated: false,
      }
      const updatedAnimations = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave(
        { ...project, animations: updatedAnimations },
        [
          { animationId: animation.id, field: 'walkBodyFrames' },
          { animationId: animation.id, field: 'walkZoneFrames' },
        ],
      )
    } finally {
      setSaving(false)
    }
  }, [bodyFrames, bodyTriangles, mesh, project, animation, onSave])

  // ─── Playback ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !hasResult) return
    let raf: number
    let last = performance.now()
    const ms = 1000 / 24
    let acc = 0
    const tick = (now: number) => {
      acc += now - last
      last = now
      if (acc >= ms) {
        const steps = Math.floor(acc / ms)
        acc -= steps * ms
        setCurrentFrame(f => (f + steps) % Math.max(1, totalFrames))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, hasResult, totalFrames])

  // ─── Draw (resize canvas inline at start, mirror V2 pattern) ───────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const t = transformRef.current
    ctx.setTransform(t.scale * dpr, 0, 0, t.scale * dpr, t.offsetX * dpr, t.offsetY * dpr)

    if (showImage && imageRef.current) ctx.drawImage(imageRef.current, 0, 0)

    const f = Math.min(currentFrame, Math.max(0, totalFrames - 1))
    const pts = hasResult && bodyFrames ? bodyFrames[f] : boundary0

    if (pts && bodyTriangles && showWireframe) {
      ctx.strokeStyle = '#22c55e'
      ctx.lineWidth = 0.6 / t.scale
      ctx.globalAlpha = 0.7
      for (const [a, b, c] of bodyTriangles) {
        const pa = pts[a], pb = pts[b], pc = pts[c]
        if (!pa || !pb || !pc) continue
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.lineTo(pc.x, pc.y)
        ctx.closePath()
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    } else if (pts) {
      ctx.strokeStyle = '#3b82f6'
      ctx.lineWidth = 1.5 / t.scale
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.closePath()
      ctx.stroke()
    }
  }, [currentFrame, showImage, showWireframe, boundary0, bodyTriangles, bodyFrames, hasResult, totalFrames, transformRef])

  // ─── Render ────────────────────────────────────────────────────────────
  if (!project.originalImageBlob) return <div className="placeholder">Image projet manquante.</div>
  if (!tri?.step3Validated) {
    return <div className="placeholder">Triangulation projet incomplète (étape 3 requise).</div>
  }
  if (!mesh?.sam2ContourAnchorTrackingValidated) {
    return <div className="placeholder">Validez d&apos;abord le tracking anchors zones (étape 5).</div>
  }
  if (!boundary0 || boundary0.length < 3) {
    return <div className="placeholder">Contour body indisponible.</div>
  }
  if (!boundaryFrames || boundaryFrames.length === 0) {
    return <div className="placeholder">Frames boundary indisponibles (validez le tracking anchors body).</div>
  }

  return (
    <div className="step-section">
      <div className="step-controls" style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn-primary" onClick={handleCompute} disabled={computing || saving}>
          {computing ? 'Triangulation...' : 'Calculer corps (triangulation contour)'}
        </button>
        {hasResult && (
          <button className="btn-primary" onClick={handleSave} disabled={saving || computing}>
            {saving ? 'Sauvegarde...' : 'Sauvegarder & Valider'}
          </button>
        )}
      </div>

      <div style={{ fontSize: 13, color: '#94a3b8', marginBottom: 8 }}>
        Contour body : {boundary0.length} pts — {bodyTriangles?.length ?? 0} triangles — {totalFrames} frames
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 13 }}>
        <label><input type="checkbox" checked={showImage} onChange={e => setShowImage(e.target.checked)} /> Image</label>
        <label><input type="checkbox" checked={showWireframe} onChange={e => setShowWireframe(e.target.checked)} /> Wireframe</label>
      </div>

      {hasResult && totalFrames > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button className="btn-sm btn-secondary" onClick={() => setPlaying(p => !p)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            value={currentFrame}
            onChange={e => { setPlaying(false); setCurrentFrame(Number(e.target.value)) }}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 12, color: '#94a3b8', minWidth: 60 }}>
            {currentFrame + 1} / {totalFrames}
          </span>
        </div>
      )}

      <div ref={containerRef} style={{ position: 'relative', width: '100%', height: 500, background: '#1a1a2e', borderRadius: 8, overflow: 'hidden' }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  )
}
