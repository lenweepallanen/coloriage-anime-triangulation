import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import jsQR from 'jsqr'
import { getBook } from '@shared/db/booksStore'
import { loadProjectForPlayEssential } from '@shared/db/projectsStore'
import { getBookDownloadProgress, isBookAdded, isBookDownloaded, startBackgroundBookDownload } from '../utils/bookDownload'
import { playUi } from '@shared/utils/uiSound'
import { useI18n } from '../i18n'
import Mascot from '@shared/components/mascot/Mascot'

/**
 * Onglet SCAN : la caméra s'ouvre directement et reconnaît toute seule le QR
 * code visé — aucune étape manuelle, aucune confirmation.
 *
 * - QR livre (…/livre/{id}) : le livre s'ajoute et son téléchargement démarre
 *   en arrière-plan ; retour au menu où la carte affiche la progression.
 *   Livre déjà ajouté → ouverture du livre.
 * - QR coloriage (…/p/{id}) : si le livre qui contient ce coloriage n'est pas
 *   encore ajouté, il s'ajoute automatiquement (téléchargement en arrière-plan),
 *   puis le coloriage s'ouvre directement sur la caméra de scan.
 * - QR inconnu : message bref, la caméra continue.
 */

type Status =
  | { kind: 'scanning' }
  | { kind: 'camera-error' }
  | { kind: 'message'; text: string }
  | { kind: 'success'; text: string }

function parseQr(data: string): { type: 'project' | 'book'; id: string } | null {
  const project = data.match(/\/p\/([A-Za-z0-9_-]+)/)
  if (project) return { type: 'project', id: project[1] }
  const book = data.match(/\/livre\/([A-Za-z0-9_-]+)/)
  if (book) return { type: 'book', id: book[1] }
  return null
}

/** Ajoute le livre s'il n'est ni ajouté ni en cours d'ajout. Renvoie true si un ajout a démarré. */
async function ensureBookAdded(bookId: string): Promise<'added' | 'present' | 'unavailable'> {
  const book = await getBook(bookId)
  if (!book || book.published !== true) return 'unavailable'
  if (getBookDownloadProgress(book.id) || isBookAdded(book)) return 'present'
  startBackgroundBookDownload(book)
  return 'added'
}

export default function ScannerPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [status, setStatus] = useState<Status>({ kind: 'scanning' })

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef(0)
  const handlingRef = useRef(false)
  const lastDecodeRef = useRef(0)
  const qrFileRef = useRef<HTMLInputElement | null>(null)

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
        await ensureBookAdded(project.bookId).catch(() => 'unavailable')
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
  }, [flashMessage, navigate, stopCamera, t])

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

  // Décodage d'un QR depuis une IMAGE choisie (Photos) — utile sans caméra
  // (simulateur, caméra HS) ou pour un QR reçu en capture d'écran.
  const handleImportQr = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const maxSide = 1200
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) { URL.revokeObjectURL(url); return }
        ctx.drawImage(img, 0, 0, w, h)
        const data = ctx.getImageData(0, 0, w, h)
        const code = jsQR(data.data, w, h)
        URL.revokeObjectURL(url)
        handlingRef.current = false
        if (code?.data) handleDecoded(code.data)
        else { playUi('error'); flashMessage(t('scanner.unknown')) }
      } catch {
        URL.revokeObjectURL(url)
        flashMessage(t('scanner.unknown'))
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); flashMessage(t('scanner.unknown')) }
    img.src = url
  }, [handleDecoded, flashMessage, t])

  // Caméra + boucle de décodage (jsQR sur frame réduite, ~7 fois/s)
  useEffect(() => {
    let cancelled = false
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
        const scale = 480 / Math.max(video.videoWidth, video.videoHeight)
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

    ;(async () => {
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
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
        }
        setStatus({ kind: 'scanning' })
        handlingRef.current = false
        rafRef.current = requestAnimationFrame(tick)
      } catch (err) {
        console.warn('[scanner] caméra indisponible', err)
        if (!cancelled) setStatus({ kind: 'camera-error' })
      }
    })()

    return () => {
      cancelled = true
      stopCamera()
    }
  }, [handleDecoded, stopCamera])

  return (
    <div className="scanner-page">
      <div className="scan-header">
        <h1 className="scan-header-title">{t('scanner.camera.title')}</h1>
        <p className="scan-header-sub">{t('scanner.camera.any')}</p>
      </div>

      <input
        ref={qrFileRef}
        type="file"
        accept="image/*"
        onChange={handleImportQr}
        style={{ display: 'none' }}
      />

      {status.kind === 'camera-error' ? (
        <div className="placeholder-card soft-card scanner-error-card">
          <Mascot size={80} mood="oops" />
          <p className="text-preline">{t('scanner.camera.error')}</p>
          <button className="scanner-import-qr" onClick={() => qrFileRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="m4.5 17 4.5-4.5 3.5 3.5 3-3 4 4" />
            </svg>
            {t('scanner.importQr')}
          </button>
        </div>
      ) : (
        <>
          <div className="scanner-camera-card soft-card">
            <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
            <div className="camera-corners" aria-hidden="true"><i /><i /><i /><i /></div>
          </div>
          <button className="scanner-import-qr" onClick={() => qrFileRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <circle cx="9" cy="10" r="1.6" />
              <path d="m4.5 17 4.5-4.5 3.5 3.5 3-3 4 4" />
            </svg>
            {t('scanner.importQr')}
          </button>
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
