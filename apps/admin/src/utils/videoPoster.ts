/**
 * Extrait une vignette JPEG d'une vidéo (blob).
 *  - `fraction` (défaut 1/3) : instant relatif à la durée (ex. 30 s → 10 s).
 *  - `atMs` (prioritaire si fourni) : instant ABSOLU (ms), clampé à la durée —
 *    utilisé quand l'utilisateur a défini une vignette (`FilmT.posterMs`).
 * Utilisée comme preview de galerie et comme frame préfixée au partage.
 *
 * Piège géré : les vidéos issues de MediaRecorder annoncent souvent
 * `duration = Infinity` au chargement. Workaround standard : seek vers un
 * temps immense → le navigateur résout alors la vraie durée → on seek au
 * point voulu, puis on capture.
 *
 * Pièges iOS / WKWebView (sinon vignette noire ou nulle → fallback 🎬) :
 *  - un <video> HORS DOM (ou display:none) ne décode PAS ses frames → drawImage
 *    renvoie du noir. On l'attache off-screen (rendu mais invisible).
 *  - `onseeked` précède souvent le décodage réel → on attend une frame VRAIMENT
 *    peinte via `requestVideoFrameCallback` (fallback : petit délai).
 *  - lecture muette lancée puis mise en pause pour forcer le décodage.
 */
export function generateVideoPoster(
  videoBlob: Blob,
  fraction = 1 / 3,
  maxWidth = 640,
  timeoutMs = 10000,
  atMs?: number | null,
): Promise<Blob | null> {
  return new Promise(resolve => {
    const url = URL.createObjectURL(videoBlob)
    const video = document.createElement('video')
    video.muted = true
    video.defaultMuted = true
    video.playsInline = true
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.preload = 'auto'
    // iOS/WKWebView : le <video> DOIT être dans le DOM (et pas display:none) pour
    // décoder ses frames. On l'attache off-screen, rendu mais invisible.
    video.style.cssText =
      'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;'
    document.body.appendChild(video)

    let done = false
    /** 'resolving-duration' = seek immense en cours (durée Infinity). */
    let phase: 'idle' | 'resolving-duration' | 'target' = 'idle'

    const finish = (blob: Blob | null) => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      try { URL.revokeObjectURL(url) } catch { /* */ }
      try { video.pause() } catch { /* */ }
      video.removeAttribute('src')
      try { video.load() } catch { /* */ }
      try { video.remove() } catch { /* */ }
      resolve(blob)
    }

    const timer = window.setTimeout(() => finish(null), timeoutMs)

    // Attend une frame réellement peinte avant de capturer (iOS).
    const rvfc = (video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => number
    }).requestVideoFrameCallback?.bind(video)

    const draw = () => {
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

    const capture = () => {
      // La frame décodée n'est pas garantie peinte à l'instant de `onseeked` sur
      // iOS : on attend un callback de frame vidéo, sinon un petit délai de repli.
      if (rvfc) rvfc(() => draw())
      else window.setTimeout(draw, 80)
    }

    const seekToTarget = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      if (duration <= 0) { capture(); return }
      phase = 'target'
      // Instant absolu (posterMs) prioritaire, clampé à la durée réelle ; sinon
      // fraction. Marge 0,05 s avant la fin pour éviter une frame vide.
      const target = atMs != null && atMs >= 0
        ? Math.min(atMs / 1000, Math.max(0, duration - 0.05))
        : duration * fraction
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
      // iOS : forcer le décodage par une lecture muette brève (autorisée sans
      // geste car muet), immédiatement mise en pause.
      const p = video.play?.()
      if (p && typeof p.then === 'function') p.then(() => { try { video.pause() } catch { /* */ } }).catch(() => { /* */ })
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
    try { video.load() } catch { /* */ }
  })
}
