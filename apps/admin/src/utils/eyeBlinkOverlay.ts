import * as PIXI from 'pixi.js'
import type { EyeRegion, Point2D, Project, ProjectEyes } from '../types/project'
import { computeAllBarycentrics, interpolateInternalPoint } from './barycentricUtils'

/** Find a body mesh (frame-0 image coords + triangles) used to deform eye polygons
 *  during walk / members-bones animations. */
export function getEyeBodyMeshData(project: Project): {
  bodyPoints: Point2D[]
  bodyTriangles: [number, number, number][]
} | null {
  const tri = project.projectTriangulation
  if (tri?.bodyPoints && tri.bodyTriangles && tri.bodyPoints.length > 0 && tri.bodyTriangles.length > 0) {
    return { bodyPoints: tri.bodyPoints, bodyTriangles: tri.bodyTriangles }
  }
  for (const anim of project.animations) {
    const sep = anim.mesh?.walkLimbSeparation
    if (sep?.bodyPoints && sep.bodyTriangles && sep.bodyPoints.length > 0 && sep.bodyTriangles.length > 0) {
      return { bodyPoints: sep.bodyPoints, bodyTriangles: sep.bodyTriangles }
    }
  }
  return null
}

/** Returns the mesh (frame-0 image coords + triangles) used to anchor the mouth.
 *  For attachZoneId === 'body' or undefined → body mesh (same as getEyeBodyMeshData).
 *  For any other zone id → projectTriangulation.zonePoints/zoneTriangles for that zone. */
export function getMouthAttachMesh(project: Project, attachZoneId: string | undefined): {
  points: Point2D[]
  triangles: [number, number, number][]
} | null {
  const zoneId = attachZoneId ?? 'body'
  if (zoneId === 'body') {
    const m = getEyeBodyMeshData(project)
    return m ? { points: m.bodyPoints, triangles: m.bodyTriangles } : null
  }
  const tri = project.projectTriangulation
  const pts = tri?.zonePoints?.[zoneId]
  const tris = tri?.zoneTriangles?.[zoneId]
  if (pts && tris && pts.length > 0 && tris.length > 0) {
    return { points: pts, triangles: tris }
  }
  return null
}

type BlinkPhase = 'idle' | 'closing' | 'opening'

interface BlinkState {
  phase: BlinkPhase
  timer: number       // ms accumulated in current phase
  duration: number    // total duration of current closing/opening half (ms)
  nextDelay: number   // ms until next blink (idle phase)
  pendingDouble: boolean
}

/** Slice the mesh's full position array down to the tracked-only positions
 *  in the order [...contourAnchors, ...anchorPoints] matching trackedTriangles. */
export interface TrackedSlice {
  nContourAnchors: number
  nContourSubdivision: number
  nAnchorPoints: number
}

export function extractTrackedPositions(all: Point2D[], slice: TrackedSlice): Point2D[] {
  const out: Point2D[] = []
  for (let i = 0; i < slice.nContourAnchors; i++) out.push(all[i])
  const base = slice.nContourAnchors + slice.nContourSubdivision
  for (let i = 0; i < slice.nAnchorPoints; i++) out.push(all[base + i])
  return out
}

