import type { FilmBackdrop, FilmOverlay, FilmPlan, FilmPlanTransition, Point2D } from '../../../types/project'

/**
 * Helpers partagés de l'éditeur de FILM (couleurs, géométrie du chemin,
 * transitions, extraction de vignettes). Fonctions pures uniquement.
 */

export const FILM_COLORS = {
  travel: '#42a5f5',
  action: '#7e57c2',
  pause: '#9e9e9e',
  departure: '#ff9800',
  point: '#42a5f5',
  pointSelected: '#ffeb3b',
  pointOut: '#ef5350',
  controlPoint: '#ffffff',
  planSwitch: '#212121',
} as const

export const CAMERA_HANDLE_H = 18

export function formatMs(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Points de contrôle par défaut le long du segment from→to (1 = milieu, 2 = tiers). */
export function defaultControlPoints(from: Point2D, to: Point2D, count: 1 | 2): Point2D[] {
  const lerp = (t: number): Point2D => ({
    x: Math.round(from.x + (to.x - from.x) * t),
    y: Math.round(from.y + (to.y - from.y) * t),
  })
  return count === 1 ? [lerp(0.5)] : [lerp(1 / 3), lerp(2 / 3)]
}

/** Extrait la frame 0 d'une vidéo en blob URL (PNG). */
export async function extractVideoFrame0Url(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const vid = document.createElement('video')
    vid.preload = 'auto'
    vid.muted = true
    vid.src = url
    const cleanup = () => { URL.revokeObjectURL(url); vid.remove() }
    vid.onloadeddata = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = vid.videoWidth
        canvas.height = vid.videoHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) { cleanup(); reject(new Error('no ctx')); return }
        ctx.drawImage(vid, 0, 0)
        canvas.toBlob((b) => {
          cleanup()
          if (!b) { reject(new Error('toBlob null')); return }
          resolve(URL.createObjectURL(b))
        }, 'image/png')
      } catch (err) {
        cleanup()
        reject(err)
      }
    }
    vid.onerror = () => { cleanup(); reject(new Error('video load failed')) }
  })
}

/** Lit les dimensions d'un fichier image/vidéo et construit le calque de décor. */
export async function fileToDecorLayer(file: File, kind: 'backdrop'): Promise<FilmBackdrop>
export async function fileToDecorLayer(file: File, kind: 'overlay'): Promise<FilmOverlay>
export async function fileToDecorLayer(file: File, kind: 'backdrop' | 'overlay'): Promise<FilmBackdrop | FilmOverlay> {
  const blob = file as Blob
  const isVideo = file.type.startsWith('video/')
  const url = URL.createObjectURL(blob)
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve) => {
    if (isVideo) {
      const vid = document.createElement('video')
      vid.preload = 'metadata'
      vid.muted = true
      vid.src = url
      vid.onloadedmetadata = () => resolve({ width: vid.videoWidth, height: vid.videoHeight })
    } else {
      const img = new Image()
      img.src = url
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
  })
  URL.revokeObjectURL(url)
  const base: FilmBackdrop = {
    imageBlob: isVideo ? null : blob,
    videoBlob: isVideo ? blob : null,
    width,
    height,
  }
  if (kind === 'backdrop') return base
  return {
    ...base,
    chromaKeyColor: isVideo ? '#000000' : null,
    ...(isVideo && { chromaKeyThreshold: 0.1, chromaKeySmoothness: 0.12 }),
  }
}

/** Encode/décode compact d'une FilmPlanTransition pour un <select>. */
export function transitionToKey(t: FilmPlanTransition | undefined): string {
  if (!t) return 'cut'
  return t.kind === 'wipe' ? `wipe-${t.direction}` : t.kind
}

export function transitionFromKey(key: string, durationMs?: number): FilmPlanTransition {
  const dur = durationMs != null && durationMs > 0 ? { durationMs } : {}
  if (key.startsWith('wipe-')) {
    return { kind: 'wipe', direction: key.slice(5) as 'left' | 'right' | 'up' | 'down', ...dur }
  }
  if (key === 'fadeBlack' || key === 'crossfade' || key === 'iris') return { kind: key, ...dur }
  return { kind: 'cut' }
}

// --- Géométrie du chemin d'un plan (même logique que buildFilmSegments) ---

/** Largeur du cadre caméra 16:9 dans le décor du plan (même formule que le player). */
export function planFrameWidth(plan: FilmPlan): number {
  const w = plan.backdrop?.width ?? 0
  const h = plan.backdrop?.height ?? 0
  return Math.min(w, h * (16 / 9))
}

export interface PlanGeometry {
  frameLeft: number
  frameRight: number
  edgeXFor: (side: 'left' | 'right') => number
  /** Position du perso à la FIN du segment du point i (après departure éventuelle). */
  cursorAfterPoint: (i: number) => Point2D
  /** Origine résolue du trajet entrant du point i. */
  travelFrom: (i: number) => Point2D
  /** Cible résolue de la departure du point i (null si pas de departure). */
  departureTo: (i: number) => Point2D | null
}

export function planGeometry(plan: FilmPlan): PlanGeometry {
  const frameW = planFrameWidth(plan)
  const frameLeft = plan.cameraX - frameW / 2
  const frameRight = plan.cameraX + frameW / 2
  const edgeXFor = (side: 'left' | 'right') => (side === 'left' ? frameLeft : frameRight)
  const points = plan.points
  const cursorAfterPoint = (i: number): Point2D => {
    const p = points[i]
    if (p.departure) {
      const t = p.departure.target
      return t.kind === 'custom' ? { x: t.x, y: t.y } : { x: edgeXFor(t.side), y: p.y }
    }
    return { x: p.x, y: p.y }
  }
  const travelFrom = (i: number): Point2D => {
    const p = points[i]
    const o = p.travel.origin
    if (o?.kind === 'appear') return { x: p.x, y: p.y }
    if (o?.kind === 'custom') return { x: o.x, y: o.y }
    if (o?.kind === 'offscreen') return { x: edgeXFor(o.side), y: p.y }
    if (i === 0) return { x: edgeXFor(plan.entrySide), y: p.y }
    return cursorAfterPoint(i - 1)
  }
  const departureTo = (i: number): Point2D | null => {
    const p = points[i]
    if (!p.departure) return null
    const t = p.departure.target
    return t.kind === 'custom' ? { x: t.x, y: t.y } : { x: edgeXFor(t.side), y: p.y }
  }
  return { frameLeft, frameRight, edgeXFor, cursorAfterPoint, travelFrom, departureTo }
}

