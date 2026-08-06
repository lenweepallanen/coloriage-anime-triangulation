import {
  doc, setDoc, getDoc, getDocs, deleteDoc, updateDoc,
  collection, query, where
} from 'firebase/firestore'
import {
  ref, uploadBytes, deleteObject
} from 'firebase/storage'
import { db, storage } from './firebase'
import { cachedDownloadBlob, invalidateBlobCache } from './blobCache'
import { logAudit } from './audit'
import { generateThumbnailBlob } from '../utils/thumbnailGenerator'
import type { Project, Animation, AnimationType, Point2D, BarycentricRef, KeyframeData, CannyParams, CurvilinearParam, MeshData, Scene, BodyZone, SceneBackground, SceneForeground, Bone, WalkSkeletonDefinition, WalkParams, WalkLimbSeparation, ProjectTriangulation } from '../types/project'

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
  sam2BodyBonesValidated?: boolean  // V2: body chain validated separately
  // Étape 10 "Lissage Bones" / V2 "Lissage Anchor"
  sam2SmoothingCutoffHz?: number
  sam2SmoothingValidated?: boolean
  hasSam2SmoothedAnchorFrames?: boolean
  hasSam2SmoothedSubdivisionFrames?: boolean
  hasSam2SmoothedContourOriginFrames?: boolean
  // V2 "Lissage Maillage Corps"
  walkBodyFramesSmoothingCutoffHz?: number
  walkBodyFramesSmoothingValidated?: boolean
  hasWalkBodyFramesSmoothed?: boolean
  // V2 "Lissage Maillage Pattes"
  walkZoneFramesSmoothingCutoffHz?: number
  walkZoneFramesSmoothingValidated?: boolean
  hasWalkZoneFramesSmoothed?: boolean
  // V3 "Calcul Corps" (Delaunay du contour body, pas d'internes)
  v3BodyTriangles?: TriangleDoc[]
  v3BodyTriangulationValidated?: boolean
  // CoTracker + Bones (animation type cotracker-bones)
  cotrackerPoints?: import('../types/project').CoTrackerPoint[]
  cotrackerVideoWidth?: number
  cotrackerVideoHeight?: number
  cotrackerTrackingValidated?: boolean
  hasCotrackerFrames?: boolean
  hasCotrackerFramesRaw?: boolean
  hasCotrackerVisibility?: boolean
  cotrackerVisibilityThreshold?: number
  cotrackerSkeleton?: import('../types/project').CoTrackerSkeleton
  cotrackerBonesValidated?: boolean
  cotrackerBoneSmoothingCutoffHz?: number
  cotrackerBoneSmoothingValidated?: boolean
  cotrackerLBSParams?: import('../types/project').CoTrackerLBSParams
  cotrackerLBSValidated?: boolean
  cotrackerJawOpennessFrames?: number[] | null
  cotrackerEyePupilFrames?: Record<string, Point2D[]> | null
  // Marche
  marcheParentAnimationId?: string | null
  marcheSkeleton?: import('../types/project').CoTrackerSkeleton | null
  marcheBodyJointRestPositions?: Point2D[]
  marcheLegRestPositions?: Record<string, { hip: Point2D; joints: Point2D[]; foot: Point2D }>
  marcheInheritValidated?: boolean
  marcheGaitLegIds?: string[]
  marcheGaitLegsValidated?: boolean
  marcheLegPhases?: Record<string, number>
  // Bruits de pas (étape « Bruits de pas » de la marche)
  footstepFrames?: number[]
  footstepVolume?: number
  footstepOffsetMs?: number
  footstepValidated?: boolean
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
  /** 'loop' | 'oneshot'. Optionnel pour rétro-compat : migration → 'oneshot' par défaut. */
  playbackMode?: 'loop' | 'oneshot'
  createdAt: number
  hasVideo: boolean
  hasAudio: boolean
  /** Sons de pas 1/2 (Storage footstep1|footstep2). Optionnels (rétro-compat). */
  hasFootstep1?: boolean
  hasFootstep2?: boolean
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

interface SceneSoundMetaDoc {
  id: string
  name: string
  volume?: number
  loop?: boolean
  rate?: number
}

interface SceneActionStepDoc {
  animationId: string
  sound?: SceneSoundMetaDoc
  isSpoken?: boolean
  animSpeedMul?: number
  loop?: boolean
}

interface SceneActionDoc {
  id: string
  name: string
  steps?: SceneActionStepDoc[]
  /** @deprecated legacy lecture-seule, migré vers `steps`. */
  animationIds?: string[]
  sound?: SceneSoundMetaDoc
  isSpoken?: boolean
}

interface SceneRestPointDoc {
  id: string
  backgroundX: number
  restAnimationId?: string
  /** Bouton ACTION (étoile) — séquence unique (`actions[0]`). */
  actions?: SceneActionDoc[]
  /** Boutons « Discours » (1, 2, 3) — mêmes séquences que les actions. */
  speeches?: SceneActionDoc[]
  /** Animation de présentation (intro) jouée une fois à l'arrivée. */
  presentation?: SceneActionDoc
  /** @deprecated legacy lecture-seule, migré vers `actions`. */
  randomAnimationIds?: string[]
  /** @deprecated legacy lecture-seule. */
  randomAnimationSounds?: SceneSoundMetaDoc[][]
  zoneAnimationMappings?: ZoneAnimationMappingDoc[]
  availableAnimationIds?: string[]  // legacy fallback
  speakSoundIds?: string[]
  helpTexts?: string[]
}

type FilmTravelOriginDoc =
  | { kind: 'previous' }
  | { kind: 'offscreen'; side: 'left' | 'right' }
  | { kind: 'custom'; x: number; y: number }
  | { kind: 'appear' }

interface FilmTravelDoc {
  animationId?: string
  speedPxPerSec?: number
  animSpeedMul?: number
  sound?: SceneSoundMetaDoc
  origin?: FilmTravelOriginDoc
  /** Array de maps {x, y} — OK Firestore (pas d'array imbriqué). */
  controlPoints?: { x: number; y: number }[]
  easing?: import('../types/project').FilmTravelEasing
}

type FilmDepartureTargetDoc =
  | { kind: 'offscreen'; side: 'left' | 'right' }
  | { kind: 'custom'; x: number; y: number; scale?: number }

interface FilmDepartureDoc {
  target: FilmDepartureTargetDoc
  travel: FilmTravelDoc
}

interface FilmPointDoc {
  id: string
  x: number
  y: number
  scale: number
  travel: FilmTravelDoc
  action?: SceneActionDoc
  pauseMs?: number
  facing?: 'left' | 'right'
  departure?: FilmDepartureDoc
}

type FilmEndingDoc =
  | { kind: 'exit'; side: 'left' | 'right'; travel: FilmTravelDoc }
  | { kind: 'stay' }

interface FilmPlanDoc {
  id: string
  name?: string
  /** null/absent = décor de la scène (fallback). Blobs dans Storage filmPlans/{planId}/. */
  background?: SceneBackgroundDoc | null
  foreground?: SceneForegroundDoc | null
  cameraX: number
  entrySide: 'left' | 'right'
  points: FilmPointDoc[]
  ending: FilmEndingDoc
  transitionToNext?: import('../types/project').FilmPlanTransition
  moveAnimationId?: string
  moveSpeedPxPerSec?: number
  idleSpeedMul?: number
}

interface SceneFilmDoc {
  enabled: boolean
  /** Nouveau format multi-plans. */
  plans?: FilmPlanDoc[]
  /** Miroir legacy de plans[0] à plat — lu par les clients play pas encore
   *  déployés (dégradation douce : ils jouent au moins le plan 1). */
  entrySide?: 'left' | 'right'
  points?: FilmPointDoc[]
  ending?: FilmEndingDoc
  cameraX?: number
  moveAnimationId?: string
  moveSpeedPxPerSec: number
  idleSpeedMul?: number
  endBehavior: 'menu'
}

// --- FILM niveau projet (modèle cible, indépendant de la scène) ---
// Storage : projects/{id}/film/plans/{planId}/backdrop|overlay
//           projects/{id}/film/sounds/{soundId}

interface FilmBackdropDoc {
  hasImage: boolean
  hasVideo: boolean
  width: number
  height: number
}

interface FilmOverlayDoc extends FilmBackdropDoc {
  chromaKeyColor?: string | null
  chromaKeyThreshold?: number
  chromaKeySmoothness?: number
}

interface FilmPlanV3Doc {
  id: string
  name?: string
  backdrop?: FilmBackdropDoc | null
  overlay?: FilmOverlayDoc | null
  cameraX: number
  entrySide: 'left' | 'right'
  points: FilmPointDoc[]
  ending: FilmEndingDoc
  transitionToNext?: import('../types/project').FilmPlanTransition
  moveAnimationId?: string
  moveSpeedPxPerSec?: number
  idleSpeedMul?: number
}

interface FilmDoc {
  plans: FilmPlanV3Doc[]
  character: { scale: number; facing: 'left' | 'right'; originU: number; originV: number }
  music?: SceneSoundMetaDoc
  moveAnimationId?: string
  moveSpeedPxPerSec: number
  idleSpeedMul?: number
}

// --- FILM TIMELINE (v4) — doc.filmT. Storage inchangé :
//     décors projects/{id}/film/plans/{planId}/backdrop|overlay,
//     sons  projects/{id}/film/sounds/{soundId}.

interface FilmWaypointDoc {
  id: string
  x: number
  y: number
  scale: number
  facing?: 'left' | 'right'
}

interface FilmMotionClipDoc {
  id: string
  startMs: number
  durationMs: number
  kind: 'appear' | 'travel' | 'exit'
  from?: import('../types/project').FilmMotionRef
  to: import('../types/project').FilmMotionRef
  /** Array de maps {x, y} — OK Firestore. */
  controlPoints?: { x: number; y: number }[]
  easing?: import('../types/project').FilmTravelEasing
  animationId?: string
  animSpeedMul?: number
  lockedSpeedPxPerSec?: number
}

interface FilmAnimClipDoc {
  id: string
  startMs: number
  durationMs: number
  animationId: string
  speedMul?: number
  fillMode: 'loop' | 'once-hold'
}

interface FilmSoundClipDoc {
  id: string
  startMs: number
  durationMs: number
  soundId: string
  volume?: number
  rate?: number
  loop?: boolean
  isSpoken?: boolean
  fadeInMs?: number
  fadeOutMs?: number
  anchor?: { clipId: string; edge: 'start' | 'end'; offsetMs: number }
}

/** Wrapper de piste : Firestore interdit les arrays imbriqués. */
interface FilmSoundTrackDoc {
  clips: FilmSoundClipDoc[]
}

interface FilmTPlanDoc {
  id: string
  name?: string
  backdrop?: FilmBackdropDoc | null
  overlay?: FilmOverlayDoc | null
  cameraX: number
  transitionToNext?: import('../types/project').FilmPlanTransition
  durationMs: number
  waypoints: FilmWaypointDoc[]
  motion: FilmMotionClipDoc[]
  anim: FilmAnimClipDoc[]
  soundTracks: FilmSoundTrackDoc[]
}

interface FilmTDoc {
  version: 4
  plans: FilmTPlanDoc[]
  character: { scale: number; facing: 'left' | 'right'; originU: number; originV: number }
  /** Bibliothèque de sons (blobs dans film/sounds/{id}). */
  sounds: { id: string; name: string; volume?: number }[]
  music?: SceneSoundMetaDoc
  /** Bruits de pas activés (défaut true). Réglages au niveau des animations. */
  footstepsEnabled?: boolean
  /** @deprecated ancien modèle (sons liés dans le film) — lu avec tolérance, plus jamais écrit. */
  footstepSounds?: { animationId: string; soundIds: string[]; zoneIds?: string[]; volume?: number; offsetMs?: number }[]
  /** Ouverture/fermeture du film (même modèle que transitionToNext). */
  intro?: import('../types/project').FilmPlanTransition
  outro?: import('../types/project').FilmPlanTransition
  /** @deprecated remplacés par intro/outro — lus en fallback. */
  introFadeMs?: number
  outroFadeMs?: number
  moveAnimationId?: string
  moveSpeedPxPerSec: number
  idleSpeedMul?: number
}

interface SceneSegmentDoc {
  duration: number
  animationId?: string
  /** Sounds attached to this segment's animation. */
  sounds?: SceneSoundMetaDoc[]
}

interface SceneTransitionDoc {
  waypoints: number[]
  segments: SceneSegmentDoc[]
}

interface SceneBackgroundDoc {
  hasImage: boolean
  hasVideo: boolean
  width: number
  height: number
}

interface SceneForegroundDoc {
  hasImage: boolean
  hasVideo?: boolean
  width: number
  height: number
  chromaKeyColor?: string | null
  chromaKeyThreshold?: number
  chromaKeySmoothness?: number
}

/** @deprecated legacy parallax 3-layer model */
interface SceneBackgroundLayerDoc {
  hasImage: boolean
  hasVideo?: boolean
  width: number
  height: number
  depthFactor: number
}

interface SceneDoc {
  id: string
  name: string
  background?: SceneBackgroundDoc | null
  foreground?: SceneForegroundDoc | null
  /** @deprecated legacy 3-layer parallax. */
  backgroundLayers?: SceneBackgroundLayerDoc[]
  // Legacy fields (migration)
  hasBackgroundImage?: boolean
  backgroundWidth?: number
  backgroundHeight?: number
  characterScale: number
  characterY: number
  /** Nouveau modèle : 1 seul rest point. */
  restPoint?: SceneRestPointDoc
  entry?: 'fixed' | 'moving'
  entryStartX?: number
  entryDurationMs?: number
  entryAnimationId?: string
  entrySound?: SceneSoundMetaDoc
  ambientSound?: SceneSoundMetaDoc
  /** Zone de marche libre + perspective 2.5D. */
  walkTrapezoid?: import('../types/project').SceneWalkTrapezoid | null
  /** Mode film (séquence de blocs auto-jouée). */
  film?: SceneFilmDoc
  /** Orientation native du coloriage (toggle admin). */
  characterFacing?: 'right' | 'left'
  /** Origine du personnage normalisée (0..1). */
  characterOriginU?: number
  characterOriginV?: number
  /** @deprecated legacy multi-rest, migré vers `restPoint` (premier élément). */
  restPoints?: SceneRestPointDoc[]
  /** @deprecated legacy. */
  transitions?: SceneTransitionDoc[]
  /** @deprecated legacy. */
  startMode?: 'rest' | 'transition'
  /** @deprecated legacy. */
  startX?: number
  /** @deprecated legacy. */
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
  // Seeds Canny par zone (clic admin) + overrides per-zone — pour reprise édition
  zoneSeeds?: Record<string, Point2D[]>
  zoneSmoothSigmas?: Record<string, number>
  zoneInflates?: Record<string, number>
  zoneBeziers?: Record<string, import('../types/project').BezierNode[]>
  zoneCannyRefs?: Record<string, Point2D[]>
  // Step 2 — nouvelles sous-phases curvilignes (V3)
  zoneOrigins?: Record<string, Point2D>
  zoneOriginsValidated?: Record<string, boolean>
  zoneAnchors?: Record<string, Point2D[]>
  zoneAnchorsValidated?: Record<string, boolean>
  zoneSubdivisionPoints?: Record<string, Point2D[]>
  zoneSubdivisionParams?: Record<string, CurvilinearParam[]>
  zoneManualSubdivisionParams?: Record<string, CurvilinearParam[]>
  zoneManualSubdivisionPoints?: Record<string, Point2D[]>
  zoneSubdivisionValidated?: Record<string, boolean>
  zonePixelAdjusted?: Record<string, boolean>
  zoneContourLength?: Record<string, number>
  // Step 2 — legacy (slider)
  zoneContourCount?: Record<string, number>
  zoneContourPoints?: Record<string, Point2D[]>
  zoneContourValidated?: Record<string, boolean>
  zonePoints: Record<string, Point2D[]>
  zoneTriangles: Record<string, TriangleDoc[]>
  zoneManualPoints?: Record<string, Point2D[]>
  zoneManualTriangles?: Record<string, TriangleDoc[]>
  zoneDensity: Record<string, number>
  bodyPoints: Point2D[]
  bodyTriangles: TriangleDoc[]
  bodyPointsBaseline?: Point2D[]
  bodyTrianglesBaseline?: TriangleDoc[]
  zonePointsBaseline?: Record<string, Point2D[]>
  zoneTrianglesBaseline?: Record<string, TriangleDoc[]>
  step2Validated: boolean
  // Step 3
  hiddenFaceZones: import('../types/project').HiddenFaceZone[]
  hiddenFaceLimbZones: import('../types/project').HiddenFaceLimbZone[]
  step3Validated: boolean
  // Step 5 — preview outlines
  outlineWidthGlobal?: number
  outlineWidthByZone?: Record<string, number>
  outlineAlignment?: number
  outlineAlignmentByZone?: Record<string, number>
  outlineSmoothing?: number
  outlineSmoothingByZone?: Record<string, number>
  outlineColorByZone?: Record<string, string>
  outlineInflateGlobal?: number
  outlineInflateByZone?: Record<string, number>
  previewInpaintingEnabled?: boolean
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
  /** FILM niveau projet (modèle cible). Absent = pas encore migré/créé. */
  film?: FilmDoc | null
  /** FILM TIMELINE (v4) — prioritaire sur `film`. Quand présent, `film` n'est plus écrit. */
  filmT?: FilmTDoc | null
  scene: SceneDoc | null
  projectTriangulation?: ProjectTriangulationDoc | null
  projectEyes?: Project['projectEyes']
  projectMouth?: Project['projectMouth']
  published?: boolean
  publishedAt?: number | null
  bookId?: string | null
  bookOrder?: number
  hasThumbnail?: boolean
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

/** Itère tous les SceneSound d'un film : par plan, sons d'action des points (son
 *  global + sons de steps) + sons de trajet (entrant, sortie de point, sortie de plan). */
function* iterateFilmSounds(film: import('../types/project').SceneFilm | undefined): Generator<import('../types/project').SceneSound> {
  if (!film) return
  for (const plan of film.plans ?? []) {
    for (const p of plan.points ?? []) {
      if (p.travel?.sound) yield p.travel.sound
      if (p.departure?.travel?.sound) yield p.departure.travel.sound
      if (p.action) {
        if (p.action.sound) yield p.action.sound
        for (const s of p.action.steps ?? []) if (s.sound) yield s.sound
      }
    }
    if (plan.ending?.kind === 'exit' && plan.ending.travel?.sound) yield plan.ending.travel.sound
  }
}

/** Même traversée côté doc Firestore (métadonnées, sans blobs). Supporte le
 *  nouveau format `plans` ET l'ancien format à plat (docs pas encore réécrits). */
function collectFilmDocSoundMetas(filmDoc: SceneFilmDoc | undefined): SceneSoundMetaDoc[] {
  if (!filmDoc) return []
  const out: SceneSoundMetaDoc[] = []
  const collectPoints = (points: FilmPointDoc[] | undefined, ending: FilmEndingDoc | undefined) => {
    for (const p of points ?? []) {
      if (p.travel?.sound) out.push(p.travel.sound)
      if (p.departure?.travel?.sound) out.push(p.departure.travel.sound)
      if (p.action?.sound) out.push(p.action.sound)
      for (const s of p.action?.steps ?? []) if (s.sound) out.push(s.sound)
    }
    if (ending?.kind === 'exit' && ending.travel?.sound) out.push(ending.travel.sound)
  }
  if (Array.isArray(filmDoc.plans) && filmDoc.plans.length > 0) {
    for (const plan of filmDoc.plans) collectPoints(plan.points, plan.ending)
  } else if (Array.isArray(filmDoc.points)) {
    collectPoints(filmDoc.points, filmDoc.ending)
  }
  return out
}

function collectSceneSoundIds(scene: Scene | null | undefined): string[] {
  if (!scene) return []
  const ids = new Set<string>()
  if (scene.entrySound) ids.add(scene.entrySound.id)
  if (scene.ambientSound) ids.add(scene.ambientSound.id)
  const rp = scene.restPoint
  if (rp) {
    for (const a of [...(rp.actions ?? []), ...(rp.speeches ?? []), ...(rp.presentation ? [rp.presentation] : [])]) {
      if (a.sound) ids.add(a.sound.id)
      for (const s of a.steps ?? []) if (s.sound) ids.add(s.sound.id)
    }
    for (const arr of rp.randomAnimationSounds ?? []) for (const s of arr) ids.add(s.id)
  }
  for (const snd of iterateFilmSounds(scene.film)) ids.add(snd.id)
  return [...ids]
}

function findSceneSoundBlob(project: Project, soundId: string): Blob | null {
  const scene = project.scene
  if (!scene) return null
  if (scene.entrySound?.id === soundId && scene.entrySound.blob) return scene.entrySound.blob
  if (scene.ambientSound?.id === soundId && scene.ambientSound.blob) return scene.ambientSound.blob
  const rp = scene.restPoint
  const rpActions = rp ? [...(rp.actions ?? []), ...(rp.speeches ?? []), ...(rp.presentation ? [rp.presentation] : [])] : []
  for (const a of rpActions) {
    if (a.sound?.id === soundId && a.sound.blob) return a.sound.blob
    for (const s of a.steps ?? []) {
      if (s.sound?.id === soundId && s.sound.blob) return s.sound.blob
    }
  }
  for (const snd of iterateFilmSounds(scene.film)) {
    if (snd.id === soundId && snd.blob) return snd.blob
  }
  for (const arr of rp?.randomAnimationSounds ?? []) {
    const found = arr.find(s => s.id === soundId)
    if (found?.blob) return found.blob
  }
  return null
}

/**
 * Télécharge les blobs de décor propres aux plans du film (Storage
 * `projects/{id}/filmPlans/{planId}/background|foreground`) et les attache.
 * Un plan avec `background: null` (décor de la scène) est laissé tel quel.
 */
async function hydrateFilmPlanDecorBlobs(
  projectId: string,
  film: import('../types/project').SceneFilm,
  filmDoc: SceneFilmDoc,
): Promise<import('../types/project').SceneFilm> {
  const docPlans = new Map((filmDoc.plans ?? []).map(p => [p.id, p]))
  const plans = await Promise.all(film.plans.map(async (plan) => {
    const docPlan = docPlans.get(plan.id)
    if (!docPlan) return plan
    let background = plan.background
    if (background && docPlan.background) {
      const blob = await downloadBlob(`projects/${projectId}/filmPlans/${plan.id}/background`).catch(() => null)
      const isVideo = blob ? (blob.type.startsWith('video/') || docPlan.background.hasVideo === true) : docPlan.background.hasVideo === true
      background = { ...background, imageBlob: isVideo ? null : blob, videoBlob: isVideo ? blob : null }
    }
    let foreground = plan.foreground
    if (foreground && docPlan.foreground) {
      const blob = await downloadBlob(`projects/${projectId}/filmPlans/${plan.id}/foreground`).catch(() => null)
      const isVideo = blob ? (blob.type.startsWith('video/') || docPlan.foreground.hasVideo === true) : docPlan.foreground.hasVideo === true
      foreground = { ...foreground, imageBlob: isVideo ? null : blob, videoBlob: isVideo ? blob : null }
    }
    return { ...plan, background, foreground }
  }))
  return { ...film, plans }
}

const STORAGE_CACHE_METADATA = { cacheControl: 'public, max-age=31536000, immutable' }

/** Upload avec retry (3 tentatives, backoff) : un échec transitoire au milieu
 *  d'une rafale (duplication ≈ 30 fichiers) ne doit pas laisser un projet
 *  à moitié copié. Échec définitif → throw (remonté à l'appelant). */
async function uploadBlob(path: string, blob: Blob): Promise<void> {
  const storageRef = ref(storage, path)
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await uploadBytes(storageRef, blob, STORAGE_CACHE_METADATA)
      invalidateBlobCache(path)
      return
    } catch (err) {
      lastErr = err
      console.warn(`[Storage] Upload échoué (tentative ${attempt}/3) pour ${path}`, err)
      if (attempt < 3) await new Promise(r => setTimeout(r, 700 * attempt))
    }
  }
  throw lastErr
}

