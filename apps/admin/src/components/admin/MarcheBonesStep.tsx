import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { Project, Animation, Point2D, CoTrackerSkeleton } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { buildMarcheInheritSnapshot } from '../../utils/marcheSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

type DragKey =
  | { kind: 'body'; jointIdx: number }
  | { kind: 'leg'; legId: string; jointIdx: number }  // 0=hip, last=foot

const PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899']
const HIT_RADIUS_PX = 12  // in screen px

/**
 * Étape 1 (marche) — Éditeur des bones hérités.
 *
 * Affiche le squelette (corps + pattes) sur l'image et permet de déplacer
 * n'importe quel joint pour ajuster sa position de repos. Bouton "Re-hériter"
 * pour repartir d'un parent cotracker-bones (au cas où on veut tout reset).
 */
export default function MarcheBonesStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { transformRef, fitToCanvas } = useCanvasInteraction(canvasRef)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [imageLoaded, setImageLoaded] = useState(false)

  // Local editable state (image coords)
  const [bodyJoints, setBodyJoints] = useState<Point2D[]>(
    () => (mesh?.marcheBodyJointRestPositions ?? []).map(p => ({ ...p })),
  )
  const [legRest, setLegRest] = useState<Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }>>(
    () => JSON.parse(JSON.stringify(mesh?.marcheLegRestPositions ?? {})),
  )
  const [dragging, setDragging] = useState<DragKey | null>(null)
  const draggingRef = useRef<DragKey | null>(null)
  draggingRef.current = dragging
  const [saving, setSaving] = useState(false)

  // Sources for re-inherit
  const marcheSources = useMemo(() => project.animations.filter(a =>
    a.type === 'cotracker-bones'
    && a.mesh?.cotrackerBonesValidated
    && a.mesh?.cotrackerSkeleton
    && (a.mesh.cotrackerBodyJointFrames
        || a.mesh.cotrackerBodyJointFramesSmoothed
        || a.mesh.cotrackerFrames)
  ), [project.animations])
  const [reInheritFrom, setReInheritFrom] = useState<string>(mesh?.marcheParentAnimationId ?? marcheSources[0]?.id ?? '')

  // Work in mask coords (consistent with bodyPoints/zonePoints).
  const maskW = project.projectTriangulation?.maskWidth ?? 1
  const maskH = project.projectTriangulation?.maskHeight ?? 1

  // Load image
  useEffect(() => {
    if (!project.originalImageBlob) return
    const url = URL.createObjectURL(project.originalImageBlob)
    const img = new Image()
    img.onload = () => {
      imageRef.current = img
      setImageLoaded(true)
      requestAnimationFrame(() => fitToCanvas(maskW, maskH))
    }
    img.src = url
    return () => { imageRef.current = null; setImageLoaded(false); URL.revokeObjectURL(url) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.originalImageBlob, maskW, maskH])

  const skeleton = mesh?.marcheSkeleton ?? null
  const migratedRef = useRef(false)

  // Auto-migrate legacy positions stored in natural-image coords → mask coords.
  // Heuristic : if any joint coord exceeds the mask bounds by >20% AND the natural
  // image is larger than the mask, rescale by mask/natural ratio.
  useEffect(() => {
    if (!imageLoaded || !imageRef.current || migratedRef.current) return
    const img = imageRef.current
    if (img.naturalWidth <= maskW * 1.05 && img.naturalHeight <= maskH * 1.05) {
      migratedRef.current = true
      return
    }
    let maxX = 0, maxY = 0
    for (const p of bodyJoints) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    for (const lr of Object.values(legRest)) {
      for (const p of [lr.hip, ...lr.joints, lr.foot]) {
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
      }
    }
    if (maxX > maskW * 1.2 || maxY > maskH * 1.2) {
      const sx = maskW / img.naturalWidth
      const sy = maskH / img.naturalHeight
      setBodyJoints(prev => prev.map(p => ({ x: p.x * sx, y: p.y * sy })))
      setLegRest(prev => {
        const next: typeof prev = {}
        for (const [id, lr] of Object.entries(prev)) {
          next[id] = {
            hip: { x: lr.hip.x * sx, y: lr.hip.y * sy },
            joints: lr.joints.map(p => ({ x: p.x * sx, y: p.y * sy })),
            foot: { x: lr.foot.x * sx, y: lr.foot.y * sy },
          }
        }
        return next
      })
    }
    migratedRef.current = true
  }, [imageLoaded, maskW, maskH, bodyJoints, legRest])

  // ── Drawing ──────────────────────────────────────────────────────
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
    ctx.fillStyle = '#1a1b2e'
    ctx.fillRect(0, 0, rect.width, rect.height)

    ctx.save()
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(t.scale, t.scale)
    ctx.globalAlpha = 0.6
    ctx.drawImage(img, 0, 0, maskW, maskH)  // scale image to mask coord system
    ctx.globalAlpha = 1

    // Body chain
    if (bodyJoints.length >= 2) {
      ctx.strokeStyle = '#06b6d4'
      ctx.lineWidth = 3 / t.scale
      ctx.beginPath()
      bodyJoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
      ctx.stroke()
    }
    // Body joints
    ctx.fillStyle = '#06b6d4'
    const rb = 6 / t.scale
    for (const p of bodyJoints) {
      ctx.beginPath(); ctx.arc(p.x, p.y, rb, 0, Math.PI * 2); ctx.fill()
    }

    // Legs
    if (skeleton) {
      skeleton.legs.forEach((leg, li) => {
        const r = legRest[leg.id]
        if (!r) return
        const chain = [r.hip, ...r.joints, r.foot]
        ctx.strokeStyle = PALETTE[li % PALETTE.length]
        ctx.lineWidth = 3 / t.scale
        ctx.beginPath()
        chain.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
        ctx.stroke()
        ctx.fillStyle = PALETTE[li % PALETTE.length]
        const r2 = 5 / t.scale
        for (const p of chain) {
          ctx.beginPath(); ctx.arc(p.x, p.y, r2, 0, Math.PI * 2); ctx.fill()
        }
      })
    }

    ctx.restore()
  }, [bodyJoints, legRest, skeleton, transformRef])

  useEffect(() => { draw() })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      if (imageRef.current && canvas.clientWidth > 0)
        fitToCanvas(maskW, maskH)
      draw()
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw])

  // ── Hit-test + drag ──────────────────────────────────────────────
  function screenToImage(e: React.PointerEvent): Point2D {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const t = transformRef.current
    return { x: (x - t.offsetX) / t.scale, y: (y - t.offsetY) / t.scale }
  }

  function hitTest(p: Point2D): DragKey | null {
    const t = transformRef.current
    const rImg = HIT_RADIUS_PX / t.scale
    const r2 = rImg * rImg
    // Body
    for (let i = 0; i < bodyJoints.length; i++) {
      const dx = bodyJoints[i].x - p.x, dy = bodyJoints[i].y - p.y
      if (dx * dx + dy * dy <= r2) return { kind: 'body', jointIdx: i }
    }
    if (!skeleton) return null
    for (const leg of skeleton.legs) {
      const r = legRest[leg.id]
      if (!r) continue
      const chain = [r.hip, ...r.joints, r.foot]
      for (let i = 0; i < chain.length; i++) {
        const dx = chain[i].x - p.x, dy = chain[i].y - p.y
        if (dx * dx + dy * dy <= r2) return { kind: 'leg', legId: leg.id, jointIdx: i }
      }
    }
    return null
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 || (e as unknown as KeyboardEvent).altKey) return
    const p = screenToImage(e)
    const hit = hitTest(p)
    if (hit) {
      setDragging(hit)
      ;(e.target as Element).setPointerCapture(e.pointerId)
    }
  }
  function onPointerMove(e: React.PointerEvent) {
    const drag = draggingRef.current
    if (!drag) return
    const p = screenToImage(e)
    if (drag.kind === 'body') {
      setBodyJoints(prev => prev.map((q, i) => i === drag.jointIdx ? p : q))
    } else {
      setLegRest(prev => {
        const next = { ...prev }
        const lr = { ...next[drag.legId], joints: [...next[drag.legId].joints] }
        const chainLen = 2 + lr.joints.length
        if (drag.jointIdx === 0) lr.hip = p
        else if (drag.jointIdx === chainLen - 1) lr.foot = p
        else lr.joints[drag.jointIdx - 1] = p
        next[drag.legId] = lr
        return next
      })
    }
  }
  function onPointerUp() { setDragging(null) }

  async function handleSave() {
    if (!mesh) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        marcheBodyJointRestPositions: bodyJoints,
        marcheLegRestPositions: legRest,
        // Invalidate downstream — bone frames need recompute
        cotrackerBodyJointFrames: null,
        cotrackerLegBoneFrames: null,
        walkBodyFrames: null,
        walkZoneFrames: null,
        walkBodyFramesSmoothed: null,
        walkZoneFramesSmoothed: null,
        cotrackerLBSValidated: false,
        walkBodyFramesSmoothingValidated: false,
        walkZoneFramesSmoothingValidated: false,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a,
      )
      await onSave({ ...project, animations: updatedAnims })
    } finally {
      setSaving(false)
    }
  }

  async function handleReInherit() {
    if (!confirm('Re-hériter le squelette depuis l\'animation parente ? Toutes les modifications seront perdues.')) return
    const parent = project.animations.find(a => a.id === reInheritFrom)
    if (!parent?.mesh) return
    const imgW = project.projectTriangulation?.maskWidth ?? 1
    const imgH = project.projectTriangulation?.maskHeight ?? 1
    const snap = buildMarcheInheritSnapshot(parent.id, parent.mesh, imgW, imgH)
    if (!snap) { alert('Parent invalide'); return }
    setBodyJoints(snap.marcheBodyJointRestPositions)
    setLegRest(snap.marcheLegRestPositions)
    if (!mesh) return
    setSaving(true)
    try {
      const updatedMesh = {
        ...mesh,
        ...snap,
        marcheGaitLegIds: snap.marcheSkeleton.legs.map(l => l.id),
        marcheGaitLegsValidated: true,
        cotrackerBodyJointFrames: null,
        cotrackerLegBoneFrames: null,
        walkBodyFrames: null,
        walkZoneFrames: null,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a,
      )
      await onSave({ ...project, animations: updatedAnims })
    } finally {
      setSaving(false)
    }
  }

  if (!skeleton) {
    return (
      <div style={{ padding: 20, color: '#9ca3af' }}>
        Aucun squelette hérité.
        {marcheSources.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button className="btn-primary" onClick={handleReInherit} disabled={saving}>
              Hériter depuis {marcheSources[0].name}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', gap: 16, height: '100%' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{
            width: '100%',
            aspectRatio: `${maskW} / ${maskH}`,
            maxHeight: '75vh',
            display: 'block',
            borderRadius: 8,
            cursor: dragging ? 'grabbing' : 'crosshair',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <p style={{ color: '#9ca3af', fontSize: 12, margin: '8px 0' }}>
          Glisse les joints pour ajuster leur position de repos. Le corps est en cyan, les pattes en couleur (1 par patte).
        </p>
      </div>

      <div style={{ width: 280, flexShrink: 0 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>Bones</h3>

        <SkeletonSummary skeleton={skeleton} />

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <button className="btn-primary" onClick={handleSave} disabled={saving} style={{ width: '100%' }}>
          {saving ? 'Sauvegarde…' : 'Sauvegarder les positions'}
        </button>

        <hr style={{ border: 'none', borderTop: '1px solid #374151', margin: '16px 0' }} />

        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 6 }}>Re-hériter depuis…</div>
        <select
          value={reInheritFrom}
          onChange={e => setReInheritFrom(e.target.value)}
          disabled={saving || marcheSources.length === 0}
          style={{ width: '100%', padding: 6, marginBottom: 6 }}
        >
          {marcheSources.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button className="btn-secondary btn-sm" onClick={handleReInherit} disabled={saving || !reInheritFrom} style={{ width: '100%' }}>
          Re-hériter (reset)
        </button>
      </div>
    </div>
  )
}

function SkeletonSummary({ skeleton }: { skeleton: CoTrackerSkeleton }) {
  return (
    <div style={{ fontSize: 12, background: '#1a1b2e', padding: 10, borderRadius: 6 }}>
      <div><strong>Body chain</strong> : {skeleton.bodyChain.length} joints</div>
      <div style={{ marginTop: 4 }}><strong>Pattes</strong> ({skeleton.legs.length}) :</div>
      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
        {skeleton.legs.map(leg => (
          <li key={leg.id}>{leg.name} <span style={{ color: '#6b7280' }}>({leg.joints.length + 2} joints)</span></li>
        ))}
      </ul>
    </div>
  )
}
