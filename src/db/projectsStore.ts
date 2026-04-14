import {
  doc, setDoc, getDoc, getDocs, deleteDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, getDownloadURL, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import type { Project, Animation, AnimationType, Point2D, BarycentricRef, KeyframeData, CannyParams, CurvilinearParam, MeshData, Scene, BodyZone, SceneBackgroundLayer, Bone, WalkSkeletonDefinition, WalkParams, WalkLimbSeparation, ProjectTriangulation } from '../types/project'

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
  bones: Bone[]
  hasBoneWeights: boolean
  bonesValidated: boolean
  walkSkeleton: WalkSkeletonDefinition | null
  walkSkeletonValidated: boolean
  walkBodyTriangles: number[]
  walkBodyValidated: boolean
  walkLimbSeparation: unknown  // Serialized WalkLimbSeparation (triangles as {a,b,c} objects)
  walkLimbSeparationValidated: boolean
  walkParams: WalkParams | null
  walkParamsValidated: boolean
  walkHiddenFaceValidated: boolean
  hasVideoFramesMesh: boolean
  hasWalkZoneFrames: boolean
  hasWalkBodyFrames: boolean
  // SAM 2 zones (members-bones)
  sam2Zones?: import('../types/project').SAM2Zone[]
  sam2Prompts?: import('../types/project').SAM2Prompt[]
  sam2VideoWidth?: number
  sam2VideoHeight?: number
  sam2Validated?: boolean
  hasSam2MasksRLE?: boolean
  // Pipeline triangulation par zone (étapes 3-8)
  sam2ContourSmoothSigma?: number
  sam2ContoursValidated?: boolean
  hasSam2Contours?: boolean
  sam2ContourOrigins?: Record<string, Point2D>
  sam2ContourOriginTrackingValidated?: boolean
  hasSam2ContourOriginFrames?: boolean
  sam2ContourAnchors?: Record<string, Point2D[]>
  sam2ContourSubdivisionPoints?: Record<string, Point2D[]>
  sam2ContourSubdivisionParams?: Record<string, CurvilinearParam[]>
  sam2ContourSubdivisionValidated?: boolean
  sam2ContourAnchorTrackingValidated?: boolean
  hasSam2ContourAnchorFrames?: boolean
  hasSam2ContourSubdivisionFrames?: boolean
  // Étape 9 "Bones par zone"
  sam2Skeleton?: import('../types/project').Sam2Skeleton
  sam2BonesValidated?: boolean
  // Étape 10 "Lissage Bones"
  sam2SmoothingCutoffHz?: number
  sam2SmoothingValidated?: boolean
  hasSam2SmoothedAnchorFrames?: boolean
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
  hasAudio: boolean
  audioEnabled: boolean
  mesh: MeshDoc | null
  physicsCode: string | null
  physicsDuration: number | null
  physicsOverlay: boolean
}

interface BodyZoneDoc {
  id: string
  label: string
  color: string
  triangleIndices: number[]
}

interface ZoneAnimationMappingDoc {
  zoneId: string
  animationId: string
}

interface SceneRestPointDoc {
  id: string
  backgroundX: number
  restAnimationId?: string
  randomAnimationIds?: string[]
  zoneAnimationMappings?: ZoneAnimationMappingDoc[]
  availableAnimationIds?: string[]  // legacy fallback
  speakSoundIds?: string[]
  helpTexts?: string[]
}

interface SceneSegmentDoc {
  duration: number
  animationId?: string
}

interface SceneTransitionDoc {
  waypoints: number[]
  segments: SceneSegmentDoc[]
}

interface SceneBackgroundLayerDoc {
  hasImage: boolean
  width: number
  height: number
  depthFactor: number
}

interface SceneDoc {
  id: string
  name: string
  backgroundLayers?: SceneBackgroundLayerDoc[]
  // Legacy fields (migration)
  hasBackgroundImage?: boolean
  backgroundWidth?: number
  backgroundHeight?: number
  characterScale: number
  characterY: number
  restPoints: SceneRestPointDoc[]
  transitions: SceneTransitionDoc[]
  startMode: 'rest' | 'transition'
  startX?: number
  startTransition?: SceneTransitionDoc
  speakSounds?: { id: string; name: string }[]
}

interface ProjectTriangulationDoc {
  // Step 0
  hasReferenceImage: boolean
  // Step 1
  zones: import('../types/project').SAM2Zone[]
  prompts: import('../types/project').SAM2Prompt[]
  hasMasksRLE: boolean
  maskWidth: number
  maskHeight: number
  hasContours: boolean
  contourSmoothSigma: number
  bridgeThreshold: number
  step1Validated: boolean
  // Step 2
  zoneContourCount?: Record<string, number>
  zoneContourPoints?: Record<string, Point2D[]>
  zoneContourValidated?: Record<string, boolean>
  zonePoints: Record<string, Point2D[]>
  zoneTriangles: Record<string, TriangleDoc[]>
  zoneDensity: Record<string, number>
  bodyPoints: Point2D[]
  bodyTriangles: TriangleDoc[]
  step2Validated: boolean
  // Step 3
  hiddenFaceZones: import('../types/project').HiddenFaceZone[]
  hiddenFaceLimbZones: import('../types/project').HiddenFaceLimbZone[]
  step3Validated: boolean
}

