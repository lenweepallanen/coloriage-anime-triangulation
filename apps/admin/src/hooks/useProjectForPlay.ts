import { useEffect, useState } from 'react'
import { loadProjectForPlayEssential, loadProjectForPlayDeferred } from '../db/projectsStore'
import type { Project } from '../types/project'

/**
 * Charge un projet pour la lecture côté play, en deux phases :
 * 1. essential (bloquant) : image + meshes finaux + métadonnées (zones, scène, triangulation).
 *    → suffit pour afficher l'UI scan et démarrer la pré-correction de perspective.
 * 2. deferred (arrière-plan) : audio ambient, vidéo de fond, calques de scène, sons de speak,
 *    audio par animation. Le projet est mis à jour dès que ces données arrivent.
 *
 * Le composant consommateur peut afficher l'UI dès que `loading === false` (phase 1 terminée),
 * et tester si un blob spécifique est null pour savoir si la phase 2 est en cours.
 */
export function useProjectForPlay(projectId: string) {
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [deferredLoaded, setDeferredLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDeferredLoaded(false)
    setProject(null)

    loadProjectForPlayEssential(projectId)
      .then(essential => {
        if (cancelled || !essential) {
          if (!cancelled) setLoading(false)
          return
        }
        setProject(essential)
        setLoading(false)
        // Phase 2 : on charge en arrière-plan, sans bloquer.
        loadProjectForPlayDeferred(essential)
          .then(full => {
            if (cancelled) return
            setProject(full)
            setDeferredLoaded(true)
          })
          .catch(err => {
            console.warn('[useProjectForPlay] deferred load failed', err)
            if (!cancelled) setDeferredLoaded(true)
          })
      })
      .catch(err => {
        console.error('[useProjectForPlay] essential load failed', err)
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId])

  return { project, loading, deferredLoaded }
}
