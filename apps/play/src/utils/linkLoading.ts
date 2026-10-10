/** Popup « on prépare ton coloriage » : état global minuscule (QR lu dans le scanner OU lien entrant, hors de toute page). */
import { useSyncExternalStore } from 'react'

export interface LinkLoadingState { done: number; total: number }
let state: LinkLoadingState | null = null
const subs = new Set<() => void>()

export function setLinkLoading(next: LinkLoadingState | null): void {
  state = next
  subs.forEach(cb => cb())
}
export function useLinkLoading(): LinkLoadingState | null {
  return useSyncExternalStore(cb => { subs.add(cb); return () => { subs.delete(cb) } }, () => state)
}
