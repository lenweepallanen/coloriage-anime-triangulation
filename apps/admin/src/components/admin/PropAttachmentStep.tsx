import { useEffect, useRef, useState, useCallback } from 'react'
import type { Project, Prop, Point2D, PropAnchorRef } from '../../types/project'

interface Props {
  project: Project
  prop: Prop
  onSave: (next: Prop) => Promise<void>
}

const ZONE_COLORS: Record<string, string> = {
  body: '#3498db',
  'leg-fl': '#e74c3c',
  'leg-fr': '#f39c12',
  'leg-bl': '#9b59b6',
  'leg-br': '#1abc9c',
}

export default function PropAttachmentStep({ project, prop, onSave }: Props) {
  const tri = project.projectTriangulation
  const refBlob = tri?.referenceImageBlob ?? null
  const zoneAnchors = tri?.zoneAnchors ?? {}

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [hover, setHover] = useState<PropAnchorRef | null>(null)
  const [pickSlot, setPickSlot] = useState<'A' | 'B'>('A')

  useEffect(() => {
    if (!refBlob) { setImage(null); return }
    const url = URL.createObjectURL(refBlob)
    const im = new Image()
    im.onload = () => setImage(im)
    im.src = url
    return () => URL.revokeObjectURL(url)
  }, [refBlob])

  const render = useCallback(() => {
    const canvas = canvasRef.current, c = containerRef.current
    if (!canvas || !c || !image) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = c.clientWidth * dpr
    canvas.height = c.clientHeight * dpr
    canvas.style.width = `${c.clientWidth}px`
    canvas.style.height = `${c.clientHeight}px`
    const ctx = canvas.getContext('2d')!
    const s = Math.min(c.clientWidth / image.width, c.clientHeight / image.height)
    const ox = (c.clientWidth - image.width * s) / 2
    const oy = (c.clientHeight - image.height * s) / 2
    ctx.setTransform(s * dpr, 0, 0, s * dpr, ox * dpr, oy * dpr)
    ctx.clearRect(0, 0, image.width, image.height)
    ctx.drawImage(image, 0, 0)

    // Affiche le contour du prop (toutes les parties) en transparent
    prop.contourParts.forEach(part => {
      if (part.length < 3) return
      ctx.beginPath()
      ctx.moveTo(part[0].x, part[0].y)
      for (let i = 1; i < part.length; i++) ctx.lineTo(part[i].x, part[i].y)
      ctx.closePath()
      ctx.fillStyle = 'rgba(46, 204, 113, 0.2)'
      ctx.strokeStyle = '#27ae60'
      ctx.lineWidth = 1.5 / s
      ctx.fill(); ctx.stroke()
    })

    // Affiche tous les anchors par zone
    const selectedRefs = collectSelectedRefs(prop)
    for (const [zoneId, list] of Object.entries(zoneAnchors)) {
      const color = ZONE_COLORS[zoneId] ?? '#7f8c8d'
      list.forEach((p, idx) => {
        const isSel = selectedRefs.some(r => r.zoneId === zoneId && r.anchorIndex === idx)
        const isHov = hover?.zoneId === zoneId && hover.anchorIndex === idx
        const r = (isSel ? 8 : isHov ? 7 : 5) / s
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fillStyle = isSel ? '#fff' : color
        ctx.fill()
        ctx.strokeStyle = color
        ctx.lineWidth = (isSel ? 3 : 1.5) / s
        ctx.stroke()
        if (isSel) {
          ctx.fillStyle = color
          ctx.font = `bold ${14 / s}px sans-serif`
          const tag = prop.attachment.mode === 'follow-2'
            ? (sameRef(prop.attachment.refA, { zoneId, anchorIndex: idx }) ? 'A' : 'B')
            : '★'
          ctx.fillText(tag, p.x + 8 / s, p.y - 8 / s)
        }
      })
    }
  }, [image, prop, zoneAnchors, hover])

  useEffect(() => { render() }, [render])

  function screenToImage(e: React.PointerEvent): Point2D {
    const canvas = canvasRef.current!, c = containerRef.current!
    const rect = canvas.getBoundingClientRect()
    const s = Math.min(c.clientWidth / (image?.width || 1), c.clientHeight / (image?.height || 1))
    const ox = (c.clientWidth - (image?.width || 0) * s) / 2
    const oy = (c.clientHeight - (image?.height || 0) * s) / 2
    return { x: (e.clientX - rect.left - ox) / s, y: (e.clientY - rect.top - oy) / s }
  }

  function nearestAnchor(pt: Point2D, maxDistImg: number): PropAnchorRef | null {
    let best: PropAnchorRef | null = null
    let bestD = Infinity
    for (const [zoneId, list] of Object.entries(zoneAnchors)) {
      list.forEach((p, idx) => {
        const d = Math.hypot(p.x - pt.x, p.y - pt.y)
        if (d < bestD) { bestD = d; best = { zoneId, anchorIndex: idx } }
      })
    }
    return best && bestD <= maxDistImg ? best : null
  }

  function onMove(e: React.PointerEvent) {
    if (!image) return
    const pt = screenToImage(e)
    setHover(nearestAnchor(pt, 30))
  }

  async function onClick(e: React.PointerEvent) {
    if (!image) return
    const pt = screenToImage(e)
    const a = nearestAnchor(pt, 30)
    if (!a) return
    if (prop.attachment.mode === 'follow-1') {
      await onSave({ ...prop, attachment: { mode: 'follow-1', ref: a } })
    } else if (prop.attachment.mode === 'follow-2') {
      if (pickSlot === 'A') {
        await onSave({ ...prop, attachment: { ...prop.attachment, refA: a } })
        setPickSlot('B')
      } else {
        await onSave({ ...prop, attachment: { ...prop.attachment, refB: a } })
        setPickSlot('A')
      }
    }
  }

  async function setMode(mode: Prop['attachment']['mode']) {
    if (mode === 'fixed') {
      await onSave({ ...prop, attachment: { mode: 'fixed' } })
    } else if (mode === 'follow-1') {
      const existing = prop.attachment.mode === 'follow-1'
        ? prop.attachment.ref
        : { zoneId: 'body', anchorIndex: 0 }
      await onSave({ ...prop, attachment: { mode: 'follow-1', ref: existing } })
    } else {
      const refA = prop.attachment.mode === 'follow-2'
        ? prop.attachment.refA
        : { zoneId: 'body', anchorIndex: 0 }
      const refB = prop.attachment.mode === 'follow-2'
        ? prop.attachment.refB
        : { zoneId: 'body', anchorIndex: 1 }
      await onSave({ ...prop, attachment: { mode: 'follow-2', refA, refB } })
      setPickSlot('A')
    }
  }

  if (!refBlob) {
    return <div className="prop-step">Importez une image de référence dans la Triangulation projet.</div>
  }

  return (
    <div className="prop-step prop-step--attachment">
      <div className="prop-step-controls">
        <label>
          <input type="radio" checked={prop.attachment.mode === 'fixed'} onChange={() => setMode('fixed')} />
          {' '}Fixe (position absolue)
        </label>
        <label>
          <input type="radio" checked={prop.attachment.mode === 'follow-1'} onChange={() => setMode('follow-1')} />
          {' '}Suit 1 anchor
        </label>
        <label>
          <input type="radio" checked={prop.attachment.mode === 'follow-2'} onChange={() => setMode('follow-2')} />
          {' '}Suit 2 anchors
        </label>
        {prop.attachment.mode === 'follow-2' && (
          <span className="muted">
            Prochain clic : <strong>{pickSlot === 'A' ? 'A' : 'B'}</strong>
            {' '}
            <button className="btn btn-ghost btn-sm" onClick={() => setPickSlot(pickSlot === 'A' ? 'B' : 'A')}>
              Basculer
            </button>
          </span>
        )}
      </div>
      <p className="muted">
        {prop.attachment.mode === 'fixed' && 'Pas d’ancrage : l’accessoire reste à sa position absolue.'}
        {prop.attachment.mode === 'follow-1' && 'Cliquez sur un anchor pour ancrer l’accessoire.'}
        {prop.attachment.mode === 'follow-2' && 'Cliquez deux anchors successifs (A puis B). Le segment A→B donne l’orientation.'}
      </p>
      <div
        ref={containerRef}
        className="prop-canvas-container"
        style={{ position: 'relative', width: '100%', height: '60vh', minHeight: 400, background: '#fafafa', border: '1px solid var(--color-border)' }}
      >
        <canvas
          ref={canvasRef}
          style={{ display: 'block', cursor: 'crosshair' }}
          onPointerMove={onMove}
          onPointerDown={onClick}
        />
      </div>
    </div>
  )
}

function sameRef(a: PropAnchorRef, b: PropAnchorRef): boolean {
  return a.zoneId === b.zoneId && a.anchorIndex === b.anchorIndex
}

function collectSelectedRefs(prop: Prop): PropAnchorRef[] {
  switch (prop.attachment.mode) {
    case 'fixed': return []
    case 'follow-1': return [prop.attachment.ref]
    case 'follow-2': return [prop.attachment.refA, prop.attachment.refB]
  }
}
