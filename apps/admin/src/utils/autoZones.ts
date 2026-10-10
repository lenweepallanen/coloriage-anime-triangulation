/**
 * « Zones auto » (étape Zones de la Triangulation projet) — post-traitement du résultat brut du worker
 * (`auto-zones`, port de docs/triangulation/auto_triang.py) : lissage, pontage du corps membre par membre,
 * conversion en courbes Bézier éditables (+ contour de référence pour le re-fit), zones nommées et colorées.
 * Rien n'est enregistré ici : le composant pose le résultat dans son état d'édition.
 */
import type { Point2D, SAM2Zone, BezierNode } from '../types/project'
import { smoothPolygonGaussian } from './sam2Contour'
import { fitBezierToClosedPolygon } from './bezierFit'
import { polygonToBezierNodes } from './bezierUtils'

export interface AutoZonesRawMember {
  kind: 'near' | 'far' | 'head'
  label: string
  zOrder: number
  polygon: Point2D[]
  seeds: Point2D[]
  inflate: number
}
export interface AutoZonesRaw {
  facesLeft: boolean
  body: Point2D[]
  members: AutoZonesRawMember[]
  info?: { fromAlpha: boolean; hooves: number; closedLegs: number; headRatio: number }
}
export interface AutoZonesResult {
  zones: SAM2Zone[]
  zoneBeziers: Record<string, BezierNode[]>
  zoneCannyRefs: Record<string, Point2D[]>
  report: string[]
}

const MEMBER_COLORS: Record<string, string> = { AVG: '#f59e0b', AVD: '#ef4444', ARD: '#3b82f6', ARG: '#a855f7' }
const HEAD_COLOR = '#ec4899'
const BODY_ZONE: SAM2Zone = { id: 'body', label: 'Body', color: '#22c55e', zOrder: 1 }

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

/** Douglas-Peucker (ouvert). */
function simplify(pts: Point2D[], eps: number): Point2D[] {
  if (pts.length <= 2) return pts
  const a = pts[0], b = pts[pts.length - 1]
  const L = Math.hypot(b.x - a.x, b.y - a.y) || 1
  let idx = -1, dmax = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b.x - a.x) * (a.y - pts[i].y) - (a.x - pts[i].x) * (b.y - a.y)) / L
    if (d > dmax) { dmax = d; idx = i }
  }
  if (dmax <= eps) return [a, b]
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)]
}

/**
 * Pontage du corps MEMBRE PAR MEMBRE : chaque point du contour corps est étiqueté par le membre le plus proche
 * (≤ bridge px) ; chaque suite d'un même membre est remplacée par sa simplification Douglas-Peucker (corde si le
 * contact est droit, polyligne s'il tourne — ex. tête : poitrail → sous crinière → garrot). Deux membres voisins
 * gardent ainsi un sommet commun à leur frontière (jonctions exactes pour la triangulation).
 */
export function bridgeBodyPerMember(bodySmooth: Point2D[], members: Record<string, Point2D[]>, bridge: number): Point2D[] {
  const ids = Object.keys(members)
  if (ids.length === 0 || bodySmooth.length < 3) return bodySmooth
  const thr2 = bridge * bridge
  const label = bodySmooth.map(p => {
    let best: string | null = null, bd = thr2
    for (const id of ids) { const d = distToPolySq(p, members[id]); if (d <= bd) { bd = d; best = id } }
    return best
  })
  const n = bodySmooth.length
  const start = label.indexOf(null)
  if (start < 0) return bodySmooth
  const out: Point2D[] = []
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n
    const lab = label[i]
    if (lab === null) { out.push(bodySmooth[i]); continue }
    let len = 0
    while (len < n && label[(i + len) % n] === lab) len++
    const run: Point2D[] = []
    for (let q = 0; q < len; q++) run.push(bodySmooth[(i + q) % n])
    out.push(...simplify(run, bridge))
    k += len - 1
  }
  return out
}

