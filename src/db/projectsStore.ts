import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, Point2D, BarycentricRef, KeyframeData, CannyParams } from '../types/project'

// Firestore doc shape (no blobs, no large JSON arrays)
// Firestore doesn't support nested arrays, so triangles are stored as objects
interface TriangleDoc { a: number; b: number; c: number }

interface MeshDoc {
  contourVertices: Point2D[]
  cannyParams: CannyParams | null
  contourKeyframeInterval: number
  contourTrackingValidated: boolean
  hasContourKeyframes: boolean
  hasContourFrames: boolean
  anchorPoints: Point2D[]
  anchorKeyframeInterval: number
  anchorTrackingValidated: boolean
  hasAnchorKeyframes: boolean
  hasAnchorFrames: boolean
  internalPoints: Point2D[]
  triangles: TriangleDoc[]
  topologyLocked: boolean
  trackedTriangles: TriangleDoc[]
  internalBarycentrics: BarycentricRef[]
  hasVideoFramesMesh: boolean
}

// Legacy format (v1: contourIndices, v2: contourPath/promotion)
interface LegacyMeshDoc {
  anchorPoints?: Point2D[]
  contourPoints?: Point2D[]
  contourIndices?: number[]
  contourPath?: { type: string; index: number }[]
  internalPoints?: Point2D[]
  triangles?: TriangleDoc[]
  topologyLocked?: boolean
  anchorTriangles?: TriangleDoc[]
  contourBarycentrics?: BarycentricRef[]
  internalBarycentrics?: BarycentricRef[]
  keyframeInterval?: number
  hasKeyframes?: boolean
  hasAnchorFrames?: boolean
  hasVideoFramesMesh?: boolean
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
      contourVertices: project.mesh.contourVertices ?? [],
      cannyParams: project.mesh.cannyParams ?? null,
      contourKeyframeInterval: project.mesh.contourKeyframeInterval ?? 10,
      contourTrackingValidated: project.mesh.contourTrackingValidated ?? false,
      hasContourKeyframes: (project.mesh.contourKeyframes?.length ?? 0) > 0,
      hasContourFrames: project.mesh.contourFrames != null,
      anchorPoints: project.mesh.anchorPoints ?? [],
      anchorKeyframeInterval: project.mesh.anchorKeyframeInterval ?? 10,
      anchorTrackingValidated: project.mesh.anchorTrackingValidated ?? false,
      hasAnchorKeyframes: (project.mesh.anchorKeyframes?.length ?? 0) > 0,
      hasAnchorFrames: project.mesh.anchorFrames != null,
      internalPoints: project.mesh.internalPoints ?? [],
      triangles: triToDoc(project.mesh.triangles ?? []),
      topologyLocked: project.mesh.topologyLocked ?? false,
      trackedTriangles: triToDoc(project.mesh.trackedTriangles ?? []),
      internalBarycentrics: project.mesh.internalBarycentrics ?? [],
      hasVideoFramesMesh: project.mesh.videoFramesMesh != null,
    } : null,
    markers: project.markers,
  }
}

type MeshWithoutLargeJSON = Omit<import('../types/project').MeshData,
  'contourKeyframes' | 'contourFrames' | 'anchorKeyframes' | 'anchorFrames' | 'videoFramesMesh'>

function isLegacyDoc(meshDoc: MeshDoc | LegacyMeshDoc): meshDoc is LegacyMeshDoc {
  const legacy = meshDoc as LegacyMeshDoc
  return !!(legacy.contourIndices || legacy.contourPath) && !('contourVertices' in meshDoc)
}

function meshFromDoc(meshDoc: MeshDoc | LegacyMeshDoc): MeshWithoutLargeJSON {
  if (isLegacyDoc(meshDoc)) {
    console.log('[Migration] Converting legacy mesh format → v3 (contour-first pipeline)')
    const legacy = meshDoc
    const oldAnchors = legacy.anchorPoints ?? []

    // Extract contour vertices from old format
    let contourVertices: Point2D[] = []
    if (legacy.contourIndices?.length) {
      contourVertices = legacy.contourIndices.map(i => oldAnchors[i])
    } else if (legacy.contourPath?.length) {
      const contourPoints = (legacy as Record<string, unknown>).contourPoints as Point2D[] ?? []
      contourVertices = legacy.contourPath.map(entry =>
        entry.type === 'anchor' ? oldAnchors[entry.index] : contourPoints[entry.index]
      )
    }

    // Feature anchors = non-contour anchors
    const contourSet = new Set(legacy.contourIndices ?? [])
    const anchorPoints = legacy.contourIndices
      ? oldAnchors.filter((_, i) => !contourSet.has(i))
      : [] // contourPath format: anchors mixed, can't cleanly separate — reset

    return {
      contourVertices,
      cannyParams: null,
      contourKeyframeInterval: 10,
      contourTrackingValidated: false,
      anchorPoints,
      anchorKeyframeInterval: 10,
      anchorTrackingValidated: false,
      internalPoints: legacy.internalPoints ?? [],
      triangles: [],
      topologyLocked: false,
      trackedTriangles: [],
      internalBarycentrics: [],
    }
  }

  const d = meshDoc as MeshDoc
  return {
    contourVertices: d.contourVertices ?? [],
    cannyParams: d.cannyParams ?? null,
    contourKeyframeInterval: d.contourKeyframeInterval ?? 10,
    contourTrackingValidated: d.contourTrackingValidated ?? false,
    anchorPoints: d.anchorPoints ?? [],
    anchorKeyframeInterval: d.anchorKeyframeInterval ?? 10,
    anchorTrackingValidated: d.anchorTrackingValidated ?? false,
    internalPoints: d.internalPoints ?? [],
    triangles: docToTri(d.triangles ?? []),
    topologyLocked: d.topologyLocked ?? false,
    trackedTriangles: docToTri(d.trackedTriangles ?? []),
    internalBarycentrics: d.internalBarycentrics ?? [],
  }
}

