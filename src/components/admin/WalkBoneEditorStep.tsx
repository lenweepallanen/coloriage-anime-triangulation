import { useState, useRef, useEffect, useCallback } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import {
  WALK_KEYPOINT_LABELS, WALK_NUM_KEYPOINTS,
  WALK_PRESETS, buildWalkSkeleton, DEFAULT_WALK_PARAMS,
} from '../../utils/walkSolver'

const POINT_RADIUS = 6
const HIT_RADIUS = 12

// Bone segment definitions: [headIdx, tailIdx] pairs in keyPoints
const BONE_SEGMENTS: [number, number][] = [
  [0, 1], [1, 2],   // AV gauche: épaule→genou→pied
  [3, 4], [4, 5],   // AV droite
  [6, 7], [7, 8],   // AR gauche
  [9, 10], [10, 11], // AR droite
  [12, 13], [13, 14], // cou→tête→sommet
  [15, 16], [16, 17], // queue
]

// Keypoint group colors
const GROUP_COLORS = [
  '#3b82f6', '#3b82f6', '#3b82f6',  // AV gauche (blue)
  '#22c55e', '#22c55e', '#22c55e',  // AV droite (green)
  '#f59e0b', '#f59e0b', '#f59e0b',  // AR gauche (amber)
  '#ef4444', '#ef4444', '#ef4444',  // AR droite (red)
  '#a855f7', '#a855f7', '#a855f7',  // cou/tête (purple)
  '#14b8a6', '#14b8a6', '#14b8a6',  // queue (teal)
]