async function downloadBlob(path: string): Promise<Blob | null> {
  return cachedDownloadBlob(path)
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

/**
 * Migrate legacy V2 Sam2LegBone single-vertex hip (`hipBodyVertexIndex`) to the
 * V3 multi-vertex form (`hipBodyVertexIndices`/`hipBodyVertexWeights` + `hipMode`).
 * Idempotent : if `hipBodyVertexIndices` is already set, the leg is left untouched.
 */
function migrateSam2Skeleton(skel: import('../types/project').Sam2Skeleton): import('../types/project').Sam2Skeleton {
  let changed = false
  const legs = skel.legs.map(leg => {
    const hasNew = leg.hipBodyVertexIndices && leg.hipBodyVertexIndices.length > 0
    const hasLegacy = leg.hipBodyVertexIndex != null
    if (!hasNew && hasLegacy) {
      changed = true
      return {
        ...leg,
        hipMode: 'body-vertex' as const,
        hipBodyVertexIndices: [leg.hipBodyVertexIndex!],
        hipBodyVertexWeights: [1],
        hipBodyVertexIndex: null,
      }
    }
    if (!leg.hipMode) {
      changed = true
      return { ...leg, hipMode: hasNew || hasLegacy ? 'body-vertex' as const : 'anchor' as const }
    }
    return leg
  })
  return changed ? { ...skel, legs } : skel
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
      id: hfl.id ?? crypto.randomUUID(),
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
      id: hfl.id ?? crypto.randomUUID(),
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
    ...(tri.zoneSeeds != null && { zoneSeeds: tri.zoneSeeds }),
    ...(tri.zoneSmoothSigmas != null && { zoneSmoothSigmas: tri.zoneSmoothSigmas }),
    ...(tri.zoneInflates != null && { zoneInflates: tri.zoneInflates }),
    ...(tri.zoneBeziers != null && { zoneBeziers: tri.zoneBeziers }),
    ...(tri.zoneCannyRefs != null && { zoneCannyRefs: tri.zoneCannyRefs }),
    // Curvilinear V3 fields
    ...(tri.zoneOrigins != null && { zoneOrigins: tri.zoneOrigins }),
    ...(tri.zoneOriginsValidated != null && { zoneOriginsValidated: tri.zoneOriginsValidated }),
    ...(tri.zoneAnchors != null && { zoneAnchors: tri.zoneAnchors }),
    ...(tri.zoneAnchorsValidated != null && { zoneAnchorsValidated: tri.zoneAnchorsValidated }),
    ...(tri.zoneSubdivisionPoints != null && { zoneSubdivisionPoints: tri.zoneSubdivisionPoints }),
    ...(tri.zoneSubdivisionParams != null && { zoneSubdivisionParams: tri.zoneSubdivisionParams }),
    ...(tri.zoneManualSubdivisionParams != null && { zoneManualSubdivisionParams: tri.zoneManualSubdivisionParams }),
    ...(tri.zoneManualSubdivisionPoints != null && { zoneManualSubdivisionPoints: tri.zoneManualSubdivisionPoints }),
    ...(tri.zoneSubdivisionValidated != null && { zoneSubdivisionValidated: tri.zoneSubdivisionValidated }),
    ...(tri.zonePixelAdjusted != null && { zonePixelAdjusted: tri.zonePixelAdjusted }),
    ...(tri.zoneContourLength != null && { zoneContourLength: tri.zoneContourLength }),
    // Legacy
    zoneContourCount: tri.zoneContourCount ?? {},
    zoneContourPoints: tri.zoneContourPoints ?? {},
    zoneContourValidated: tri.zoneContourValidated ?? {},
    zonePoints: tri.zonePoints ?? {},
    zoneTriangles: zoneTrianglesDoc,
    ...(tri.zoneManualPoints != null && { zoneManualPoints: tri.zoneManualPoints }),
    ...(tri.zoneManualTriangles != null && {
      zoneManualTriangles: Object.fromEntries(
        Object.entries(tri.zoneManualTriangles).map(([zid, tris]) => [zid, triToDoc(tris)])
      ),
    }),
    zoneDensity: tri.zoneDensity ?? {},
    bodyPoints: tri.bodyPoints ?? [],
    bodyTriangles: triToDoc(tri.bodyTriangles ?? []),
    ...(tri.bodyPointsBaseline != null && { bodyPointsBaseline: tri.bodyPointsBaseline }),
    ...(tri.bodyTrianglesBaseline != null && { bodyTrianglesBaseline: triToDoc(tri.bodyTrianglesBaseline) }),
    ...(tri.zonePointsBaseline != null && { zonePointsBaseline: tri.zonePointsBaseline }),
    ...(tri.zoneTrianglesBaseline != null && {
      zoneTrianglesBaseline: Object.fromEntries(
        Object.entries(tri.zoneTrianglesBaseline).map(([zid, tris]) => [zid, triToDoc(tris)])
      ),
    }),
    step2Validated: tri.step2Validated ?? false,
    hiddenFaceZones: tri.hiddenFaceZones ?? [],
    hiddenFaceLimbZones: tri.hiddenFaceLimbZones ?? [],
    step3Validated: tri.step3Validated ?? false,
    ...(tri.outlineWidthGlobal != null && { outlineWidthGlobal: tri.outlineWidthGlobal }),
    ...(tri.outlineWidthByZone != null && { outlineWidthByZone: tri.outlineWidthByZone }),
    ...(tri.outlineAlignment != null && { outlineAlignment: tri.outlineAlignment }),
    ...(tri.outlineAlignmentByZone != null && { outlineAlignmentByZone: tri.outlineAlignmentByZone }),
    ...(tri.outlineSmoothing != null && { outlineSmoothing: tri.outlineSmoothing }),
    ...(tri.outlineSmoothingByZone != null && { outlineSmoothingByZone: tri.outlineSmoothingByZone }),
    ...(tri.outlineColorByZone != null && { outlineColorByZone: tri.outlineColorByZone }),
    ...(tri.outlineInflateGlobal != null && { outlineInflateGlobal: tri.outlineInflateGlobal }),
    ...(tri.outlineInflateByZone != null && { outlineInflateByZone: tri.outlineInflateByZone }),
    ...(tri.previewInpaintingEnabled != null && { previewInpaintingEnabled: tri.previewInpaintingEnabled }),
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
    zoneSeeds: doc.zoneSeeds,
    zoneSmoothSigmas: doc.zoneSmoothSigmas,
    zoneInflates: doc.zoneInflates,
    zoneBeziers: doc.zoneBeziers,
    zoneCannyRefs: doc.zoneCannyRefs,
    zoneOrigins: doc.zoneOrigins,
    zoneOriginsValidated: doc.zoneOriginsValidated,
    zoneAnchors: doc.zoneAnchors,
    zoneAnchorsValidated: doc.zoneAnchorsValidated,
    zoneSubdivisionPoints: doc.zoneSubdivisionPoints,
    zoneSubdivisionParams: doc.zoneSubdivisionParams,
    zoneManualSubdivisionParams: doc.zoneManualSubdivisionParams,
    zoneManualSubdivisionPoints: doc.zoneManualSubdivisionPoints,
    zoneSubdivisionValidated: doc.zoneSubdivisionValidated,
    zonePixelAdjusted: doc.zonePixelAdjusted,
    zoneContourLength: doc.zoneContourLength,
    zoneContourCount: doc.zoneContourCount ?? {},
    zoneContourPoints: doc.zoneContourPoints ?? {},
    zoneContourValidated: doc.zoneContourValidated ?? {},
    zonePoints: doc.zonePoints ?? {},
    zoneTriangles,
    zoneManualPoints: doc.zoneManualPoints,
    zoneManualTriangles: doc.zoneManualTriangles
      ? Object.fromEntries(
          Object.entries(doc.zoneManualTriangles).map(([zid, tris]) => [zid, docToTri(tris as TriangleDoc[])])
        )
      : undefined,
    zoneDensity: doc.zoneDensity ?? {},
    bodyPoints: doc.bodyPoints ?? [],
    bodyTriangles: docToTri(doc.bodyTriangles ?? []),
    ...(doc.bodyPointsBaseline != null && { bodyPointsBaseline: doc.bodyPointsBaseline }),
    ...(doc.bodyTrianglesBaseline != null && { bodyTrianglesBaseline: docToTri(doc.bodyTrianglesBaseline) }),
    ...(doc.zonePointsBaseline != null && { zonePointsBaseline: doc.zonePointsBaseline }),
    ...(doc.zoneTrianglesBaseline != null && {
      zoneTrianglesBaseline: Object.fromEntries(
        Object.entries(doc.zoneTrianglesBaseline).map(([zid, tris]) => [zid, docToTri(tris as TriangleDoc[])])
      ),
    }),
    step2Validated: doc.step2Validated ?? false,
    hiddenFaceZones: doc.hiddenFaceZones ?? [],
    hiddenFaceLimbZones: (doc.hiddenFaceLimbZones ?? []).map(hfl => ({
      ...hfl,
      id: hfl.id ?? crypto.randomUUID(),
    })),
    step3Validated: doc.step3Validated ?? false,
    outlineWidthGlobal: doc.outlineWidthGlobal,
    outlineWidthByZone: doc.outlineWidthByZone,
    outlineAlignment: doc.outlineAlignment,
    outlineAlignmentByZone: doc.outlineAlignmentByZone,
    outlineSmoothing: doc.outlineSmoothing,
    outlineSmoothingByZone: doc.outlineSmoothingByZone,
    outlineColorByZone: doc.outlineColorByZone,
    outlineInflateGlobal: doc.outlineInflateGlobal,
    outlineInflateByZone: doc.outlineInflateByZone,
    previewInpaintingEnabled: doc.previewInpaintingEnabled,
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
    ...(mesh.sam2BodyBonesValidated != null && { sam2BodyBonesValidated: mesh.sam2BodyBonesValidated }),
    // Étape 10 "Lissage Bones" / V2 "Lissage Anchor"
    ...(mesh.sam2SmoothingCutoffHz != null && { sam2SmoothingCutoffHz: mesh.sam2SmoothingCutoffHz }),
    ...(mesh.sam2SmoothingValidated != null && { sam2SmoothingValidated: mesh.sam2SmoothingValidated }),
    hasSam2SmoothedAnchorFrames: mesh.sam2SmoothedAnchorFrames != null,
    hasSam2SmoothedSubdivisionFrames: mesh.sam2SmoothedSubdivisionFrames != null,
    hasSam2SmoothedContourOriginFrames: mesh.sam2SmoothedContourOriginFrames != null,
    // V2 "Lissage Maillage Corps"
    ...(mesh.walkBodyFramesSmoothingCutoffHz != null && { walkBodyFramesSmoothingCutoffHz: mesh.walkBodyFramesSmoothingCutoffHz }),
    ...(mesh.walkBodyFramesSmoothingValidated != null && { walkBodyFramesSmoothingValidated: mesh.walkBodyFramesSmoothingValidated }),
    hasWalkBodyFramesSmoothed: mesh.walkBodyFramesSmoothed != null,
    // V2 "Lissage Maillage Pattes"
    ...(mesh.walkZoneFramesSmoothingCutoffHz != null && { walkZoneFramesSmoothingCutoffHz: mesh.walkZoneFramesSmoothingCutoffHz }),
    ...(mesh.walkZoneFramesSmoothingValidated != null && { walkZoneFramesSmoothingValidated: mesh.walkZoneFramesSmoothingValidated }),
    hasWalkZoneFramesSmoothed: mesh.walkZoneFramesSmoothed != null,
    // V3 "Calcul Corps" — petits champs en Firestore
    ...(mesh.v3BodyTriangles != null && { v3BodyTriangles: triToDoc(mesh.v3BodyTriangles) }),
    ...(mesh.v3BodyTriangulationValidated != null && { v3BodyTriangulationValidated: mesh.v3BodyTriangulationValidated }),
    // CoTracker + Bones (animation type cotracker-bones)
    ...(mesh.cotrackerPoints != null && { cotrackerPoints: mesh.cotrackerPoints }),
    ...(mesh.cotrackerVideoWidth != null && { cotrackerVideoWidth: mesh.cotrackerVideoWidth }),
    ...(mesh.cotrackerVideoHeight != null && { cotrackerVideoHeight: mesh.cotrackerVideoHeight }),
    ...(mesh.cotrackerTrackingValidated != null && { cotrackerTrackingValidated: mesh.cotrackerTrackingValidated }),
    hasCotrackerFrames: mesh.cotrackerFrames != null,
    hasCotrackerFramesRaw: mesh.cotrackerFramesRaw != null,
    hasCotrackerVisibility: mesh.cotrackerVisibility != null,
    ...(mesh.cotrackerVisibilityThreshold != null && { cotrackerVisibilityThreshold: mesh.cotrackerVisibilityThreshold }),
    ...(mesh.cotrackerSkeleton != null && { cotrackerSkeleton: mesh.cotrackerSkeleton }),
    ...(mesh.cotrackerBonesValidated != null && { cotrackerBonesValidated: mesh.cotrackerBonesValidated }),
    ...(mesh.cotrackerBoneSmoothingCutoffHz != null && { cotrackerBoneSmoothingCutoffHz: mesh.cotrackerBoneSmoothingCutoffHz }),
    ...(mesh.cotrackerBoneSmoothingValidated != null && { cotrackerBoneSmoothingValidated: mesh.cotrackerBoneSmoothingValidated }),
    ...(mesh.cotrackerLBSParams != null && { cotrackerLBSParams: mesh.cotrackerLBSParams }),
    ...(mesh.cotrackerLBSValidated != null && { cotrackerLBSValidated: mesh.cotrackerLBSValidated }),
    ...(mesh.cotrackerJawOpennessFrames != null && { cotrackerJawOpennessFrames: mesh.cotrackerJawOpennessFrames }),
    ...(mesh.cotrackerEyePupilFrames != null && { cotrackerEyePupilFrames: mesh.cotrackerEyePupilFrames }),
    // Marche (animation type 'marche')
    ...(mesh.marcheParentAnimationId != null && { marcheParentAnimationId: mesh.marcheParentAnimationId }),
    ...(mesh.marcheSkeleton != null && { marcheSkeleton: mesh.marcheSkeleton }),
    ...(mesh.marcheBodyJointRestPositions != null && { marcheBodyJointRestPositions: mesh.marcheBodyJointRestPositions }),
    ...(mesh.marcheLegRestPositions != null && { marcheLegRestPositions: mesh.marcheLegRestPositions }),
    ...(mesh.marcheInheritValidated != null && { marcheInheritValidated: mesh.marcheInheritValidated }),
    ...(mesh.marcheGaitLegIds != null && { marcheGaitLegIds: mesh.marcheGaitLegIds }),
    ...(mesh.marcheGaitLegsValidated != null && { marcheGaitLegsValidated: mesh.marcheGaitLegsValidated }),
    ...(mesh.marcheLegPhases != null && { marcheLegPhases: mesh.marcheLegPhases }),
    // Bruits de pas
    ...(mesh.footstepFrames != null && { footstepFrames: mesh.footstepFrames }),
    ...(mesh.footstepVolume != null && { footstepVolume: mesh.footstepVolume }),
    ...(mesh.footstepOffsetMs != null && { footstepOffsetMs: mesh.footstepOffsetMs }),
    ...(mesh.footstepValidated != null && { footstepValidated: mesh.footstepValidated }),
  }
}

function animToDoc(anim: Animation): AnimationDoc {
  return {
    id: anim.id,
    name: anim.name,
    type: anim.type,
    ...(anim.playbackMode != null && { playbackMode: anim.playbackMode }),
    createdAt: anim.createdAt,
    hasVideo: anim.videoBlob != null,
    hasAudio: anim.audioBlob != null,
    hasFootstep1: anim.footstepSound1Blob != null,
    hasFootstep2: anim.footstepSound2Blob != null,
    audioEnabled: anim.audioEnabled ?? false,
    mesh: anim.mesh ? meshToDoc(anim.mesh) : null,
    physicsCode: anim.physicsCode ?? null,
    physicsDuration: anim.physicsDuration ?? null,
    physicsOverlay: anim.physicsOverlay ?? false,
  }
}