function toBezier(poly: Point2D[], tolerance: number, cornerDeg: number): BezierNode[] {
  try {
    const nodes = fitBezierToClosedPolygon(poly, { tolerance, cornerThresholdDeg: cornerDeg, cornerSmoothWindow: 3 })
    if (nodes.length >= 3) return nodes
  } catch (err) {
    console.warn('[Zones auto] fit Bézier → repli resampling', err)
  }
  return polygonToBezierNodes(poly, Math.max(12, Math.min(64, Math.round(poly.length / 40))))
}

/**
 * Zones déjà existantes (graines / flood-fill) → courbes Bézier RELIÉES : membres lissés, corps = contour brut
 * (silhouette − membres) lissé puis ponté MEMBRE PAR MEMBRE (Douglas-Peucker), pour que chaque jonction ait des
 * sommets communs (la triangulation auto y force des ancres → pas d'encoche entre un membre et le corps).
 * Les ids/labels/couleurs des zones sont conservés.
 */
export function buildBezierZonesFromLoops(
  zones: SAM2Zone[],
  loops: Record<string, Point2D[]>,
  bodyRaw: Point2D[],
  sigma: number,
  bridge: number,
): { zoneBeziers: Record<string, BezierNode[]>; zoneCannyRefs: Record<string, Point2D[]>; report: string[] } {
  const zoneBeziers: Record<string, BezierNode[]> = {}
  const zoneCannyRefs: Record<string, Point2D[]> = {}
  const smoothedMembers: Record<string, Point2D[]> = {}
  const report: string[] = []
  for (const z of zones) {
    if (z.id === 'body') continue
    const poly = loops[z.id]
    if (!poly || poly.length < 10) { report.push(`${z.label} : pas de contour`); continue }
    const sm = smoothPolygonGaussian(poly, sigma)
    smoothedMembers[z.id] = sm
    zoneCannyRefs[z.id] = sm
    zoneBeziers[z.id] = toBezier(sm, 2.5, 60)
    report.push(`${z.label} : ${zoneBeziers[z.id].length} nœuds`)
  }
  const bodySmooth = smoothPolygonGaussian(bodyRaw, sigma)
  const bodyBridged = bridgeBodyPerMember(bodySmooth, smoothedMembers, Math.max(bridge, 6))
  zoneCannyRefs['body'] = bodyBridged
  zoneBeziers['body'] = toBezier(bodyBridged, 2.5, 50)
  report.unshift(`Corps : ${zoneBeziers['body'].length} nœuds, ponté membre par membre`)
  return { zoneBeziers, zoneCannyRefs, report }
}

export function buildAutoZones(raw: AutoZonesRaw, sigma: number, bridge: number): AutoZonesResult {
  const zones: SAM2Zone[] = [{ ...BODY_ZONE }]
  const loops: Record<string, Point2D[]> = {}
  const kinds: Record<string, string> = {}
  for (const m of raw.members) {
    if (!m.polygon || m.polygon.length < 10) continue
    const id = `member-${crypto.randomUUID().slice(0, 8)}`
    const color = m.kind === 'head' ? HEAD_COLOR : (MEMBER_COLORS[m.label.slice(0, 3)] ?? '#64748b')
    zones.push({ id, label: m.label, color, zOrder: m.zOrder })
    loops[id] = m.polygon
    kinds[id] = m.kind === 'near' ? 'patte devant' : m.kind === 'far' ? 'patte arrière-plan' : 'tête + cou + crinière'
  }
  const built = buildBezierZonesFromLoops(zones, loops, raw.body, sigma, bridge)
  const report = built.report.map(line => { const z = zones.find(x => line.startsWith(x.label + ' :')); return z && kinds[z.id] ? line.replace(' :', ` : ${kinds[z.id]},`) : line })
  report[0] = `${report[0]} · tête ${raw.facesLeft ? 'à gauche' : 'à droite'}${raw.info ? ` · silhouette ${raw.info.fromAlpha ? 'alpha' : 'Canny'}, ${raw.info.hooves} sabots` : ''}`
  return { zones, zoneBeziers: built.zoneBeziers, zoneCannyRefs: built.zoneCannyRefs, report }
}
