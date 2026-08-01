import { getSharedAudioContext } from './mouthAudioAnalyser'

/**
 * Bus audio d'ENREGISTREMENT : un MediaStreamAudioDestinationNode branché sur
 * l'AudioContext partagé (celui du lip-sync). Quand le bus est actif :
 *  - les HTMLAudioElement du player peuvent être routés dessus (en PARALLÈLE de
 *    la sortie normale) via `routeElementForRecording` ;
 *  - le lip-sync s'y branche automatiquement (tap dans mouthAudioAnalyser).
 * Quand le bus est inactif, tout est no-op — zéro impact hors capture.
 */

let recDest: MediaStreamAudioDestinationNode | null = null
/** Un MediaElementSource ne peut être créé qu'UNE fois par élément — garde. */
const routedElements = new WeakMap<HTMLAudioElement, { source: MediaElementAudioSourceNode }>()

export function enableRecordingBus(): MediaStreamAudioDestinationNode | null {
  try {
    const ctx = getSharedAudioContext()
    if (!recDest) recDest = ctx.createMediaStreamDestination()
    return recDest
  } catch (err) {
    console.warn('[recordingBus] activation impossible :', err)
    return null
  }
}

export function disableRecordingBus(): void {
  if (recDest) {
    try { recDest.disconnect() } catch { /* */ }
  }
  recDest = null
}

export function getRecordingDestination(): MediaStreamAudioDestinationNode | null {
  return recDest
}

/**
 * Route un HTMLAudioElement vers la sortie normale ET le bus d'enregistrement.
 * À appeler juste après `new Audio(...)`. No-op si le bus est inactif.
 *
 * ⚠ `createMediaElementSource` re-route la sortie de l'élément dans le graphe :
 * on reconnecte TOUJOURS ctx.destination pour continuer d'entendre le son.
 * (Certains navigateurs privacy — Brave/Firefox durci — peuvent produire du
 * silence via MediaElementSource : la vidéo perdrait ces sons, l'écoute non.)
 */
export function routeElementForRecording(audio: HTMLAudioElement): void {
  if (!recDest) return
  if (routedElements.has(audio)) return
  try {
    const ctx = getSharedAudioContext()
    const source = ctx.createMediaElementSource(audio)
    source.connect(ctx.destination)
    source.connect(recDest)
    routedElements.set(audio, { source })
  } catch (err) {
    // Élément déjà consommé par un autre contexte, ou API indisponible :
    // le son restera audible (sortie par défaut) mais absent de la vidéo.
    console.warn('[recordingBus] routage HTMLAudio impossible :', err)
  }
}
