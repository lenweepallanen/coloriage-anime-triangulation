import { getAllProjects, ensureProjectThumbnail, type EnsureThumbnailResult } from './projectsStore'

export interface BackfillProgress {
  /** Nombre de projets traités jusqu'ici (1-based). */
  index: number
  total: number
  projectId: string
  name: string
  result: EnsureThumbnailResult
}

export interface BackfillSummary {
  total: number
  /** Vignette (re)générée et uploadée. */
  generated: number
  /** Sautés car ils avaient déjà une vignette (mode non-force). */
  skipped: number
  /** Pas d'image originale → rien à réduire. */
  noImage: number
  /** Échecs (erreur réseau / droits / image illisible). */
  failed: number
}

/**
 * Parcourt TOUS les projets de la base et garantit une vignette légère pour chacun —
 * l'équivalent d'un « dépublier → republier » manuel sur chaque coloriage, mais en un
 * seul passage.
 *
 * À lancer depuis la console du navigateur dans l'app ADMIN (auth requise pour écrire) :
 *   await backfillThumbnails()                 // saute ceux qui ont déjà une vignette
 *   await backfillThumbnails({ force: true })  // régénère TOUT depuis l'image originale
 *
 * Tolérant : un projet en échec n'interrompt pas les autres. Concurrence limitée pour
 * ne pas saturer le réseau / Storage.
 */
export async function backfillAllThumbnails(opts?: {
  force?: boolean
  concurrency?: number
  onProgress?: (p: BackfillProgress) => void
}): Promise<BackfillSummary> {
  const force = opts?.force ?? false
  const concurrency = Math.max(1, opts?.concurrency ?? 3)

  const projects = await getAllProjects()
  const total = projects.length
  const summary: BackfillSummary = { total, generated: 0, skipped: 0, noImage: 0, failed: 0 }

  let cursor = 0
  let done = 0

  async function worker() {
    while (cursor < total) {
      const p = projects[cursor++]
      const result = await ensureProjectThumbnail(p.id, undefined, { force })
      if (result === 'generated') summary.generated++
      else if (result === 'skipped-existing') summary.skipped++
      else if (result === 'no-image') summary.noImage++
      else summary.failed++ // 'error' | 'not-found'
      done++
      opts?.onProgress?.({ index: done, total, projectId: p.id, name: p.name, result })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
  return summary
}
