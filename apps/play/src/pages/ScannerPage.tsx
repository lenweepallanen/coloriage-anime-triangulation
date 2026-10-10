import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import jsQR from 'jsqr'
import { getBook } from '@shared/db/booksStore'
import { loadProjectForPlayEssential } from '@shared/db/projectsStore'
import { getBookDownloadProgress, isBookDownloaded } from '../utils/bookDownload'
import { parseQr, ensureBookAdded } from '../utils/qrLinks'
import { playUi } from '@shared/utils/uiSound'
import { useI18n } from '../i18n'
import Mascot from '@shared/components/mascot/Mascot'
import { logAppError } from '../utils/appErrors'

/**
 * Onglet SCAN : la caméra s'ouvre directement et reconnaît toute seule le QR
 * code visé — aucune étape manuelle, aucune confirmation.
 *
 * - QR livre (…/livre/{id}) : le livre s'ajoute et son téléchargement démarre
 *   en arrière-plan ; retour au menu où la carte affiche la progression.
 *   Livre déjà ajouté → ouverture du livre.
 * - QR coloriage (…/p/{id}) : le livre qui le contient s'ajoute automatiquement.
 *   Tant qu'il n'est pas téléchargé à 100 % → retour au menu (anneau de
 *   progression, attente lisible, puis tout s'ouvre depuis le cache) ; livre
 *   déjà complet → le coloriage s'ouvre directement sur la caméra.
 * - QR inconnu : message bref, la caméra continue.
 *
 * ROBUSTESSE CAMÉRA (iOS) : la piste vidéo peut revenir muette/suspendue après
 * un passage en arrière-plan, ou ne jamais délivrer d'image si une autre session
 * de capture était encore active (fin de film). La caméra est donc RELANCÉE :
 *  - au retour au premier plan (visibilitychange + App.appStateChange Capacitor) ;
 *  - quand la piste se termine ou passe muette (`ended` / `mute`) ;
 *  - par un chien de garde : 1,5 s sans image → nouvelle acquisition (3 essais,
 *    puis carte d'erreur avec bouton « Réessayer »).
 * L'onglet SCANNER, quand on est déjà sur cette page, pousse `state.reset` pour
 * forcer la même relance (sinon rien ne se passait : même route, pas de remontage).
 */

type Status =
  | { kind: 'scanning' }
  | { kind: 'camera-error' }
  | { kind: 'message'; text: string }
  | { kind: 'success'; text: string }

const WATCHDOG_MS = 1500
const MAX_RESTARTS = 3

// parseQr / ensureBookAdded : utils/qrLinks (partagés avec les liens entrants — lien universel, Install Referrer)

