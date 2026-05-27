import type { Point2D, SceneWalkTrapezoid } from '../types/project'

/**
 * Géométrie du trapèze de marche + perspective 2.5D pour la scène.
 * Le trapèze est défini en coords du layer front (premier plan).
 * U ∈ [0,1] : 0 = gauche, 1 = droite.
 * V ∈ [0,1] : 0 = top (arrière, scale min), 1 = bottom (avant, scale max).
 */

function sub(a: Point2D, b: Point2D): Point2D { return { x: a.x - b.x, y: a.y - b.y } }
function add(a: Point2D, b: Point2D): Point2D { return { x: a.x + b.x, y: a.y + b.y } }
function mul(a: Point2D, s: number): Point2D { return { x: a.x * s, y: a.y * s } }
function dot(a: Point2D, b: Point2D): number { return a.x * b.x + a.y * b.y }
function cross(a: Point2D, b: Point2D): number { return a.x * b.y - a.y * b.x }

/** Évalue le trapèze bilinéaire : (u,v) → point. */
export function trapezoidUVToPoint(u: number, v: number, t: SceneWalkTrapezoid): Point2D {
  const top = add(mul(t.topLeft, 1 - u), mul(t.topRight, u))
  const bottom = add(mul(t.bottomLeft, 1 - u), mul(t.bottomRight, u))
  return add(mul(top, 1 - v), mul(bottom, v))
}

/**
 * Coords bilinéaires inverses (u,v) ∈ [0,1]² si p est dans le quad, sinon null.
 * Résolution analytique pour un quad bilinéaire convexe.
 */
export function pointToTrapezoidUV(p: Point2D, t: SceneWalkTrapezoid): { u: number; v: number } | null {
  const a = t.topLeft
  const b = t.topRight
  const c = t.bottomRight
  const d = t.bottomLeft
  // p = a + (b-a)u + (d-a)v + (a-b-d+c)uv
  const e = sub(b, a)
  const f = sub(d, a)
  const g = sub(add(a, c), add(b, d))
  const h = sub(p, a)
  // Résout : u * e + v * f + uv * g = h
  // → équation quadratique en v : k2*v² + k1*v + k0 = 0
  // Dérivation correcte : à partir de h - v·f = u·(e + v·g), cross avec (e + v·g)
  // donne k2·v² + k1·v + k0 = 0 avec :
  const k2 = cross(g, f)
  const k1 = cross(e, f) + cross(h, g)
  const k0 = cross(h, e)
  let v: number
  if (Math.abs(k2) < 1e-9) {
    // Linéaire : trapèze dégénéré (parallélogramme)
    if (Math.abs(k1) < 1e-9) return null
    v = -k0 / k1
  } else {
    const disc = k1 * k1 - 4 * k2 * k0
    if (disc < 0) return null
    const sq = Math.sqrt(disc)
    const v1 = (-k1 + sq) / (2 * k2)
    const v2 = (-k1 - sq) / (2 * k2)
    v = (v1 >= -1e-3 && v1 <= 1 + 1e-3) ? v1 : v2
  }
  // u depuis v
  const denomX = e.x + g.x * v
  const denomY = e.y + g.y * v
  const u = Math.abs(denomX) > Math.abs(denomY)
    ? (h.x - f.x * v) / denomX
    : (h.y - f.y * v) / denomY
  if (u < -1e-3 || u > 1 + 1e-3 || v < -1e-3 || v > 1 + 1e-3) return null
  return { u: Math.max(0, Math.min(1, u)), v: Math.max(0, Math.min(1, v)) }
}

/** Test point-in-trapezoid. */
export function isInsideTrapezoid(p: Point2D, t: SceneWalkTrapezoid): boolean {
  return pointToTrapezoidUV(p, t) !== null
}

/** Scale de perspective au paramètre v (0 = top, 1 = bottom). */
export function scaleAtV(v: number, t: SceneWalkTrapezoid): number {
  const c = Math.max(0, Math.min(1, v))
  return t.scaleAtTop + (t.scaleAtBottom - t.scaleAtTop) * c
}

/** V dérivé directement de Y (axe-aligné top/bottom) — plus robuste que l'UV bilinéaire
 *  pour la perspective : top.yAvg → 0, bottom.yAvg → 1. */
export function vFromY(y: number, t: SceneWalkTrapezoid): number {
  const topY = (t.topLeft.y + t.topRight.y) / 2
  const botY = (t.bottomLeft.y + t.bottomRight.y) / 2
  if (Math.abs(botY - topY) < 1e-6) return 0
  return Math.max(0, Math.min(1, (y - topY) / (botY - topY)))
}

/** Scale de perspective dérivé directement du Y du point. */
export function scaleAtY(y: number, t: SceneWalkTrapezoid): number {
  return scaleAtV(vFromY(y, t), t)
}

