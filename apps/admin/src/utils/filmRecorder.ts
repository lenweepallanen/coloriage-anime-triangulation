import { enableRecordingBus } from './recordingAudioBus'

/**
 * Enregistrement du film PENDANT sa lecture : canvas PIXI (captureStream) +
 * piste audio du bus d'enregistrement (recordingAudioBus) → MediaRecorder.
 * iOS/WKWebView produit du MP4 (H.264/AAC) ; Chrome/Android du WebM.
 */

export interface FilmRecordingResult {
  blob: Blob
  mimeType: string
  durationMs: number
  /** Vignette capturée DIRECTEMENT depuis le rendu PIXI pendant la lecture
   *  (fiable sur iOS, contrairement à l'extraction d'une frame de la vidéo). */
  posterBlob?: Blob | null
  posterMs?: number | null
}

export interface FilmRecording {
  pause(): void
  resume(): void
  /** Finalise l'enregistrement et retourne le fichier. */
  stop(): Promise<FilmRecordingResult>
  /** Arrête et JETTE l'enregistrement (démontage en cours de film). */
  abort(): void
}

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch { /* */ }
  }
  return null
}

/**
 * Démarre la capture. Retourne null si l'API n'est pas disponible (dégradation
 * propre : le film joue normalement, sans vidéo). Le bus audio doit avoir été
 * activé AVANT la création des sons de la scène (enableRecordingBus).
 */
export function startFilmRecording(canvas: HTMLCanvasElement, fps = 30): FilmRecording | null {
  const mimeType = pickMimeType()
  if (!mimeType || typeof canvas.captureStream !== 'function') {
    console.warn('[filmRecorder] MediaRecorder/captureStream indisponibles — pas de capture')
    return null
  }

  let stream: MediaStream
  try {
    stream = canvas.captureStream(fps)
  } catch (err) {
    console.warn('[filmRecorder] captureStream a échoué :', err)
    return null
  }

  // Piste audio : mix du bus d'enregistrement (HTMLAudio routés + lip-sync).
  const recDest = enableRecordingBus()
  const audioTrack = recDest?.stream.getAudioTracks()[0]
  if (audioTrack) stream.addTrack(audioTrack)

  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
  } catch (err) {
    console.warn('[filmRecorder] MediaRecorder a échoué :', err)
    return null
  }

  const chunks: Blob[] = []
  const startedAt = performance.now()
  let pausedTotalMs = 0
  let pausedAt: number | null = null
  let stopPromise: Promise<FilmRecordingResult> | null = null

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data)
  }
  recorder.onerror = (e) => {
    console.warn('[filmRecorder] erreur MediaRecorder :', e)
  }

  recorder.start(1000) // chunks réguliers (robustesse mémoire/interruption)
  console.log(`[filmRecorder] capture démarrée (${mimeType}, audio: ${audioTrack ? 'oui' : 'non'})`)

  const doStop = (): Promise<FilmRecordingResult> => {
    if (stopPromise) return stopPromise
    stopPromise = new Promise<FilmRecordingResult>((resolve) => {
      const finalize = () => {
        const durationMs = performance.now() - startedAt - pausedTotalMs
        resolve({ blob: new Blob(chunks, { type: mimeType }), mimeType, durationMs })
      }
      if (recorder.state === 'inactive') {
        finalize()
        return
      }
      recorder.onstop = finalize
      try {
        recorder.stop()
      } catch {
        finalize()
      }
    })
    return stopPromise
  }

  return {
    pause() {
      if (recorder.state === 'recording') {
        try { recorder.pause() } catch { /* */ }
        pausedAt = performance.now()
      }
    },
    resume() {
      if (recorder.state === 'paused') {
        try { recorder.resume() } catch { /* */ }
        if (pausedAt != null) {
          pausedTotalMs += performance.now() - pausedAt
          pausedAt = null
        }
      }
    },
    stop() {
      return doStop()
    },
    abort() {
      void doStop().then(() => {
        chunks.length = 0
      })
      // Libère les pistes (le canvas stream survivrait sinon au démontage).
      for (const t of stream.getTracks()) {
        try { t.stop() } catch { /* */ }
      }
    },
  }
}
