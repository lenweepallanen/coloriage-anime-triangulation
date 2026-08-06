import { useEffect, useState, useSyncExternalStore } from 'react'
import { getDownloadSnapshot, subscribeDownloads } from '../utils/downloadProgress'

/** Seuil (ms) au-delà duquel une rafale de téléchargements est jugée « lente ». */
const SLOW_AFTER_MS = 4000

export interface DownloadProgress {
  /** Un ou plusieurs téléchargements sont en cours. */
  active: boolean
  /** Ratio 0..1 si la taille totale est connue, sinon null (barre indéterminée). */
  ratio: number | null
  /** Octets reçus / attendus (0 = inconnu). */
  received: number
  total: number
  /** La rafale dure au-delà du seuil → afficher le message « connexion lente ». */
  slow: boolean
}

/**
 * Progression AGRÉGÉE des téléchargements Storage en cours + drapeau « lent ».
 * Réévalue le drapeau lent via un intervalle tant qu'un téléchargement est actif
 * (l'état octets seul ne re-render pas quand aucun octet n'arrive — connexion
 * gelée = justement le cas « lent » à signaler).
 */
export function useDownloadProgress(): DownloadProgress {
  const snap = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot, getDownloadSnapshot)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    if (snap.active === 0 || snap.startedAt == null) {
      setSlow(false)
      return
    }
    const check = () => {
      const elapsed = (typeof performance !== 'undefined' ? performance.now() : 0) - (snap.startedAt ?? 0)
      setSlow(elapsed >= SLOW_AFTER_MS)
    }
    check()
    const timer = window.setInterval(check, 500)
    return () => window.clearInterval(timer)
  }, [snap.active, snap.startedAt])

  return {
    active: snap.active > 0,
    ratio: snap.total > 0 ? Math.min(1, snap.received / snap.total) : null,
    received: snap.received,
    total: snap.total,
    slow,
  }
}