/** X du bord gauche du trap à une hauteur Y donnée (interp top↔bottom). */
export function leftEdgeXAtY(y: number, t: SceneWalkTrapezoid): number {
  const dy = t.bottomLeft.y - t.topLeft.y
  const v = Math.abs(dy) < 1e-6 ? 0 : Math.max(0, Math.min(1, (y - t.topLeft.y) / dy))
  return t.topLeft.x + (t.bottomLeft.x - t.topLeft.x) * v
}

/** X du bord droit du trap à une hauteur Y donnée. */
export function rightEdgeXAtY(y: number, t: SceneWalkTrapezoid): number {
  const dy = t.bottomRight.y - t.topRight.y
  const v = Math.abs(dy) < 1e-6 ? 0 : Math.max(0, Math.min(1, (y - t.topRight.y) / dy))
  return t.topRight.x + (t.bottomRight.x - t.topRight.x) * v
}

/** Intersection segment [p0, p1] avec segment [q0, q1]. Retourne le paramètre t∈[0,1] sur p0→p1 ou null. */
function segmentSegmentParam(p0: Point2D, p1: Point2D, q0: Point2D, q1: Point2D): number | null {
  const r = sub(p1, p0)
  const s = sub(q1, q0)
  const rxs = cross(r, s)
  if (Math.abs(rxs) < 1e-9) return null
  const qp = sub(q0, p0)
  const t = cross(qp, s) / rxs
  const u = cross(qp, r) / rxs
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return t
}

/** Sortie de la demi-droite origin→target hors du trapèze. Si target est dans le trapèze, retourne target. */
export function segmentTrapezoidExit(origin: Point2D, target: Point2D, t: SceneWalkTrapezoid): Point2D {
  if (isInsideTrapezoid(target, t)) return { ...target }
  const edges: [Point2D, Point2D][] = [
    [t.topLeft, t.topRight],
    [t.topRight, t.bottomRight],
    [t.bottomRight, t.bottomLeft],
    [t.bottomLeft, t.topLeft],
  ]
  let bestT = Infinity
  for (const [a, b] of edges) {
    const tt = segmentSegmentParam(origin, target, a, b)
    if (tt != null && tt > 1e-4 && tt < bestT) bestT = tt
  }
  if (!isFinite(bestT)) {
    // Origin déjà hors → projette target sur l'arête la plus proche
    return clampPointToTrapezoid(target, t)
  }
  // Recule légèrement de l'arête pour rester strictement à l'intérieur
  const eps = 0.999
  return {
    x: origin.x + (target.x - origin.x) * bestT * eps,
    y: origin.y + (target.y - origin.y) * bestT * eps,
  }
}

/** Projette un point sur le bord du trapèze le plus proche. Si déjà dedans, retourne tel quel. */
export function clampPointToTrapezoid(p: Point2D, t: SceneWalkTrapezoid): Point2D {
  if (isInsideTrapezoid(p, t)) return { ...p }
  const edges: [Point2D, Point2D][] = [
    [t.topLeft, t.topRight],
    [t.topRight, t.bottomRight],
    [t.bottomRight, t.bottomLeft],
    [t.bottomLeft, t.topLeft],
  ]
  let best: Point2D = { ...p }
  let bestDist = Infinity
  for (const [a, b] of edges) {
    const ab = sub(b, a)
    const ap = sub(p, a)
    const lenSq = dot(ab, ab) || 1
    const tt = Math.max(0, Math.min(1, dot(ap, ab) / lenSq))
    const proj: Point2D = { x: a.x + ab.x * tt, y: a.y + ab.y * tt }
    const dx = proj.x - p.x
    const dy = proj.y - p.y
    const d2 = dx * dx + dy * dy
    if (d2 < bestDist) { bestDist = d2; best = proj }
  }
  return best
}

/** Construit un trapèze par défaut couvrant ~60% en largeur centré, mi-haut 50% → bas 80% du layer. */
export function defaultTrapezoid(layerWidth: number, layerHeight: number, walkAnimationId: string): SceneWalkTrapezoid {
  const w = layerWidth || 1920
  const h = layerHeight || 1080
  const cx = w / 2
  const yTop = h * 0.55
  const yBot = h * 0.85
  const halfTop = w * 0.25
  const halfBot = w * 0.40
  return {
    topLeft: { x: cx - halfTop, y: yTop },
    topRight: { x: cx + halfTop, y: yTop },
    bottomRight: { x: cx + halfBot, y: yBot },
    bottomLeft: { x: cx - halfBot, y: yBot },
    scaleAtTop: 0.7,
    scaleAtBottom: 1.15,
    tiltDegMax: 6,
    skewYMax: 0.08,
    walkAnimationId,
    walkSpeedPxPerSec: 250,
  }
}
