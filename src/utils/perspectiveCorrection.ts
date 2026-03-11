/**
 * Correction de perspective via Web Worker (ne gèle pas l'UI)
 * + détection temps réel pour le preview caméra
 */

import type { Point2D } from '../types/project'

export interface ProcessResult {
  imageData: ImageData
  corrected: boolean
  strategy: string | null
  detectedCorners: Point2D[] | null
  debug: Record<string, unknown>
  originalSize: { width: number; height: number }
}

let worker: Worker | null = null
let workerReady = false
let loadingPromise: Promise<void> | null = null
let detectCallback: ((corners: Point2D[] | null) => void) | null = null
let processCallback: ((msg: { ok: true; data: any } | { ok: false; error: string }) => void) | null = null

function workerMessageHandler(e: MessageEvent) {
  const { type } = e.data

  if (type === 'detect-result') {
    if (detectCallback) detectCallback(e.data.corners)
    return
  }

  if (type === 'result') {
    if (processCallback) processCallback({ ok: true, data: e.data })
    return
  }

  if (type === 'error') {
    if (processCallback) processCallback({ ok: false, error: e.data.error })
    return
  }
}

/**
 * Charge OpenCV dans le worker. Retourne une promesse résolue quand prêt.
 * Peut être appelé plusieurs fois (singleton).
 */
export function loadOpenCVWorker(): Promise<void> {
  if (workerReady) return Promise.resolve()
  if (loadingPromise) return loadingPromise

  loadingPromise = new Promise<void>((resolve, reject) => {
    worker = new Worker('/opencv-worker.js')

    const timeout = setTimeout(() => {
      loadingPromise = null
      reject(new Error('Timeout chargement OpenCV (30s)'))
    }, 30000)

    worker.onerror = (event) => {
      clearTimeout(timeout)
      loadingPromise = null
      reject(new Error('Worker failed to load: ' + (event.message || 'unknown error')))
    }

    worker.onmessage = (e) => {
      if (e.data.type === 'ready') {
        clearTimeout(timeout)
        workerReady = true
        worker!.onmessage = workerMessageHandler
        resolve()
      } else if (e.data.type === 'error') {
        clearTimeout(timeout)
        loadingPromise = null
        reject(new Error(e.data.error))
      }
    }

    worker.postMessage({ type: 'init' })
  }).catch(err => {
    loadingPromise = null
    throw err
  })

  return loadingPromise
}

// --- Optical flow via worker ---

function workerRpc(msg: any, responseType: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      if (e.data.type === responseType) {
        worker!.removeEventListener('message', handler)
        worker!.onmessage = workerMessageHandler
        resolve(e.data)
      } else if (e.data.type === 'flow-error') {
        worker!.removeEventListener('message', handler)
        worker!.onmessage = workerMessageHandler
        reject(new Error(e.data.error))
      }
    }
    worker!.onmessage = handler
    worker!.postMessage(msg)
  })
}

export async function flowInit(points: { x: number; y: number }[]): Promise<void> {
  if (!workerReady) await loadOpenCVWorker()
  await workerRpc({ type: 'flow-init', points }, 'flow-init-done')
}

export interface ContourMatchResult {
  lkPos: { x: number; y: number }
  tmPos: { x: number; y: number }
  tmScore: number
}

export interface FlowFrameResult {
  points: { x: number; y: number }[]
  contourMatches?: ContourMatchResult[]
}

export async function flowProcessFrame(imageData: ImageData): Promise<FlowFrameResult> {
  if (!workerReady) await loadOpenCVWorker()
  const result = await workerRpc({
    type: 'flow-frame',
    imageData: { data: imageData.data, width: imageData.width, height: imageData.height }
  }, 'flow-frame-result')
  return { points: result.points, contourMatches: result.contourMatches || undefined }
}

export async function flowUpdatePoints(points: { x: number; y: number }[]): Promise<void> {
  if (!workerReady || !worker) return
  await workerRpc({ type: 'flow-update-points', points }, 'flow-update-points-done')
}

export async function flowInitTemplates(
  contourAnchorIndices: number[],
  templateSize?: number
): Promise<void> {
  if (!workerReady) await loadOpenCVWorker()
  await workerRpc({
    type: 'flow-init-templates',
    contourAnchorIndices,
    templateSize: templateSize ?? 31
  }, 'flow-init-templates-done')
}

