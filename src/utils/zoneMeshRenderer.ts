/**
 * Zone Mesh Renderer — Builds per-zone PIXI meshes for walk animations
 * with limb separation, enabling independent z-ordered rendering.
 *
 * New format: each zone has its own points + triangles (independent of rest mesh).
 * Body uses rest mesh triangles filtered by bodyTriangleIndices.
 */

import * as PIXI from 'pixi.js'
import type { Point2D, WalkLimbSeparation } from '../types/project'
import { computeUVs } from './textureExtractor'
import type { ContentAlignment } from './textureExtractor'

export interface ZoneMeshInfo {
  zoneId: string
  pixiMesh: PIXI.Mesh
  geometry: PIXI.MeshGeometry
  numVertices: number
  zOrder: number
}

export interface ZoneMeshSetup {
  container: PIXI.Container
  zoneMeshes: ZoneMeshInfo[]
  bodyMesh: ZoneMeshInfo
}

/**
 * Build PIXI meshes for each zone + body from a limb separation.
 */
export function buildZoneMeshes(
  separation: WalkLimbSeparation,
  allRestPoints: Point2D[],
  restTriangles: [number, number, number][],
  texture: PIXI.Texture,
  imageWidth: number,
  imageHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  contentAlignment?: ContentAlignment,
): ZoneMeshSetup {
  const container = new PIXI.Container()
  container.sortableChildren = true

  const zoneMeshes: ZoneMeshInfo[] = []

  // Build zone meshes (each zone has its own independent points + triangles)
  for (const zone of separation.zones) {
    const pts = separation.zonePoints[zone.id] || []
    const tris = separation.zoneTriangles[zone.id] || []
    if (pts.length === 0 || tris.length === 0) continue

    const info = buildMesh(zone.id, pts, tris, texture, imageWidth, imageHeight, scale, offsetX, offsetY, zone.zOrder, contentAlignment)
    zoneMeshes.push(info)
    container.addChild(info.pixiMesh)
  }

  // Build body mesh — use pre-computed bodyPoints/bodyTriangles if available, else derive from indices
  let bodyPts: Point2D[]
  let bodyTris: [number, number, number][]
  if (separation.bodyPoints && separation.bodyTriangles) {
    bodyPts = separation.bodyPoints
    bodyTris = separation.bodyTriangles
  } else {
    const bodyTriIndices = separation.bodyTriangleIndices
    const bodyVertSet = new Set<number>()
    for (const ti of bodyTriIndices) {
      const [a, b, c] = restTriangles[ti]
      bodyVertSet.add(a); bodyVertSet.add(b); bodyVertSet.add(c)
    }
    const bodyGlobalIndices = [...bodyVertSet].sort((a, b) => a - b)
    const g2l = new Map<number, number>()
    bodyGlobalIndices.forEach((gi, li) => g2l.set(gi, li))
    bodyPts = bodyGlobalIndices.map(gi => allRestPoints[gi])
    bodyTris = bodyTriIndices.map(ti => {
      const [a, b, c] = restTriangles[ti]
      return [g2l.get(a)!, g2l.get(b)!, g2l.get(c)!]
    })
  }

  const bodyInfo = buildMesh('__body__', bodyPts, bodyTris, texture, imageWidth, imageHeight, scale, offsetX, offsetY, 0, contentAlignment)
  container.addChild(bodyInfo.pixiMesh)

  return { container, zoneMeshes, bodyMesh: bodyInfo }
}

function buildMesh(
  zoneId: string,
  points: Point2D[],
  triangles: [number, number, number][],
  texture: PIXI.Texture,
  imageWidth: number,
  imageHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  zOrder: number,
  contentAlignment?: ContentAlignment,
): ZoneMeshInfo {
  const uvs = computeUVs(points, imageWidth, imageHeight, contentAlignment)

  const indices = new Uint16Array(triangles.length * 3)
  triangles.forEach(([a, b, c], i) => {
    indices[i * 3] = a; indices[i * 3 + 1] = b; indices[i * 3 + 2] = c
  })

  const vertices = new Float32Array(points.length * 2)
  points.forEach((p, i) => {
    vertices[i * 2] = p.x * scale + offsetX
    vertices[i * 2 + 1] = p.y * scale + offsetY
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const geometry = new PIXI.MeshGeometry(vertices as any, uvs as any, indices as any)
  const material = new PIXI.MeshMaterial(texture)
  const pixiMesh = new PIXI.Mesh(geometry, material)
  pixiMesh.zIndex = zOrder

  return { zoneId, pixiMesh, geometry, numVertices: points.length, zOrder }
}

/**
 * Update zone mesh vertices for a frame.
 */
export function updateZoneMeshVertices(
  meshInfo: ZoneMeshInfo,
  framePositions: Point2D[],
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const verts = meshInfo.geometry.getBuffer('aVertexPosition')
  const data = verts.data as unknown as Float32Array
  for (let i = 0; i < framePositions.length; i++) {
    data[i * 2] = framePositions[i].x * scale + offsetX
    data[i * 2 + 1] = framePositions[i].y * scale + offsetY
  }
  verts.update()
}
