import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, Point2D, BarycentricRef, KeyframeData, MeshData } from '../types/project'

// Firestore doc shape (no blobs, no large JSON arrays)
// Firestore doesn't support nested arrays, so triangles are stored as objects
interface TriangleDoc { a: number; b: number; c: number }

interface MeshDoc {
  anchorPoints: Point2D[]
  contourIndices: number[]
  internalPoints: Point2D[]
  triangles: TriangleDoc[]
  topologyLocked: boolean
  anchorTriangles: TriangleDoc[]
  internalBarycentrics: BarycentricRef[]
  keyframeInterval: number
  hasKeyframes: boolean
  hasAnchorFrames: boolean
  hasVideoFramesMesh: boolean
}

interface ProjectDoc {
  id: string
  name: string
  createdAt: number
  hasImage: boolean
  hasVideo: boolean
  mesh: MeshDoc | null
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

async function downloadJSON<T>(path: string): Promise<T | null> {
  const blob = await downloadBlob(path)
  if (!blob) return null
  const text = await blob.text()
  return JSON.parse(text)
}

function triToDoc(tri: [number, number, number][]): TriangleDoc[] {
  return tri.map(([a, b, c]) => ({ a, b, c }))
}

function docToTri(docs: TriangleDoc[]): [number, number, number][] {
  return docs.map(t => [t.a, t.b, t.c] as [number, number, number])
}

function toDoc(project: Project): ProjectDoc {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    hasImage: project.originalImageBlob != null,
    hasVideo: project.videoBlob != null,
    mesh: project.mesh ? {
      anchorPoints: project.mesh.anchorPoints ?? [],
      contourIndices: project.mesh.contourIndices ?? [],
      internalPoints: project.mesh.internalPoints ?? [],
      triangles: triToDoc(project.mesh.triangles ?? []),
      topologyLocked: project.mesh.topologyLocked ?? false,
      anchorTriangles: triToDoc(project.mesh.anchorTriangles ?? []),
      internalBarycentrics: project.mesh.internalBarycentrics ?? [],
      keyframeInterval: project.mesh.keyframeInterval ?? 10,
      hasKeyframes: (project.mesh.keyframes?.length ?? 0) > 0,
      hasAnchorFrames: project.mesh.anchorFrames != null,
      hasVideoFramesMesh: project.mesh.videoFramesMesh != null,
    } : null,
    markers: project.markers,
  }
}

function meshFromDoc(meshDoc: MeshDoc): Omit<MeshData, 'keyframes' | 'anchorFrames' | 'videoFramesMesh'> {
  return {
    anchorPoints: meshDoc.anchorPoints ?? [],
    contourIndices: meshDoc.contourIndices ?? [],
    internalPoints: meshDoc.internalPoints ?? [],
    triangles: docToTri(meshDoc.triangles ?? []),
    topologyLocked: meshDoc.topologyLocked ?? false,
    anchorTriangles: docToTri(meshDoc.anchorTriangles ?? []),
    internalBarycentrics: meshDoc.internalBarycentrics ?? [],
    keyframeInterval: meshDoc.keyframeInterval ?? 10,
  }
}

async function fromDoc(data: ProjectDoc): Promise<Project> {
  const id = data.id

  const [imageBlob, videoBlob] = await Promise.all([
    data.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    data.hasVideo ? downloadBlob(`projects/${id}/video`) : Promise.resolve(null),
  ])

  let keyframes: KeyframeData[] = []
  let anchorFrames: Point2D[][] | null = null
  let videoFramesMesh: Point2D[][] | null = null

  if (data.mesh) {
    const downloads = await Promise.all([
      data.mesh.hasKeyframes ? downloadJSON<KeyframeData[]>(`projects/${id}/keyframes.json`) : null,
      data.mesh.hasAnchorFrames ? downloadJSON<Point2D[][]>(`projects/${id}/anchorFrames.json`) : null,
      data.mesh.hasVideoFramesMesh ? downloadJSON<Point2D[][]>(`projects/${id}/videoFramesMesh.json`) : null,
    ])
    keyframes = downloads[0] ?? []
    anchorFrames = downloads[1]
    videoFramesMesh = downloads[2]
  }

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    originalImageBlob: imageBlob,
    videoBlob: videoBlob,
    mesh: data.mesh ? {
      ...meshFromDoc(data.mesh),
      keyframes,
      anchorFrames,
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
        ...meshFromDoc(data.mesh),
        keyframes: [],
        anchorFrames: null,
        videoFramesMesh: null,
      } : null,
      markers: data.markers,
    }
  })
}

export type UploadHint = 'image' | 'video' | 'keyframes' | 'anchorFrames' | 'videoFramesMesh'

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
  if (uploadOnly?.includes('keyframes') && project.mesh?.keyframes.length) {
    const json = JSON.stringify(project.mesh.keyframes)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading keyframes for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/keyframes.json`, blob)
        .then(() => console.log('[Storage] keyframes uploaded'))
    )
  }
  if (uploadOnly?.includes('anchorFrames') && project.mesh?.anchorFrames) {
    const json = JSON.stringify(project.mesh.anchorFrames)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading anchorFrames for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/anchorFrames.json`, blob)
        .then(() => console.log('[Storage] anchorFrames uploaded'))
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
    `projects/${id}/keyframes.json`,
    `projects/${id}/anchorFrames.json`,
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
