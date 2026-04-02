/**
 * BoneEditorStep — Step 6 for bone-type animations.
 * Allows defining bones (head/tail endpoints relative to anchor pairs)
 * with parent-child hierarchy. On validation, computes auto-weights.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { Project, Animation, Point2D, Bone, BoneEndpointRef } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { useCanvasInteraction } from '../triangulation/useCanvasInteraction'
import { computeAutoWeights, computeBoneRestPose, computeBoneEndpoint } from '../../utils/boneSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

/** Get rest mesh geometry from the rest animation */
function getRestGeometry(project: Project) {
  const restAnim = project.animations.find(a => a.type === 'rest')
  const m = restAnim?.mesh
  if (!m || m.triangles.length === 0) return null
  const allPoints = [
    ...m.contourAnchors,
    ...m.contourSubdivisionPoints,
    ...m.anchorPoints,
    ...m.internalPoints,
  ]
  const trackedPoints = [...m.contourAnchors, ...m.anchorPoints]
  return {
    allPoints,
    trackedPoints,
    contourAnchors: m.contourAnchors,
    anchorPoints: m.anchorPoints,
    triangles: m.triangles,
    contourSubdivisionPoints: m.contourSubdivisionPoints,
  }
}

const BONE_COLORS = [
  '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]

function getBoneColor(index: number): string {
  return BONE_COLORS[index % BONE_COLORS.length]
}

type EditMode = 'select' | 'add-head' | 'add-tail' | 'place-elbow'

export default function BoneEditorStep({ project, animation, onSave }: Props) {
  const [saving, setSaving] = useState(false)
  const [bones, setBones] = useState<Bone[]>(() => animation.mesh?.bones ?? [])
  const [selectedBoneId, setSelectedBoneId] = useState<string | null>(null)
  const [editMode, setEditMode] = useState<EditMode>('select')
  const [pendingHead, setPendingHead] = useState<BoneEndpointRef | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { transformRef, screenToImage, fitToCanvas, isPanning, spaceDown } =
    useCanvasInteraction(canvasRef)
  const animFrameRef = useRef(0)
  const draggingElbowRef = useRef<string | null>(null)  // bone id being dragged

  const restGeo = useMemo(() => getRestGeometry(project), [project])
  const selectedBone = bones.find(b => b.id === selectedBoneId) ?? null

  // Load image
  useEffect(() => {
    if (!project.originalImageBlob) { setImageUrl(null); return }
    const url = URL.createObjectURL(project.originalImageBlob)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [project.originalImageBlob])

  useEffect(() => {
    if (!imageUrl) { setLoadedImage(null); return }
    const img = new Image()
    img.onload = () => {
      setLoadedImage(img)
      fitToCanvas(img.width, img.height)
    }
    img.src = imageUrl
  }, [imageUrl, fitToCanvas])

  // ─── Canvas drawing ─────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !restGeo) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const t = transformRef.current

    // Resize
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    ctx.save()
    ctx.translate(t.offsetX, t.offsetY)
    ctx.scale(t.scale, t.scale)

    // Draw image
    if (loadedImage) {
      ctx.globalAlpha = 0.4
      ctx.drawImage(loadedImage, 0, 0)
      ctx.globalAlpha = 1
    }

    // Draw mesh wireframe
    const { allPoints, triangles, trackedPoints } = restGeo
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 0.5 / t.scale
    for (const [a, b, c] of triangles) {
      const pa = allPoints[a], pb = allPoints[b], pc = allPoints[c]
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      ctx.lineTo(pb.x, pb.y)
      ctx.lineTo(pc.x, pc.y)
      ctx.closePath()
      ctx.stroke()
    }

    // Draw tracked anchor points with numbers
    const radius = 4 / t.scale
    for (let i = 0; i < trackedPoints.length; i++) {
      const p = trackedPoints[i]
      const isContour = i < restGeo.contourAnchors.length
      ctx.fillStyle = isContour ? '#3b82f6' : '#f59e0b'
      ctx.beginPath()
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
      ctx.fill()

      // Label
      ctx.fillStyle = 'white'
      ctx.font = `${Math.max(10, 12 / t.scale)}px monospace`
      ctx.textAlign = 'center'
      ctx.fillText(`${i}`, p.x, p.y - radius - 2 / t.scale)
    }

    // Draw bones
    for (let bi = 0; bi < bones.length; bi++) {
      const bone = bones[bi]
      const color = getBoneColor(bi)
      const isSelected = bone.id === selectedBoneId
      const headPos = computeBoneEndpoint(bone.head, trackedPoints)
      const tailPos = computeBoneEndpoint(bone.tail, trackedPoints)
      const hasElbow = bone.elbowPos != null

      if (hasElbow) {
        // Draw 2 sub-segments through elbow
        const elbowPos = bone.elbowPos!
        const lw = (isSelected ? 3 : 2) / t.scale

        // Segment head → elbow
        ctx.strokeStyle = color
        ctx.lineWidth = lw
        ctx.beginPath()
        ctx.moveTo(headPos.x, headPos.y)
        ctx.lineTo(elbowPos.x, elbowPos.y)
        ctx.stroke()

        // Segment elbow → tail (slightly lighter)
        ctx.globalAlpha = 0.7
        ctx.beginPath()
        ctx.moveTo(elbowPos.x, elbowPos.y)
        ctx.lineTo(tailPos.x, tailPos.y)
        ctx.stroke()
        ctx.globalAlpha = 1

        // Elbow square
        const elbR = (isSelected ? 5 : 4) / t.scale
        ctx.fillStyle = '#fbbf24' // amber/yellow
        ctx.fillRect(elbowPos.x - elbR, elbowPos.y - elbR, elbR * 2, elbR * 2)
        ctx.strokeStyle = 'white'
        ctx.lineWidth = 1 / t.scale
        ctx.strokeRect(elbowPos.x - elbR, elbowPos.y - elbR, elbR * 2, elbR * 2)
      } else {
        // Single segment head → tail
        ctx.strokeStyle = color
        ctx.lineWidth = (isSelected ? 3 : 2) / t.scale
        ctx.beginPath()
        ctx.moveTo(headPos.x, headPos.y)
        ctx.lineTo(tailPos.x, tailPos.y)
        ctx.stroke()
      }

      // Head circle
      const headR = (isSelected ? 6 : 4) / t.scale
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(headPos.x, headPos.y, headR, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1 / t.scale
      ctx.stroke()

      // Tail diamond
      const tailR = (isSelected ? 5 : 3.5) / t.scale
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(tailPos.x, tailPos.y - tailR)
      ctx.lineTo(tailPos.x + tailR, tailPos.y)
      ctx.lineTo(tailPos.x, tailPos.y + tailR)
      ctx.lineTo(tailPos.x - tailR, tailPos.y)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = 'white'
      ctx.lineWidth = 1 / t.scale
      ctx.stroke()

      // Bone name label
      const midX = (headPos.x + tailPos.x) / 2
      const midY = (headPos.y + tailPos.y) / 2
      ctx.fillStyle = color
      ctx.font = `bold ${Math.max(10, 11 / t.scale)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(bone.name, midX, midY - 6 / t.scale)
    }

    // Draw pending head during add mode
    if (editMode === 'add-tail' && pendingHead) {
      const headPos = computeBoneEndpoint(pendingHead, trackedPoints)
      ctx.fillStyle = 'rgba(255,255,255,0.7)'
      ctx.beginPath()
      ctx.arc(headPos.x, headPos.y, 5 / t.scale, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.restore()

    animFrameRef.current = requestAnimationFrame(draw)
  }, [restGeo, loadedImage, bones, selectedBoneId, editMode, pendingHead, transformRef])

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animFrameRef.current)
  }, [draw])

  // ─── Canvas interaction ─────────────────────────────────────────────

  /** Convert a click position to a BoneEndpointRef by finding the nearest anchor pair */
  function clickToEndpointRef(imgPos: Point2D): BoneEndpointRef | null {
    if (!restGeo || restGeo.trackedPoints.length < 2) return null

    // Find the 2 closest tracked anchors
    const dists = restGeo.trackedPoints.map((p, i) => ({
      i,
      d: Math.hypot(p.x - imgPos.x, p.y - imgPos.y),
    }))
    dists.sort((a, b) => a.d - b.d)
    const iA = dists[0].i
    const iB = dists[1].i

    const a = restGeo.trackedPoints[iA]
    const b = restGeo.trackedPoints[iB]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    if (lenSq === 0) return { anchorIndexA: iA, anchorIndexB: iB, localX: 0, localY: 0 }

    // Project click onto the A→B frame
    const relX = imgPos.x - a.x
    const relY = imgPos.y - a.y
    const localX = (relX * dx + relY * dy) / lenSq
    const localY = (-relX * dy + relY * dx) / lenSq  // perp component (matching boneSolver convention: perp = (-dy, dx))

    return { anchorIndexA: iA, anchorIndexB: iB, localX, localY }
  }

  /** Hit-test elbow: returns bone id if click is near an elbow point */
  function findElbowAtPos(imgPos: Point2D): string | null {
    const threshold = 10 / transformRef.current.scale
    for (let i = bones.length - 1; i >= 0; i--) {
      const bone = bones[i]
      if (!bone.elbowPos) continue
      if (Math.hypot(imgPos.x - bone.elbowPos.x, imgPos.y - bone.elbowPos.y) < threshold) {
        return bone.id
      }
    }
    return null
  }

  function handleCanvasMouseDown(e: React.MouseEvent) {
    if (isPanning.current || spaceDown.current || !restGeo) return
    if (e.button !== 0) return

    const imgPos = screenToImage(e.clientX, e.clientY)

    // In select mode, check if we're starting a drag on an elbow
    if (editMode === 'select') {
      const elbowBoneId = findElbowAtPos(imgPos)
      if (elbowBoneId) {
        draggingElbowRef.current = elbowBoneId
        setSelectedBoneId(elbowBoneId)
        e.preventDefault()
        return
      }
    }
  }

  function handleCanvasMouseMove(e: React.MouseEvent) {
    if (!draggingElbowRef.current || !restGeo) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    setBones(prev => prev.map(b =>
      b.id === draggingElbowRef.current ? { ...b, elbowPos: { x: imgPos.x, y: imgPos.y } } : b
    ))
  }

  function handleCanvasMouseUp(_e: React.MouseEvent) {
    draggingElbowRef.current = null
  }

  function handleCanvasClick(e: React.MouseEvent) {
    if (isPanning.current || spaceDown.current || !restGeo) return
    if (e.button !== 0) return

    const imgPos = screenToImage(e.clientX, e.clientY)

    if (editMode === 'select') {
      // Hit-test bones (skip if we just finished a drag)
      const hitBone = findBoneAtPos(imgPos)
      setSelectedBoneId(hitBone?.id ?? null)
      return
    }

    if (editMode === 'add-head') {
      const ref = clickToEndpointRef(imgPos)
      if (!ref) return
      setPendingHead(ref)
      setEditMode('add-tail')
      return
    }

    if (editMode === 'add-tail' && pendingHead) {
      const ref = clickToEndpointRef(imgPos)
      if (!ref) return
      const newBone: Bone = {
        id: crypto.randomUUID(),
        name: `Bone ${bones.length + 1}`,
        head: pendingHead,
        tail: ref,
        fixedLength: false,
        elbowPos: null,
        elbowMode: 'rest',
      }
      setBones(prev => [...prev, newBone])
      setSelectedBoneId(newBone.id)
      setPendingHead(null)
      setEditMode('select')
      return
    }

    if (editMode === 'place-elbow' && selectedBoneId) {
      setBones(prev => prev.map(b =>
        b.id === selectedBoneId ? { ...b, elbowPos: { x: imgPos.x, y: imgPos.y } } : b
      ))
      setEditMode('select')
      return
    }
  }

  function findBoneAtPos(imgPos: Point2D): Bone | null {
    if (!restGeo) return null
    const threshold = 8 / transformRef.current.scale

    for (let i = bones.length - 1; i >= 0; i--) {
      const bone = bones[i]
      const head = computeBoneEndpoint(bone.head, restGeo.trackedPoints)
      const tail = computeBoneEndpoint(bone.tail, restGeo.trackedPoints)

      // Distance to segment
      const dx = tail.x - head.x
      const dy = tail.y - head.y
      const lenSq = dx * dx + dy * dy
      if (lenSq === 0) {
        if (Math.hypot(imgPos.x - head.x, imgPos.y - head.y) < threshold) return bone
        continue
      }
      let t = ((imgPos.x - head.x) * dx + (imgPos.y - head.y) * dy) / lenSq
      t = Math.max(0, Math.min(1, t))
      const projX = head.x + t * dx
      const projY = head.y + t * dy
      if (Math.hypot(imgPos.x - projX, imgPos.y - projY) < threshold) return bone
    }
    return null
  }

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (!restGeo) return
    const imgPos = screenToImage(e.clientX, e.clientY)
    const bone = findBoneAtPos(imgPos)
    if (bone) {
      setBones(prev => prev.filter(b => b.id !== bone.id))
      if (selectedBoneId === bone.id) setSelectedBoneId(null)
    }
  }

  // ─── Bone property editing ─────────────────────────────────────────

  function updateBone(boneId: string, update: Partial<Bone>) {
    setBones(prev => prev.map(b => b.id === boneId ? { ...b, ...update } : b))
  }

  function updateEndpoint(boneId: string, end: 'head' | 'tail', update: Partial<BoneEndpointRef>) {
    setBones(prev => prev.map(b => {
      if (b.id !== boneId) return b
      return { ...b, [end]: { ...b[end], ...update } }
    }))
  }

  // ─── Save & validate ───────────────────────────────────────────────

  async function handleSave() {
    if (!animation.mesh) return
    setSaving(true)
    const updatedMesh = { ...animation.mesh, bones, bonesValidated: false, boneWeights: null, videoFramesMesh: null }
    const updatedAnims = project.animations.map(a =>
      a.id === animation.id ? { ...a, mesh: updatedMesh } : a
    )
    await onSave({ ...project, animations: updatedAnims })
    setSaving(false)
  }

  const [validateStatus, setValidateStatus] = useState('')

  async function handleValidate() {
    if (!animation.mesh || !restGeo || bones.length === 0) {
      setValidateStatus('Prérequis manquants : mesh=' + !!animation.mesh + ', restGeo=' + !!restGeo + ', bones=' + bones.length)
      return
    }
    setSaving(true)

    try {
      setValidateStatus(`Calcul rest pose (${bones.length} bones, ${restGeo.trackedPoints.length} tracked points)...`)
      await new Promise(r => setTimeout(r, 0))
      const restPose = computeBoneRestPose(bones, restGeo.trackedPoints)
      console.log('[BoneEditor] Rest pose computed:', Object.fromEntries(restPose))

      setValidateStatus(`Calcul auto-weights (${restGeo.allPoints.length} vertices × ${bones.length} bones)...`)
      await new Promise(r => setTimeout(r, 0))
      const weights = computeAutoWeights(restGeo.allPoints, bones, restPose)
      console.log('[BoneEditor] Weights computed:', weights.length, 'vertices')

      // Log weight stats
      const nonZeroCounts = weights.map(w => w.filter(v => v > 0).length)
      const avgInfluences = nonZeroCounts.reduce((a, b) => a + b, 0) / nonZeroCounts.length
      console.log('[BoneEditor] Avg bone influences per vertex:', avgInfluences.toFixed(1))

      setValidateStatus('Sauvegarde...')
      await new Promise(r => setTimeout(r, 0))

      const updatedMesh = {
        ...animation.mesh,
        bones,
        boneWeights: weights,
        bonesValidated: true,
        videoFramesMesh: null,
      }
      const updatedAnims = project.animations.map(a =>
        a.id === animation.id ? { ...a, mesh: updatedMesh } : a
      )
      await onSave(
        { ...project, animations: updatedAnims },
        [{ animationId: animation.id, field: 'boneWeights' as const }],
      )
      setValidateStatus(`Validé : ${weights.length} vertices, ${bones.length} bones, ~${avgInfluences.toFixed(1)} influences/vertex`)
    } catch (err) {
      console.error('[BoneEditor] Validation failed:', err)
      setValidateStatus('Erreur : ' + (err instanceof Error ? err.message : String(err)))
    }
    setSaving(false)
  }

  // ─── Weight visualization ──────────────────────────────────────────

  const [showWeights, setShowWeights] = useState(false)

  // ─── Render ────────────────────────────────────────────────────────

  if (!restGeo) {
    return (
      <div className="step-container">
        <p style={{ color: 'var(--color-text-muted)' }}>
          La rest animation doit avoir une triangulation calculée (topologie verrouillée) pour définir les bones.
        </p>
      </div>
    )
  }

  const trackedCount = restGeo.trackedPoints.length

  return (
    <div className="step-container" style={{ display: 'flex', gap: 'var(--space-4)', minHeight: 500 }}>
      {/* Canvas */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', cursor: editMode !== 'select' ? 'crosshair' : 'default' }}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={handleCanvasMouseUp}
          onClick={handleCanvasClick}
          onContextMenu={handleContextMenu}
        />
        {/* Toolbar */}
        <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 }}>
          <button
            className={`btn-sm ${editMode === 'select' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setEditMode('select'); setPendingHead(null) }}
          >
            Sélectionner
          </button>
          <button
            className={`btn-sm ${editMode.startsWith('add') ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setEditMode('add-head'); setPendingHead(null); setSelectedBoneId(null) }}
          >
            + Ajouter bone
          </button>
        </div>
        {editMode === 'add-head' && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(0,0,0,0.7)', padding: '4px 8px', borderRadius: 4, fontSize: 12 }}>
            Cliquez pour placer la <strong>tête</strong> du bone
          </div>
        )}
        {editMode === 'add-tail' && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(0,0,0,0.7)', padding: '4px 8px', borderRadius: 4, fontSize: 12 }}>
            Cliquez pour placer la <strong>queue</strong> du bone — clic droit pour annuler
          </div>
        )}
        {editMode === 'place-elbow' && (
          <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(0,0,0,0.7)', padding: '4px 8px', borderRadius: 4, fontSize: 12, borderLeft: '3px solid #fbbf24' }}>
            Cliquez pour placer le <strong>coude</strong> sur le bone
          </div>
        )}
      </div>

      {/* Properties panel */}
      <div style={{ width: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          Bones ({bones.length})
        </h3>

        {/* Bone list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {bones.map((bone, i) => (
            <div
              key={bone.id}
              onClick={() => { setSelectedBoneId(bone.id); setEditMode('select') }}
              style={{
                padding: '4px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background: bone.id === selectedBoneId ? 'rgba(255,255,255,0.1)' : 'transparent',
                borderLeft: `3px solid ${getBoneColor(i)}`,
                fontSize: 'var(--text-sm)',
              }}
            >
              {bone.name}
            </div>
          ))}
        </div>

        {/* Selected bone properties */}
        {selectedBone && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 'var(--space-2)' }}>
            <label style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Nom</label>
            <input
              className="input"
              value={selectedBone.name}
              onChange={e => updateBone(selectedBone.id, { name: e.target.value })}
              style={{ fontSize: 'var(--text-sm)' }}
            />

            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)', marginTop: 'var(--space-1)' }}>
              <input
                type="checkbox"
                checked={selectedBone.fixedLength}
                onChange={e => updateBone(selectedBone.id, { fixedLength: e.target.checked })}
              />
              Longueur constante
            </label>

            {/* Elbow */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 'var(--space-1)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
                <input
                  type="checkbox"
                  checked={selectedBone.elbowPos != null}
                  onChange={e => {
                    if (e.target.checked) {
                      // Enter elbow placement mode
                      setEditMode('place-elbow')
                    } else {
                      // Remove elbow
                      updateBone(selectedBone.id, { elbowPos: null })
                    }
                  }}
                />
                Coude (pli)
              </label>
              {selectedBone.elbowPos && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div>
                    Position : ({selectedBone.elbowPos.x.toFixed(0)}, {selectedBone.elbowPos.y.toFixed(0)})
                    <button
                      className="btn-sm btn-ghost"
                      style={{ marginLeft: 8, fontSize: 'var(--text-xs)' }}
                      onClick={() => setEditMode('place-elbow')}
                    >
                      Repositionner
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <label>Mode :</label>
                    <select
                      className="input"
                      value={selectedBone.elbowMode ?? 'rest'}
                      onChange={e => updateBone(selectedBone.id, { elbowMode: e.target.value as 'rest' | 'centroid' | 'continuity' })}
                      style={{ fontSize: 'var(--text-xs)', flex: 1 }}
                    >
                      <option value="rest">Fixe (placement)</option>
                      <option value="centroid">Centroïde (intérieur)</option>
                      <option value="continuity">Continuité (frame préc.)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            {/* Head endpoint */}
            <fieldset style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: 'var(--space-2)' }}>
              <legend style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Tête (head)</legend>
              <EndpointEditor
                ref_={selectedBone.head}
                trackedCount={trackedCount}
                onChange={(update) => updateEndpoint(selectedBone.id, 'head', update)}
              />
            </fieldset>

            {/* Tail endpoint */}
            <fieldset style={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: 'var(--space-2)' }}>
              <legend style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>Queue (tail)</legend>
              <EndpointEditor
                ref_={selectedBone.tail}
                trackedCount={trackedCount}
                onChange={(update) => updateEndpoint(selectedBone.id, 'tail', update)}
              />
            </fieldset>

            <button
              className="btn-sm btn-danger"
              onClick={() => {
                setBones(prev => prev.filter(b => b.id !== selectedBone.id))
                setSelectedBoneId(null)
              }}
            >
              Supprimer ce bone
            </button>
          </div>
        )}

        {/* Actions */}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 'var(--space-3)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-sm)' }}>
            <input type="checkbox" checked={showWeights} onChange={e => setShowWeights(e.target.checked)} />
            Visualiser les poids
          </label>

          <button className="btn-secondary" onClick={handleSave} disabled={saving}>
            {saving ? 'Sauvegarde...' : 'Sauvegarder les bones'}
          </button>
          <button
            className="btn-primary"
            onClick={handleValidate}
            disabled={saving || bones.length === 0}
          >
            {saving ? 'Calcul en cours...' : 'Valider et calculer les poids'}
          </button>
          {validateStatus && (
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', fontFamily: 'monospace' }}>
              {validateStatus}
            </span>
          )}
          {animation.mesh?.bonesValidated && !saving && (
            <span style={{ color: 'var(--color-type-rest)', fontSize: 'var(--text-xs)' }}>
              &#10003; Bones validés ({animation.mesh.boneWeights?.length ?? 0} vertices, {bones.length} bones)
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Endpoint editor sub-component ────────────────────────────────────

function EndpointEditor({
  ref_,
  trackedCount,
  onChange,
}: {
  ref_: BoneEndpointRef
  trackedCount: number
  onChange: (update: Partial<BoneEndpointRef>) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-xs)' }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <label style={{ width: 70 }}>Anchor A</label>
        <select
          className="input"
          value={ref_.anchorIndexA}
          onChange={e => onChange({ anchorIndexA: Number(e.target.value) })}
          style={{ flex: 1, fontSize: 'var(--text-xs)' }}
        >
          {Array.from({ length: trackedCount }, (_, i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <label style={{ width: 70 }}>Anchor B</label>
        <select
          className="input"
          value={ref_.anchorIndexB}
          onChange={e => onChange({ anchorIndexB: Number(e.target.value) })}
          style={{ flex: 1, fontSize: 'var(--text-xs)' }}
        >
          {Array.from({ length: trackedCount }, (_, i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <label style={{ width: 70 }}>localX</label>
        <input
          className="input"
          type="number"
          step={0.05}
          value={ref_.localX}
          onChange={e => onChange({ localX: Number(e.target.value) })}
          style={{ flex: 1, fontSize: 'var(--text-xs)' }}
        />
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <label style={{ width: 70 }}>localY</label>
        <input
          className="input"
          type="number"
          step={0.05}
          value={ref_.localY}
          onChange={e => onChange({ localY: Number(e.target.value) })}
          style={{ flex: 1, fontSize: 'var(--text-xs)' }}
        />
      </div>
    </div>
  )
}
