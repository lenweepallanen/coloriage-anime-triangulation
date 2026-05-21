/**
 * Zone outlines — applique sur une texture (scan ou image originale) :
 *  1) une érosion virtuelle de 1px sur chaque zone (en peignant un trait noir
 *     centré sur le contour, ce qui mange ~0.5px de chaque côté du bord) ;
 *  2) un contour noir d'épaisseur configurable par zone (slider global +
 *     overrides par zone, persistés dans ProjectTriangulation).
 *
 * Le contour de chaque zone vient de :
 *   tri.zonePoints[zoneId][0..tri.zoneContourLength[zoneId]-1]
 * en coords image (dimensions = originalImage). Le canvas cible peut être
 * d'une autre taille — on rescale les coordonnées au passage.
 */

import * as PIXI from 'pixi.js'
import type { ProjectTriangulation, Point2D } from '../types/project'
import type { ContentAlignment } from './textureExtractor'
import { filterTrianglesOutsideMouth } from './mouthOverlay'

export interface MouthHoleForOutline {
  polygon: Point2D[]
  zoneId: string
}

export interface ApplyZoneOutlinesOptions {
  /** Largeur/hauteur de l'image source ayant servi à définir la triangulation. */
  sourceImageWidth: number
  sourceImageHeight: number
  /** Forcer l'épaisseur (sinon lit tri.outlineWidthGlobal/outlineWidthByZone). */
  overrideWidth?: number
  /** Alignement mesh/draw bbox (cf. computeUVs). Si présent, les coords contour
   *  sont remappées de l'espace mesh vers l'espace canvas. */
  alignment?: ContentAlignment
  /** Image source pour repeindre l'intérieur de chaque zone avant son outline,
   *  ce qui efface tout résidu d'outline d'une zone à z-order inférieur ayant
   *  pu bleed dans cette zone. Indispensable pour un z-order propre. */
  originalImage?: CanvasImageSource
  /** Si fourni, ne stroke QUE les outlines des zones listées (les autres zones
   *  servent uniquement pour le clipping z-order). Utilisé pour les textures
   *  dérivées (HiddenFaceZone body, HiddenFaceLimbZone d'une patte) qui ne
   *  doivent porter que l'outline de la zone qui les sample. */
  onlyZoneIds?: string[]
}

export function getZoneOutlineWidth(tri: ProjectTriangulation, zoneId: string): number {
  const perZone = tri.outlineWidthByZone?.[zoneId]
  if (typeof perZone === 'number') return Math.max(0, perZone)
  return Math.max(0, tri.outlineWidthGlobal ?? 2)
}

export function getZoneOutlineAlignment(tri: ProjectTriangulation, zoneId: string): number {
  const perZone = tri.outlineAlignmentByZone?.[zoneId]
  if (typeof perZone === 'number') return Math.max(0, Math.min(1, perZone))
  return Math.max(0, Math.min(1, tri.outlineAlignment ?? 0.5))
}

export function getZoneOutlineColor(tri: ProjectTriangulation, zoneId: string): string {
  return tri.outlineColorByZone?.[zoneId] ?? '#000000'
}

export function getZoneOutlineSmoothing(tri: ProjectTriangulation, zoneId: string): number {
  const perZone = tri.outlineSmoothingByZone?.[zoneId]
  if (typeof perZone === 'number') return Math.max(0, Math.min(5, perZone))
  return Math.max(0, Math.min(5, tri.outlineSmoothing ?? 0))
}

export function getZoneOutlineInflate(tri: ProjectTriangulation, zoneId: string): number {
  const perZone = tri.outlineInflateByZone?.[zoneId]
  if (typeof perZone === 'number') return perZone
  return tri.outlineInflateGlobal ?? 0
}

/** Décale un polygone fermé d'une distance signée le long de la normale.
 *  Positif = vers l'extérieur, négatif = vers l'intérieur. Détecte
 *  l'orientation par aire signée. Utilise un miter limit pour éviter les
 *  spikes aux angles aigus. */
