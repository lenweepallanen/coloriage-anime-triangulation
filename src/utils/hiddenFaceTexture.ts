/**
 * Hidden Face Texture — Color clustering inpainting for hidden face zones.
 *
 * Paints flat-fill colors onto the scan canvas for the hidden face triangles.
 * These triangles are a subset of bodyTriangles (same bodyPoints).
 *
 * Algorithm:
 * 1. Convert body vertices to scan canvas coords (via contentAlignment)
 * 2. Rasterize the hidden face triangles into a mask on the scan canvas
 * 3. Identify border pixels (interior pixels adjacent to exterior with existing color)
 * 4. K-means clustering on border pixel colors (auto K=1..5 via silhouette score)
 * 5. BFS propagation from border pixels with cluster barriers → flat fill
 */

import type { Point2D, HiddenFaceZone } from '../types/project'
import type { ContentAlignment } from './textureExtractor'

/**
 * Paint diffused colors onto the scan canvas for a hidden face zone.
 * After this, the scan canvas contains plausible colors in the zone area.
 */
export function inpaintHiddenFaceOnScan(
  scanCanvas: HTMLCanvasElement,
  zone: HiddenFaceZone,
  bodyPoints: Point2D[],
  bodyTriangles: [number, number, number][],
  imageWidth: number,
  imageHeight: number,
  contentAlignment?: ContentAlignment,
): void {
  if (zone.bodyTriangleIndices.length === 0) return

  const scanW = scanCanvas.width
  const scanH = scanCanvas.height

  // 1. Convert body points to scan canvas pixel coords
  const scanPoints = bodyPoints.map(p => imageToScanPixel(p, imageWidth, imageHeight, scanW, scanH, contentAlignment))

  // 2. Compute bounding box of hidden face triangles in scan space
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const ti of zone.bodyTriangleIndices) {
    const tri = bodyTriangles[ti]
    if (!tri) continue
    for (const vi of tri) {
      const p = scanPoints[vi]
      if (!p) continue
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  const PAD = 6
  minX = Math.max(0, Math.floor(minX) - PAD)
  minY = Math.max(0, Math.floor(minY) - PAD)
  maxX = Math.min(scanW - 1, Math.ceil(maxX) + PAD)
  maxY = Math.min(scanH - 1, Math.ceil(maxY) + PAD)

  const w = maxX - minX + 1
  const h = maxY - minY + 1
  if (w <= 0 || h <= 0) return

  // 3. Rasterize hidden face triangles into mask
  const mask = new Uint8Array(w * h) // 0=exterior, 1=interior, 2=border
  for (const ti of zone.bodyTriangleIndices) {
    const tri = bodyTriangles[ti]
    if (!tri) continue
    const [a, b, c] = tri
    const pa = scanPoints[a], pb = scanPoints[b], pc = scanPoints[c]
    if (!pa || !pb || !pc) continue
    rasterizeTriangle(pa, pb, pc, minX, minY, w, h, mask)
  }

  // 4. Identify border pixels
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x] !== 1) continue
      const hasExterior =
        (x === 0 || mask[y * w + x - 1] === 0) ||
        (x === w - 1 || mask[y * w + x + 1] === 0) ||
        (y === 0 || mask[(y - 1) * w + x] === 0) ||
        (y === h - 1 || mask[(y + 1) * w + x] === 0)
      if (hasExterior) mask[y * w + x] = 2
    }
  }

  // 5. Read scan pixels + collect border colors
  const ctx = scanCanvas.getContext('2d')
  if (!ctx) return
  const imgData = ctx.getImageData(minX, minY, w, h)
  const pixels = imgData.data

  const borderIndices: number[] = []
  const borderColors: [number, number, number][] = []
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 2) {
      borderIndices.push(i)
      borderColors.push([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]])
    }
  }

  if (borderIndices.length === 0) return

  // 6. K-means clustering on border colors (auto K via silhouette)
  const { assignments, centroids } = autoKMeans(borderColors, 5)

  // Map border pixel index → cluster id
  const borderCluster = new Int8Array(w * h).fill(-1)
  for (let i = 0; i < borderIndices.length; i++) {
    borderCluster[borderIndices[i]] = assignments[i]
  }

  // 7. BFS propagation from border pixels with cluster barriers
  const pixelCluster = new Int8Array(w * h).fill(-1)
  // Copy border assignments
  for (let i = 0; i < borderIndices.length; i++) {
    pixelCluster[borderIndices[i]] = assignments[i]
  }

  // Detect barrier border pixels: border pixel adjacent to a border pixel of different cluster
  const barrier = new Uint8Array(w * h)
  for (const idx of borderIndices) {
    const bx = idx % w
    const by = (idx - bx) / w
    const cl = borderCluster[idx]
    const neighbors = [
      by > 0 ? idx - w : -1,
      by < h - 1 ? idx + w : -1,
      bx > 0 ? idx - 1 : -1,
      bx < w - 1 ? idx + 1 : -1,
    ]
    for (const ni of neighbors) {
      if (ni >= 0 && mask[ni] === 2 && borderCluster[ni] !== cl && borderCluster[ni] >= 0) {
        barrier[idx] = 1
        break
      }
    }
  }

  // Multi-source BFS from non-barrier border pixels
  const queue: number[] = []
  for (const idx of borderIndices) {
    if (!barrier[idx]) queue.push(idx)
  }

  let head = 0
  while (head < queue.length) {
    const idx = queue[head++]
    const cl = pixelCluster[idx]
    const bx = idx % w
    const by = (idx - bx) / w
    const neighbors = [
      by > 0 ? idx - w : -1,
      by < h - 1 ? idx + w : -1,
      bx > 0 ? idx - 1 : -1,
      bx < w - 1 ? idx + 1 : -1,
    ]
    for (const ni of neighbors) {
      if (ni >= 0 && mask[ni] === 1 && pixelCluster[ni] < 0) {
        pixelCluster[ni] = cl
        queue.push(ni)
      }
    }
  }

  // Fallback: any interior pixel not reached → nearest border pixel (by distance)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (mask[idx] !== 1 || pixelCluster[idx] >= 0) continue
      let bestDist = Infinity
      let bestCl = 0
      for (let i = 0; i < borderIndices.length; i++) {
        const bi = borderIndices[i]
        const bbx = bi % w, bby = (bi - bbx) / w
        const d = (x - bbx) * (x - bbx) + (y - bby) * (y - bby)
        if (d < bestDist) { bestDist = d; bestCl = assignments[i] }
      }
      pixelCluster[idx] = bestCl
    }
  }

  // 8. Write clustered colors
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (mask[idx] !== 1) continue
      const cl = pixelCluster[idx]
      const c = cl >= 0 ? centroids[cl] : centroids[0]
      const pIdx = idx * 4
      pixels[pIdx] = c[0]
      pixels[pIdx + 1] = c[1]
      pixels[pIdx + 2] = c[2]
      pixels[pIdx + 3] = 255
    }
  }
  ctx.putImageData(imgData, minX, minY)
}

