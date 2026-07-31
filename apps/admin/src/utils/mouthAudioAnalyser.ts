/**
 * Lecteur audio + AnalyserNode pour le lip-sync de la bouche.
 *
 * N'utilise pas `<audio>` + `createMediaElementAudioSource` (souvent bloqué par
 * Brave Shields / Firefox resistFingerprinting / extensions privacy).
 *
 * À la place : `decodeAudioData` + `AudioBufferSourceNode`. Le buffer décodé est
 * réutilisable ; chaque appel à `play()` crée une nouvelle source (les
 * BufferSource sont à usage unique).
 */

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!sharedCtx) {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) {
      throw new Error('Web Audio API non disponible dans ce navigateur');
    }
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * Suspend l'AudioContext partagé (pause film) : gèle l'horloge et la lecture des
 * BufferSource en cours SANS déclencher leur `onended`. Reprise via
 * `resumeMouthAudioContext`. No-op si aucun contexte n'a été créé.
 */
export async function suspendMouthAudioContext(): Promise<void> {
  if (sharedCtx && sharedCtx.state === 'running') {
    try { await sharedCtx.suspend(); } catch { /* */ }
  }
}

export async function resumeMouthAudioContext(): Promise<void> {
  if (sharedCtx && sharedCtx.state === 'suspended') {
    try { await sharedCtx.resume(); } catch { /* */ }
  }
}

export interface MouthAudioPlayer {
  /** Démarre la lecture. Re-crée un BufferSource à chaque appel. Résout dès le démarrage. */
  play: () => Promise<void>;
  /** Arrête la lecture en cours (si une source est active). */
  stop: () => void;
  /** RMS lissée [0,1]. Retourne 0 quand rien ne joue. */
  getRMS: () => number;
  /** Définit le volume de sortie [0,1]. */
  setVolume: (v: number) => void;
  /** Libère le buffer et déconnecte les nodes (l'AudioContext partagé reste vivant). */
  cleanup: () => void;
  /** Durée totale du buffer en secondes. */
  readonly duration: number;
  /** true si une source joue actuellement. */
  readonly isPlaying: boolean;
}

interface LoadOptions {
  /** Coefficient lissage exponentiel α ∈ [0,1]. Plus haut = plus réactif. Défaut 0.4. */
  smoothing?: number;
  /** Gain appliqué à la RMS brute avant clamp. Défaut 1.8. */
  gain?: number;
  /** Volume de sortie [0,1]. Défaut 1. */
  volume?: number;
  /** Vitesse de lecture (playbackRate, défaut 1). Affecte aussi la hauteur. */
  rate?: number;
  /** Callback de fin de lecture (source onended). */
  onEnded?: () => void;
}

export async function loadMouthAudio(
  source: Blob | ArrayBuffer | string,
  opts: LoadOptions = {},
): Promise<MouthAudioPlayer> {
  const smoothing = opts.smoothing ?? 0.4;
  const gain = opts.gain ?? 1.8;
  const ctx = getCtx();

  // Récupère l'ArrayBuffer
  let arrayBuf: ArrayBuffer;
  if (source instanceof Blob) {
    arrayBuf = await source.arrayBuffer();
  } else if (typeof source === 'string') {
    const resp = await fetch(source);
    arrayBuf = await resp.arrayBuffer();
  } else {
    arrayBuf = source;
  }

  // decodeAudioData supporte les deux signatures (callback / promise). On wrappe
  // explicitement pour Safari ancien qui n'a que la version callback.
  const audioBuffer: AudioBuffer = await new Promise((resolve, reject) => {
    try {
      const ret = ctx.decodeAudioData(
        arrayBuf,
        b => resolve(b),
        e => reject(e),
      );
      if (ret && typeof (ret as Promise<AudioBuffer>).then === 'function') {
        (ret as Promise<AudioBuffer>).then(resolve, reject);
      }
    } catch (e) {
      reject(e);
    }
  });

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0;
  // src → analyser → gain → destination. Le GainNode contrôle le volume de sortie sans
  // affecter l'analyse RMS (qui lit depuis analyser en amont).
  const gainNode = ctx.createGain();
  gainNode.gain.value = opts.volume ?? 1;
  analyser.connect(gainNode);
  gainNode.connect(ctx.destination);

  const buf = new Uint8Array(analyser.fftSize);
  let smoothed = 0;
  let currentSource: AudioBufferSourceNode | null = null;
  let disposed = false;

  const player: MouthAudioPlayer = {
    play: async () => {
      if (disposed) return;
      if (ctx.state === 'suspended') await ctx.resume();
      // stoppe l'éventuelle source précédente
      if (currentSource) {
        try { currentSource.stop(); } catch { /* déjà arrêtée */ }
        currentSource.disconnect();
      }
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.playbackRate.value = opts.rate ?? 1;
      src.connect(analyser);
      src.onended = () => {
        if (currentSource === src) {
          currentSource = null;
          smoothed = 0;
          opts.onEnded?.();
        }
      };
      src.start(0);
      currentSource = src;
    },
    stop: () => {
      if (currentSource) {
        try { currentSource.stop(); } catch { /* ignore */ }
        currentSource.disconnect();
        currentSource = null;
      }
      smoothed = 0;
    },
    setVolume: (v: number) => {
      const clamped = Math.max(0, Math.min(1, v))
      try { gainNode.gain.setValueAtTime(clamped, ctx.currentTime); } catch { gainNode.gain.value = clamped; }
    },
    getRMS: () => {
      if (!currentSource) return 0;
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const scaled = Math.min(1, rms * gain);
      smoothed = smoothed + (scaled - smoothed) * smoothing;
      return smoothed;
    },
    cleanup: () => {
      disposed = true;
      if (currentSource) {
        try { currentSource.stop(); } catch { /* ignore */ }
        currentSource.disconnect();
        currentSource = null;
      }
      try { gainNode.disconnect(); } catch { /* ignore */ }
      analyser.disconnect();
    },
    get duration() { return audioBuffer.duration; },
    get isPlaying() { return currentSource !== null; },
  };

  return player;
}
