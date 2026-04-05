/**
 * LaMa Inpainting Client — Calls the Cloud Function to inpaint
 * limb areas on the scanned coloring page using LaMa.
 */

// Cloud Function URL — deployed on coloriage-anime-prod (europe-west1)
const LAMA_FUNCTION_URL = import.meta.env.VITE_LAMA_FUNCTION_URL
  || 'https://lama-inpaint-6gzhik6pka-ew.a.run.app'

// LaMa works well at 512px — smaller = faster inference, upscaled back after
const MAX_LAMA_DIM = 512

export type LamaPhase = 'warmup' | 'inpainting'

/**
 * Send scan image + mask to the LaMa Cloud Function and return the inpainted canvas.
 * Images are downscaled to 1024px max for the API call, then upscaled back.
 *
 * Two-step process:
 * 1. GET ping to warm up the instance (triggers cold start if needed)
 * 2. POST with the actual image + mask for inpainting
 */
export async function requestLamaInpainting(
  scanCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  options?: { timeoutMs?: number; onPhase?: (phase: LamaPhase) => void },
): Promise<HTMLCanvasElement> {
  const timeoutMs = options?.timeoutMs ?? 120_000
  const onPhase = options?.onPhase
  const origW = scanCanvas.width
  const origH = scanCanvas.height

  // Step 1: Warm up the instance (cold start happens here)
  onPhase?.('warmup')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    await fetch(LAMA_FUNCTION_URL, { method: 'GET', signal: controller.signal })

    // Step 2: Actual inpainting
    onPhase?.('inpainting')

    // Downscale to MAX_LAMA_DIM for smaller payload and faster inference
    const ratio = Math.min(MAX_LAMA_DIM / origW, MAX_LAMA_DIM / origH, 1)
    const scaledW = Math.round(origW * ratio)
    const scaledH = Math.round(origH * ratio)
    const sendImage = ratio < 1 ? downscaleCanvas(scanCanvas, scaledW, scaledH) : scanCanvas
    const sendMask = ratio < 1 ? downscaleCanvas(maskCanvas, scaledW, scaledH) : maskCanvas

    // Encode as JPEG for image (much smaller), PNG for mask (needs lossless)
    const imageB64 = canvasToBase64(sendImage, 'image/jpeg', 0.85)
    const maskB64 = canvasToBase64(sendMask, 'image/png')

    const response = await fetch(LAMA_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageB64, mask: maskB64 }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${response.status}`)
    }

    const data = await response.json()
    if (!data.inpainted) {
      throw new Error('Response missing inpainted field')
    }

    // Decode and upscale back to original dimensions
    return await base64ToCanvas(data.inpainted, origW, origH)
  } finally {
    clearTimeout(timer)
  }
}

function downscaleCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(src, 0, 0, w, h)
  return c
}

function canvasToBase64(canvas: HTMLCanvasElement, mimeType: string, quality?: number): string {
  const dataUrl = quality != null
    ? canvas.toDataURL(mimeType, quality)
    : canvas.toDataURL(mimeType)
  // Strip "data:<mime>;base64," prefix
  return dataUrl.split(',')[1]
}

function base64ToCanvas(b64: string, width: number, height: number): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0, width, height)
      resolve(canvas)
    }
    img.onerror = () => reject(new Error('Failed to decode LaMa inpainted image'))
    img.src = `data:image/jpeg;base64,${b64}`
  })
}
