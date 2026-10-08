/**
 * Géométrie de la triangulation automatique — réutilise les utilitaires de l'admin (mêmes algorithmes que l'UI).
 * Entrée (JSON, argv[2]) : { w, h, zones: [{ id, label, color, zOrder, kind: 'body'|'near'|'far' }], raw: { zoneId: Point2D[] },
 *   params: { sigma, bridge, anchors: { body, leg }, subdivSpacing, density: { body, leg } } }
 * Sortie (JSON, stdout) : champs ProjectTriangulation (étapes 1 à 3) + zoneBeziers pour les zones « far ».
 * Bundle : npx esbuild docs/triangulation/auto_triang_geom.ts --bundle --platform=node --format=esm --outfile=<x>.mjs
 */
import { readFileSync } from 'node:fs'
import type { Point2D, SAM2Zone, CurvilinearParam, HiddenFaceZone, HiddenFaceLimbZone, BezierNode } from '../../apps/admin/src/types/project'
import { smoothPolygonGaussian } from '../../apps/admin/src/utils/sam2Contour'
import { detectCurvatureExtrema } from '../../apps/admin/src/utils/curvatureScaleSpace'
import { reorderContourFromOrigin, computeArcLengths, subdivideContour } from '../../apps/admin/src/utils/curvilinearContour'
import { triangulateZone, generateInternalPoints, triangulateHiddenFace, triangulateHiddenFaceLimb } from '../../apps/admin/src/utils/limbSeparation'
import { pointInPolygon } from '../../apps/admin/src/utils/geometry'
import { polygonToBezierNodes } from '../../apps/admin/src/utils/bezierUtils'

type Zone = SAM2Zone & { kind: 'body' | 'near' | 'far' | 'head' }
interface Input {
  w: number; h: number; zones: Zone[]; raw: Record<string, Point2D[]>
  params: { sigma: number; bridge: number; anchors: { body: number; leg: number; head: number }; subdivSpacing: number; density: { body: number; leg: number; head: number } }
}
const input: Input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { w, h, zones, params } = input
const maxDim = Math.max(w, h)
const log = (...a: unknown[]) => console.error('[geom]', ...a)

// ───────────────────────── étape 1 : contours lissés, body ponté PATTE PAR PATTE ─────────────────────────
// Chaque point du contour body est étiqueté par la patte la plus proche (≤ bridge px) ; chaque suite de points d'une même
// patte est remplacée par ses deux extrémités (corde). Deux pattes voisines donnent ainsi deux cordes avec un sommet commun
// à leur frontière — nécessaire pour que chaque jonction soit exacte (bridgeContourAtLegs fusionnerait les deux contacts).
function distToPolySq(p: Point2D, poly: Point2D[]): number {
  let best = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i]; const dx = b.x - a.x, dy = b.y - a.y; const l = dx * dx + dy * dy
    const t = l > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0
    const d = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2; if (d < best) best = d
  }
  return best
}
function nearestOn(p: Point2D, poly: Point2D[]): Point2D { let b = poly[0], bd = Infinity; for (const q of poly) { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; b = q } } return b }
const members = zones.filter(z => z.id !== 'body')
const contours: Record<string, Point2D[]> = {}
for (const z of members) contours[z.id] = smoothPolygonGaussian(input.raw[z.id], params.sigma)
const bodySm = smoothPolygonGaussian(input.raw['body'], params.sigma)
const thr2 = params.bridge * params.bridge
const label: (string | null)[] = bodySm.map(p => {
  let best: string | null = null, bd = thr2
  for (const z of members) { const d = distToPolySq(p, contours[z.id]); if (d <= bd) { bd = d; best = z.id } }
  return best
})
function simplify(pts: Point2D[], eps: number): Point2D[] {
  if (pts.length <= 2) return pts
  const a = pts[0], b = pts[pts.length - 1]; let idx = -1, dmax = 0
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L; if (d > dmax) { dmax = d; idx = i } }
  if (dmax <= eps) return [a, b]
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)]
}
const junctions: Record<string, [Point2D, Point2D]> = {}
{
  const n = bodySm.length; const start = label.indexOf(null)
  if (start < 0) throw new Error('contour body entièrement en contact avec les pattes')
  const out: Point2D[] = []; const bestY: Record<string, number> = {}
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n; const lab = label[i]
    if (lab === null) { out.push(bodySm[i]); continue }
    let len = 0, sy = 0; while (len < n && label[(i + len) % n] === lab) { sy += bodySm[(i + len) % n].y; len++ }
    const a = bodySm[i], b = bodySm[(i + len - 1) % n]
    // la suite est remplacée par sa simplification Douglas-Peucker (ε = bridge) : une corde si le contact est droit, une
    // polyligne s'il tourne (ex. tête : poitrail → bas de crinière → garrot), au lieu d'une corde unique qui couperait la zone
    const run: Point2D[] = []; for (let q = 0; q < len; q++) run.push(bodySm[(i + q) % n])
    for (const p of simplify(run, params.bridge)) out.push(p)
    const span = Math.hypot(b.x - a.x, b.y - a.y)
    if (span >= 20 && (bestY[lab] === undefined || sy / len < bestY[lab])) { bestY[lab] = sy / len; junctions[lab] = [a, b] }
    k += len - 1
  }
  contours['body'] = out
}
for (const z of members) {
  const j = junctions[z.id]
  if (j) log(z.id, 'jonction', Math.round(j[0].x), Math.round(j[0].y), '→', Math.round(j[1].x), Math.round(j[1].y), 'longueur', Math.round(Math.hypot(j[1].x - j[0].x, j[1].y - j[0].y)))
  else log(z.id, 'PAS de jonction avec le corps')
}
log('contours', Object.fromEntries(Object.entries(contours).map(([k, v]) => [k, v.length])))

