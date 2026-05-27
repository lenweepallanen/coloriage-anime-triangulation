import { useEffect, useRef, useState } from 'react'

interface Props {
  imageUrl: string | null
  originU: number
  originV: number
  onChange: (u: number, v: number) => void
}

/**
 * Petit éditeur qui montre l'image du coloriage et un point draggable
 * représentant l'origine du personnage (0..1 normalisé). Le clic en marche
 * libre placera ce point sur la position cliquée du décor.
 */
export default function CharacterOriginEditor({ imageUrl, originU, originV, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [canvasW, setCanvasW] = useState(360)
  const [drag, setDrag] = useState(false)

  useEffect(() => {
    if (!imageUrl) { setImg(null); return }
    const i = new Image()
    i.src = imageUrl
    i.onload = () => setImg(i)
  }, [imageUrl])

  useEffect(() => {
    if (!wrapRef.current) return
    const ro = new ResizeObserver(es => {
      for (const e of es) setCanvasW(Math.max(160, Math.min(400, e.contentRect.width)))
    })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const aspect = img && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1
  const canvasH = Math.round(canvasW * aspect)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    c.width = canvasW
    c.height = canvasH
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, canvasW, canvasH)
    if (img) ctx.drawImage(img, 0, 0, canvasW, canvasH)
    const x = originU * canvasW
    const y = originV * canvasH
    // Croix
    ctx.strokeStyle = '#ff4081'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x - 14, y); ctx.lineTo(x + 14, y)
    ctx.moveTo(x, y - 14); ctx.lineTo(x, y + 14)
    ctx.stroke()
    ctx.fillStyle = drag ? '#ffeb3b' : '#ff4081'
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.stroke()
  }, [img, canvasW, canvasH, originU, originV, drag])

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const v = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    return { u, v }
  }

  if (!imageUrl) {
    return <div style={{ fontSize: 12, opacity: 0.7 }}>Importe l'image du coloriage pour définir l'origine.</div>
  }

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: canvasH, cursor: drag ? 'grabbing' : 'crosshair', borderRadius: 4, border: '1px solid #333' }}
        onPointerDown={(e) => {
          setDrag(true)
          ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
          const { u, v } = pointFromEvent(e)
          onChange(u, v)
        }}
        onPointerMove={(e) => {
          if (!drag) return
          const { u, v } = pointFromEvent(e)
          onChange(u, v)
        }}
        onPointerUp={(e) => {
          setDrag(false)
          try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId) } catch { /* */ }
        }}
        onPointerCancel={() => setDrag(false)}
      />
      <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
        Clique sur le coloriage pour placer l'origine (ex. milieu des pattes). Le clic dans la scène posera ce point sur le décor.
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12 }}>
        <span>U : {originU.toFixed(2)}</span>
        <span>V : {originV.toFixed(2)}</span>
        <button className="btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => onChange(0.5, 1.0)}>Pieds (défaut)</button>
      </div>
    </div>
  )
}