// ─── K-means clustering ─────────────────────────────────────────────

type RGB = [number, number, number]

function distSqRGB(a: RGB, b: RGB): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

function runKMeans(
  colors: RGB[], k: number, maxIter = 20,
): { assignments: number[]; centroids: RGB[] } {
  const n = colors.length
  // K-means++ initialization
  const centroids: RGB[] = [colors[Math.floor(Math.random() * n)]]
  for (let c = 1; c < k; c++) {
    const dists = colors.map(col => Math.min(...centroids.map(cen => distSqRGB(col, cen))))
    const total = dists.reduce((s, d) => s + d, 0)
    let r = Math.random() * total
    let pick = 0
    for (let i = 0; i < n; i++) {
      r -= dists[i]
      if (r <= 0) { pick = i; break }
    }
    centroids.push(colors[pick])
  }

  const assignments = new Array<number>(n).fill(0)

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign
    let changed = false
    for (let i = 0; i < n; i++) {
      let bestD = Infinity, bestC = 0
      for (let c = 0; c < k; c++) {
        const d = distSqRGB(colors[i], centroids[c])
        if (d < bestD) { bestD = d; bestC = c }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true }
    }
    if (!changed) break

    // Update centroids
    const sums = Array.from({ length: k }, () => [0, 0, 0] as [number, number, number])
    const counts = new Array<number>(k).fill(0)
    for (let i = 0; i < n; i++) {
      const c = assignments[i]
      sums[c][0] += colors[i][0]
      sums[c][1] += colors[i][1]
      sums[c][2] += colors[i][2]
      counts[c]++
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c] = [
          Math.round(sums[c][0] / counts[c]),
          Math.round(sums[c][1] / counts[c]),
          Math.round(sums[c][2] / counts[c]),
        ]
      }
    }
  }

  return { assignments, centroids }
}