// ───────────────────────── étape 2 : P0, anchors, subdivision (comme ProjectTriangMeshStep) ─────────────────────────
const TOP_CURVATURE_CANDIDATES = 20
function arcLengthOf(ordered: Point2D[], arcLens: number[], p: Point2D): number {
  let bestIdx = 0, bestDist = Infinity
  for (let i = 0; i < ordered.length; i++) { const d = (ordered[i].x - p.x) ** 2 + (ordered[i].y - p.y) ** 2; if (d < bestDist) { bestDist = d; bestIdx = i } }
  return arcLens[bestIdx] / (arcLens[arcLens.length - 1] || 1)
}
const zoneOrigins: Record<string, Point2D> = {}
const zoneAnchors: Record<string, Point2D[]> = {}
const zoneSubdivisionPoints: Record<string, Point2D[]> = {}
const zoneSubdivisionParams: Record<string, CurvilinearParam[]> = {}
const closedContours: Record<string, Point2D[]> = {}
for (const z of zones) {
  const ref = contours[z.id]
  const pool = detectCurvatureExtrema(ref, TOP_CURVATURE_CANDIDATES)
  // P0 = point le plus bas parmi les 20 extrema (stable : sabot / bas du ventre), sinon le 1er
  const p0 = pool.length ? pool.reduce((b, c) => (c.position.y > b.position.y ? c : b)).position : ref[0]
  // ancres FORCÉES : extrémités des cordes de jonction (corps : toutes ; patte : les siennes, projetées sur son contour)
  const forcedRaw = z.id === 'body' ? Object.values(junctions).flat() : (junctions[z.id] ? [...junctions[z.id]] : [])
  const forced = forcedRaw.map(p => nearestOn(p, ref)).filter(p => Math.hypot(p.x - p0.x, p.y - p0.y) > 25)
  const farFromForced = (p: Point2D) => forced.every(f => Math.hypot(f.x - p.x, f.y - p.y) > 25)
  const targetN = z.kind === 'body' ? params.anchors.body : z.kind === 'head' ? params.anchors.head : params.anchors.leg
  const nExtrema = z.kind === 'body' ? targetN - 1 : Math.max(3, targetN - 1 - forced.length)
  const extrema = pool.filter(c => Math.hypot(c.position.x - p0.x, c.position.y - p0.y) > 20 && farFromForced(c.position)).slice(0, nExtrema).map(c => c.position)
  const selected = [...forced, ...extrema]
  const ordered = reorderContourFromOrigin(ref, p0)
  const arcLens = computeArcLengths(ordered)
  const sorted = selected.map(p => ({ p, s: arcLengthOf(ordered, arcLens, p) })).sort((a, b) => a.s - b.s).map(x => x.p)
  const anchors = [p0, ...sorted]
  // compteurs par segment ∝ longueur d'arc du segment
  const sA = anchors.map(a => arcLengthOf(ordered, arcLens, a) * (arcLens[arcLens.length - 1] || 1))
  const counts = anchors.map((_, i) => {
    const a = sA[i], b = sA[(i + 1) % anchors.length]; const total = arcLens[arcLens.length - 1] || 1
    const len = ((b - a) % total + total) % total || total
    return Math.max(1, Math.round(len / params.subdivSpacing))
  })
  const { points, params: subParams } = subdivideContour(ordered, anchors, counts)
  zoneOrigins[z.id] = p0; zoneAnchors[z.id] = anchors; zoneSubdivisionPoints[z.id] = points; zoneSubdivisionParams[z.id] = subParams
  // buildClosedContour : anchor_i puis subdivisions du segment i triées par t
  const n = anchors.length; const bySeg: { t: number; pt: Point2D }[][] = Array.from({ length: n }, () => [])
  subParams.forEach((p, i) => { if (points[i] && p.segmentIndex >= 0 && p.segmentIndex < n) bySeg[p.segmentIndex].push({ t: p.t, pt: points[i] }) })
  for (const arr of bySeg) arr.sort((a, b) => a.t - b.t)
  const out: Point2D[] = []
  for (let i = 0; i < n; i++) { out.push(anchors[i]); for (const sp of bySeg[i]) out.push(sp.pt) }
  closedContours[z.id] = out
  log(z.id, 'anchors', anchors.length, 'subdiv', points.length, 'contour', out.length)
}

