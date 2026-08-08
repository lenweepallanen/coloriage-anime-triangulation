import { getSharedAudioContext } from './mouthAudioAnalyser'

/**
 * Sound design d'INTERFACE (app PLAY) — sons courts, SECS et NEUTRES (variante
 * « minimale » validée), synthétisés en direct sur le contexte audio PARTAGÉ.
 * Zéro fichier, 100 % offline, latence nulle.
 *
 * Garde-fous :
 *  - branché sur `ctx.destination` UNIQUEMENT (jamais `recordingAudioBus`) → les
 *    sons d'UI ne finissent PAS dans les vidéos exportées ;
 *  - no-op hors de l'app play (`body.play-app`) → l'admin reste silencieux même
 *    quand il rend des composants partagés (ScenePlayer/CameraView) ;
 *  - respecte le toggle utilisateur (localStorage `picopop-sound`) ;
 *  - throttle anti-répétition par son.
 *
 * Haptique découplée : `setHapticHook` (enregistré uniquement côté play) évite
 * d'imposer `@capacitor/haptics` au build admin.
 */

export type UiSoundName =
  | 'tap' | 'nav' | 'shutter' | 'switchOn' | 'switchOff'
  | 'scanDing' | 'success' | 'whoosh' | 'shareReady' | 'playful' | 'error'

/** Sons « physiques » qui déclenchent aussi un retour haptique léger. */
const HAPTIC_SOUNDS = new Set<UiSoundName>(['tap', 'shutter', 'switchOn', 'switchOff', 'success', 'playful'])

const SOUND_PREF_KEY = 'picopop-sound'
const MASTER = 0.5 // volume global bas (discret)

let masterGain: GainNode | null = null
let noiseBuf: AudioBuffer | null = null
let hapticHook: ((name: UiSoundName) => void) | null = null
let enabled: boolean | null = null // cache du toggle
const lastPlay = new Map<UiSoundName, number>()

function isPlayApp(): boolean {
  try { return document.body.classList.contains('play-app') } catch { return false }
}

export function isUiSoundEnabled(): boolean {
  if (enabled == null) {
    try { enabled = localStorage.getItem(SOUND_PREF_KEY) !== 'off' } catch { enabled = true }
  }
  return enabled
}

export function setUiSoundEnabled(on: boolean): void {
  enabled = on
  try { localStorage.setItem(SOUND_PREF_KEY, on ? 'on' : 'off') } catch { /* */ }
}

/** Enregistre le retour haptique (play uniquement) — appelé pour les sons physiques. */
export function setHapticHook(fn: ((name: UiSoundName) => void) | null): void {
  hapticHook = fn
}

/** Déverrouille le contexte audio (à appeler dans un geste utilisateur, iOS). */
export function unlockUiSound(): void {
  try {
    const ctx = getSharedAudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch { /* */ }
}

function getMaster(ctx: AudioContext): GainNode {
  if (!masterGain) {
    masterGain = ctx.createGain()
    masterGain.gain.value = MASTER
    masterGain.connect(ctx.destination) // JAMAIS le bus d'enregistrement
  }
  return masterGain
}

function getNoise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate)
    const d = noiseBuf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  }
  return noiseBuf
}

/** Note sinusoïdale courte avec enveloppe (attaque brève + décroissance expo). */
function tone(ctx: AudioContext, at: number, f0: number, f1: number, dur: number, gain: number, tau: number): void {
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(f0, at)
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, at)
  g.gain.linearRampToValueAtTime(gain, at + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(g); g.connect(getMaster(ctx))
  osc.start(at); osc.stop(at + dur + 0.02)
}

/** Clic sec = bruit passe-haut très court (le « tick » signature de la variante B). */
function click(ctx: AudioContext, at: number, dur: number, gain: number, hpHz: number, tau: number, swell = false): void {
  const src = ctx.createBufferSource()
  src.buffer = getNoise(ctx)
  src.loop = true
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = hpHz
  const g = ctx.createGain()
  if (swell) {
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(gain, at + dur * 0.45)
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  } else {
    g.gain.setValueAtTime(gain, at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + Math.max(0.01, tau * 4))
  }
  src.connect(hp); hp.connect(g); g.connect(getMaster(ctx))
  src.start(at, Math.random() * 0.3); src.stop(at + dur + 0.03)
}

/** Joue un son d'UI (no-op hors play / si mute / si suspendu non déverrouillable). */
export function playUi(name: UiSoundName): void {
  if (!isPlayApp() || !isUiSoundEnabled()) return
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  if (now - (lastPlay.get(name) ?? 0) < 40) return
  lastPlay.set(name, now)

  let ctx: AudioContext
  try { ctx = getSharedAudioContext() } catch { return }
  if (ctx.state === 'suspended') { void ctx.resume() }
  const t = ctx.currentTime

  switch (name) {
    case 'tap': click(ctx, t, 0.02, 0.5, 2200, 0.004); break
    case 'nav': click(ctx, t, 0.04, 0.42, 1800, 0.006); tone(ctx, t, 420, 320, 0.03, 0.06, 0.02); break
    case 'shutter': click(ctx, t, 0.018, 0.6, 2600, 0.004); click(ctx, t + 0.045, 0.02, 0.5, 2600, 0.005); break
    case 'switchOn': click(ctx, t, 0.012, 0.35, 2600, 0.004); tone(ctx, t, 520, 660, 0.03, 0.22, 0.02); break
    case 'switchOff': click(ctx, t, 0.012, 0.35, 2600, 0.004); tone(ctx, t, 660, 520, 0.03, 0.22, 0.02); break
    case 'scanDing': tone(ctx, t, 880, 880, 0.07, 0.26, 0.05); tone(ctx, t + 0.05, 1174, 1174, 0.11, 0.26, 0.06); break
    case 'success': tone(ctx, t, 659, 659, 0.17, 0.26, 0.1); tone(ctx, t + 0.09, 988, 988, 0.2, 0.24, 0.11); break
    case 'whoosh': click(ctx, t, 0.18, 0.28, 900, 0, true); break
    case 'shareReady': tone(ctx, t, 988, 988, 0.15, 0.26, 0.08); break
    case 'playful': tone(ctx, t, 420, 250, 0.12, 0.3, 0.07); break
    case 'error': tone(ctx, t, 220, 220, 0.2, 0.26, 0.13); click(ctx, t, 0.01, 0.15, 2000, 0.004); break
  }

  if (hapticHook && HAPTIC_SOUNDS.has(name)) {
    try { hapticHook(name) } catch { /* */ }
  }
}
