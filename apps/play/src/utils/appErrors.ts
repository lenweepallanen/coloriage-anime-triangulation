/**
 * Journal des erreurs de l'app play (diagnostic des plantages).
 *
 * Garde les 20 dernières erreurs (rendu React, exceptions non rattrapées, promesses
 * rejetées) dans `localStorage` sous `picopop.errors`, avec l'écran courant et
 * l'horodatage. Rien ne quitte l'appareil : c'est lisible via Safari Web Inspector
 * (`localStorage.getItem('picopop.errors')`) ou le panneau « À propos ».
 */

export interface AppErrorEntry {
  at: string
  kind: 'react' | 'error' | 'unhandledrejection' | 'restart'
  message: string
  stack?: string
  route: string
  scanStage?: string
}

const KEY = 'picopop.errors'
const MAX = 20

export function readAppErrors(): AppErrorEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as AppErrorEntry[] } catch { return [] }
}

export function logAppError(kind: AppErrorEntry['kind'], err: unknown, extra?: string): void {
  const message = err instanceof Error ? err.message : String(err)
  const stack = (err instanceof Error ? err.stack : undefined) ?? extra
  const entry: AppErrorEntry = {
    at: new Date().toISOString(),
    kind,
    message,
    stack: stack ? stack.slice(0, 2000) : undefined,
    route: typeof location !== 'undefined' ? location.pathname : '',
    scanStage: typeof document !== 'undefined' ? document.body.dataset.scanStage : undefined,
  }
  console.error('[picopop]', kind, message)
  try {
    const list = readAppErrors()
    list.push(entry)
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)))
  } catch { /* stockage indisponible */ }
}

let installed = false
/** Capture globale des exceptions et des promesses rejetées (une fois). */
export function installGlobalErrorLogging(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => { logAppError('error', e.error ?? e.message) })
  window.addEventListener('unhandledrejection', (e) => { logAppError('unhandledrejection', e.reason) })
  installRestartDetector()
}

/**
 * Mouchard de REDÉMARRAGE : un plantage de la WebView (pression mémoire iOS) ne
 * lève aucune erreur JS — l'app repart simplement à zéro. On écrit un battement
 * (écran, étape de scan, mémoire JS) toutes les secondes pendant un scan ; au
 * démarrage suivant, un battement récent (< 60 s) sur une étape de scan prouve
 * que l'app est morte en plein scan → journalisé comme `restart` avec l'étape.
 */
const ALIVE_KEY = 'picopop.alive'
function installRestartDetector(): void {
  try {
    const raw = localStorage.getItem(ALIVE_KEY)
    if (raw) {
      const last = JSON.parse(raw) as { at: number; route: string; stage?: string; heapMb?: number }
      const ageS = (Date.now() - last.at) / 1000
      if (last.stage && ageS < 60) {
        logAppError('restart', `redémarrage ${Math.round(ageS)} s après un battement en étape « ${last.stage} » (${last.route}${last.heapMb ? `, JS ${last.heapMb} Mo` : ''})`)
      }
    }
    localStorage.removeItem(ALIVE_KEY)
  } catch { /* stockage indisponible */ }
  const beat = () => {
    try {
      const stage = document.body.dataset.scanStage
      if (!stage) { localStorage.removeItem(ALIVE_KEY); return }
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
      localStorage.setItem(ALIVE_KEY, JSON.stringify({ at: Date.now(), route: location.pathname, stage, heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined }))
    } catch { /* stockage indisponible */ }
  }
  window.setInterval(beat, 1000)
  // Sortie propre (fermeture par l'utilisateur, mise en arrière-plan) : pas un plantage.
  window.addEventListener('pagehide', () => { try { localStorage.removeItem(ALIVE_KEY) } catch { /* */ } })
}
