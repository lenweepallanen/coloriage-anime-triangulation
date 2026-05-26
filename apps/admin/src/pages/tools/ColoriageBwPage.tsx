import { useEffect, useState } from 'react'
import JSZip from 'jszip'
// @ts-expect-error no types
import { traceCanvas, getSVG } from 'potrace-js/src/index.js'

const TARGET_SIZE = 2000
const TRACE_SIZE = 1000

type Params = {
  threshold: number
  turdSize: number
  alphaMax: number
  optTolerance: number
}

function thresholdToCanvas(img: HTMLImageElement, thr: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = TRACE_SIZE
  c.height = TRACE_SIZE
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, TRACE_SIZE, TRACE_SIZE)
  ctx.drawImage(img, 0, 0, TRACE_SIZE, TRACE_SIZE)
  const imageData = ctx.getImageData(0, 0, TRACE_SIZE, TRACE_SIZE)
  const data = imageData.data
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    const v = lum < thr ? 0 : 255
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  return c
}

async function vectorize(img: HTMLImageElement, p: Params): Promise<string> {
  const canvas = thresholdToCanvas(img, p.threshold)
  const pathList = traceCanvas(canvas, {
    turnpolicy: 'minority',
    turdsize: p.turdSize,
    optcurve: true,
    alphamax: p.alphaMax,
    opttolerance: p.optTolerance,
  })
  const rawSvg: string = getSVG(pathList, 1)
  return rawSvg.replace(
    /<svg[^>]*>/,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TRACE_SIZE} ${TRACE_SIZE}" width="${TRACE_SIZE}" height="${TRACE_SIZE}">`
  )
}

