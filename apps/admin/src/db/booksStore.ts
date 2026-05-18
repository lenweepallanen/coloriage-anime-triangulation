import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where,
} from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage } from './firebase'
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
}

function booksCol() {
  return collection(db, 'books')
}

function bookRef(id: string) {
  return doc(db, 'books', id)
}

async function uploadBlob(path: string, blob: Blob): Promise<void> {
  await uploadBytes(ref(storage, path), blob)
}

async function downloadBlob(path: string): Promise<Blob | null> {
  try {
    const url = await getDownloadURL(ref(storage, path))
    const res = await fetch(url)
    return await res.blob()
  } catch {
    return null
  }
}

function toDoc(book: Book): BookDoc {
  return {
    id: book.id,
    name: book.name,
    createdAt: book.createdAt,
    hasCover: book.coverImageBlob != null,
    published: book.published === true,
    publishedAt: book.publishedAt ?? null,
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
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    coverImageBlob,
    published: d.published === true,
    publishedAt: d.publishedAt ?? null,
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
    }
  })
}

export async function getBookCover(bookId: string): Promise<Blob | null> {
  return downloadBlob(`books/${bookId}/cover`)
}

export type BookUploadHint = 'cover'

export async function updateBook(book: Book, uploadOnly?: BookUploadHint[]): Promise<void> {
  await setDoc(bookRef(book.id), toDoc(book))
  if (!uploadOnly) return
  const uploads: Promise<void>[] = []
  for (const hint of uploadOnly) {
    if (hint === 'cover' && book.coverImageBlob) {
      uploads.push(uploadBlob(`books/${book.id}/cover`, book.coverImageBlob))
    }
  }
  await Promise.all(uploads)
  await logAudit('book.update', book.id)
}

export async function deleteBook(id: string): Promise<void> {
  // Détache d'abord les projets du livre (mais ne les supprime PAS)
  const projSnap = await getDocs(query(collection(db, 'projects'), where('bookId', '==', id)))
  await Promise.all(projSnap.docs.map(d => setProjectBook(d.id, null)))

  // Supprime cover storage
  await deleteObject(ref(storage, `books/${id}/cover`)).catch(() => {})
  await deleteDoc(bookRef(id))
  await logAudit('book.delete', id)
}

/** Duplique un projet vers un livre cible (override bookId + nom + bookOrder). */
export async function duplicateProjectIntoBook(sourceProjectId: string, targetBookId: string | null): Promise<Project> {
  return duplicateProject(sourceProjectId, { bookId: targetBookId, bookOrder: Date.now() })
}
