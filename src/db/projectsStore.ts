import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, Point2D } from '../types/project'

// Firestore doc shape (no blobs, no videoFramesMesh)
// Firestore doesn't support nested arrays, so triangles are stored as objects
interface TriangleDoc { a: number; b: number; c: number }

interface ProjectDoc {
  id: string
  name: string
  createdAt: number
  hasImage: boolean
  hasVideo: boolean
  mesh: {
    contourPoints: Point2D[]
    internalPoints: Point2D[]
    triangles: TriangleDoc[]
    hasVideoFramesMesh: boolean
  } | null
  markers: Project['markers']
}

function projectsCol() {
  return collection(db, 'projects')
}

function projectRef(id: string) {
  return doc(db, 'projects', id)
}

async function uploadBlob(path: string, blob: Blob): Promise<void> {
  const storageRef = ref(storage, path)
  await uploadBytes(storageRef, blob)
}

async function downloadBlob(path: string): Promise<Blob | null> {
  try {
    const storageRef = ref(storage, path)
    const url = await getDownloadURL(storageRef)
    const response = await fetch(url)
    return await response.blob()
  } catch (err) {
    console.warn(`[Storage] Download failed for ${path}:`, err)
    return null
  }
}

function toDoc(project: Project): ProjectDoc {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    hasImage: project.originalImageBlob != null,
    hasVideo: project.videoBlob != null,
    mesh: project.mesh ? {
      contourPoints: project.mesh.contourPoints,
      internalPoints: project.mesh.internalPoints,
      triangles: project.mesh.triangles.map(([a, b, c]) => ({ a, b, c })),
      hasVideoFramesMesh: project.mesh.videoFramesMesh != null,
    } : null,
    markers: project.markers,
  }
}

async function fromDoc(data: ProjectDoc): Promise<Project> {
  const id = data.id

  const [imageBlob, videoBlob] = await Promise.all([
    data.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    data.hasVideo ? downloadBlob(`projects/${id}/video`) : Promise.resolve(null),
  ])

  let videoFramesMesh: Point2D[][] | null = null
  if (data.mesh?.hasVideoFramesMesh) {
    const meshBlob = await downloadBlob(`projects/${id}/videoFramesMesh.json`)
    if (meshBlob) {
      const text = await meshBlob.text()
      videoFramesMesh = JSON.parse(text)
    }
  }

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    originalImageBlob: imageBlob,
    videoBlob: videoBlob,
    mesh: data.mesh ? {
      contourPoints: data.mesh.contourPoints,
      internalPoints: data.mesh.internalPoints,
      triangles: data.mesh.triangles.map(t => [t.a, t.b, t.c] as [number, number, number]),
      videoFramesMesh,
    } : null,
    markers: data.markers,
  }
}

export async function createProject(name: string): Promise<Project> {
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    originalImageBlob: null,
    videoBlob: null,
    mesh: null,
    markers: null,
  }
  await setDoc(projectRef(project.id), toDoc(project))
  console.log('[Firebase] Project created:', project.id)
  return project
}

export async function getProject(id: string): Promise<Project | undefined> {
  const snap = await getDoc(projectRef(id))
  if (!snap.exists()) return undefined
  console.log('[Firebase] Loading project:', id)
  return fromDoc(snap.data() as ProjectDoc)
}

export async function getAllProjects(): Promise<Project[]> {
  const snap = await getDocs(projectsCol())
  return snap.docs.map(d => {
    const data = d.data() as ProjectDoc
    return {
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      originalImageBlob: null,
      videoBlob: null,
      mesh: data.mesh ? {
        contourPoints: data.mesh.contourPoints,
        internalPoints: data.mesh.internalPoints,
        triangles: data.mesh.triangles.map(t => [t.a, t.b, t.c] as [number, number, number]),
        videoFramesMesh: null,
      } : null,
      markers: data.markers,
    }
  })
}

export type UploadHint = 'image' | 'video' | 'videoFramesMesh'

export async function updateProject(project: Project, uploadOnly?: UploadHint[]): Promise<void> {
  const id = project.id

  // Save Firestore doc first (always)
  console.log('[Firebase] Saving project metadata:', id)
  await setDoc(projectRef(id), toDoc(project))

  // Then upload blobs to Storage (only what's specified, or nothing if not specified)
  const uploads: Promise<void>[] = []

  if (uploadOnly?.includes('image') && project.originalImageBlob) {
    console.log('[Storage] Uploading image for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/originalImage`, project.originalImageBlob)
        .then(() => console.log('[Storage] Image uploaded'))
    )
  }
  if (uploadOnly?.includes('video') && project.videoBlob) {
    console.log('[Storage] Uploading video for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/video`, project.videoBlob)
        .then(() => console.log('[Storage] Video uploaded'))
    )
  }
  if (uploadOnly?.includes('videoFramesMesh') && project.mesh?.videoFramesMesh) {
    const json = JSON.stringify(project.mesh.videoFramesMesh)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading videoFramesMesh for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/videoFramesMesh.json`, blob)
        .then(() => console.log('[Storage] videoFramesMesh uploaded'))
    )
  }

  await Promise.all(uploads)
}

export async function deleteProject(id: string): Promise<void> {
  const scansSnap = await getDocs(query(collection(db, 'scans'), where('projectId', '==', id)))
  const deletions: Promise<void>[] = scansSnap.docs.map(d => deleteDoc(d.ref))

  // Delete known storage files (no listAll — avoids CORS issues)
  const knownFiles = [
    `projects/${id}/originalImage`,
    `projects/${id}/video`,
    `projects/${id}/videoFramesMesh.json`,
  ]
  for (const path of knownFiles) {
    deletions.push(deleteObject(ref(storage, path)).catch(() => {}))
  }

  for (const scanDoc of scansSnap.docs) {
    deletions.push(deleteObject(ref(storage, `scans/${scanDoc.id}/scanImage`)).catch(() => {}))
  }

  deletions.push(deleteDoc(projectRef(id)))
  await Promise.all(deletions)
}
