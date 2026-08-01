/**
 * Extrait une vignette JPEG d'une vidéo (blob) à une fraction de sa durée
 * (défaut 1/3) — utilisée comme preview dans la galerie de l'app et comme
 * poster des lecteurs vidéo.
 */
export function generateVideoPoster(
  videoBlob: Blob,
  fraction = 1 / 3,
  maxWidth = 640,
  timeoutMs = 8000,
): Promise<Blob | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(videoBlob)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    let done = false

    const finish = (blob: Blob | null) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      try { URL.revokeObjectURL(url) } catch { /* */ }
      video.removeAttribute('src')
      try { video.load() } catch { /* */ }
      resolve(blob)
    }

    const timer = window.setTimeout(() => finish(null), timeoutMs)

    video.onerror = () => finish(null)
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      // Certains WebM MediaRecorder annoncent duration=Infinity : fallback 1 s.
      const target = duration > 0 ? duration * fraction : 1
      try {
        video.currentTime = target
      } catch {
        finish(null)
      }
    }
    video.onseeked = () => {
      try {
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) { finish(null); return }
        const scale = Math.min(1, maxWidth / w)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(w * scale)
        canvas.height = Math.round(h * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) { finish(null); return }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(b => finish(b), 'image/jpeg', 0.82)
      } catch {
        finish(null)
      }
    }

    video.src = url
  })
}