/** Helper : meta doc d'un SceneSound (id, name, volume/loop/rate optionnels — pas le blob). */
function sceneSoundMetaToDoc(s: { id: string; name: string; volume?: number; loop?: boolean; rate?: number }): SceneSoundMetaDoc {
  return {
    id: s.id,
    name: s.name,
    ...(s.volume != null && { volume: s.volume }),
    ...(s.loop && { loop: true }),
    ...(s.rate != null && { rate: s.rate }),
  }
}

/** Sérialise un SceneAction (strippe les blobs des sons via sceneSoundMetaToDoc). */
function actionToDoc(a: import('../types/project').SceneAction): SceneActionDoc {
  return {
    id: a.id,
    name: a.name,
    steps: a.steps.map(s => ({
      animationId: s.animationId,
      ...(s.sound != null && { sound: sceneSoundMetaToDoc(s.sound) }),
      ...(s.isSpoken && { isSpoken: true }),
      ...(s.animSpeedMul != null && { animSpeedMul: s.animSpeedMul }),
      ...(s.loop && { loop: true }),
    })),
    ...(a.sound != null && { sound: sceneSoundMetaToDoc(a.sound) }),
    ...(a.isSpoken && { isSpoken: true }),
  }
}

function filmTravelToDoc(t: import('../types/project').FilmTravel): FilmTravelDoc {
  return {
    ...(t.animationId != null && { animationId: t.animationId }),
    ...(t.speedPxPerSec != null && { speedPxPerSec: t.speedPxPerSec }),
    ...(t.animSpeedMul != null && { animSpeedMul: t.animSpeedMul }),
    ...(t.sound != null && { sound: sceneSoundMetaToDoc(t.sound) }),
    ...(t.origin != null && { origin: t.origin }),
    ...(t.controlPoints != null && t.controlPoints.length > 0 && { controlPoints: t.controlPoints.map(cp => ({ x: cp.x, y: cp.y })) }),
    ...(t.easing != null && { easing: t.easing }),
  }
}

function filmDepartureToDoc(d: import('../types/project').FilmDeparture): FilmDepartureDoc {
  return {
    target: d.target.kind === 'offscreen'
      ? { kind: 'offscreen', side: d.target.side }
      : { kind: 'custom', x: d.target.x, y: d.target.y, ...(d.target.scale != null && { scale: d.target.scale }) },
    travel: filmTravelToDoc(d.travel),
  }
}

function filmPointToDoc(p: import('../types/project').FilmPoint): FilmPointDoc {
  return {
    id: p.id,
    x: p.x,
    y: p.y,
    scale: p.scale,
    travel: filmTravelToDoc(p.travel),
    ...(p.action != null && { action: actionToDoc(p.action) }),
    ...(p.pauseMs != null && p.pauseMs > 0 && { pauseMs: p.pauseMs }),
    ...(p.facing != null && { facing: p.facing }),
    ...(p.departure != null && { departure: filmDepartureToDoc(p.departure) }),
  }
}

function filmEndingToDoc(e: import('../types/project').FilmEnding): FilmEndingDoc {
  return e.kind === 'exit'
    ? { kind: 'exit', side: e.side, travel: filmTravelToDoc(e.travel) }
    : { kind: 'stay' }
}

function filmPlanToDoc(pl: import('../types/project').SceneFilmPlan): FilmPlanDoc {
  return {
    id: pl.id,
    ...(pl.name != null && { name: pl.name }),
    background: pl.background ? {
      hasImage: pl.background.imageBlob != null,
      hasVideo: pl.background.videoBlob != null,
      width: pl.background.width,
      height: pl.background.height,
    } : null,
    foreground: pl.foreground ? {
      hasImage: pl.foreground.imageBlob != null,
      hasVideo: pl.foreground.videoBlob != null,
      width: pl.foreground.width,
      height: pl.foreground.height,
      ...(pl.foreground.chromaKeyColor != null && { chromaKeyColor: pl.foreground.chromaKeyColor }),
      ...(pl.foreground.chromaKeyThreshold != null && { chromaKeyThreshold: pl.foreground.chromaKeyThreshold }),
      ...(pl.foreground.chromaKeySmoothness != null && { chromaKeySmoothness: pl.foreground.chromaKeySmoothness }),
    } : null,
    cameraX: pl.cameraX,
    entrySide: pl.entrySide,
    points: pl.points.map(filmPointToDoc),
    ending: filmEndingToDoc(pl.ending),
    ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
    ...(pl.moveAnimationId != null && { moveAnimationId: pl.moveAnimationId }),
    ...(pl.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: pl.moveSpeedPxPerSec }),
    ...(pl.idleSpeedMul != null && { idleSpeedMul: pl.idleSpeedMul }),
  }
}

function filmToDoc(film: import('../types/project').SceneFilm): SceneFilmDoc {
  const first = film.plans[0]
  return {
    enabled: film.enabled,
    plans: film.plans.map(filmPlanToDoc),
    // Miroir legacy de plans[0] à plat : un client play pas encore déployé joue
    // au moins le plan 1 (les nouveaux champs y sont simplement ignorés).
    entrySide: first?.entrySide ?? 'left',
    points: first ? first.points.map(filmPointToDoc) : [],
    ending: first ? filmEndingToDoc(first.ending) : { kind: 'stay' },
    cameraX: first?.cameraX ?? 0,
    ...(film.moveAnimationId != null && { moveAnimationId: film.moveAnimationId }),
    moveSpeedPxPerSec: film.moveSpeedPxPerSec,
    ...(film.idleSpeedMul != null && { idleSpeedMul: film.idleSpeedMul }),
    endBehavior: film.endBehavior,
  }
}

// --- Sérialisation FILM niveau projet ---

function filmV3ToDoc(film: import('../types/project').Film): FilmDoc {
  return {
    plans: film.plans.map((pl): FilmPlanV3Doc => ({
      id: pl.id,
      ...(pl.name != null && { name: pl.name }),
      backdrop: pl.backdrop ? {
        hasImage: pl.backdrop.imageBlob != null,
        hasVideo: pl.backdrop.videoBlob != null,
        width: pl.backdrop.width,
        height: pl.backdrop.height,
      } : null,
      overlay: pl.overlay ? {
        hasImage: pl.overlay.imageBlob != null,
        hasVideo: pl.overlay.videoBlob != null,
        width: pl.overlay.width,
        height: pl.overlay.height,
        ...(pl.overlay.chromaKeyColor != null && { chromaKeyColor: pl.overlay.chromaKeyColor }),
        ...(pl.overlay.chromaKeyThreshold != null && { chromaKeyThreshold: pl.overlay.chromaKeyThreshold }),
        ...(pl.overlay.chromaKeySmoothness != null && { chromaKeySmoothness: pl.overlay.chromaKeySmoothness }),
      } : null,
      cameraX: pl.cameraX,
      entrySide: pl.entrySide,
      points: pl.points.map(filmPointToDoc),
      ending: filmEndingToDoc(pl.ending),
      ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
      ...(pl.moveAnimationId != null && { moveAnimationId: pl.moveAnimationId }),
      ...(pl.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: pl.moveSpeedPxPerSec }),
      ...(pl.idleSpeedMul != null && { idleSpeedMul: pl.idleSpeedMul }),
    })),
    character: {
      scale: film.character.scale,
      facing: film.character.facing,
      originU: film.character.originU,
      originV: film.character.originV,
    },
    ...(film.music != null && { music: sceneSoundMetaToDoc(film.music) }),
    ...(film.moveAnimationId != null && { moveAnimationId: film.moveAnimationId }),
    moveSpeedPxPerSec: film.moveSpeedPxPerSec,
    ...(film.idleSpeedMul != null && { idleSpeedMul: film.idleSpeedMul }),
  }
}

/** Désérialise un FilmDoc. `getBlob` fournit les blobs des sons (film/sounds/{id}) ;
 *  les décors de plans sont hydratés séparément (hydrateFilmV3DecorBlobs). */
function docToFilmV3(filmDoc: FilmDoc, getBlob: (id: string) => Blob | null): import('../types/project').Film {
  const mapSound = (m: SceneSoundMetaDoc): import('../types/project').SceneSound => ({
    id: m.id, name: m.name, volume: m.volume, loop: m.loop, rate: m.rate, blob: getBlob(m.id),
  })
  const mapAction = (a: SceneActionDoc): import('../types/project').SceneAction => ({
    id: a.id,
    name: a.name,
    steps: (a.steps ?? []).map(s => ({
      animationId: s.animationId,
      ...(s.sound != null && { sound: mapSound(s.sound) }),
      ...(s.isSpoken && { isSpoken: true }),
      ...(s.animSpeedMul != null && { animSpeedMul: s.animSpeedMul }),
      ...(s.loop && { loop: true }),
    })),
    ...(a.sound != null && { sound: mapSound(a.sound) }),
    ...(a.isSpoken && { isSpoken: true }),
  })
  const mapTravel = (t: FilmTravelDoc | undefined): import('../types/project').FilmTravel => ({
    ...(t?.animationId != null && { animationId: t.animationId }),
    ...(t?.speedPxPerSec != null && { speedPxPerSec: t.speedPxPerSec }),
    ...(t?.animSpeedMul != null && { animSpeedMul: t.animSpeedMul }),
    ...(t?.sound != null && { sound: mapSound(t.sound) }),
    ...(t?.origin != null && { origin: t.origin }),
    ...(t?.controlPoints != null && t.controlPoints.length > 0 && { controlPoints: t.controlPoints.map(cp => ({ x: cp.x, y: cp.y })) }),
    ...(t?.easing != null && { easing: t.easing }),
  })
  const mapPoint = (p: FilmPointDoc): import('../types/project').FilmPoint => ({
    id: p.id,
    x: p.x,
    y: p.y,
    scale: p.scale ?? 1,
    travel: mapTravel(p.travel),
    ...(p.action != null && { action: mapAction(p.action) }),
    ...(p.pauseMs != null && p.pauseMs > 0 && { pauseMs: p.pauseMs }),
    ...(p.facing != null && { facing: p.facing }),
    ...(p.departure != null && { departure: { target: p.departure.target, travel: mapTravel(p.departure.travel) } }),
  })
  const mapEnding = (e: FilmEndingDoc | undefined): import('../types/project').FilmEnding =>
    e?.kind === 'exit' ? { kind: 'exit', side: e.side, travel: mapTravel(e.travel) } : { kind: 'stay' }

  return {
    plans: (filmDoc.plans ?? []).map((pl): import('../types/project').FilmPlan => ({
      id: pl.id,
      ...(pl.name != null && { name: pl.name }),
      backdrop: pl.backdrop
        ? { imageBlob: null, videoBlob: null, width: pl.backdrop.width, height: pl.backdrop.height }
        : null,
      overlay: pl.overlay
        ? {
            imageBlob: null,
            videoBlob: null,
            width: pl.overlay.width,
            height: pl.overlay.height,
            chromaKeyColor: pl.overlay.chromaKeyColor ?? null,
            chromaKeyThreshold: pl.overlay.chromaKeyThreshold,
            chromaKeySmoothness: pl.overlay.chromaKeySmoothness,
          }
        : null,
      cameraX: pl.cameraX ?? 0,
      entrySide: pl.entrySide ?? 'left',
      points: (pl.points ?? []).map(mapPoint),
      ending: mapEnding(pl.ending),
      ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
      ...(pl.moveAnimationId != null && { moveAnimationId: pl.moveAnimationId }),
      ...(pl.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: pl.moveSpeedPxPerSec }),
      ...(pl.idleSpeedMul != null && { idleSpeedMul: pl.idleSpeedMul }),
    })),
    character: {
      scale: filmDoc.character?.scale ?? 1,
      facing: filmDoc.character?.facing ?? 'right',
      originU: filmDoc.character?.originU ?? 0.5,
      originV: filmDoc.character?.originV ?? 1.0,
    },
    ...(filmDoc.music != null && { music: { id: filmDoc.music.id, name: filmDoc.music.name, blob: getBlob(filmDoc.music.id), volume: filmDoc.music.volume } }),
    ...(filmDoc.moveAnimationId != null && { moveAnimationId: filmDoc.moveAnimationId }),
    moveSpeedPxPerSec: filmDoc.moveSpeedPxPerSec ?? 260,
    ...(filmDoc.idleSpeedMul != null && { idleSpeedMul: filmDoc.idleSpeedMul }),
  }
}

/** Itère tous les sons d'un Film (musique + trajets + sorties + actions/étapes + endings). */
function* iterateFilmV3Sounds(film: import('../types/project').Film | null | undefined): Generator<{ id: string; blob: Blob | null }> {
  if (!film) return
  if (film.music) yield { id: film.music.id, blob: film.music.blob }
  for (const pl of film.plans) {
    for (const p of pl.points) {
      if (p.travel?.sound) yield { id: p.travel.sound.id, blob: p.travel.sound.blob }
      if (p.departure?.travel?.sound) yield { id: p.departure.travel.sound.id, blob: p.departure.travel.sound.blob }
      if (p.action) {
        if (p.action.sound) yield { id: p.action.sound.id, blob: p.action.sound.blob }
        for (const s of p.action.steps ?? []) if (s.sound) yield { id: s.sound.id, blob: s.sound.blob }
      }
    }
    if (pl.ending.kind === 'exit' && pl.ending.travel.sound) yield { id: pl.ending.travel.sound.id, blob: pl.ending.travel.sound.blob }
  }
}

/** Ids de sons référencés par un FilmDoc (pour le download film/sounds/). */
function collectFilmV3DocSoundIds(filmDoc: FilmDoc | null | undefined): string[] {
  if (!filmDoc) return []
  const ids = new Set<string>()
  if (filmDoc.music) ids.add(filmDoc.music.id)
  const fromTravel = (t: FilmTravelDoc | undefined) => { if (t?.sound) ids.add(t.sound.id) }
  const fromAction = (a: SceneActionDoc | undefined) => {
    if (!a) return
    if (a.sound) ids.add(a.sound.id)
    for (const s of a.steps ?? []) if (s.sound) ids.add(s.sound.id)
  }
  for (const pl of filmDoc.plans ?? []) {
    for (const p of pl.points ?? []) {
      fromTravel(p.travel)
      fromTravel(p.departure?.travel)
      fromAction(p.action)
    }
    if (pl.ending?.kind === 'exit') fromTravel(pl.ending.travel)
  }
  return [...ids]
}

/** Télécharge et attache les blobs de décors des plans d'un Film (doc.film présent). */
async function hydrateFilmV3DecorBlobs(projectId: string, film: import('../types/project').Film): Promise<import('../types/project').Film> {
  const plans = await Promise.all(film.plans.map(async (pl) => {
    const [bd, ov] = await Promise.all([
      pl.backdrop ? downloadBlob(`projects/${projectId}/film/plans/${pl.id}/backdrop`).catch(() => null) : Promise.resolve(null),
      pl.overlay ? downloadBlob(`projects/${projectId}/film/plans/${pl.id}/overlay`).catch(() => null) : Promise.resolve(null),
    ])
    return {
      ...pl,
      backdrop: pl.backdrop && bd
        ? { ...pl.backdrop, imageBlob: bd.type.startsWith('video/') ? null : bd, videoBlob: bd.type.startsWith('video/') ? bd : null }
        : pl.backdrop,
      overlay: pl.overlay && ov
        ? { ...pl.overlay, imageBlob: ov.type.startsWith('video/') ? null : ov, videoBlob: ov.type.startsWith('video/') ? ov : null }
        : pl.overlay,
    }
  }))
  return { ...film, plans }
}

// --- Sérialisation FILM TIMELINE (v4) ---

function filmTToDoc(film: import('../types/project').FilmT): FilmTDoc {
  const cleanMotion = (c: import('../types/project').FilmMotionClip): FilmMotionClipDoc => ({
    id: c.id,
    startMs: c.startMs,
    durationMs: c.durationMs,
    kind: c.kind,
    ...(c.from != null && { from: c.from }),
    to: c.to,
    ...(c.controlPoints != null && c.controlPoints.length > 0 && { controlPoints: c.controlPoints.map(cp => ({ x: cp.x, y: cp.y })) }),
    ...(c.easing != null && { easing: c.easing }),
    ...(c.animationId != null && { animationId: c.animationId }),
    ...(c.animSpeedMul != null && { animSpeedMul: c.animSpeedMul }),
    ...(c.lockedSpeedPxPerSec != null && { lockedSpeedPxPerSec: c.lockedSpeedPxPerSec }),
  })
  const cleanAnim = (c: import('../types/project').FilmAnimClip): FilmAnimClipDoc => ({
    id: c.id,
    startMs: c.startMs,
    durationMs: c.durationMs,
    animationId: c.animationId,
    ...(c.speedMul != null && { speedMul: c.speedMul }),
    fillMode: c.fillMode,
  })
  const cleanSound = (c: import('../types/project').FilmSoundClip): FilmSoundClipDoc => ({
    id: c.id,
    startMs: c.startMs,
    durationMs: c.durationMs,
    soundId: c.soundId,
    ...(c.volume != null && { volume: c.volume }),
    ...(c.rate != null && { rate: c.rate }),
    ...(c.loop === true && { loop: true }),
    ...(c.isSpoken === true && { isSpoken: true }),
    ...(c.fadeInMs != null && { fadeInMs: c.fadeInMs }),
    ...(c.fadeOutMs != null && { fadeOutMs: c.fadeOutMs }),
    ...(c.anchor != null && { anchor: c.anchor }),
  })
  return {
    version: 4,
    plans: film.plans.map((pl): FilmTPlanDoc => ({
      id: pl.id,
      ...(pl.name != null && { name: pl.name }),
      backdrop: pl.backdrop ? {
        hasImage: pl.backdrop.imageBlob != null,
        hasVideo: pl.backdrop.videoBlob != null,
        width: pl.backdrop.width,
        height: pl.backdrop.height,
      } : null,
      overlay: pl.overlay ? {
        hasImage: pl.overlay.imageBlob != null,
        hasVideo: pl.overlay.videoBlob != null,
        width: pl.overlay.width,
        height: pl.overlay.height,
        ...(pl.overlay.chromaKeyColor != null && { chromaKeyColor: pl.overlay.chromaKeyColor }),
        ...(pl.overlay.chromaKeyThreshold != null && { chromaKeyThreshold: pl.overlay.chromaKeyThreshold }),
        ...(pl.overlay.chromaKeySmoothness != null && { chromaKeySmoothness: pl.overlay.chromaKeySmoothness }),
      } : null,
      cameraX: pl.cameraX,
      ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
      durationMs: pl.timeline.durationMs,
      waypoints: pl.timeline.waypoints.map(w => ({
        id: w.id, x: w.x, y: w.y, scale: w.scale,
        ...(w.facing != null && { facing: w.facing }),
      })),
      motion: pl.timeline.motion.map(cleanMotion),
      anim: pl.timeline.anim.map(cleanAnim),
      soundTracks: pl.timeline.soundTracks.map(track => ({ clips: track.map(cleanSound) })),
    })),
    character: {
      scale: film.character.scale,
      facing: film.character.facing,
      originU: film.character.originU,
      originV: film.character.originV,
    },
    sounds: film.sounds.map(snd => ({ id: snd.id, name: snd.name, ...(snd.volume != null && { volume: snd.volume }) })),
    ...(film.music != null && { music: sceneSoundMetaToDoc(film.music) }),
    ...(film.footstepsEnabled != null && { footstepsEnabled: film.footstepsEnabled }),
    ...(film.moveAnimationId != null && { moveAnimationId: film.moveAnimationId }),
    ...(film.intro != null && { intro: film.intro }),
    ...(film.outro != null && { outro: film.outro }),
    ...(film.introFadeMs != null && { introFadeMs: film.introFadeMs }),
    ...(film.outroFadeMs != null && { outroFadeMs: film.outroFadeMs }),
    moveSpeedPxPerSec: film.moveSpeedPxPerSec,
    ...(film.idleSpeedMul != null && { idleSpeedMul: film.idleSpeedMul }),
  }
}

/** Désérialise un FilmTDoc. `getBlob` fournit les blobs des sons (film/sounds/{id}) ;
 *  les décors de plans sont hydratés séparément (hydrateFilmTDecorBlobs). */