function silhouetteScore(colors: RGB[], assignments: number[], k: number): number {
  const n = colors.length
  if (k <= 1 || n <= k) return -1

  // Group indices by cluster
  const groups: number[][] = Array.from({ length: k }, () => [])
  for (let i = 0; i < n; i++) groups[assignments[i]].push(i)

  let totalS = 0
  let counted = 0
  for (let i = 0; i < n; i++) {
    const ci = assignments[i]
    if (groups[ci].length <= 1) continue

    // a(i) = mean intra-cluster distance
    let a = 0
    for (const j of groups[ci]) {
      if (j !== i) a += Math.sqrt(distSqRGB(colors[i], colors[j]))
    }
    a /= (groups[ci].length - 1)

    // b(i) = min mean inter-cluster distance
    let b = Infinity
    for (let c = 0; c < k; c++) {
      if (c === ci || groups[c].length === 0) continue
      let meanD = 0
      for (const j of groups[c]) meanD += Math.sqrt(distSqRGB(colors[i], colors[j]))
      meanD /= groups[c].length
      if (meanD < b) b = meanD
    }

    totalS += (b - a) / Math.max(a, b)
    counted++
  }

  return counted > 0 ? totalS / counted : -1
}

function autoKMeans(
  colors: RGB[], maxK: number,
): { assignments: number[]; centroids: RGB[] } {
  if (colors.length <= 1) {
    return { assignments: [0], centroids: [colors[0] || [128, 128, 128]] }
  }

  // Small zone: just use median color
  if (colors.length < 6) {
    const median: RGB = [
      colors.map(c => c[0]).sort((a, b) => a - b)[Math.floor(colors.length / 2)],
      colors.map(c => c[1]).sort((a, b) => a - b)[Math.floor(colors.length / 2)],
      colors.map(c => c[2]).sort((a, b) => a - b)[Math.floor(colors.length / 2)],
    ]
    return { assignments: new Array(colors.length).fill(0), centroids: [median] }
  }

  // Check if all colors are similar (variance test) → K=1
  const mean: RGB = [0, 0, 0]
  for (const c of colors) { mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2] }
  mean[0] /= colors.length; mean[1] /= colors.length; mean[2] /= colors.length
  let variance = 0
  for (const c of colors) variance += distSqRGB(c, mean)
  variance /= colors.length
  // If std dev < 15 in RGB space, single color
  if (variance < 225) {
    return {
      assignments: new Array(colors.length).fill(0),
      centroids: [[Math.round(mean[0]), Math.round(mean[1]), Math.round(mean[2])]],
    }
  }

  let bestScore = -2
  let bestResult = runKMeans(colors, 1)

  const effectiveMaxK = Math.min(maxK, colors.length)
  for (let k = 2; k <= effectiveMaxK; k++) {
    const result = runKMeans(colors, k)
    const score = silhouetteScore(colors, result.assignments, k)
    if (score > bestScore) {
      bestScore = score
      bestResult = result
    }
  }

  return bestResult
}

// ─── Coordinate conversion ──────────────────────────────────────────

export function imageToScanPixel(
  p: Point2D,
  imageWidth: number, imageHeight: number,
  scanW: number, scanH: number,
  contentAlignment?: ContentAlignment,
): Point2D {
  if (contentAlignment) {
    const { drawBBox, meshBBox } = contentAlignment
    const meshW = meshBBox.maxX - meshBBox.minX
    const meshH = meshBBox.maxY - meshBBox.minY
    const drawW = drawBBox.maxX - drawBBox.minX
    const drawH = drawBBox.maxY - drawBBox.minY
    const normX = meshW > 0 ? (p.x - meshBBox.minX) / meshW : 0.5
    const normY = meshH > 0 ? (p.y - meshBBox.minY) / meshH : 0.5
    return { x: normX * drawW + drawBBox.minX, y: normY * drawH + drawBBox.minY }
  }
  return { x: p.x / imageWidth * scanW, y: p.y / imageHeight * scanH }
}

// ─── Triangle rasterization ──────────────────────────────────────────

function rasterizeTriangle(
  p0: Point2D, p1: Point2D, p2: Point2D,
  originX: number, originY: number,
  w: number, h: number,
  mask: Uint8Array,
) {
  const ax = p0.x - originX, ay = p0.y - originY
  const bx = p1.x - originX, by = p1.y - originY
  const cx = p2.x - originX, cy = p2.y - originY

  const minPx = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
  const maxPx = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)))
  const minPy = Math.max(0, Math.floor(Math.min(ay, by, cy)))
  const maxPy = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)))

  for (let py = minPy; py <= maxPy; py++) {
    for (let px = minPx; px <= maxPx; px++) {
      const x = px + 0.5, y = py + 0.5
      const d0 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
      const d1 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
      const d2 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
      if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) {
        if (mask[py * w + px] === 0) mask[py * w + px] = 1
      }
    }
  }
}