async function fromDoc(data: ProjectDoc): Promise<Project> {
  const id = data.id

  const [imageBlob, videoBlob] = await Promise.all([
    data.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    data.hasVideo ? downloadBlob(`projects/${id}/video`) : Promise.resolve(null),
  ])

  let contourKeyframes: KeyframeData[] = []
  let contourFrames: Point2D[][] | null = null
  let anchorKeyframes: KeyframeData[] = []
  let anchorFrames: Point2D[][] | null = null
  let videoFramesMesh: Point2D[][] | null = null

  if (data.mesh) {
    const meshDoc = data.mesh as MeshDoc
    const downloads = await Promise.all([
      meshDoc.hasContourKeyframes ? downloadJSON<KeyframeData[]>(`projects/${id}/contourKeyframes.json`) : null,
      meshDoc.hasContourFrames ? downloadJSON<Point2D[][]>(`projects/${id}/contourFrames.json`) : null,
      meshDoc.hasAnchorKeyframes ? downloadJSON<KeyframeData[]>(`projects/${id}/anchorKeyframes.json`) : null,
      meshDoc.hasAnchorFrames ? downloadJSON<Point2D[][]>(`projects/${id}/anchorFrames.json`) : null,
      meshDoc.hasVideoFramesMesh ? downloadJSON<Point2D[][]>(`projects/${id}/videoFramesMesh.json`) : null,
    ])
    contourKeyframes = downloads[0] ?? []
    contourFrames = downloads[1]
    anchorKeyframes = downloads[2] ?? []
    anchorFrames = downloads[3]
    videoFramesMesh = downloads[4]
  }

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    originalImageBlob: imageBlob,
    videoBlob: videoBlob,
    mesh: data.mesh ? {
      ...meshFromDoc(data.mesh),
      contourKeyframes,
      contourFrames,
      anchorKeyframes,
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
        ...meshFromDoc(data.mesh as MeshDoc | LegacyMeshDoc),
        contourKeyframes: [],
        contourFrames: null,
        anchorKeyframes: [],
        anchorFrames: null,
        videoFramesMesh: null,
      } : null,
      markers: data.markers,
    }
  })
}

export type UploadHint = 'image' | 'video' | 'contourKeyframes' | 'contourFrames' | 'anchorKeyframes' | 'anchorFrames' | 'videoFramesMesh'

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
  if (uploadOnly?.includes('contourKeyframes') && project.mesh?.contourKeyframes.length) {
    const json = JSON.stringify(project.mesh.contourKeyframes)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading contourKeyframes for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/contourKeyframes.json`, blob)
        .then(() => console.log('[Storage] contourKeyframes uploaded'))
    )
  }
  if (uploadOnly?.includes('contourFrames') && project.mesh?.contourFrames) {
    const json = JSON.stringify(project.mesh.contourFrames)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading contourFrames for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/contourFrames.json`, blob)
        .then(() => console.log('[Storage] contourFrames uploaded'))
    )
  }
  if (uploadOnly?.includes('anchorKeyframes') && project.mesh?.anchorKeyframes.length) {
    const json = JSON.stringify(project.mesh.anchorKeyframes)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading anchorKeyframes for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/anchorKeyframes.json`, blob)
        .then(() => console.log('[Storage] anchorKeyframes uploaded'))
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
    `projects/${id}/contourKeyframes.json`,
    `projects/${id}/contourFrames.json`,
    `projects/${id}/anchorKeyframes.json`,
    `projects/${id}/anchorFrames.json`,
    `projects/${id}/videoFramesMesh.json`,
    // Legacy paths (cleanup)
    `projects/${id}/keyframes.json`,
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