function inflateLoop(points: { x: number, y: number }[], distance: number): { x: number, y: number }[] {
  if (Math.abs(distance) < 1e-6 || points.length < 3) return points
  let signed = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length]
    signed += a.x * b.y - b.x * a.y
  }
  const sign = signed > 0 ? 1 : -1 // CCW → outward normal = rotate tangent +90° (avec ce sign)
  const out: { x: number, y: number }[] = new Array(points.length)
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length]
    const curr = points[i]
    const next = points[(i + 1) % points.length]
    const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y
    const dx2 = next.x - curr.x, dy2 = next.y - curr.y
    const l1 = Math.hypot(dx1, dy1), l2 = Math.hypot(dx2, dy2)
    if (l1 < 1e-9 || l2 < 1e-9) { out[i] = { x: curr.x, y: curr.y }; continue }
    // Normales extérieures unitaires des deux arêtes
    const n1x = sign * dy1 / l1, n1y = -sign * dx1 / l1
    const n2x = sign * dy2 / l2, n2y = -sign * dx2 / l2
    // Bisecteur (normalisé)
    const bx = n1x + n2x, by = n1y + n2y
    const bl = Math.hypot(bx, by) || 1
    const ux = bx / bl, uy = by / bl
    // Miter length = distance / cos(angle/2) = distance / dot(bisector, normal_edge)
    const dot = ux * n1x + uy * n1y
    const miterLimit = 4 // évite spikes
    const m = Math.abs(dot) > 1e-3 ? distance / dot : distance
    const mClamped = Math.max(-Math.abs(distance) * miterLimit, Math.min(Math.abs(distance) * miterLimit, m))
    out[i] = { x: curr.x + ux * mClamped, y: curr.y + uy * mClamped }
  }
  return out
}

/** Lissage Chaikin sur polygone fermé : remplace chaque arête par 2 points
 *  à 1/4 et 3/4. N itérations → 2^N × points. Préserve la forme générale en
 *  arrondissant les angles. */
function chaikinSmooth(points: { x: number, y: number }[], iterations: number): { x: number, y: number }[] {
  if (iterations <= 0 || points.length < 3) return points
  let pts = points
  for (let it = 0; it < iterations; it++) {
    const out: { x: number, y: number }[] = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
    }
    pts = out
  }
  return pts
}

/** Renvoie les indices ordonnés du contour externe de la zone, indexés sur :
 *   - tri.bodyPoints (et donc walkBodyFrames) si zoneId === 'body'
 *   - tri.zonePoints[zoneId] (et donc walkZoneFrames[zoneId]) sinon.
 * Renvoie null si pas de donnée. Fallback : premiers indices = contour curviligne. */
export function getZoneContourIndices(
  tri: ProjectTriangulation,
  zoneId: string,
  overrideTriangles?: [number, number, number][],
): number[] | null {
  let pts: Point2D[] | undefined
  let tris: [number, number, number][] | undefined
  if (zoneId === 'body') {
    pts = tri.bodyPoints
    tris = tri.bodyTriangles
  } else {
    pts = tri.zonePoints?.[zoneId]
    tris = tri.zoneTriangles?.[zoneId]
  }
  if (overrideTriangles) tris = overrideTriangles
  if (pts && tris && pts.length > 0 && tris.length > 0) {
    const idx = extractOuterContourIndices(pts, tris)
    if (idx && idx.length >= 3) return idx
  }
  const zpts = tri.zonePoints?.[zoneId]
  const len = tri.zoneContourLength?.[zoneId]
  if (!zpts || zpts.length === 0) return null
  const n = (typeof len === 'number' && len > 2 && len <= zpts.length) ? len : zpts.length
  return Array.from({ length: n }, (_, i) => i)
}

