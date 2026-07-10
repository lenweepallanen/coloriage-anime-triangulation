/**
 * Outil annexe : posterisation de vidéo (quantification de couleurs).
 *
 * Les vidéos générées par IA (Kling…) délavent les aplats : dégradés, ombres,
 * contours flous. Cet outil re-snappe chaque pixel de chaque frame sur la
 * palette de couleurs de référence (extraite de la frame 0 ou d'une image
 * source), ce qui re-stabilise les aplats pour le tracking (CoTracker,
 * contrainte couleur, Canny).
 *
 * Pipeline : extraction palette (K-means) → preview avant/après frame par frame
 * → posterisation de toutes les frames → réencodage WebM (canvas.captureStream
 * + MediaRecorder, temps réel) → téléchargement.
 */

import { useEffect, useRef, useState } from 'react'

const FPS = 24

type RGB = [number, number, number]

function colorDist2(a: RGB, b: RGB): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

function luminance(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/**
 * Palette de k couleurs : sélection maximin pondérée par fréquence + raffinement K-means.
 *
 * 1. Histogramme des couleurs quantifiées (5 bits/canal), bruit filtré.
 * 2. 1ʳᵉ couleur = la plus fréquente, puis chaque suivante = candidate la plus
 *    éloignée des couleurs déjà choisies (départage par fréquence). Garantit que
 *    monter le slider ajoute des teintes réellement distinctes (pas de fusion).
 * 3. Quelques itérations K-means pour recentrer chaque couleur sur sa masse.
 */
function kmeansPalette(img: ImageData, k: number): RGB[] {
  const total = img.width * img.height
  const step = Math.max(1, Math.floor(total / 40000))
  const pixels: RGB[] = []
  for (let i = 0; i < total; i += step) {
    const o = i * 4
    pixels.push([img.data[o], img.data[o + 1], img.data[o + 2]])
  }
  if (pixels.length === 0) return []

  // Histogramme quantifié 5 bits/canal (somme par bin pour une couleur moyenne fidèle)
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (const p of pixels) {
    const key = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3)
    const e = counts.get(key)
    if (e) { e.n++; e.r += p[0]; e.g += p[1]; e.b += p[2] }
    else counts.set(key, { n: 1, r: p[0], g: p[1], b: p[2] })
  }
  // Candidats = bins non négligeables (filtre le bruit de compression)
  const minCount = Math.max(2, Math.floor(pixels.length * 0.0005))
  const candidates = [...counts.values()]
    .filter(e => e.n >= minCount)
    .map(e => ({ color: [e.r / e.n, e.g / e.n, e.b / e.n] as RGB, n: e.n }))
  if (candidates.length === 0) return []

  // Sélection maximin : couleur la plus fréquente, puis les plus éloignées des choisies
  candidates.sort((a, b) => b.n - a.n)
  let centers: RGB[] = [candidates[0].color]
  while (centers.length < k) {
    let best: { color: RGB; score: number } | null = null
    for (const cand of candidates) {
      let minD = Infinity
      for (const c of centers) minD = Math.min(minD, colorDist2(cand.color, c))
      // Distance d'abord, fréquence en départage léger (log pour ne pas écraser la distance)
      const score = minD * (1 + Math.log10(cand.n))
      if (!best || score > best.score) best = { color: cand.color, score }
    }
    if (!best) break
    let minD = Infinity
    for (const c of centers) minD = Math.min(minD, colorDist2(best.color, c))
    if (minD < 10 * 10) break // plus aucune couleur réellement distincte
    centers.push(best.color)
  }

  // Raffinement K-means (recentre chaque couleur sur sa masse de pixels)
  for (let iter = 0; iter < 8; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0])
    for (const p of pixels) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centers.length; c++) {
        const d = colorDist2(p, centers[c])
        if (d < bestD) { bestD = d; best = c }
      }
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; sums[best][3]++
    }
    centers = centers.map((c, i) =>
      sums[i][3] > 0
        ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] as RGB
        : c
    )
  }

  return centers
    .map(c => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])] as RGB)
    .sort((a, b) => luminance(a) - luminance(b))
}

/** Snap chaque pixel sur la couleur de palette la plus proche.
 * Cache 15 bits (5 bits/canal) → lookup quasi gratuit après les premières frames. */
