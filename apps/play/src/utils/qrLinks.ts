/**
 * Liens « coloriage » et « livre » (contenu des QR codes, liens universels, Install Referrer) :
 * analyse + résolution de la destination dans l'app. Partagé par le scanner (QR lu dans l'app) et
 * par les liens entrants (QR lu avec l'appareil photo, app installée → ouverture directe).
 */
import { getBook } from '@shared/db/booksStore'
import { loadProjectForPlayEssential } from '@shared/db/projectsStore'
import { getBookDownloadProgress, isBookAdded, isBookDownloaded, startBackgroundBookDownload } from './bookDownload'

export type ScannedLink = { type: 'project' | 'book'; id: string }

/** `…/p/{id}` → coloriage ; `…/livre/{id}` → livre ; sinon null. Accepte aussi `project=` / `book=` (Install Referrer). */
export function parseQr(data: string): ScannedLink | null {
  const project = data.match(/\/p\/([A-Za-z0-9_-]+)/) ?? data.match(/(?:^|[?&])project=([A-Za-z0-9_-]+)/)
  if (project) return { type: 'project', id: project[1] }
  const book = data.match(/\/livre\/([A-Za-z0-9_-]+)/) ?? data.match(/(?:^|[?&])book=([A-Za-z0-9_-]+)/)
  if (book) return { type: 'book', id: book[1] }
  return null
}

/** Ajoute le livre s'il n'est ni ajouté ni en cours d'ajout. */
export async function ensureBookAdded(bookId: string): Promise<'added' | 'present' | 'unavailable'> {
  const book = await getBook(bookId)
  if (!book || book.published !== true) return 'unavailable'
  if (getBookDownloadProgress(book.id) || isBookAdded(book)) return 'present'
  startBackgroundBookDownload(book)
  return 'added'
}

/**
 * Destination dans l'app pour un lien lu HORS scanner (lien universel, Install Referrer) :
 * même logique que le scanner, sans les sons ni les messages. null = contenu indisponible.
 *  - livre : ajouté/complet → page du livre, sinon accueil (anneau de progression) ;
 *  - coloriage : son livre s'ajoute tout seul ; livre pas encore complet → accueil, sinon caméra directe.
 */
export async function resolveScannedLink(link: ScannedLink): Promise<string | null> {
  if (link.type === 'book') {
    const result = await ensureBookAdded(link.id)
    if (result === 'unavailable') return null
    const book = await getBook(link.id)
    const openable = book != null && isBookDownloaded(book) && getBookDownloadProgress(link.id) == null
    return openable ? `/livre/${link.id}` : '/'
  }
  const project = await loadProjectForPlayEssential(link.id)
  if (!project || project.published !== true) return null
  if (project.bookId) {
    const result = await ensureBookAdded(project.bookId).catch(() => 'unavailable' as const)
    const book = result === 'unavailable' ? null : await getBook(project.bookId).catch(() => undefined)
    const ready = book != null && isBookDownloaded(book) && getBookDownloadProgress(project.bookId) == null
    if (result !== 'unavailable' && !ready) return '/'
  }
  return `/p/${link.id}?autocam=1`
}
