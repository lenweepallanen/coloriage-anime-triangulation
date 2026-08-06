import type { FilmT } from '../types/project'
import { getSharedAudioContext } from './mouthAudioAnalyser'

/**
 * Scheduler audio WebAudio du film timeline : tous les clips sons (+ la musique
 * de fond bouclée) sont PLANIFIÉS sur l'AudioContext partagé via
 * `AudioBufferSourceNode.start(when, offset)` → sync milliseconde, seek exact,
 * pause via `ctx.suspend()` (pattern lip-sync existant, sans onended parasite).
 *
 * L'horloge du contexte est aussi l'HORLOGE MAÎTRESSE du film : le player dérive
 * `tMs = currentTimeMs()` → zéro dérive audio/visuel, la pause suspend tout.
 *
 * Enregistrement vidéo : le master gain se connecte directement au bus
 * (`getRecordingDestination()`) — plus de hack MediaElementSource côté film.
 */

interface FlatClip {
  startMs: number
  endMs: number
  soundId: string
  volume: number
  rate: number
  loop: boolean
  isSpoken: boolean
  fadeInMs: number
  fadeOutMs: number
}

interface ActiveSource {
  source: AudioBufferSourceNode
  gain: GainNode
  analyser: AnalyserNode | null
  endMs: number
  startMs: number
  smoothed: number
}

const RMS_GAIN = 1.8
const RMS_SMOOTHING = 0.4

export class FilmAudioScheduler {
  private ctx: AudioContext
  private master: GainNode
  private buffers = new Map<string, AudioBuffer>()
  private clips: FlatClip[] = []
  private musicId: string | null = null
  private musicVolume = 1
  private totalMs = 0
  private active: ActiveSource[] = []
  private startedAtCtxSec: number | null = null
  private baseMs = 0
  private rmsBuf = new Uint8Array(256)
  private disposed = false
  /** Résolue quand tous les buffers sont décodés. */
  readonly ready: Promise<void>

  private oneShots: { timeMs: number; soundId: string; volume?: number }[] = []

  /**
   * @param planStartMs Début absolu (ms) de chaque plan de film.plans — mêmes
   *   valeurs que `FilmTimelineSampler.planStartMs` (NaN = plan inactif, ignoré).
   *   Pour la lecture d'un seul plan (éditeur) : `[NaN, …, 0, …, NaN]`.
   * @param oneShots Sons ponctuels à temps absolu (bruits de pas synchronisés).
   * @param extraSounds Blobs additionnels hors bibliothèque du film, keyés par
   *   soundId (ex. clés `anim:{animId}:1|2` des sons de pas portés par les
   *   animations) — ajoutés au pré-décodage, référençables par les one-shots.
   */
  constructor(film: FilmT, planStartMs: number[], totalMs: number, oneShots?: { timeMs: number; soundId: string; volume?: number }[], extraSounds?: Map<string, Blob>) {
    this.ctx = getSharedAudioContext()
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
    // Tap bus d'enregistrement (import dynamique : évite un cycle de modules).
    void import('./recordingAudioBus').then(({ getRecordingDestination }) => {
      const recDest = getRecordingDestination()
      if (recDest && !this.disposed) {
        try { this.master.connect(recDest) } catch { /* déjà connecté */ }
      }
    })

    this.totalMs = Math.max(0, totalMs)
    // Aplatissement des clips en temps ABSOLU film.
    film.plans.forEach((plan, idx) => {
      const base = planStartMs[idx]
      if (base == null || Number.isNaN(base)) return
      for (const track of plan.timeline.soundTracks) {
        for (const clip of track) {
          this.clips.push({
            startMs: base + clip.startMs,
            endMs: base + clip.startMs + clip.durationMs,
            soundId: clip.soundId,
            volume: clip.volume ?? 1,
            rate: Math.max(0.01, clip.rate ?? 1),
            loop: clip.loop === true,
            isSpoken: clip.isSpoken === true,
            fadeInMs: clip.fadeInMs ?? 0,
            fadeOutMs: clip.fadeOutMs ?? 0,
          })
        }
      }
    })
    if (film.music?.blob) {
      this.musicId = film.music.id
      this.musicVolume = film.music.volume ?? 1
    }
    this.oneShots = oneShots ?? []

    // Pré-décodage de tous les sons référencés (+ musique + one-shots).
    const wanted = new Set(this.clips.map(c => c.soundId))
    for (const os of this.oneShots) wanted.add(os.soundId)
    if (this.musicId) wanted.add(this.musicId)
    const soundById = new Map(film.sounds.map(snd => [snd.id, snd]))
    if (film.music) soundById.set(film.music.id, film.music)
    this.ready = Promise.all(Array.from(wanted).map(async id => {
      const blob = soundById.get(id)?.blob ?? extraSounds?.get(id)
      if (!blob) return
      try {
        const arrayBuf = await blob.arrayBuffer()
        const buf: AudioBuffer = await new Promise((resolve, reject) => {
          try {
            const ret = this.ctx.decodeAudioData(arrayBuf, b => resolve(b), e => reject(e))
            if (ret && typeof (ret as Promise<AudioBuffer>).then === 'function') {
              (ret as Promise<AudioBuffer>).then(resolve, reject)
            }
          } catch (e) { reject(e) }
        })
        this.buffers.set(id, buf)
      } catch {
        // Son indécodable : le film joue sans lui.
      }
    })).then(() => undefined)
  }

