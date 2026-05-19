import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'

const TARGET_SIZE = 2000

async function processImage(img: HTMLImageElement, thr: number, ss: number): Promise<Blob> {
  const hiSize = TARGET_SIZE * ss
  const hi = document.createElement('canvas')
  hi.width = hiSize
  hi.height = hiSize
  const hctx = hi.getContext('2d')!
  hctx.imageSmoothingEnabled = true
  hctx.imageSmoothingQuality = 'high'
  hctx.fillStyle = '#fff'
  hctx.fillRect(0, 0, hiSize, hiSize)
  hctx.drawImage(img, 0, 0, hiSize, hiSize)

  const imageData = hctx.getImageData(0, 0, hiSize, hiSize)
  const data = imageData.data
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    const v = lum < thr ? 0 : 255
    data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
  }
  hctx.putImageData(imageData, 0, 0)

  const out = document.createElement('canvas')
  out.width = TARGET_SIZE
  out.height = TARGET_SIZE
  const octx = out.getContext('2d')!
  octx.imageSmoothingEnabled = true
  octx.imageSmoothingQuality = 'high'
  octx.fillStyle = '#fff'
  octx.fillRect(0, 0, TARGET_SIZE, TARGET_SIZE)
  octx.drawImage(hi, 0, 0, TARGET_SIZE, TARGET_SIZE)

  return await new Promise<Blob>(r => out.toBlob(b => r(b!), 'image/jpeg', 0.95))
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

function outName(srcName: string) {
  const base = srcName.replace(/\.[^.]+$/, '') || 'coloriage'
  return `${base}-nb-2000.jpg`
}

export default function ColoriageBwPage() {
  const [files, setFiles] = useState<File[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(100)
  const [supersample, setSupersample] = useState(2)
  const [processing, setProcessing] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  const firstImgRef = useRef<HTMLImageElement | null>(null)

  async function handleSelect(list: FileList | null) {
    const arr = Array.from(list ?? [])
    setFiles(arr)
    if (arr.length > 0) {
      const img = await loadImage(arr[0])
      firstImgRef.current = img
      await runPreview(threshold, supersample, img)
    } else {
      firstImgRef.current = null
      setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    }
  }

  async function runPreview(thr: number, ss: number, img: HTMLImageElement | null = firstImgRef.current) {
    if (!img) return
    setProcessing(true)
    try {
      const blob = await processImage(img, thr, ss)
      const url = URL.createObjectURL(blob)
      setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url })
    } finally {
      setProcessing(false)
    }
  }

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }
  }, [previewUrl])

  async function handleRunBatch() {
    if (files.length === 0) return
    setBatchProgress({ done: 0, total: files.length })
    const zip = new JSZip()
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        try {
          const img = await loadImage(file)
          const blob = await processImage(img, threshold, supersample)
          zip.file(outName(file.name), blob)
        } catch (err) {
          console.error('Batch error on', file.name, err)
        }
        setBatchProgress({ done: i + 1, total: files.length })
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' }, meta => {
        setBatchProgress({ done: files.length, total: files.length, ...({} as any) })
        void meta
      })
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
      triggerDownload(zipBlob, `coloriages-nb-2000-${ts}.zip`)
    } finally {
      setTimeout(() => setBatchProgress(null), 1500)
    }
  }

  return (
    <div style={{ padding: 'var(--space-6)', maxWidth: 1200, margin: '0 auto' }}>
      <h1>Couleur → Noir & Blanc (upscale 2000×2000)</h1>
      <p style={{ color: '#9aa3b2' }}>
        Sélectionnez un ou plusieurs JPG. Le premier fichier sert d'aperçu pour régler le seuil et l'anti-aliasing.
        À la validation, les mêmes paramètres sont appliqués à tout le lot et exportés dans un .zip.
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
            : `${files.length} fichier${files.length > 1 ? 's' : ''} — aperçu : ${files[0].name}`}
        </span>
      </div>

      {firstImgRef.current && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', margin: 'var(--space-3) 0', maxWidth: 600 }}>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 160 }}>Seuil noir : {threshold}</label>
            <input
              type="range"
              min={20}
              max={200}
              value={threshold}
              onChange={e => setThreshold(Number(e.target.value))}
              onMouseUp={() => runPreview(threshold, supersample)}
              onTouchEnd={() => runPreview(threshold, supersample)}
              style={{ flex: 1 }}
            />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 160 }}>Anti-aliasing : ×{supersample}</label>
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={supersample}
              onChange={e => setSupersample(Number(e.target.value))}
              onMouseUp={() => runPreview(threshold, supersample)}
              onTouchEnd={() => runPreview(threshold, supersample)}
              style={{ flex: 1 }}
            />
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

      {processing && <p>Aperçu en cours…</p>}

      {previewUrl && (
        <div style={{ marginTop: 'var(--space-4)', border: '1px solid #2d3340', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
          <img src={previewUrl} alt="Aperçu N&B" style={{ display: 'block', width: '100%', height: 'auto' }} />
        </div>
      )}
    </div>
  )
}
