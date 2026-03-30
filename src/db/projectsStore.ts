import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, Animation, AnimationType, Point2D, BarycentricRef, KeyframeData, CannyParams, CurvilinearParam, MeshData } from '../types/project'

// Firestore doc shape (no blobs, no large JSON arrays)
// Firestore doesn't support nested arrays, so triangles are stored as objects
interface TriangleDoc { a: number; b: number; c: number }

interface MeshDoc {
  cannyParams: CannyParams | null
  contourOrigin: Point2D | null
  contourOriginKeyframeInterval: number
  contourOriginTrackingValidated: boolean
  hasContourOriginKeyframes: boolean
  hasContourOriginFrames: boolean
  contourAnchors: Point2D[]
  contourAnchorKeyframeInterval: number
  contourAnchorTrackingValidated: boolean
  hasContourAnchorKeyframes: boolean
  hasContourAnchorFrames: boolean
  contourSubdivisionPoints: Point2D[]
  contourSubdivisionParams: CurvilinearParam[]
  hasContourSubdivisionFrames: boolean
  contourSubdivisionValidated: boolean
  hasContourCannyFrames: boolean
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

interface AnimationDoc {
  id: string
  name: string
  type: AnimationType
  createdAt: number
  hasVideo: boolean
  mesh: MeshDoc | null
  physicsCode: string | null
  physicsDuration: number | null
  physicsOverlay: boolean
}

interface ProjectDoc {
  id: string
  name: string
  createdAt: number
  hasImage: boolean
  hasBackgroundVideo: boolean
  animations: AnimationDoc[]
  markers: Project['markers']
}

// Legacy project doc (v4 format — single mesh + video at root)
interface LegacyProjectDoc {
  id: string
  name: string
  createdAt: number
  hasImage: boolean
  hasVideo: boolean
  hasBackgroundVideo: boolean
  mesh: MeshDoc | LegacyMeshDoc | null
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

// --- Animation storage path helpers ---

function animStoragePath(projectId: string, animId: string, file: string): string {
  return `projects/${projectId}/animations/${animId}/${file}`
}

// Legacy storage paths (root-level, before multi-animation)
function legacyStoragePath(projectId: string, file: string): string {
  return `projects/${projectId}/${file}`
}

// --- MeshDoc conversion ---

function meshToDoc(mesh: MeshData): MeshDoc {
  return {
    cannyParams: mesh.cannyParams ?? null,
    contourOrigin: mesh.contourOrigin ?? null,
    contourOriginKeyframeInterval: mesh.contourOriginKeyframeInterval ?? 10,
    contourOriginTrackingValidated: mesh.contourOriginTrackingValidated ?? false,
    hasContourOriginKeyframes: (mesh.contourOriginKeyframes?.length ?? 0) > 0,
    hasContourOriginFrames: mesh.contourOriginFrames != null,
    contourAnchors: mesh.contourAnchors ?? [],
    contourAnchorKeyframeInterval: mesh.contourAnchorKeyframeInterval ?? 10,
    contourAnchorTrackingValidated: mesh.contourAnchorTrackingValidated ?? false,
    hasContourAnchorKeyframes: (mesh.contourAnchorKeyframes?.length ?? 0) > 0,
    hasContourAnchorFrames: mesh.contourAnchorFrames != null,
    contourSubdivisionPoints: mesh.contourSubdivisionPoints ?? [],
    contourSubdivisionParams: mesh.contourSubdivisionParams ?? [],
    hasContourSubdivisionFrames: mesh.contourSubdivisionFrames != null,
    contourSubdivisionValidated: mesh.contourSubdivisionValidated ?? false,
    hasContourCannyFrames: mesh.contourCannyFrames != null,
    anchorPoints: mesh.anchorPoints ?? [],
    anchorKeyframeInterval: mesh.anchorKeyframeInterval ?? 10,
    anchorTrackingValidated: mesh.anchorTrackingValidated ?? false,
    hasAnchorKeyframes: (mesh.anchorKeyframes?.length ?? 0) > 0,
    hasAnchorFrames: mesh.anchorFrames != null,
    internalPoints: mesh.internalPoints ?? [],
    triangles: triToDoc(mesh.triangles ?? []),
    topologyLocked: mesh.topologyLocked ?? false,
    trackedTriangles: triToDoc(mesh.trackedTriangles ?? []),
    internalBarycentrics: mesh.internalBarycentrics ?? [],
    hasVideoFramesMesh: mesh.videoFramesMesh != null,
  }
}

function animToDoc(anim: Animation): AnimationDoc {
  return {
    id: anim.id,
    name: anim.name,
    type: anim.type,
    createdAt: anim.createdAt,
    hasVideo: anim.videoBlob != null,
    mesh: anim.mesh ? meshToDoc(anim.mesh) : null,
    physicsCode: anim.physicsCode ?? null,
    physicsDuration: anim.physicsDuration ?? null,
    physicsOverlay: anim.physicsOverlay ?? false,
  }
}

function toDoc(project: Project): ProjectDoc {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    hasImage: project.originalImageBlob != null,
    hasBackgroundVideo: project.backgroundVideoBlob != null,
    animations: project.animations.map(animToDoc),
    markers: project.markers,
  }
}

type MeshWithoutLargeJSON = Omit<import('../types/project').MeshData,
  'contourOriginKeyframes' | 'contourOriginFrames' |
  'contourAnchorKeyframes' | 'contourAnchorFrames' | 'contourSubdivisionFrames' |
  'contourCannyFrames' |
  'anchorKeyframes' | 'anchorFrames' | 'videoFramesMesh'>

function isLegacyMeshDoc(meshDoc: MeshDoc | LegacyMeshDoc): meshDoc is LegacyMeshDoc {
  const legacy = meshDoc as LegacyMeshDoc
  return (!('contourAnchors' in meshDoc)) &&
    !!(legacy.contourIndices || legacy.contourPath || legacy.contourVertices)
}

function meshFromDoc(meshDoc: MeshDoc | LegacyMeshDoc): MeshWithoutLargeJSON {
  if (isLegacyMeshDoc(meshDoc)) {
    console.log('[Migration] Converting legacy mesh format → v4 (curvilinear contour)')
    const legacy = meshDoc

    let contourAnchors: Point2D[] = []
    if (legacy.contourVertices?.length) {
      const cv = legacy.contourVertices
      const step = Math.max(1, Math.floor(cv.length / 5))
      for (let i = 0; i < cv.length; i += step) {
        contourAnchors.push(cv[i])
      }
    }

    return {
      cannyParams: legacy.cannyParams ?? null,
      contourOrigin: null,
      contourOriginKeyframeInterval: 10,
      contourOriginTrackingValidated: false,
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
    contourOrigin: d.contourOrigin ?? null,
    contourOriginKeyframeInterval: d.contourOriginKeyframeInterval ?? 10,
    contourOriginTrackingValidated: d.contourOriginTrackingValidated ?? false,
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

// Load large JSON data for a single animation
async function loadAnimationJSON(
  projectId: string,
  animId: string,
  meshDoc: MeshDoc,
  isLegacy: boolean,
): Promise<{
  contourOriginKeyframes: KeyframeData[]
  contourOriginFrames: Point2D[][] | null
  contourAnchorKeyframes: KeyframeData[]
  contourAnchorFrames: Point2D[][] | null
  contourSubdivisionFrames: Point2D[][] | null
  contourCannyFrames: Point2D[][] | null
  anchorKeyframes: KeyframeData[]
  anchorFrames: Point2D[][] | null
  videoFramesMesh: Point2D[][] | null
}> {
  // Legacy projects store files at root level, new ones under animations/{animId}/
  const path = (file: string) =>
    isLegacy ? legacyStoragePath(projectId, file) : animStoragePath(projectId, animId, file)

  const downloads = await Promise.all([
    meshDoc.hasContourOriginKeyframes ? downloadJSON<KeyframeData[]>(path('contourOriginKeyframes.json')) : null,
    meshDoc.hasContourOriginFrames ? downloadJSON<Point2D[][]>(path('contourOriginFrames.json')) : null,
    meshDoc.hasContourAnchorKeyframes ? downloadJSON<KeyframeData[]>(path('contourAnchorKeyframes.json')) : null,
    meshDoc.hasContourAnchorFrames ? downloadJSON<Point2D[][]>(path('contourAnchorFrames.json')) : null,
    meshDoc.hasContourSubdivisionFrames ? downloadJSON<Point2D[][]>(path('contourSubdivisionFrames.json')) : null,
    meshDoc.hasContourCannyFrames ? downloadJSON<Point2D[][]>(path('contourCannyFrames.json')) : null,
    meshDoc.hasAnchorKeyframes ? downloadJSON<KeyframeData[]>(path('anchorKeyframes.json')) : null,
    meshDoc.hasAnchorFrames ? downloadJSON<Point2D[][]>(path('anchorFrames.json')) : null,
    meshDoc.hasVideoFramesMesh ? downloadJSON<Point2D[][]>(path('videoFramesMesh.json')) : null,
  ])

  return {
    contourOriginKeyframes: downloads[0] ?? [],
    contourOriginFrames: downloads[1],
    contourAnchorKeyframes: downloads[2] ?? [],
    contourAnchorFrames: downloads[3],
    contourSubdivisionFrames: downloads[4],
    contourCannyFrames: downloads[5],
    anchorKeyframes: downloads[6] ?? [],
    anchorFrames: downloads[7],
    videoFramesMesh: downloads[8],
  }
}

function isLegacyProjectDoc(data: Record<string, unknown>): boolean {
  // Legacy format has 'mesh' or 'hasVideo' at root, no 'animations' array
  return !('animations' in data) && ('mesh' in data || 'hasVideo' in data)
}

async function fromDoc(data: Record<string, unknown>): Promise<Project> {
  if (isLegacyProjectDoc(data)) {
    return fromLegacyDoc(data as unknown as LegacyProjectDoc)
  }

  const projDoc = data as unknown as ProjectDoc
  const id = projDoc.id

  const [imageBlob, backgroundVideoBlob] = await Promise.all([
    projDoc.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    projDoc.hasBackgroundVideo ? downloadBlob(`projects/${id}/backgroundVideo`) : Promise.resolve(null),
  ])

  // Load all animations in parallel
  const animations = await Promise.all(
    projDoc.animations.map(async (animDoc): Promise<Animation> => {
      const videoBlob = animDoc.hasVideo
        ? await downloadBlob(animStoragePath(id, animDoc.id, 'video'))
        : null

      let mesh: MeshData | null = null
      if (animDoc.mesh) {
        const jsonData = await loadAnimationJSON(id, animDoc.id, animDoc.mesh as MeshDoc, false)
        mesh = {
          ...meshFromDoc(animDoc.mesh as MeshDoc),
          ...jsonData,
        }
      }

      return {
        id: animDoc.id,
        name: animDoc.name,
        type: animDoc.type,
        createdAt: animDoc.createdAt,
        videoBlob,
        mesh,
        physicsCode: animDoc.physicsCode ?? null,
        physicsDuration: animDoc.physicsDuration ?? null,
        physicsOverlay: animDoc.physicsOverlay ?? false,
      }
    })
  )

  return {
    id: projDoc.id,
    name: projDoc.name,
    createdAt: projDoc.createdAt,
    originalImageBlob: imageBlob,
    backgroundVideoBlob,
    animations,
    markers: projDoc.markers,
  }
}

async function fromLegacyDoc(data: LegacyProjectDoc): Promise<Project> {
  console.log('[Migration] Converting legacy project doc → multi-animation format')
  const id = data.id

  const [imageBlob, videoBlob, backgroundVideoBlob] = await Promise.all([
    data.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    data.hasVideo ? downloadBlob(`projects/${id}/video`) : Promise.resolve(null),
    data.hasBackgroundVideo ? downloadBlob(`projects/${id}/backgroundVideo`) : Promise.resolve(null),
  ])

  let mesh: MeshData | null = null
  if (data.mesh) {
    const meshDoc = data.mesh as MeshDoc
    // Legacy files are at root level
    const jsonData = await loadAnimationJSON(id, '', meshDoc, true)
    mesh = {
      ...meshFromDoc(data.mesh),
      ...jsonData,
    }
  }

  // Create a single rest animation from legacy data
  const legacyAnimation: Animation = {
    id: crypto.randomUUID(),
    name: 'Animation',
    type: 'rest',
    createdAt: data.createdAt,
    videoBlob,
    mesh,
    physicsCode: null,
    physicsDuration: null,
    physicsOverlay: false,
  }

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    originalImageBlob: imageBlob,
    backgroundVideoBlob,
    animations: [legacyAnimation],
    markers: data.markers,
  }
}

function meshShellFromDoc(meshDoc: MeshDoc | LegacyMeshDoc): MeshData {
  return {
    ...meshFromDoc(meshDoc),
    contourOriginKeyframes: [],
    contourOriginFrames: null,
    contourAnchorKeyframes: [],
    contourAnchorFrames: null,
    contourSubdivisionFrames: null,
    contourCannyFrames: null,
    anchorKeyframes: [],
    anchorFrames: null,
    videoFramesMesh: null,
  }
}

export async function getProjectThumbnail(projectId: string): Promise<Blob | null> {
  return downloadBlob(`projects/${projectId}/originalImage`)
}

export async function createProject(name: string): Promise<Project> {
  const restAnimation: Animation = {
    id: crypto.randomUUID(),
    name: 'Animation',
    type: 'rest',
    createdAt: Date.now(),
    videoBlob: null,
    mesh: null,
    physicsCode: null,
    physicsDuration: null,
    physicsOverlay: false,
  }
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    originalImageBlob: null,
    backgroundVideoBlob: null,
    animations: [restAnimation],
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
  return fromDoc(snap.data() as Record<string, unknown>)
}

export async function getAllProjects(): Promise<Project[]> {
  const snap = await getDocs(projectsCol())
  return snap.docs.map(d => {
    const data = d.data()

    // Handle legacy format in listing
    if (isLegacyProjectDoc(data)) {
      const legacy = data as unknown as LegacyProjectDoc
      const legacyAnim: Animation = {
        id: 'legacy-placeholder',
        name: 'Animation',
        type: 'rest',
        createdAt: legacy.createdAt,
        videoBlob: null,
        mesh: legacy.mesh ? meshShellFromDoc(legacy.mesh as MeshDoc | LegacyMeshDoc) : null,
        physicsCode: null,
        physicsDuration: null,
        physicsOverlay: false,
      }
      return {
        id: legacy.id,
        name: legacy.name,
        createdAt: legacy.createdAt,
        originalImageBlob: null,
        backgroundVideoBlob: null,
        animations: [legacyAnim],
        markers: legacy.markers,
      }
    }

    const projDoc = data as unknown as ProjectDoc
    return {
      id: projDoc.id,
      name: projDoc.name,
      createdAt: projDoc.createdAt,
      originalImageBlob: null,
      backgroundVideoBlob: null,
      animations: projDoc.animations.map(animDoc => ({
        id: animDoc.id,
        name: animDoc.name,
        type: animDoc.type,
        createdAt: animDoc.createdAt,
        videoBlob: null,
        mesh: animDoc.mesh ? meshShellFromDoc(animDoc.mesh as MeshDoc) : null,
        physicsCode: animDoc.physicsCode ?? null,
        physicsDuration: animDoc.physicsDuration ?? null,
        physicsOverlay: animDoc.physicsOverlay ?? false,
      })),
      markers: projDoc.markers,
    }
  })
}

export type AnimationUploadField =
  | 'video'
  | 'contourOriginKeyframes' | 'contourOriginFrames'
  | 'contourAnchorKeyframes' | 'contourAnchorFrames'
  | 'contourSubdivisionFrames' | 'contourCannyFrames'
  | 'anchorKeyframes' | 'anchorFrames'
  | 'videoFramesMesh'

export type UploadHint =
  | 'image' | 'backgroundVideo'
  | { animationId: string; field: AnimationUploadField }

/** Flat upload hint used by step components (legacy-compatible strings) */
export type StepUploadHint = 'image' | 'backgroundVideo' | AnimationUploadField

export async function updateProject(project: Project, uploadOnly?: UploadHint[]): Promise<void> {
  const id = project.id

  // Save Firestore doc first (always)
  console.log('[Firebase] Saving project metadata:', id)
  await setDoc(projectRef(id), toDoc(project))

  // Then upload blobs to Storage (only what's specified)
  const uploads: Promise<void>[] = []

  if (!uploadOnly) return

  for (const hint of uploadOnly) {
    if (hint === 'image' && project.originalImageBlob) {
      console.log('[Storage] Uploading image for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/originalImage`, project.originalImageBlob)
          .then(() => console.log('[Storage] Image uploaded'))
      )
    } else if (hint === 'backgroundVideo' && project.backgroundVideoBlob) {
      console.log('[Storage] Uploading background video for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/backgroundVideo`, project.backgroundVideoBlob)
          .then(() => console.log('[Storage] Background video uploaded'))
      )
    } else if (typeof hint === 'object') {
      const { animationId, field } = hint
      const anim = project.animations.find(a => a.id === animationId)
      if (!anim) continue

      const storagePath = animStoragePath(id, animationId, field === 'video' ? 'video' : `${field}.json`)

      if (field === 'video' && anim.videoBlob) {
        console.log(`[Storage] Uploading video for animation ${animationId}`)
        uploads.push(
          uploadBlob(storagePath, anim.videoBlob)
            .then(() => console.log(`[Storage] Video uploaded for animation ${animationId}`))
        )
      } else if (field !== 'video' && anim.mesh) {
        const jsonFieldMap: Record<string, unknown> = {
          contourOriginKeyframes: anim.mesh.contourOriginKeyframes,
          contourOriginFrames: anim.mesh.contourOriginFrames,
          contourAnchorKeyframes: anim.mesh.contourAnchorKeyframes,
          contourAnchorFrames: anim.mesh.contourAnchorFrames,
          contourSubdivisionFrames: anim.mesh.contourSubdivisionFrames,
          contourCannyFrames: anim.mesh.contourCannyFrames,
          anchorKeyframes: anim.mesh.anchorKeyframes,
          anchorFrames: anim.mesh.anchorFrames,
          videoFramesMesh: anim.mesh.videoFramesMesh,
        }
        const data = jsonFieldMap[field]
        if (data && (Array.isArray(data) ? data.length > 0 : true)) {
          const json = JSON.stringify(data)
          const blob = new Blob([json], { type: 'application/json' })
          console.log(`[Storage] Uploading ${field} for animation ${animationId}`)
          uploads.push(
            uploadBlob(storagePath, blob)
              .then(() => console.log(`[Storage] ${field} uploaded for animation ${animationId}`))
          )
        }
      }
    }
  }

  await Promise.all(uploads)
}

const ANIM_JSON_FILES = [
  'video',
  'contourOriginKeyframes.json',
  'contourOriginFrames.json',
  'contourAnchorKeyframes.json',
  'contourAnchorFrames.json',
  'contourSubdivisionFrames.json',
  'contourCannyFrames.json',
  'anchorKeyframes.json',
  'anchorFrames.json',
  'videoFramesMesh.json',
]

export async function deleteProject(id: string): Promise<void> {
  // First load the project doc to get animation IDs
  const snap = await getDoc(projectRef(id))
  const data = snap.exists() ? snap.data() : null

  const scansSnap = await getDocs(query(collection(db, 'scans'), where('projectId', '==', id)))
  const deletions: Promise<void>[] = scansSnap.docs.map(d => deleteDoc(d.ref))

  // Delete project-level storage files
  const projectFiles = [
    `projects/${id}/originalImage`,
    `projects/${id}/backgroundVideo`,
  ]
  for (const path of projectFiles) {
    deletions.push(deleteObject(ref(storage, path)).catch(() => {}))
  }

  // Delete animation storage files
  if (data && 'animations' in data) {
    const projDoc = data as unknown as ProjectDoc
    for (const animDoc of projDoc.animations) {
      for (const file of ANIM_JSON_FILES) {
        deletions.push(
          deleteObject(ref(storage, animStoragePath(id, animDoc.id, file))).catch(() => {})
        )
      }
    }
  }

  // Also clean up legacy paths
  const legacyFiles = [
    `projects/${id}/video`,
    `projects/${id}/contourOriginKeyframes.json`,
    `projects/${id}/contourOriginFrames.json`,
    `projects/${id}/contourAnchorKeyframes.json`,
    `projects/${id}/contourAnchorFrames.json`,
    `projects/${id}/contourSubdivisionFrames.json`,
    `projects/${id}/contourCannyFrames.json`,
    `projects/${id}/anchorKeyframes.json`,
    `projects/${id}/anchorFrames.json`,
    `projects/${id}/videoFramesMesh.json`,
    `projects/${id}/keyframes.json`,
    `projects/${id}/contourKeyframes.json`,
    `projects/${id}/contourFrames.json`,
  ]
  for (const path of legacyFiles) {
    deletions.push(deleteObject(ref(storage, path)).catch(() => {}))
  }

  // Delete scan images
  for (const scanDoc of scansSnap.docs) {
    deletions.push(deleteObject(ref(storage, `scans/${scanDoc.id}/scanImage`)).catch(() => {}))
  }

  deletions.push(deleteDoc(projectRef(id)))
  await Promise.all(deletions)
}

const ANIM_UPLOAD_FIELDS: AnimationUploadField[] = [
  'video', 'contourOriginKeyframes', 'contourOriginFrames',
  'contourAnchorKeyframes', 'contourAnchorFrames',
  'contourSubdivisionFrames', 'contourCannyFrames',
  'anchorKeyframes', 'anchorFrames', 'videoFramesMesh',
]

export async function duplicateProject(sourceId: string): Promise<Project> {
  const source = await getProject(sourceId)
  if (!source) throw new Error('Project not found')

  // Build ID mapping for animations
  const animIdMap = new Map<string, string>()
  for (const anim of source.animations) {
    animIdMap.set(anim.id, crypto.randomUUID())
  }

  const newId = crypto.randomUUID()
  const duplicate: Project = {
    ...source,
    id: newId,
    name: `${source.name} (copie)`,
    createdAt: Date.now(),
    animations: source.animations.map(a => ({
      ...a,
      id: animIdMap.get(a.id)!,
      createdAt: Date.now(),
    })),
  }

  // Build upload hints for all blobs
  const hints: UploadHint[] = []
  if (duplicate.originalImageBlob) hints.push('image')
  if (duplicate.backgroundVideoBlob) hints.push('backgroundVideo')
  for (const anim of duplicate.animations) {
    const newAnimId = anim.id
    for (const field of ANIM_UPLOAD_FIELDS) {
      if (field === 'video' && anim.videoBlob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field !== 'video' && anim.mesh) {
        const val = anim.mesh[field as keyof typeof anim.mesh]
        if (val && (Array.isArray(val) ? val.length > 0 : true)) {
          hints.push({ animationId: newAnimId, field })
        }
      }
    }
  }

  await updateProject(duplicate, hints)
  console.log(`[Firebase] Project duplicated: ${sourceId} -> ${newId}`)
  return duplicate
}
