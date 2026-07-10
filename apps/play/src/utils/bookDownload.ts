import {
  getProjectsByBook,
  loadProjectForPlayEssential,
  loadProjectForPlayDeferred,
  getProjectThumbnailBlob,
  getProjectThumbnail,
} from '@shared/db/projectsStore'
import type { Book } from '@shared/types/project'

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

export function isBookDownloaded(book: Book): boolean {
  try {
    const t = Number(localStorage.getItem(keyFor(book.id)) ?? 0)
    return t > 0 && t >= (book.publishedAt ?? 0)
  } catch {
    return false
  }
}

export async function downloadBook(
  book: Book,
  onProgress: (done: number, total: number) => void,
): Promise<void> {
  const projects = await getProjectsByBook(book.id, true)
  const total = projects.length
  let done = 0
  onProgress(done, total)

  // Séquentiel : limite la mémoire (les blobs chargés sont relâchés entre
  // deux coloriages) et donne une progression lisible.
  for (const p of projects) {
    try {
      // Vignette du menu livre (petite, best-effort)
      if (p.hasThumbnail) await getProjectThumbnailBlob(p.id)
      else await getProjectThumbnail(p.id)
    } catch { /* non bloquant */ }

    const essential = await loadProjectForPlayEssential(p.id)
    if (essential) {
      await loadProjectForPlayDeferred(essential).catch(() => { /* non bloquant */ })
    }
    done++
    onProgress(done, total)
  }

  try {
    localStorage.setItem(keyFor(book.id), String(Date.now()))
  } catch { /* stockage indisponible : le cache blobs reste rempli quand même */ }
}