// ───────────────────────── étape 2d : Delaunay + trous par zOrder + compaction (comme zoneMeshes) ─────────────────────────
const spacingForDensity = (d: number) => maxDim / (d * 3 + 5)
const zonePoints: Record<string, Point2D[]> = {}
const zoneTriangles: Record<string, [number, number, number][]> = {}
const zoneContourLength: Record<string, number> = {}
const zoneDensity: Record<string, number> = {}
for (const z of zones) {
  const cPts = closedContours[z.id]
  const density = z.kind === 'body' ? params.density.body : z.kind === 'head' ? params.density.head : params.density.leg
  zoneDensity[z.id] = density
  const internal = generateInternalPoints(cPts, spacingForDensity(density))
  const tri = triangulateZone(cPts, internal, cPts)
  const currentZ = z.zOrder ?? 0
  const higher = zones.filter(o => o.id !== z.id && (o.zOrder ?? 0) > currentZ).map(o => closedContours[o.id])
  const filtered = higher.length ? tri.triangles.filter(([a, b, c]) => !higher.some(hc => pointInPolygon(tri.points[a], hc) || pointInPolygon(tri.points[b], hc) || pointInPolygon(tri.points[c], hc))) : tri.triangles
  const used = new Set<number>(); for (const [a, b, c] of filtered) { used.add(a); used.add(b); used.add(c) }
  for (let i = 0; i < cPts.length; i++) used.add(i)
  const usedArr = [...used].sort((a, b) => a - b); const oldToNew = new Map<number, number>(); const newPts: Point2D[] = []
  for (const o of usedArr) { oldToNew.set(o, newPts.length); newPts.push(tri.points[o]) }
  zonePoints[z.id] = newPts
  zoneTriangles[z.id] = filtered.map(([a, b, c]) => [oldToNew.get(a)!, oldToNew.get(b)!, oldToNew.get(c)!] as [number, number, number])
  zoneContourLength[z.id] = cPts.length
  log(z.id, 'points', newPts.length, 'triangles', zoneTriangles[z.id].length, '(avant trous', tri.triangles.length, ')')
}

// ───────────────────────── étape 3 : faces cachées automatiques ─────────────────────────
/** Arc de pont entre A et B, bombé du côté `inside` : chaque point est poussé perpendiculairement à la corde de
 *  depth·sin(πt) puis ramené vers la corde point par point tant qu'il n'est pas « dedans » (épaule/hanche pleine
 *  même si la zone est biseautée près des extrémités). */
function arcPoints(A: Point2D, B: Point2D, inside: (p: Point2D) => boolean, depthRatio: number, count = 6): Point2D[] {
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2; const L = Math.hypot(B.x - A.x, B.y - A.y) || 1
  let nx = -(B.y - A.y) / L, ny = (B.x - A.x) / L
  const score = (sx: number, sy: number) => [15, 30, 60, 90].filter(d => inside({ x: mx + sx * d, y: my + sy * d })).length
  if (score(-nx, -ny) > score(nx, ny)) { nx = -nx; ny = -ny }
  const pts: Point2D[] = []
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1); const bx = A.x + (B.x - A.x) * t, by = A.y + (B.y - A.y) * t
    let d = L * depthRatio * Math.sin(Math.PI * t)
    while (d > 3 && !inside({ x: bx + nx * d, y: by + ny * d })) d *= 0.85
    if (d > 3) pts.push({ x: bx + nx * d, y: by + ny * d })
  }
  return pts.length >= 3 ? pts : []
}