/** Clip a polygon against a half-plane. `keep` = 'above' keeps y <= cutY, 'below' keeps y >= cutY. */
function clipPolygonY(poly: Point2D[], cutY: number, keep: 'above' | 'below'): Point2D[] {
  if (poly.length < 3) return []
  const inside = (y: number) => keep === 'above' ? y <= cutY : y >= cutY
  const out: Point2D[] = []
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]
    const next = poly[(i + 1) % poly.length]
    const curIn = inside(cur.y)
    const nextIn = inside(next.y)
    if (curIn) out.push(cur)
    if (curIn !== nextIn) {
      const dy = next.y - cur.y
      const t = Math.abs(dy) < 1e-6 ? 0 : (cutY - cur.y) / dy
      out.push({ x: cur.x + t * (next.x - cur.x), y: cutY })
    }
  }
  return out
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/** Parse une couleur hex ('#rgb' ou '#rrggbb') en nombre PIXI. Fallback fourni. */
function hexToNum(hex: string | undefined, fallback: number): number {
  if (!hex) return fallback
  let h = hex.trim().replace('#', '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  const n = parseInt(h, 16)
  return Number.isFinite(n) ? n : fallback
}

/** Repère local d'un œil à partir de son polygone (n'importe quel espace de coords).
 *  ux suit le vecteur centre→premier point (tourne avec l'œil). halfU/halfV =
 *  demi-extensions du polygone le long des axes locaux. */
export interface EyeFrame {
  center: Point2D
  ux: number; uy: number
  vx: number; vy: number
  halfU: number; halfV: number
}

export function computeEyeFrame(poly: Point2D[]): EyeFrame {
  let cx = 0, cy = 0
  for (const p of poly) { cx += p.x; cy += p.y }
  cx /= poly.length; cy /= poly.length
  let ux = poly[0].x - cx, uy = poly[0].y - cy
  const n = Math.hypot(ux, uy)
  if (n < 1e-6) { ux = 1; uy = 0 } else { ux /= n; uy /= n }
  const vx = -uy, vy = ux
  let halfU = 0, halfV = 0
  for (const p of poly) {
    const dx = p.x - cx, dy = p.y - cy
    halfU = Math.max(halfU, Math.abs(dx * ux + dy * uy))
    halfV = Math.max(halfV, Math.abs(dx * vx + dy * vy))
  }
  return { center: { x: cx, y: cy }, ux, uy, vx, vy, halfU, halfV }
}

export interface EyeAttachMesh {
  triangles: [number, number, number][]
  pointsFrame0: Point2D[]
}
/** Maillages d'attache par zone (clé = attachZoneId, 'body' inclus). */
export type EyeAttachMeshes = Record<string, EyeAttachMesh>

/** Construit les maillages d'attache (frame 0) pour tous les yeux : 'body' + chaque
 *  zone patte de projectTriangulation, sinon fallback body legacy (walkLimbSeparation). */
export function buildEyeAttachMeshes(project: Project): EyeAttachMeshes | null {
  const tri = project.projectTriangulation
  if (tri?.bodyPoints && tri.bodyTriangles && tri.bodyPoints.length > 0 && tri.bodyTriangles.length > 0) {
    const out: EyeAttachMeshes = { body: { triangles: tri.bodyTriangles, pointsFrame0: tri.bodyPoints } }
    for (const zid of Object.keys(tri.zonePoints ?? {})) {
      const pts = tri.zonePoints?.[zid]
      const trs = tri.zoneTriangles?.[zid]
      if (pts && trs && pts.length > 0 && trs.length > 0) out[zid] = { triangles: trs, pointsFrame0: pts }
    }
    return out
  }
  const m = getEyeBodyMeshData(project)
  if (m) return { body: { triangles: m.bodyTriangles, pointsFrame0: m.bodyPoints } }
  return null
}

export class EyeBlinkOverlay {
  private eyes: ProjectEyes
  private trackedTriangles: [number, number, number][] | null
  private slice: TrackedSlice | null
  private attachMeshes: EyeAttachMeshes | null
  private container: PIXI.Container
  private graphics: PIXI.Graphics[] = []
  private state: BlinkState

  constructor(
    eyes: ProjectEyes,
    parent: PIXI.Container,
    trackedTriangles: [number, number, number][] | null,
    slice: TrackedSlice | null,
    attachMeshes: EyeAttachMeshes | null = null,
  ) {
    this.eyes = eyes
    this.trackedTriangles = trackedTriangles
    this.slice = slice
    this.attachMeshes = attachMeshes
    // (Re)calcule TOUJOURS les bodyBarycentricRefs depuis le maillage de la zone
    // d'attache de chaque œil (source de vérité courante). Évite les refs périmés
    // après re-triangulation, et permet d'ancrer un œil à une zone précise.
    if (attachMeshes) {
      for (const eye of eyes.regions) {
        const zoneId = eye.attachZoneId ?? 'body'
        const m = attachMeshes[zoneId]
        if (m && m.triangles.length > 0 && m.pointsFrame0.length > 0 && eye.contourPoints.length >= 3) {
          eye.bodyBarycentricRefs = computeAllBarycentrics(eye.contourPoints, m.pointsFrame0, m.triangles)
        }
      }
    }
    this.container = new PIXI.Container()
    this.container.zIndex = 9999
    parent.addChild(this.container)
    for (let i = 0; i < eyes.regions.length; i++) {
      const g = new PIXI.Graphics()
      this.graphics.push(g)
      this.container.addChild(g)
    }
    this.state = {
      phase: 'idle',
      timer: 0,
      duration: this.eyes.blinkDurationMs / 2,
      nextDelay: this.randomInterval(),
      pendingDouble: false,
    }
  }

  private randomInterval(): number {
    const lo = this.eyes.blinkIntervalMinMs
    const hi = Math.max(lo + 100, this.eyes.blinkIntervalMaxMs)
    return lo + Math.random() * (hi - lo)
  }

  /** Compute eye polygon in image coords for current frame. Prefers body deformation
   *  (walk / members-bones) when bodyPositions + bodyBarycentricRefs are available. */
  private deformEye(
    eye: EyeRegion,
    allPositions: Point2D[] | null,
    bodyPositionsByZone: Record<string, Point2D[]> | null,
  ): Point2D[] {
    const zoneId = eye.attachZoneId ?? 'body'
    const m = this.attachMeshes?.[zoneId]
    const positions = bodyPositionsByZone?.[zoneId]
    if (
      positions
      && m
      && m.triangles.length > 0
      && eye.bodyBarycentricRefs
      && eye.bodyBarycentricRefs.length === eye.contourPoints.length
    ) {
      return eye.contourPoints.map((_, i) =>
        interpolateInternalPoint(eye.bodyBarycentricRefs![i], positions, m.triangles)
      )
    }
    if (
      allPositions
      && this.trackedTriangles
      && this.trackedTriangles.length > 0
      && this.slice
      && eye.barycentricRefs.length === eye.contourPoints.length
    ) {
      const tracked = extractTrackedPositions(allPositions, this.slice)
      return eye.contourPoints.map((_, i) =>
        interpolateInternalPoint(eye.barycentricRefs[i], tracked, this.trackedTriangles!)
      )
    }
    return eye.contourPoints
  }

  /**
   * @param pupilOffsets   Offsets pupille (anim courante).
   * @param prevPupilOffsets Offsets pupille de l'anim précédente, pour crossfade.
   * @param fadeT          Facteur de blend ∈ [0,1] : 0 = prev, 1 = current. Défaut 1.
   */
  update(
    allPositions: Point2D[] | null,
    bodyPositionsByZone: Record<string, Point2D[]> | null,
    scale: number,
    offsetX: number,
    offsetY: number,
    dtMs: number,
    pupilOffsets: Record<string, Point2D> | null = null,
    prevPupilOffsets: Record<string, Point2D> | null = null,
    fadeT: number = 1,
  ): void {
    if (this.eyes.regions.length === 0) {
      for (const g of this.graphics) g.clear()
      return
    }

    // Advance single shared blink state machine (all eyes blink in sync).
    // Si le clignement est désactivé, on reste en phase idle (progress = 0)
    // mais on dessine quand même l'œil.
    const st = this.state
    if (this.eyes.blinkEnabled) st.timer += dtMs
    if (!this.eyes.blinkEnabled) {
      st.phase = 'idle'
    } else if (st.phase === 'idle') {
      if (st.timer >= st.nextDelay) {
        st.phase = 'closing'
        st.timer = 0
        st.duration = this.eyes.blinkDurationMs / 2
        st.pendingDouble = Math.random() < this.eyes.doubleBlinkProbability
      }
    } else if (st.phase === 'closing') {
      if (st.timer >= st.duration) {
        st.phase = 'opening'
        st.timer = 0
      }
    } else if (st.phase === 'opening') {
      if (st.timer >= st.duration) {
        if (st.pendingDouble) {
          st.pendingDouble = false
          st.phase = 'closing'
          st.timer = 0
          st.duration = this.eyes.blinkDurationMs / 2
          st.nextDelay = 80
        } else {
          st.phase = 'idle'
          st.timer = 0
          st.nextDelay = this.randomInterval()
        }
      }
    }

    let progress = 0
    if (st.phase === 'closing') progress = easeInOutQuad(Math.min(1, st.timer / st.duration))
    else if (st.phase === 'opening') progress = 1 - easeInOutQuad(Math.min(1, st.timer / st.duration))

    for (let i = 0; i < this.eyes.regions.length; i++) {
      const eye = this.eyes.regions[i]
      const g = this.graphics[i]
      g.clear()

      // Deform polygon (image coords) → screen coords
      const polyImg = this.deformEye(eye, allPositions, bodyPositionsByZone)
      if (polyImg.length < 3) continue
      const polyScreen: Point2D[] = polyImg.map(p => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY }))

      const frame = computeEyeFrame(polyScreen)

      // ── Ellipse 1 : sclère (blanc + contour noir réglable) ──
      const scleraColor = hexToNum(eye.scleraColor, 0xffffff)
      const outlineColor = hexToNum(eye.outlineColor, 0x000000)
      const strokePx = Math.max(0, (eye.outlineThickness ?? 3) * scale)
      g.lineStyle({ width: strokePx, color: outlineColor, alpha: 1, alignment: 0.5 })
      g.beginFill(scleraColor, 1)
      g.moveTo(polyScreen[0].x, polyScreen[0].y)
      for (let k = 1; k < polyScreen.length; k++) g.lineTo(polyScreen[k].x, polyScreen[k].y)
      g.closePath()
      g.endFill()
      g.lineStyle(0)

      // ── Ellipse 2 : pupille (suit le point CoTracker, clampée par le compute) ──
      const minHalf = Math.min(frame.halfU, frame.halfV)
      const pupilR = Math.max(1, (eye.pupilRadiusFrac ?? 0.45) * minHalf)
      // Tracking actif → la pupille "regarde" le point CoTracker (offset déjà clampé
      // dans l'ellipse au pré-calcul, en unités image → écran via scale).
      // Sinon → position de repos des sliders (fraction des demi-axes).
      // Crossfade : blend entre prev et cur pour lisser les transitions d'animations.
      const baseU = (eye.pupilOffsetFrac?.x ?? 0) * frame.halfU
      const baseV = (eye.pupilOffsetFrac?.y ?? 0) * frame.halfV
      const curT = pupilOffsets?.[eye.id]
      const curU = curT ? curT.x * scale : baseU
      const curV = curT ? curT.y * scale : baseV
      const prevT = prevPupilOffsets?.[eye.id]
      const prevU = prevT ? prevT.x * scale : baseU
      const prevV = prevT ? prevT.y * scale : baseV
      const t = Math.max(0, Math.min(1, fadeT))
      let offU = prevU + (curU - prevU) * t
      let offV = prevV + (curV - prevV) * t
      const ax = Math.max(1, frame.halfU - pupilR)
      const ay = Math.max(1, frame.halfV - pupilR)
      const ecl = (offU * offU) / (ax * ax) + (offV * offV) / (ay * ay)
      if (ecl > 1) { const s = 1 / Math.sqrt(ecl); offU *= s; offV *= s }
      const pupilCx = frame.center.x + offU * frame.ux + offV * frame.vx
      const pupilCy = frame.center.y + offU * frame.uy + offV * frame.vy
      g.beginFill(hexToNum(eye.pupilColor, 0x000000), 1)
      g.drawCircle(pupilCx, pupilCy, pupilR)
      g.endFill()

      // ── Ellipse 3 : reflet (petit disque dans la pupille) ──
      const reflR = Math.max(0.5, (eye.reflectionRadiusFrac ?? 0.30) * pupilR)
      const roff = eye.reflectionOffsetFrac ?? { x: -0.3, y: -0.3 }
      const reflCx = pupilCx + roff.x * pupilR * frame.ux + roff.y * pupilR * frame.vx
      const reflCy = pupilCy + roff.x * pupilR * frame.uy + roff.y * pupilR * frame.vy
      g.beginFill(hexToNum(eye.reflectionColor, 0xffffff), 1)
      g.drawCircle(reflCx, reflCy, reflR)
      g.endFill()

      // ── Volet de clignement (par-dessus, masque pupille+reflet) ──
      if (progress > 0.001) {
        let minY = Infinity, maxY = -Infinity
        for (const p of polyScreen) {
          if (p.y < minY) minY = p.y
          if (p.y > maxY) maxY = p.y
        }
        const half = (maxY - minY) * (progress / 2)
        const topPoly = clipPolygonY(polyScreen, minY + half, 'above')
        const bottomPoly = clipPolygonY(polyScreen, maxY - half, 'below')
        g.lineStyle({ width: strokePx, color: outlineColor, alpha: 1, alignment: 0.5 })
        g.beginFill(outlineColor, 1)
        if (topPoly.length >= 3) {
          g.moveTo(topPoly[0].x, topPoly[0].y)
          for (let k = 1; k < topPoly.length; k++) g.lineTo(topPoly[k].x, topPoly[k].y)
          g.closePath()
        }
        if (bottomPoly.length >= 3) {
          g.moveTo(bottomPoly[0].x, bottomPoly[0].y)
          for (let k = 1; k < bottomPoly.length; k++) g.lineTo(bottomPoly[k].x, bottomPoly[k].y)
          g.closePath()
        }
        g.endFill()
        g.lineStyle(0)
      }
    }
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible
    if (!visible) for (const g of this.graphics) g.clear()
  }

  destroy(): void {
    for (const g of this.graphics) g.destroy()
    this.graphics = []
    this.container.destroy({ children: true })
  }
}
