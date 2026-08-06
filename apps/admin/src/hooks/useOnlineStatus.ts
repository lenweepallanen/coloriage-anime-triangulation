import { useEffect, useState } from 'react'

/**
 * Statut en ligne / hors ligne (navigator.onLine + événements online/offline).
 * Fiable partout, y compris WKWebView iOS (contrairement à navigator.connection).
 * Sert à afficher une bannière « Pas de connexion » côté PLAY.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => {
    try { return navigator.onLine } catch { return true }
  })
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
