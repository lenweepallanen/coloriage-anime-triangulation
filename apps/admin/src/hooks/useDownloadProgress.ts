import { useEffect, useState, useSyncExternalStore } from 'react'
import { getDownloadSnapshot, subscribeDownloads } from '../utils/downloadProgress'

/** Blocage (ms) sans AUCUN octet reçu au-delà duquel la connexion est jugée « lente ».
 *  (Avant : durée totale de la rafale > 4 s — dépassée à chaque 1er scan, même en
 *  bon Wi-Fi, ce qui affichait le message à tort.) */
const STALL_MS = 5000

export interface DownloadProgress {
  /** Un ou plusieurs téléchargements de PREMIER PLAN sont en cours. */
  active: boolean
  /** Ratio 0..1 si la taille totale est connue, sinon null (barre indéterminée). */
  ratio: number | null
  /** Octets reçus / attendus (0 = inconnu). */
  received: number
  total: number
  /** Aucun octet reçu depuis STALL_MS → afficher le message « connexion lente ». */
  slow: boolean
}

/**
 * Progression AGRÉGÉE des téléchargements Storage de premier plan + drapeau
 * « lent ». Le drapeau est réévalué via un intervalle tant qu'un téléchargement
 * est actif (l'état octets seul ne re-render pas quand aucun octet n'arrive —
 * connexion gelée = justement le cas « lent » à signaler).
 */
export function useDownloadProgress(): DownloadProgress {
  const snap = useSyncExternalStore(subscribeDownloads, getDownloadSnapshot, getDownloadSnapshot)
  // Horloge de re-rendu : tant qu'un téléchargement est actif, on se réveille toutes les
  // 500 ms pour réévaluer « lent » (aucun octet n'arrive = aucun événement du store).
  const [now, setNow] = useState(() => nowMs())
  useEffect(() => {
    if (snap.active === 0) return
    const timer = window.setInterval(() => setNow(nowMs()), 500)
    return () => window.clearInterval(timer)
  }, [snap.active])

  const slow = snap.active > 0 && snap.lastProgressAt != null && now - snap.lastProgressAt >= STALL_MS

  return {
    active: snap.active > 0,
    ratio: snap.total > 0 ? Math.min(1, snap.received / snap.total) : null,
    received: snap.received,
    total: snap.total,
    slow,
  }
}

function nowMs(): number {
  try { return performance.now() } catch { return 0 }
}
