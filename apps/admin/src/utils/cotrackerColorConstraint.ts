/**
 * Contrainte couleur pour le tracking CoTracker3.
 *
 * Quand chaque membre du personnage a une couleur distincte, on peut détecter les
 * dérives que la visibilité CoTracker ne voit pas : un point qui glisse vers une
 * zone voisine (autre couleur) pendant une occlusion reste "confiant" pour le
 * modèle, mais la couleur sous le point ne correspond plus à sa couleur de
 * référence (frame 0). On produit alors une pseudo-visibilité 0/1 par point par
 * frame, combinable avec la visibilité CoTracker (min), qui alimente le mécanisme
 * d'interpolation d'occlusion existant.
 *
 * Tout tourne en local dans le navigateur (extraction frames 24 fps, comme les
 * autres étapes du pipeline).
 */

import type { Point2D } from '../types/project'

export interface ColorConstraintOptions {
  /** Rayon du patch d'échantillonnage (2 → 5×5 px). */
  patchRadius?: number
  /** Distance RGB euclidienne max vs la couleur de référence avant mismatch. */
  colorThreshold?: number
  /** Nb de frames consécutives hors couleur pour déclarer l'occlusion (anti-clignotement). */
  minConsecutive?: number
  fps?: number
}

const DEFAULTS: Required<ColorConstraintOptions> = {
  patchRadius: 2,
  colorThreshold: 60,
  minConsecutive: 3,
  fps: 24,
}

type RGB = [number, number, number]

/** Couleur dominante d'un patch : médiane des pixels non-noirs (les contours noirs
 * du dessin sont ignorés). Si le patch est presque entièrement noir, médiane de tout. */
function samplePatchColor(img: ImageData, cx: number, cy: number, radius: number): RGB | null {
  const { width, height, data } = img
  const x0 = Math.max(0, Math.round(cx) - radius)
  const x1 = Math.min(width - 1, Math.round(cx) + radius)
  const y0 = Math.max(0, Math.round(cy) - radius)
  const y1 = Math.min(height - 1, Math.round(cy) + radius)
  if (x1 < x0 || y1 < y0) return null

  const colored: RGB[] = []
  const all: RGB[] = []
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4
      const px: RGB = [data[i], data[i + 1], data[i + 2]]
      all.push(px)
      // "noir contour" : tous les canaux sombres
      if (!(px[0] < 70 && px[1] < 70 && px[2] < 70)) colored.push(px)
    }
  }
  const pool = colored.length >= all.length * 0.3 ? colored : all
  if (pool.length === 0) return null
  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  return [median(pool.map(p => p[0])), median(pool.map(p => p[1])), median(pool.map(p => p[2]))]
}

function colorDist(a: RGB, b: RGB): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

/**
 * Calcule une pseudo-visibilité 0/1 par point par frame : 0 quand la couleur sous
 * la position trackée ne correspond plus à la couleur de référence du point
 * (échantillonnée à la frame 0) pendant ≥ minConsecutive frames consécutives.
 *
 * @param tracks positions trackées brutes, en COORDS VIDÉO ([pointId][frame])
 */
export async function computeColorConstraintVisibility(
  videoBlob: Blob,
  tracks: Record<string, Point2D[]>,
  onProgress?: (fraction: number) => void,
  options?: ColorConstraintOptions,
): Promise<Record<string, number[]>> {
  const opts = { ...DEFAULTS, ...options }
  const pids = Object.keys(tracks)
  const numFrames = Math.max(0, ...pids.map(pid => tracks[pid].length))
  if (pids.length === 0 || numFrames === 0) return {}

  const url = URL.createObjectURL(videoBlob)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = url

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Impossible de charger la vidéo pour la contrainte couleur'))
    })

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas 2D indisponible')

    const seekTo = (f: number) => new Promise<void>((resolve, reject) => {
      const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve() }
      video.addEventListener('seeked', onSeeked)
      video.onerror = () => reject(new Error('Erreur de seek vidéo'))
      video.currentTime = Math.min(f / opts.fps + 0.001, Math.max(0, video.duration - 0.001))
    })

    // mismatch[pid][f] = true si la couleur sous le point ne matche plus la référence
    const mismatch: Record<string, boolean[]> = {}
    const refColors: Record<string, RGB | null> = {}
    for (const pid of pids) mismatch[pid] = new Array(tracks[pid].length).fill(false)

    for (let f = 0; f < numFrames; f++) {
      await seekTo(f)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)

      for (const pid of pids) {
        const pos = tracks[pid][f]
        if (!pos) continue
        const color = samplePatchColor(img, pos.x, pos.y, opts.patchRadius)
        if (f === 0) {
          // Référence : couleur du membre sous le point à la frame 0
          refColors[pid] = color
          continue
        }
        const ref = refColors[pid]
        if (!ref || !color) continue // pas de référence fiable → pas de contrainte
        mismatch[pid][f] = colorDist(color, ref) > opts.colorThreshold
      }
      onProgress?.((f + 1) / numFrames)
    }

    // Anti-clignotement : seules les plages de ≥ minConsecutive frames hors couleur
    // deviennent invisibles (vis 0). Les mismatches isolés (bruit compression) sont ignorés.
    const visibility: Record<string, number[]> = {}
    for (const pid of pids) {
      const n = tracks[pid].length
      const vis = new Array<number>(n).fill(1)
      let runStart = -1
      for (let f = 0; f <= n; f++) {
        const m = f < n ? mismatch[pid][f] : false
        if (m) {
          if (runStart < 0) runStart = f
        } else if (runStart >= 0) {
          if (f - runStart >= opts.minConsecutive) {
            for (let k = runStart; k < f; k++) vis[k] = 0
          }
          runStart = -1
        }
      }
      visibility[pid] = vis
    }
    return visibility
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Combine deux signaux de visibilité par min (occlus si l'un des deux le dit). */
export function combineVisibility(
  a: Record<string, number[]> | null | undefined,
  b: Record<string, number[]> | null | undefined,
): Record<string, number[]> | null {
  if (!a) return b ?? null
  if (!b) return a
  const out: Record<string, number[]> = {}
  const pids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const pid of pids) {
    const va = a[pid]
    const vb = b[pid]
    if (!va) { out[pid] = vb; continue }
    if (!vb) { out[pid] = va; continue }
    const n = Math.max(va.length, vb.length)
    const v = new Array<number>(n)
    for (let f = 0; f < n; f++) v[f] = Math.min(va[f] ?? 1, vb[f] ?? 1)
    out[pid] = v
  }
  return out
}