function docToFilmT(filmDoc: FilmTDoc, getBlob: (id: string) => Blob | null): import('../types/project').FilmT {
  return {
    version: 4,
    plans: (filmDoc.plans ?? []).map((pl): import('../types/project').FilmTimelinePlan => ({
      id: pl.id,
      ...(pl.name != null && { name: pl.name }),
      backdrop: pl.backdrop
        ? { imageBlob: null, videoBlob: null, width: pl.backdrop.width, height: pl.backdrop.height }
        : null,
      overlay: pl.overlay
        ? {
            imageBlob: null,
            videoBlob: null,
            width: pl.overlay.width,
            height: pl.overlay.height,
            chromaKeyColor: pl.overlay.chromaKeyColor ?? null,
            chromaKeyThreshold: pl.overlay.chromaKeyThreshold,
            chromaKeySmoothness: pl.overlay.chromaKeySmoothness,
          }
        : null,
      cameraX: pl.cameraX ?? 0,
      ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
      timeline: {
        durationMs: pl.durationMs ?? 0,
        waypoints: (pl.waypoints ?? []).map(w => ({
          id: w.id, x: w.x, y: w.y, scale: w.scale ?? 1,
          ...(w.facing != null && { facing: w.facing }),
        })),
        motion: (pl.motion ?? []).map(c => ({
          id: c.id, startMs: c.startMs, durationMs: c.durationMs, kind: c.kind,
          ...(c.from != null && { from: c.from }),
          to: c.to,
          ...(c.controlPoints != null && c.controlPoints.length > 0 && { controlPoints: c.controlPoints.map(cp => ({ x: cp.x, y: cp.y })) }),
          ...(c.easing != null && { easing: c.easing }),
          ...(c.animationId != null && { animationId: c.animationId }),
          ...(c.animSpeedMul != null && { animSpeedMul: c.animSpeedMul }),
          ...(c.lockedSpeedPxPerSec != null && { lockedSpeedPxPerSec: c.lockedSpeedPxPerSec }),
        })),
        anim: (pl.anim ?? []).map(c => ({
          id: c.id, startMs: c.startMs, durationMs: c.durationMs, animationId: c.animationId,
          ...(c.speedMul != null && { speedMul: c.speedMul }),
          fillMode: c.fillMode ?? 'loop',
        })),
        soundTracks: (pl.soundTracks ?? []).map(track => (track.clips ?? []).map(c => ({
          id: c.id, startMs: c.startMs, durationMs: c.durationMs, soundId: c.soundId,
          ...(c.volume != null && { volume: c.volume }),
          ...(c.rate != null && { rate: c.rate }),
          ...(c.loop === true && { loop: true }),
          ...(c.isSpoken === true && { isSpoken: true }),
          ...(c.fadeInMs != null && { fadeInMs: c.fadeInMs }),
          ...(c.fadeOutMs != null && { fadeOutMs: c.fadeOutMs }),
          ...(c.anchor != null && { anchor: c.anchor }),
        }))),
      },
    })),
    character: {
      scale: filmDoc.character?.scale ?? 1,
      facing: filmDoc.character?.facing ?? 'right',
      originU: filmDoc.character?.originU ?? 0.5,
      originV: filmDoc.character?.originV ?? 1.0,
    },
    sounds: (filmDoc.sounds ?? []).map(snd => ({ id: snd.id, name: snd.name, blob: getBlob(snd.id), ...(snd.volume != null && { volume: snd.volume }) })),
    ...(filmDoc.music != null && { music: { id: filmDoc.music.id, name: filmDoc.music.name, blob: getBlob(filmDoc.music.id), volume: filmDoc.music.volume } }),
    ...(filmDoc.footstepsEnabled != null && { footstepsEnabled: filmDoc.footstepsEnabled }),
    ...(filmDoc.moveAnimationId != null && { moveAnimationId: filmDoc.moveAnimationId }),
    ...(filmDoc.intro != null && { intro: filmDoc.intro }),
    ...(filmDoc.outro != null && { outro: filmDoc.outro }),
    ...(filmDoc.introFadeMs != null && { introFadeMs: filmDoc.introFadeMs }),
    ...(filmDoc.outroFadeMs != null && { outroFadeMs: filmDoc.outroFadeMs }),
    moveSpeedPxPerSec: filmDoc.moveSpeedPxPerSec ?? 260,
    ...(filmDoc.idleSpeedMul != null && { idleSpeedMul: filmDoc.idleSpeedMul }),
  }
}

/** Itère tous les sons d'un FilmT (bibliothèque + musique). */
function* iterateFilmTSounds(film: import('../types/project').FilmT | null | undefined): Generator<{ id: string; blob: Blob | null }> {
  if (!film) return
  if (film.music) yield { id: film.music.id, blob: film.music.blob }
  for (const snd of film.sounds) yield { id: snd.id, blob: snd.blob }
}

/** Ids de sons référencés par un FilmTDoc (download film/sounds/). */
function collectFilmTDocSoundIds(filmDoc: FilmTDoc | null | undefined): string[] {
  if (!filmDoc) return []
  const ids = new Set<string>()
  if (filmDoc.music) ids.add(filmDoc.music.id)
  for (const snd of filmDoc.sounds ?? []) ids.add(snd.id)
  return [...ids]
}

/** Télécharge et attache les blobs de décors des plans d'un FilmT. */
async function hydrateFilmTDecorBlobs(projectId: string, film: import('../types/project').FilmT): Promise<import('../types/project').FilmT> {
  const plans = await Promise.all(film.plans.map(async (pl) => {
    const [bd, ov] = await Promise.all([
      pl.backdrop ? downloadBlob(`projects/${projectId}/film/plans/${pl.id}/backdrop`).catch(() => null) : Promise.resolve(null),
      pl.overlay ? downloadBlob(`projects/${projectId}/film/plans/${pl.id}/overlay`).catch(() => null) : Promise.resolve(null),
    ])
    return {
      ...pl,
      backdrop: pl.backdrop && bd
        ? { ...pl.backdrop, imageBlob: bd.type.startsWith('video/') ? null : bd, videoBlob: bd.type.startsWith('video/') ? bd : null }
        : pl.backdrop,
      overlay: pl.overlay && ov
        ? { ...pl.overlay, imageBlob: ov.type.startsWith('video/') ? null : ov, videoBlob: ov.type.startsWith('video/') ? ov : null }
        : pl.overlay,
    }
  }))
  return { ...film, plans }
}

/** Remappe les références d'animations d'un FilmT (duplication). */
function remapFilmTAnimationIds(film: import('../types/project').FilmT | null | undefined, idMap: Map<string, string>): import('../types/project').FilmT | null {
  if (!film) return null
  const mapId = (aid: string) => idMap.get(aid) ?? aid
  return {
    ...film,
    ...(film.moveAnimationId != null && { moveAnimationId: mapId(film.moveAnimationId) }),
    plans: film.plans.map(pl => ({
      ...pl,
      timeline: {
        ...pl.timeline,
        motion: pl.timeline.motion.map(c => c.animationId != null ? { ...c, animationId: mapId(c.animationId) } : c),
        anim: pl.timeline.anim.map(c => ({ ...c, animationId: mapId(c.animationId) })),
      },
    })),
  }
}

/**
 * MIGRATION legacy : convertit un film stocké dans la scène (SceneFilm) vers le
 * modèle Film niveau projet. Les blobs de la scène (décor, sons) sont réutilisés
 * tels quels en mémoire ; la première sauvegarde du FilmEditor les uploade sous
 * les nouveaux chemins film/… (flag `filmNeedsFullUpload`).
 */
function convertLegacySceneFilm(scene: Scene): import('../types/project').Film | null {
  const sf = scene.film
  if (!sf || !sf.plans.some(pl => pl.points.length > 0)) return null
  const sceneBackdrop = scene.background && (scene.background.imageBlob || scene.background.videoBlob) ? scene.background : null
  return {
    plans: sf.plans.map((pl): import('../types/project').FilmPlan => {
      const ownDecor = pl.background != null
      const backdrop = ownDecor ? pl.background : sceneBackdrop
      const overlay = ownDecor ? pl.foreground : (sceneBackdrop ? scene.foreground : null)
      return {
        id: pl.id,
        ...(pl.name != null && { name: pl.name }),
        backdrop: backdrop ? { ...backdrop } : null,
        overlay: overlay ? { ...overlay } : null,
        cameraX: pl.cameraX,
        entrySide: pl.entrySide,
        points: pl.points,
        ending: pl.ending,
        ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
        ...(pl.moveAnimationId != null && { moveAnimationId: pl.moveAnimationId }),
        ...(pl.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: pl.moveSpeedPxPerSec }),
        ...(pl.idleSpeedMul != null && { idleSpeedMul: pl.idleSpeedMul }),
      }
    }),
    character: {
      scale: scene.characterScale ?? 1,
      facing: scene.characterFacing ?? 'right',
      originU: scene.characterOriginU ?? 0.5,
      originV: scene.characterOriginV ?? 1.0,
    },
    ...(scene.ambientSound != null && {
      music: { id: scene.ambientSound.id, name: scene.ambientSound.name, blob: scene.ambientSound.blob, volume: scene.ambientSound.volume },
    }),
    ...(sf.moveAnimationId != null && { moveAnimationId: sf.moveAnimationId }),
    moveSpeedPxPerSec: sf.moveSpeedPxPerSec,
    ...(sf.idleSpeedMul != null && { idleSpeedMul: sf.idleSpeedMul }),
  }
}

/** « A un film jouable » calculé depuis le DOC (chargements de liste, sans blobs). */
function computeDocHasFilm(projDoc: ProjectDoc): boolean {
  const ft = projDoc.filmT
  if (ft && Array.isArray(ft.plans) && ft.plans.some(pl =>
    pl.backdrop != null && ((pl.motion?.length ?? 0) + (pl.anim?.length ?? 0) > 0))) return true
  const f = projDoc.film
  if (f && Array.isArray(f.plans) && f.plans.some(pl => pl.backdrop != null && (pl.points?.length ?? 0) > 0)) return true
  // Legacy : film dans la scène (converti à l'ouverture) — le décor vient de la scène.
  const sf = projDoc.scene?.film
  if (sf) {
    if (Array.isArray(sf.plans) && sf.plans.some(pl => (pl.points?.length ?? 0) > 0)) return true
    if (Array.isArray(sf.points) && sf.points.length > 0) return true
  }
  return false
}

function restPointToDoc(rp: import('../types/project').SceneRestPoint): SceneRestPointDoc {
  return {
    id: rp.id,
    backgroundX: rp.backgroundX,
    ...(rp.restAnimationId != null && { restAnimationId: rp.restAnimationId }),
    ...(rp.actions != null && rp.actions.length > 0 && { actions: rp.actions.map(actionToDoc) }),
    ...(rp.speeches != null && rp.speeches.length > 0 && { speeches: rp.speeches.map(actionToDoc) }),
    ...(rp.presentation != null && (rp.presentation.steps.length > 0 || rp.presentation.sound != null) && { presentation: actionToDoc(rp.presentation) }),
    ...(rp.zoneAnimationMappings != null && rp.zoneAnimationMappings.length > 0 && { zoneAnimationMappings: rp.zoneAnimationMappings }),
    ...(rp.speakSoundIds != null && { speakSoundIds: rp.speakSoundIds }),
    ...(rp.helpTexts != null && rp.helpTexts.length > 0 && { helpTexts: rp.helpTexts }),
  }
}

function sceneToDoc(scene: Scene): SceneDoc {
  return {
    id: scene.id,
    name: scene.name,
    background: scene.background ? {
      hasImage: scene.background.imageBlob != null,
      hasVideo: scene.background.videoBlob != null,
      width: scene.background.width,
      height: scene.background.height,
    } : null,
    foreground: scene.foreground ? {
      hasImage: scene.foreground.imageBlob != null,
      hasVideo: scene.foreground.videoBlob != null,
      width: scene.foreground.width,
      height: scene.foreground.height,
      ...(scene.foreground.chromaKeyColor != null && { chromaKeyColor: scene.foreground.chromaKeyColor }),
      ...(scene.foreground.chromaKeyThreshold != null && { chromaKeyThreshold: scene.foreground.chromaKeyThreshold }),
      ...(scene.foreground.chromaKeySmoothness != null && { chromaKeySmoothness: scene.foreground.chromaKeySmoothness }),
    } : null,
    characterScale: scene.characterScale,
    characterY: scene.characterY,
    restPoint: restPointToDoc(scene.restPoint),
    entry: scene.entry,
    ...(scene.entryStartX != null && { entryStartX: scene.entryStartX }),
    ...(scene.entryDurationMs != null && { entryDurationMs: scene.entryDurationMs }),
    ...(scene.entryAnimationId != null && { entryAnimationId: scene.entryAnimationId }),
    ...(scene.entrySound != null && { entrySound: sceneSoundMetaToDoc(scene.entrySound) }),
    ...(scene.ambientSound != null && { ambientSound: sceneSoundMetaToDoc(scene.ambientSound) }),
    ...(scene.walkTrapezoid != null && { walkTrapezoid: scene.walkTrapezoid }),
    ...(scene.film != null && { film: filmToDoc(scene.film) }),
    ...(scene.characterFacing != null && { characterFacing: scene.characterFacing }),
    ...(scene.characterOriginU != null && { characterOriginU: scene.characterOriginU }),
    ...(scene.characterOriginV != null && { characterOriginV: scene.characterOriginV }),
    ...(scene.speakSounds.length > 0 && { speakSounds: scene.speakSounds.map(s => (sceneSoundMetaToDoc(s))) }),
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
    // filmT prioritaire : quand présent, `film` (v3) n'est PLUS écrit — setDoc
    // remplace le doc entier, l'ancien champ disparaît (pattern v2→v3).
    ...(project.filmT != null
      ? { filmT: filmTToDoc(project.filmT) }
      : (project.film != null ? { film: filmV3ToDoc(project.film) } : {})),
    scene: project.scene ? sceneToDoc(project.scene) : null,
    ...(project.projectTriangulation != null && { projectTriangulation: projectTriangulationToDoc(project.projectTriangulation) }),
    ...(project.projectEyes != null && { projectEyes: project.projectEyes }),
    ...(project.projectMouth != null && { projectMouth: project.projectMouth }),
    published: project.published === true,
    publishedAt: project.publishedAt ?? null,
    bookId: project.bookId ?? null,
    bookOrder: project.bookOrder ?? 0,
    hasThumbnail: project.thumbnailBlob != null,
  }
}

