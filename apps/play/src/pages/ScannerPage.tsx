import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import jsQR from 'jsqr'
import { getBook } from '@shared/db/booksStore'
import { isBookDownloaded, downloadBook } from '../utils/bookDownload'
import { useI18n } from '../i18n'

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
  | { kind: 'adding'; done: number; total: number }
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
      if (isBookDownloaded(book)) {
        setStatus({ kind: 'success', text: t('scanner.book.already') })
        setTimeout(() => {
          stopCamera()
          navigate(`/livre/${id}`)
        }, 1400)
        return
      }
      setStatus({ kind: 'adding', done: 0, total: 0 })
      await downloadBook(book, (done, total) => setStatus({ kind: 'adding', done, total }))
      stopCamera()
      navigate(`/livre/${id}`)
    } catch (err) {
      console.error('[scanner] ajout livre échoué', err)
      flashMessage(t('home.error1'))
    }
  }, [flashMessage, navigate, stopCamera, t])

  const handleDecoded = useCallback((data: string) => {
    if (handlingRef.current) return
    handlingRef.current = true
    const parsed = parseQr(data)
    if (!parsed) {
      flashMessage(t('scanner.unknown'))
      return
    }
    if (parsed.type === 'project') {
      stopCamera()
      navigate(`/p/${parsed.id}`)
      return
    }
    void handleBookQr(parsed.id)
  }, [flashMessage, handleBookQr, navigate, stopCamera, t])

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
        className="book-home-btn"
        onClick={() => {
          stopCamera()
          setStatus({ kind: 'scanning' })
          handlingRef.current = false
          setMode('choice')
        }}
      >
        ← {t('scanner.back')}
      </button>
      <h1 className="scanner-camera-title">
        {t(mode === 'book' ? 'scanner.camera.book' : 'scanner.camera.coloring')}
      </h1>

      {status.kind === 'camera-error' ? (
        <div className="placeholder-card soft-card" style={{ margin: '24px auto', maxWidth: 380 }}>
          <span className="placeholder-icon" aria-hidden="true">📷</span>
          <p style={{ whiteSpace: 'pre-line' }}>{t('scanner.camera.error')}</p>
        </div>
      ) : (
        <>
          <div className="scanner-camera-card soft-card">
            <video ref={videoRef} className="scanner-video" playsInline muted autoPlay />
            <div className="scanner-viewfinder" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="#ffffff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
                <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
                <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
                <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
              </svg>
            </div>
          </div>
          {status.kind !== 'scanning' && (
            <div className={`scanner-status ${status.kind === 'success' ? 'scanner-status--success' : ''}`}>
              {status.kind === 'adding' ? (
                <>
                  <span className="boot-spinner boot-spinner--small" />
                  <span>
                    {t('scanner.book.adding')}
                    {status.total > 0 && ` ${status.done}/${status.total}`}
                  </span>
                </>
              ) : status.kind === 'message' || status.kind === 'success' ? (
                <span>{status.text}</span>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  )
}
