import * as PIXI from 'pixi.js'
import type { Point2D, Prop, ProjectTriangulation, Animation as ProjectAnimation } from '../types/project'
import { buildPropTexture, type PropTextureResult } from './propScanTexture'

export interface PropSpriteEntry {
  prop: Prop
  sprite: PIXI.Sprite
  bboxMin: Point2D
  bboxSize: { width: number; height: number }
  /** Positions des anchors référencés au moment du build (frame 0) en coords image. */
  buildAnchors: {
    fixed?: { centerImage: Point2D }
    follow1?: { anchor: Point2D }
    follow2?: { anchorA: Point2D; anchorB: Point2D }
  }
}

export interface PropLayerSetup {
  container: PIXI.Container
  entries: PropSpriteEntry[]
}

/**
 * Construit le calque PIXI des accessoires : un sprite par accessoire,
 * texture découpée du canvas source via `buildPropTexture`.
 *
 * Le `container` retourné a `sortableChildren = true` et chaque sprite reçoit
 * `zIndex = prop.zOrder` — l'appelant insère ce container dans son parent
 * sortable (ex: à côté du `zoneMeshSetup.container`).
 *
 * `sceneScale/offsetX/offsetY` correspondent au mapping image→écran utilisé
 * pour le reste de la scène (cf. `buildZoneMeshes`).
 */
export function buildPropLayer(
  props: Prop[],
  source: HTMLCanvasElement | HTMLImageElement,
  imageWidth: number,
  imageHeight: number,
  projectTriangulation: ProjectTriangulation | null,
  sceneScale: number,
  sceneOffsetX: number,
  sceneOffsetY: number,
): PropLayerSetup {
  const container = new PIXI.Container()
  container.sortableChildren = true
  const entries: PropSpriteEntry[] = []

  for (const prop of props) {
    const tex = buildPropTexture(prop, source, imageWidth, imageHeight)
    if (!tex) continue
    const sprite = new PIXI.Sprite(tex.texture)
    sprite.anchor.set(0, 0)
    sprite.zIndex = prop.zOrder

    const entry: PropSpriteEntry = {
      prop,
      sprite,
      bboxMin: tex.bboxMin,
      bboxSize: { width: tex.width, height: tex.height },
      buildAnchors: captureBuildAnchors(prop, projectTriangulation, tex),
    }
    placeSprite(entry, getAnchorsByZone(projectTriangulation), sceneScale, sceneOffsetX, sceneOffsetY)
    container.addChild(sprite)
    entries.push(entry)
  }

  return { container, entries }
}

/**
 * Met à jour la position de tous les sprites en fonction des anchors courants.
 * Appelé chaque frame depuis la boucle d'animation.
 */
export function updatePropLayer(
  setup: PropLayerSetup,
  anchorsByZone: Record<string, Point2D[]>,
  sceneScale: number,
  sceneOffsetX: number,
  sceneOffsetY: number,
): void {
  for (const entry of setup.entries) {
    placeSprite(entry, anchorsByZone, sceneScale, sceneOffsetX, sceneOffsetY)
  }
}

// --- internes ----------------------------------------------------------------

function captureBuildAnchors(
  prop: Prop,
  tri: ProjectTriangulation | null,
  tex: PropTextureResult,
): PropSpriteEntry['buildAnchors'] {
  const anchorsByZone = getAnchorsByZone(tri)
  switch (prop.attachment.mode) {
    case 'fixed': {
      const cx = (tex.bboxMin.x + tex.bboxMax.x) / 2
      const cy = (tex.bboxMin.y + tex.bboxMax.y) / 2
      return { fixed: { centerImage: { x: cx, y: cy } } }
    }
    case 'follow-1': {
      const a = anchorsByZone[prop.attachment.ref.zoneId]?.[prop.attachment.ref.anchorIndex]
      return { follow1: { anchor: a ? { ...a } : { x: 0, y: 0 } } }
    }
    case 'follow-2': {
      const a = anchorsByZone[prop.attachment.refA.zoneId]?.[prop.attachment.refA.anchorIndex]
      const b = anchorsByZone[prop.attachment.refB.zoneId]?.[prop.attachment.refB.anchorIndex]
      return {
        follow2: {
          anchorA: a ? { ...a } : { x: 0, y: 0 },
          anchorB: b ? { ...b } : { x: 10, y: 0 },
        },
      }
    }
  }
}

