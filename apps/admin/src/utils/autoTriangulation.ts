/**
 * « Triangulation auto » (étape Maillage de la Triangulation projet) — à partir des contours validés en étape Zones,
 * propose pour chaque zone : P0, ancres, compteurs de subdivision par segment et densité intérieure. Les maillages
 * eux-mêmes restent calculés par l'étape comme pour un placement manuel (tout reste éditable).
 *
 * Règles (issues du pilote LICORNE, docs/triangulation/) :
 *  - P0 = le plus bas des 20 extrema de courbure (stable : sabot / bas du ventre).
 *  - Ancres = extrémités de chaque contact membre ↔ corps (ancres FORCÉES, pour que les jonctions soient exactes)
 *    + les meilleurs extrema de courbure (NMS), triés par abscisse curviligne depuis P0.
 *  - Subdivision ∝ longueur d'arc de chaque segment (un point tous les `spacing` px, ≈ maxDim/40).
 *  - Densité intérieure 7 pour une grande zone (corps, tête), 6 pour une petite (patte).
 * Aucune face cachée n'est produite (à faire à la main).
 */
import type { Point2D, SAM2Zone } from '../types/project'
import { detectCurvatureExtrema } from './curvatureScaleSpace'
import { reorderContourFromOrigin, computeArcLengths } from './curvilinearContour'
import { pointInPolygon } from './geometry'

export interface AutoTriangulationPlan {
  zoneOrigins: Record<string, Point2D>
  zoneAnchors: Record<string, Point2D[]>
  zoneSegmentCounts: Record<string, number[]>
  zoneDensity: Record<string, number>
  /** Compte-rendu lisible (une ligne par zone). */
  report: string[]
}

export interface AutoTriangulationOptions {
  /** Espacement cible des points de contour (px image). Défaut maxDim / 40. */
  spacing?: number
  /** Distance (px) en deçà de laquelle un point du contour corps est « en contact » avec un membre. Défaut 10. */
  contactDist?: number
}

const TOP_CURVATURE_CANDIDATES = 20
const FORCED_MIN_GAP = 25   // deux ancres ne peuvent pas être plus proches que ça

function distToPolySq(p: Point2D, poly: Point2D[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i]
    const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
    const t = l > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0
    const d = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2
    if (d < best) best = d
  }
  return best
}

function nearestOn(p: Point2D, poly: Point2D[]): Point2D {
  let best = poly[0], bd = Infinity
  for (const q of poly) { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; best = q } }
  return best
}

function polygonArea(poly: Point2D[]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y)
  return Math.abs(a) / 2
}

/**
 * Extrémités des suites cycliques de points de `contour` situés à ≤ `dist` px de `other` (ou dedans).
 * Un contact droit (corde) donne ses deux bouts ; un simple sommet partagé donne un point.
 */
function contactEnds(contour: Point2D[], other: Point2D[], dist: number): Point2D[] {
  const n = contour.length
  if (n < 3 || other.length < 3) return []
  const d2 = dist * dist
  const near = contour.map(p => distToPolySq(p, other) <= d2 || pointInPolygon(p, other))
  if (!near.some(Boolean) || near.every(Boolean)) return []
  const start = near.indexOf(false)
  const out: Point2D[] = []
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    if (!near[i]) continue
    let len = 0
    while (len < n && near[(i + len) % n]) len++
    out.push(contour[i])
    if (len > 1) out.push(contour[(i + len - 1) % n])
    k += len - 1
  }
  return out
}

function dedupe(points: Point2D[], minGap: number): Point2D[] {
  const out: Point2D[] = []
  for (const p of points) if (out.every(q => Math.hypot(q.x - p.x, q.y - p.y) > minGap)) out.push(p)
  return out
}

