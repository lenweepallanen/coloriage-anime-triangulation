/**
 * SAM 2 Segmentation Client — Calls the Cloud Function (Python + SAM 2 Hiera Tiny)
 * to segment body + 4 leg zones across all video frames for the `members-bones`
 * animation pipeline (étape "Définir Zones").
 *
 * Pattern mirrors cotrackerTracking.ts:
 * 1. GET ping to warm up (cold start triggered here)
 * 2. POST { video, zones[] } → { masks: { zoneId: RLEMask[] }, videoWidth, videoHeight, numFrames }
 */

import type { SAM2Zone, SAM2Prompt, RLEMask } from '../types/project'

// Cloud Function URL — deployed on coloriage-anime-prod (europe-west1)
const SAM2_FUNCTION_URL = import.meta.env.VITE_SAM2_FUNCTION_URL
  || 'https://sam2-segment-vasshazrla-ew.a.run.app'

export type SAM2Phase = 'warmup' | 'uploading' | 'segmenting'

export interface SAM2Result {
  videoWidth: number
  videoHeight: number
  numFrames: number
  masks: Record<string, RLEMask[]>
}

interface ServerResponse {
  videoWidth: number
  videoHeight: number
  numFrames: number
  masks: Record<string, RLEMask[]>
  error?: string
}

/**
 * Segment a video into per-frame masks using SAM 2 video predictor.
 *
 * @param videoBlob       Source video (MP4/WebM blob)
 * @param zones           Zone definitions (id + label + color)
 * @param prompts         All prompts across all zones (filtered by zoneId server-side)
 * @param imageWidth      Image coordinate space width (for prompt conversion)
 * @param imageHeight     Image coordinate space height
 * @param options         Optional timeout (ms) and onPhase callback
 */
export async function requestSam2Segmentation(
  videoBlob: Blob,
  zones: SAM2Zone[],
  prompts: SAM2Prompt[],
  imageWidth: number,
  imageHeight: number,
  options?: { timeoutMs?: number; onPhase?: (phase: SAM2Phase) => void; videoDimensions?: { width: number; height: number } }
): Promise<SAM2Result> {
  const timeoutMs = options?.timeoutMs ?? 600_000  // 10 min default (cold start)
  const onPhase = options?.onPhase

  if (zones.length === 0) {
    throw new Error('zones is empty')
  }
  if (prompts.length === 0) {
    throw new Error('prompts is empty')
  }
  if (videoBlob.size > 50 * 1024 * 1024) {
    throw new Error(`Vidéo trop lourde (${(videoBlob.size / 1024 / 1024).toFixed(1)} MB, max 50 MB)`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    // Step 1: warm up
    onPhase?.('warmup')
    console.log('[SAM2] Warmup GET', SAM2_FUNCTION_URL)
    const warmupRes = await fetch(SAM2_FUNCTION_URL, { method: 'GET', signal: controller.signal })
    console.log(`[SAM2] Warmup status: ${warmupRes.status}`)

    // Step 2: read video dimensions for image↔video coord conversion
    onPhase?.('uploading')
    const videoDims = options?.videoDimensions ?? await readVideoDimensions(videoBlob)
    console.log(`[SAM2] Video dims: ${videoDims.width}x${videoDims.height}`)

    // Convert prompts from image coords → video pixel coords
    const promptsByZone: Record<string, { x: number; y: number; label: number }[]> = {}
    for (const z of zones) promptsByZone[z.id] = []
    for (const p of prompts) {
      if (!promptsByZone[p.zoneId]) promptsByZone[p.zoneId] = []
      promptsByZone[p.zoneId].push({
        x: (p.x / imageWidth) * videoDims.width,
        y: (p.y / imageHeight) * videoDims.height,
        label: p.label,
      })
    }

    // Build zones payload, skip empty zones
    const zonesPayload = zones
      .filter(z => promptsByZone[z.id] && promptsByZone[z.id].length > 0)
      .map(z => ({
        id: z.id,
        prompts: promptsByZone[z.id],
      }))

    if (zonesPayload.length === 0) {
      throw new Error('Aucune zone n\'a de prompt — placez au moins un point par zone.')
    }

    // Encode video as base64
    const videoB64 = await blobToBase64(videoBlob)
    console.log(`[SAM2] Payload: ${zonesPayload.length} zones, video ~${(videoB64.length / 1024 / 1024).toFixed(2)} MB base64`)

    // Step 3: POST to the function
    onPhase?.('segmenting')
    console.log(`[SAM2] POST segmenting`)
    const t0 = performance.now()
    const response = await fetch(SAM2_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video: videoB64,
        zones: zonesPayload,
      }),
      signal: controller.signal,
    })
    console.log(`[SAM2] POST returned ${response.status} after ${((performance.now() - t0) / 1000).toFixed(1)}s`)

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${response.status}`)
    }

    const data = (await response.json()) as ServerResponse
    if (!data.masks) {
      throw new Error('Response missing masks field')
    }

    return {
      videoWidth: data.videoWidth,
      videoHeight: data.videoHeight,
      numFrames: data.numFrames,
      masks: data.masks,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Read video width/height by attaching the blob to a temporary <video> element. */
function readVideoDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const video = document.createElement('video')
    video.muted = true
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      const w = video.videoWidth
      const h = video.videoHeight
      URL.revokeObjectURL(url)
      if (w === 0 || h === 0) {
        reject(new Error('Failed to read video dimensions (zero size)'))
      } else {
        resolve({ width: w, height: h })
      }
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load video metadata'))
    }
    video.src = url
  })
}

/** Encode a Blob as a base64 string (no data URL prefix). */
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

/**
 * Encode a static image (PNG/JPEG) as a short 1-frame WebM video.
 * This allows reusing the SAM 2 video segmentation endpoint on a single image.
 */
export async function encodePngAsFakeMp4(imageBlob: Blob): Promise<Blob> {
  // Load image into a canvas
  const img = await createImageBitmap(imageBlob)
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)

  // Choose a supported mimeType
  const mimeTypes = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m))
  if (!mimeType) {
    throw new Error('MediaRecorder: aucun codec vidéo supporté (WebM VP8/VP9)')
  }

  // Capture stream at 25 FPS (automatic frames, more robust than manual requestFrame)
  const stream = canvas.captureStream(25)
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 })

  return new Promise<Blob>((resolve, reject) => {
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    recorder.onstop = () => {
      if (chunks.length === 0) {
        reject(new Error('MediaRecorder: aucune donnée capturée'))
        return
      }
      resolve(new Blob(chunks, { type: mimeType }))
    }
    recorder.onerror = () => reject(new Error('MediaRecorder: erreur d\'encodage'))

    recorder.start()

    // Record ~300ms (~7 frames at 25 FPS) to ensure a valid WebM container
    setTimeout(() => {
      recorder.stop()
      stream.getTracks().forEach(t => t.stop())
    }, 300)
  })
}