export default function ScannerPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useI18n()
  const [status, setStatus] = useState<Status>({ kind: 'scanning' })
  // Jeton de relance : onglet SCANNER re-tapé (state.reset) ou bouton « Réessayer ».
  const resetToken = (location.state as { reset?: number } | null)?.reset ?? 0
  const [retryToken, setRetryToken] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const handlingRef = useRef(false)
  const lastDecodeRef = useRef(0)

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach(tr => tr.stop())
    streamRef.current = null
  }, [])

  const flashMessage = useCallback((text: string) => {
    setStatus({ kind: 'message', text })
    setTimeout(() => {
      setStatus({ kind: 'scanning' })
      handlingRef.current = false
    }, 2000)
  }, [])

  /** Succès bref (ding + message), puis navigation. */
  const succeedThen = useCallback((text: string, go: () => void, delayMs = 1200) => {
    playUi('scanDing')
    setStatus({ kind: 'success', text })
    setTimeout(() => { stopCamera(); go() }, delayMs)
  }, [stopCamera])

  const handleBookQr = useCallback(async (id: string) => {
    try {
      const result = await ensureBookAdded(id)
      if (result === 'unavailable') { flashMessage(t('scanner.book.notfound')); return }
      if (result === 'present') {
        // Déjà ajouté : on ouvre le livre (s'il se télécharge encore, le menu montre la progression).
        // Encore en téléchargement (ou interrompu) → retour au menu, où l'anneau de progression est visible.
        const book = await getBook(id)
        const openable = book != null && isBookDownloaded(book) && getBookDownloadProgress(id) == null
        succeedThen(t('scanner.book.already'), () => navigate(openable ? `/livre/${id}` : '/'))
        return
      }
      playUi('success')
      succeedThen(t('scanner.book.added'), () => navigate('/'), 1400)
    } catch (err) {
      console.error('[scanner] lecture livre échouée', err)
      flashMessage(t('home.error1'))
    }
  }, [flashMessage, navigate, succeedThen, t])

  const handleProjectQr = useCallback(async (id: string) => {
    try {
      // Lecture Firestore seule (pas d'assets) : suffit pour connaître le livre du coloriage.
      const project = await loadProjectForPlayEssential(id)
      if (!project || project.published !== true) { flashMessage(t('scanner.project.notfound')); return }
      if (project.bookId) {
        // Le livre s'ajoute tout seul ; non bloquant si indisponible.
        const result = await ensureBookAdded(project.bookId).catch(() => 'unavailable' as const)
        // Livre pas encore téléchargé (vient d'être ajouté, ou encore en cours) :
        // RETOUR AU MENU, où l'anneau de progression rend l'attente lisible. Le
        // coloriage s'ouvrira ensuite depuis le cache, sans lenteur pendant le
        // scan. Livre déjà complet → caméra directe (raccourci).
        const book = result === 'unavailable' ? null : await getBook(project.bookId).catch(() => undefined)
        const ready = book != null && isBookDownloaded(book) && getBookDownloadProgress(project.bookId) == null
        if (result !== 'unavailable' && !ready) {
          playUi('success')
          succeedThen(t('scanner.book.added'), () => navigate('/'), 1400)
          return
        }
      }
      playUi('scanDing')
      stopCamera()
      // autocam=1 : la caméra du pipeline scan démarre directement (elle était
      // déjà ouverte pour lire le QR — pas de ré-écran « Prêt à scanner ? »).
      navigate(`/p/${id}?autocam=1`)
    } catch (err) {
      console.error('[scanner] lecture coloriage échouée', err)
      flashMessage(t('home.error1'))
    }
  }, [flashMessage, navigate, stopCamera, succeedThen, t])

  const handleDecoded = useCallback((data: string) => {
    if (handlingRef.current) return
    handlingRef.current = true
    const parsed = parseQr(data)
    if (!parsed) {
      playUi('error')
      flashMessage(t('scanner.unknown'))
      return
    }
    if (parsed.type === 'project') void handleProjectQr(parsed.id)
    else void handleBookQr(parsed.id)
  }, [flashMessage, handleBookQr, handleProjectQr, t])

  // Caméra + boucle de décodage (jsQR sur frame réduite, ~7 fois/s).
  // 640 px (et non 480) : un QR de 27 mm imprimé se lit alors même quand la
  // caméra cadre toute la page A4 (≈ 80 px sur 640), sans devoir s'approcher.
  useEffect(() => {
    let cancelled = false
    let restarts = 0
    let watchdog = 0
    let acquiring = false
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const tick = () => {
      if (cancelled) return
      const video = videoRef.current
      const now = performance.now()
      if (
        video && ctx && !handlingRef.current &&
        video.readyState >= 2 && video.videoWidth > 0 &&
        now - lastDecodeRef.current > 150
      ) {
        lastDecodeRef.current = now
        const scale = 640 / Math.max(video.videoWidth, video.videoHeight)
        const w = Math.round(video.videoWidth * scale)
        const h = Math.round(video.videoHeight * scale)
        canvas.width = w
        canvas.height = h
        ctx.drawImage(video, 0, 0, w, h)
        const img = ctx.getImageData(0, 0, w, h)
        const code = jsQR(img.data, w, h)
        if (code?.data) handleDecoded(code.data)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    /** La piste délivre-t-elle des images ? (iOS : piste muette/suspendue = écran noir sans erreur) */
    const isAlive = () => {
      const video = videoRef.current
      const track = streamRef.current?.getVideoTracks()[0]
      return !!video && !!track && track.readyState === 'live' && !track.muted && video.videoWidth > 0
    }

    const acquire = async (reason: string) => {
      if (cancelled || acquiring) return
      acquiring = true
      window.clearTimeout(watchdog)
      cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach(tr => tr.stop())
      streamRef.current = null
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach(tr => tr.stop())
          return
        }
        streamRef.current = stream
        const track = stream.getVideoTracks()[0]
        track?.addEventListener('ended', () => { void restart('piste terminée') })
        track?.addEventListener('mute', () => { window.setTimeout(() => { if (!isAlive()) void restart('piste muette') }, 600) })
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => { /* autoplay best-effort */ })
        }
        setStatus(s => (s.kind === 'camera-error' || s.kind === 'scanning' ? { kind: 'scanning' } : s))
        handlingRef.current = false
        rafRef.current = requestAnimationFrame(tick)
        // Chien de garde : pas d'image après WATCHDOG_MS → on relance.
        watchdog = window.setTimeout(() => { if (!isAlive()) void restart(`aucune image après ${WATCHDOG_MS} ms`) }, WATCHDOG_MS)
        if (reason !== 'montage') console.log('[scanner] caméra relancée :', reason)
      } catch (err) {
        console.warn('[scanner] caméra indisponible', err)
        logAppError('error', err, `getUserMedia scanner (${reason})`)
        if (!cancelled) setStatus({ kind: 'camera-error' })
      } finally {
        acquiring = false
      }
    }

    const restart = async (reason: string) => {
      if (cancelled) return
      if (restarts >= MAX_RESTARTS) {
        logAppError('error', new Error('caméra sans image'), `scanner : ${reason}, ${restarts} relances`)
        stopCamera()
        setStatus({ kind: 'camera-error' })
        return
      }
      restarts++
      await acquire(reason)
    }

    // Retour au premier plan : iOS peut avoir suspendu la capture et mis la
    // <video> en pause → on relance systématiquement (piste fraîche).
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || cancelled) return
      restarts = 0
      void acquire('retour au premier plan')
    }
    document.addEventListener('visibilitychange', onVisible)
    let removeAppListener: (() => void) | null = null
    void import('@capacitor/app')
      .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => { if (isActive) onVisible() }))
      .then(handle => { if (cancelled) void handle.remove(); else removeAppListener = () => { void handle.remove() } })
      .catch(() => { /* web : pas de plugin */ })

    void acquire('montage')

    return () => {
      cancelled = true
      window.clearTimeout(watchdog)
      document.removeEventListener('visibilitychange', onVisible)
      removeAppListener?.()
      stopCamera()
    }
  }, [handleDecoded, stopCamera, resetToken, retryToken])

  return (
    <div className="scanner-page">
      <div className="scan-header">
        <h1 className="scan-header-title">{t('scanner.camera.title')}</h1>
        <p className="scan-header-sub">{t('scanner.camera.any')}</p>
      </div>

      {status.kind === 'camera-error' ? (
        <div className="placeholder-card soft-card scanner-error-card">
          <Mascot size={80} mood="oops" />
          <p className="text-preline">{t('scanner.camera.error')}</p>
          <button className="soft-btn" onClick={() => { setStatus({ kind: 'scanning' }); setRetryToken(n => n + 1) }}>
            {t('home.retry')}
          </button>
        </div>
      ) : (
        <>
          <div className="scanner-camera-card soft-card">
            <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
            <div className="camera-corners" aria-hidden="true"><i /><i /><i /><i /></div>
          </div>
          {status.kind !== 'scanning' && (
            <div className={`scanner-status ${status.kind === 'success' ? 'scanner-status--success' : ''}`} role="status">
              <span>{status.text}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