type MeshWithoutLargeJSON = Omit<import('../types/project').MeshData,
  'contourOriginKeyframes' | 'contourOriginFrames' |
  'contourAnchorKeyframes' | 'contourAnchorFrames' | 'contourSubdivisionFrames' |
  'contourCannyFrames' |
  'anchorKeyframes' | 'anchorFrames' | 'boneWeights' | 'videoFramesMesh' |
  'walkZoneFrames' | 'walkBodyFrames' | 'walkHiddenFaceFrames' |
  'walkBodyFramesSmoothed' | 'walkZoneFramesSmoothed' |
  'sam2MasksRLE' |
  'sam2Contours' | 'sam2ContourOriginFrames' | 'sam2ContourAnchorFrames' | 'sam2ContourSubdivisionFrames' |
  'sam2SmoothedAnchorFrames' | 'sam2SmoothedSubdivisionFrames' | 'sam2SmoothedContourOriginFrames' |
  'cotrackerFrames' | 'cotrackerFramesRaw' | 'cotrackerVisibility'>

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
    sam2Skeleton: d.sam2Skeleton ? migrateSam2Skeleton(d.sam2Skeleton) : d.sam2Skeleton,
    sam2BonesValidated: d.sam2BonesValidated,
    sam2BodyBonesValidated: d.sam2BodyBonesValidated,
    // Étape 10 "Lissage Bones" / V2 "Lissage Anchor"
    sam2SmoothingCutoffHz: d.sam2SmoothingCutoffHz,
    sam2SmoothingValidated: d.sam2SmoothingValidated,
    // V2 "Lissage Maillage Corps"
    walkBodyFramesSmoothingCutoffHz: d.walkBodyFramesSmoothingCutoffHz,
    walkBodyFramesSmoothingValidated: d.walkBodyFramesSmoothingValidated,
    // V2 "Lissage Maillage Pattes"
    walkZoneFramesSmoothingCutoffHz: d.walkZoneFramesSmoothingCutoffHz,
    walkZoneFramesSmoothingValidated: d.walkZoneFramesSmoothingValidated,
    // V3 "Calcul Corps"
    v3BodyTriangles: d.v3BodyTriangles ? docToTri(d.v3BodyTriangles) : undefined,
    v3BodyTriangulationValidated: d.v3BodyTriangulationValidated,
    // CoTracker + Bones
    cotrackerPoints: d.cotrackerPoints,
    cotrackerVideoWidth: d.cotrackerVideoWidth,
    cotrackerVideoHeight: d.cotrackerVideoHeight,
    cotrackerTrackingValidated: d.cotrackerTrackingValidated,
    cotrackerVisibilityThreshold: d.cotrackerVisibilityThreshold,
    cotrackerSkeleton: d.cotrackerSkeleton,
    cotrackerBonesValidated: d.cotrackerBonesValidated,
    cotrackerBoneSmoothingCutoffHz: d.cotrackerBoneSmoothingCutoffHz,
    cotrackerBoneSmoothingValidated: d.cotrackerBoneSmoothingValidated,
    cotrackerLBSParams: d.cotrackerLBSParams,
    cotrackerLBSValidated: d.cotrackerLBSValidated,
    cotrackerJawOpennessFrames: (() => {
      const v = d.cotrackerJawOpennessFrames
      console.log('[Firebase load] cotrackerJawOpennessFrames raw:', v == null ? v : `array(${v.length})`, 'cotrackerLBSValidated:', d.cotrackerLBSValidated, 'cotrackerSkeleton.jaw:', (d as any).cotrackerSkeleton?.jaw ? 'yes' : 'no')
      return v ?? null
    })(),
    cotrackerEyePupilFrames: d.cotrackerEyePupilFrames ?? null,
    // Marche
    marcheParentAnimationId: d.marcheParentAnimationId,
    marcheSkeleton: d.marcheSkeleton,
    marcheBodyJointRestPositions: d.marcheBodyJointRestPositions,
    marcheLegRestPositions: d.marcheLegRestPositions,
    marcheInheritValidated: d.marcheInheritValidated,
    marcheGaitLegIds: d.marcheGaitLegIds,
    marcheGaitLegsValidated: d.marcheGaitLegsValidated,
    marcheLegPhases: d.marcheLegPhases,
    // Bruits de pas
    footstepFrames: d.footstepFrames,
    footstepVolume: d.footstepVolume,
    footstepOffsetMs: d.footstepOffsetMs,
    footstepValidated: d.footstepValidated,
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
  sam2SmoothedSubdivisionFrames: Record<string, Point2D[][]> | null
  sam2SmoothedContourOriginFrames: Record<string, Point2D[]> | null
  walkBodyFramesSmoothed: Point2D[][] | null
  walkZoneFramesSmoothed: Record<string, Point2D[][]> | null
  cotrackerFrames: Record<string, Point2D[]> | null
  cotrackerFramesRaw: Record<string, Point2D[]> | null
  cotrackerVisibility: Record<string, number[]> | null
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
    meshDoc.hasSam2SmoothedSubdivisionFrames ? downloadJSON<Record<string, Point2D[][]>>(path('sam2SmoothedSubdivisionFrames.json')) : null,
    meshDoc.hasSam2SmoothedContourOriginFrames ? downloadJSON<Record<string, Point2D[]>>(path('sam2SmoothedContourOriginFrames.json')) : null,
    meshDoc.hasWalkBodyFramesSmoothed ? downloadJSON<Point2D[][]>(path('walkBodyFramesSmoothed.json')) : null,
    meshDoc.hasWalkZoneFramesSmoothed ? downloadJSON<Record<string, Point2D[][]>>(path('walkZoneFramesSmoothed.json')) : null,
    meshDoc.hasCotrackerFrames ? downloadJSON<Record<string, Point2D[]>>(path('cotrackerFrames.json')) : null,
    meshDoc.hasCotrackerFramesRaw ? downloadJSON<Record<string, Point2D[]>>(path('cotrackerFramesRaw.json')) : null,
    meshDoc.hasCotrackerVisibility ? downloadJSON<Record<string, number[]>>(path('cotrackerVisibility.json')) : null,
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
    sam2SmoothedSubdivisionFrames: downloads[18] as Record<string, Point2D[][]> | null,
    sam2SmoothedContourOriginFrames: downloads[19] as Record<string, Point2D[]> | null,
    walkBodyFramesSmoothed: downloads[20] as Point2D[][] | null,
    walkZoneFramesSmoothed: downloads[21] as Record<string, Point2D[][]> | null,
    cotrackerFrames: downloads[22] as Record<string, Point2D[]> | null,
    cotrackerFramesRaw: downloads[23] as Record<string, Point2D[]> | null,
    cotrackerVisibility: downloads[24] as Record<string, number[]> | null,
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

  const [imageBlob, backgroundVideoBlob, ambientSoundBlob, thumbnailBlob] = await Promise.all([
    projDoc.hasImage ? downloadBlob(`projects/${id}/originalImage`) : Promise.resolve(null),
    projDoc.hasBackgroundVideo ? downloadBlob(`projects/${id}/backgroundVideo`) : Promise.resolve(null),
    (projDoc as ProjectDoc).hasAmbientSound ? downloadBlob(`projects/${id}/ambientSound`) : Promise.resolve(null),
    projDoc.hasThumbnail ? downloadBlob(`projects/${id}/thumbnail`) : Promise.resolve(null),
  ])

  // Download scene background + foreground blobs.
  // Fallback de migration legacy : si le nouveau chemin `sceneBackground` est vide alors
  // que le doc annonce du contenu, on retombe sur les anciens `sceneBackgroundLayer0/1/2`.
  let sceneBackgroundBlob: Blob | null = null
  let sceneForegroundBlob: Blob | null = null
  if (projDoc.scene) {
    // Robustesse : on télécharge dès que les métadonnées du calque existent, sans se fier
    // au flag hasImage/hasVideo du doc (qui peut être périmé → fond noir au reload).
    if (projDoc.scene.background || projDoc.scene.backgroundLayers || projDoc.scene.hasBackgroundImage) {
      sceneBackgroundBlob = await downloadBlob(`projects/${id}/sceneBackground`).catch(() => null)
      if (!sceneBackgroundBlob) {
        // Fallback chemins legacy (projet migré sans re-upload du blob)
        for (let i = 0; i < 3 && !sceneBackgroundBlob; i++) {
          sceneBackgroundBlob = await downloadBlob(`projects/${id}/sceneBackgroundLayer${i}`).catch(() => null)
        }
      }
    }
    if (projDoc.scene.foreground) {
      sceneForegroundBlob = await downloadBlob(`projects/${id}/sceneForeground`).catch(() => null)
    }
  }

  // Load all animations in parallel
  const animations = await Promise.all(
    projDoc.animations.map(async (animDoc): Promise<Animation> => {
      const [videoBlob, audioBlob, footstepSound1Blob, footstepSound2Blob] = await Promise.all([
        animDoc.hasVideo ? downloadBlob(animStoragePath(id, animDoc.id, 'video')) : Promise.resolve(null),
        animDoc.hasAudio ? downloadBlob(animStoragePath(id, animDoc.id, 'audio')) : Promise.resolve(null),
        animDoc.hasFootstep1 ? downloadBlob(animStoragePath(id, animDoc.id, 'footstep1')) : Promise.resolve(null),
        animDoc.hasFootstep2 ? downloadBlob(animStoragePath(id, animDoc.id, 'footstep2')) : Promise.resolve(null),
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
        // Migration : projets legacy n'ont pas de playbackMode → 'oneshot' par défaut
        // (l'utilisateur recoche manuellement en 'loop' depuis l'éditeur d'animation).
        playbackMode: animDoc.playbackMode ?? 'oneshot',
        createdAt: animDoc.createdAt,
        videoBlob,
        mesh,
        physicsCode: animDoc.physicsCode ?? null,
        physicsDuration: animDoc.physicsDuration ?? null,
        physicsOverlay: animDoc.physicsOverlay ?? false,
        audioBlob,
        audioEnabled: animDoc.audioEnabled ?? false,
        footstepSound1Blob,
        footstepSound2Blob,
      }
    })
  )

  // Reconstruct scene if present
  let sceneSoundBlobs: Map<string, Blob | null> = new Map()
  if (projDoc.scene) {
    const ids = new Set<string>()
    if (projDoc.scene.entrySound) ids.add(projDoc.scene.entrySound.id)
    if (projDoc.scene.ambientSound) ids.add(projDoc.scene.ambientSound.id)
    const rpDoc = projDoc.scene.restPoint ?? projDoc.scene.restPoints?.[0]
    if (rpDoc) {
      for (const a of [...(rpDoc.actions ?? []), ...(rpDoc.speeches ?? []), ...(rpDoc.presentation ? [rpDoc.presentation] : [])]) {
        if (a.sound) ids.add(a.sound.id)
        for (const s of a.steps ?? []) if (s.sound) ids.add(s.sound.id)
      }
      for (const arr of rpDoc.randomAnimationSounds ?? []) for (const s of arr) ids.add(s.id)
    }
    for (const meta of collectFilmDocSoundMetas(projDoc.scene.film)) ids.add(meta.id)
    const idList = [...ids]
    const blobs = await Promise.all(
      idList.map(sid => downloadBlob(`projects/${id}/scene/sounds/${sid}`))
    )
    sceneSoundBlobs = new Map(idList.map((sid, i) => [sid, blobs[i]]))
  }

  const hydrateSounds = (metas: SceneSoundMetaDoc[] | undefined): import('../types/project').SceneSound[] =>
    (metas ?? []).map(m => ({ id: m.id, name: m.name, volume: m.volume, blob: sceneSoundBlobs.get(m.id) ?? null }))

  const docToAction = (a: SceneActionDoc): import('../types/project').SceneAction => {
    // Migration intra-action : ancien format `animationIds: string[]` → `steps`.
    const steps = a.steps
      ? a.steps.map(s => ({
          animationId: s.animationId,
          ...(s.sound != null && { sound: { id: s.sound.id, name: s.sound.name, volume: s.sound.volume, loop: s.sound.loop, rate: s.sound.rate, blob: sceneSoundBlobs.get(s.sound.id) ?? null } }),
          ...(s.isSpoken && { isSpoken: true }),
          ...(s.animSpeedMul != null && { animSpeedMul: s.animSpeedMul }),
      ...(s.loop && { loop: true }),
        }))
      : (a.animationIds ?? []).map((animId: string) => ({ animationId: animId }))
    return {
      id: a.id,
      name: a.name,
      steps,
      ...(a.sound != null && { sound: { id: a.sound.id, name: a.sound.name, volume: a.sound.volume, loop: a.sound.loop, rate: a.sound.rate, blob: sceneSoundBlobs.get(a.sound.id) ?? null } }),
      ...(a.isSpoken && { isSpoken: true }),
    }
  }

  const docToFilmTravel = (t: FilmTravelDoc | undefined): import('../types/project').FilmTravel => ({
    ...(t?.animationId != null && { animationId: t.animationId }),
    ...(t?.speedPxPerSec != null && { speedPxPerSec: t.speedPxPerSec }),
    ...(t?.animSpeedMul != null && { animSpeedMul: t.animSpeedMul }),
    ...(t?.sound != null && { sound: { id: t.sound.id, name: t.sound.name, volume: t.sound.volume, loop: t.sound.loop, rate: t.sound.rate, blob: sceneSoundBlobs.get(t.sound.id) ?? null } }),
    ...(t?.origin != null && { origin: t.origin }),
    ...(t?.controlPoints != null && t.controlPoints.length > 0 && { controlPoints: t.controlPoints.map(cp => ({ x: cp.x, y: cp.y })) }),
    ...(t?.easing != null && { easing: t.easing }),
  })

  const docToFilmDeparture = (d: FilmDepartureDoc): import('../types/project').FilmDeparture => ({
    target: d.target,
    travel: docToFilmTravel(d.travel),
  })

  const docToFilmPoint = (p: FilmPointDoc): import('../types/project').FilmPoint => ({
    id: p.id,
    x: p.x,
    y: p.y,
    scale: p.scale ?? 1,
    travel: docToFilmTravel(p.travel),
    ...(p.action != null && { action: docToAction(p.action) }),
    ...(p.pauseMs != null && p.pauseMs > 0 && { pauseMs: p.pauseMs }),
    ...(p.facing != null && { facing: p.facing }),
    ...(p.departure != null && { departure: docToFilmDeparture(p.departure) }),
  })

  const docToFilmEnding = (e: FilmEndingDoc | undefined): import('../types/project').FilmEnding =>
    e?.kind === 'exit'
      ? { kind: 'exit', side: e.side, travel: docToFilmTravel(e.travel) }
      : { kind: 'stay' }

  // Blobs des décors de plan téléchargés séparément (hydrateFilmPlanDecorBlobs).
  const docToFilmPlan = (pl: FilmPlanDoc): import('../types/project').SceneFilmPlan => ({
    id: pl.id,
    ...(pl.name != null && { name: pl.name }),
    background: pl.background
      ? { imageBlob: null, videoBlob: null, width: pl.background.width, height: pl.background.height }
      : null,
    foreground: pl.foreground
      ? {
          imageBlob: null,
          videoBlob: null,
          width: pl.foreground.width,
          height: pl.foreground.height,
          chromaKeyColor: pl.foreground.chromaKeyColor ?? null,
          chromaKeyThreshold: pl.foreground.chromaKeyThreshold,
          chromaKeySmoothness: pl.foreground.chromaKeySmoothness,
        }
      : null,
    cameraX: pl.cameraX ?? 0,
    entrySide: pl.entrySide ?? 'left',
    points: (pl.points ?? []).map(docToFilmPoint),
    ending: docToFilmEnding(pl.ending),
    ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
    ...(pl.moveAnimationId != null && { moveAnimationId: pl.moveAnimationId }),
    ...(pl.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: pl.moveSpeedPxPerSec }),
    ...(pl.idleSpeedMul != null && { idleSpeedMul: pl.idleSpeedMul }),
  })

  // Garde de compat : les docs film v1 (format `steps`) sont ignorés (jamais en prod).
  // Migration : format à plat (pré-plans) → plans[0] avec décor de la scène.
  const docToFilm = (filmDoc: SceneFilmDoc): import('../types/project').SceneFilm | undefined => {
    let plans: import('../types/project').SceneFilmPlan[]
    if (Array.isArray(filmDoc.plans) && filmDoc.plans.length > 0) {
      plans = filmDoc.plans.map(docToFilmPlan)
    } else if (Array.isArray(filmDoc.points)) {
      plans = [{
        id: crypto.randomUUID(),
        background: null,
        foreground: null,
        cameraX: filmDoc.cameraX ?? 0,
        entrySide: filmDoc.entrySide ?? 'left',
        points: filmDoc.points.map(docToFilmPoint),
        ending: docToFilmEnding(filmDoc.ending),
      }]
    } else {
      return undefined
    }
    return {
      enabled: filmDoc.enabled,
      plans,
      ...(filmDoc.moveAnimationId != null && { moveAnimationId: filmDoc.moveAnimationId }),
      moveSpeedPxPerSec: filmDoc.moveSpeedPxPerSec ?? 260,
      ...(filmDoc.idleSpeedMul != null && { idleSpeedMul: filmDoc.idleSpeedMul }),
      endBehavior: filmDoc.endBehavior ?? 'menu',
    }
  }

  /**
   * Migre un rest point legacy : si `actions` est absent et `randomAnimationIds` présent,
   * créer une action 1-étape par animation, avec le 1ᵉʳ son legacy comme son d'action.
   */
  const docToRestPoint = (rp: SceneRestPointDoc): import('../types/project').SceneRestPoint => {
    let actions = rp.actions?.map(docToAction)
    if (!actions || actions.length === 0) {
      const legacyIds = rp.randomAnimationIds ?? rp.availableAnimationIds ?? []
      if (legacyIds.length > 0) {
        actions = legacyIds.map((animId, i) => {
          const legacySound = rp.randomAnimationSounds?.[i]?.[0]
          return {
            id: crypto.randomUUID(),
            name: `Action ${i + 1}`,
            steps: [{ animationId: animId }],
            ...(legacySound && {
              sound: { id: legacySound.id, name: legacySound.name, volume: legacySound.volume, blob: sceneSoundBlobs.get(legacySound.id) ?? null },
            }),
          }
        })
      }
    }
    let speeches = rp.speeches?.map(docToAction)
    // Migration 3-boutons → 1 ACTION + Discours : si pas de `speeches`, le reste des actions devient les discours.
    if (speeches == null && actions && actions.length > 1) {
      speeches = actions.slice(1)
      actions = actions.slice(0, 1)
    }
    return {
      id: rp.id,
      backgroundX: rp.backgroundX,
      ...(rp.restAnimationId != null && { restAnimationId: rp.restAnimationId }),
      ...(actions && actions.length > 0 && { actions }),
      ...(speeches && speeches.length > 0 && { speeches }),
      ...(rp.presentation != null && { presentation: docToAction(rp.presentation) }),
      ...(rp.zoneAnimationMappings != null && { zoneAnimationMappings: rp.zoneAnimationMappings }),
      ...(rp.speakSoundIds != null && { speakSoundIds: rp.speakSoundIds }),
      ...(rp.helpTexts != null && { helpTexts: rp.helpTexts }),
    }
  }

  let scene: Scene | null = null
  if (projDoc.scene) {
    const speakSounds = projDoc.scene.speakSounds ?? []
    const speakSoundBlobs = await Promise.all(
      speakSounds.map(s => downloadBlob(`projects/${id}/scene/speakSounds/${s.id}`))
    )
    let background: SceneBackground | null = null
    if (projDoc.scene.background) {
      const bgIsVideo = sceneBackgroundBlob
        ? (sceneBackgroundBlob.type.startsWith('video/') || projDoc.scene.background.hasVideo === true)
        : projDoc.scene.background.hasVideo === true
      background = {
        imageBlob: bgIsVideo ? null : sceneBackgroundBlob,
        videoBlob: bgIsVideo ? sceneBackgroundBlob : null,
        width: projDoc.scene.background.width,
        height: projDoc.scene.background.height,
      }
    } else if (projDoc.scene.backgroundLayers) {
      // Legacy migration : promouvoir le premier layer avec media en arrière-plan unique.
      const legacy = projDoc.scene.backgroundLayers.find(l => l.hasImage || l.hasVideo)
      if (legacy) {
        background = {
          imageBlob: legacy.hasVideo ? null : sceneBackgroundBlob,
          videoBlob: legacy.hasVideo ? sceneBackgroundBlob : null,
          width: legacy.width,
          height: legacy.height,
        }
      }
    } else if (projDoc.scene.hasBackgroundImage) {
      background = {
        imageBlob: sceneBackgroundBlob,
        videoBlob: null,
        width: projDoc.scene.backgroundWidth ?? 0,
        height: projDoc.scene.backgroundHeight ?? 0,
      }
    }
    const fgDoc = projDoc.scene.foreground
    const fgIsVideo = sceneForegroundBlob
      ? (sceneForegroundBlob.type.startsWith('video/') || fgDoc?.hasVideo === true)
      : fgDoc?.hasVideo === true
    const foreground: SceneForeground | null = fgDoc
      ? {
          imageBlob: fgIsVideo ? null : sceneForegroundBlob,
          videoBlob: fgIsVideo ? sceneForegroundBlob : null,
          width: fgDoc.width,
          height: fgDoc.height,
          chromaKeyColor: fgDoc.chromaKeyColor ?? null,
          chromaKeyThreshold: fgDoc.chromaKeyThreshold,
          chromaKeySmoothness: fgDoc.chromaKeySmoothness,
        }
      : null

    // Migration : restPoint = nouveau champ, sinon restPoints[0] (legacy multi-rest).
    const rpDoc = projDoc.scene.restPoint ?? projDoc.scene.restPoints?.[0]
    const restPoint = rpDoc
      ? docToRestPoint(rpDoc)
      : { id: crypto.randomUUID(), backgroundX: 0 }

    let filmV2 = projDoc.scene.film ? docToFilm(projDoc.scene.film) : undefined
    if (filmV2 && projDoc.scene.film) {
      filmV2 = await hydrateFilmPlanDecorBlobs(id, filmV2, projDoc.scene.film)
    }

    // Migration entry/entryStartX depuis l'ancien startMode
    let entry: 'fixed' | 'moving' = projDoc.scene.entry ?? 'fixed'
    let entryStartX = projDoc.scene.entryStartX
    if (projDoc.scene.entry == null) {
      if (projDoc.scene.startMode === 'transition' && projDoc.scene.startX != null) {
        entry = 'moving'
        entryStartX = projDoc.scene.startX
      }
    }

    scene = {
      id: projDoc.scene.id,
      name: projDoc.scene.name,
      background,
      foreground,
      characterScale: projDoc.scene.characterScale,
      characterY: projDoc.scene.characterY,
      restPoint,
      entry,
      ...(entryStartX != null && { entryStartX }),
      ...(projDoc.scene.entryDurationMs != null && { entryDurationMs: projDoc.scene.entryDurationMs }),
      ...(projDoc.scene.entryAnimationId != null && { entryAnimationId: projDoc.scene.entryAnimationId }),
      ...(projDoc.scene.entrySound != null && { entrySound: { id: projDoc.scene.entrySound.id, name: projDoc.scene.entrySound.name, volume: projDoc.scene.entrySound.volume, blob: sceneSoundBlobs.get(projDoc.scene.entrySound.id) ?? null } }),
      ...(projDoc.scene.ambientSound != null && { ambientSound: { id: projDoc.scene.ambientSound.id, name: projDoc.scene.ambientSound.name, volume: projDoc.scene.ambientSound.volume, blob: sceneSoundBlobs.get(projDoc.scene.ambientSound.id) ?? null } }),
      ...(projDoc.scene.walkTrapezoid != null && { walkTrapezoid: projDoc.scene.walkTrapezoid }),
      ...(filmV2 != null && { film: filmV2 }),
      ...(projDoc.scene.characterFacing != null && { characterFacing: projDoc.scene.characterFacing }),
      ...(projDoc.scene.characterOriginU != null && { characterOriginU: projDoc.scene.characterOriginU }),
      ...(projDoc.scene.characterOriginV != null && { characterOriginV: projDoc.scene.characterOriginV }),
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

  // FILM niveau projet : doc.film prioritaire ; sinon conversion legacy scene.film
  // (les blobs de la scène déjà hydratés sont réutilisés, upload complet à la
  // prochaine sauvegarde du film → filmNeedsFullUpload).
  let filmV3: import('../types/project').Film | null = null
  let filmNeedsFullUpload = false
  let filmT: import('../types/project').FilmT | null = null
  if (projDoc.filmT) {
    // FILM TIMELINE (v4) — prioritaire.
    const soundIds = collectFilmTDocSoundIds(projDoc.filmT)
    const soundBlobs = await Promise.all(
      soundIds.map(sid => downloadBlob(`projects/${id}/film/sounds/${sid}`).catch(() => null))
    )
    const soundMap = new Map(soundIds.map((sid, i) => [sid, soundBlobs[i]]))
    filmT = docToFilmT(projDoc.filmT, sid => soundMap.get(sid) ?? null)
    filmT = await hydrateFilmTDecorBlobs(id, filmT)
  } else if (projDoc.film) {
    const filmSoundIds = collectFilmV3DocSoundIds(projDoc.film)
    const filmSoundBlobs = await Promise.all(
      filmSoundIds.map(sid => downloadBlob(`projects/${id}/film/sounds/${sid}`).catch(() => null))
    )
    const filmSoundMap = new Map(filmSoundIds.map((sid, i) => [sid, filmSoundBlobs[i]]))
    filmV3 = docToFilmV3(projDoc.film, sid => filmSoundMap.get(sid) ?? null)
    filmV3 = await hydrateFilmV3DecorBlobs(id, filmV3)
  } else if (scene) {
    filmV3 = convertLegacySceneFilm(scene)
    if (filmV3) filmNeedsFullUpload = true
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
    film: filmV3,
    filmT,
    ...(filmNeedsFullUpload && { filmNeedsFullUpload: true }),
    scene,
    projectTriangulation,
    projectEyes: projDoc.projectEyes ?? null,
    projectMouth: projDoc.projectMouth ?? null,
    published: projDoc.published === true,
    publishedAt: projDoc.publishedAt ?? null,
    bookId: projDoc.bookId ?? null,
    bookOrder: projDoc.bookOrder ?? projDoc.createdAt ?? 0,
    thumbnailBlob: thumbnailBlob,
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
    playbackMode: 'oneshot',
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
    film: null,
    scene: null,
    projectTriangulation: null,
    projectEyes: null,
    projectMouth: null,
    published: false,
    publishedAt: null,
    bookId: null,
    bookOrder: data.createdAt,
    thumbnailBlob: null,
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
    sam2SmoothedSubdivisionFrames: null,
    sam2SmoothedContourOriginFrames: null,
    walkBodyFramesSmoothed: null,
    walkZoneFramesSmoothed: null,
  }
}

export async function getProjectThumbnail(projectId: string): Promise<Blob | null> {
  return downloadBlob(`projects/${projectId}/originalImage`)
}

export async function createProject(name: string): Promise<Project> {
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
    originalImageBlob: null,
    backgroundVideoBlob: null,
    ambientSoundBlob: null,
    ambientSoundEnabled: false,
    animations: [],
    bodyZones: [],
    markers: null,
    film: null,
    scene: null,
    projectTriangulation: null,
    projectEyes: null,
    projectMouth: null,
    published: false,
    publishedAt: null,
    bookId: null,
    bookOrder: Date.now(),
    thumbnailBlob: null,
  }
  await setDoc(projectRef(project.id), toDoc(project))
  console.log('[Firebase] Project created:', project.id)
  await logAudit('project.create', project.id, { name })
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
        playbackMode: 'oneshot',
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
        film: null,
        scene: null,
        projectTriangulation: null,
        projectEyes: null,
        projectMouth: null,
        published: false,
        publishedAt: null,
        bookId: null,
        bookOrder: legacy.createdAt,
        thumbnailBlob: null,
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
      film: null,
      hasFilm: computeDocHasFilm(projDoc),
      scene: null,
      projectTriangulation: null,
      projectEyes: projDoc.projectEyes ?? null,
      projectMouth: projDoc.projectMouth ?? null,
      published: projDoc.published === true,
      publishedAt: projDoc.publishedAt ?? null,
      bookId: projDoc.bookId ?? null,
      bookOrder: projDoc.bookOrder ?? projDoc.createdAt ?? 0,
      thumbnailBlob: null,
    }
  })
}