function posterizeInPlace(img: ImageData, palette: RGB[], cache: Int16Array) {
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)
    let pi = cache[key]
    if (pi < 0) {
      let bestD = Infinity
      pi = 0
      for (let c = 0; c < palette.length; c++) {
        const dr = d[i] - palette[c][0]
        const dg = d[i + 1] - palette[c][1]
        const db = d[i + 2] - palette[c][2]
        const dd = dr * dr + dg * dg + db * db
        if (dd < bestD) { bestD = dd; pi = c }
      }
      cache[key] = pi
    }
    d[i] = palette[pi][0]; d[i + 1] = palette[pi][1]; d[i + 2] = palette[pi][2]; d[i + 3] = 255
  }
}

function makeCache(): Int16Array {
  return new Int16Array(32768).fill(-1)
}

function loadVideoElement(blob: Blob): Promise<{ video: HTMLVideoElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'auto'
    video.onloadedmetadata = () => resolve({ video, url })
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Impossible de charger la vidéo')) }
    video.src = url
  })
}

function seekVideo(video: HTMLVideoElement, f: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve() }
    video.addEventListener('seeked', onSeeked)
    video.onerror = () => reject(new Error('Erreur de seek vidéo'))
    video.currentTime = Math.min(f / FPS + 0.001, Math.max(0, video.duration - 0.001))
  })
}

function canvasToBlob(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob a échoué')), type, quality))
}