interface ProjectDoc {
  id: string
  name: string
  createdAt: number
  hasImage: boolean
  hasBackgroundVideo: boolean
  hasAmbientSound: boolean
  ambientSoundEnabled: boolean
  animations: AnimationDoc[]
  bodyZones?: BodyZoneDoc[]
  markers: Project['markers']
  scene: SceneDoc | null
  projectTriangulation?: ProjectTriangulationDoc | null
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

// Serialize WalkLimbSeparation for Firestore (convert nested arrays to {a,b,c} objects)
function limbSeparationToDoc(sep: WalkLimbSeparation | null | undefined): unknown {
  if (!sep) return null
  const zoneTrianglesDoc: Record<string, TriangleDoc[]> = {}
  for (const [zoneId, tris] of Object.entries(sep.zoneTriangles)) {
    zoneTrianglesDoc[zoneId] = triToDoc(tris)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: Record<string, any> = {
    zones: sep.zones,
    overlapMargin: sep.overlapMargin,
    zonePoints: sep.zonePoints,
    zoneTriangles: zoneTrianglesDoc,
    bodyTriangleIndices: sep.bodyTriangleIndices,
  }

  // Body mesh fields (triangles need {a,b,c} conversion)
  if (sep.bodyPoints) doc.bodyPoints = sep.bodyPoints
  if (sep.bodyTriangles) doc.bodyTriangles = triToDoc(sep.bodyTriangles)
  if (sep.bodyExtraPoints) doc.bodyExtraPoints = sep.bodyExtraPoints
  if (sep.bodyManualTriangles) doc.bodyManualTriangles = triToDoc(sep.bodyManualTriangles)

  // Hidden face zones (triangles need {a,b,c} conversion, avoid undefined for Firestore)
  if (sep.hiddenFaceZones && sep.hiddenFaceZones.length > 0) {
    doc.hiddenFaceZones = sep.hiddenFaceZones.map(hfz => ({
      limbZoneId: hfz.limbZoneId,
      bodyVertexA: hfz.bodyVertexA,
      bodyVertexB: hfz.bodyVertexB,
      bridgePoints: hfz.bridgePoints,
      bodyTriangleIndices: hfz.bodyTriangleIndices,
    }))
  }

  // Hidden face limb zones (extensions de pattes)
  if (sep.hiddenFaceLimbZones && sep.hiddenFaceLimbZones.length > 0) {
    doc.hiddenFaceLimbZones = sep.hiddenFaceLimbZones.map(hfl => ({
      limbZoneId: hfl.limbZoneId,
      zoneVertexA: hfl.zoneVertexA,
      zoneVertexB: hfl.zoneVertexB,
      bridgePoints: hfl.bridgePoints,
      zoneTriangleIndices: hfl.zoneTriangleIndices,
    }))
  }

  return doc
}

// Deserialize WalkLimbSeparation from Firestore
function limbSeparationFromDoc(doc: Record<string, unknown> | null | undefined): WalkLimbSeparation | null {
  if (!doc) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = doc as any
  const zoneTriangles: Record<string, [number, number, number][]> = {}
  if (d.zoneTriangles) {
    for (const [zoneId, triDocs] of Object.entries(d.zoneTriangles)) {
      zoneTriangles[zoneId] = docToTri(triDocs as TriangleDoc[])
    }
  }

  const result: WalkLimbSeparation = {
    zones: d.zones ?? [],
    overlapMargin: d.overlapMargin ?? 3,
    zonePoints: d.zonePoints ?? {},
    zoneTriangles,
    bodyTriangleIndices: d.bodyTriangleIndices ?? [],
  }

  // Body mesh fields
  if (d.bodyPoints) result.bodyPoints = d.bodyPoints
  if (d.bodyTriangles) result.bodyTriangles = docToTri(d.bodyTriangles as TriangleDoc[])
  if (d.bodyExtraPoints) result.bodyExtraPoints = d.bodyExtraPoints
  if (d.bodyManualTriangles) result.bodyManualTriangles = docToTri(d.bodyManualTriangles as TriangleDoc[])

  // Hidden face zones
  if (d.hiddenFaceZones && Array.isArray(d.hiddenFaceZones)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.hiddenFaceZones = d.hiddenFaceZones.map((hfz: any) => ({
      limbZoneId: hfz.limbZoneId,
      bodyVertexA: hfz.bodyVertexA ?? 0,
      bodyVertexB: hfz.bodyVertexB ?? 0,
      bridgePoints: hfz.bridgePoints ?? [],
      bodyTriangleIndices: hfz.bodyTriangleIndices ?? [],
    }))
  }

  // Hidden face limb zones (extensions de pattes)
  console.log('[Firebase] limbSeparationFromDoc — all keys:', Object.keys(d), 'hiddenFaceLimbZones:', d.hiddenFaceLimbZones ? `array(${d.hiddenFaceLimbZones.length})` : String(d.hiddenFaceLimbZones), 'bodyPoints:', d.bodyPoints ? `array(${(d.bodyPoints as any[]).length})` : String(d.bodyPoints))
  if (d.hiddenFaceLimbZones && Array.isArray(d.hiddenFaceLimbZones)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.hiddenFaceLimbZones = d.hiddenFaceLimbZones.map((hfl: any) => ({
      limbZoneId: hfl.limbZoneId,
      zoneVertexA: hfl.zoneVertexA ?? 0,
      zoneVertexB: hfl.zoneVertexB ?? 0,
      bridgePoints: hfl.bridgePoints ?? [],
      zoneTriangleIndices: hfl.zoneTriangleIndices ?? [],
    }))
  }

  return result
}

// --- Project Triangulation serialization ---

function projectTriangulationToDoc(tri: ProjectTriangulation): ProjectTriangulationDoc {
  const zoneTrianglesDoc: Record<string, TriangleDoc[]> = {}
  for (const [zoneId, tris] of Object.entries(tri.zoneTriangles ?? {})) {
    zoneTrianglesDoc[zoneId] = triToDoc(tris)
  }
  return {
    hasReferenceImage: tri.referenceImageBlob != null,
    zones: tri.zones ?? [],
    prompts: tri.prompts ?? [],
    hasMasksRLE: tri.masksRLE != null,
    maskWidth: tri.maskWidth ?? 0,
    maskHeight: tri.maskHeight ?? 0,
    hasContours: tri.contours != null,
    contourSmoothSigma: tri.contourSmoothSigma ?? 3,
    bridgeThreshold: tri.bridgeThreshold ?? 8,
    step1Validated: tri.step1Validated ?? false,
    zoneContourCount: tri.zoneContourCount ?? {},
    zoneContourPoints: tri.zoneContourPoints ?? {},
    zoneContourValidated: tri.zoneContourValidated ?? {},
    zonePoints: tri.zonePoints ?? {},
    zoneTriangles: zoneTrianglesDoc,
    zoneDensity: tri.zoneDensity ?? {},
    bodyPoints: tri.bodyPoints ?? [],
    bodyTriangles: triToDoc(tri.bodyTriangles ?? []),
    step2Validated: tri.step2Validated ?? false,
    hiddenFaceZones: tri.hiddenFaceZones ?? [],
    hiddenFaceLimbZones: tri.hiddenFaceLimbZones ?? [],
    step3Validated: tri.step3Validated ?? false,
  }
}

function projectTriangulationFromDoc(doc: ProjectTriangulationDoc): Omit<ProjectTriangulation, 'referenceImageBlob' | 'masksRLE' | 'contours'> {
  const zoneTriangles: Record<string, [number, number, number][]> = {}
  for (const [zoneId, triDocs] of Object.entries(doc.zoneTriangles ?? {})) {
    zoneTriangles[zoneId] = docToTri(triDocs as TriangleDoc[])
  }
  return {
    zones: doc.zones ?? [],
    prompts: doc.prompts ?? [],
    maskWidth: doc.maskWidth ?? 0,
    maskHeight: doc.maskHeight ?? 0,
    contourSmoothSigma: doc.contourSmoothSigma ?? 3,
    bridgeThreshold: doc.bridgeThreshold ?? 8,
    step1Validated: doc.step1Validated ?? false,
    zoneContourCount: doc.zoneContourCount ?? {},
    zoneContourPoints: doc.zoneContourPoints ?? {},
    zoneContourValidated: doc.zoneContourValidated ?? {},
    zonePoints: doc.zonePoints ?? {},
    zoneTriangles,
    zoneDensity: doc.zoneDensity ?? {},
    bodyPoints: doc.bodyPoints ?? [],
    bodyTriangles: docToTri(doc.bodyTriangles ?? []),
    step2Validated: doc.step2Validated ?? false,
    hiddenFaceZones: doc.hiddenFaceZones ?? [],
    hiddenFaceLimbZones: doc.hiddenFaceLimbZones ?? [],
    step3Validated: doc.step3Validated ?? false,
  }
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
    bones: mesh.bones ?? [],
    hasBoneWeights: mesh.boneWeights != null,
    bonesValidated: mesh.bonesValidated ?? false,
    walkLimbSeparation: limbSeparationToDoc(mesh.walkLimbSeparation),
    walkLimbSeparationValidated: mesh.walkLimbSeparationValidated ?? false,
    walkSkeleton: mesh.walkSkeleton ?? null,
    walkSkeletonValidated: mesh.walkSkeletonValidated ?? false,
    walkBodyTriangles: mesh.walkBodyTriangles ?? [],
    walkBodyValidated: mesh.walkBodyValidated ?? false,
    walkParams: mesh.walkParams ?? null,
    walkParamsValidated: mesh.walkParamsValidated ?? false,
    walkHiddenFaceValidated: mesh.walkHiddenFaceValidated ?? false,
    hasVideoFramesMesh: mesh.videoFramesMesh != null,
    hasWalkZoneFrames: mesh.walkZoneFrames != null,
    hasWalkBodyFrames: mesh.walkBodyFrames != null,
    // SAM 2 (members-bones)
    ...(mesh.sam2Zones != null && { sam2Zones: mesh.sam2Zones }),
    ...(mesh.sam2Prompts != null && { sam2Prompts: mesh.sam2Prompts }),
    ...(mesh.sam2VideoWidth != null && { sam2VideoWidth: mesh.sam2VideoWidth }),
    ...(mesh.sam2VideoHeight != null && { sam2VideoHeight: mesh.sam2VideoHeight }),
    ...(mesh.sam2Validated != null && { sam2Validated: mesh.sam2Validated }),
    hasSam2MasksRLE: mesh.sam2MasksRLE != null,
    // Pipeline triangulation par zone (étapes 3-8) — petits champs en Firestore, gros en Storage
    ...(mesh.sam2ContourSmoothSigma != null && { sam2ContourSmoothSigma: mesh.sam2ContourSmoothSigma }),
    ...(mesh.sam2ContoursValidated != null && { sam2ContoursValidated: mesh.sam2ContoursValidated }),
    hasSam2Contours: mesh.sam2Contours != null,
    ...(mesh.sam2ContourOrigins != null && { sam2ContourOrigins: mesh.sam2ContourOrigins }),
    ...(mesh.sam2ContourOriginTrackingValidated != null && { sam2ContourOriginTrackingValidated: mesh.sam2ContourOriginTrackingValidated }),
    hasSam2ContourOriginFrames: mesh.sam2ContourOriginFrames != null,
    ...(mesh.sam2ContourAnchors != null && { sam2ContourAnchors: mesh.sam2ContourAnchors }),
    ...(mesh.sam2ContourSubdivisionPoints != null && { sam2ContourSubdivisionPoints: mesh.sam2ContourSubdivisionPoints }),
    ...(mesh.sam2ContourSubdivisionParams != null && { sam2ContourSubdivisionParams: mesh.sam2ContourSubdivisionParams }),
    ...(mesh.sam2ContourSubdivisionValidated != null && { sam2ContourSubdivisionValidated: mesh.sam2ContourSubdivisionValidated }),
    ...(mesh.sam2ContourAnchorTrackingValidated != null && { sam2ContourAnchorTrackingValidated: mesh.sam2ContourAnchorTrackingValidated }),
    hasSam2ContourAnchorFrames: mesh.sam2ContourAnchorFrames != null,
    hasSam2ContourSubdivisionFrames: mesh.sam2ContourSubdivisionFrames != null,
    // Étape 9 "Bones par zone"
    ...(mesh.sam2Skeleton != null && { sam2Skeleton: mesh.sam2Skeleton }),
    ...(mesh.sam2BonesValidated != null && { sam2BonesValidated: mesh.sam2BonesValidated }),
    // Étape 10 "Lissage Bones"
    ...(mesh.sam2SmoothingCutoffHz != null && { sam2SmoothingCutoffHz: mesh.sam2SmoothingCutoffHz }),
    ...(mesh.sam2SmoothingValidated != null && { sam2SmoothingValidated: mesh.sam2SmoothingValidated }),
    hasSam2SmoothedAnchorFrames: mesh.sam2SmoothedAnchorFrames != null,
  }
}

function animToDoc(anim: Animation): AnimationDoc {
  return {
    id: anim.id,
    name: anim.name,
    type: anim.type,
    createdAt: anim.createdAt,
    hasVideo: anim.videoBlob != null,
    hasAudio: anim.audioBlob != null,
    audioEnabled: anim.audioEnabled ?? false,
    mesh: anim.mesh ? meshToDoc(anim.mesh) : null,
    physicsCode: anim.physicsCode ?? null,
    physicsDuration: anim.physicsDuration ?? null,
    physicsOverlay: anim.physicsOverlay ?? false,
  }
}

function transitionToDoc(t: import('../types/project').SceneTransition): SceneTransitionDoc {
  return {
    waypoints: t.waypoints,
    segments: t.segments.map(s => ({
      duration: s.duration,
      ...(s.animationId != null && { animationId: s.animationId }),
    })),
  }
}

function sceneToDoc(scene: Scene): SceneDoc {
  return {
    id: scene.id,
    name: scene.name,
    backgroundLayers: scene.backgroundLayers.map(l => ({
      hasImage: l.imageBlob != null,
      width: l.width,
      height: l.height,
      depthFactor: l.depthFactor,
    })),
    characterScale: scene.characterScale,
    characterY: scene.characterY,
    restPoints: scene.restPoints.map(rp => ({
      id: rp.id,
      backgroundX: rp.backgroundX,
      ...(rp.restAnimationId != null && { restAnimationId: rp.restAnimationId }),
      ...(rp.randomAnimationIds != null && { randomAnimationIds: rp.randomAnimationIds }),
      ...(rp.zoneAnimationMappings != null && rp.zoneAnimationMappings.length > 0 && { zoneAnimationMappings: rp.zoneAnimationMappings }),
      ...(rp.speakSoundIds != null && { speakSoundIds: rp.speakSoundIds }),
      ...(rp.helpTexts != null && rp.helpTexts.length > 0 && { helpTexts: rp.helpTexts }),
    })),
    transitions: scene.transitions.map(transitionToDoc),
    startMode: scene.startMode,
    ...(scene.startX != null && { startX: scene.startX }),
    ...(scene.startTransition != null && { startTransition: transitionToDoc(scene.startTransition) }),
    ...(scene.speakSounds.length > 0 && { speakSounds: scene.speakSounds.map(s => ({ id: s.id, name: s.name })) }),
  }
}

function toDoc(project: Project): ProjectDoc {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    hasImage: project.originalImageBlob != null,
    hasBackgroundVideo: project.backgroundVideoBlob != null,
    hasAmbientSound: project.ambientSoundBlob != null,
    ambientSoundEnabled: project.ambientSoundEnabled ?? false,
    animations: project.animations.map(animToDoc),
    ...(project.bodyZones.length > 0 && { bodyZones: project.bodyZones }),
    markers: project.markers,
    scene: project.scene ? sceneToDoc(project.scene) : null,
    ...(project.projectTriangulation != null && { projectTriangulation: projectTriangulationToDoc(project.projectTriangulation) }),
  }
}

