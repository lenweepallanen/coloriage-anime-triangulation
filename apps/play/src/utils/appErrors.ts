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
  kind: 'react' | 'error' | 'unhandledrejection'
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
}
