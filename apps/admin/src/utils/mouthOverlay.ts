import * as PIXI from 'pixi.js'
import earcut from 'earcut'
import type { MouthDefinition, Point2D } from '../types/project'
import { flattenClosedBezier } from './bezierUtils'
import { interpolateInternalPoint } from './barycentricUtils'
import { computeUVs, type ContentAlignment } from './textureExtractor'

const SAMPLES_PER_SEGMENT = 24

function rotatePoint(p: Point2D, pivot: Point2D, angleRad: number): Point2D {
  const c = Math.cos(angleRad), s = Math.sin(angleRad)
  const dx = p.x - pivot.x, dy = p.y - pivot.y
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c }
}

/**
 * Mâchoire basse animée — rendue au-dessus du body mesh.
 *
 * Les nœuds Bézier sont ancrés via barycentriques au body mesh (image coords) ;
 * à chaque frame on résout les positions courantes, on flatten la Bézier puis on
 * applique une rotation rigide autour de la charnière, paramétrée par `openness ∈ [0,1]`.
 *
 * La topologie (indices earcut) et les UVs sont fixes : la texture suit le mesh
 * comme pour le body.
 */
export class MouthOverlay {
  private mouth: MouthDefinition
  private bodyTriangles: [number, number, number][]
  private container: PIXI.Container
  private mesh: PIXI.Mesh
  private geometry: PIXI.MeshGeometry
  private numVerts: number
  private destroyed = false

  constructor(
    mouth: MouthDefinition,
    parent: PIXI.Container,
    bodyPointsFrame0: Point2D[],
    bodyTriangles: [number, number, number][],
    texture: PIXI.Texture,
    imgW: number,
    imgH: number,
    contentAlignment?: ContentAlignment | null,
  ) {
    this.mouth = mouth
    this.bodyTriangles = bodyTriangles

    // Résoudre les ancres frame 0 (positions image) pour avoir des UVs cohérents
    const refs = mouth.contourBodyAnchors ?? mouth.contourAnchors
    const resolvedAnchors: Point2D[] = refs.map(r =>
      interpolateInternalPoint(r, bodyPointsFrame0, bodyTriangles)
    )
    // Reconstruire les BezierNodes avec ancres résolues + handles relatifs
    const nodesResolved = mouth.bezierNodes.map((n, i) => {
      const a = resolvedAnchors[i]
      const dx = a.x - n.anchor.x
      const dy = a.y - n.anchor.y
      return {
        anchor: a,
        handleIn: { x: n.handleIn.x + dx, y: n.handleIn.y + dy },
        handleOut: { x: n.handleOut.x + dx, y: n.handleOut.y + dy },
        smooth: n.smooth,
      }
    })
    const flattened = flattenClosedBezier(nodesResolved, SAMPLES_PER_SEGMENT)
    this.numVerts = flattened.length

    // Triangulation interne par earcut (réutilisée chaque frame)
    const flat: number[] = []
    for (const p of flattened) { flat.push(p.x, p.y) }
    const indices = new Uint32Array(earcut(flat))

    // UVs : positions frame 0 mappées sur la texture du scan (avec alignment)
    const uvs = computeUVs(flattened, imgW, imgH, contentAlignment ?? undefined)

    const vertices = new Float32Array(this.numVerts * 2)
    for (let i = 0; i < this.numVerts; i++) {
      vertices[i * 2] = flattened[i].x
      vertices[i * 2 + 1] = flattened[i].y
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
    const material = new PIXI.MeshMaterial(texture)
    this.mesh = new PIXI.Mesh(this.geometry, material)
    this.mesh.zIndex = 9998 // sous les yeux (9999), au-dessus du body

    this.container = new PIXI.Container()
    this.container.zIndex = 9998
    this.container.addChild(this.mesh)
    parent.addChild(this.container)
  }

  /** Recalcule les positions du mesh pour la frame courante.
   *  `bodyPositions` : positions courantes du body mesh (image coords).
   *  `openness` ∈ [0,1] : pilote l'angle de rotation autour de la charnière. */
  update(
    bodyPositions: Point2D[] | null,
    scale: number,
    offsetX: number,
    offsetY: number,
    openness: number,
  ): void {
    if (this.destroyed) return
    const positions = bodyPositions ?? null
    if (!positions) return

    // 1. Résoudre les ancres pour la frame courante
    const refs = this.mouth.contourBodyAnchors ?? this.mouth.contourAnchors
    const resolvedAnchors: Point2D[] = new Array(refs.length)
    for (let i = 0; i < refs.length; i++) {
      resolvedAnchors[i] = interpolateInternalPoint(refs[i], positions, this.bodyTriangles)
    }
    // 2. Reconstruire les BezierNodes avec offsets de handles conservés
    const nodes = this.mouth.bezierNodes.map((n, i) => {
      const a = resolvedAnchors[i]
      const dx = a.x - n.anchor.x
      const dy = a.y - n.anchor.y
      return {
        anchor: a,
        handleIn: { x: n.handleIn.x + dx, y: n.handleIn.y + dy },
        handleOut: { x: n.handleOut.x + dx, y: n.handleOut.y + dy },
        smooth: n.smooth,
      }
    })
    const flattened = flattenClosedBezier(nodes, SAMPLES_PER_SEGMENT)

    // 3. Charnière + rotation
    const hingeRef = this.mouth.hingeBodyAnchor ?? this.mouth.hingeAnchor
    const hinge = interpolateInternalPoint(hingeRef, positions, this.bodyTriangles)
    const angle = (openness * this.mouth.maxOpenAngleDeg * this.mouth.rotationSign * Math.PI) / 180

    // 4. Écriture des vertices (image coords → screen)
    const buf = this.geometry.getBuffer('aVertexPosition')
    const arr = buf.data as unknown as Float32Array
    const n = Math.min(flattened.length, this.numVerts)
    if (Math.abs(angle) < 1e-4) {
      for (let i = 0; i < n; i++) {
        arr[i * 2] = flattened[i].x * scale + offsetX
        arr[i * 2 + 1] = flattened[i].y * scale + offsetY
      }
    } else {
      for (let i = 0; i < n; i++) {
        const rp = rotatePoint(flattened[i], hinge, angle)
        arr[i * 2] = rp.x * scale + offsetX
        arr[i * 2 + 1] = rp.y * scale + offsetY
      }
    }
    buf.update()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.container.destroy({ children: true })
  }
}
