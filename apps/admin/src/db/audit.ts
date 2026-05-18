import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { auth, db } from './firebase'

export type AuditAction =
  | 'project.create'
  | 'project.delete'
  | 'project.duplicate'
  | 'project.publish'
  | 'project.unpublish'
  | 'project.move'
  | 'animation.delete'
  | 'book.create'
  | 'book.update'
  | 'book.delete'
  | 'book.publish'
  | 'book.unpublish'

/**
 * Log an admin write to Firestore. Best-effort : si l'écriture échoue (offline,
 * rules), on continue silencieusement — l'action principale ne doit pas être
 * bloquée par l'audit.
 */
export async function logAudit(action: AuditAction, projectId: string, details?: Record<string, unknown>): Promise<void> {
  const user = auth.currentUser
  if (!user) return
  try {
    await addDoc(collection(db, 'auditLog'), {
      uid: user.uid,
      email: user.email ?? null,
      action,
      projectId,
      timestamp: serverTimestamp(),
      ...(details ? { details } : {}),
    })
  } catch (e) {
    console.warn('[audit] write failed:', e)
  }
}