/** Chaikin sur polygone fermé, exposé pour les renderers d'overlay. */
export function chaikinSmoothLoop(points: { x: number, y: number }[], iterations: number): { x: number, y: number }[] {
  return chaikinSmooth(points, Math.max(0, Math.round(iterations)))
}

/** Helper PIXI : dessine les outlines de zones. Le z-order est géré par le
 *  zIndex des Graphics (= zone.zOrder + 0.9) dans setup.container avec
 *  sortableChildren=true : les meshes des zones à zOrder strictement supérieur
 *  couvrent naturellement les outlines des zones inférieures. Pas de masque. */
export function drawZoneOutlinesPixi(
  outlineGraphics: Map<string, PIXI.Graphics>,
  polylines: ZoneOutlinePolyline[],
  isVisible?: (zoneId: string) => boolean,
): void {
  const polylineByZone = new Map(polylines.map(p => [p.zoneId, p]))
  for (const [zoneId, g] of outlineGraphics) {
    g.clear()
    const pl = polylineByZone.get(zoneId)
    if (!pl || pl.points.length < 3) continue
    if (isVisible && !isVisible(zoneId)) continue
    const colorNum = parseInt(pl.color.replace('#', ''), 16) || 0
    g.lineStyle({ width: pl.width, color: colorNum, alignment: 0.5, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND })
    g.moveTo(pl.points[0].x, pl.points[0].y)
    for (let i = 1; i < pl.points.length; i++) g.lineTo(pl.points[i].x, pl.points[i].y)
    g.lineTo(pl.points[0].x, pl.points[0].y)
    g.lineStyle(0)
  }
}

export interface ZoneOutlinePolyline {
  zoneId: string
  zOrder: number
  /** Polyligne fermée (déjà lissée), en coords cible (canvas ou stage PIXI). */
  points: { x: number, y: number }[]
  /** Épaisseur dans la même unité que `points` (déjà scalée). */
  width: number
  /** Couleur en hex `#RRGGBB`. */
  color: string
}

/** Calcule les polylignes d'outline pour chaque zone à partir des positions
 *  courantes des sommets (en coords image). Indépendant du renderer : à toi
 *  de dessiner sur canvas 2D, PIXI.Graphics, SVG, etc.
 *  - `bodyPoints` : positions courantes du mesh body (indexées comme tri.bodyPoints / walkBodyFrames).
 *  - `zonePoints` : positions courantes de chaque mesh limb (indexées comme tri.zonePoints[id] / walkZoneFrames[id]).
 *  - `mapPoint` : conversion coords image → coords cible (typiquement scale + offset). */
