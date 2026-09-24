import {
  getProjectsByBook,
  loadProjectForPlayEssential,
  loadProjectForPlayDeferred,
  getProjectThumbnailBlob,
  getProjectThumbnail,
} from '@shared/db/projectsStore'
import type { Book } from '@shared/types/project'
import { runAsBackgroundDownloads } from '@shared/utils/downloadProgress'

/**
 * Téléchargement d'un livre = pré-chargement de tous les assets de ses
 * coloriages publiés. Les téléchargements passent par le blobCache (IndexedDB),
 * donc une fois le livre "téléchargé", ouvrir un coloriage est instantané et
 * fonctionne hors ligne.
 *
 * L'état "téléchargé" est un simple marqueur localStorage horodaté : si le
 * livre est republié après coup (publishedAt plus récent), le badge
 * téléchargement réapparaît et un nouveau passage re-valide/re-télécharge
 * uniquement ce qui a changé (validation par génération Storage).
 */

const keyFor = (bookId: string) => `bookDownloadedAt:${bookId}`
/** Livre AJOUTÉ (scan du QR) mais dont le pré-chargement n'est pas encore terminé :
 *  il apparaît dans MES LIVRES avec son anneau de progression, et le
 *  téléchargement reprend automatiquement au prochain passage sur l'accueil
 *  (l'app a pu être fermée entre-temps). */
const addedKeyFor = (bookId: string) => `bookAddedAt:${bookId}`

/* ---------------------------------------------------------------------
   Téléchargement EN ARRIÈRE-PLAN : le livre est marqué « ajouté »
   immédiatement (il apparaît dans MES LIVRES et peut être ouvert tout de
   suite — les assets manquants se chargent à la demande via le blobCache),
   pendant que le pré-chargement complet tourne en tâche de fond avec une
   progression observable (badge sur la carte du livre).
   ------------------------------------------------------------------- */

export interface BookDownloadProgress {
  /** Étapes terminées (3 par coloriage : vignette, essentiel, différé). */
  done: number
  total: number
}

const inFlight: Record<string, BookDownloadProgress> = {}
/** Livres dont le téléchargement vient de se terminer (signal « prêt ! » à consommer par l'accueil). */
const justCompleted = new Set<string>()
const listeners = new Set<() => void>()

/** Pourcentage 0–100 du téléchargement en cours (0 tant que la liste des coloriages n'est pas connue). */
export function getBookDownloadPercent(bookId: string): number | null {
  const p = inFlight[bookId]
  if (!p) return null
  return p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
}

/** Vrai UNE fois, juste après la fin du téléchargement du livre (pour l'animation « prêt »). */
export function consumeBookJustCompleted(bookId: string): boolean {
  return justCompleted.delete(bookId)
}

function notifyDownloadListeners(): void {
  listeners.forEach(cb => cb())
}

/** S'abonner aux changements de progression des téléchargements de livres. */
export function subscribeBookDownloads(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

export function getBookDownloadProgress(bookId: string): BookDownloadProgress | null {
  return inFlight[bookId] ?? null
}

/**
 * Ajoute le livre immédiatement (MES LIVRES) et lance le pré-chargement des
 * assets en arrière-plan. Idempotent si un téléchargement est déjà en cours.
 */
export function startBackgroundBookDownload(book: Book): void {
  if (inFlight[book.id]) return
  try {
    localStorage.setItem(addedKeyFor(book.id), String(Date.now()))
  } catch { /* stockage indisponible */ }
  inFlight[book.id] = { done: 0, total: 0 }
  notifyDownloadListeners()
  downloadBook(book, (done, total) => {
    inFlight[book.id] = { done, total }
    notifyDownloadListeners()
  })
    .catch(err => {
      // Non bloquant : les assets manquants se chargeront à la demande.
      console.warn('[bookDownload] pré-chargement arrière-plan incomplet', err)
    })
    .finally(() => {
      delete inFlight[book.id]
      justCompleted.add(book.id)
      notifyDownloadListeners()
    })
}

/** Retire le livre de MES LIVRES (les assets restent en cache, inoffensif). */
export function removeBook(bookId: string): void {
  try {
    localStorage.removeItem(keyFor(bookId))
    localStorage.removeItem(addedKeyFor(bookId))
  } catch { /* stockage indisponible */ }
}

/** Téléchargement TERMINÉ (et pas périmé par une republication). */
export function isBookDownloaded(book: Book): boolean {
  try {
    const t = Number(localStorage.getItem(keyFor(book.id)) ?? 0)
    return t > 0 && t >= (book.publishedAt ?? 0)
  } catch {
    return false
  }
}

/** Livre présent dans MES LIVRES : téléchargé, ou ajouté et en attente de la fin du pré-chargement. */
export function isBookAdded(book: Book): boolean {
  if (isBookDownloaded(book)) return true
  try {
    return Number(localStorage.getItem(addedKeyFor(book.id)) ?? 0) > 0
  } catch {
    return false
  }
}

/** Livre ajouté dont le pré-chargement n'est pas fini (en cours, ou interrompu par une fermeture de l'app). */
export function isBookPending(book: Book): boolean {
  return isBookAdded(book) && !isBookDownloaded(book)
}

/** Relance les pré-chargements interrompus (appelé à l'affichage de l'accueil). */
export function resumePendingBookDownloads(books: Book[]): void {
  for (const b of books) {
    if (isBookPending(b) && !inFlight[b.id]) startBackgroundBookDownload(b)
  }
}

export async function downloadBook(
  book: Book,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const projects = await getProjectsByBook(book.id, true)
  // 3 étapes par coloriage → progression lisible même pour un livre d'un seul coloriage.
  const total = projects.length * 3
  let done = 0
  onProgress(done, total)

  // Séquentiel : limite la mémoire (les blobs chargés sont relâchés entre
  // deux coloriages) et donne une progression lisible.
  for (const p of projects) {
    // Un scan est en cours (étape caméra/preview/film) : on laisse toute la
    // bande passante et la mémoire au scan, le pré-chargement reprend après.
    await waitWhileScanning()
    try {
      // Vignette du menu livre (petite, best-effort)
      await runAsBackgroundDownloads(() => p.hasThumbnail ? getProjectThumbnailBlob(p.id) : getProjectThumbnail(p.id))
    } catch { /* non bloquant */ }
    done++
    onProgress(done, total)

    const essential = await runAsBackgroundDownloads(() => loadProjectForPlayEssential(p.id))
    done++
    onProgress(done, total)
    if (essential) {
      await runAsBackgroundDownloads(() => loadProjectForPlayDeferred(essential)).catch(() => { /* non bloquant */ })
    }
    done++
    onProgress(done, total)
  }

  try {
    localStorage.setItem(keyFor(book.id), String(Date.now()))
  } catch { /* stockage indisponible : le cache blobs reste rempli quand même */ }
}

/** Attend (poll 500 ms) tant qu'une page de scan est affichée (`body[data-scan-stage]`). */
function waitWhileScanning(): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      if (typeof document === 'undefined' || document.body.dataset.scanStage == null) resolve()
      else window.setTimeout(check, 500)
    }
    check()
  })
}
