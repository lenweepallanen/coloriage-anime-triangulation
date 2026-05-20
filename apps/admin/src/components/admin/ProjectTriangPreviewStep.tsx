/**
 * Étape 5 (Triangulation Projet) — Preview du rendu final.
 *
 * Affiche l'image originale du coloriage avec, par zone :
 *   - 1px d'érosion (constant, pour gommer les résidus blancs aux bords
 *     de triangulation imprécise) ;
 *   - un contour noir d'épaisseur configurable (slider global + sliders par zone).
 *
 * Toggle "Inpainting" : si activé, applique LaMa (zones pattes dilatées) en
 * sous-couche pour montrer le scan "sans pattes" qui sert aux faces cachées.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, ProjectTriangulation } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { computeZoneOutlinePolylines, getZoneOutlineWidth, getZoneOutlineSmoothing, getZoneOutlineColor, getZoneOutlineInflate, hasZoneOutlineData } from '../../utils/zoneOutlines'
import { requestLamaInpainting } from '../../utils/lamaInpainting'

interface Props {
  project: Project
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

const MAX_OUTLINE = 20

export default function ProjectTriangPreviewStep({ project, onSave }: Props) {
  const tri = project.projectTriangulation
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const [globalWidth, setGlobalWidthState] = useState<number>(tri?.outlineWidthGlobal ?? 2)
  const [perZone, setPerZone] = useState<Record<string, number>>(() => ({ ...(tri?.outlineWidthByZone ?? {}) }))
  // Bouger le slider global remet tous les sliders par-zone à leur défaut (=global)
  // → effet "tous les sliders bougent ensemble".
  const setGlobalWidth = useCallback((v: number) => {
    setGlobalWidthState(v)
    setPerZone({})
  }, [])
  const [smoothing, setSmoothing] = useState<number>(tri?.outlineSmoothing ?? 0)
  const [perZoneSmooth, setPerZoneSmooth] = useState<Record<string, number>>(() => ({ ...(tri?.outlineSmoothingByZone ?? {}) }))
  const [perZoneColor, setPerZoneColor] = useState<Record<string, string>>(() => ({ ...(tri?.outlineColorByZone ?? {}) }))
  const [inflate, setInflateState] = useState<number>(tri?.outlineInflateGlobal ?? 0)
  const [perZoneInflate, setPerZoneInflate] = useState<Record<string, number>>(() => ({ ...(tri?.outlineInflateByZone ?? {}) }))
  const setInflate = useCallback((v: number) => { setInflateState(v); setPerZoneInflate({}) }, [])
  const [inpaintEnabled, setInpaintEnabled] = useState<boolean>(tri?.previewInpaintingEnabled ?? false)
  const [inpaintBlob, setInpaintBlob] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Charge image source (originale ou inpaintée) — un seul effect pour
  // créer l'URL, attendre le load, puis revoke au cleanup (StrictMode-safe).
  const sourceBlob = inpaintEnabled && inpaintBlob ? inpaintBlob : project.originalImageBlob
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!sourceBlob) { setImg(null); return }
    const url = URL.createObjectURL(sourceBlob)
    const el = new Image()
    let cancelled = false
    el.onload = () => { if (!cancelled) setImg(el) }
    el.onerror = () => { if (!cancelled) setImg(null) }
    el.src = url
    return () => {
      cancelled = true
      URL.revokeObjectURL(url)
    }
  }, [sourceBlob])

  // Patch le tri avec les valeurs locales pour rendre live (sans toucher au state Firestore)
  const triPreview: ProjectTriangulation | null = useMemo(() => {
    if (!tri) return null
    return { ...tri, outlineWidthGlobal: globalWidth, outlineWidthByZone: perZone, outlineSmoothing: smoothing, outlineSmoothingByZone: perZoneSmooth, outlineColorByZone: perZoneColor, outlineInflateGlobal: inflate, outlineInflateByZone: perZoneInflate }
  }, [tri, globalWidth, perZone, smoothing, perZoneSmooth, perZoneColor, inflate, perZoneInflate])

  // Pré-rendu de l'image + outlines à pleine résolution sur un canvas offscreen.
  // Mémoïsé sur (img, triPreview) — recalculé seulement si l'image ou les
  // paramètres d'outline changent.
  const renderedCanvas = useMemo(() => {
    if (!img || !triPreview) return null
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0)
    // Outline en overlay : polyligne tracée par-dessus l'image, pas bakée
    // dans la texture. Cohérent avec preview animation et scan.
    const polylines = computeZoneOutlinePolylines(
      triPreview,
      { body: triPreview.bodyPoints, limbs: triPreview.zonePoints },
      (p) => ({ x: p.x, y: p.y }),
    )
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    for (const pl of polylines) {
      if (pl.points.length < 3) continue
      ctx.strokeStyle = pl.color
      ctx.lineWidth = pl.width
      ctx.beginPath()
      ctx.moveTo(pl.points[0].x, pl.points[0].y)
      for (let i = 1; i < pl.points.length; i++) ctx.lineTo(pl.points[i].x, pl.points[i].y)
      ctx.closePath()
      ctx.stroke()
    }
    return c
  }, [img, triPreview])

  // Affichage : draw du canvas pré-rendu, scalé fit-to-container avec letterboxing.
  // Redessine au resize via ResizeObserver.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !renderedCanvas) return
    const draw = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const srcW = renderedCanvas.width
      const srcH = renderedCanvas.height
      const aspect = srcW / srcH
      const cw = canvas.width, ch = canvas.height
      let dw = cw, dh = cw / aspect
      if (dh > ch) { dh = ch; dw = ch * aspect }
      const dx = (cw - dw) / 2
      const dy = (ch - dh) / 2
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(renderedCanvas, 0, 0, srcW, srcH, dx, dy, dw, dh)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [renderedCanvas])

  // Génère le scan inpainté (LaMa)
  const runInpainting = useCallback(async () => {
    if (!project.originalImageBlob || !tri) return
    setBusy(true)
    setError(null)
    try {
      const url = URL.createObjectURL(project.originalImageBlob)
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el); el.onerror = reject; el.src = url
      })
      URL.revokeObjectURL(url)
      const W = image.naturalWidth, H = image.naturalHeight
      const baseCanvas = document.createElement('canvas')
      baseCanvas.width = W; baseCanvas.height = H
      baseCanvas.getContext('2d')!.drawImage(image, 0, 0)

      // Masque des zones membres (pattes/têtes), tout sauf 'body'.
      // generateLimbsMask attend WalkLimbSeparation; on n'a pas ça ici directement.
      // Solution simple : rasteriser les contours des zones non-body sur un masque.
      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = W; maskCanvas.height = H
      const mctx = maskCanvas.getContext('2d')!
      mctx.fillStyle = '#000'
      mctx.fillRect(0, 0, W, H)
      mctx.fillStyle = '#fff'
      for (const z of tri.zones) {
        if (z.id === 'body') continue
        const pts = tri.zonePoints?.[z.id]
        const len = tri.zoneContourLength?.[z.id] ?? pts?.length ?? 0
        if (!pts || len < 3) continue
        mctx.beginPath()
        for (let i = 0; i < len; i++) {
          const p = pts[i]
          if (i === 0) mctx.moveTo(p.x, p.y); else mctx.lineTo(p.x, p.y)
        }
        mctx.closePath()
        mctx.fill()
      }
      const inpaintedCanvas = await requestLamaInpainting(baseCanvas, maskCanvas)
      const inpainted = await new Promise<Blob>(r => inpaintedCanvas.toBlob(b => r(b!), 'image/png')!)
      setInpaintBlob(inpainted)
      setInpaintEnabled(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [project.originalImageBlob, tri])

  const saveSettings = useCallback(async () => {
    if (!tri) return
    setSaving(true)
    try {
      const newTri: ProjectTriangulation = {
        ...tri,
        outlineWidthGlobal: globalWidth,
        outlineWidthByZone: { ...perZone },
        outlineSmoothing: smoothing,
        outlineSmoothingByZone: { ...perZoneSmooth },
        outlineColorByZone: { ...perZoneColor },
        outlineInflateGlobal: inflate,
        outlineInflateByZone: { ...perZoneInflate },
        previewInpaintingEnabled: inpaintEnabled,
      }
      await onSave({ ...project, projectTriangulation: newTri })
    } finally {
      setSaving(false)
    }
  }, [tri, project, onSave, globalWidth, perZone, smoothing, perZoneSmooth, perZoneColor, inflate, perZoneInflate, inpaintEnabled])

  if (!tri) {
    return <div className="step-section"><p>Aucune triangulation projet.</p></div>
  }
  if (!project.originalImageBlob) {
    return <div className="step-section"><p>Importez d'abord l'image du coloriage (section Import).</p></div>
  }
  if (!hasZoneOutlineData(tri)) {
    return <div className="step-section"><p>Aucun contour de zone disponible. Validez l'étape "Maillage par zone".</p></div>
  }

  const zones = tri.zones ?? []

  return (
    <div className="step-section" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* Canvas preview */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3 style={{ marginTop: 0 }}>Preview rendu final</h3>
        <p style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12 }}>
          Chaque zone est érodée de 1px puis bordée d'un trait noir d'épaisseur configurable.
        </p>
        <div style={{ border: '1px solid #334155', borderRadius: 8, overflow: 'hidden', background: '#fff', flex: 1, minHeight: 500, height: '70vh' }}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
        </div>
      </div>

      {/* Panneau de contrôle */}
      <div style={{ width: 280, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ padding: 12, background: '#1e293b', borderRadius: 8 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
            Inpainting LaMa
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={inpaintEnabled}
              onChange={e => setInpaintEnabled(e.target.checked)}
              disabled={!inpaintBlob}
              id="inpaint-toggle"
            />
            <label htmlFor="inpaint-toggle" style={{ fontSize: 12 }}>
              Afficher version inpaintée
            </label>
          </div>
          <button
            className="btn-secondary btn-sm"
            onClick={runInpainting}
            disabled={busy}
            style={{ width: '100%' }}
          >
            {busy ? 'Calcul...' : inpaintBlob ? 'Régénérer inpainting' : 'Générer inpainting'}
          </button>
          {error && <p style={{ color: '#ef4444', fontSize: 12, marginTop: 6 }}>{error}</p>}
        </div>

        <div style={{ padding: 12, background: '#1e293b', borderRadius: 8 }}>
          <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>
            Contour global : <strong>{globalWidth}px</strong>
          </label>
          <input
            type="range"
            min={0}
            max={MAX_OUTLINE}
            step={1}
            value={globalWidth}
            onChange={e => setGlobalWidth(parseInt(e.target.value, 10))}
            style={{ width: '100%' }}
          />
          <label style={{ display: 'block', fontSize: 13, marginTop: 10, marginBottom: 6 }}>
            Lissage : <strong>{smoothing}</strong>
          </label>
          <input
            type="range" min={0} max={5} step={1} value={smoothing}
            onChange={e => setSmoothing(parseInt(e.target.value, 10))}
            style={{ width: '100%' }}
          />
          <label style={{ display: 'block', fontSize: 13, marginTop: 10, marginBottom: 6 }}>
            Inflate / Deflate : <strong>{inflate > 0 ? '+' : ''}{inflate}px</strong>
          </label>
          <input
            type="range" min={-30} max={30} step={1} value={inflate}
            onChange={e => setInflate(parseInt(e.target.value, 10))}
            style={{ width: '100%' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#94a3b8' }}>
            <span>− intérieur</span>
            <span>0 bord</span>
            <span>+ extérieur</span>
          </div>
        </div>

        <div style={{ padding: 12, background: '#1e293b', borderRadius: 8 }}>
          <div style={{ fontSize: 13, marginBottom: 8, fontWeight: 600 }}>Par zone</div>
          {zones.map(z => {
            const widthVal = perZone[z.id] ?? getZoneOutlineWidth({ ...tri, outlineWidthGlobal: globalWidth, outlineWidthByZone: perZone }, z.id)
            const widthOverridden = perZone[z.id] !== undefined
            const smoothVal = perZoneSmooth[z.id] ?? getZoneOutlineSmoothing({ ...tri, outlineSmoothing: smoothing, outlineSmoothingByZone: perZoneSmooth }, z.id)
            const smoothOverridden = perZoneSmooth[z.id] !== undefined
            const colorVal = perZoneColor[z.id] ?? getZoneOutlineColor({ ...tri, outlineColorByZone: perZoneColor }, z.id)
            const colorOverridden = perZoneColor[z.id] !== undefined
            const inflateVal = perZoneInflate[z.id] ?? getZoneOutlineInflate({ ...tri, outlineInflateGlobal: inflate, outlineInflateByZone: perZoneInflate }, z.id)
            const inflateOverridden = perZoneInflate[z.id] !== undefined
            return (
              <div key={z.id} style={{ marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid #334155' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, background: z.color, borderRadius: 2, display: 'inline-block' }} />
                    <strong>{z.label}</strong>
                  </span>
                </div>
                {/* Épaisseur */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8' }}>
                  <span>Épaisseur</span>
                  <span style={{ color: widthOverridden ? '#22c55e' : '#94a3b8' }}>{widthVal}px</span>
                </div>
                <input
                  type="range" min={0} max={MAX_OUTLINE} step={1} value={widthVal}
                  onChange={e => setPerZone(prev => ({ ...prev, [z.id]: parseInt(e.target.value, 10) }))}
                  style={{ width: '100%' }}
                />
                {/* Lissage */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                  <span>Lissage</span>
                  <span style={{ color: smoothOverridden ? '#22c55e' : '#94a3b8' }}>{smoothVal}</span>
                </div>
                <input
                  type="range" min={0} max={5} step={1} value={smoothVal}
                  onChange={e => setPerZoneSmooth(prev => ({ ...prev, [z.id]: parseInt(e.target.value, 10) }))}
                  style={{ width: '100%' }}
                />
                {/* Inflate/Deflate */}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
                  <span>Inflate</span>
                  <span style={{ color: inflateOverridden ? '#22c55e' : '#94a3b8' }}>{inflateVal > 0 ? '+' : ''}{inflateVal}px</span>
                </div>
                <input
                  type="range" min={-30} max={30} step={1} value={inflateVal}
                  onChange={e => setPerZoneInflate(prev => ({ ...prev, [z.id]: parseInt(e.target.value, 10) }))}
                  style={{ width: '100%' }}
                />
                {/* Couleur trait */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                  <span>Couleur</span>
                  <input
                    type="color"
                    value={colorVal}
                    onChange={e => setPerZoneColor(prev => ({ ...prev, [z.id]: e.target.value }))}
                    style={{ width: 40, height: 22, padding: 0, border: '1px solid #334155', background: 'transparent', cursor: 'pointer' }}
                  />
                </div>
                {(widthOverridden || smoothOverridden || colorOverridden || inflateOverridden) && (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      setPerZone(prev => { const n = { ...prev }; delete n[z.id]; return n })
                      setPerZoneSmooth(prev => { const n = { ...prev }; delete n[z.id]; return n })
                      setPerZoneColor(prev => { const n = { ...prev }; delete n[z.id]; return n })
                      setPerZoneInflate(prev => { const n = { ...prev }; delete n[z.id]; return n })
                    }}
                    style={{ fontSize: 11, padding: '2px 6px', marginTop: 4 }}
                  >
                    Reset (= défaut)
                  </button>
                )}
              </div>
            )
          })}
        </div>

        <button className="btn-primary" onClick={saveSettings} disabled={saving}>
          {saving ? 'Sauvegarde...' : 'Sauvegarder paramètres'}
        </button>
      </div>
    </div>
  )
}