// maillages « propres » (avant faces cachées) : baselines pour l'étape 3 de l'admin
const basePts: Record<string, Point2D[]> = { ...zonePoints }; const baseTris: Record<string, [number, number, number][]> = { ...zoneTriangles }
let bodyPts = [...zonePoints['body']]; let bodyTris = [...zoneTriangles['body']]
const bodyDense = contours['body']
const hiddenFaceZones: HiddenFaceZone[] = []
const hiddenFaceLimbZones: HiddenFaceLimbZone[] = []
const bodyZ = zones.find(z => z.id === 'body')!.zOrder ?? 0
const nearestIdx = (p: Point2D, pts: Point2D[], n: number) => { let b = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = (pts[i].x - p.x) ** 2 + (pts[i].y - p.y) ** 2; if (d < bd) { bd = d; b = i } } return b }
for (const z of members) {
  const legDense = contours[z.id]; const j = junctions[z.id]
  if (!j) continue
  if (z.kind === 'head') { log(z.id, 'tête : pas de face cachée automatique (à faire à la main)'); continue }
  if ((z.zOrder ?? 0) > bodyZ) {
    // patte DEVANT le corps → le corps continue DERRIÈRE la patte (épaule/hanche) : A/B sur le contour body, arc DANS la patte
    const A = nearestIdx(j[0], bodyPts, zoneContourLength['body']), B = nearestIdx(j[1], bodyPts, zoneContourLength['body'])
    if (A === B) { log(z.id, 'corde dégénérée'); continue }
    const bridge = arcPoints(bodyPts[A], bodyPts[B], p => pointInPolygon(p, legDense), 0.6)
    if (!bridge.length) { log(z.id, 'arc corps→patte impossible', bodyPts[A], bodyPts[B]); continue }
    const r = triangulateHiddenFace(bodyPts, bodyTris, A, B, bridge)
    bodyPts = r.updatedBodyPoints; bodyTris = r.updatedBodyTriangles
    hiddenFaceZones.push({ limbZoneId: z.id, bodyVertexA: A, bodyVertexB: B, bridgePoints: bridge, bodyTriangleIndices: r.hiddenFaceTriangleIndices })
    log(z.id, 'face cachée corps', r.hiddenFaceTriangleIndices.length, 'triangles')
  } else {
    // patte DERRIÈRE le corps → la patte se prolonge SOUS le corps : A/B sur le contour de la patte, arc DANS le corps
    const zp = zonePoints[z.id]; const zt = zoneTriangles[z.id]
    const A = nearestIdx(j[0], zp, zoneContourLength[z.id]), B = nearestIdx(j[1], zp, zoneContourLength[z.id])
    if (A === B) { log(z.id, 'corde dégénérée'); continue }
    const bridge = arcPoints(zp[A], zp[B], p => pointInPolygon(p, bodyDense) && !pointInPolygon(p, legDense), 0.6)
    if (!bridge.length) { log(z.id, 'arc patte→corps impossible', zp[A], zp[B]); continue }
    const r = triangulateHiddenFaceLimb(zp, zt, A, B, bridge)
    zonePoints[z.id] = r.updatedZonePoints; zoneTriangles[z.id] = r.updatedZoneTriangles
    hiddenFaceLimbZones.push({ id: `hfl-${z.id}`, limbZoneId: z.id, zoneVertexA: A, zoneVertexB: B, bridgePoints: bridge, zoneTriangleIndices: r.hiddenFaceLimbTriangleIndices })
    log(z.id, 'prolongement patte', r.hiddenFaceLimbTriangleIndices.length, 'triangles')
  }
}
const bodyPointsBaseline = basePts['body']; const bodyTrianglesBaseline = baseTris['body']
const finalZonePoints: Record<string, Point2D[]> = { ...zonePoints, body: bodyPts }
const finalZoneTriangles: Record<string, [number, number, number][]> = { ...zoneTriangles, body: bodyTris }
const zoneBeziers: Record<string, BezierNode[]> = {}
for (const z of members) if (z.kind === 'far') zoneBeziers[z.id] = polygonToBezierNodes(contours[z.id], 24)
for (const z of members) if (z.kind === 'head') zoneBeziers[z.id] = polygonToBezierNodes(contours[z.id], 48)

const flags = (v: boolean) => Object.fromEntries(zones.map(z => [z.id, v]))
process.stdout.write(JSON.stringify({
  contours, zoneOrigins, zoneAnchors, zoneSubdivisionPoints, zoneSubdivisionParams, zoneContourLength, zoneDensity,
  zoneOriginsValidated: flags(true), zoneAnchorsValidated: flags(true), zoneSubdivisionValidated: flags(true),
  zonePoints: finalZonePoints, zoneTriangles: finalZoneTriangles,
  bodyPoints: bodyPts, bodyTriangles: bodyTris,
  bodyPointsBaseline, bodyTrianglesBaseline, zonePointsBaseline: Object.fromEntries(members.map(z => [z.id, basePts[z.id]])), zoneTrianglesBaseline: Object.fromEntries(members.map(z => [z.id, baseTris[z.id]])),
  hiddenFaceZones, hiddenFaceLimbZones, zoneBeziers,
}))