export function computeZoneOutlinePolylines(
  tri: ProjectTriangulation,
  pointsByZone: {
    body?: Point2D[] | null,
    limbs?: Record<string, Point2D[] | null | undefined> | null,
  },
  mapPoint: (p: Point2D) => { x: number, y: number },
  mouthHole?: MouthHoleForOutline | null,
): ZoneOutlinePolyline[] {
  if (!tri.zones || tri.zones.length === 0) return []
  // Échelle moyenne pour convertir les épaisseurs (en px image) en px cible.
  const a = mapPoint({ x: 0, y: 0 })
  const b = mapPoint({ x: 1, y: 0 })
  const c = mapPoint({ x: 0, y: 1 })
  const sx = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const sy = Math.hypot(c.x - a.x, c.y - a.y) || 1
  const k = (sx + sy) / 2
  const sorted = [...tri.zones].sort((u, v) => (u.zOrder ?? 0) - (v.zOrder ?? 0))
  const out: ZoneOutlinePolyline[] = []
  for (const zone of sorted) {
    let overrideTris: [number, number, number][] | undefined
    if (mouthHole && mouthHole.zoneId === zone.id) {
      const pts = zone.id === 'body' ? tri.bodyPoints : tri.zonePoints?.[zone.id]
      const tris = zone.id === 'body' ? tri.bodyTriangles : tri.zoneTriangles?.[zone.id]
      if (pts && tris) overrideTris = filterTrianglesOutsideMouth(pts, tris, mouthHole.polygon)
    }
    const indices = getZoneContourIndices(tri, zone.id, overrideTris)
    if (!indices || indices.length < 3) continue
    const src = zone.id === 'body' ? pointsByZone.body : pointsByZone.limbs?.[zone.id]
    if (!src) continue
    const imgPositions: Point2D[] = []
    for (const i of indices) {
      const p = src[i]
      if (p) imgPositions.push(p)
    }
    if (imgPositions.length < 3) continue
    // Inflate/deflate en coords image (avant le mapping vers cible)
    const inflateImg = getZoneOutlineInflate(tri, zone.id)
    const inflated = inflateImg !== 0 ? inflateLoop(imgPositions, inflateImg) : imgPositions
    const mapped = inflated.map(mapPoint)
    const iters = Math.round(getZoneOutlineSmoothing(tri, zone.id))
    const smoothed = chaikinSmooth(mapped, iters)
    const widthImg = getZoneOutlineWidth(tri, zone.id)
    const width = Math.max(1, widthImg * k)
    out.push({
      zoneId: zone.id,
      zOrder: zone.zOrder ?? 0,
      points: smoothed,
      width,
      color: getZoneOutlineColor(tri, zone.id),
    })
  }
  return out
}

function getZoneContour(tri: ProjectTriangulation, zoneId: string): Point2D[] | null {
  // Symétrie : chaque zone trace son silhouette ÉTENDU = mesh propre ∪ ses
  // faces cachées fusionnées.
  //   - Body : bodyTriangles inclut les HiddenFaceZones (extensions derrière
  //     les membres).
  //   - Membre : zoneTriangles[id] inclut les HiddenFaceLimbZones (extension
  //     du membre sous le body).
  // extractOuterContour renvoie la boucle d'aire max = silhouette extérieur du
  // mesh étendu.
  let pts: Point2D[] | undefined
  let tris: [number, number, number][] | undefined
  if (zoneId === 'body') {
    pts = tri.bodyPoints
    tris = tri.bodyTriangles
  } else {
    pts = tri.zonePoints?.[zoneId]
    tris = tri.zoneTriangles?.[zoneId]
  }
  if (pts && tris && pts.length > 0 && tris.length > 0) {
    const outer = extractOuterContour(pts, tris)
    if (outer && outer.length >= 3) return outer
  }
  // Fallback : contour curviligne de step 2
  const zpts = tri.zonePoints?.[zoneId]
  const len = tri.zoneContourLength?.[zoneId]
  if (!zpts || zpts.length === 0) return null
  const n = (typeof len === 'number' && len > 2 && len <= zpts.length) ? len : zpts.length
  return zpts.slice(0, n)
}

/** Extrait le contour externe d'un mesh : arêtes apparaissant dans un seul
 *  triangle = bord ; on les chaîne en polygone ordonné. Quand le mesh a des
 *  trous (e.g. body avec trous aux pattes partiellement comblés par hidden
 *  faces), plusieurs boucles existent. On retourne celle d'aire absolue
 *  maximale — le contour extérieur enferme géométriquement tous les trous,
 *  donc son aire est la plus grande même si son périmètre est plus court
 *  qu'un trou très alongé. */
