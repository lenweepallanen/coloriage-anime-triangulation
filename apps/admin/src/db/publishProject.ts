import { doc, updateDoc, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'
import { logAudit } from './audit'

/**
 * Bascule le flag `published` d'un projet sans toucher au reste du document.
 * Met aussi à jour `publishedAt` au premier passage à true.
 */
export async function setProjectPublished(projectId: string, published: boolean): Promise<void> {
  const ref = doc(db, 'projects', projectId)
  await updateDoc(ref, {
    published,
    ...(published ? { publishedAt: serverTimestamp() } : {}),
  })
  await logAudit(published ? 'project.publish' : 'project.unpublish', projectId)
}

/**
 * Génère l'URL publique du projet côté play. Lue depuis VITE_PLAY_BASE_URL,
 * fallback sur https://play.NDD (à configurer en prod via Vercel env var).
 */
export function buildPlayUrl(projectId: string): string {
  const base = (import.meta.env.VITE_PLAY_BASE_URL ?? 'https://play.NDD').replace(/\/+$/, '')
  return `${base}/p/${projectId}`
}
