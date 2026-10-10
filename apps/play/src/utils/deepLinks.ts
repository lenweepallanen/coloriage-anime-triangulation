/**
 * Liens entrants dans l'app NATIVE :
 *  - lien universel / App Link (QR scanné avec l'appareil photo, app installée) → `appUrlOpen` ou URL de lancement ;
 *  - Android : Install Referrer du Play Store (`…&project=<id>`) lu UNE fois au premier lancement → le coloriage
 *    scanné avant l'installation est retrouvé (deferred deep link). iOS n'a pas d'équivalent : l'utilisateur rescanne.
 * La destination est calculée comme pour un QR lu dans le scanner (utils/qrLinks).
 */
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { parseQr, resolveScannedLink } from './qrLinks'
import { logAppError } from './appErrors'

const InstallReferrer = registerPlugin<{ get(): Promise<{ referrer?: string }> }>('InstallReferrer')
const REFERRER_KEY = 'picopop.installReferrerDone'

export function useDeepLinks() {
  const navigate = useNavigate()
  useEffect(() => {
    if (Capacitor.getPlatform() === 'web') return
    let disposed = false
    let remove: (() => void) | null = null

    const open = async (url: string, source: string) => {
      const link = parseQr(url)
      if (!link) return
      try {
        const to = await resolveScannedLink(link)
        if (!disposed && to) navigate(to)
      } catch (err) {
        logAppError(`lien entrant (${source})`, err)
      }
    }

    void import('@capacitor/app').then(async ({ App }) => {
      const handle = await App.addListener('appUrlOpen', ({ url }) => { void open(url, 'appUrlOpen') })
      remove = () => { void handle.remove() }
      const launch = await App.getLaunchUrl().catch(() => null)
      if (launch?.url) void open(launch.url, 'launchUrl')
    })

    if (Capacitor.getPlatform() === 'android') {
      let done = false
      try { done = localStorage.getItem(REFERRER_KEY) === '1' } catch { /* stockage indisponible */ }
      if (!done) {
        try { localStorage.setItem(REFERRER_KEY, '1') } catch { /* idem */ }
        void InstallReferrer.get()
          .then(({ referrer }) => { if (referrer) void open(referrer, 'installReferrer') })
          .catch(() => { /* plugin absent ou store inaccessible : rien à faire */ })
      }
    }

    return () => { disposed = true; remove?.() }
  }, [navigate])
}
