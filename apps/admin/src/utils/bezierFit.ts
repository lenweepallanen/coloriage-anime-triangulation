/**
 * Fitting automatique d'une courbe Bézier sur un polygone, à la
 * Schneider (Graphics Gems I, 1990).
 *
 * Principe :
 *   1. Détecte les coins (vertex anguleux > seuil).
 *   2. Découpe le polygone en arcs entre coins.
 *   3. Pour chaque arc : `fitCubic` (subdivision récursive + LSQ + Newton).
 *   4. Stitche les cubics en BezierNode[].
 *
 * Conséquence : ligne droite → 1 cubic, courbe à variation rapide → bcp
 * d'anchors aux bons endroits, coins → anchors `smooth=false`.
 */

import type { Point2D, BezierNode } from '../types/project'

export interface FitBezierOptions {
  /** Erreur max acceptable en pixels (distance point ↔ cubic). */
  tolerance: number
  /** Vertex anguleux : si l'angle de rotation > ce seuil (en degrés), c'est un coin.
   *  0° = aucun coin, 180° = tout le monde est coin. Typiquement 30–90. */
  cornerThresholdDeg: number
  /** Optionnel : fenêtre de lissage utilisée pour la détection de coins (px d'arc).
   *  Évite les faux coins dus au bruit Canny. Défaut 3. */
  cornerSmoothWindow?: number
}

// ─── Vector helpers ───────────────────────────────────────────────────

type V = { x: number; y: number }
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s })
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y
const len = (a: V): number => Math.hypot(a.x, a.y)
const norm = (a: V): V => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l } }

// ─── Cubic Bézier evaluation + derivatives ────────────────────────────

type Cubic = [V, V, V, V]   // [P0, CP1, CP2, P3]

function bezierAt(b: Cubic, t: number): V {
  const mt = 1 - t
  const mt2 = mt * mt, mt3 = mt2 * mt
  const t2 = t * t, t3 = t2 * t
  return {
    x: mt3 * b[0].x + 3 * mt2 * t * b[1].x + 3 * mt * t2 * b[2].x + t3 * b[3].x,
    y: mt3 * b[0].y + 3 * mt2 * t * b[1].y + 3 * mt * t2 * b[2].y + t3 * b[3].y,
  }
}

// B'(t) — first derivative (degree 2)
function bezierD1(b: Cubic, t: number): V {
  const mt = 1 - t
  return {
    x: 3 * mt * mt * (b[1].x - b[0].x) + 6 * mt * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * mt * mt * (b[1].y - b[0].y) + 6 * mt * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  }
}

// B''(t) — second derivative (degree 1)
function bezierD2(b: Cubic, t: number): V {
  const mt = 1 - t
  return {
    x: 6 * mt * (b[2].x - 2 * b[1].x + b[0].x) + 6 * t * (b[3].x - 2 * b[2].x + b[1].x),
    y: 6 * mt * (b[2].y - 2 * b[1].y + b[0].y) + 6 * t * (b[3].y - 2 * b[2].y + b[1].y),
  }
}

// ─── Tangent estimators ───────────────────────────────────────────────

function centerTangent(pts: V[], center: number): V {
  const v1 = sub(pts[center - 1], pts[center])
  const v2 = sub(pts[center], pts[center + 1])
  return norm({ x: (v1.x + v2.x) / 2, y: (v1.y + v2.y) / 2 })
}

// ─── Chord-length parameterization ────────────────────────────────────

function chordLengthParam(pts: V[], first: number, last: number): number[] {
  const u: number[] = [0]
  for (let i = first + 1; i <= last; i++) {
    u.push(u[u.length - 1] + len(sub(pts[i], pts[i - 1])))
  }
  const total = u[u.length - 1] || 1
  return u.map(x => x / total)
}

// ─── Generate bezier from data points + endpoint tangents (LSQ) ───────

