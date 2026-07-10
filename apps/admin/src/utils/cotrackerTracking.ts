/**
 * CoTracker3 Tracking Client.
 *
 * The Cloud Function (already deployed sur le projet GCP, host
 * `cotracker-track-6gzhik6pka-ew.a.run.app`) attend ce schéma :
 *
 *   POST {
 *     video: base64 MP4,
 *     queryFrame: int,                                // unique pour tout le lot
 *     queryPoints: [{ x, y }, ...],                   // ordonnés
 *     startFrame: int, endFrame: int,
 *   } → {
 *     startFrame, endFrame, videoWidth, videoHeight,
 *     tracks: [frame][pointIdx] = { x, y },
 *   }
 *
 * Comme le serveur ne supporte qu'un seul `queryFrame` par appel, on **groupe les
 * prompts par frame** : 1 appel par frame d'origine, puis on fusionne. Pour un point
 * avec plusieurs prompts à des frames différentes, on prend la trajectoire issue
 * de son premier prompt (limitation du serveur — la propagation est forward+backward
 * mais à partir d'un seul queryFrame par batch).
 */

import type { Point2D, CoTrackerPoint } from '../types/project'

const COTRACKER_FUNCTION_URL = import.meta.env.VITE_COTRACKER_FUNCTION_URL
  || 'https://cotracker-track-6gzhik6pka-ew.a.run.app'

export type CoTrackerPhase = 'warmup' | 'uploading' | 'tracking'
export type CoTrackerResolution = 'native' | '512'
export type CoTrackerEngine = 'offline' | 'online'

export interface CoTrackerResult {
  videoWidth: number
  videoHeight: number
  numFrames: number
  points: Record<string, Point2D[]>  // pointId → positions per frame (video coords)
  visibility?: Record<string, number[]>  // pointId → score [0,1] par frame (absent = ancien serveur)
  elapsedMs: number                  // total wall-clock time côté client (warmup → fin tracking)
  serverInferenceMs?: number         // temps inférence côté serveur (somme des appels)
  resolutionUsed: CoTrackerResolution
  interpShapeUsed?: [number, number] // résolution interne réellement utilisée par le modèle (h, w)
  subsampleUsed?: number             // frame subsample appliqué côté serveur (1 = aucun)
  engineUsed?: CoTrackerEngine       // moteur CoTracker utilisé ('offline' = full-video, 'online' = sliding window)
}

interface ServerResponse {
  videoWidth: number
  videoHeight: number
  numFrames: number
  points: Record<string, [number, number][]>  // pointId → [[x,y], ...] per frame
  visibility?: Record<string, number[]>       // pointId → [v, ...] per frame, v ∈ [0,1]
  executionTimeMs?: number
  interpShapeUsed?: [number, number]
  resolutionUsed?: string
  subsampleUsed?: number
  engineUsed?: CoTrackerEngine
  error?: string
}

