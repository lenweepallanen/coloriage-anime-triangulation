import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where,
} from 'firebase/firestore'
import { ref, uploadBytes, deleteObject } from 'firebase/storage'
import { db, storage } from './firebase'
import { cachedDownloadBlob, invalidateBlobCache } from './blobCache'
import { logAudit } from './audit'
import { setProjectBook, duplicateProject } from './projectsStore'
import type { Book, Project } from '../types/project'

interface BookDoc {
  id: string
  name: string
  createdAt: number
  hasCover: boolean
  published?: boolean
  publishedAt?: number | null
  unlisted?: boolean
  amazonUrl?: string
  bonusUrl?: string
  hasBonusImage?: boolean
}

function booksCol() {
  return collection(db, 'books')
}

function bookRef(id: string) {
  return doc(db, 'books', id)
}

async function uploadBlob(path: string, blob: Blob): Promise<void> {
  await uploadBytes(ref(storage, path), blob, { cacheControl: 'public, max-age=31536000, immutable' })
  invalidateBlobCache(path)
}

async function downloadBlob(path: string): Promise<Blob | null> {
  return cachedDownloadBlob(path)
}

function toDoc(book: Book): BookDoc {
  return {
    id: book.id,
    name: book.name,
    createdAt: book.createdAt,
    hasCover: book.coverImageBlob != null,
    published: book.published === true,
    publishedAt: book.publishedAt ?? null,
    unlisted: book.unlisted === true,
    amazonUrl: book.amazonUrl || 'amazon.com',
    bonusUrl: book.bonusUrl || 'amazon.com',
    hasBonusImage: book.bonusImageBlob != null,
  }
}

export async function createBook(name: string): Promise<Book> {
  const book: Book = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    coverImageBlob: null,
    published: false,
    publishedAt: null,
    unlisted: false,
    amazonUrl: 'amazon.com',
    bonusUrl: 'amazon.com',
    bonusImageBlob: null,
  }
  await setDoc(bookRef(book.id), toDoc(book))
  await logAudit('book.create', book.id, { name })
  return book
}

export async function getBook(id: string): Promise<Book | undefined> {
  const snap = await getDoc(bookRef(id))
  if (!snap.exists()) return undefined
  const d = snap.data() as BookDoc
  const coverImageBlob = d.hasCover ? await downloadBlob(`books/${id}/cover`) : null
  const bonusImageBlob = d.hasBonusImage ? await downloadBlob(`books/${id}/bonus`) : null
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    coverImageBlob,
    published: d.published === true,
    publishedAt: d.publishedAt ?? null,
    unlisted: d.unlisted === true,
    amazonUrl: d.amazonUrl || 'amazon.com',
    bonusUrl: d.bonusUrl || 'amazon.com',
    bonusImageBlob,
  }
}

export async function getAllBooks(): Promise<Book[]> {
  const snap = await getDocs(booksCol())
  return snap.docs.map(d => {
    const data = d.data() as BookDoc
    return {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      coverImageBlob: null,
      published: data.published === true,
      publishedAt: data.publishedAt ?? null,
      unlisted: data.unlisted === true,
      amazonUrl: data.amazonUrl || 'amazon.com',
      bonusUrl: data.bonusUrl || 'amazon.com',
      bonusImageBlob: null,
    }
  })
}

/**
 * Liste uniquement les livres publiés (métadonnées seules, sans blobs).
 * Contrairement à `getAllBooks`, la requête est contrainte à `published == true`,
 * ce qui satisfait la règle Firestore de lecture publique : utilisable côté PLAY
 * (non authentifié) sans erreur de permissions.
 */
export async function getPublishedBooks(): Promise<Book[]> {
  const snap = await getDocs(query(booksCol(), where('published', '==', true)))
  return snap.docs.map(d => {
    const data = d.data() as BookDoc
    return {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      coverImageBlob: null,
      published: true,
      publishedAt: data.publishedAt ?? null,
      unlisted: data.unlisted === true,
      amazonUrl: data.amazonUrl || 'amazon.com',
      bonusUrl: data.bonusUrl || 'amazon.com',
      bonusImageBlob: null,
    }
  })
}

export async function getBookCover(bookId: string): Promise<Blob | null> {
  return downloadBlob(`books/${bookId}/cover`)
}

export async function getBookBonusImage(bookId: string): Promise<Blob | null> {
  return downloadBlob(`books/${bookId}/bonus`)
}

export type BookUploadHint = 'cover' | 'bonus'

export async function updateBook(book: Book, uploadOnly?: BookUploadHint[]): Promise<void> {
  await setDoc(bookRef(book.id), toDoc(book))
  if (!uploadOnly) return
  const uploads: Promise<void>[] = []
  for (const hint of uploadOnly) {
    if (hint === 'cover' && book.coverImageBlob) {
      uploads.push(uploadBlob(`books/${book.id}/cover`, book.coverImageBlob))
    }
    if (hint === 'bonus' && book.bonusImageBlob) {
      uploads.push(uploadBlob(`books/${book.id}/bonus`, book.bonusImageBlob))
    }
  }
  await Promise.all(uploads)
  await logAudit('book.update', book.id)
}

export async function deleteBook(id: string): Promise<void> {
  // Détache d'abord les projets du livre (mais ne les supprime PAS)
  const projSnap = await getDocs(query(collection(db, 'projects'), where('bookId', '==', id)))
  await Promise.all(projSnap.docs.map(d => setProjectBook(d.id, null)))

  // Supprime cover + bonus storage
  await deleteObject(ref(storage, `books/${id}/cover`)).catch(() => {})
  await deleteObject(ref(storage, `books/${id}/bonus`)).catch(() => {})
  await deleteDoc(bookRef(id))
  await logAudit('book.delete', id)
}

/** Duplique un projet vers un livre cible (override bookId + nom + bookOrder). */
export async function duplicateProjectIntoBook(sourceProjectId: string, targetBookId: string | null): Promise<Project> {
  return duplicateProject(sourceProjectId, { bookId: targetBookId, bookOrder: Date.now() })
}
