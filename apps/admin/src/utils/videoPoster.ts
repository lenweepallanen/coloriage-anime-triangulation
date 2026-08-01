/**
 * Extrait une vignette JPEG d'une vidéo (blob) à une fraction de sa durée
 * (défaut 1/3 — ex. vidéo de 30 s → frame à 10 s). Utilisée comme preview
 * dans la galerie de l'app et comme poster des lecteurs vidéo.
 *
 * Piège géré : les vidéos issues de MediaRecorder annoncent souvent
 * `duration = Infinity` au chargement. Workaround standard : seek vers un
 * temps immense → le navigateur résout alors la vraie durée → on seek au
 * point voulu, puis on capture.
 */
export function generateVideoPoster(
  videoBlob: Blob,
  fraction = 1 / 3,
  maxWidth = 640,
  timeoutMs = 10000,
): Promise<Blob | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(videoBlob)
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    let done = false
    /** 'resolving-duration' = seek immense en cours (durée Infinity). */
    let phase: 'idle' | 'resolving-duration' | 'target' = 'idle'

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

    const capture = () => {
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

    const seekToTarget = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      if (duration <= 0) { capture(); return }
      phase = 'target'
      const target = duration * fraction
      if (Math.abs(video.currentTime - target) < 0.05) {
        capture()
        return
      }
      try {
        video.currentTime = target
      } catch {
        capture()
      }
    }

    video.onerror = () => finish(null)
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        seekToTarget()
      } else {
        // Durée inconnue (MediaRecorder) : seek immense pour la faire résoudre.
        phase = 'resolving-duration'
        try {
          video.currentTime = 1e7
        } catch {
          finish(null)
        }
      }
    }
    video.onseeked = () => {
      if (done) return
      if (phase === 'resolving-duration') {
        seekToTarget()
      } else if (phase === 'target') {
        capture()
      }
    }

    video.src = url
  })
}
