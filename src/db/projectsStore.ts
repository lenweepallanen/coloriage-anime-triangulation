import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, Point2D, BarycentricRef, KeyframeData, CannyParams, CurvilinearParam } from '../types/project'

// Firestore doc shape (no blobs, no large JSON arrays)
// Firestore doesn't support nested arrays, so triangles are stored as objects
interface TriangleDoc { a: number; b: number; c: number }

interface MeshDoc {
  cannyParams: CannyParams | null
  contourAnchors: Point2D[]
  contourAnchorKeyframeInterval: number
  contourAnchorTrackingValidated: boolean
  hasContourAnchorKeyframes: boolean
  hasContourAnchorFrames: boolean
  contourSubdivisionPoints: Point2D[]
  contourSubdivisionParams: CurvilinearParam[]
  hasContourSubdivisionFrames: boolean
  contourSubdivisionValidated: boolean
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

// Legacy formats (v1-v3)
interface LegacyMeshDoc {
  anchorPoints?: Point2D[]
  contourPoints?: Point2D[]
  contourVertices?: Point2D[]
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
  // v3 fields
  contourKeyframeInterval?: number
  contourTrackingValidated?: boolean
  hasContourKeyframes?: boolean
  hasContourFrames?: boolean
  cannyParams?: CannyParams | null
  anchorKeyframeInterval?: number
  anchorTrackingValidated?: boolean
  hasAnchorKeyframes?: boolean
  trackedTriangles?: TriangleDoc[]
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
      cannyParams: project.mesh.cannyParams ?? null,
      contourAnchors: project.mesh.contourAnchors ?? [],
      contourAnchorKeyframeInterval: project.mesh.contourAnchorKeyframeInterval ?? 10,
      contourAnchorTrackingValidated: project.mesh.contourAnchorTrackingValidated ?? false,
      hasContourAnchorKeyframes: (project.mesh.contourAnchorKeyframes?.length ?? 0) > 0,
      hasContourAnchorFrames: project.mesh.contourAnchorFrames != null,
      contourSubdivisionPoints: project.mesh.contourSubdivisionPoints ?? [],
      contourSubdivisionParams: project.mesh.contourSubdivisionParams ?? [],
      hasContourSubdivisionFrames: project.mesh.contourSubdivisionFrames != null,
      contourSubdivisionValidated: project.mesh.contourSubdivisionValidated ?? false,
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
  'contourAnchorKeyframes' | 'contourAnchorFrames' | 'contourSubdivisionFrames' |
  'anchorKeyframes' | 'anchorFrames' | 'videoFramesMesh'>

function isLegacyDoc(meshDoc: MeshDoc | LegacyMeshDoc): meshDoc is LegacyMeshDoc {
  const legacy = meshDoc as LegacyMeshDoc
  // Legacy if has old-style fields and NOT new v4 contourAnchors
  return (!('contourAnchors' in meshDoc)) &&
    !!(legacy.contourIndices || legacy.contourPath || legacy.contourVertices)
}

function meshFromDoc(meshDoc: MeshDoc | LegacyMeshDoc): MeshWithoutLargeJSON {
  if (isLegacyDoc(meshDoc)) {
    console.log('[Migration] Converting legacy mesh format → v4 (curvilinear contour)')
    const legacy = meshDoc

    // Try to extract some contour anchor points from old data
    let contourAnchors: Point2D[] = []
    if (legacy.contourVertices?.length) {
      // v3 format: take a few evenly spaced points as anchors
      const cv = legacy.contourVertices
      const step = Math.max(1, Math.floor(cv.length / 5))
      for (let i = 0; i < cv.length; i += step) {
        contourAnchors.push(cv[i])
      }
    }

    return {
      cannyParams: legacy.cannyParams ?? null,
      contourAnchors,
      contourAnchorKeyframeInterval: 10,
      contourAnchorTrackingValidated: false,
      contourSubdivisionPoints: [],
      contourSubdivisionParams: [],
      contourSubdivisionValidated: false,
      anchorPoints: legacy.anchorPoints ?? [],
      anchorKeyframeInterval: legacy.anchorKeyframeInterval ?? 10,
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
    cannyParams: d.cannyParams ?? null,
    contourAnchors: d.contourAnchors ?? [],
    contourAnchorKeyframeInterval: d.contourAnchorKeyframeInterval ?? 10,
    contourAnchorTrackingValidated: d.contourAnchorTrackingValidated ?? false,
    contourSubdivisionPoints: d.contourSubdivisionPoints ?? [],
    contourSubdivisionParams: d.contourSubdivisionParams ?? [],
    contourSubdivisionValidated: d.contourSubdivisionValidated ?? false,
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

  let contourAnchorKeyframes: KeyframeData[] = []
  let contourAnchorFrames: Point2D[][] | null = null
  let contourSubdivisionFrames: Point2D[][] | null = null
  let anchorKeyframes: KeyframeData[] = []
  let anchorFrames: Point2D[][] | null = null
  let videoFramesMesh: Point2D[][] | null = null

  if (data.mesh) {
    const meshDoc = data.mesh as MeshDoc
    const downloads = await Promise.all([
      meshDoc.hasContourAnchorKeyframes ? downloadJSON<KeyframeData[]>(`projects/${id}/contourAnchorKeyframes.json`) : null,
      meshDoc.hasContourAnchorFrames ? downloadJSON<Point2D[][]>(`projects/${id}/contourAnchorFrames.json`) : null,
      meshDoc.hasContourSubdivisionFrames ? downloadJSON<Point2D[][]>(`projects/${id}/contourSubdivisionFrames.json`) : null,
      meshDoc.hasAnchorKeyframes ? downloadJSON<KeyframeData[]>(`projects/${id}/anchorKeyframes.json`) : null,
      meshDoc.hasAnchorFrames ? downloadJSON<Point2D[][]>(`projects/${id}/anchorFrames.json`) : null,
      meshDoc.hasVideoFramesMesh ? downloadJSON<Point2D[][]>(`projects/${id}/videoFramesMesh.json`) : null,
    ])
    contourAnchorKeyframes = downloads[0] ?? []
    contourAnchorFrames = downloads[1]
    contourSubdivisionFrames = downloads[2]
    anchorKeyframes = downloads[3] ?? []
    anchorFrames = downloads[4]
    videoFramesMesh = downloads[5]
  }

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    originalImageBlob: imageBlob,
    videoBlob: videoBlob,
    mesh: data.mesh ? {
      ...meshFromDoc(data.mesh),
      contourAnchorKeyframes,
      contourAnchorFrames,
      contourSubdivisionFrames,
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
        contourAnchorKeyframes: [],
        contourAnchorFrames: null,
        contourSubdivisionFrames: null,
        anchorKeyframes: [],
        anchorFrames: null,
        videoFramesMesh: null,
      } : null,
      markers: data.markers,
    }
  })
}

export type UploadHint = 'image' | 'video' | 'contourAnchorKeyframes' | 'contourAnchorFrames' | 'contourSubdivisionFrames' | 'anchorKeyframes' | 'anchorFrames' | 'videoFramesMesh'

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
  if (uploadOnly?.includes('contourAnchorKeyframes') && project.mesh?.contourAnchorKeyframes.length) {
    const json = JSON.stringify(project.mesh.contourAnchorKeyframes)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading contourAnchorKeyframes for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/contourAnchorKeyframes.json`, blob)
        .then(() => console.log('[Storage] contourAnchorKeyframes uploaded'))
    )
  }
  if (uploadOnly?.includes('contourAnchorFrames') && project.mesh?.contourAnchorFrames) {
    const json = JSON.stringify(project.mesh.contourAnchorFrames)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading contourAnchorFrames for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/contourAnchorFrames.json`, blob)
        .then(() => console.log('[Storage] contourAnchorFrames uploaded'))
    )
  }
  if (uploadOnly?.includes('contourSubdivisionFrames') && project.mesh?.contourSubdivisionFrames) {
    const json = JSON.stringify(project.mesh.contourSubdivisionFrames)
    const blob = new Blob([json], { type: 'application/json' })
    console.log('[Storage] Uploading contourSubdivisionFrames for:', id)
    uploads.push(
      uploadBlob(`projects/${id}/contourSubdivisionFrames.json`, blob)
        .then(() => console.log('[Storage] contourSubdivisionFrames uploaded'))
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
    `projects/${id}/contourAnchorKeyframes.json`,
    `projects/${id}/contourAnchorFrames.json`,
    `projects/${id}/contourSubdivisionFrames.json`,
    `projects/${id}/anchorKeyframes.json`,
    `projects/${id}/anchorFrames.json`,
    `projects/${id}/videoFramesMesh.json`,
    // Legacy paths (cleanup)
    `projects/${id}/keyframes.json`,
    `projects/${id}/contourKeyframes.json`,
    `projects/${id}/contourFrames.json`,
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
