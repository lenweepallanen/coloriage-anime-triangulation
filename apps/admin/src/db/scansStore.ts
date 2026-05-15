import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getBlob, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Scan } from '../types/project'

interface ScanDoc {
  id: string
  projectId: string
  scannedAt: number
}

function scanRef(id: string) {
  return doc(db, 'scans', id)
}

export async function createScan(projectId: string, scanImageBlob: Blob): Promise<Scan> {
  const id = crypto.randomUUID()
  const scanDoc: ScanDoc = {
    id,
    projectId,
    scannedAt: Date.now(),
  }

  await Promise.all([
    setDoc(scanRef(id), scanDoc),
    uploadBytes(ref(storage, `scans/${id}/scanImage`), scanImageBlob),
  ])

  return {
    id,
    projectId,
    scannedAt: scanDoc.scannedAt,
    scanImageBlob,
    textureMap: null,
  }
}

export async function getScan(id: string): Promise<Scan | undefined> {
  const snap = await getDoc(scanRef(id))
  if (!snap.exists()) return undefined
  const data = snap.data() as ScanDoc

  let scanImageBlob: Blob
  try {
    scanImageBlob = await getBlob(ref(storage, `scans/${id}/scanImage`))
  } catch {
    return undefined
  }

  return {
    id: data.id,
    projectId: data.projectId,
    scannedAt: data.scannedAt,
    scanImageBlob,
    textureMap: null,
  }
}

export async function getScansByProject(projectId: string): Promise<Scan[]> {
  const snap = await getDocs(
    query(collection(db, 'scans'), where('projectId', '==', projectId))
  )
  // Return metadata only for listing (no blob download)
  return snap.docs.map(d => {
    const data = d.data() as ScanDoc
    return {
      id: data.id,
      projectId: data.projectId,
      scannedAt: data.scannedAt,
      scanImageBlob: new Blob(), // placeholder — download on demand
      textureMap: null,
    }
  })
}

export async function updateScan(scan: Scan): Promise<void> {
  const scanDoc: ScanDoc = {
    id: scan.id,
    projectId: scan.projectId,
    scannedAt: scan.scannedAt,
  }
  await Promise.all([
    setDoc(scanRef(scan.id), scanDoc),
    uploadBytes(ref(storage, `scans/${scan.id}/scanImage`), scan.scanImageBlob),
  ])
}

export async function deleteScan(id: string): Promise<void> {
  await Promise.all([
    deleteDoc(scanRef(id)),
    deleteObject(ref(storage, `scans/${id}/scanImage`)).catch(() => {}),
  ])
}