function generateBezier(
  pts: V[], first: number, last: number, u: number[], tHat1: V, tHat2: V,
): Cubic {
  const n = last - first + 1
  // A[i][j] : direction vectors for control points 1 (j=0) and 2 (j=1)
  const A: V[][] = []
  for (let i = 0; i < n; i++) {
    const t = u[i], mt = 1 - t
    A.push([
      mul(tHat1, 3 * mt * mt * t),
      mul(tHat2, 3 * mt * t * t),
    ])
  }
  // Build linear system C·alpha = X
  let C00 = 0, C01 = 0, C10 = 0, C11 = 0, X0 = 0, X1 = 0
  for (let i = 0; i < n; i++) {
    C00 += dot(A[i][0], A[i][0])
    C01 += dot(A[i][0], A[i][1])
    C10 += C01   // symmetric
    C11 += dot(A[i][1], A[i][1])
    // tmp = points[first+i] - B0(t)*P0 - B3(t)*P3 (Bernstein basis weights summing P0/P3 contribution)
    const t = u[i], mt = 1 - t
    const t2 = t * t, t3 = t2 * t
    const mt2 = mt * mt, mt3 = mt2 * mt
    const p0 = pts[first], p3 = pts[last]
    const tmp: V = {
      x: pts[first + i].x - (mt3 * p0.x + 3 * mt2 * t * p0.x + 3 * mt * t2 * p3.x + t3 * p3.x),
      y: pts[first + i].y - (mt3 * p0.y + 3 * mt2 * t * p0.y + 3 * mt * t2 * p3.y + t3 * p3.y),
    }
    X0 += dot(A[i][0], tmp)
    X1 += dot(A[i][1], tmp)
  }
  // Solve 2×2 system
  const det = C00 * C11 - C01 * C10
  const detA1 = X0 * C11 - C01 * X1
  const detA2 = C00 * X1 - X0 * C10
  let alpha1 = det !== 0 ? detA1 / det : 0
  let alpha2 = det !== 0 ? detA2 / det : 0

  // Heuristique Schneider : si alpha trop petit, fallback à 1/3 distance.
  const segLen = len(sub(pts[last], pts[first]))
  const epsilon = 1e-6 * segLen
  if (alpha1 < epsilon || alpha2 < epsilon) {
    const fallback = segLen / 3
    alpha1 = alpha2 = fallback
  }

  return [
    pts[first],
    add(pts[first], mul(tHat1, alpha1)),
    add(pts[last], mul(tHat2, alpha2)),
    pts[last],
  ]
}

// ─── Max error (point ↔ bezier) + split point ─────────────────────────

function computeMaxError(
  pts: V[], first: number, last: number, b: Cubic, u: number[],
): { maxError: number; splitIndex: number } {
  let maxError = 0
  let splitIndex = Math.floor((last - first + 1) / 2)
  for (let i = 1; i < last - first; i++) {
    const p = bezierAt(b, u[i])
    const d = len(sub(p, pts[first + i]))
    if (d * d > maxError) {
      maxError = d * d
      splitIndex = first + i
    }
  }
  return { maxError: Math.sqrt(maxError), splitIndex }
}

// ─── Newton-Raphson reparameterization ────────────────────────────────

function newtonRefineU(b: Cubic, p: V, u: number): number {
  const d = sub(bezierAt(b, u), p)
  const d1 = bezierD1(b, u)
  const d2 = bezierD2(b, u)
  const num = dot(d, d1)
  const den = dot(d1, d1) + dot(d, d2)
  if (den === 0) return u
  return u - num / den
}

function reparameterize(pts: V[], first: number, _last: number, u: number[], b: Cubic): number[] {
  return u.map((ui, i) => newtonRefineU(b, pts[first + i], ui))
}

// ─── FitCubic récursif (Schneider) ────────────────────────────────────