export type AnimationUploadField =
  | 'video' | 'audio' | 'footstep1' | 'footstep2'
  | 'contourOriginKeyframes' | 'contourOriginFrames'
  | 'contourAnchorKeyframes' | 'contourAnchorFrames'
  | 'contourSubdivisionFrames' | 'contourCannyFrames'
  | 'anchorKeyframes' | 'anchorFrames'
  | 'boneWeights'
  | 'videoFramesMesh'
  | 'walkZoneFrames' | 'walkBodyFrames'
  | 'walkBodyFramesSmoothed' | 'walkZoneFramesSmoothed'
  | 'sam2MasksRLE'
  | 'sam2Contours' | 'sam2ContourOriginFrames' | 'sam2ContourAnchorFrames' | 'sam2ContourSubdivisionFrames'
  | 'sam2SmoothedAnchorFrames' | 'sam2SmoothedSubdivisionFrames' | 'sam2SmoothedContourOriginFrames'
  | 'cotrackerFrames' | 'cotrackerFramesRaw' | 'cotrackerVisibility'

export type UploadHint =
  | 'image' | 'backgroundVideo' | 'ambientSound' | 'thumbnail'
  | 'sceneBackground' | 'sceneForeground'
  | 'triangulationReferenceImage' | 'triangulationMasks' | 'triangulationContours'
  | { animationId: string; field: AnimationUploadField }
  | { speakSoundId: string }
  | { deleteSpeakSoundId: string }
  | { sceneSoundId: string }
  | { deleteSceneSoundId: string }
  | { filmPlanBackground: string }        // valeur = planId (LEGACY scene.film)
  | { filmPlanForeground: string }
  | { deleteFilmPlanBackground: string }
  | { deleteFilmPlanForeground: string }
  // FILM niveau projet : film/plans/{planId}/backdrop|overlay + film/sounds/{soundId}
  | { filmPlanBackdrop: string }          // valeur = planId
  | { filmPlanOverlay: string }
  | { deleteFilmPlanBackdrop: string }
  | { deleteFilmPlanOverlay: string }
  | { filmSoundId: string }
  | { deleteFilmSoundId: string }

/** Flat upload hint used by step components (legacy-compatible strings) */
export type StepUploadHint = 'image' | 'backgroundVideo' | 'ambientSound' | 'thumbnail' | AnimationUploadField

export async function updateProject(
  project: Project,
  uploadOnly?: UploadHint[],
  opts?: {
    /** Écrit le doc Firestore APRÈS la réussite de tous les uploads Storage.
     *  Utilisé par la duplication : le projet n'apparaît que quand la copie est
     *  COMPLÈTE — une interruption/erreur ne laisse pas de projet à moitié copié
     *  (doc annonçant des fichiers absents → 404 / scène vide). */
    docAfterUploads?: boolean
  },
): Promise<void> {
  const id = project.id

  const saveDoc = async () => {
    console.log('[Firebase] Saving project metadata:', id)
    await setDoc(projectRef(id), toDoc(project))
  }

  // Comportement normal (sauvegarde d'édition) : doc d'abord, puis blobs.
  if (!opts?.docAfterUploads) await saveDoc()

  // Then upload blobs to Storage (only what's specified)
  const uploads: Promise<void>[] = []

  if (!uploadOnly) {
    if (opts?.docAfterUploads) await saveDoc()
    return
  }

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
    } else if (hint === 'thumbnail' && project.thumbnailBlob) {
      console.log('[Storage] Uploading thumbnail for:', id)
      uploads.push(
        uploadBlob(`projects/${id}/thumbnail`, project.thumbnailBlob)
          .then(() => console.log('[Storage] Thumbnail uploaded'))
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
    } else if (hint === 'sceneBackground' && project.scene?.background) {
      const blob = project.scene.background.videoBlob ?? project.scene.background.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading scene background for:`, id)
        uploads.push(
          uploadBlob(`projects/${id}/sceneBackground`, blob)
            .then(() => console.log(`[Storage] Scene background uploaded`))
        )
      }
    } else if (hint === 'sceneForeground' && project.scene?.foreground) {
      const blob = project.scene.foreground.videoBlob ?? project.scene.foreground.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading scene foreground for:`, id)
        uploads.push(
          uploadBlob(`projects/${id}/sceneForeground`, blob)
            .then(() => console.log(`[Storage] Scene foreground uploaded`))
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
    } else if (typeof hint === 'object' && 'sceneSoundId' in hint) {
      const soundId = hint.sceneSoundId
      const blob = findSceneSoundBlob(project, soundId)
      if (blob) {
        console.log(`[Storage] Uploading scene sound ${soundId}`)
        uploads.push(
          uploadBlob(`projects/${id}/scene/sounds/${soundId}`, blob)
            .then(() => console.log(`[Storage] Scene sound ${soundId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'deleteSceneSoundId' in hint) {
      const soundId = hint.deleteSceneSoundId
      console.log(`[Storage] Deleting scene sound ${soundId}`)
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/scene/sounds/${soundId}`)).catch(() => {})
      )
    } else if (typeof hint === 'object' && 'filmPlanBackground' in hint) {
      const planId = hint.filmPlanBackground
      const plan = project.scene?.film?.plans.find(pl => pl.id === planId)
      const blob = plan?.background?.videoBlob ?? plan?.background?.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading film plan background ${planId}`)
        uploads.push(
          uploadBlob(`projects/${id}/filmPlans/${planId}/background`, blob)
            .then(() => console.log(`[Storage] Film plan background ${planId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'filmPlanForeground' in hint) {
      const planId = hint.filmPlanForeground
      const plan = project.scene?.film?.plans.find(pl => pl.id === planId)
      const blob = plan?.foreground?.videoBlob ?? plan?.foreground?.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading film plan foreground ${planId}`)
        uploads.push(
          uploadBlob(`projects/${id}/filmPlans/${planId}/foreground`, blob)
            .then(() => console.log(`[Storage] Film plan foreground ${planId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'deleteFilmPlanBackground' in hint) {
      const planId = hint.deleteFilmPlanBackground
      console.log(`[Storage] Deleting film plan background ${planId}`)
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/filmPlans/${planId}/background`)).catch(() => {})
      )
    } else if (typeof hint === 'object' && 'deleteFilmPlanForeground' in hint) {
      const planId = hint.deleteFilmPlanForeground
      console.log(`[Storage] Deleting film plan foreground ${planId}`)
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/filmPlans/${planId}/foreground`)).catch(() => {})
      )
    } else if (typeof hint === 'object' && 'filmPlanBackdrop' in hint) {
      const planId = hint.filmPlanBackdrop
      const plan = project.filmT?.plans.find(pl => pl.id === planId) ?? project.film?.plans.find(pl => pl.id === planId)
      const blob = plan?.backdrop?.videoBlob ?? plan?.backdrop?.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading film plan backdrop ${planId}`)
        uploads.push(
          uploadBlob(`projects/${id}/film/plans/${planId}/backdrop`, blob)
            .then(() => console.log(`[Storage] Film plan backdrop ${planId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'filmPlanOverlay' in hint) {
      const planId = hint.filmPlanOverlay
      const plan = project.filmT?.plans.find(pl => pl.id === planId) ?? project.film?.plans.find(pl => pl.id === planId)
      const blob = plan?.overlay?.videoBlob ?? plan?.overlay?.imageBlob
      if (blob) {
        console.log(`[Storage] Uploading film plan overlay ${planId}`)
        uploads.push(
          uploadBlob(`projects/${id}/film/plans/${planId}/overlay`, blob)
            .then(() => console.log(`[Storage] Film plan overlay ${planId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'deleteFilmPlanBackdrop' in hint) {
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/film/plans/${hint.deleteFilmPlanBackdrop}/backdrop`)).catch(() => {})
      )
    } else if (typeof hint === 'object' && 'deleteFilmPlanOverlay' in hint) {
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/film/plans/${hint.deleteFilmPlanOverlay}/overlay`)).catch(() => {})
      )
    } else if (typeof hint === 'object' && 'filmSoundId' in hint) {
      const soundId = hint.filmSoundId
      let blob: Blob | null = null
      for (const s of iterateFilmTSounds(project.filmT)) {
        if (s.id === soundId && s.blob) { blob = s.blob; break }
      }
      if (!blob) {
        for (const s of iterateFilmV3Sounds(project.film)) {
          if (s.id === soundId && s.blob) { blob = s.blob; break }
        }
      }
      if (blob) {
        console.log(`[Storage] Uploading film sound ${soundId}`)
        uploads.push(
          uploadBlob(`projects/${id}/film/sounds/${soundId}`, blob)
            .then(() => console.log(`[Storage] Film sound ${soundId} uploaded`))
        )
      }
    } else if (typeof hint === 'object' && 'deleteFilmSoundId' in hint) {
      uploads.push(
        deleteObject(ref(storage, `projects/${id}/film/sounds/${hint.deleteFilmSoundId}`)).catch(() => {})
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
      // Champs BLOBS (pas de suffixe .json) : vidéo, audio, sons de pas.
      const BLOB_FIELDS = ['video', 'audio', 'footstep1', 'footstep2'] as const
      const isBlobField = (BLOB_FIELDS as readonly string[]).includes(field)
      const storagePath = animStoragePath(
        id,
        animationId,
        isBlobField ? field : (fileNameForField[field] ?? `${field}.json`)
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
      } else if (field === 'footstep1' && anim.footstepSound1Blob) {
        console.log(`[Storage] Uploading footstep1 for animation ${animationId}`)
        uploads.push(
          uploadBlob(storagePath, anim.footstepSound1Blob)
            .then(() => console.log(`[Storage] Footstep1 uploaded for animation ${animationId}`))
        )
      } else if (field === 'footstep2' && anim.footstepSound2Blob) {
        console.log(`[Storage] Uploading footstep2 for animation ${animationId}`)
        uploads.push(
          uploadBlob(storagePath, anim.footstepSound2Blob)
            .then(() => console.log(`[Storage] Footstep2 uploaded for animation ${animationId}`))
        )
      } else if (!isBlobField && anim.mesh) {
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
          sam2SmoothedSubdivisionFrames: anim.mesh.sam2SmoothedSubdivisionFrames,
          sam2SmoothedContourOriginFrames: anim.mesh.sam2SmoothedContourOriginFrames,
          walkBodyFramesSmoothed: anim.mesh.walkBodyFramesSmoothed,
          walkZoneFramesSmoothed: anim.mesh.walkZoneFramesSmoothed,
          cotrackerFrames: anim.mesh.cotrackerFrames,
          cotrackerFramesRaw: anim.mesh.cotrackerFramesRaw,
          cotrackerVisibility: anim.mesh.cotrackerVisibility,
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
  if (opts?.docAfterUploads) await saveDoc()
}

const ANIM_JSON_FILES = [
  'video',
  'audio',
  'footstep1',
  'footstep2',
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
  'sam2SmoothedSubdivisionFrames.json',
  'sam2SmoothedContourOriginFrames.json',
  'walkBodyFramesSmoothed.json',
  'walkZoneFramesSmoothed.json',
  'cotrackerFrames.json',
  'cotrackerFramesRaw.json',
  'cotrackerVisibility.json',
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
    `projects/${id}/thumbnail`,
    `projects/${id}/backgroundVideo`,
    `projects/${id}/ambientSound`,
    `projects/${id}/sceneBackground`,
    `projects/${id}/sceneForeground`,
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
    // Scene sounds (rattachés inline aux rest points / segments)
    const sceneSoundIds = new Set<string>()
    for (const rp of sceneDoc?.restPoints ?? []) {
      for (const arr of rp.randomAnimationSounds ?? []) for (const s of arr) sceneSoundIds.add(s.id)
    }
    const collectFromTransitionDoc = (t: SceneTransitionDoc | undefined) => {
      for (const seg of t?.segments ?? []) for (const s of seg.sounds ?? []) sceneSoundIds.add(s.id)
    }
    for (const t of sceneDoc?.transitions ?? []) collectFromTransitionDoc(t)
    collectFromTransitionDoc(sceneDoc?.startTransition)
    for (const meta of collectFilmDocSoundMetas(sceneDoc?.film)) sceneSoundIds.add(meta.id)
    for (const sid of sceneSoundIds) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/scene/sounds/${sid}`)).catch(() => {}))
    }
    // Décors propres aux plans du film legacy (scene.film)
    for (const plan of sceneDoc?.film?.plans ?? []) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/filmPlans/${plan.id}/background`)).catch(() => {}))
      deletions.push(deleteObject(ref(storage, `projects/${id}/filmPlans/${plan.id}/foreground`)).catch(() => {}))
    }
  }

  // FILM TIMELINE (v4) : décors de plans + sons de la bibliothèque
  if (data && 'filmT' in data && (data as unknown as ProjectDoc).filmT) {
    const ftDoc = (data as unknown as ProjectDoc).filmT!
    for (const plan of ftDoc.plans ?? []) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/film/plans/${plan.id}/backdrop`)).catch(() => {}))
      deletions.push(deleteObject(ref(storage, `projects/${id}/film/plans/${plan.id}/overlay`)).catch(() => {}))
    }
    for (const sid of collectFilmTDocSoundIds(ftDoc)) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/film/sounds/${sid}`)).catch(() => {}))
    }
  }

  // FILM niveau projet : décors de plans + sons
  if (data && 'film' in data && (data as unknown as ProjectDoc).film) {
    const filmDoc = (data as unknown as ProjectDoc).film!
    for (const plan of filmDoc.plans ?? []) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/film/plans/${plan.id}/backdrop`)).catch(() => {}))
      deletions.push(deleteObject(ref(storage, `projects/${id}/film/plans/${plan.id}/overlay`)).catch(() => {}))
    }
    for (const sid of collectFilmV3DocSoundIds(filmDoc)) {
      deletions.push(deleteObject(ref(storage, `projects/${id}/film/sounds/${sid}`)).catch(() => {}))
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
  await logAudit('project.delete', id)
}

// ⚠ Doit couvrir TOUS les champs JSON de AnimationUploadField : c'est la liste des
// fichiers Storage copiés par duplicateProject. Un champ manquant ici = données
// silencieusement perdues à la duplication (le doc annonce has*=true mais le
// fichier n'existe pas sur le nouveau projet).
const ANIM_UPLOAD_FIELDS: AnimationUploadField[] = [
  'video', 'audio', 'footstep1', 'footstep2',
  'contourOriginKeyframes', 'contourOriginFrames',
  'contourAnchorKeyframes', 'contourAnchorFrames',
  'contourSubdivisionFrames', 'contourCannyFrames',
  'anchorKeyframes', 'anchorFrames', 'boneWeights', 'videoFramesMesh',
  'walkZoneFrames', 'walkBodyFrames',
  'walkBodyFramesSmoothed', 'walkZoneFramesSmoothed',
  'sam2MasksRLE',
  'sam2Contours', 'sam2ContourOriginFrames', 'sam2ContourAnchorFrames', 'sam2ContourSubdivisionFrames',
  'sam2SmoothedAnchorFrames', 'sam2SmoothedSubdivisionFrames', 'sam2SmoothedContourOriginFrames',
  'cotrackerFrames', 'cotrackerFramesRaw', 'cotrackerVisibility',
]

export interface DuplicateProjectOverrides {
  name?: string
  bookId?: string | null
  bookOrder?: number
}

/**
 * Remappe toutes les références d'animations d'une scène vers les nouveaux ids
 * générés par la duplication (rest point, actions/discours/présentation, zones,
 * entrée, trapèze de marche, film). Sans ce remap, la scène du duplicata pointe
 * vers les animations de l'ANCIEN projet → références cassées (idle invisible,
 * boutons inertes, trajets sans animation).
 */
function remapSceneAnimationIds(scene: Scene | null, idMap: Map<string, string>): Scene | null {
  if (!scene) return scene
  const mapId = (id: string) => idMap.get(id) ?? id
  const mapAction = (a: import('../types/project').SceneAction): import('../types/project').SceneAction => ({
    ...a,
    steps: a.steps.map(s => ({ ...s, animationId: mapId(s.animationId) })),
  })
  const mapTravel = (t: import('../types/project').FilmTravel): import('../types/project').FilmTravel => ({
    ...t,
    ...(t.animationId != null && { animationId: mapId(t.animationId) }),
  })
  const rp = scene.restPoint
  return {
    ...scene,
    restPoint: rp
      ? {
          ...rp,
          ...(rp.restAnimationId != null && { restAnimationId: mapId(rp.restAnimationId) }),
          ...(rp.actions != null && { actions: rp.actions.map(mapAction) }),
          ...(rp.speeches != null && { speeches: rp.speeches.map(mapAction) }),
          ...(rp.presentation != null && { presentation: mapAction(rp.presentation) }),
          ...(rp.zoneAnimationMappings != null && { zoneAnimationMappings: rp.zoneAnimationMappings.map(m => ({ ...m, animationId: mapId(m.animationId) })) }),
          ...(rp.randomAnimationIds != null && { randomAnimationIds: rp.randomAnimationIds.map(mapId) }),
        }
      : rp,
    ...(scene.entryAnimationId != null && { entryAnimationId: mapId(scene.entryAnimationId) }),
    ...(scene.walkTrapezoid != null && {
      walkTrapezoid: { ...scene.walkTrapezoid, walkAnimationId: mapId(scene.walkTrapezoid.walkAnimationId) },
    }),
    ...(scene.film != null && {
      film: {
        ...scene.film,
        ...(scene.film.moveAnimationId != null && { moveAnimationId: mapId(scene.film.moveAnimationId) }),
        // Les `plan.id` ne sont PAS remappés (scopés par projectId) — les blobs
        // Storage des plans sont re-uploadés sous le nouveau projectId par les hints.
        plans: scene.film.plans.map(plan => ({
          ...plan,
          ...(plan.moveAnimationId != null && { moveAnimationId: mapId(plan.moveAnimationId) }),
          points: plan.points.map(p => ({
            ...p,
            travel: mapTravel(p.travel),
            ...(p.action != null && { action: mapAction(p.action) }),
            ...(p.departure != null && { departure: { ...p.departure, travel: mapTravel(p.departure.travel) } }),
          })),
          ending: plan.ending.kind === 'exit'
            ? { ...plan.ending, travel: mapTravel(plan.ending.travel) }
            : plan.ending,
        })),
      },
    }),
  }
}

