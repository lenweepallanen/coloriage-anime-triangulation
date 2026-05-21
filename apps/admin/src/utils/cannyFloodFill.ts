import type { Point2D } from '../types/project'
import { orderContourPixels } from './curvilinearContour'

/**
 * Flood-fill 8-connexe sur la grille de pixels Canny.
 *
 * Les pixels Canny sont supposés discrets (coordonnées entières en pixels image
 * de référence). On part d'un pixel seed (déjà snappé sur le contour Canny),
 * et on collecte tous les pixels Canny atteignables en sautant de voisin à
 * voisin dans une fenêtre 3×3.
 *
 * Retourne le polygone fermé ordonné via `orderContourPixels` (chaînage
 * nearest-neighbor avec grille spatiale 4 px) — directement utilisable comme
 * `contourParts[i]` d'un accessoire.
 */
export function floodFillCannyComponent(
  seedPixel: Point2D,
  cannyPixels: Point2D[],
  maxPixels = 50000,
): Point2D[] {
  if (cannyPixels.length === 0) return []

  // Carte index pixel-clé → index dans `cannyPixels`.
  const pixelMap = new Map<string, number>()
  for (let i = 0; i < cannyPixels.length; i++) {
    const px = Math.round(cannyPixels[i].x)
    const py = Math.round(cannyPixels[i].y)
    const key = `${px},${py}`
    if (!pixelMap.has(key)) pixelMap.set(key, i)
  }

  // Snap seed au pixel le plus proche en distance L∞ ≤ 4 px (filet de sécurité).
  let seedIdx = -1
  const sx = Math.round(seedPixel.x)
  const sy = Math.round(seedPixel.y)
  outer: for (let r = 0; r <= 4 && seedIdx === -1; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const k = `${sx + dx},${sy + dy}`
        const idx = pixelMap.get(k)
        if (idx !== undefined) {
          seedIdx = idx
          break outer
        }
      }
    }
  }
  if (seedIdx === -1) return []

  const visited = new Set<number>()
  visited.add(seedIdx)
  const queue: number[] = [seedIdx]
  const collected: Point2D[] = []

  while (queue.length > 0 && collected.length < maxPixels) {
    const idx = queue.shift()!
    const p = cannyPixels[idx]
    collected.push(p)
    const px = Math.round(p.x)
    const py = Math.round(p.y)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        const k = `${px + dx},${py + dy}`
        const nIdx = pixelMap.get(k)
        if (nIdx !== undefined && !visited.has(nIdx)) {
          visited.add(nIdx)
          queue.push(nIdx)
        }
      }
    }
  }

  return orderContourPixels(collected)
}
