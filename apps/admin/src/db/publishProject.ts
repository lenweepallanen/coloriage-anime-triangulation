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
 * Base publique côté play. Lue depuis VITE_PLAY_BASE_URL (configurée en prod via
 * Vercel env var), fallback sur l'URL Vercel par défaut. Garde-fou : si la var est
 * mal configurée sur le domaine admin, on la réécrit vers le domaine play pour que
 * le lien USER ne pointe jamais vers l'admin.
 */
function playBaseUrl(): string {
  const base = (import.meta.env.VITE_PLAY_BASE_URL ?? 'https://coloriage-anime-play.vercel.app').replace(/\/+$/, '')
  return base.replace('coloriage-anime-admin', 'coloriage-anime-play')
}

export function buildPlayUrl(projectId: string): string {
  return `${playBaseUrl()}/p/${projectId}`
}

/**
 * Base admin. Lue depuis VITE_ADMIN_BASE_URL, fallback sur l'URL Vercel admin.
 * Garde-fou symétrique : si la var pointe par erreur vers le domaine play, on la
 * réécrit vers le domaine admin pour que le lien ADMIN ouvre bien le mode debug.
 */
function adminBaseUrl(): string {
  const base = (import.meta.env.VITE_ADMIN_BASE_URL ?? 'https://coloriage-anime-admin.vercel.app').replace(/\/+$/, '')
  return base.replace('coloriage-anime-play', 'coloriage-anime-admin')
}

/** Lien scanner en mode ADMIN (debug complet) : `${adminBaseUrl}/scan/{projectId}`. */
export function buildAdminScanUrl(projectId: string): string {
  return `${adminBaseUrl()}/scan/${projectId}`
}

export function buildBookPlayUrl(bookId: string): string {
  return `${playBaseUrl()}/livre/${bookId}`
}

/** URL de preview locale (dev) — basé sur VITE_PLAY_LOCAL_URL ou fallback 5175. */
export function buildBookPlayUrlLocal(bookId: string): string {
  const base = (import.meta.env.VITE_PLAY_LOCAL_URL ?? 'https://localhost:5175').replace(/\/+$/, '')
  return `${base}/livre/${bookId}`
}

export function buildPlayUrlLocal(projectId: string): string {
  const base = (import.meta.env.VITE_PLAY_LOCAL_URL ?? 'https://localhost:5175').replace(/\/+$/, '')
  return `${base}/p/${projectId}`
}

export async function setBookPublished(bookId: string, published: boolean): Promise<void> {
  const ref = doc(db, 'books', bookId)
  await updateDoc(ref, {
    published,
    ...(published ? { publishedAt: serverTimestamp() } : {}),
  })
  await logAudit(published ? 'book.publish' : 'book.unpublish', bookId)
}