/** Remappe les références d'animations d'un FILM (duplication). */
function remapFilmAnimationIds(film: import('../types/project').Film | null, idMap: Map<string, string>): import('../types/project').Film | null {
  if (!film) return film
  const mapId = (id: string) => idMap.get(id) ?? id
  const mapAction = (a: import('../types/project').SceneAction): import('../types/project').SceneAction => ({
    ...a,
    steps: a.steps.map(s => ({ ...s, animationId: mapId(s.animationId) })),
  })
  const mapTravel = (t: import('../types/project').FilmTravel): import('../types/project').FilmTravel => ({
    ...t,
    ...(t.animationId != null && { animationId: mapId(t.animationId) }),
  })
  return {
    ...film,
    ...(film.moveAnimationId != null && { moveAnimationId: mapId(film.moveAnimationId) }),
    plans: film.plans.map(pl => ({
      ...pl,
      ...(pl.moveAnimationId != null && { moveAnimationId: mapId(pl.moveAnimationId) }),
      points: pl.points.map(p => ({
        ...p,
        travel: mapTravel(p.travel),
        ...(p.action != null && { action: mapAction(p.action) }),
        ...(p.departure != null && { departure: { ...p.departure, travel: mapTravel(p.departure.travel) } }),
      })),
      ending: pl.ending.kind === 'exit'
        ? { ...pl.ending, travel: mapTravel(pl.ending.travel) }
        : pl.ending,
    })),
  }
}

export async function duplicateProject(sourceId: string, overrides?: DuplicateProjectOverrides): Promise<Project> {
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
    name: overrides?.name ?? `${source.name} (copie)`,
    createdAt: Date.now(),
    animations: source.animations.map(a => ({
      ...a,
      id: animIdMap.get(a.id)!,
      createdAt: Date.now(),
    })),
    film: remapFilmAnimationIds(source.film, animIdMap),
    filmT: remapFilmTAnimationIds(source.filmT, animIdMap),
    filmNeedsFullUpload: undefined,
    scene: remapSceneAnimationIds(source.scene, animIdMap),
    bookId: overrides?.bookId !== undefined ? overrides.bookId : source.bookId,
    bookOrder: overrides?.bookOrder !== undefined ? overrides.bookOrder : Date.now(),
    published: false,
    publishedAt: null,
  }

  // Build upload hints for all blobs
  const hints: UploadHint[] = []
  if (duplicate.originalImageBlob) hints.push('image')
  if (duplicate.thumbnailBlob) hints.push('thumbnail')
  if (duplicate.backgroundVideoBlob) hints.push('backgroundVideo')
  if (duplicate.ambientSoundBlob) hints.push('ambientSound')
  if (duplicate.projectTriangulation?.referenceImageBlob) hints.push('triangulationReferenceImage')
  if (duplicate.projectTriangulation?.masksRLE) hints.push('triangulationMasks')
  if (duplicate.projectTriangulation?.contours) hints.push('triangulationContours')
  if (duplicate.scene?.background && (duplicate.scene.background.imageBlob || duplicate.scene.background.videoBlob)) {
    hints.push('sceneBackground')
  }
  if (duplicate.scene?.foreground && (duplicate.scene.foreground.imageBlob || duplicate.scene.foreground.videoBlob)) {
    hints.push('sceneForeground')
  }
  for (const sound of duplicate.scene?.speakSounds ?? []) {
    hints.push({ speakSoundId: sound.id })
  }
  for (const sid of collectSceneSoundIds(duplicate.scene)) {
    hints.push({ sceneSoundId: sid })
  }
  for (const plan of duplicate.scene?.film?.plans ?? []) {
    if (plan.background && (plan.background.imageBlob || plan.background.videoBlob)) {
      hints.push({ filmPlanBackground: plan.id })
    }
    if (plan.foreground && (plan.foreground.imageBlob || plan.foreground.videoBlob)) {
      hints.push({ filmPlanForeground: plan.id })
    }
  }
  // FILM niveau projet : décors de plans + sons (le duplicata démarre directement
  // au nouveau format, même si la source était un film legacy converti).
  const dupFilmSoundIds = new Set<string>()
  const dupFilmPlanIds = new Set<string>()
  // filmT (v4) prioritaire ; les plans/sons v3 partagent les mêmes chemins →
  // dédupliqués par id pour ne pas uploader deux fois le même blob.
  for (const plan of duplicate.filmT?.plans ?? []) {
    dupFilmPlanIds.add(plan.id)
    if (plan.backdrop && (plan.backdrop.imageBlob || plan.backdrop.videoBlob)) {
      hints.push({ filmPlanBackdrop: plan.id })
    }
    if (plan.overlay && (plan.overlay.imageBlob || plan.overlay.videoBlob)) {
      hints.push({ filmPlanOverlay: plan.id })
    }
  }
  for (const s of iterateFilmTSounds(duplicate.filmT)) {
    if (s.blob && !dupFilmSoundIds.has(s.id)) {
      dupFilmSoundIds.add(s.id)
      hints.push({ filmSoundId: s.id })
    }
  }
  for (const plan of duplicate.film?.plans ?? []) {
    if (dupFilmPlanIds.has(plan.id)) continue
    if (plan.backdrop && (plan.backdrop.imageBlob || plan.backdrop.videoBlob)) {
      hints.push({ filmPlanBackdrop: plan.id })
    }
    if (plan.overlay && (plan.overlay.imageBlob || plan.overlay.videoBlob)) {
      hints.push({ filmPlanOverlay: plan.id })
    }
  }
  for (const s of iterateFilmV3Sounds(duplicate.film)) {
    if (s.blob && !dupFilmSoundIds.has(s.id)) {
      dupFilmSoundIds.add(s.id)
      hints.push({ filmSoundId: s.id })
    }
  }
  for (const anim of duplicate.animations) {
    const newAnimId = anim.id
    for (const field of ANIM_UPLOAD_FIELDS) {
      if (field === 'video' && anim.videoBlob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field === 'audio' && anim.audioBlob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field === 'footstep1' && anim.footstepSound1Blob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field === 'footstep2' && anim.footstepSound2Blob) {
        hints.push({ animationId: newAnimId, field })
      } else if (field !== 'video' && field !== 'audio' && field !== 'footstep1' && field !== 'footstep2' && anim.mesh) {
        const val = anim.mesh[field as keyof typeof anim.mesh]
        if (val && (Array.isArray(val) ? val.length > 0 : true)) {
          hints.push({ animationId: newAnimId, field })
        }
      }
    }
  }

  // Uploads d'abord (avec retry), doc Firestore en DERNIER : le duplicata
  // n'apparaît que quand la copie est complète.
  await updateProject(duplicate, hints, { docAfterUploads: true })
  console.log(`[Firebase] Project duplicated: ${sourceId} -> ${newId}`)
  await logAudit('project.duplicate', newId, { sourceId })
  return duplicate
}

/** Met à jour le rattachement livre d'un projet (Firestore minimal, sans toucher les blobs). */
export async function setProjectBook(projectId: string, bookId: string | null, bookOrder?: number): Promise<void> {
  await updateDoc(projectRef(projectId), {
    bookId,
    bookOrder: bookOrder ?? Date.now(),
  })
  await logAudit('project.move', projectId, { bookId })
}

/** Liste les projets rattachés à un livre, triés par bookOrder asc. Métadonnées only (pas de blobs).
 *  Si `publishedOnly` est true, ne retourne que les projets publiés (requis pour la lecture anonyme côté play). */
export async function getProjectsByBook(bookId: string, publishedOnly = false): Promise<Project[]> {
  const constraints = [where('bookId', '==', bookId)]
  if (publishedOnly) constraints.push(where('published', '==', true))
  const q = query(projectsCol(), ...constraints)
  const snap = await getDocs(q)
  const list = snap.docs.map(d => {
    const projDoc = d.data() as unknown as ProjectDoc
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
      film: null,
      hasFilm: computeDocHasFilm(projDoc),
      scene: null,
      projectTriangulation: null,
      projectEyes: projDoc.projectEyes ?? null,
      projectMouth: projDoc.projectMouth ?? null,
      published: projDoc.published === true,
      publishedAt: projDoc.publishedAt ?? null,
      bookId: projDoc.bookId ?? null,
      bookOrder: projDoc.bookOrder ?? projDoc.createdAt ?? 0,
      thumbnailBlob: null,
      // Permet à la vignette play d'éviter une requête /thumbnail vouée à 404 quand
      // le projet n'a pas de vignette dédiée (cf. BookPage → fallback image directe).
      hasThumbnail: projDoc.hasThumbnail === true,
    }
  })
  return list.sort((a, b) => (a.bookOrder ?? 0) - (b.bookOrder ?? 0))
}

/** Télécharge uniquement la vignette d'un projet (pour le menu livre côté play). */
export async function getProjectThumbnailBlob(projectId: string): Promise<Blob | null> {
  return downloadBlob(`projects/${projectId}/thumbnail`)
}

export type EnsureThumbnailResult = 'generated' | 'skipped-existing' | 'no-image' | 'not-found' | 'error'

/**
 * Garantit qu'une vignette légère existe pour le projet, pour un menu livre rapide
 * côté play. No-op si une vignette est déjà présente (`hasThumbnail`), sauf si
 * `opts.force` est vrai (régénération depuis l'image originale). Génère une image
 * réduite depuis l'image originale (fournie ou re-téléchargée), l'upload sous
 * `projects/{id}/thumbnail` et lève le flag Firestore `hasThumbnail`.
 *
 * Appelé à la publication (backfill des projets existants), à l'import d'image
 * (cf. ProjectImportSection) et par le script de backfill global (backfillThumbnails).
 * Tolérant : toute erreur est avalée (log) et renvoyée comme statut — ne bloque rien.
 */
export async function ensureProjectThumbnail(
  projectId: string,
  imageBlob?: Blob | null,
  opts?: { force?: boolean },
): Promise<EnsureThumbnailResult> {
  try {
    const snap = await getDoc(projectRef(projectId))
    if (!snap.exists()) return 'not-found'
    const data = snap.data() as Record<string, unknown>
    if (data.hasThumbnail === true && !opts?.force) return 'skipped-existing'
    const source = imageBlob ?? (await downloadBlob(`projects/${projectId}/originalImage`))
    if (!source) return 'no-image'
    const thumb = await generateThumbnailBlob(source)
    await uploadBlob(`projects/${projectId}/thumbnail`, thumb)
    if (data.hasThumbnail !== true) await updateDoc(projectRef(projectId), { hasThumbnail: true })
    return 'generated'
  } catch (err) {
    console.warn(`[thumbnail] ensure failed for ${projectId}:`, err)
    return 'error'
  }
}

// ===================================================================
// Play-optimized loaders
// ===================================================================
// Le pipeline play (apps/play) n'a besoin que des données de rendu finales :
// - image projet (texture du mesh)
// - per-animation : videoFramesMesh, walkBodyFrames, walkZoneFrames (+ smoothed)
// - bodyZones, scene.restPoints, projectTriangulation (zones / triangles)
// Tout le reste (vidéos sources, keyframes, sam2*, cotrackerFrames, Canny cache,
// triangulation reference/masks/contours) ne sert qu'au pipeline d'édition admin.
//
// Loaders en deux phases : essential = bloquant (image + meshes), deferred =
// arrière-plan (audio + vidéo bg + scene layers + speak sounds + anim audio).
// ===================================================================

async function loadAnimationJSONForPlay(
  projectId: string,
  animId: string,
  meshDoc: MeshDoc,
): Promise<Partial<ReturnType<typeof loadAnimationJSON> extends Promise<infer T> ? T : never>> {
  const path = (file: string) => animStoragePath(projectId, animId, file)
  const [videoFramesMesh, walkZoneFrames, walkBodyFrames, walkBodyFramesSmoothed, walkZoneFramesSmoothed] = await Promise.all([
    meshDoc.hasVideoFramesMesh ? downloadJSON<Point2D[][]>(path('videoFramesMesh.json')) : null,
    meshDoc.hasWalkZoneFrames ? downloadJSON<Record<string, Point2D[][]>>(path('walkZoneFrames.json')) : null,
    meshDoc.hasWalkBodyFrames ? downloadJSON<Point2D[][]>(path('walkBodyFrames.json')) : null,
    meshDoc.hasWalkBodyFramesSmoothed ? downloadJSON<Point2D[][]>(path('walkBodyFramesSmoothed.json')) : null,
    meshDoc.hasWalkZoneFramesSmoothed ? downloadJSON<Record<string, Point2D[][]>>(path('walkZoneFramesSmoothed.json')) : null,
  ])
  return { videoFramesMesh, walkZoneFrames, walkBodyFrames, walkBodyFramesSmoothed, walkZoneFramesSmoothed }
}

/** Charge UNIQUEMENT le doc Firestore (métadonnées, mesh topology, markers,
 *  zones, scene config, projectTriangulation géométrie). Pas un seul fetch
 *  Storage : ~50 ms. Suffit pour valider le projet et démarrer l'UI scan.
 *  Tous les blobs (image, vidéos, audio, JSON videoFramesMesh, etc.) sont
 *  chargés ensuite par loadProjectForPlayDeferred en arrière-plan pendant
 *  que l'utilisateur prend sa photo. */
