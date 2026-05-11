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

const EYE_STROKE_PX = 2

export class EyeBlinkOverlay {
  private eyes: ProjectEyes
  private trackedTriangles: [number, number, number][] | null
  private slice: TrackedSlice | null
  private bodyTriangles: [number, number, number][] | null
  private container: PIXI.Container
  private graphics: PIXI.Graphics[] = []
  private state: BlinkState

  constructor(
    eyes: ProjectEyes,
    parent: PIXI.Container,
    trackedTriangles: [number, number, number][] | null,
    slice: TrackedSlice | null,
    bodyTriangles: [number, number, number][] | null = null,
    bodyPointsFrame0: Point2D[] | null = null,
  ) {
    this.eyes = eyes
    this.trackedTriangles = trackedTriangles
    this.slice = slice
    this.bodyTriangles = bodyTriangles
    // Auto-compute missing bodyBarycentricRefs for legacy eyes saved before body tracking
    // was supported. Mutates the eyes objects in place so subsequent saves persist them.
    if (bodyTriangles && bodyTriangles.length > 0 && bodyPointsFrame0 && bodyPointsFrame0.length > 0) {
      for (const eye of eyes.regions) {
        if (!eye.bodyBarycentricRefs || eye.bodyBarycentricRefs.length !== eye.contourPoints.length) {
          eye.bodyBarycentricRefs = computeAllBarycentrics(eye.contourPoints, bodyPointsFrame0, bodyTriangles)
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
    bodyPositions: Point2D[] | null,
  ): Point2D[] {
    if (
      bodyPositions
      && this.bodyTriangles
      && this.bodyTriangles.length > 0
      && eye.bodyBarycentricRefs
      && eye.bodyBarycentricRefs.length === eye.contourPoints.length
    ) {
      return eye.contourPoints.map((_, i) =>
        interpolateInternalPoint(eye.bodyBarycentricRefs![i], bodyPositions, this.bodyTriangles!)
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

  update(
    allPositions: Point2D[] | null,
    bodyPositions: Point2D[] | null,
    scale: number,
    offsetX: number,
    offsetY: number,
    dtMs: number,
  ): void {
    if (!this.eyes.blinkEnabled || this.eyes.regions.length === 0) {
      for (const g of this.graphics) g.clear()
      return
    }

    // Advance single shared blink state machine (all eyes blink in sync).
    const st = this.state
    st.timer += dtMs
    if (st.phase === 'idle') {
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
      if (progress <= 0.001) continue

      // Deform polygon (image coords) → screen coords
      const polyImg = this.deformEye(eye, allPositions, bodyPositions)
      if (polyImg.length < 3) continue
      const polyScreen: Point2D[] = polyImg.map(p => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY }))

      // Compute bbox in screen space
      let minY = Infinity, maxY = -Infinity
      for (const p of polyScreen) {
        if (p.y < minY) minY = p.y
        if (p.y > maxY) maxY = p.y
      }
      // Double eyelid : top descends, bottom rises, meet in the middle at progress=1.
      const half = (maxY - minY) * (progress / 2)
      const topCutY = minY + half
      const bottomCutY = maxY - half
      const topPoly = clipPolygonY(polyScreen, topCutY, 'above')
      const bottomPoly = clipPolygonY(polyScreen, bottomCutY, 'below')

      g.lineStyle({ width: EYE_STROKE_PX, color: 0x000000, alpha: 1, alignment: 0.5 })
      g.beginFill(0x000000, 1)
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

  destroy(): void {
    for (const g of this.graphics) g.destroy()
    this.graphics = []
    this.container.destroy({ children: true })
  }
}