async function rasterizeSvg(svg: string, size: number): Promise<Blob> {
  const blob = new Blob([svg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(img, 0, 0, size, size)
    return await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png')!)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function composeColorWithVector(colorImg: HTMLImageElement, svg: string, size: number): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(colorImg, 0, 0, size, size)

  const transparentSvg = svg.replace(/fill="#?[fF]{3,6}"/g, 'fill="none"')
  const blob = new Blob([transparentSvg], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  try {
    const overlay = new Image()
    overlay.src = url
    await overlay.decode()
    ctx.drawImage(overlay, 0, 0, size, size)
  } finally {
    URL.revokeObjectURL(url)
  }
  return await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png')!)
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function baseName(srcName: string) {
  return srcName.replace(/\.[^.]+$/, '') || 'coloriage'
}

export default function ColoriageBwPage() {
  const [files, setFiles] = useState<File[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(100)
  const [turdSize, setTurdSize] = useState(4)
  const [alphaMax, setAlphaMax] = useState(1)
  const [optTolerance, setOptTolerance] = useState(0.2)
  const [processing, setProcessing] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const [currentImg, setCurrentImg] = useState<HTMLImageElement | null>(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  async function handleSelect(list: FileList | null) {
    const arr = Array.from(list ?? [])
    setFiles(arr)
    setCurrentIndex(0)
    setErrorMsg(null)
    if (arr.length > 0) {
      await loadAtIndex(arr, 0)
    } else {
      setCurrentImg(null)
      setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    }
  }

  async function loadAtIndex(arr: File[], idx: number) {
    try {
      const img = await loadImage(arr[idx])
      setCurrentImg(img)
      await runPreview({ threshold, turdSize, alphaMax, optTolerance }, img)
    } catch (e) {
      console.error(e)
      setErrorMsg(`Erreur chargement : ${(e as Error).message}`)
    }
  }

  async function goToIndex(idx: number) {
    if (files.length === 0) return
    const clamped = (idx + files.length) % files.length
    setCurrentIndex(clamped)
    await loadAtIndex(files, clamped)
  }

  async function runPreview(p: Params, img: HTMLImageElement | null = currentImg) {
    if (!img) return
    setProcessing(true)
    setErrorMsg(null)
    try {
      const svg = await vectorize(img, p)
      const blob = new Blob([svg], { type: 'image/svg+xml' })
      const url = URL.createObjectURL(blob)
      setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url })
    } catch (e) {
      console.error(e)
      setErrorMsg(`Erreur vectorisation : ${(e as Error).message}`)
    } finally {
      setProcessing(false)
    }
  }

  function reRunPreview() {
    void runPreview({ threshold, turdSize, alphaMax, optTolerance })
  }

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }, [previewUrl])

  async function handleRunBatch() {
    if (files.length === 0) return
    setBatchProgress({ done: 0, total: files.length })
    const zip = new JSZip()
    const params = { threshold, turdSize, alphaMax, optTolerance }
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          const img = await loadImage(file)
          const svg = await vectorize(img, params)
          const png = await rasterizeSvg(svg, TARGET_SIZE)
          const colorPng = await composeColorWithVector(img, svg, TARGET_SIZE)
          const name = baseName(file.name)
          zip.file(`${name}-nb.svg`, svg)
          zip.file(`${name}-nb-2000.png`, png)
          zip.file(`${name}-couleur-2000.png`, colorPng)
        } catch (err) {
          console.error('Batch error on', file.name, err)
        }
        setBatchProgress({ done: i + 1, total: files.length })
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      triggerDownload(zipBlob, `coloriages-nb-vector-${ts}.zip`)
    } finally {
      setTimeout(() => setBatchProgress(null), 1500)
    }
  }

  return (
    <div style={{ padding: 'var(--space-6)', maxWidth: 1200, margin: '0 auto' }}>
      <h1>Couleur → Noir & Blanc (vectorisé, SVG + PNG 2000×2000)</h1>
      <p style={{ color: '#9aa3b2' }}>
        Sélectionnez un ou plusieurs JPG. Le premier fichier sert d'aperçu pour régler le seuil et les paramètres de vectorisation (Potrace).
        À la validation, le lot est exporté en .zip contenant pour chaque image un .svg vectoriel et un .png 2000×2000 rastérisé depuis le SVG.
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', margin: 'var(--space-4) 0', flexWrap: 'wrap' }}>
        <input
          type="file"
          accept="image/jpeg,image/jpg,image/png"
          multiple
          onChange={e => handleSelect(e.target.files)}
        />
        <span style={{ color: '#9aa3b2' }}>
          {files.length === 0
            ? 'Aucun fichier'
            : `${files.length} fichier${files.length > 1 ? 's' : ''} — aperçu : ${files[currentIndex]?.name}`}
        </span>
        {files.length > 1 && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <button className="btn-secondary btn-sm" onClick={() => goToIndex(currentIndex - 1)} disabled={processing}>← Précédent</button>
            <span style={{ color: '#9aa3b2' }}>{currentIndex + 1} / {files.length}</span>
            <button className="btn-secondary btn-sm" onClick={() => goToIndex(currentIndex + 1)} disabled={processing}>Suivant →</button>
          </div>
        )}
      </div>

      {currentImg && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', margin: 'var(--space-3) 0', maxWidth: 600 }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 180 }}>Seuil noir : {threshold}</label>
            <input type="range" min={20} max={200} value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              onMouseUp={reRunPreview} onTouchEnd={reRunPreview}
              style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 180 }}>Filtre taches (turdSize) : {turdSize}</label>
            <input type="range" min={0} max={50} value={turdSize}
              onChange={e => setTurdSize(Number(e.target.value))}
              onMouseUp={reRunPreview} onTouchEnd={reRunPreview}
              style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 180 }}>Lissage coins (alphaMax) : {alphaMax.toFixed(2)}</label>
            <input type="range" min={0} max={1.34} step={0.01} value={alphaMax}
              onChange={e => setAlphaMax(Number(e.target.value))}
              onMouseUp={reRunPreview} onTouchEnd={reRunPreview}
              style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 180 }}>Simplification (optTolerance) : {optTolerance.toFixed(2)}</label>
            <input type="range" min={0} max={1} step={0.05} value={optTolerance}
              onChange={e => setOptTolerance(Number(e.target.value))}
              onMouseUp={reRunPreview} onTouchEnd={reRunPreview}
              style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', marginTop: 'var(--space-2)' }}>
            <button
              className="btn-primary"
              disabled={files.length === 0 || processing || batchProgress !== null}
              onClick={handleRunBatch}
            >
              {files.length > 1
                ? `Valider et exporter le lot (${files.length} fichiers, .zip)`
                : 'Valider et exporter le .zip'}
            </button>
            {batchProgress && (
              <span style={{ color: '#9aa3b2' }}>
                {batchProgress.done} / {batchProgress.total}
              </span>
            )}
          </div>
        </div>
      )}

      {processing && <p>Vectorisation en cours…</p>}
      {errorMsg && <p style={{ color: '#ff6b6b' }}>{errorMsg}</p>}

      {previewUrl && (
        <div style={{ marginTop: 'var(--space-4)', border: '1px solid #2d3340', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
          <img src={previewUrl} alt="Aperçu N&B vectorisé" style={{ display: 'block', width: '100%', height: 'auto' }} />
        </div>
      )}
    </div>
  )
}