function placeSprite(
  entry: PropSpriteEntry,
  anchorsByZone: Record<string, Point2D[]>,
  sceneScale: number,
  sceneOffsetX: number,
  sceneOffsetY: number,
): void {
  const { prop, sprite, bboxMin, bboxSize, buildAnchors } = entry
  // Position du coin haut-gauche de la bbox en coords image courantes.
  let topLeftImage: Point2D = { x: bboxMin.x, y: bboxMin.y }
  let rotation = 0
  let scaleMultiplier = 1

  switch (prop.attachment.mode) {
    case 'fixed':
      // bbox d'origine + offset
      topLeftImage = { x: bboxMin.x + prop.offset.x, y: bboxMin.y + prop.offset.y }
      break
    case 'follow-1': {
      const cur = anchorsByZone[prop.attachment.ref.zoneId]?.[prop.attachment.ref.anchorIndex]
      const build = buildAnchors.follow1?.anchor
      if (cur && build) {
        const dx = cur.x - build.x
        const dy = cur.y - build.y
        topLeftImage = { x: bboxMin.x + dx + prop.offset.x, y: bboxMin.y + dy + prop.offset.y }
      } else {
        topLeftImage = { x: bboxMin.x + prop.offset.x, y: bboxMin.y + prop.offset.y }
      }
      break
    }
    case 'follow-2': {
      const curA = anchorsByZone[prop.attachment.refA.zoneId]?.[prop.attachment.refA.anchorIndex]
      const curB = anchorsByZone[prop.attachment.refB.zoneId]?.[prop.attachment.refB.anchorIndex]
      const buildA = buildAnchors.follow2?.anchorA
      const buildB = buildAnchors.follow2?.anchorB
      if (curA && curB && buildA && buildB) {
        const angBuild = Math.atan2(buildB.y - buildA.y, buildB.x - buildA.x)
        const angCur = Math.atan2(curB.y - curA.y, curB.x - curA.x)
        rotation = angCur - angBuild
        // pivot = curA. Position du coin TL = transform de (bboxMin - buildA) autour de l'origine + curA.
        const lx = bboxMin.x - buildA.x
        const ly = bboxMin.y - buildA.y
        const cos = Math.cos(rotation), sin = Math.sin(rotation)
        topLeftImage = {
          x: curA.x + lx * cos - ly * sin + prop.offset.x,
          y: curA.y + lx * sin + ly * cos + prop.offset.y,
        }
      } else {
        topLeftImage = { x: bboxMin.x + prop.offset.x, y: bboxMin.y + prop.offset.y }
      }
      break
    }
  }

  const finalScale = sceneScale * prop.scale * scaleMultiplier
  sprite.position.set(
    topLeftImage.x * sceneScale + sceneOffsetX,
    topLeftImage.y * sceneScale + sceneOffsetY,
  )
  sprite.rotation = rotation
  sprite.scale.set(finalScale, finalScale)
  sprite.width = bboxSize.width * finalScale
  sprite.height = bboxSize.height * finalScale
  sprite.zIndex = prop.zOrder
}

/**
 * Construit la table `zoneId → Point2D[]` des anchors statiques (frame 0) en
 * coords image, à partir de `projectTriangulation.zoneAnchors`.
 * Utilisé comme fallback / rest pose quand aucune animation ne fournit
 * d'anchors trackés.
 */
export function getAnchorsByZone(tri: ProjectTriangulation | null): Record<string, Point2D[]> {
  if (!tri) return {}
  return tri.zoneAnchors ?? {}
}

/**
 * Pour chaque zone, mappe `zoneAnchors[zoneId][i]` (P0 inclus comme [0]) à son
 * index dans `zonePoints[zoneId]` (ordre interleavé contour). Le mapping est
 * calculé par recherche du vertex le plus proche dans les N premiers points
 * de `zonePoints` (= contour pinné), N = `zoneContourLength[zoneId]`.
 *
 * Pour zoneId='body', `zonePoints['body']` correspond à `bodyPoints` (mêmes
 * indices) — l'index renvoyé s'applique donc directement à `walkBodyFrames`.
 * Pour les pattes, l'index s'applique à `walkZoneFrames[zoneId][f]`.
 */
