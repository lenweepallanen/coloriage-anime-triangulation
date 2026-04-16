/**
 * Body mesh resolution helper for members-bones animations.
 *
 * V2 / members-bones reads the body mesh from `project.projectTriangulation`.
 * V3 builds it from the animation's SAM 2 body contour (anchors + subdivision,
 * frame 0, converted to image coords) — pas d'internes : la triangulation est
 * un Delaunay du contour seul, et les frames suivent directement le contour
 * trackée (lissé si dispo).
 *
 * All output is in IMAGE coordinates (matches the convention used by leg LBS).
 */

import type { Animation, MeshData, Point2D, Project } from '../types/project'

export interface MembersBonesBodyMesh {
  bodyPoints: Point2D[]
  bodyTriangles: [number, number, number][]
  /** Number of boundary vertices at the start of bodyPoints. V3 = bodyPoints.length, V2 = 0. */
  nBoundary: number
}

/**
 * Concatenate body anchor + subdivision frame-0 positions in image coords.
 * Returns null if either is missing.
 */
export function buildV3BoundaryFrame0(
  mesh: MeshData,
  imgW: number, imgH: number,
): Point2D[] | null {
  const anchors = mesh.sam2ContourAnchors?.['body']
  const subs = mesh.sam2ContourSubdivisionPoints?.['body']
  if (!anchors || !subs) return null
  const vidW = mesh.sam2VideoWidth ?? imgW
  const vidH = mesh.sam2VideoHeight ?? imgH
  const sx = imgW / Math.max(1, vidW)
  const sy = imgH / Math.max(1, vidH)
  return [
    ...anchors.map(p => ({ x: p.x * sx, y: p.y * sy })),
    ...subs.map(p => ({ x: p.x * sx, y: p.y * sy })),
  ]
}

/**
 * Returns the rest body mesh (frame 0 positions + triangulation) in IMAGE coords.
 * For V3, requires image dimensions to convert SAM 2 video-coord boundary into image coords.
 * V3 body mesh = Delaunay du contour seul (boundary anchors + subdivision body).
 */
export function getMembersBonesBodyMesh(
  project: Project,
  animation: Animation,
  imgW: number,
  imgH: number,
): MembersBonesBodyMesh | null {
  const mesh = animation.mesh
  if (!mesh) return null

  if (animation.type === 'members-bones-v3') {
    const boundary = buildV3BoundaryFrame0(mesh, imgW, imgH)
    const triangles = mesh.v3BodyTriangles
    if (!boundary || !triangles) return null
    return {
      bodyPoints: boundary,
      bodyTriangles: triangles,
      nBoundary: boundary.length,
    }
  }

  const tri = project.projectTriangulation
  if (!tri) return null
  return {
    bodyPoints: tri.bodyPoints,
    bodyTriangles: tri.bodyTriangles,
    nBoundary: 0,
  }
}

/**
 * Build per-frame boundary positions for V3 body mesh in IMAGE coords.
 * Used by ARAP solving to get the pinned vertex positions for each frame.
 * Prefers smoothed anchors+subdivisions when available.
 */
export function buildV3BoundaryFrames(
  mesh: MeshData,
  imgW: number, imgH: number,
): Point2D[][] | null {
  const anchorFrames = mesh.sam2SmoothedAnchorFrames?.['body'] ?? mesh.sam2ContourAnchorFrames?.['body']
  const subFrames = mesh.sam2SmoothedSubdivisionFrames?.['body'] ?? mesh.sam2ContourSubdivisionFrames?.['body']
  if (!anchorFrames || !subFrames) return null
  const totalFrames = Math.min(anchorFrames.length, subFrames.length)
  const vidW = mesh.sam2VideoWidth ?? imgW
  const vidH = mesh.sam2VideoHeight ?? imgH
  const sx = imgW / Math.max(1, vidW)
  const sy = imgH / Math.max(1, vidH)
  const result: Point2D[][] = new Array(totalFrames)
  for (let f = 0; f < totalFrames; f++) {
    const a = anchorFrames[f] ?? []
    const s = subFrames[f] ?? []
    result[f] = [
      ...a.map(p => ({ x: p.x * sx, y: p.y * sy })),
      ...s.map(p => ({ x: p.x * sx, y: p.y * sy })),
    ]
  }
  return result
}