// Keypoint groups for the checklist
const GROUPS = [
  { label: 'Patte AV gauche', indices: [0, 1, 2] },
  { label: 'Patte AV droite', indices: [3, 4, 5] },
  { label: 'Patte AR gauche', indices: [6, 7, 8] },
  { label: 'Patte AR droite', indices: [9, 10, 11] },
  { label: 'Cou / Tête', indices: [12, 13, 14] },
  { label: 'Queue', indices: [15, 16, 17] },
]

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function WalkBoneEditorStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const restAnim = project.animations.find(a => a.type === 'rest')
  const restMesh = restAnim?.mesh

  // Key points state (null = not placed yet)
  const [keyPoints, setKeyPoints] = useState<(Point2D | null)[]>(() => {
    if (mesh?.walkSkeleton) return [...mesh.walkSkeleton.keyPoints]
    return new Array(WALK_NUM_KEYPOINTS).fill(null)
  })
  const [selectedIndex, setSelectedIndex] = useState<number>(0) // next unplaced
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [canvasKey, setCanvasKey] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const animFrameRef = useRef<number>(0)

  console.log('[WalkBone] mount', {
    hasMesh: !!mesh,
    hasSkeleton: !!mesh?.walkSkeleton,
    skeletonPoints: mesh?.walkSkeleton?.keyPoints?.length,
    keyPointsLoaded: keyPoints.filter(p => p !== null).length,
  })

  // Load image + re-fit on resize/remount
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      requestAnimationFrame(() => fitToCanvas(img.width, img.height))
    }
    img.src = url

    const canvas = canvasRef.current
    let ro: ResizeObserver | null = null
    if (canvas) {
      ro = new ResizeObserver(() => {
        if (imageRef.current && canvas.clientWidth > 0) {
          fitToCanvas(imageRef.current.naturalWidth, imageRef.current.naturalHeight)
        }
      })
      ro.observe(canvas)
    }

    return () => {
      imageRef.current = null
      URL.revokeObjectURL(url)
      ro?.disconnect()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob, canvasKey])

  // Find next unplaced point
  useEffect(() => {
    const nextUnplaced = keyPoints.findIndex(p => p === null)
    if (nextUnplaced >= 0 && draggingIndex === null) {
      setSelectedIndex(nextUnplaced)
    }
  }, [keyPoints, draggingIndex])

  // Draw loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const img = imageRef.current
    if (!canvas || !ctx || !img) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const t = transformRef.current
    ctx.clearRect(0, 0, rect.width, rect.height)

    // Background
    ctx.fillStyle = '#1a1b2e'
    ctx.fillRect(0, 0, rect.width, rect.height)

    ctx.save()
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(t.scale, t.scale)

    // Image
    ctx.drawImage(img, 0, 0)

    // Draw triangulation wireframe if available
    if (restMesh?.triangles && restMesh.topologyLocked) {
      const allPoints = [
        ...(restMesh.contourAnchors || []),
        ...(restMesh.contourSubdivisionPoints || []),
        ...(restMesh.anchorPoints || []),
        ...(restMesh.internalPoints || []),
      ]
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
      ctx.lineWidth = 1 / t.scale
      for (const [a, b, c] of restMesh.triangles) {
        if (a >= allPoints.length || b >= allPoints.length || c >= allPoints.length) continue
        ctx.beginPath()
        ctx.moveTo(allPoints[a].x, allPoints[a].y)
        ctx.lineTo(allPoints[b].x, allPoints[b].y)
        ctx.lineTo(allPoints[c].x, allPoints[c].y)
        ctx.closePath()
        ctx.stroke()
      }
    }

    // Draw bone segments
    ctx.lineWidth = 2.5 / t.scale
    for (const [hi, ti] of BONE_SEGMENTS) {
      const hp = keyPoints[hi]
      const tp = keyPoints[ti]
      if (!hp || !tp) continue
      ctx.strokeStyle = GROUP_COLORS[hi]
      ctx.beginPath()
      ctx.moveTo(hp.x, hp.y)
      ctx.lineTo(tp.x, tp.y)
      ctx.stroke()
    }

    // Draw spine (midpoint shoulders → midpoint hips) if all bases placed
    const bases = [keyPoints[0], keyPoints[3], keyPoints[6], keyPoints[9]]
    if (bases.every(b => b != null)) {
      const frontMid = { x: (bases[0]!.x + bases[1]!.x) / 2, y: (bases[0]!.y + bases[1]!.y) / 2 }
      const backMid = { x: (bases[2]!.x + bases[3]!.x) / 2, y: (bases[2]!.y + bases[3]!.y) / 2 }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.lineWidth = 3 / t.scale
      ctx.setLineDash([6 / t.scale, 4 / t.scale])
      ctx.beginPath()
      ctx.moveTo(frontMid.x, frontMid.y)
      ctx.lineTo(backMid.x, backMid.y)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Draw keypoints
    const pr = POINT_RADIUS / t.scale
    for (let i = 0; i < WALK_NUM_KEYPOINTS; i++) {
      const p = keyPoints[i]
      if (!p) continue

      ctx.fillStyle = i === selectedIndex ? '#fff' : GROUP_COLORS[i]
      ctx.strokeStyle = i === selectedIndex ? GROUP_COLORS[i] : '#fff'
      ctx.lineWidth = 2 / t.scale
      ctx.beginPath()
      ctx.arc(p.x, p.y, pr, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      // Label
      ctx.fillStyle = '#fff'
      ctx.font = `${11 / t.scale}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(String(i + 1), p.x, p.y - pr - 4 / t.scale)
    }

    ctx.restore()

    animFrameRef.current = requestAnimationFrame(draw)
  }, [keyPoints, selectedIndex, restMesh, transformRef])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // Mouse handlers
  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0 || spaceDown.current || isPanning.current) return
    const canvas = canvasRef.current
    if (!canvas) return

    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    // Check if clicking on an existing point
    for (let i = 0; i < WALK_NUM_KEYPOINTS; i++) {
      const p = keyPoints[i]
      if (!p) continue
      const d = Math.hypot(p.x - imgPt.x, p.y - imgPt.y)
      if (d < hitR) {
        setDraggingIndex(i)
        setSelectedIndex(i)
        return
      }
    }

    // Place the selected (next unplaced) point
    if (selectedIndex >= 0 && selectedIndex < WALK_NUM_KEYPOINTS && keyPoints[selectedIndex] === null) {
      const newKP = [...keyPoints]
      newKP[selectedIndex] = imgPt
      setKeyPoints(newKP)
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (draggingIndex === null) return
    const imgPt = screenToImage(e.clientX, e.clientY)
    const newKP = [...keyPoints]
    newKP[draggingIndex] = imgPt
    setKeyPoints(newKP)
  }

  function handleMouseUp() {
    setDraggingIndex(null)
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    const imgPt = screenToImage(e.clientX, e.clientY)
    const t = transformRef.current
    const hitR = HIT_RADIUS / t.scale

    for (let i = 0; i < WALK_NUM_KEYPOINTS; i++) {
      const p = keyPoints[i]
      if (!p) continue
      if (Math.hypot(p.x - imgPt.x, p.y - imgPt.y) < hitR) {
        const newKP = [...keyPoints]
        newKP[i] = null
        setKeyPoints(newKP)
        return
      }
    }
  }

  const allPlaced = keyPoints.every(p => p != null)

  if (!mesh) {
    return (
      <div style={{ padding: 20, color: '#f59e0b' }}>
        Le mesh de cette animation est vide. Assurez-vous que la rest animation a une triangulation verrouillée,
        puis recréez l'animation walk.
      </div>
    )
  }

  async function handleValidate() {
    console.log('[WalkBone] handleValidate called', { allPlaced, hasMesh: !!mesh, saving })
    if (!allPlaced || !mesh) {
      console.log('[WalkBone] early return — allPlaced:', allPlaced, 'mesh:', !!mesh)
      return
    }
    const existingPhases = mesh.walkSkeleton
      ? mesh.walkSkeleton.legs.map(l => l.phaseOffset) as [number, number, number, number]
      : WALK_PRESETS.walk
    const skeleton = buildWalkSkeleton(keyPoints as Point2D[], existingPhases)
    console.log('[WalkBone] skeleton built, saving...')
    const updatedMesh: typeof mesh = {
      ...mesh,
      walkSkeleton: skeleton,
      walkSkeletonValidated: true,
      walkParams: mesh.walkParams ?? DEFAULT_WALK_PARAMS,
      videoFramesMesh: null,
    }
    const updatedAnims: Animation[] = project.animations.map(a =>
      a.id === animation.id ? { ...a, mesh: updatedMesh } : a
    )
    setSaving(true)
    try {
      await onSave({ ...project, animations: updatedAnims })
      console.log('[WalkBone] save complete')
    } catch (err) {
      console.error('[WalkBone] save failed:', err)
    }
    setSaving(false)
  }

  const placedCount = keyPoints.filter(p => p != null).length

  return (
    <div className="walk-bone-editor" style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          key={canvasKey}
          ref={canvasRef}
          style={{ width: '100%', height: 500, display: 'block', borderRadius: 8 }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
        />
        <div style={{ padding: '8px 0', color: '#9ca3af', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          Clic gauche = placer, Drag = déplacer, Clic droit = supprimer.
          Espace + drag = pan, Molette = zoom.
          <button
            className="btn-sm btn-ghost"
            onClick={() => setCanvasKey(k => k + 1)}
            style={{ marginLeft: 'auto', fontSize: 11 }}
          >
            Rafraichir canvas
          </button>
        </div>
      </div>

      <div style={{ width: 280, flexShrink: 0, overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>
          Squelette de marche ({placedCount}/{WALK_NUM_KEYPOINTS})
        </h3>

        {GROUPS.map(group => (
          <div key={group.label} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color: '#e5e7eb' }}>
              {group.label}
            </div>
            {group.indices.map(i => {
              const placed = keyPoints[i] != null
              const isSelected = i === selectedIndex
              return (
                <div
                  key={i}
                  onClick={() => !placed && setSelectedIndex(i)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '3px 8px', borderRadius: 4, cursor: placed ? 'default' : 'pointer',
                    background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  }}
                >
                  <span style={{
                    width: 10, height: 10, borderRadius: '50%',
                    background: placed ? GROUP_COLORS[i] : '#4b5563',
                    border: isSelected ? '2px solid #fff' : '2px solid transparent',
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 13, color: placed ? '#e5e7eb' : '#6b7280' }}>
                    {WALK_KEYPOINT_LABELS[i]}
                  </span>
                  {placed && <span style={{ marginLeft: 'auto', color: '#22c55e', fontSize: 12 }}>✓</span>}
                </div>
              )
            })}
          </div>
        ))}

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <button
          className="btn-primary"
          onClick={handleValidate}
          disabled={!allPlaced || saving}
          style={{ width: '100%' }}
        >
          {saving ? 'Sauvegarde...' : allPlaced ? 'Valider le squelette' : `Placer les ${WALK_NUM_KEYPOINTS - placedCount} points restants`}
        </button>
      </div>
    </div>
  )
}
