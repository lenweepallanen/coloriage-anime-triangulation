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

export interface MouthAudioPlayer {
  /** Démarre la lecture. Re-crée un BufferSource à chaque appel. Résout dès le démarrage. */
  play: () => Promise<void>;
  /** Arrête la lecture en cours (si une source est active). */
  stop: () => void;
  /** RMS lissée [0,1]. Retourne 0 quand rien ne joue. */
  getRMS: () => number;
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
  analyser.connect(ctx.destination);

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
      analyser.disconnect();
    },
    get duration() { return audioBuffer.duration; },
    get isPlaying() { return currentSource !== null; },
  };

  return player;
}
