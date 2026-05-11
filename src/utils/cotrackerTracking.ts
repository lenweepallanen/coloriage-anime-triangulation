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

export interface CoTrackerResult {
  videoWidth: number
  videoHeight: number
  numFrames: number
  points: Record<string, Point2D[]>  // pointId → positions per frame (video coords)
}

interface ServerResponse {
  startFrame: number
  endFrame: number
  videoWidth: number
  videoHeight: number
  tracks: { x: number; y: number }[][]  // tracks[frame][pointIdx]
  error?: string
}

export async function requestCoTracker(
  videoBlob: Blob,
  points: CoTrackerPoint[],
  options?: { timeoutMs?: number; onPhase?: (phase: CoTrackerPhase) => void },
): Promise<CoTrackerResult> {
  const timeoutMs = options?.timeoutMs ?? 600_000
  const onPhase = options?.onPhase

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
    const totalFrames = await readVideoFrameCount(videoBlob)
    const videoB64 = await blobToBase64(videoBlob)
    console.log(`[CoTracker] Video ${videoDims.width}x${videoDims.height}, ~${totalFrames} frames, payload ~${(videoB64.length / 1024 / 1024).toFixed(2)} MB`)

    // Group points by their FIRST prompt's frameIdx (1 API call per group)
    const groups = new Map<number, CoTrackerPoint[]>()
    for (const pt of points) {
      const fr = pt.prompts[0].frameIdx
      if (!groups.has(fr)) groups.set(fr, [])
      groups.get(fr)!.push(pt)
    }
    console.log(`[CoTracker] ${groups.size} groupe(s) de queryFrame → ${points.length} points`)

    onPhase?.('tracking')

    const allTrajectories: Record<string, Point2D[]> = {}
    let outWidth = videoDims.width
    let outHeight = videoDims.height
    let outFrames = totalFrames

    for (const [queryFrame, group] of groups) {
      const queryPoints = group.map(pt => {
        const q = pt.prompts.find(qq => qq.frameIdx === queryFrame) ?? pt.prompts[0]
        return { x: q.x, y: q.y }
      })
      const t0 = performance.now()
      const response = await fetch(COTRACKER_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video: videoB64,
          queryFrame,
          queryPoints,
          startFrame: 0,
          endFrame: Math.max(0, totalFrames - 1),
        }),
        signal: controller.signal,
      })
      console.log(`[CoTracker] queryFrame=${queryFrame}, ${group.length} pts → HTTP ${response.status} in ${((performance.now() - t0) / 1000).toFixed(1)}s`)

      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      const data = (await response.json()) as ServerResponse
      if (!data.tracks) throw new Error('Réponse sans champ tracks')

      outWidth = data.videoWidth ?? outWidth
      outHeight = data.videoHeight ?? outHeight
      outFrames = data.tracks.length

      // tracks[frame][pointIdx] → per-point trajectory
      group.forEach((pt, idx) => {
        allTrajectories[pt.id] = data.tracks.map(f => ({ x: f[idx].x, y: f[idx].y }))
      })
    }

    return {
      videoWidth: outWidth,
      videoHeight: outHeight,
      numFrames: outFrames,
      points: allTrajectories,
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
