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

import type { Animation, MeshData, Point2D, Project, CurvilinearParam } from '../types/project'

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
 * V3 inherits full topology (boundary + internals) from projectTriangulation,
 * with the first `zoneContourLength.body` indices being the contour.
 * Legacy V3 (pre-projectTriangulation) falls back to Delaunay of contour seul.
 */
export function getMembersBonesBodyMesh(
  project: Project,
  animation: Animation,
  imgW: number,
  imgH: number,
): MembersBonesBodyMesh | null {
  const mesh = animation.mesh
  if (!mesh) return null
  const tri = project.projectTriangulation

  if (animation.type === 'members-bones-v3') {
    if (tri?.step3Validated && tri.bodyPoints?.length && tri.bodyTriangles?.length && tri.zoneContourLength?.['body']) {
      return {
        bodyPoints: tri.bodyPoints,
        bodyTriangles: tri.bodyTriangles,
        nBoundary: tri.zoneContourLength['body'],
      }
    }
    const boundary = buildV3BoundaryFrame0(mesh, imgW, imgH)
    const triangles = mesh.v3BodyTriangles
    if (!boundary || !triangles) return null
    return {
      bodyPoints: boundary,
      bodyTriangles: triangles,
      nBoundary: boundary.length,
    }
  }

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
 *
 * Si `subParams` est fourni : produit l'ordre interleavé
 * [P0, ...subs_seg0, anchor_1, ...subs_seg1, ..., anchor_N, ...subs_segN]
 * qui matche `projectTriangulation.bodyPoints[0..nContour]`.
 *
 * Sinon : ordre flat [...anchors, ...subs] (legacy V2-style).
 */
export function buildV3BoundaryFrames(
  mesh: MeshData,
  imgW: number, imgH: number,
  subParams?: CurvilinearParam[],
): Point2D[][] | null {
  const anchorFrames = mesh.sam2SmoothedAnchorFrames?.['body'] ?? mesh.sam2ContourAnchorFrames?.['body']
  const subFrames = mesh.sam2SmoothedSubdivisionFrames?.['body'] ?? mesh.sam2ContourSubdivisionFrames?.['body']
  if (!anchorFrames || !subFrames) return null
  const totalFrames = Math.min(anchorFrames.length, subFrames.length)
  const vidW = mesh.sam2VideoWidth ?? imgW
  const vidH = mesh.sam2VideoHeight ?? imgH
  const sx = imgW / Math.max(1, vidW)
  const sy = imgH / Math.max(1, vidH)

  // Précalcul des indices de subdivisions par segment (ordre stable garanti par subdivideContour)
  let subIndicesBySegment: number[][] | null = null
  if (subParams) {
    subIndicesBySegment = []
    for (let i = 0; i < subParams.length; i++) {
      const seg = subParams[i].segmentIndex
      if (!subIndicesBySegment[seg]) subIndicesBySegment[seg] = []
      subIndicesBySegment[seg].push(i)
    }
  }

  const result: Point2D[][] = new Array(totalFrames)
  for (let f = 0; f < totalFrames; f++) {
    const a = anchorFrames[f] ?? []
    const s = subFrames[f] ?? []
    if (subIndicesBySegment) {
      // Interleavé : pour chaque anchor i, push anchor[i] + subs du segment i
      const out: Point2D[] = []
      for (let i = 0; i < a.length; i++) {
        const ai = a[i]
        out.push({ x: ai.x * sx, y: ai.y * sy })
        const segSubs = subIndicesBySegment[i] ?? []
        for (const k of segSubs) {
          const p = s[k]
          if (p) out.push({ x: p.x * sx, y: p.y * sy })
        }
      }
      result[f] = out
    } else {
      result[f] = [
        ...a.map(p => ({ x: p.x * sx, y: p.y * sy })),
        ...s.map(p => ({ x: p.x * sx, y: p.y * sy })),
      ]
    }
  }
  return result
}