export function planAutoTriangulation(
  contours: Record<string, Point2D[]>,
  zones: SAM2Zone[],
  imageWidth: number,
  imageHeight: number,
  opts: AutoTriangulationOptions = {},
): AutoTriangulationPlan {
  const maxDim = Math.max(imageWidth, imageHeight)
  const spacing = opts.spacing ?? maxDim / 40
  const contactDist = opts.contactDist ?? 10
  const imageArea = imageWidth * imageHeight
  const members = zones.filter(z => z.id !== 'body' && contours[z.id]?.length >= 3)
  const body = contours['body']

  const plan: AutoTriangulationPlan = { zoneOrigins: {}, zoneAnchors: {}, zoneSegmentCounts: {}, zoneDensity: {}, report: [] }

  for (const z of zones) {
    const ref = contours[z.id]
    if (!ref || ref.length < 10) { plan.report.push(`${z.label} : pas de contour`); continue }

    // Ancres forcées = contacts avec les autres zones (corps ↔ chaque membre ; membre ↔ corps)
    const forcedRaw: Point2D[] = []
    if (z.id === 'body') { for (const m of members) forcedRaw.push(...contactEnds(ref, contours[m.id], contactDist)) }
    else if (body && body.length >= 3) forcedRaw.push(...contactEnds(ref, body, contactDist))

    const pool = detectCurvatureExtrema(ref, TOP_CURVATURE_CANDIDATES)
    const p0 = pool.length ? pool.reduce((b, c) => (c.position.y > b.position.y ? c : b)).position : ref[0]
    const forced = dedupe(forcedRaw.map(p => nearestOn(p, ref)).filter(p => Math.hypot(p.x - p0.x, p.y - p0.y) > FORCED_MIN_GAP), FORCED_MIN_GAP)

    // Nombre total d'ancres visé ∝ périmètre, borné [8, 16] (corps ≈ 16, patte ≈ 8-10, tête ≈ 12-16)
    const arcAll = computeArcLengths(ref)
    const perimeter = arcAll[arcAll.length - 1] || 1
    const target = Math.max(8, Math.min(16, Math.round(perimeter / (spacing * 7))))
    const nExtrema = Math.max(3, target - 1 - forced.length)
    const farFromForced = (p: Point2D) => forced.every(f => Math.hypot(f.x - p.x, f.y - p.y) > FORCED_MIN_GAP)
    const extrema = pool
      .filter(c => Math.hypot(c.position.x - p0.x, c.position.y - p0.y) > 20 && farFromForced(c.position))
      .slice(0, nExtrema)
      .map(c => c.position)

    // Tri par abscisse curviligne depuis P0 (ordre de chaîne), comme autoDetectAnchors de l'étape
    const ordered = reorderContourFromOrigin(ref, p0)
    const arcLens = computeArcLengths(ordered)
    const total = arcLens[arcLens.length - 1] || 1
    const arcOf = (p: Point2D): number => {
      let bestIdx = 0, bestDist = Infinity
      for (let i = 0; i < ordered.length; i++) {
        const d = (ordered[i].x - p.x) ** 2 + (ordered[i].y - p.y) ** 2
        if (d < bestDist) { bestDist = d; bestIdx = i }
      }
      return arcLens[bestIdx]
    }
    const sorted = [...forced, ...extrema].map(p => ({ p, s: arcOf(p) })).sort((a, b) => a.s - b.s).map(x => x.p)
    const anchors = [p0, ...sorted]

    // Compteurs par segment ∝ longueur d'arc (segment i = anchor_i → anchor_{i+1}, cyclique)
    const sA = anchors.map(arcOf)
    const counts = anchors.map((_, i) => {
      const a = sA[i], b = sA[(i + 1) % anchors.length]
      const len = (((b - a) % total) + total) % total || total
      return Math.max(1, Math.round(len / spacing))
    })

    plan.zoneOrigins[z.id] = p0
    plan.zoneAnchors[z.id] = anchors
    plan.zoneSegmentCounts[z.id] = counts
    plan.zoneDensity[z.id] = polygonArea(ref) > 0.08 * imageArea ? 7 : 6
    plan.report.push(`${z.label} : ${anchors.length} ancres (${forced.length} aux jonctions), ${counts.reduce((s, c) => s + c, 0)} points de subdivision, densité ${plan.zoneDensity[z.id]}`)
  }
  return plan
}