/** Réencode des frames PNG en WebM via captureStream + MediaRecorder (temps réel). */
async function encodeFramesToWebM(
  frames: Blob[],
  width: number,
  height: number,
  onProgress?: (fraction: number) => void,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const first = await createImageBitmap(frames[0])
  ctx.drawImage(first, 0, 0)
  first.close()

  const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m))
  if (!mimeType) throw new Error('MediaRecorder : aucun codec WebM supporté')

  const stream = canvas.captureStream(FPS)
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => chunks.length > 0
      ? resolve(new Blob(chunks, { type: mimeType }))
      : reject(new Error('MediaRecorder : aucune donnée capturée'))
    recorder.onerror = () => reject(new Error('MediaRecorder : erreur d\'encodage'))
  })

  recorder.start()
  const t0 = performance.now()
  let current = 0
  await new Promise<void>(resolve => {
    const tick = async () => {
      const elapsed = (performance.now() - t0) / 1000
      const idx = Math.min(frames.length - 1, Math.floor(elapsed * FPS))
      if (idx !== current) {
        current = idx
        const bmp = await createImageBitmap(frames[idx])
        ctx.drawImage(bmp, 0, 0)
        bmp.close()
        onProgress?.((idx + 1) / frames.length)
      }
      if (elapsed * FPS >= frames.length) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // Petite traîne pour capturer la dernière frame
  await new Promise(r => setTimeout(r, 150))
  recorder.stop()
  stream.getTracks().forEach(t => t.stop())
  return done
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

export default function VideoPosterizePage() {
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const [videoDims, setVideoDims] = useState<{ w: number; h: number; frames: number } | null>(null)
  const [refImageFile, setRefImageFile] = useState<File | null>(null)
  const [numColors, setNumColors] = useState(8)
  const [palette, setPalette] = useState<RGB[] | null>(null)
  const [previewFrame, setPreviewFrame] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const beforeCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const afterCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoUrlRef = useRef<string | null>(null)

  useEffect(() => () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
  }, [resultUrl])

  async function handleVideoSelect(file: File | null) {
    setErrorMsg(null)
    setResultBlob(null)
    setResultUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setPalette(null)
    setVideoFile(file)
    if (videoUrlRef.current) { URL.revokeObjectURL(videoUrlRef.current); videoUrlRef.current = null }
    setVideoEl(null)
    setVideoDims(null)
    if (!file) return
    try {
      const { video, url } = await loadVideoElement(file)
      videoUrlRef.current = url
      setVideoEl(video)
      setVideoDims({ w: video.videoWidth, h: video.videoHeight, frames: Math.max(1, Math.floor(video.duration * FPS)) })
      setPreviewFrame(0)
    } catch (e) {
      setErrorMsg((e as Error).message)
    }
  }

  /** Extrait la palette depuis l'image de référence, ou la frame 0 de la vidéo. */
  async function extractPalette(): Promise<RGB[] | null> {
    setErrorMsg(null)
    try {
      const c = document.createElement('canvas')
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      const MAX = 256
      if (refImageFile) {
        const bmp = await createImageBitmap(refImageFile)
        const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height))
        c.width = Math.round(bmp.width * scale)
        c.height = Math.round(bmp.height * scale)
        ctx.drawImage(bmp, 0, 0, c.width, c.height)
        bmp.close()
      } else if (videoEl) {
        await seekVideo(videoEl, 0)
        const scale = Math.min(1, MAX / Math.max(videoEl.videoWidth, videoEl.videoHeight))
        c.width = Math.round(videoEl.videoWidth * scale)
        c.height = Math.round(videoEl.videoHeight * scale)
        ctx.drawImage(videoEl, 0, 0, c.width, c.height)
      } else {
        return null
      }
      const pal = kmeansPalette(ctx.getImageData(0, 0, c.width, c.height), numColors)
      setPalette(pal)
      return pal
    } catch (e) {
      setErrorMsg((e as Error).message)
      return null
    }
  }

  /** Preview avant/après sur la frame courante. */
  async function renderPreview(frame: number, pal: RGB[] | null = palette) {
    const before = beforeCanvasRef.current
    const after = afterCanvasRef.current
    if (!videoEl || !videoDims || !before || !after) return
    await seekVideo(videoEl, frame)
    before.width = after.width = videoDims.w
    before.height = after.height = videoDims.h
    const bctx = before.getContext('2d')!
    bctx.drawImage(videoEl, 0, 0)
    const actx = after.getContext('2d', { willReadFrequently: true })!
    actx.drawImage(videoEl, 0, 0)
    if (pal && pal.length > 0) {
      const img = actx.getImageData(0, 0, after.width, after.height)
      posterizeInPlace(img, pal, makeCache())
      actx.putImageData(img, 0, 0)
    }
  }

  async function handleExtractAndPreview() {
    if (!videoEl) return
    setBusy('Extraction de la palette…')
    try {
      const pal = await extractPalette()
      if (pal) await renderPreview(previewFrame, pal)
    } finally {
      setBusy(null)
    }
  }

  useEffect(() => {
    if (palette && videoEl) void renderPreview(previewFrame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewFrame])

  async function handleProcess() {
    if (!videoEl || !videoDims || !palette || palette.length === 0) return
    setErrorMsg(null)
    setResultBlob(null)
    setResultUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null })
    setProgress(0)
    try {
      // Pass 1 : posterisation de toutes les frames → PNG (lossless, idéal aplats)
      setBusy('Posterisation des frames…')
      const c = document.createElement('canvas')
      c.width = videoDims.w
      c.height = videoDims.h
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      const cache = makeCache()
      const frames: Blob[] = []
      for (let f = 0; f < videoDims.frames; f++) {
        await seekVideo(videoEl, f)
        ctx.drawImage(videoEl, 0, 0)
        const img = ctx.getImageData(0, 0, c.width, c.height)
        posterizeInPlace(img, palette, cache)
        ctx.putImageData(img, 0, 0)
        frames.push(await canvasToBlob(c, 'image/png'))
        setProgress((f + 1) / videoDims.frames)
      }
      // Pass 2 : réencodage WebM en temps réel (garder l'onglet au premier plan)
      setBusy('Encodage WebM (temps réel, gardez l\'onglet visible)…')
      setProgress(0)
      const webm = await encodeFramesToWebM(frames, videoDims.w, videoDims.h, setProgress)
      setResultBlob(webm)
      setResultUrl(URL.createObjectURL(webm))
    } catch (e) {
      setErrorMsg((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const baseName = (videoFile?.name ?? 'video').replace(/\.[^.]+$/, '')

  return (
    <div style={{ padding: 'var(--space-6)', maxWidth: 1200, margin: '0 auto' }}>
      <h1>Posterisation vidéo (aplats couleur)</h1>
      <p style={{ color: '#9aa3b2' }}>
        Re-snappe chaque pixel de la vidéo sur une palette de couleurs fixe pour annuler le délavage
        des générateurs IA (dégradés, ombres, contours flous). La palette est extraite de l'image de
        référence (recommandé : le PNG colorisé source) ou à défaut de la frame 0 de la vidéo.
        Sortie : WebM 24 fps à réimporter comme vidéo d'animation.
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center', margin: 'var(--space-4) 0', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: '#9aa3b2' }}>Vidéo (MP4/WebM)</span>
          <input type="file" accept="video/mp4,video/webm" onChange={e => handleVideoSelect(e.target.files?.[0] ?? null)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 12, color: '#9aa3b2' }}>Image référence palette (optionnel, sinon frame 0)</span>
          <input type="file" accept="image/png,image/jpeg" onChange={e => { setRefImageFile(e.target.files?.[0] ?? null); setPalette(null) }} />
        </label>
      </div>

      {videoDims && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxWidth: 700 }}>
          <span style={{ color: '#9aa3b2', fontSize: 13 }}>
            {videoDims.w}×{videoDims.h} · ~{videoDims.frames} frames ({(videoDims.frames / FPS).toFixed(1)} s à {FPS} fps)
          </span>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <label style={{ minWidth: 180 }}>Nombre de couleurs : {numColors}</label>
            <input type="range" min={3} max={16} value={numColors}
              onChange={e => { setNumColors(Number(e.target.value)); setPalette(null) }}
              style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <button className="btn-primary" onClick={handleExtractAndPreview} disabled={busy != null}>
              {palette ? 'Re-extraire la palette' : 'Extraire la palette + preview'}
            </button>
            {palette && (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {palette.map((c, i) => (
                  <span key={i} title={`rgb(${c[0]}, ${c[1]}, ${c[2]})`} style={{
                    width: 22, height: 22, borderRadius: 4, border: '1px solid #2d3340',
                    background: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
                  }} />
                ))}
                <span style={{ fontSize: 12, color: '#9aa3b2', marginLeft: 6 }}>{palette.length} couleurs</span>
              </div>
            )}
          </div>
        </div>
      )}

      {palette && videoDims && (
        <>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', margin: 'var(--space-3) 0', maxWidth: 700 }}>
            <label style={{ minWidth: 180 }}>Frame preview : {previewFrame}</label>
            <input type="range" min={0} max={videoDims.frames - 1} value={previewFrame}
              onChange={e => setPreviewFrame(Number(e.target.value))}
              style={{ flex: 1 }} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <figure style={{ flex: 1, minWidth: 300, margin: 0 }}>
              <figcaption style={{ fontSize: 12, color: '#9aa3b2', marginBottom: 4 }}>Original</figcaption>
              <canvas ref={beforeCanvasRef} style={{ width: '100%', height: 'auto', border: '1px solid #2d3340', borderRadius: 8, background: '#fff' }} />
            </figure>
            <figure style={{ flex: 1, minWidth: 300, margin: 0 }}>
              <figcaption style={{ fontSize: 12, color: '#9aa3b2', marginBottom: 4 }}>Posterisé</figcaption>
              <canvas ref={afterCanvasRef} style={{ width: '100%', height: 'auto', border: '1px solid #2d3340', borderRadius: 8, background: '#fff' }} />
            </figure>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', margin: 'var(--space-4) 0' }}>
            <button className="btn-primary" onClick={handleProcess} disabled={busy != null}>
              Posteriser toute la vidéo → WebM
            </button>
            {busy && (
              <span style={{ color: '#9aa3b2' }}>
                {busy} {progress > 0 && `${Math.round(progress * 100)}%`}
              </span>
            )}
          </div>
        </>
      )}

      {errorMsg && <p style={{ color: '#ff6b6b' }}>{errorMsg}</p>}

      {resultUrl && resultBlob && (
        <div style={{ marginTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', maxWidth: 700 }}>
          <h3 style={{ margin: 0 }}>Résultat ({(resultBlob.size / 1024 / 1024).toFixed(1)} MB)</h3>
          <video src={resultUrl} controls loop muted style={{ width: '100%', border: '1px solid #2d3340', borderRadius: 8, background: '#fff' }} />
          <button className="btn-primary" onClick={() => triggerDownload(resultBlob, `${baseName}-posterized.webm`)}>
            Télécharger le WebM
          </button>
        </div>
      )}
    </div>
  )
}