function extractOuterContourIndices(points: Point2D[], triangles: [number, number, number][]): number[] | null {
  const edgeKey = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`
  const counts = new Map<string, number>()
  const edges = new Map<string, [number, number]>()
  for (const [a, b, c] of triangles) {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = edgeKey(x, y)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (!edges.has(k)) edges.set(k, [x, y])
    }
  }
  const adj = new Map<number, Set<number>>()
  for (const [k, n] of counts) {
    if (n !== 1) continue
    const [x, y] = edges.get(k)!
    if (!adj.has(x)) adj.set(x, new Set())
    if (!adj.has(y)) adj.set(y, new Set())
    adj.get(x)!.add(y)
    adj.get(y)!.add(x)
  }
  if (adj.size === 0) return null
  const visited = new Set<number>()
  const loops: number[][] = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const loop: number[] = [start]
    visited.add(start)
    let prev = -1
    let curr = start
    while (true) {
      const next = [...adj.get(curr)!].find(n => n !== prev && (n === start || !visited.has(n)))
      if (next === undefined) break
      if (next === start) break
      loop.push(next)
      visited.add(next)
      prev = curr
      curr = next
    }
    if (loop.length >= 3) loops.push(loop)
  }
  if (loops.length === 0) return null
  const absArea = (loop: number[]): number => {
    let s = 0
    for (let i = 0; i < loop.length; i++) {
      const a = points[loop[i]]
      const b = points[loop[(i + 1) % loop.length]]
      s += a.x * b.y - b.x * a.y
    }
    return Math.abs(s) * 0.5
  }
  let best = loops[0]
  let bestArea = absArea(best)
  for (let i = 1; i < loops.length; i++) {
    const a = absArea(loops[i])
    if (a > bestArea) { bestArea = a; best = loops[i] }
  }
  return best
}

function extractOuterContour(points: Point2D[], triangles: [number, number, number][]): Point2D[] | null {
  const edgeKey = (a: number, b: number) => a < b ? `${a}-${b}` : `${b}-${a}`
  const counts = new Map<string, number>()
  const edges = new Map<string, [number, number]>()
  for (const [a, b, c] of triangles) {
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = edgeKey(x, y)
      counts.set(k, (counts.get(k) ?? 0) + 1)
      if (!edges.has(k)) edges.set(k, [x, y])
    }
  }
  // Adjacence des bords
  const adj = new Map<number, Set<number>>()
  for (const [k, n] of counts) {
    if (n !== 1) continue
    const [x, y] = edges.get(k)!
    if (!adj.has(x)) adj.set(x, new Set())
    if (!adj.has(y)) adj.set(y, new Set())
    adj.get(x)!.add(y)
    adj.get(y)!.add(x)
  }
  if (adj.size === 0) return null

  // Walk toutes les boucles, garde celle d'aire absolue maximale (= extérieure)
  const visited = new Set<number>()
  const loops: number[][] = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const loop: number[] = [start]
    visited.add(start)
    let prev = -1
    let curr = start
    while (true) {
      const next = [...adj.get(curr)!].find(n => n !== prev && (n === start || !visited.has(n)))
      if (next === undefined) break
      if (next === start) break
      loop.push(next)
      visited.add(next)
      prev = curr
      curr = next
    }
    if (loop.length >= 3) loops.push(loop)
  }
  if (loops.length === 0) return null

  const absArea = (loop: number[]): number => {
    let s = 0
    for (let i = 0; i < loop.length; i++) {
      const a = points[loop[i]]
      const b = points[loop[(i + 1) % loop.length]]
      s += a.x * b.y - b.x * a.y
    }
    return Math.abs(s) * 0.5
  }
  let best = loops[0]
  let bestArea = absArea(best)
  for (let i = 1; i < loops.length; i++) {
    const a = absArea(loops[i])
    if (a > bestArea) { bestArea = a; best = loops[i] }
  }
  return best.map(i => points[i])
}

/**
 * Dessine en place sur le canvas cible :
 *   - 1px d'érosion (trait noir constant)
 *   - + épaisseur configurable par zone
 * Le canvas doit déjà contenir l'image source (scan ou coloriage).
 */
export function applyZoneOutlines(
  canvas: HTMLCanvasElement,
  tri: ProjectTriangulation,
  opts: ApplyZoneOutlinesOptions,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const sx = canvas.width / opts.sourceImageWidth
  const sy = canvas.height / opts.sourceImageHeight
  const k = (sx + sy) / 2 // scale moyen pour épaisseurs

  // Mapping mesh→canvas (avec alignment éventuel)
  let mapPoint: (p: Point2D) => { x: number, y: number }
  if (opts.alignment) {
    const { drawBBox, meshBBox } = opts.alignment
    const meshW = meshBBox.maxX - meshBBox.minX
    const meshH = meshBBox.maxY - meshBBox.minY
    const drawW = drawBBox.maxX - drawBBox.minX
    const drawH = drawBBox.maxY - drawBBox.minY
    mapPoint = (p) => {
      const nx = meshW > 0 ? (p.x - meshBBox.minX) / meshW : 0.5
      const ny = meshH > 0 ? (p.y - meshBBox.minY) / meshH : 0.5
      return {
        x: (nx * drawW + drawBBox.minX) * sx,
        y: (ny * drawH + drawBBox.minY) * sy,
      }
    }
  } else {
    mapPoint = (p) => ({ x: p.x * sx, y: p.y * sy })
  }

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Tri par z-order croissant (les zones devant écrasent celles derrière)
  const sortedZones = [...(tri.zones ?? [])].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0))

  // Path2D des contours par zoneId (en coords canvas) — pré-calculé pour le clipping.
  // Le contour est lissé par Chaikin selon le paramètre de la zone (entiers, plafonnés
  // à 5 itérations = ~32× points).
  const zonePaths = new Map<string, Path2D>()
  for (const z of sortedZones) {
    const c = getZoneContour(tri, z.id)
    if (!c || c.length < 3) continue
    const mapped = c.map(mapPoint)
    const iters = Math.round(getZoneOutlineSmoothing(tri, z.id))
    const smoothed = chaikinSmooth(mapped, iters)
    const p = new Path2D()
    for (let i = 0; i < smoothed.length; i++) {
      const q = smoothed[i]
      if (i === 0) p.moveTo(q.x, q.y); else p.lineTo(q.x, q.y)
    }
    p.closePath()
    zonePaths.set(z.id, p)
  }

  const onlySet = opts.onlyZoneIds ? new Set(opts.onlyZoneIds) : null
  for (let zi = 0; zi < sortedZones.length; zi++) {
    const zone = sortedZones[zi]
    const polyPath = zonePaths.get(zone.id)
    if (!polyPath) continue
    if (onlySet && !onlySet.has(zone.id)) continue

    // Avant de peindre l'outline de cette zone : restaurer l'image originale
    // à l'intérieur de son polygone pour effacer tout résidu d'outline d'une
    // zone à z-order inférieur ayant pu bleed jusqu'ici.
    if (opts.originalImage) {
      ctx.save()
      ctx.clip(polyPath)
      const srcW = opts.sourceImageWidth
      const srcH = opts.sourceImageHeight
      if (opts.alignment) {
        const { drawBBox, meshBBox } = opts.alignment
        const meshW = meshBBox.maxX - meshBBox.minX
        const meshH = meshBBox.maxY - meshBBox.minY
        const drawW = drawBBox.maxX - drawBBox.minX
        const drawH = drawBBox.maxY - drawBBox.minY
        // L'image source (en coords mesh) doit être remappée sur la draw bbox.
        const dx = drawBBox.minX * sx - meshBBox.minX * (drawW / meshW) * sx
        const dy = drawBBox.minY * sy - meshBBox.minY * (drawH / meshH) * sy
        const dw = srcW * (drawW / meshW) * sx
        const dh = srcH * (drawH / meshH) * sy
        ctx.drawImage(opts.originalImage, dx, dy, dw, dh)
      } else {
        ctx.drawImage(opts.originalImage, 0, 0, canvas.width, canvas.height)
      }
      ctx.restore()
    }

    const outlineWidth = opts.overrideWidth ?? getZoneOutlineWidth(tri, zone.id)
    const erosion = 1 // px image, toujours appliquée
    const totalWidthImagePx = erosion + outlineWidth
    if (totalWidthImagePx <= 0) continue

    const wScreen = Math.max(1, totalWidthImagePx * k)
    const alignment = getZoneOutlineAlignment(tri, zone.id)
    ctx.strokeStyle = getZoneOutlineColor(tri, zone.id)

    // Construit le path "hors zones à z-order strictement supérieur" pour le clipping extérieur.
    // evenodd : rect canvas + chaque polygone des zones supérieures → l'intérieur de ces
    // polygones se retrouve "hors" du fill, donc clippé.
    const higherZonesExcludePath = new Path2D()
    higherZonesExcludePath.rect(0, 0, canvas.width, canvas.height)
    let hasHigher = false
    for (let zj = zi + 1; zj < sortedZones.length; zj++) {
      const hp = zonePaths.get(sortedZones[zj].id)
      if (hp) { higherZonesExcludePath.addPath(hp); hasHigher = true }
    }

    // Côté intérieur : stroke double épaisseur clippé au polygone → conserve la moitié interne
    if (alignment > 0) {
      ctx.save()
      ctx.clip(polyPath)
      ctx.lineWidth = Math.max(0.5, 2 * wScreen * alignment)
      ctx.stroke(polyPath)
      ctx.restore()
    }

    // Côté extérieur : stroke double épaisseur clippé à l'extérieur du polygone
    // ET hors des zones à z-order supérieur (pour ne pas bleeder dans leur texture).
    if (alignment < 1) {
      const outsidePath = new Path2D()
      outsidePath.rect(0, 0, canvas.width, canvas.height)
      outsidePath.addPath(polyPath)
      ctx.save()
      ctx.clip(outsidePath, 'evenodd')
      if (hasHigher) ctx.clip(higherZonesExcludePath, 'evenodd')
      ctx.lineWidth = Math.max(0.5, 2 * wScreen * (1 - alignment))
      ctx.stroke(polyPath)
      ctx.restore()
    }
  }

  ctx.restore()
}

/**
 * Variante qui applique les outlines en préservant le contenu existant du
 * canvas (inpainting, scan, etc.). Snapshot interne utilisé pour l'anti-bleed,
 * donc l'appelant n'a pas à le gérer. À utiliser pour toutes les textures
 * dérivées (hidden face body, extensions limb), afin que les contours
 * apparaissent au même endroit que sur la texture principale.
 */
export function applyZoneOutlinesPreserving(
  canvas: HTMLCanvasElement,
  tri: ProjectTriangulation,
  opts: Omit<ApplyZoneOutlinesOptions, 'originalImage'>,
): void {
  const snap = document.createElement('canvas')
  snap.width = canvas.width
  snap.height = canvas.height
  snap.getContext('2d')!.drawImage(canvas, 0, 0)
  applyZoneOutlines(canvas, tri, { ...opts, originalImage: snap })
}

/**
 * Variante asynchrone : charge un Blob image, applique les outlines, retourne
 * un nouveau Blob PNG. Utile pour pré-calculer la texture avant PIXI.
 */
export async function applyZoneOutlinesToBlob(
  imageBlob: Blob,
  tri: ProjectTriangulation,
  sourceImageWidth?: number,
  sourceImageHeight?: number,
): Promise<Blob> {
  const url = URL.createObjectURL(imageBlob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const W = img.naturalWidth
    const H = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    applyZoneOutlines(canvas, tri, {
      sourceImageWidth: sourceImageWidth ?? W,
      sourceImageHeight: sourceImageHeight ?? H,
    })
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function hasZoneOutlineData(tri: ProjectTriangulation | null | undefined): boolean {
  if (!tri) return false
  if (!tri.zones || tri.zones.length === 0) return false
  if (!tri.zonePoints) return false
  for (const z of tri.zones) {
    const c = getZoneContour(tri, z.id)
    if (c && c.length >= 3) return true
  }
  return false
}