export async function loadProjectForPlayEssential(id: string): Promise<Project | undefined> {
  const snap = await getDoc(projectRef(id))
  if (!snap.exists()) return undefined
  const data = snap.data() as Record<string, unknown>

  if (isLegacyProjectDoc(data)) {
    return fromLegacyDoc(data as unknown as LegacyProjectDoc)
  }

  const projDoc = data as unknown as ProjectDoc

  // Pas de fetch Storage en phase 1 → image, audio, JSON tous chargés en phase 2.
  const animations: Animation[] = projDoc.animations.map(animDoc => {
    let mesh: MeshData | null = null
    if (animDoc.mesh) {
      // Topologie mesh hydratée depuis le Firestore doc (triangles, anchors, internalBarycentrics)
      // mais sans les gros JSON (videoFramesMesh, walk*Frames) — phase 2.
      mesh = meshShellFromDoc(animDoc.mesh as MeshDoc)
    }
    return {
      id: animDoc.id,
      name: animDoc.name,
      type: animDoc.type,
      playbackMode: animDoc.playbackMode ?? 'oneshot',
      createdAt: animDoc.createdAt,
      videoBlob: null,
      mesh,
      physicsCode: animDoc.physicsCode ?? null,
      physicsDuration: animDoc.physicsDuration ?? null,
      physicsOverlay: animDoc.physicsOverlay ?? false,
      audioBlob: null,
      audioEnabled: animDoc.audioEnabled ?? false,
    }
  })

  // Triangulation : on hydrate les données géométriques (déjà dans Firestore doc)
  // mais on saute referenceImage / masksRLE / contours (admin only).
  let projectTriangulation: ProjectTriangulation | null = null
  if (projDoc.projectTriangulation) {
    const triBase = projectTriangulationFromDoc(projDoc.projectTriangulation)
    projectTriangulation = { ...triBase, referenceImageBlob: null, masksRLE: null, contours: null }
  }

  // Scene : on hydrate les méta mais on garde les blobs lourds (layers / sounds) pour la phase différée.
  let scene: Scene | null = null
  if (projDoc.scene) {
    const speakSounds = projDoc.scene.speakSounds ?? []
    // Métadonnées seules (blobs hydratés plus tard via hydrateProjectAssets)
    let background: SceneBackground | null = null
    if (projDoc.scene.background) {
      background = { imageBlob: null, videoBlob: null, width: projDoc.scene.background.width, height: projDoc.scene.background.height }
    } else if (projDoc.scene.backgroundLayers) {
      const legacy = projDoc.scene.backgroundLayers.find(l => l.hasImage || l.hasVideo)
      if (legacy) background = { imageBlob: null, videoBlob: null, width: legacy.width, height: legacy.height }
    } else if (projDoc.scene.hasBackgroundImage) {
      background = { imageBlob: null, videoBlob: null, width: projDoc.scene.backgroundWidth ?? 0, height: projDoc.scene.backgroundHeight ?? 0 }
    }
    const fgDocE = projDoc.scene.foreground
    const foreground: SceneForeground | null = (fgDocE?.hasImage || fgDocE?.hasVideo)
      ? {
          imageBlob: null,
          videoBlob: null,
          width: fgDocE.width,
          height: fgDocE.height,
          chromaKeyColor: fgDocE.chromaKeyColor ?? null,
          chromaKeyThreshold: fgDocE.chromaKeyThreshold,
          chromaKeySmoothness: fgDocE.chromaKeySmoothness,
        }
      : null

    const docToActionEssentials = (a: SceneActionDoc): import('../types/project').SceneAction => {
      const steps = a.steps
        ? a.steps.map(s => ({
            animationId: s.animationId,
            ...(s.sound != null && { sound: { id: s.sound.id, name: s.sound.name, volume: s.sound.volume, loop: s.sound.loop, rate: s.sound.rate, blob: null } }),
            ...(s.isSpoken && { isSpoken: true }),
            ...(s.animSpeedMul != null && { animSpeedMul: s.animSpeedMul }),
      ...(s.loop && { loop: true }),
          }))
        : (a.animationIds ?? []).map((animId: string) => ({ animationId: animId }))
      return {
        id: a.id,
        name: a.name,
        steps,
        ...(a.sound != null && { sound: { id: a.sound.id, name: a.sound.name, volume: a.sound.volume, loop: a.sound.loop, rate: a.sound.rate, blob: null } }),
        ...(a.isSpoken && { isSpoken: true }),
      }
    }

    const docToFilmTravelEssentials = (t: FilmTravelDoc | undefined): import('../types/project').FilmTravel => ({
      ...(t?.animationId != null && { animationId: t.animationId }),
      ...(t?.speedPxPerSec != null && { speedPxPerSec: t.speedPxPerSec }),
      ...(t?.animSpeedMul != null && { animSpeedMul: t.animSpeedMul }),
      ...(t?.sound != null && { sound: { id: t.sound.id, name: t.sound.name, volume: t.sound.volume, loop: t.sound.loop, rate: t.sound.rate, blob: null } }),
      ...(t?.origin != null && { origin: t.origin }),
      ...(t?.controlPoints != null && t.controlPoints.length > 0 && { controlPoints: t.controlPoints.map(cp => ({ x: cp.x, y: cp.y })) }),
      ...(t?.easing != null && { easing: t.easing }),
    })

    const docToFilmPointEssentials = (p: FilmPointDoc): import('../types/project').FilmPoint => ({
      id: p.id,
      x: p.x,
      y: p.y,
      scale: p.scale ?? 1,
      travel: docToFilmTravelEssentials(p.travel),
      ...(p.action != null && { action: docToActionEssentials(p.action) }),
      ...(p.pauseMs != null && p.pauseMs > 0 && { pauseMs: p.pauseMs }),
      ...(p.facing != null && { facing: p.facing }),
      ...(p.departure != null && { departure: { target: p.departure.target, travel: docToFilmTravelEssentials(p.departure.travel) } }),
    })

    const docToFilmEndingEssentials = (e: FilmEndingDoc | undefined): import('../types/project').FilmEnding =>
      e?.kind === 'exit'
        ? { kind: 'exit', side: e.side, travel: docToFilmTravelEssentials(e.travel) }
        : { kind: 'stay' }

    const docToFilmPlanEssentials = (pl: FilmPlanDoc): import('../types/project').SceneFilmPlan => ({
      id: pl.id,
      ...(pl.name != null && { name: pl.name }),
      background: pl.background
        ? { imageBlob: null, videoBlob: null, width: pl.background.width, height: pl.background.height }
        : null,
      foreground: pl.foreground
        ? {
            imageBlob: null,
            videoBlob: null,
            width: pl.foreground.width,
            height: pl.foreground.height,
            chromaKeyColor: pl.foreground.chromaKeyColor ?? null,
            chromaKeyThreshold: pl.foreground.chromaKeyThreshold,
            chromaKeySmoothness: pl.foreground.chromaKeySmoothness,
          }
        : null,
      cameraX: pl.cameraX ?? 0,
      entrySide: pl.entrySide ?? 'left',
      points: (pl.points ?? []).map(docToFilmPointEssentials),
      ending: docToFilmEndingEssentials(pl.ending),
      ...(pl.transitionToNext != null && { transitionToNext: pl.transitionToNext }),
      ...(pl.moveAnimationId != null && { moveAnimationId: pl.moveAnimationId }),
      ...(pl.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: pl.moveSpeedPxPerSec }),
      ...(pl.idleSpeedMul != null && { idleSpeedMul: pl.idleSpeedMul }),
    })

    // Garde de compat : docs film v1 (format `steps`) ignorés.
    // Migration : format à plat (pré-plans) → plans[0] avec décor de la scène.
    const docToFilmEssentials = (filmDoc: SceneFilmDoc): import('../types/project').SceneFilm | undefined => {
      let plans: import('../types/project').SceneFilmPlan[]
      if (Array.isArray(filmDoc.plans) && filmDoc.plans.length > 0) {
        plans = filmDoc.plans.map(docToFilmPlanEssentials)
      } else if (Array.isArray(filmDoc.points)) {
        plans = [{
          id: crypto.randomUUID(),
          background: null,
          foreground: null,
          cameraX: filmDoc.cameraX ?? 0,
          entrySide: filmDoc.entrySide ?? 'left',
          points: filmDoc.points.map(docToFilmPointEssentials),
          ending: docToFilmEndingEssentials(filmDoc.ending),
        }]
      } else {
        return undefined
      }
      return {
        enabled: filmDoc.enabled,
        plans,
        ...(filmDoc.moveAnimationId != null && { moveAnimationId: filmDoc.moveAnimationId }),
        moveSpeedPxPerSec: filmDoc.moveSpeedPxPerSec ?? 260,
        ...(filmDoc.idleSpeedMul != null && { idleSpeedMul: filmDoc.idleSpeedMul }),
        endBehavior: filmDoc.endBehavior ?? 'menu',
      }
    }

    const docToRestPointEssentials = (rp: SceneRestPointDoc): import('../types/project').SceneRestPoint => {
      const docToAction = docToActionEssentials
      let actions = rp.actions?.map(docToAction)
      if (!actions || actions.length === 0) {
        const legacyIds = rp.randomAnimationIds ?? rp.availableAnimationIds ?? []
        if (legacyIds.length > 0) {
          actions = legacyIds.map((animId, i) => {
            const legacySound = rp.randomAnimationSounds?.[i]?.[0]
            return {
              id: crypto.randomUUID(),
              name: `Action ${i + 1}`,
              steps: [{ animationId: animId }],
              ...(legacySound && { sound: { id: legacySound.id, name: legacySound.name, volume: legacySound.volume, blob: null } }),
            }
          })
        }
      }
      let speeches = rp.speeches?.map(docToAction)
      // Migration 3-boutons → 1 ACTION + Discours : si pas de `speeches`, le reste des actions devient les discours.
      if (speeches == null && actions && actions.length > 1) {
        speeches = actions.slice(1)
        actions = actions.slice(0, 1)
      }
      return {
        id: rp.id,
        backgroundX: rp.backgroundX,
        ...(rp.restAnimationId != null && { restAnimationId: rp.restAnimationId }),
        ...(actions && actions.length > 0 && { actions }),
        ...(speeches && speeches.length > 0 && { speeches }),
        ...(rp.presentation != null && { presentation: docToAction(rp.presentation) }),
        ...(rp.zoneAnimationMappings != null && { zoneAnimationMappings: rp.zoneAnimationMappings }),
        ...(rp.speakSoundIds != null && { speakSoundIds: rp.speakSoundIds }),
        ...(rp.helpTexts != null && { helpTexts: rp.helpTexts }),
      }
    }

    const rpDoc = projDoc.scene.restPoint ?? projDoc.scene.restPoints?.[0]
    const restPoint = rpDoc ? docToRestPointEssentials(rpDoc) : { id: crypto.randomUUID(), backgroundX: 0 }

    let entry: 'fixed' | 'moving' = projDoc.scene.entry ?? 'fixed'
    let entryStartX = projDoc.scene.entryStartX
    if (projDoc.scene.entry == null) {
      if (projDoc.scene.startMode === 'transition' && projDoc.scene.startX != null) {
        entry = 'moving'
        entryStartX = projDoc.scene.startX
      }
    }

    const filmEssentials = projDoc.scene.film ? docToFilmEssentials(projDoc.scene.film) : undefined

    scene = {
      id: projDoc.scene.id,
      name: projDoc.scene.name,
      background,
      foreground,
      characterScale: projDoc.scene.characterScale,
      characterY: projDoc.scene.characterY,
      restPoint,
      entry,
      ...(entryStartX != null && { entryStartX }),
      ...(projDoc.scene.entryDurationMs != null && { entryDurationMs: projDoc.scene.entryDurationMs }),
      ...(projDoc.scene.entryAnimationId != null && { entryAnimationId: projDoc.scene.entryAnimationId }),
      ...(projDoc.scene.entrySound != null && { entrySound: { id: projDoc.scene.entrySound.id, name: projDoc.scene.entrySound.name, volume: projDoc.scene.entrySound.volume, blob: null } }),
      ...(projDoc.scene.ambientSound != null && { ambientSound: { id: projDoc.scene.ambientSound.id, name: projDoc.scene.ambientSound.name, volume: projDoc.scene.ambientSound.volume, blob: null } }),
      ...(projDoc.scene.walkTrapezoid != null && { walkTrapezoid: projDoc.scene.walkTrapezoid }),
      ...(filmEssentials != null && { film: filmEssentials }),
      ...(projDoc.scene.characterFacing != null && { characterFacing: projDoc.scene.characterFacing }),
      ...(projDoc.scene.characterOriginU != null && { characterOriginU: projDoc.scene.characterOriginU }),
      ...(projDoc.scene.characterOriginV != null && { characterOriginV: projDoc.scene.characterOriginV }),
      speakSounds,
      speakSoundBlobs: speakSounds.map(() => null),
    }
  }

  // FILM niveau projet (essentials, sans blobs — hydraté en phase différée) :
  // doc.film prioritaire ; sinon conversion legacy scene.film.
  let filmEssentialsV3: import('../types/project').Film | null = null
  let filmEssentialsT: import('../types/project').FilmT | null = null
  if (projDoc.filmT) {
    filmEssentialsT = docToFilmT(projDoc.filmT, () => null)
  } else if (projDoc.film) {
    filmEssentialsV3 = docToFilmV3(projDoc.film, () => null)
  } else if (scene) {
    filmEssentialsV3 = convertLegacySceneFilm(scene)
  }

  return {
    id: projDoc.id,
    name: projDoc.name,
    createdAt: projDoc.createdAt,
    originalImageBlob: null,         // Différé (chargé en phase 2)
    backgroundVideoBlob: null,       // Différé
    ambientSoundBlob: null,          // Différé
    ambientSoundEnabled: projDoc.ambientSoundEnabled ?? false,
    animations,
    bodyZones: (projDoc.bodyZones ?? []).map((z: Record<string, unknown>) => ({
      id: z.id as string,
      label: z.label as string,
      color: z.color as string,
      triangleIndices: (z.triangleIndices ?? z.vertexIndices ?? []) as number[],
    })),
    markers: projDoc.markers,
    film: filmEssentialsV3,
    filmT: filmEssentialsT,
    scene,
    projectTriangulation,
    projectEyes: projDoc.projectEyes ?? null,
    projectMouth: projDoc.projectMouth ?? null,
    published: projDoc.published === true,
    publishedAt: projDoc.publishedAt ?? null,
    bookId: projDoc.bookId ?? null,
    bookOrder: projDoc.bookOrder ?? projDoc.createdAt ?? 0,
    thumbnailBlob: null,
  }
}

/** Complète un Project chargé par essential avec tous les blobs Storage :
 *  image, vidéo de fond, audio, JSON videoFramesMesh/walk*Frames par animation,
 *  per-animation audio, calques de scène, speak sounds, scene sounds.
 *  Tout est téléchargé en parallèle. */
export async function loadProjectForPlayDeferred(project: Project): Promise<Project> {
  const id = project.id

  // Snapshot Firestore pour récupérer les flags hasXxx des meshes (sans refetcher tout).
  const snap = await getDoc(projectRef(id))
  const projDoc = snap.data() as unknown as ProjectDoc | undefined

  const [originalImageBlob, backgroundVideoBlob, ambientSoundBlob] = await Promise.all([
    project.originalImageBlob === null ? downloadBlob(`projects/${id}/originalImage`).catch(() => null) : Promise.resolve(project.originalImageBlob),
    project.backgroundVideoBlob === null ? downloadBlob(`projects/${id}/backgroundVideo`).catch(() => null) : Promise.resolve(project.backgroundVideoBlob),
    project.ambientSoundBlob === null ? downloadBlob(`projects/${id}/ambientSound`).catch(() => null) : Promise.resolve(project.ambientSoundBlob),
  ])

  // Per-animation : audio + JSON videoFramesMesh / walk*Frames (en parallèle).
  const animationsWithAudio = await Promise.all(
    project.animations.map(async anim => {
      const animDoc = projDoc?.animations.find(a => a.id === anim.id)
      const meshDoc = animDoc?.mesh as MeshDoc | null | undefined
      const [audio, footstep1, footstep2, meshJson] = await Promise.all([
        anim.audioBlob != null
          ? Promise.resolve(anim.audioBlob)
          : downloadBlob(animStoragePath(id, anim.id, 'audio')).catch(() => null),
        anim.footstepSound1Blob != null
          ? Promise.resolve(anim.footstepSound1Blob)
          : (animDoc?.hasFootstep1 ? downloadBlob(animStoragePath(id, anim.id, 'footstep1')).catch(() => null) : Promise.resolve(null)),
        anim.footstepSound2Blob != null
          ? Promise.resolve(anim.footstepSound2Blob)
          : (animDoc?.hasFootstep2 ? downloadBlob(animStoragePath(id, anim.id, 'footstep2')).catch(() => null) : Promise.resolve(null)),
        meshDoc ? loadAnimationJSONForPlay(id, anim.id, meshDoc) : Promise.resolve({}),
      ])
      const mesh: MeshData | null = anim.mesh ? { ...anim.mesh, ...(meshJson as Partial<MeshData>) } : null
      return { ...anim, audioBlob: audio, footstepSound1Blob: footstep1, footstepSound2Blob: footstep2, mesh }
    })
  )

  // Scene background + foreground + speak sounds + scene sounds
  let scene = project.scene
  if (scene) {
    const bgDoc = projDoc?.scene?.background ?? null
    const bgHasVideo = bgDoc?.hasVideo === true
    const fgDocDef = projDoc?.scene?.foreground ?? null
    const fgHasVideo = fgDocDef?.hasVideo === true
    // Robustesse : on télécharge dès que les métadonnées du calque existent, sans se
    // fier au flag hasVideo/hasImage du doc (qui peut être périmé/incohérent → fond noir).
    // Le type image/vidéo est ensuite déterminé via le MIME du blob.
    const [backgroundBlob, foregroundBlob] = await Promise.all([
      scene.background
        ? ((scene.background.imageBlob || scene.background.videoBlob)
            ? Promise.resolve(scene.background.imageBlob ?? scene.background.videoBlob)
            : downloadBlob(`projects/${id}/sceneBackground`).catch(() => null))
        : Promise.resolve(null),
      scene.foreground
        ? ((scene.foreground.imageBlob || scene.foreground.videoBlob)
            ? Promise.resolve(scene.foreground.imageBlob ?? scene.foreground.videoBlob)
            : downloadBlob(`projects/${id}/sceneForeground`).catch(() => null))
        : Promise.resolve(null),
    ])
    const bgIsVideo = backgroundBlob ? (backgroundBlob.type.startsWith('video/') || bgHasVideo) : bgHasVideo
    const fgIsVideo = foregroundBlob ? (foregroundBlob.type.startsWith('video/') || fgHasVideo) : fgHasVideo
    const speakSoundBlobs = await Promise.all(
      scene.speakSounds.map(s => downloadBlob(`projects/${id}/scene/speakSounds/${s.id}`).catch(() => null))
    )
    // Collect sceneSounds IDs (entry + ambient + restPoint actions + legacy random) puis download.
    const soundIds = new Set<string>()
    if (scene.entrySound) soundIds.add(scene.entrySound.id)
    if (scene.ambientSound) soundIds.add(scene.ambientSound.id)
    const rp = scene.restPoint
    if (rp) {
      for (const a of [...(rp.actions ?? []), ...(rp.speeches ?? []), ...(rp.presentation ? [rp.presentation] : [])]) {
        if (a.sound) soundIds.add(a.sound.id)
        for (const s of a.steps ?? []) if (s.sound) soundIds.add(s.sound.id)
      }
      for (const arr of rp.randomAnimationSounds ?? []) for (const s of arr) soundIds.add(s.id)
    }
    for (const snd of iterateFilmSounds(scene.film)) soundIds.add(snd.id)
    const ids = [...soundIds]
    const sceneSoundBlobs = await Promise.all(ids.map(sid => downloadBlob(`projects/${id}/scene/sounds/${sid}`).catch(() => null)))
    const sceneSoundMap = new Map(ids.map((sid, i) => [sid, sceneSoundBlobs[i]]))
    const hydrateActionBlobs = (a: import('../types/project').SceneAction): import('../types/project').SceneAction => ({
      ...a,
      ...(a.sound != null && { sound: { ...a.sound, blob: sceneSoundMap.get(a.sound.id) ?? a.sound.blob ?? null } }),
      steps: a.steps.map(s => ({
        ...s,
        ...(s.sound != null && { sound: { ...s.sound, blob: sceneSoundMap.get(s.sound.id) ?? s.sound.blob ?? null } }),
      })),
    })
    const hydrateTravelBlob = (t: import('../types/project').FilmTravel): import('../types/project').FilmTravel => ({
      ...t,
      ...(t.sound != null && { sound: { ...t.sound, blob: sceneSoundMap.get(t.sound.id) ?? t.sound.blob ?? null } }),
    })

    // Décors propres aux plans du film : download parallèle, type via MIME du blob.
    const filmPlansHydrated = scene.film
      ? await Promise.all(scene.film.plans.map(async (plan) => {
          const [planBg, planFg] = await Promise.all([
            plan.background && !plan.background.imageBlob && !plan.background.videoBlob
              ? downloadBlob(`projects/${id}/filmPlans/${plan.id}/background`).catch(() => null)
              : Promise.resolve(null),
            plan.foreground && !plan.foreground.imageBlob && !plan.foreground.videoBlob
              ? downloadBlob(`projects/${id}/filmPlans/${plan.id}/foreground`).catch(() => null)
              : Promise.resolve(null),
          ])
          return {
            ...plan,
            background: plan.background && planBg
              ? {
                  ...plan.background,
                  imageBlob: planBg.type.startsWith('video/') ? null : planBg,
                  videoBlob: planBg.type.startsWith('video/') ? planBg : null,
                }
              : plan.background,
            foreground: plan.foreground && planFg
              ? {
                  ...plan.foreground,
                  imageBlob: planFg.type.startsWith('video/') ? null : planFg,
                  videoBlob: planFg.type.startsWith('video/') ? planFg : null,
                }
              : plan.foreground,
          }
        }))
      : null

    scene = {
      ...scene,
      background: scene.background
        ? {
            ...scene.background,
            imageBlob: scene.background.imageBlob ?? (bgIsVideo ? null : backgroundBlob),
            videoBlob: scene.background.videoBlob ?? (bgIsVideo ? backgroundBlob : null),
          }
        : null,
      foreground: scene.foreground
        ? {
            ...scene.foreground,
            imageBlob: scene.foreground.imageBlob ?? (fgIsVideo ? null : foregroundBlob),
            videoBlob: scene.foreground.videoBlob ?? (fgIsVideo ? foregroundBlob : null),
          }
        : null,
      ...(scene.entrySound != null && { entrySound: { ...scene.entrySound, blob: sceneSoundMap.get(scene.entrySound.id) ?? scene.entrySound.blob ?? null } }),
      ...(scene.ambientSound != null && { ambientSound: { ...scene.ambientSound, blob: sceneSoundMap.get(scene.ambientSound.id) ?? scene.ambientSound.blob ?? null } }),
      restPoint: {
        ...scene.restPoint,
        ...(scene.restPoint.actions != null && {
          actions: scene.restPoint.actions.map(hydrateActionBlobs),
        }),
        ...(scene.restPoint.speeches != null && {
          speeches: scene.restPoint.speeches.map(hydrateActionBlobs),
        }),
        ...(scene.restPoint.presentation != null && {
          presentation: hydrateActionBlobs(scene.restPoint.presentation),
        }),
      },
      ...(scene.film != null && filmPlansHydrated != null && {
        film: {
          ...scene.film,
          plans: filmPlansHydrated.map(plan => ({
            ...plan,
            points: plan.points.map(p => ({
              ...p,
              travel: hydrateTravelBlob(p.travel),
              ...(p.action != null && { action: hydrateActionBlobs(p.action) }),
              ...(p.departure != null && { departure: { ...p.departure, travel: hydrateTravelBlob(p.departure.travel) } }),
            })),
            ending: plan.ending.kind === 'exit'
              ? { ...plan.ending, travel: hydrateTravelBlob(plan.ending.travel) }
              : plan.ending,
          })),
        },
      }),
      speakSoundBlobs,
    }
  }

  // FILM niveau projet : hydratation des blobs (phase différée).
  // doc.film présent → sons film/sounds/ + décors film/plans/ ;
  // sinon legacy → reconversion depuis la scène HYDRATÉE (décor + sons scène).
  let film = project.film
  let filmT = project.filmT ?? null
  if (projDoc?.filmT) {
    const soundIds = collectFilmTDocSoundIds(projDoc.filmT)
    const soundBlobs = await Promise.all(
      soundIds.map(sid => downloadBlob(`projects/${id}/film/sounds/${sid}`).catch(() => null))
    )
    const soundMap = new Map(soundIds.map((sid, i) => [sid, soundBlobs[i]]))
    filmT = docToFilmT(projDoc.filmT, sid => soundMap.get(sid) ?? null)
    filmT = await hydrateFilmTDecorBlobs(id, filmT)
  } else if (projDoc?.film) {
    const filmSoundIds = collectFilmV3DocSoundIds(projDoc.film)
    const filmSoundBlobs = await Promise.all(
      filmSoundIds.map(sid => downloadBlob(`projects/${id}/film/sounds/${sid}`).catch(() => null))
    )
    const filmSoundMap = new Map(filmSoundIds.map((sid, i) => [sid, filmSoundBlobs[i]]))
    film = docToFilmV3(projDoc.film, sid => filmSoundMap.get(sid) ?? null)
    film = await hydrateFilmV3DecorBlobs(id, film)
  } else if (film && scene) {
    film = convertLegacySceneFilm(scene) ?? film
  }

  return {
    ...project,
    originalImageBlob,
    backgroundVideoBlob,
    ambientSoundBlob,
    animations: animationsWithAudio,
    film,
    filmT,
    scene,
  }
}
