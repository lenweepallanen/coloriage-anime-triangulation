import { addDoc, collection } from 'firebase/firestore'
import { Capacitor } from '@capacitor/core'
import { db } from '@shared/db/firebase'
import { APP_VERSION } from '../config'

/**
 * Événements ANONYMES de l'app (tableau de bord « PicoPop Studio » de l'admin).
 *
 * Ce qui part : un identifiant d'installation ALÉATOIRE (tiré au premier lancement, jamais lié
 * à une personne, un compte, un email ou un identifiant publicitaire), le type d'événement,
 * l'id du livre ou du coloriage concerné, la plateforme, la version de l'app, la langue de
 * l'interface et le jour. Rien d'autre : ni photo, ni scan, ni position, ni adresse IP côté app.
 *
 * Types :
 *   install     1ʳᵉ ouverture de l'app sur cet appareil (une seule fois)
 *   book_added  livre ajouté (une seule fois par livre et par appareil)
 *   scan        coloriage scanné et validé (le film démarre)
 *   share       vidéo d'un coloriage partagée (feuille de partage ouverte avec succès)
 *
 * Envoi non bloquant : en cas d'échec (hors ligne, Firestore indisponible) l'événement est
 * gardé dans une petite file locale et renvoyé au prochain lancement / retour du réseau.
 * Règle Firestore `appEvents` : création publique au contenu strictement borné, lecture admin.
 */

export type AppEventType = 'install' | 'book_added' | 'scan' | 'share'

interface QueuedEvent {
  installId: string
  type: AppEventType
  bookId?: string
  projectId?: string
  platform: 'ios' | 'android' | 'web'
  appVersion: string
  lang: string
  day: string
  ts: number
}

const INSTALL_KEY = 'picopop.installId'
const QUEUE_KEY = 'picopop.eventQueue'
const SENT_PREFIX = 'picopop.eventSent:'
const QUEUE_MAX = 100
const SEND_TIMEOUT_MS = 8000

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* stockage indisponible : on ne bloque rien */ }
}

/** Identifiant d'installation aléatoire, créé au premier appel. */
export function getInstallId(): string {
  let id = read(INSTALL_KEY)
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
    write(INSTALL_KEY, id)
  }
  return id
}

function platform(): QueuedEvent['platform'] {
  const p = Capacitor.getPlatform()
  return p === 'ios' || p === 'android' ? p : 'web'
}

function loadQueue(): QueuedEvent[] {
  try { const q = JSON.parse(read(QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : [] } catch { return [] }
}
function saveQueue(q: QueuedEvent[]): void {
  write(QUEUE_KEY, JSON.stringify(q.slice(-QUEUE_MAX)))
}

async function send(ev: QueuedEvent): Promise<void> {
  const payload: Record<string, string | number> = { installId: ev.installId, type: ev.type, platform: ev.platform, appVersion: ev.appVersion, lang: ev.lang, day: ev.day, ts: ev.ts }
  if (ev.bookId) payload.bookId = ev.bookId
  if (ev.projectId) payload.projectId = ev.projectId
  await Promise.race([
    addDoc(collection(db, 'appEvents'), payload),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), SEND_TIMEOUT_MS)),
  ])
}

let flushing = false
/** Renvoie les événements en attente (au lancement et au retour du réseau). */
export async function flushAppEvents(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    let queue = loadQueue()
    while (queue.length > 0) {
      try {
        await send(queue[0])
        queue = queue.slice(1)
        saveQueue(queue)
      } catch {
        break // on réessaiera plus tard
      }
    }
  } finally {
    flushing = false
  }
}

/** Enregistre un événement (envoi immédiat, file locale en cas d'échec). Jamais bloquant. */
export function trackAppEvent(type: AppEventType, ref: { bookId?: string; projectId?: string } = {}): void {
  // Dédoublonnage des événements « une seule fois »
  const onceKey = type === 'install' ? `${SENT_PREFIX}install` : type === 'book_added' && ref.bookId ? `${SENT_PREFIX}book:${ref.bookId}` : null
  if (onceKey && read(onceKey)) return
  if (onceKey) write(onceKey, '1')

  const ev: QueuedEvent = {
    installId: getInstallId(),
    type,
    ...(ref.bookId ? { bookId: ref.bookId } : {}),
    ...(ref.projectId ? { projectId: ref.projectId } : {}),
    platform: platform(),
    appVersion: APP_VERSION,
    lang: (typeof navigator !== 'undefined' ? navigator.language : 'zz').slice(0, 2).toLowerCase(),
    day: new Date().toISOString().slice(0, 10),
    ts: Date.now(),
  }
  saveQueue([...loadQueue(), ev])
  void flushAppEvents()
}

/** À appeler une fois au démarrage : événement d'installation + reprise de la file. */
export function initAppEvents(): void {
  trackAppEvent('install')
  if (typeof window !== 'undefined') window.addEventListener('online', () => { void flushAppEvents() })
}
