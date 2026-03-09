import { useState, useEffect, useCallback } from 'react'
import { getProject, updateProject } from '../db/projectsStore'
import type { Project } from '../types/project'

export function useProject(projectId: string) {
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
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

  const save = useCallback(async (updated: Project) => {
    await updateProject(updated)
    setProject(updated)
  }, [])

  return { project, loading, save }
}