function fitCubic(
  pts: V[], first: number, last: number, tHat1: V, tHat2: V, error: number, depth = 0,
): Cubic[] {
  if (last - first + 1 < 2) return []
  if (last - first + 1 === 2) {
    // Trivial : 2 points → ligne droite
    const dist = len(sub(pts[last], pts[first])) / 3
    return [[
      pts[first],
      add(pts[first], mul(tHat1, dist)),
      add(pts[last], mul(tHat2, dist)),
      pts[last],
    ]]
  }
  let u = chordLengthParam(pts, first, last)
  let bez = generateBezier(pts, first, last, u, tHat1, tHat2)
  let { maxError, splitIndex } = computeMaxError(pts, first, last, bez, u)
  if (maxError < error) return [bez]

  // Newton refinement (Schneider : si erreur < error^2, tente 4 itérations)
  if (maxError < error * error && depth < 6) {
    for (let i = 0; i < 4; i++) {
      const uPrime = reparameterize(pts, first, last, u, bez)
      const bezPrime = generateBezier(pts, first, last, uPrime, tHat1, tHat2)
      const r = computeMaxError(pts, first, last, bezPrime, uPrime)
      if (r.maxError < error) return [bezPrime]
      u = uPrime; bez = bezPrime; maxError = r.maxError; splitIndex = r.splitIndex
    }
  }

  if (depth > 32) return [bez]   // garde-fou récursion

  const tHatC = centerTangent(pts, splitIndex)
  const left = fitCubic(pts, first, splitIndex, tHat1, tHatC, error, depth + 1)
  const right = fitCubic(pts, splitIndex, last, mul(tHatC, -1), tHat2, error, depth + 1)
  return [...left, ...right]
}

// ─── Corner detection ─────────────────────────────────────────────────

/** Lisse un polygone fermé par moyenne mobile (fenêtre de `window` voisins de chaque côté). */
function smoothClosed(polygon: V[], window: number): V[] {
  if (window <= 0) return polygon
  const N = polygon.length
  const out: V[] = []
  for (let i = 0; i < N; i++) {
    let sx = 0, sy = 0, count = 0
    for (let k = -window; k <= window; k++) {
      const p = polygon[(i + k + N) % N]
      sx += p.x; sy += p.y; count++
    }
    out.push({ x: sx / count, y: sy / count })
  }
  return out
}

/** Renvoie les indices des coins du polygone fermé (angle de rotation > seuil). */
function detectCorners(polygon: V[], thresholdDeg: number, smoothWindow: number): number[] {
  if (thresholdDeg >= 180) return []
  const smoothed = smoothClosed(polygon, smoothWindow)
  const N = polygon.length
  const threshRad = (thresholdDeg * Math.PI) / 180
  const corners: number[] = []
  for (let i = 0; i < N; i++) {
    const prev = smoothed[(i - 1 + N) % N]
    const curr = smoothed[i]
    const next = smoothed[(i + 1) % N]
    const a1 = Math.atan2(curr.y - prev.y, curr.x - prev.x)
    const a2 = Math.atan2(next.y - curr.y, next.x - curr.x)
    let turn = a2 - a1
    while (turn > Math.PI) turn -= 2 * Math.PI
    while (turn < -Math.PI) turn += 2 * Math.PI
    if (Math.abs(turn) > threshRad) corners.push(i)
  }
  // Non-maximum suppression : si plusieurs coins consécutifs, garde le plus marqué.
  if (corners.length < 2) return corners
  const merged: number[] = []
  let i = 0
  while (i < corners.length) {
    let j = i
    while (j + 1 < corners.length && (corners[j + 1] - corners[j]) <= Math.max(2, smoothWindow)) j++
    merged.push(corners[Math.floor((i + j) / 2)])
    i = j + 1
  }
  return merged
}

// ─── Stitch cubics → BezierNode[] (open arc) ──────────────────────────

function cubicsToOpenNodes(cubics: Cubic[]): BezierNode[] {
  if (cubics.length === 0) return []
  const out: BezierNode[] = []
  // Premier anchor : handleIn = miroir handleOut (placeholder, sera réécrit par le caller pour les coins)
  out.push({
    anchor: cubics[0][0],
    handleIn: { x: cubics[0][0].x, y: cubics[0][0].y },   // placeholder
    handleOut: cubics[0][1],
    smooth: true,
  })
  for (let i = 0; i < cubics.length - 1; i++) {
    const cur = cubics[i], nxt = cubics[i + 1]
    out.push({
      anchor: cur[3],
      handleIn: cur[2],
      handleOut: nxt[1],
      smooth: true,
    })
  }
  const last = cubics[cubics.length - 1]
  out.push({
    anchor: last[3],
    handleIn: last[2],
    handleOut: { x: last[3].x, y: last[3].y },   // placeholder
    smooth: true,
  })
  return out
}

// ─── Main entry — fit closed polygon → BezierNode[] ───────────────────

