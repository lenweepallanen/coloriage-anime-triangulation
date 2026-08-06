/**
 * Suivi GLOBAL de l'activité de téléchargement Storage (octets), pour afficher
 * une vraie barre de progression + un message « connexion lente » côté PLAY.
 *
 * Pub/sub minimal alimenté par `blobCache.cachedDownloadBlob` (lecture du corps
 * de la réponse par flux). Agrège tous les téléchargements en cours : quand plus
 * rien n'est actif, les compteurs se remettent à zéro. Aucune dépendance UI.
 */

interface ProgressState {
  /** Nombre de téléchargements en cours. */
  active: number
  /** Octets reçus (cumulés sur les téléchargements actifs). */
  received: number
  /** Octets attendus (somme des Content-Length connus ; 0 si inconnu). */
  total: number
  /** Horodatage (performance.now) du 1ᵉʳ téléchargement de la rafale, sinon null. */
  startedAt: number | null
}

let state: ProgressState = { active: 0, received: 0, total: 0, startedAt: null }
const listeners = new Set<() => void>()
let nextId = 1
let lastEmit = 0

/** Notifie les abonnés. `force` = toujours (begin/end) ; sinon throttle ~60 ms
 *  pour éviter des centaines de re-renders pendant un gros téléchargement. */
function emit(force: boolean): void {
  const now = nowMs()
  if (!force && now - lastEmit < 60) return
  lastEmit = now
  for (const l of listeners) l()
}

/** Snapshot immuable courant (pour useSyncExternalStore). */
export function getDownloadSnapshot(): ProgressState {
  return state
}

export function subscribeDownloads(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Démarre le suivi d'un téléchargement (`totalBytes` = 0 si inconnu). */
export function beginDownload(totalBytes: number): number {
  const id = nextId++
  state = {
    active: state.active + 1,
    received: state.received,
    total: state.total + Math.max(0, totalBytes),
    startedAt: state.active === 0 ? (state.startedAt ?? nowMs()) : state.startedAt,
  }
  emit(true)
  return id
}

/** Ajoute `deltaBytes` octets reçus. */
export function progressDownload(_id: number, deltaBytes: number): void {
  if (deltaBytes <= 0) return
  state = { ...state, received: state.received + deltaBytes }
  emit(false)
}

/** Termine un téléchargement. Quand plus aucun n'est actif, reset des compteurs. */
export function endDownload(_id: number): void {
  const active = Math.max(0, state.active - 1)
  state = active === 0
    ? { active: 0, received: 0, total: 0, startedAt: null }
    : { ...state, active }
  emit(true)
}

/** performance.now si dispo (monotone), sinon 0 (l'horloge sert au « lent »). */
function nowMs(): number {
  try { return performance.now() } catch { return 0 }
}
