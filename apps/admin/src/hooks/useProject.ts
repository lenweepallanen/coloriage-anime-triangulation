import { useState, useEffect, useCallback } from 'react'
import { getProject, updateProject, type UploadHint } from '../db/projectsStore'
import type { Project } from '../types/project'

export function useProject(projectId: string | null | undefined) {
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(!!projectId)

  useEffect(() => {
    if (!projectId) {
      setProject(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    getProject(projectId).then(p => {
      if (!cancelled) {
        setProject(p ?? null)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [projectId])

  const save = useCallback(async (updated: Project, uploadOnly?: UploadHint[]) => {
    await updateProject(updated, uploadOnly)
    setProject(updated)
  }, [])

  /** Mise à jour LOCALE de l'état (sans écriture Firestore/Storage). À utiliser quand
   *  la persistance a déjà été faite par un chemin dédié (ex. setProjectPublished). */
  const patchLocal = useCallback((partial: Partial<Project>) => {
    setProject(prev => (prev ? { ...prev, ...partial } : prev))
  }, [])

  return { project, loading, save, patchLocal }
}
