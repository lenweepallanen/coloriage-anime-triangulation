import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import jsQR from 'jsqr'
import { getBook, getBookCover } from '@shared/db/booksStore'
import type { Book } from '@shared/types/project'
import { isBookDownloaded, startBackgroundBookDownload } from '../utils/bookDownload'
import { playUi } from '@shared/utils/uiSound'
import { useI18n } from '../i18n'
import Mascot from '@shared/components/mascot/Mascot'

/**
 * Onglet SCANNER : lecture des QR codes imprimés dans les livres papier.
 *
 * - Écran de choix : « Ajouter un livre » / « Scanner un coloriage »
 *   (le mode adapte les consignes ; la carte + de MES LIVRES arrive
 *   directement en mode livre via /scanner?mode=livre).
 * - QR coloriage (…/p/{id}) → pipeline scan.
 * - QR livre (…/livre/{id}) → ajout dans MES LIVRES (pré-chargement des
 *   assets) ; si déjà ajouté → « Livre déjà ajouté ! » puis ouverture.
 * - Tolérant : un QR valide de l'autre type que le mode choisi est quand
 *   même traité (on ne bloque jamais un enfant).
 */

type Mode = 'choice' | 'book' | 'coloring'
type Status =
  | { kind: 'scanning' }
  | { kind: 'camera-error' }
  | { kind: 'message'; text: string }
  | { kind: 'confirm'; book: Book; coverUrl: string | null; launching?: boolean }
  | { kind: 'success'; text: string }

function parseQr(data: string): { type: 'project' | 'book'; id: string } | null {
  const project = data.match(/\/p\/([A-Za-z0-9_-]+)/)
  if (project) return { type: 'project', id: project[1] }
  const book = data.match(/\/livre\/([A-Za-z0-9_-]+)/)
  if (book) return { type: 'book', id: book[1] }
  return null
}

