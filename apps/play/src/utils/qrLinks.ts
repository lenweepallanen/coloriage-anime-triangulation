/**
 * Liens « coloriage » et « livre » (contenu des QR codes, liens universels, Install Referrer) :
 * analyse + résolution de la destination dans l'app. Partagé par le scanner (QR lu dans l'app) et
 * par les liens entrants (QR lu avec l'appareil photo, app installée → ouverture directe).
 */
import { getBook } from '@shared/db/booksStore'
import { getProject } from '@shared/db/projectsStore'
import { ensureProjectReady, getBookDownloadProgress, isBookAdded, isBookOpenable, isProjectDownloaded, startBackgroundBookDownload } from './bookDownload'
import { setLinkLoading } from './linkLoading'

export type ScannedLink = { type: 'project' | 'book'; id: string }

/** `…/p/{id}` → coloriage ; `…/livre/{id}` → livre ; sinon null. Accepte aussi `project=` / `book=` (Install Referrer). */
export function parseQr(data: string): ScannedLink | null {
  const project = data.match(/\/p\/([A-Za-z0-9_-]+)/) ?? data.match(/(?:^|[?&])project=([A-Za-z0-9_-]+)/)
  if (project) return { type: 'project', id: project[1] }
  const book = data.match(/\/livre\/([A-Za-z0-9_-]+)/) ?? data.match(/(?:^|[?&])book=([A-Za-z0-9_-]+)/)
  if (book) return { type: 'book', id: book[1] }
  return null
}

/** Ajoute le livre s'il n'est ni ajouté ni en cours d'ajout (`priorityProjectId` : coloriage à charger en premier). */
export async function ensureBookAdded(bookId: string, priorityProjectId?: string): Promise<'added' | 'present' | 'unavailable'> {
  const book = await getBook(bookId)
  if (!book || book.published !== true) return 'unavailable'
  if (getBookDownloadProgress(book.id) || isBookAdded(book)) return 'present'
  startBackgroundBookDownload(book, priorityProjectId)
  return 'added'
}

/**
 * Destination dans l'app pour un lien lu hors scanner (lien universel, Install Referrer) ou dans le scanner :
 *  - livre : ajouté → page du livre dès qu'il est ouvrable (premier coloriage prêt), sinon accueil (anneau) ;
 *  - coloriage : son livre s'ajoute tout seul avec CE coloriage en tête de file ; s'il n'est pas encore prêt, la popup
 *    de chargement s'affiche le temps de le pré-charger, puis caméra directe. Plus de détour par le menu.
 * null = contenu indisponible.
 */
export async function resolveScannedLink(link: ScannedLink): Promise<string | null> {
  if (link.type === 'book') {
    const result = await ensureBookAdded(link.id)
    if (result === 'unavailable') return null
    const book = await getBook(link.id)
    return book != null && isBookOpenable(book) ? `/livre/${link.id}` : '/'
  }
  const project = await getProject(link.id)   // document seul : publié ? livre ? vignette ?
  if (!project || project.published !== true) return null
  if (project.bookId) await ensureBookAdded(project.bookId, link.id).catch(() => 'unavailable' as const)
  if (!isProjectDownloaded(project)) {
    setLinkLoading({ done: 0, total: 3 })
    try {
      await ensureProjectReady(project, (done, total) => setLinkLoading({ done, total }))
    } finally {
      setLinkLoading(null)
    }
  }
  return `/p/${link.id}?autocam=1`
}