export function fitBezierToClosedPolygon(
  polygon: Point2D[],
  options: FitBezierOptions,
): BezierNode[] {
  if (polygon.length < 4) return []
  const tol = Math.max(0.1, options.tolerance)
  const win = Math.max(0, options.cornerSmoothWindow ?? 3)
  const corners = detectCorners(polygon, options.cornerThresholdDeg, win)

  const N = polygon.length

  if (corners.length === 0) {
    // Pas de coin → fit sur la polyline rallongée (premier point répété)
    const opened: V[] = polygon.concat([polygon[0]])
    const tHat1 = norm(sub(opened[1], opened[0]))
    const tHat2 = norm(sub(opened[opened.length - 2], opened[opened.length - 1]))
    const cubics = fitCubic(opened, 0, opened.length - 1, tHat1, tHat2, tol)
    const nodes = cubicsToOpenNodes(cubics)
    if (nodes.length < 2) return []
    // Stitch first/last : le dernier anchor doit fusionner avec le premier
    // → on retire le dernier et on reporte son handleIn sur le premier.
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    first.handleIn = last.handleIn
    return nodes.slice(0, -1)
  }

  // Avec coins : pour chaque arc [corner_k, corner_{k+1}] (cyclique), fit
  // comme arc ouvert. Les coins deviennent des anchors `smooth=false`.
  const sorted = [...corners].sort((a, b) => a - b)
  const nodes: BezierNode[] = []
  for (let k = 0; k < sorted.length; k++) {
    const ci = sorted[k]
    const cn = sorted[(k + 1) % sorted.length]
    // Extrait l'arc [ci, ci+1, ..., cn] cycliquement
    const arc: V[] = []
    let idx = ci
    while (true) {
      arc.push(polygon[idx])
      if (idx === cn) break
      idx = (idx + 1) % N
      if (arc.length > N + 1) break
    }
    if (arc.length < 2) continue

    let arcNodes: BezierNode[]
    if (arc.length === 2) {
      const a = arc[0], b = arc[1]
      const d = len(sub(b, a)) / 3
      const dir = norm(sub(b, a))
      arcNodes = [
        { anchor: a, handleIn: a, handleOut: add(a, mul(dir, d)), smooth: false },
        { anchor: b, handleIn: sub(b, mul(dir, d)), handleOut: b, smooth: false },
      ]
    } else {
      const tHat1 = norm(sub(arc[1], arc[0]))
      const tHat2 = norm(sub(arc[arc.length - 2], arc[arc.length - 1]))
      const cubics = fitCubic(arc, 0, arc.length - 1, tHat1, tHat2, tol)
      arcNodes = cubicsToOpenNodes(cubics)
    }
    if (arcNodes.length < 2) continue
    // 1er et dernier nœuds = coins (smooth=false) ; placeholder handles → restent identiques au point
    arcNodes[0].smooth = false
    arcNodes[arcNodes.length - 1].smooth = false
    arcNodes[0].handleIn = { x: arcNodes[0].anchor.x, y: arcNodes[0].anchor.y }
    arcNodes[arcNodes.length - 1].handleOut = { x: arcNodes[arcNodes.length - 1].anchor.x, y: arcNodes[arcNodes.length - 1].anchor.y }

    // Stitch avec le précédent : si nodes[-1].anchor === arcNodes[0].anchor, on fusionne.
    if (nodes.length > 0 && k > 0) {
      const prev = nodes[nodes.length - 1]
      // Le coin a deux handles : le handleIn vient du dernier cubic de l'arc précédent,
      // le handleOut vient du premier cubic de l'arc courant.
      prev.handleOut = arcNodes[0].handleOut
      // Avance dans arcNodes : on saute le 1er (déjà absorbé par prev)
      for (let j = 1; j < arcNodes.length; j++) nodes.push(arcNodes[j])
    } else {
      for (const n of arcNodes) nodes.push(n)
    }
  }
  // Boucle finale : le dernier anchor (= 1er coin re-traversé) doit fusionner avec nodes[0].
  if (nodes.length > 1) {
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (len(sub(first.anchor, last.anchor)) < 1e-3) {
      // Le handleOut du « dernier » (qui est l'arc se refermant sur le 1er coin) doit
      // remplacer le handleOut du 1er nœud.
      first.handleOut = last.handleOut
      nodes.pop()
    }
  }
  return nodes
}