export async function requestCoTracker(
  videoBlob: Blob,
  points: CoTrackerPoint[],
  options?: {
    timeoutMs?: number
    onPhase?: (phase: CoTrackerPhase) => void
    resolution?: CoTrackerResolution
    subsample?: number  // 1 = toutes les frames (défaut), 2 = 1 sur 2 (12fps depuis 24fps)
    engine?: CoTrackerEngine  // 'offline' (défaut, full-video) ou 'online' (sliding window, ~×2 plus rapide)
  },
): Promise<CoTrackerResult> {
  const timeoutMs = options?.timeoutMs ?? 600_000
  const onPhase = options?.onPhase
  const resolution: CoTrackerResolution = options?.resolution ?? 'native'
  const subsample = Math.max(1, Math.floor(options?.subsample ?? 1))
  const engine: CoTrackerEngine = options?.engine ?? 'offline'
  const t0Wall = performance.now()

  if (points.length === 0) throw new Error('Aucun point à tracker')
  if (videoBlob.size > 50 * 1024 * 1024) {
    throw new Error(`Vidéo trop lourde (${(videoBlob.size / 1024 / 1024).toFixed(1)} MB, max 50 MB)`)
  }
  for (const p of points) {
    if (p.prompts.length === 0) throw new Error(`Point ${p.name ?? p.id.slice(0, 6)} sans prompt`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    onPhase?.('warmup')
    console.log('[CoTracker] Warmup GET', COTRACKER_FUNCTION_URL)
    const warmupRes = await fetch(COTRACKER_FUNCTION_URL, { method: 'GET', signal: controller.signal })
    console.log(`[CoTracker] Warmup status: ${warmupRes.status}`)

    onPhase?.('uploading')
    const videoDims = await readVideoDimensions(videoBlob)
    const rawFrames = await readVideoFrameCount(videoBlob)
    // Cloud Function caps at MAX_FRAMES = 300 (cotracker/_common.py) but OOMs on
    // 960×960 video around that limit. Clamp to 150 to stay under the 16 GB RAM budget
    // (video tensor float32 = W×H×T×3×4 bytes + model + buffers).
    const SERVER_MAX_FRAMES = 150
    const totalFrames = Math.min(rawFrames, SERVER_MAX_FRAMES)
    if (rawFrames > SERVER_MAX_FRAMES) {
      console.warn(`[CoTracker] Vidéo ${rawFrames} frames > limite serveur ${SERVER_MAX_FRAMES}, tracking limité aux ${SERVER_MAX_FRAMES} premières frames (${(SERVER_MAX_FRAMES / 24).toFixed(1)}s)`)
    }
    const videoB64 = await blobToBase64(videoBlob)
    console.log(`[CoTracker] Video ${videoDims.width}x${videoDims.height}, ~${totalFrames} frames (raw ${rawFrames}), payload ~${(videoB64.length / 1024 / 1024).toFixed(2)} MB`)

    // Flatten all prompts (multi-frame supported natively by CoTracker3) into a single
    // `queries` array. Each query is (pointId, frameIdx, x, y) — the server averages
    // trajectories per pointId across queries.
    const queries: { pointId: string; frameIdx: number; x: number; y: number }[] = []
    for (const pt of points) {
      for (const pr of pt.prompts) {
        queries.push({ pointId: pt.id, frameIdx: pr.frameIdx, x: pr.x, y: pr.y })
      }
    }
    console.log(`[CoTracker] ${points.length} points, ${queries.length} queries (multi-frame supported)`)

    onPhase?.('tracking')

    const allTrajectories: Record<string, Point2D[]> = {}
    let outWidth = videoDims.width
    let outHeight = videoDims.height
    let outFrames = totalFrames
    let serverInferenceMs = 0
    let interpShapeUsed: [number, number] | undefined
    let subsampleUsed: number | undefined
    let engineUsed: CoTrackerEngine | undefined

    const t0 = performance.now()
    const response = await fetch(COTRACKER_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video: videoB64, queries, resolution, subsample, engine }),
      signal: controller.signal,
    })
    const callMs = performance.now() - t0
    console.log(`[CoTracker] resolution=${resolution} ${queries.length} queries → HTTP ${response.status} in ${(callMs / 1000).toFixed(1)}s`)

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${response.status}`)
    }
    const data = (await response.json()) as ServerResponse
    if (!data.points) throw new Error('Réponse sans champ points')

    outWidth = data.videoWidth ?? outWidth
    outHeight = data.videoHeight ?? outHeight
    outFrames = data.numFrames ?? totalFrames
    if (typeof data.executionTimeMs === 'number') serverInferenceMs = data.executionTimeMs
    if (Array.isArray(data.interpShapeUsed) && data.interpShapeUsed.length === 2) {
      interpShapeUsed = [data.interpShapeUsed[0], data.interpShapeUsed[1]]
    }
    if (typeof data.subsampleUsed === 'number') subsampleUsed = data.subsampleUsed
    if (data.engineUsed === 'offline' || data.engineUsed === 'online') engineUsed = data.engineUsed

    const allVisibility: Record<string, number[]> = {}
    for (const pt of points) {
      const traj = data.points[pt.id]
      if (!traj) {
        console.warn(`[CoTracker] Trajectoire manquante pour point ${pt.id}`)
        continue
      }
      allTrajectories[pt.id] = traj.map(([x, y]) => ({ x, y }))
      const vis = data.visibility?.[pt.id]
      if (Array.isArray(vis)) allVisibility[pt.id] = vis.map(v => Number(v))
    }
    const hasVisibility = Object.keys(allVisibility).length > 0

    const elapsedMs = performance.now() - t0Wall
    console.log(
      `[CoTracker] ✓ ${resolution} terminé en ${(elapsedMs / 1000).toFixed(2)}s (wall) · inférence serveur ${(serverInferenceMs / 1000).toFixed(2)}s` +
      (interpShapeUsed ? ` · interp_shape ${interpShapeUsed[0]}×${interpShapeUsed[1]}` : ''),
    )

    return {
      videoWidth: outWidth,
      videoHeight: outHeight,
      numFrames: outFrames,
      points: allTrajectories,
      visibility: hasVisibility ? allVisibility : undefined,
      elapsedMs,
      serverInferenceMs: serverInferenceMs > 0 ? serverInferenceMs : undefined,
      resolutionUsed: resolution,
      interpShapeUsed,
      subsampleUsed,
      engineUsed,
    }
  } finally {
    clearTimeout(timer)
  }
}

function readVideoDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const w = video.videoWidth, h = video.videoHeight
      URL.revokeObjectURL(url)
      if (!w || !h) reject(new Error('Failed to read video dimensions'))
      else resolve({ width: w, height: h })
    }
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load video metadata')) }
    video.src = url
  })
}

function readVideoFrameCount(blob: Blob): Promise<number> {
  // 24 FPS hardcoded across the project
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const d = video.duration
      URL.revokeObjectURL(url)
      if (!Number.isFinite(d)) reject(new Error('Failed to read video duration'))
      else resolve(Math.max(1, Math.floor(d * 24)))
    }
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load video metadata')) }
    video.src = url
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(new Error('Failed to encode video as base64'))
    reader.readAsDataURL(blob)
  })
}