export function buildAnchorIndexMap(
  tri: ProjectTriangulation | null,
): Record<string, number[]> {
  if (!tri) return {}
  const out: Record<string, number[]> = {}
  for (const [zoneId, anchors] of Object.entries(tri.zoneAnchors ?? {})) {
    const zonePts = (zoneId === 'body' ? tri.bodyPoints : tri.zonePoints?.[zoneId]) ?? []
    if (zonePts.length === 0 || anchors.length === 0) { out[zoneId] = []; continue }
    const nContour = tri.zoneContourLength?.[zoneId] ?? zonePts.length
    const haystack = zonePts.slice(0, nContour)
    out[zoneId] = anchors.map(a => {
      let bestIdx = 0, bestD = Infinity
      for (let i = 0; i < haystack.length; i++) {
        const d = (haystack[i].x - a.x) ** 2 + (haystack[i].y - a.y) ** 2
        if (d < bestD) { bestD = d; bestIdx = i }
      }
      return bestIdx
    })
  }
  return out
}

/**
 * Extrait `anchorsByZone` à la frame courante en s'appuyant sur les frames
 * déformées disponibles sur l'animation (`walkBodyFrames`, `walkZoneFrames`,
 * versions lissées le cas échéant). Si rien de pertinent n'est dispo (ex:
 * rest legacy sans V3), retombe sur les positions statiques de la
 * Triangulation projet.
 */
export function getAnchorsByZoneAtFrame(
  animation: ProjectAnimation | null | undefined,
  frameIndex: number,
  tri: ProjectTriangulation | null,
  anchorIndexMap: Record<string, number[]>,
): Record<string, Point2D[]> {
  const fallback = getAnchorsByZone(tri)
  if (!animation?.mesh || !tri) return fallback

  const mesh = animation.mesh
  const out: Record<string, Point2D[]> = { ...fallback }

  // Body : préférer le lissé si dispo
  const bodyFrames = mesh.walkBodyFramesSmoothed ?? mesh.walkBodyFrames
  if (bodyFrames && bodyFrames.length > 0) {
    const frame = bodyFrames[clampFrame(frameIndex, bodyFrames.length)]
    const map = anchorIndexMap['body'] ?? []
    if (frame && map.length > 0) {
      out['body'] = map.map(idx => frame[idx] ?? { x: 0, y: 0 })
    }
  }

  // Pattes
  const zoneFrames = mesh.walkZoneFramesSmoothed ?? mesh.walkZoneFrames
  if (zoneFrames) {
    for (const [zoneId, frames] of Object.entries(zoneFrames)) {
      if (zoneId === 'body') continue
      if (!frames || frames.length === 0) continue
      const frame = frames[clampFrame(frameIndex, frames.length)]
      const map = anchorIndexMap[zoneId] ?? []
      if (frame && map.length > 0) {
        out[zoneId] = map.map(idx => frame[idx] ?? { x: 0, y: 0 })
      }
    }
  }

  return out
}

function clampFrame(f: number, len: number): number {
  if (len <= 0) return 0
  return ((f % len) + len) % len
}

/**
 * Variante de `getAnchorsByZoneAtFrame` quand on dispose déjà des positions
 * body/zones courantes (ex: `activeBodyPlayback.getPositions()` dans
 * ScenePlayer). Évite de relire les frames depuis l'animation.
 */
export function getAnchorsByZoneFromCurrent(
  bodyPositions: Point2D[] | null,
  zonePositions: Record<string, Point2D[]> | null,
  anchorIndexMap: Record<string, number[]>,
  fallback: Record<string, Point2D[]>,
): Record<string, Point2D[]> {
  const out: Record<string, Point2D[]> = { ...fallback }
  if (bodyPositions) {
    const map = anchorIndexMap['body'] ?? []
    if (map.length > 0) {
      out['body'] = map.map(idx => bodyPositions[idx] ?? { x: 0, y: 0 })
    }
  }
  if (zonePositions) {
    for (const [zoneId, pts] of Object.entries(zonePositions)) {
      if (zoneId === 'body' || !pts) continue
      const map = anchorIndexMap[zoneId] ?? []
      if (map.length > 0) {
        out[zoneId] = map.map(idx => pts[idx] ?? { x: 0, y: 0 })
      }
    }
  }
  return out
}