export default function ScannerPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const [mode, setMode] = useState<Mode>(() =>
    searchParams.get('mode') === 'livre' ? 'book' : 'choice',
  )
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

  const handleBookQr = useCallback(async (id: string) => {
    try {
      const book = await getBook(id)
      if (!book || book.published !== true) {
        flashMessage(t('scanner.book.notfound'))
        return
      }
      playUi('scanDing')
      if (isBookDownloaded(book)) {
        setStatus({ kind: 'success', text: t('scanner.book.already') })
        setTimeout(() => {
          stopCamera()
          navigate(`/livre/${id}`)
        }, 1400)
        return
      }
      // Aperçu du livre (couverture + titre) avant l'ajout
      const cover = await getBookCover(id).catch(() => null)
      const coverUrl = cover ? URL.createObjectURL(cover) : null
      setStatus({ kind: 'confirm', book, coverUrl })
    } catch (err) {
      console.error('[scanner] lecture livre échouée', err)
      flashMessage(t('home.error1'))
    }
  }, [flashMessage, navigate, stopCamera, t])

  const confirmAdd = useCallback((book: Book, coverUrl: string | null) => {
    // Le popup passe en mode « Ajout du livre en cours… », le pré-chargement
    // part en arrière-plan, puis retour au menu (badge de progression sur la
    // carte du livre — il est ouvrable immédiatement).
    setStatus({ kind: 'confirm', book, coverUrl, launching: true })
    playUi('success')
    startBackgroundBookDownload(book)
    setTimeout(() => {
      if (coverUrl) URL.revokeObjectURL(coverUrl)
      stopCamera()
      navigate('/')
    }, 1400)
  }, [navigate, stopCamera])

  const cancelConfirm = useCallback((coverUrl: string | null) => {
    if (coverUrl) URL.revokeObjectURL(coverUrl)
    setStatus({ kind: 'scanning' })
    handlingRef.current = false
  }, [])

  const handleDecoded = useCallback((data: string) => {
    if (handlingRef.current) return
    handlingRef.current = true
    const parsed = parseQr(data)
    if (!parsed) {
      playUi('error')
      flashMessage(t('scanner.unknown'))
      return
    }
    if (parsed.type === 'project') {
      playUi('scanDing')
      stopCamera()
      // autocam=1 : la caméra du pipeline scan démarre directement (elle
      // était déjà ouverte pour lire le QR — pas de ré-écran « Prêt à scanner ? »)
      navigate(`/p/${parsed.id}?autocam=1`)
      return
    }
    void handleBookQr(parsed.id)
  }, [flashMessage, handleBookQr, navigate, stopCamera, t])

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
    if (mode === 'choice') return
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
  }, [mode, handleDecoded, stopCamera])

  if (mode === 'choice') {
    return (
      <div className="scanner-page">
        <div className="page-mascot-row"><Mascot size={84} gaze="pointer" /></div>
        <h1 className="section-title">{t('scanner.choice.title')}</h1>
        <div className="scanner-choices">
          <button className="scanner-choice soft-card" onClick={() => setMode('book')}>
            <span className="scanner-choice-icon scanner-choice-icon--book" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 6.5C10.5 5 8.5 4.5 5.5 4.5c-.8 0-1.5.7-1.5 1.5v11c0 .8.7 1.5 1.5 1.5 3 0 5 .5 6.5 2 1.5-1.5 3.5-2 6.5-2 .8 0 1.5-.7 1.5-1.5V6c0-.8-.7-1.5-1.5-1.5-3 0-5 .5-6.5 2Z" />
                <path d="M12 6.5v14" />
              </svg>
            </span>
            <span className="scanner-choice-texts">
              <strong>{t('scanner.choice.book')}</strong>
              <small>{t('scanner.choice.book.sub')}</small>
            </span>
          </button>
          <button className="scanner-choice soft-card" onClick={() => setMode('coloring')}>
            <span className="scanner-choice-icon scanner-choice-icon--coloring" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
                <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
                <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
                <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
                <path d="M4 12h16" />
              </svg>
            </span>
            <span className="scanner-choice-texts">
              <strong>{t('scanner.choice.coloring')}</strong>
              <small>{t('scanner.choice.coloring.sub')}</small>
            </span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="scanner-page">
      <button
        className="scan-back-bar"
        onClick={() => {
          stopCamera()
          setStatus({ kind: 'scanning' })
          handlingRef.current = false
          setMode('choice')
        }}
      >
        ← {t('scanner.back')}
      </button>
      <div className="scan-header">
        <h1 className="scan-header-title">{t('scanner.camera.title')}</h1>
        <p className="scan-header-sub">
          {t(mode === 'book' ? 'scanner.camera.book' : 'scanner.camera.coloring')}
        </p>
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
          {status.kind === 'confirm' && (
            <div className="scanner-confirm-backdrop" role="dialog" aria-modal="true">
              <div className="scanner-confirm soft-card">
                {status.coverUrl ? (
                  <img className="scanner-confirm-cover" src={status.coverUrl} alt={status.book.name} />
                ) : (
                  <span className="scanner-confirm-fallback" aria-hidden="true">📖</span>
                )}
                <strong className="scanner-confirm-title">{status.book.name}</strong>
                {status.launching ? (
                  <div className="scanner-confirm-loading">
                    <span className="boot-spinner boot-spinner--small" />
                    <span>{t('scanner.book.adding')}</span>
                  </div>
                ) : (
                  <>
                    <p className="scanner-confirm-q">{t('scanner.book.confirmQ')}</p>
                    <div className="scanner-confirm-actions">
                      <button className="soft-btn" onClick={() => confirmAdd(status.book, status.coverUrl)}>
                        {t('common.yes')}
                      </button>
                      <button className="soft-btn soft-btn--ghost" onClick={() => cancelConfirm(status.coverUrl)}>
                        {t('common.no')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {status.kind !== 'scanning' && status.kind !== 'confirm' && (
            <div className={`scanner-status ${status.kind === 'success' ? 'scanner-status--success' : ''}`}>
              {status.kind === 'message' || status.kind === 'success' ? (
                <span>{status.text}</span>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  )
}