export async function flowExtractContourDense(imageData: ImageData): Promise<{ x: number; y: number }[] | null> {
  if (!workerReady) await loadOpenCVWorker()
  const result = await workerRpc({
    type: 'flow-contour-dense',
    imageData: { data: imageData.data, width: imageData.width, height: imageData.height }
  }, 'flow-contour-dense-result')
  return result.contourPoints || null
}

export async function flowCleanup(): Promise<void> {
  if (!workerReady || !worker) return
  await workerRpc({ type: 'flow-cleanup' }, 'flow-cleanup-done')
}

// --- Détection de contour (pour la triangulation auto) ---

export async function detectContourViaWorker(
  imageData: ImageData,
  density: number
): Promise<{ x: number; y: number }[] | null> {
  if (!workerReady) await loadOpenCVWorker()

  return new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'contour-result') {
        worker!.removeEventListener('message', handler)
        worker!.onmessage = workerMessageHandler
        resolve(e.data.points || null)
      }
    }
    worker!.onmessage = handler
    worker!.postMessage({
      type: 'contour',
      imageData: { data: imageData.data, width: imageData.width, height: imageData.height },
      density
    })
  })
}

// --- Détection temps réel (pour le preview caméra) ---

export function setDetectCallback(cb: ((corners: Point2D[] | null) => void) | null): void {
  detectCallback = cb
}

export function detectFrame(imageData: ImageData): boolean {
  if (!workerReady || !worker) return false
  worker.postMessage({
    type: 'detect',
    imageData: {
      data: imageData.data,
      width: imageData.width,
      height: imageData.height
    }
  })
  return true
}

// --- Traitement complet de l'image capturée ---

/**
 * Traite l'image capturée : détecte les coins et applique la correction perspective.
 * @param blob - Image capturée
 * @param predetectedCorners - Coins pré-détectés (optionnel)
 * @returns Image 2048x2048 corrigée
 */
export async function processCapturedImage(
  blob: Blob,
  predetectedCorners?: Point2D[] | null
): Promise<ProcessResult> {
  if (!workerReady) await loadOpenCVWorker()

  const imageData = await blobToImageData(blob)
  console.log(`Image: ${imageData.width}x${imageData.height}px`)

  return new Promise((resolve, reject) => {
    processCallback = (msg) => {
      processCallback = null

      if (!msg.ok) {
        reject(new Error(msg.error))
        return
      }

      const e = msg.data
      const { data, width, height } = e.imageData
      const corrected: boolean = e.corrected
      const strategy: string | null = e.strategy || null

      console.log(corrected
        ? `Coins détectés (${strategy}), perspective corrigée`
        : 'Coins non détectés, fallback crop')

      let resultImageData: ImageData
      if (corrected) {
        resultImageData = new ImageData(new Uint8ClampedArray(data), width, height)
      } else {
        // Fallback: crop carré au centre
        console.warn('Fallback: crop carré au centre')
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = imageData.width
        tempCanvas.height = imageData.height
        tempCanvas.getContext('2d')!.putImageData(imageData, 0, 0)

        const size = Math.min(imageData.width, imageData.height)
        const offsetX = Math.floor((imageData.width - size) / 2)
        const offsetY = Math.floor((imageData.height - size) / 2)

        const canvas = document.createElement('canvas')
        canvas.width = 2048
        canvas.height = 2048
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(tempCanvas, offsetX, offsetY, size, size, 0, 0, 2048, 2048)
        resultImageData = ctx.getImageData(0, 0, 2048, 2048)
      }

      resolve({
        imageData: resultImageData,
        corrected,
        strategy,
        detectedCorners: e.detectedCorners || null,
        debug: e.debug || {},
        originalSize: { width: imageData.width, height: imageData.height }
      })
    }

    const message: any = {
      type: 'process',
      imageData: {
        data: imageData.data,
        width: imageData.width,
        height: imageData.height
      }
    }

    if (predetectedCorners && predetectedCorners.length === 4) {
      message.predetectedCorners = predetectedCorners
    }

    worker!.postMessage(message)
  })
}

function blobToImageData(blob: Blob): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height))
      URL.revokeObjectURL(img.src)
    }
    img.onerror = reject
    img.src = URL.createObjectURL(blob)
  })
}
