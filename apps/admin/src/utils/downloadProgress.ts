/**
 * Suivi GLOBAL de l'activité de téléchargement Storage (octets), pour afficher
 * une vraie barre de progression + un message « connexion lente » côté PLAY.
 *
 * Pub/sub minimal alimenté par `blobCache.cachedDownloadBlob` (lecture du corps
 * de la réponse par flux). Agrège tous les téléchargements en cours : quand plus
 * rien n'est actif, les compteurs se remettent à zéro. Aucune dépendance UI.
 *
 * PREMIER PLAN vs ARRIÈRE-PLAN : les téléchargements lancés pendant une section
 * `runAsBackgroundDownloads()` (pré-chargement d'un livre) sont comptés à part —
 * ils n'alimentent ni la barre ni le message « lent » (l'utilisateur n'attend
 * pas dessus). Le message « lent » ne se base plus sur la DURÉE de la rafale
 * (4 s étaient dépassées sur n'importe quelle connexion normale au 1er scan)
 * mais sur un vrai BLOCAGE : aucun octet reçu depuis `STALL_MS`.
 */

interface ProgressState {
  /** Nombre de téléchargements de PREMIER PLAN en cours. */
  active: number
  /** Nombre de téléchargements d'ARRIÈRE-PLAN en cours (pré-chargement livre). */
  background: number
  /** Octets reçus (cumulés sur les téléchargements de premier plan actifs). */
  received: number
  /** Octets attendus (somme des Content-Length connus ; 0 si inconnu). */
  total: number
  /** Horodatage (performance.now) du 1ᵉʳ téléchargement de la rafale, sinon null. */
  startedAt: number | null
  /** Horodatage (performance.now) du dernier octet reçu (ou du début) — sert à
   *  détecter un blocage réel de la connexion. */
  lastProgressAt: number | null
}

let state: ProgressState = { active: 0, background: 0, received: 0, total: 0, startedAt: null, lastProgressAt: null }
const listeners = new Set<() => void>()
let nextId = 1
let lastEmit = 0
const backgroundIds = new Set<number>()
let backgroundDepth = 0

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

/**
 * Exécute `fn` en marquant comme ARRIÈRE-PLAN tous les téléchargements qui
 * DÉMARRENT pendant son exécution (pré-chargement d'un livre). Réentrant.
 */
export async function runAsBackgroundDownloads<T>(fn: () => Promise<T>): Promise<T> {
  backgroundDepth++
  try { return await fn() } finally { backgroundDepth = Math.max(0, backgroundDepth - 1) }
}

/** Vrai si une section arrière-plan est en cours (les nouveaux téléchargements y sont rattachés). */
export function isBackgroundDownloadContext(): boolean {
  return backgroundDepth > 0
}

/** Démarre le suivi d'un téléchargement (`totalBytes` = 0 si inconnu). */
export function beginDownload(totalBytes: number): number {
  const id = nextId++
  if (backgroundDepth > 0) {
    backgroundIds.add(id)
    state = { ...state, background: state.background + 1 }
    emit(true)
    return id
  }
  const now = nowMs()
  state = {
    ...state,
    active: state.active + 1,
    total: state.total + Math.max(0, totalBytes),
    startedAt: state.active === 0 ? (state.startedAt ?? now) : state.startedAt,
    lastProgressAt: state.active === 0 ? now : (state.lastProgressAt ?? now),
  }
  emit(true)
  return id
}

/** Renseigne la taille attendue quand les en-têtes arrivent (0 = inconnue). */
export function setDownloadTotal(id: number, totalBytes: number): void {
  if (totalBytes <= 0 || backgroundIds.has(id)) return
  state = { ...state, total: state.total + totalBytes, lastProgressAt: nowMs() }
  emit(true)
}

/** Ajoute `deltaBytes` octets reçus. */
export function progressDownload(id: number, deltaBytes: number): void {
  if (deltaBytes <= 0 || backgroundIds.has(id)) return
  state = { ...state, received: state.received + deltaBytes, lastProgressAt: nowMs() }
  emit(false)
}

/** Termine un téléchargement. Quand plus aucun n'est actif, reset des compteurs. */
export function endDownload(id: number): void {
  if (backgroundIds.has(id)) {
    backgroundIds.delete(id)
    state = { ...state, background: Math.max(0, state.background - 1) }
    emit(true)
    return
  }
  const active = Math.max(0, state.active - 1)
  state = active === 0
    ? { ...state, active: 0, received: 0, total: 0, startedAt: null, lastProgressAt: null }
    : { ...state, active }
  emit(true)
}

/** performance.now si dispo (monotone), sinon 0 (l'horloge sert au « lent »). */
function nowMs(): number {
  try { return performance.now() } catch { return 0 }
}