  /** À appeler dans un GESTE utilisateur (iOS) avant/pendant le lancement. */
  async unlock(): Promise<void> {
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume() } catch { /* */ }
    }
  }

  get isStarted(): boolean {
    return this.startedAtCtxSec != null
  }

  /** Temps film courant (ms) dérivé de l'horloge du contexte. Gelé si suspendu. */
  currentTimeMs(): number {
    if (this.startedAtCtxSec == null) return this.baseMs
    return this.baseMs + (this.ctx.currentTime - this.startedAtCtxSec) * 1000
  }

  /** Planifie tous les clips ∩ [fromMs, ∞) et démarre l'horloge à fromMs. */
  start(fromMs: number): void {
    if (this.disposed) return
    this.stopSources()
    this.baseMs = Math.max(0, fromMs)
    this.startedAtCtxSec = this.ctx.currentTime
    const now = this.ctx.currentTime

    const schedule = (c: FlatClip): void => {
      const buf = this.buffers.get(c.soundId)
      if (!buf || c.endMs <= this.baseMs) return
      const delaySec = Math.max(0, (c.startMs - this.baseMs) / 1000)
      const offsetTimelineSec = Math.max(0, (this.baseMs - c.startMs) / 1000)
      // offset du BUFFER : le playbackRate accélère le temps buffer.
      let offsetBufSec = offsetTimelineSec * c.rate
      if (c.loop && buf.duration > 0) offsetBufSec = offsetBufSec % buf.duration
      else if (offsetBufSec >= buf.duration) return // déjà terminé à fromMs

      const source = this.ctx.createBufferSource()
      source.buffer = buf
      source.playbackRate.value = c.rate
      source.loop = c.loop
      const gain = this.ctx.createGain()
      let analyser: AnalyserNode | null = null
      if (c.isSpoken) {
        analyser = this.ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0
        source.connect(analyser)
        analyser.connect(gain)
      } else {
        source.connect(gain)
      }
      gain.connect(this.master)

      const when = now + delaySec
      const endWhen = now + (c.endMs - this.baseMs) / 1000
      // Enveloppe volume + fades (rampes ignorées si on démarre au-delà).
      const g = gain.gain
      if (c.fadeInMs > 0 && offsetTimelineSec * 1000 < c.fadeInMs) {
        const alreadyIn = offsetTimelineSec * 1000
        g.setValueAtTime((alreadyIn / c.fadeInMs) * c.volume, when)
        g.linearRampToValueAtTime(c.volume, when + (c.fadeInMs - alreadyIn) / 1000)
      } else {
        g.setValueAtTime(c.volume, when)
      }
      // Fondu de fin : celui du clip, sinon 150 ms AUTO pour les sons bouclés
      // (coupés à la fin du trajet — un stop sec fait une « coupure » audible).
      const fadeOutMs = c.fadeOutMs > 0 ? c.fadeOutMs : (c.loop ? 150 : 0)
      if (fadeOutMs > 0) {
        const foStart = Math.max(when, endWhen - fadeOutMs / 1000)
        g.setValueAtTime(c.volume, foStart)
        g.linearRampToValueAtTime(0, endWhen)
      }

      const entry: ActiveSource = { source, gain, analyser, startMs: c.startMs, endMs: c.endMs, smoothed: 0 }
      source.onended = () => {
        try { gain.disconnect() } catch { /* */ }
        try { analyser?.disconnect() } catch { /* */ }
        this.active = this.active.filter(a => a !== entry)
      }
      source.start(when, offsetBufSec)
      source.stop(endWhen)
      this.active.push(entry)
    }

    for (const c of this.clips) schedule(c)
    // Bruits de pas : un one-shot par contact au sol (durée = son entier).
    for (const os of this.oneShots) {
      if (os.timeMs < this.baseMs) continue
      const buf = this.buffers.get(os.soundId)
      if (!buf) continue
      const source = this.ctx.createBufferSource()
      source.buffer = buf
      const gain = this.ctx.createGain()
      const vol = os.volume ?? 1
      source.connect(gain)
      gain.connect(this.master)
      const when = now + (os.timeMs - this.baseMs) / 1000
      // Un pas = UN impact : si le fichier est long (enregistrement de marche
      // complet), on ne joue que son attaque (450 ms, fondu 60 ms).
      const playSec = Math.min(buf.duration, 0.45)
      gain.gain.setValueAtTime(vol, when)
      if (buf.duration > playSec) {
        gain.gain.setValueAtTime(vol, when + playSec - 0.06)
        gain.gain.linearRampToValueAtTime(0, when + playSec)
      }
      const entry: ActiveSource = { source, gain, analyser: null, startMs: os.timeMs, endMs: os.timeMs + playSec * 1000, smoothed: 0 }
      source.onended = () => {
        try { gain.disconnect() } catch { /* */ }
        this.active = this.active.filter(a => a !== entry)
      }
      source.start(when)
      source.stop(when + playSec)
      this.active.push(entry)
    }
    // Musique de fond : bouclée sur toute la durée restante du film.
    if (this.musicId) {
      schedule({
        startMs: 0,
        endMs: this.totalMs,
        soundId: this.musicId,
        volume: this.musicVolume,
        rate: 1,
        loop: true,
        isSpoken: false,
        fadeInMs: 0,
        fadeOutMs: 300,
      })
    }
  }

  /** Seek exact : coupe tout et re-planifie depuis toMs. */
  seek(toMs: number): void {
    this.start(toMs)
  }

  /** RMS lissée agrégée (max) des clips « parlé » actifs — pilote la bouche. */
  getSpokenRMS(): number {
    if (this.startedAtCtxSec == null) return 0
    const t = this.currentTimeMs()
    let out = 0
    for (const a of this.active) {
      if (!a.analyser || t < a.startMs || t >= a.endMs) continue
      a.analyser.getByteTimeDomainData(this.rmsBuf)
      let sumSq = 0
      for (let i = 0; i < this.rmsBuf.length; i++) {
        const v = (this.rmsBuf[i] - 128) / 128
        sumSq += v * v
      }
      const scaled = Math.min(1, Math.sqrt(sumSq / this.rmsBuf.length) * RMS_GAIN)
      a.smoothed = a.smoothed + (scaled - a.smoothed) * RMS_SMOOTHING
      out = Math.max(out, a.smoothed)
    }
    return out
  }

  private stopSources(): void {
    for (const a of this.active) {
      try { a.source.onended = null } catch { /* */ }
      try { a.source.stop() } catch { /* déjà arrêtée */ }
      try { a.source.disconnect() } catch { /* */ }
      try { a.gain.disconnect() } catch { /* */ }
      try { a.analyser?.disconnect() } catch { /* */ }
    }
    this.active = []
  }

  stop(): void {
    this.baseMs = this.currentTimeMs()
    this.startedAtCtxSec = null
    this.stopSources()
  }

  dispose(): void {
    this.disposed = true
    this.stopSources()
    try { this.master.disconnect() } catch { /* */ }
    this.buffers.clear()
  }
}
