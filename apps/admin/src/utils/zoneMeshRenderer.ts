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
export interface MouthHole {
  polygon: Point2D[]   // image coords, frame 0
  zoneId: string       // 'body' or zone id whose mesh to cut
}

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
  hiddenFaceMeshes: ZoneMeshInfo[]
  hiddenFaceLimbMeshes: ZoneMeshInfo[]
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
  hiddenFaceTexture?: PIXI.Texture,
  hiddenFaceLimbTextures?: Record<string, PIXI.Texture>,
): ZoneMeshSetup {
  const container = new PIXI.Container()
  container.sortableChildren = true

  const zoneMeshes: ZoneMeshInfo[] = []
  const hiddenFaceLimbMeshes: ZoneMeshInfo[] = []

  // Index des faces cachées par zone-mère (limbZoneId). Une zone peut avoir N entrées
  // (ex : aile cachée par body ET par tête = 2 entrées distinctes sur l'aile).
  const hflByZone = new Map<string, NonNullable<typeof separation.hiddenFaceLimbZones>>()
  if (separation.hiddenFaceLimbZones) {
    for (const hfl of separation.hiddenFaceLimbZones) {
      const list = hflByZone.get(hfl.limbZoneId) ?? []
      list.push(hfl)
      hflByZone.set(hfl.limbZoneId, list)
    }
  }

  // Build zone meshes (each zone has its own independent points + triangles)
  for (const zone of separation.zones) {
    const pts = separation.zonePoints[zone.id] || []
    const tris = separation.zoneTriangles[zone.id] || []
    if (pts.length === 0 || tris.length === 0) continue

    const hflEntries = hflByZone.get(zone.id) ?? []

    if (hflEntries.length > 0) {
      // Union de tous les indices d'extension pour exclure de la partie visible
      const allExtTriIdx = new Set<number>()
      for (const hfl of hflEntries) {
        for (const ti of hfl.zoneTriangleIndices) allExtTriIdx.add(ti)
      }
      const visibleTris = tris.filter((_, i) => !allExtTriIdx.has(i))

      // Visible part
      if (visibleTris.length > 0) {
        const info = buildMesh(zone.id, pts, visibleTris, texture, imageWidth, imageHeight, scale, offsetX, offsetY, zone.zOrder, contentAlignment)
        zoneMeshes.push(info)
        container.addChild(info.pixiMesh)
      }

      // Une sous-mesh PIXI par face cachée. Texture clé = HFL.id (fallback limbZoneId
      // pour rétro-compat). Z-order : zone.zOrder - 0.5 (juste derrière la zone-mère, donc
      // cachée par n'importe quelle zone de z-order supérieur).
      for (const hfl of hflEntries) {
        const extTris = hfl.zoneTriangleIndices.map(i => tris[i]).filter(Boolean)
        if (extTris.length === 0) continue
        const texKey = hfl.id ?? hfl.limbZoneId
        const limbTex = hiddenFaceLimbTextures?.[texKey] ?? hiddenFaceLimbTextures?.[hfl.limbZoneId] ?? texture
        const extInfo = buildMesh(
          zone.id, pts, extTris,
          limbTex, imageWidth, imageHeight, scale, offsetX, offsetY,
          zone.zOrder - 0.5, contentAlignment,
        )
        hiddenFaceLimbMeshes.push(extInfo)
        container.addChild(extInfo.pixiMesh)
      }
    } else {
      // No extension — single mesh as before
      const info = buildMesh(zone.id, pts, tris, texture, imageWidth, imageHeight, scale, offsetX, offsetY, zone.zOrder, contentAlignment)
      zoneMeshes.push(info)
      container.addChild(info.pixiMesh)
    }
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

  // Split body into pure body (scan texture) + hidden face meshes (inpainted texture)
  const hiddenFaceMeshes: ZoneMeshInfo[] = []

  const hfTriIdxSet = new Set<number>()
  if (separation.hiddenFaceZones) {
    for (const hfz of separation.hiddenFaceZones) {
      for (const ti of hfz.bodyTriangleIndices) hfTriIdxSet.add(ti)
    }
  }

  let pureBodyTris: [number, number, number][] = []
  for (let i = 0; i < bodyTris.length; i++) {
    if (!hfTriIdxSet.has(i)) pureBodyTris.push(bodyTris[i])
  }

  // Pure body mesh (z=0, uses scan texture)
  const bodyZOrder = separation.bodyZOrder ?? 0
  const bodyInfo = buildMesh('__body__', bodyPts, pureBodyTris, texture, imageWidth, imageHeight, scale, offsetX, offsetY, bodyZOrder, contentAlignment)
  container.addChild(bodyInfo.pixiMesh)

  // Hidden face meshes — same bodyPoints, but only the marked triangles
  if (separation.hiddenFaceZones) {
    for (const hfz of separation.hiddenFaceZones) {
      if (hfz.bodyTriangleIndices.length === 0) continue
      const hfTris = hfz.bodyTriangleIndices.map(ti => bodyTris[ti]).filter(Boolean)
      if (hfTris.length === 0) continue
      // HFZ appartient au body : zOrder = body.zOrder + 0.5
      const hfZOrder = bodyZOrder + 0.5
      const info = buildMesh(
        `__hf_${hfz.limbZoneId}`, bodyPts, hfTris,
        hiddenFaceTexture ?? texture, imageWidth, imageHeight, scale, offsetX, offsetY,
        hfZOrder, contentAlignment,
      )
      hiddenFaceMeshes.push(info)
      container.addChild(info.pixiMesh)
    }
  }

  return { container, zoneMeshes, bodyMesh: bodyInfo, hiddenFaceMeshes, hiddenFaceLimbMeshes }
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