type MeshWithoutLargeJSON = Omit<import('../types/project').MeshData,
  'contourOriginKeyframes' | 'contourOriginFrames' |
  'contourAnchorKeyframes' | 'contourAnchorFrames' | 'contourSubdivisionFrames' |
  'contourCannyFrames' |
  'anchorKeyframes' | 'anchorFrames' | 'boneWeights' | 'videoFramesMesh' |
  'walkZoneFrames' | 'walkBodyFrames' | 'walkHiddenFaceFrames' |
  'sam2MasksRLE' |
  'sam2Contours' | 'sam2ContourOriginFrames' | 'sam2ContourAnchorFrames' | 'sam2ContourSubdivisionFrames' | 'sam2SmoothedAnchorFrames'>

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
      bones: [],
      bonesValidated: false,
      walkLimbSeparation: null,
      walkLimbSeparationValidated: false,
      walkSkeleton: null,
      walkSkeletonValidated: false,
      walkBodyTriangles: [],
      walkBodyValidated: false,
      walkParams: null,
      walkParamsValidated: false,
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
    bones: d.bones ?? [],
    bonesValidated: d.bonesValidated ?? false,
    walkLimbSeparation: (() => { console.log('[Firebase] meshFromDoc walkLimbSeparation raw:', d.walkLimbSeparation ? Object.keys(d.walkLimbSeparation as object) : null); return limbSeparationFromDoc(d.walkLimbSeparation as Record<string, unknown> | null) })(),
    walkLimbSeparationValidated: d.walkLimbSeparationValidated ?? false,
    walkSkeleton: d.walkSkeleton ?? null,
    walkSkeletonValidated: d.walkSkeletonValidated ?? false,
    walkBodyTriangles: d.walkBodyTriangles ?? [],
    walkBodyValidated: d.walkBodyValidated ?? false,
    walkParams: d.walkParams ?? null,
    walkParamsValidated: d.walkParamsValidated ?? false,
    walkHiddenFaceValidated: d.walkHiddenFaceValidated ?? false,
    // SAM 2 (members-bones)
    sam2Zones: d.sam2Zones,
    sam2Prompts: d.sam2Prompts,
    sam2VideoWidth: d.sam2VideoWidth,
    sam2VideoHeight: d.sam2VideoHeight,
    sam2Validated: d.sam2Validated,
    // Pipeline triangulation par zone (étapes 3-8)
    sam2ContourSmoothSigma: d.sam2ContourSmoothSigma,
    sam2ContoursValidated: d.sam2ContoursValidated,
    sam2ContourOrigins: d.sam2ContourOrigins,
    sam2ContourOriginTrackingValidated: d.sam2ContourOriginTrackingValidated,
    sam2ContourAnchors: d.sam2ContourAnchors,
    sam2ContourSubdivisionPoints: d.sam2ContourSubdivisionPoints,
    sam2ContourSubdivisionParams: d.sam2ContourSubdivisionParams,
    sam2ContourSubdivisionValidated: d.sam2ContourSubdivisionValidated,
    sam2ContourAnchorTrackingValidated: d.sam2ContourAnchorTrackingValidated,
    // Étape 9 "Bones par zone"
    sam2Skeleton: d.sam2Skeleton,
    sam2BonesValidated: d.sam2BonesValidated,
    // Étape 10 "Lissage Bones"
    sam2SmoothingCutoffHz: d.sam2SmoothingCutoffHz,
    sam2SmoothingValidated: d.sam2SmoothingValidated,
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
  boneWeights: number[][] | null
  videoFramesMesh: Point2D[][] | null
  walkZoneFrames: Record<string, Point2D[][]> | null
  walkBodyFrames: Point2D[][] | null
  sam2MasksRLE: Record<string, import('../types/project').RLEMask[]> | null
  sam2Contours: Record<string, Point2D[][]> | null
  sam2ContourOriginFrames: Record<string, Point2D[]> | null
  sam2ContourAnchorFrames: Record<string, Point2D[][]> | null
  sam2ContourSubdivisionFrames: Record<string, Point2D[][]> | null
  sam2SmoothedAnchorFrames: Record<string, Point2D[][]> | null
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
    meshDoc.hasBoneWeights ? downloadJSON<number[][]>(path('boneWeights.json')) : null,
    meshDoc.hasVideoFramesMesh ? downloadJSON<Point2D[][]>(path('videoFramesMesh.json')) : null,
    meshDoc.hasWalkZoneFrames ? downloadJSON<Record<string, Point2D[][]>>(path('walkZoneFrames.json')) : null,
    meshDoc.hasWalkBodyFrames ? downloadJSON<Point2D[][]>(path('walkBodyFrames.json')) : null,
    meshDoc.hasSam2MasksRLE ? downloadJSON<Record<string, import('../types/project').RLEMask[]>>(path('sam2Masks.json')) : null,
    meshDoc.hasSam2Contours ? downloadJSON<Record<string, Point2D[][]>>(path('sam2Contours.json')) : null,
    meshDoc.hasSam2ContourOriginFrames ? downloadJSON<Record<string, Point2D[]>>(path('sam2ContourOriginFrames.json')) : null,
    meshDoc.hasSam2ContourAnchorFrames ? downloadJSON<Record<string, Point2D[][]>>(path('sam2ContourAnchorFrames.json')) : null,
    meshDoc.hasSam2ContourSubdivisionFrames ? downloadJSON<Record<string, Point2D[][]>>(path('sam2ContourSubdivisionFrames.json')) : null,
    meshDoc.hasSam2SmoothedAnchorFrames ? downloadJSON<Record<string, Point2D[][]>>(path('sam2SmoothedAnchorFrames.json')) : null,
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
    boneWeights: downloads[8],
    videoFramesMesh: downloads[9],
    walkZoneFrames: downloads[10],
    walkBodyFrames: downloads[11],
    sam2MasksRLE: downloads[12] as Record<string, import('../types/project').RLEMask[]> | null,
    sam2Contours: downloads[13] as Record<string, Point2D[][]> | null,
    sam2ContourOriginFrames: downloads[14] as Record<string, Point2D[]> | null,
    sam2ContourAnchorFrames: downloads[15] as Record<string, Point2D[][]> | null,
    sam2ContourSubdivisionFrames: downloads[16] as Record<string, Point2D[][]> | null,
    sam2SmoothedAnchorFrames: downloads[17] as Record<string, Point2D[][]> | null,
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

  const [imageBlob, backgroundVideoBlob, ambientSoundBlob] = await Promise.all([
    projDoc.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    projDoc.hasBackgroundVideo ? downloadBlob(`projects/${id}/backgroundVideo`) : Promise.resolve(null),
    (projDoc as ProjectDoc).hasAmbientSound ? downloadBlob(`projects/${id}/ambientSound`) : Promise.resolve(null),
  ])

  // Download scene background layer blobs
  let sceneLayerBlobs: (Blob | null)[] = [null, null, null]
  if (projDoc.scene) {
    if (projDoc.scene.backgroundLayers) {
      // New format: 3 layers
      sceneLayerBlobs = await Promise.all(
        projDoc.scene.backgroundLayers.map((l, i) =>
          l.hasImage ? downloadBlob(`projects/${id}/sceneBackgroundLayer${i}`) : Promise.resolve(null)
        )
      )
    } else if (projDoc.scene.hasBackgroundImage) {
      // Legacy format: single background → layer 2
      const legacyBlob = await downloadBlob(`projects/${id}/sceneBackground`)
      sceneLayerBlobs = [null, null, legacyBlob]
    }
  }

  // Load all animations in parallel
  const animations = await Promise.all(
    projDoc.animations.map(async (animDoc): Promise<Animation> => {
      const [videoBlob, audioBlob] = await Promise.all([
        animDoc.hasVideo ? downloadBlob(animStoragePath(id, animDoc.id, 'video')) : Promise.resolve(null),
        animDoc.hasAudio ? downloadBlob(animStoragePath(id, animDoc.id, 'audio')) : Promise.resolve(null),
      ])

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
        audioBlob,
        audioEnabled: animDoc.audioEnabled ?? false,
      }
    })
  )

  // Reconstruct scene if present
  const docToTransition = (td: SceneTransitionDoc): import('../types/project').SceneTransition => ({
    waypoints: td.waypoints ?? [],
    segments: (td.segments ?? []).map(s => ({
      duration: s.duration,
      ...(s.animationId != null && { animationId: s.animationId }),
    })),
  })

  let scene: Scene | null = null
  if (projDoc.scene) {
    const speakSounds = projDoc.scene.speakSounds ?? []
    const speakSoundBlobs = await Promise.all(
      speakSounds.map(s => downloadBlob(`projects/${id}/scene/speakSounds/${s.id}`))
    )
    // Build background layers (with legacy migration)
    const layerDocs = projDoc.scene.backgroundLayers ?? [
      { hasImage: false, width: 0, height: 0, depthFactor: 0.3 },
      { hasImage: false, width: 0, height: 0, depthFactor: 0.6 },
      { hasImage: projDoc.scene.hasBackgroundImage ?? false, width: projDoc.scene.backgroundWidth ?? 0, height: projDoc.scene.backgroundHeight ?? 0, depthFactor: 1.0 },
    ]
    const backgroundLayers: SceneBackgroundLayer[] = layerDocs.map((l, i) => ({
      imageBlob: sceneLayerBlobs[i] ?? null,
      width: l.width,
      height: l.height,
      depthFactor: l.depthFactor,
    }))

    scene = {
      id: projDoc.scene.id,
      name: projDoc.scene.name,
      backgroundLayers,
      characterScale: projDoc.scene.characterScale,
      characterY: projDoc.scene.characterY,
      restPoints: (projDoc.scene.restPoints ?? []).map(rp => ({
        id: rp.id,
        backgroundX: rp.backgroundX,
        ...(rp.restAnimationId != null && { restAnimationId: rp.restAnimationId }),
        randomAnimationIds: rp.randomAnimationIds ?? rp.availableAnimationIds,
        ...(rp.zoneAnimationMappings != null && { zoneAnimationMappings: rp.zoneAnimationMappings }),
        ...(rp.speakSoundIds != null && { speakSoundIds: rp.speakSoundIds }),
        ...(rp.helpTexts != null && { helpTexts: rp.helpTexts }),
      })),
      transitions: (projDoc.scene.transitions ?? []).map(docToTransition),
      startMode: projDoc.scene.startMode ?? 'rest',
      ...(projDoc.scene.startX != null && { startX: projDoc.scene.startX }),
      ...(projDoc.scene.startTransition != null && { startTransition: docToTransition(projDoc.scene.startTransition) }),
      speakSounds,
      speakSoundBlobs,
    }
  }

  // Load project triangulation if present
  let projectTriangulation: ProjectTriangulation | null = null
  if (projDoc.projectTriangulation) {
    const triDoc = projDoc.projectTriangulation
    const triBase = projectTriangulationFromDoc(triDoc)
    const triPath = (file: string) => `projects/${id}/triangulation/${file}`
    const [referenceImageBlob, masksRLE, contours] = await Promise.all([
      triDoc.hasReferenceImage ? downloadBlob(triPath('referenceImage')) : null,
      triDoc.hasMasksRLE ? downloadJSON<Record<string, import('../types/project').RLEMask[]>>(triPath('masksRLE.json')) : null,
      triDoc.hasContours ? downloadJSON<Record<string, Point2D[]>>(triPath('contours.json')) : null,
    ])
    projectTriangulation = { ...triBase, referenceImageBlob, masksRLE, contours }
  }

  return {
    id: projDoc.id,
    name: projDoc.name,
    createdAt: projDoc.createdAt,
    originalImageBlob: imageBlob,
    backgroundVideoBlob,
    ambientSoundBlob,
    ambientSoundEnabled: (projDoc as ProjectDoc).ambientSoundEnabled ?? false,
    animations,
    bodyZones: (projDoc.bodyZones ?? []).map((z: Record<string, unknown>) => ({
      id: z.id as string,
      label: z.label as string,
      color: z.color as string,
      triangleIndices: (z.triangleIndices ?? z.vertexIndices ?? []) as number[],
    })),
    markers: projDoc.markers,
    scene,
    projectTriangulation,
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
    audioBlob: null,
    audioEnabled: false,
  }

  return {
    id: data.id,
    name: data.name,
    createdAt: data.createdAt,
    originalImageBlob: imageBlob,
    backgroundVideoBlob,
    ambientSoundBlob: null,
    ambientSoundEnabled: false,
    animations: [legacyAnimation],
    bodyZones: [],
    markers: data.markers,
    scene: null,
    projectTriangulation: null,
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
    boneWeights: null,
    videoFramesMesh: null,
    walkZoneFrames: null,
    walkBodyFrames: null,
    sam2MasksRLE: null,
    sam2Contours: null,
    sam2ContourOriginFrames: null,
    sam2ContourAnchorFrames: null,
    sam2ContourSubdivisionFrames: null,
    sam2SmoothedAnchorFrames: null,
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
    audioBlob: null,
    audioEnabled: false,
  }
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    originalImageBlob: null,
    backgroundVideoBlob: null,
    ambientSoundBlob: null,
    ambientSoundEnabled: false,
    animations: [restAnimation],
    bodyZones: [],
    markers: null,
    scene: null,
    projectTriangulation: null,
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
        audioBlob: null,
        audioEnabled: false,
      }
      return {
        id: legacy.id,
        name: legacy.name,
        createdAt: legacy.createdAt,
        originalImageBlob: null,
        backgroundVideoBlob: null,
        ambientSoundBlob: null,
        ambientSoundEnabled: false,
        animations: [legacyAnim],
        bodyZones: [],
        markers: legacy.markers,
        scene: null,
        projectTriangulation: null,
      }
    }

    const projDoc = data as unknown as ProjectDoc
    return {
      id: projDoc.id,
      name: projDoc.name,
      createdAt: projDoc.createdAt,
      originalImageBlob: null,
      backgroundVideoBlob: null,
      ambientSoundBlob: null,
      ambientSoundEnabled: projDoc.ambientSoundEnabled ?? false,
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
        audioBlob: null,
        audioEnabled: animDoc.audioEnabled ?? false,
      })),
      bodyZones: (projDoc.bodyZones ?? []).map((z: Record<string, unknown>) => ({
      id: z.id as string,
      label: z.label as string,
      color: z.color as string,
      triangleIndices: (z.triangleIndices ?? z.vertexIndices ?? []) as number[],
    })),
      markers: projDoc.markers,
      scene: null,
      projectTriangulation: null,
    }
  })
}

