import { ref, getMetadata, getDownloadURL } from 'firebase/storage'
import { storage } from './firebase'
import { beginDownload, setDownloadTotal, progressDownload, endDownload } from '../utils/downloadProgress'

/**
 * Cache local des blobs Cloud Storage (IndexedDB).
 *
 * Stratégie : validation par `generation` Storage (change à chaque overwrite).
 * - En ligne : une requête metadata légère (~100 ms) compare la génération ;
 *   si identique → lecture locale instantanée, sinon re-téléchargement.
 * - Hors ligne / erreur réseau : le cache est servi tel quel (mode offline).
 * - Objet supprimé côté Storage : entrée purgée, retourne null.
 *
 * Bénéficie surtout à l'app native PLAY (chargement instantané + offline),
 * mais aussi au web (best-effort, IndexedDB évincible par le navigateur).
 * Si IndexedDB est indisponible (navigation privée...), fallback silencieux
 * en téléchargement direct.
 */

const DB_NAME = 'coloriage-blob-cache'
const STORE = 'blobs'

interface CacheEntry {
  path: string
  generation: string
  blob: Blob
  cachedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'path' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

async function idbGet(path: string): Promise<CacheEntry | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(path)
      req.onsuccess = () => resolve((req.result as CacheEntry | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbPut(entry: CacheEntry): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(entry)
  } catch { /* best-effort */ }
}

async function idbDelete(path: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(path)
  } catch { /* best-effort */ }
}

/** Compteurs de debug consultables via window.__blobCacheStats */
const stats = { hits: 0, misses: 0, offline: 0 }
;(globalThis as Record<string, unknown>).__blobCacheStats = stats

/**
 * Télécharge un blob Storage avec cache local. Remplaçant direct des
 * `getDownloadURL` + `fetch` des stores. Retourne null si l'objet n'existe
 * pas (ou pas de cache en mode hors ligne).
 */
export async function cachedDownloadBlob(path: string): Promise<Blob | null> {
  const cached = await idbGet(path)
  const storageRef = ref(storage, path)

  let generation: string
  try {
    generation = (await getMetadata(storageRef)).generation
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'storage/object-not-found') {
      if (cached) void idbDelete(path)
      return null
    }
    // Hors ligne / erreur transitoire → on sert le cache si disponible
    if (cached) stats.offline++
    return cached?.blob ?? null
  }

  if (cached && cached.generation === generation) {
    stats.hits++
    return cached.blob
  }

  // Le suivi démarre AVANT la résolution d'URL et la requête : un blocage avant les
  // en-têtes (DNS, TLS, serveur lent) compte comme « aucun octet reçu ».
  const id = beginDownload(0)
  try {
    const url = await getDownloadURL(storageRef)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await readBlobWithProgress(response, id)
    stats.misses++
    void idbPut({ path, generation, blob, cachedAt: Date.now() })
    return blob
  } catch (err) {
    console.warn(`[blobCache] Download failed for ${path}:`, err)
    return cached?.blob ?? null
  } finally {
    endDownload(id)
  }
}

/**
 * Lit le corps de la réponse en flux pour alimenter le suivi de progression
 * GLOBAL (barre + message « connexion lente » côté play). Repli sur
 * `response.blob()` si le streaming n'est pas disponible (vieux navigateurs).
 */
async function readBlobWithProgress(response: Response, id: number): Promise<Blob> {
  const totalBytes = Number(response.headers.get('content-length')) || 0
  const type = response.headers.get('content-type') || ''
  setDownloadTotal(id, totalBytes)
  const body = response.body
  if (!body || typeof body.getReader !== 'function') return response.blob()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) { chunks.push(value); progressDownload(id, value.length) }
  }
  return new Blob(chunks as BlobPart[], type ? { type } : undefined)
}

/** À appeler après un upload/suppression pour invalider l'entrée locale. */
export function invalidateBlobCache(path: string): void {
  void idbDelete(path)
}
