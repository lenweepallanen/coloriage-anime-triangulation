/**
 * Stockage LOCAL (IndexedDB, par appareil) des vidéos de film enregistrées.
 * UNE vidéo max par coloriage (keyPath = projectId, `put` = écrasement).
 * Rien n'est envoyé sur Firebase — la copie durable côté utilisateur est la
 * galerie Photos (cf. saveToGallery côté app play).
 */

const DB_NAME = 'picopop-film-videos'
const STORE = 'videos'

export interface FilmVideoRecord {
  projectId: string
  createdAt: number
  mimeType: string
  durationMs: number
  blob: Blob
  /** Vignette JPEG extraite à 1/3 de la durée (galerie, posters). */
  posterBlob?: Blob | null
  /** Nom du coloriage au moment de l'enregistrement (affichage galerie). */
  projectName?: string
}

/** Miroir localStorage pour lecture SYNCHRONE (gates/badges) — pattern `scanned:`. */
const markerKey = (projectId: string) => `filmVideo:${projectId}`

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'projectId' })
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

export async function saveFilmVideo(
  projectId: string,
  video: { blob: Blob; mimeType: string; durationMs: number; posterBlob?: Blob | null; projectName?: string },
): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise(resolve => {
    try {
      const record: FilmVideoRecord = {
        projectId,
        createdAt: Date.now(),
        mimeType: video.mimeType,
        durationMs: video.durationMs,
        blob: video.blob,
        posterBlob: video.posterBlob ?? null,
        projectName: video.projectName,
      }
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(record)
      tx.oncomplete = () => {
        try { localStorage.setItem(markerKey(projectId), String(record.createdAt)) } catch { /* */ }
        resolve(true)
      }
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

export async function getFilmVideo(projectId: string): Promise<FilmVideoRecord | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(projectId)
      req.onsuccess = () => resolve((req.result as FilmVideoRecord | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

export async function deleteFilmVideo(projectId: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(projectId)
  } catch { /* best-effort */ }
  try { localStorage.removeItem(markerKey(projectId)) } catch { /* */ }
}

/**
 * Poster (frame à 1/3 de la durée) d'un enregistrement : retourne celui stocké,
 * sinon le GÉNÈRE depuis la vidéo puis le persiste (couvre les vidéos
 * enregistrées avant l'ajout des posters ou dont l'extraction avait échoué).
 */
export async function getFilmVideoPoster(record: FilmVideoRecord): Promise<Blob | null> {
  if (record.posterBlob) return record.posterBlob
  const { generateVideoPoster } = await import('../utils/videoPoster')
  const poster = await generateVideoPoster(record.blob).catch(() => null)
  if (!poster) return null
  record.posterBlob = poster
  const db = await openDb()
  if (db) {
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(record) } catch { /* best-effort */ }
  }
  return poster
}

/** Toutes les vidéos enregistrées (galerie de l'app), plus récentes d'abord. */
export async function listAllFilmVideos(): Promise<FilmVideoRecord[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () => {
        const list = (req.result as FilmVideoRecord[] | undefined) ?? []
        resolve([...list].sort((a, b) => b.createdAt - a.createdAt))
      }
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

/** Test SYNCHRONE (miroir localStorage) — pour les gates au montage. */
export function hasFilmVideo(projectId: string): boolean {
  try {
    return localStorage.getItem(markerKey(projectId)) != null
  } catch {
    return false
  }
}