export type AnimationUploadField =
  | 'video' | 'audio'
  | 'contourOriginKeyframes' | 'contourOriginFrames'
  | 'contourAnchorKeyframes' | 'contourAnchorFrames'
  | 'contourSubdivisionFrames' | 'contourCannyFrames'
  | 'anchorKeyframes' | 'anchorFrames'
  | 'boneWeights'
  | 'videoFramesMesh'
  | 'walkZoneFrames' | 'walkBodyFrames'
  | 'sam2MasksRLE'
  | 'sam2Contours' | 'sam2ContourOriginFrames' | 'sam2ContourAnchorFrames' | 'sam2ContourSubdivisionFrames'

export type UploadHint =
  | 'image' | 'backgroundVideo' | 'ambientSound'
  | 'sceneBackgroundLayer0' | 'sceneBackgroundLayer1' | 'sceneBackgroundLayer2'
  | 'triangulationReferenceImage' | 'triangulationMasks' | 'triangulationContours'
  | { animationId: string; field: AnimationUploadField }
  | { speakSoundId: string }
  | { deleteSpeakSoundId: string }

/** Flat upload hint used by step components (legacy-compatible strings) */
export type StepUploadHint = 'image' | 'backgroundVideo' | 'ambientSound' | AnimationUploadField

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
    } else if (hint === 'ambientSound' && project.ambientSoundBlob) {
      console.log('[Storage] Uploading ambient sound for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/ambientSound`, project.ambientSoundBlob)
          .then(() => console.log('[Storage] Ambient sound uploaded'))
      )
    } else if (hint === 'triangulationReferenceImage' && project.projectTriangulation?.referenceImageBlob) {
      console.log('[Storage] Uploading triangulation reference image for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/triangulation/referenceImage`, project.projectTriangulation.referenceImageBlob)
          .then(() => console.log('[Storage] Triangulation reference image uploaded'))
      )
    } else if (hint === 'triangulationMasks' && project.projectTriangulation?.masksRLE) {
      const json = JSON.stringify(project.projectTriangulation.masksRLE)
      const blob = new Blob([json], { type: 'application/json' })
      console.log('[Storage] Uploading triangulation masks for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/triangulation/masksRLE.json`, blob)
          .then(() => console.log('[Storage] Triangulation masks uploaded'))
      )
    } else if (hint === 'triangulationContours' && project.projectTriangulation?.contours) {
      const json = JSON.stringify(project.projectTriangulation.contours)
      const blob = new Blob([json], { type: 'application/json' })
      console.log('[Storage] Uploading triangulation contours for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/triangulation/contours.json`, blob)
          .then(() => console.log('[Storage] Triangulation contours uploaded'))
      )
    } else if (typeof hint === 'string' && hint.startsWith('sceneBackgroundLayer') && project.scene) {
      const layerIdx = parseInt(hint.slice(-1))
      const blob = project.scene.backgroundLayers[layerIdx]?.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading scene background layer ${layerIdx} for:`, id)
        uploads.push(
          uploadBlob(`projects/${id}/sceneBackgroundLayer${layerIdx}`, blob)
            .then(() => console.log(`[Storage] Scene background layer ${layerIdx} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'speakSoundId' in hint) {
      const soundId = hint.speakSoundId
      const idx = project.scene?.speakSounds.findIndex(s => s.id === soundId) ?? -1
      const blob = idx >= 0 ? project.scene?.speakSoundBlobs[idx] : null
      if (blob) {
        console.log(`[Storage] Uploading speak sound ${soundId}`)
        uploads.push(
          uploadBlob(`projects/${id}/scene/speakSounds/${soundId}`, blob)
            .then(() => console.log(`[Storage] Speak sound ${soundId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'deleteSpeakSoundId' in hint) {
      const soundId = hint.deleteSpeakSoundId
      console.log(`[Storage] Deleting speak sound ${soundId}`)
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/scene/speakSounds/${soundId}`)).catch(() => {})
      )
    } else if (typeof hint === 'object' && 'animationId' in hint) {
      const { animationId, field } = hint
      const anim = project.animations.find(a => a.id === animationId)
      if (!anim) continue

      // Map field name → storage filename (most are field+'.json', but sam2 has a custom filename)
      const fileNameForField: Record<string, string> = {
        sam2MasksRLE: 'sam2Masks.json',
        sam2Contours: 'sam2Contours.json',
        sam2ContourOriginFrames: 'sam2ContourOriginFrames.json',
        sam2ContourAnchorFrames: 'sam2ContourAnchorFrames.json',
        sam2ContourSubdivisionFrames: 'sam2ContourSubdivisionFrames.json',
        sam2SmoothedAnchorFrames: 'sam2SmoothedAnchorFrames.json',
      }
      const storagePath = animStoragePath(
        id,
        animationId,
        field === 'video' ? 'video'
          : field === 'audio' ? 'audio'
          : (fileNameForField[field] ?? `${field}.json`)
      )

      if (field === 'video' && anim.videoBlob) {
        console.log(`[Storage] Uploading video for animation ${animationId}`)
        uploads.push(
          uploadBlob(storagePath, anim.videoBlob)
            .then(() => console.log(`[Storage] Video uploaded for animation ${animationId}`))
        )
      } else if (field === 'audio' && anim.audioBlob) {
        console.log(`[Storage] Uploading audio for animation ${animationId}`)
        uploads.push(
          uploadBlob(storagePath, anim.audioBlob)
            .then(() => console.log(`[Storage] Audio uploaded for animation ${animationId}`))
        )
      } else if (field !== 'video' && field !== 'audio' && anim.mesh) {
        const jsonFieldMap: Record<string, unknown> = {
          contourOriginKeyframes: anim.mesh.contourOriginKeyframes,
          contourOriginFrames: anim.mesh.contourOriginFrames,
          contourAnchorKeyframes: anim.mesh.contourAnchorKeyframes,
          contourAnchorFrames: anim.mesh.contourAnchorFrames,
          contourSubdivisionFrames: anim.mesh.contourSubdivisionFrames,
          contourCannyFrames: anim.mesh.contourCannyFrames,
          anchorKeyframes: anim.mesh.anchorKeyframes,
          anchorFrames: anim.mesh.anchorFrames,
          boneWeights: anim.mesh.boneWeights,
          videoFramesMesh: anim.mesh.videoFramesMesh,
          walkZoneFrames: anim.mesh.walkZoneFrames,
          walkBodyFrames: anim.mesh.walkBodyFrames,
          sam2MasksRLE: anim.mesh.sam2MasksRLE,
          sam2Contours: anim.mesh.sam2Contours,
          sam2ContourOriginFrames: anim.mesh.sam2ContourOriginFrames,
          sam2ContourAnchorFrames: anim.mesh.sam2ContourAnchorFrames,
          sam2ContourSubdivisionFrames: anim.mesh.sam2ContourSubdivisionFrames,
          sam2SmoothedAnchorFrames: anim.mesh.sam2SmoothedAnchorFrames,
        }
        const data = jsonFieldMap[field]
        const isNonEmpty = data != null && (Array.isArray(data) ? data.length > 0 : (typeof data === 'object' ? Object.keys(data).length > 0 : true))
        if (isNonEmpty) {
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
  'audio',
  'contourOriginKeyframes.json',
  'contourOriginFrames.json',
  'contourAnchorKeyframes.json',
  'contourAnchorFrames.json',
  'contourSubdivisionFrames.json',
  'contourCannyFrames.json',
  'anchorKeyframes.json',
  'anchorFrames.json',
  'boneWeights.json',
  'videoFramesMesh.json',
  'walkZoneFrames.json',
  'walkBodyFrames.json',
  'sam2Masks.json',
  'sam2Contours.json',
  'sam2ContourOriginFrames.json',
  'sam2ContourAnchorFrames.json',
  'sam2ContourSubdivisionFrames.json',
  'sam2SmoothedAnchorFrames.json',
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
    `projects/${id}/ambientSound`,
    `projects/${id}/sceneBackground`,
    `projects/${id}/sceneBackgroundLayer0`,
    `projects/${id}/sceneBackgroundLayer1`,
    `projects/${id}/sceneBackgroundLayer2`,
    `projects/${id}/triangulation/referenceImage`,
    `projects/${id}/triangulation/masksRLE.json`,
    `projects/${id}/triangulation/contours.json`,
  ]
  for (const path of projectFiles) {
    deletions.push(deleteObject(ref(storage, path)).catch(() => {}))
  }

  // Delete speak sound files
  if (data && 'scene' in data) {
    const sceneDoc = (data as unknown as ProjectDoc).scene
    for (const sound of sceneDoc?.speakSounds ?? []) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/scene/speakSounds/${sound.id}`)).catch(() => {}))
    }
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
  'video', 'audio', 'contourOriginKeyframes', 'contourOriginFrames',
  'contourAnchorKeyframes', 'contourAnchorFrames',
  'contourSubdivisionFrames', 'contourCannyFrames',
  'anchorKeyframes', 'anchorFrames', 'boneWeights', 'videoFramesMesh',
  'walkZoneFrames', 'walkBodyFrames', 'sam2MasksRLE',
  'sam2Contours', 'sam2ContourOriginFrames', 'sam2ContourAnchorFrames', 'sam2ContourSubdivisionFrames',
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
  if (duplicate.ambientSoundBlob) hints.push('ambientSound')
  if (duplicate.projectTriangulation?.referenceImageBlob) hints.push('triangulationReferenceImage')
  if (duplicate.projectTriangulation?.masksRLE) hints.push('triangulationMasks')
  if (duplicate.projectTriangulation?.contours) hints.push('triangulationContours')
  if (duplicate.scene) {
    duplicate.scene.backgroundLayers.forEach((l, i) => {
      if (l.imageBlob) hints.push(`sceneBackgroundLayer${i}` as UploadHint)
    })
  }
  for (const sound of duplicate.scene?.speakSounds ?? []) {
    hints.push({ speakSoundId: sound.id })
  }
  for (const anim of duplicate.animations) {
    const newAnimId = anim.id
    for (const field of ANIM_UPLOAD_FIELDS) {
      if (field === 'video' && anim.videoBlob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field === 'audio' && anim.audioBlob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field !== 'video' && field !== 'audio' && anim.mesh) {
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
