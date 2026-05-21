import * as PIXI from 'pixi.js'
import type { Point2D, Prop } from '../types/project'

export interface PropTextureResult {
  texture: PIXI.Texture
  /** bbox (en coords image source) englobant toutes les `contourParts` */
  bboxMin: Point2D
  bboxMax: Point2D
  /** dimensions du canvas découpé (= bboxMax - bboxMin) */
  width: number
  height: number
}

/**
 * Découpe une région polygonale (union de `prop.contourParts`) d'un canvas
 * source — typiquement le scan rectifié de l'enfant, ou l'image de référence
 * pour le preview admin — et retourne une PIXI.Texture avec masque alpha.
 *
 * Coordonnées : `prop.contourParts` est en pixels image de référence.
 * `sourceCanvas` est supposé être dans le **même espace** (même grille image).
 * Si les dimensions diffèrent, on rescale uniformément.
 */
export function buildPropTexture(
  prop: Prop,
  sourceCanvas: HTMLCanvasElement | HTMLImageElement,
  imageWidth: number,
  imageHeight: number,
): PropTextureResult | null {
  if (prop.contourParts.length === 0) return null

  // 1. bbox des polygones
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const part of prop.contourParts) {
    for (const p of part) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  // marge de 2 px pour éviter le clipping
  minX = Math.max(0, Math.floor(minX - 2))
  minY = Math.max(0, Math.floor(minY - 2))
  maxX = Math.min(imageWidth, Math.ceil(maxX + 2))
  maxY = Math.min(imageHeight, Math.ceil(maxY + 2))
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)

  // 2. canvas découpé : copie la région du source
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const ctx = off.getContext('2d')!

  const srcW = 'naturalWidth' in sourceCanvas ? sourceCanvas.naturalWidth : sourceCanvas.width
  const srcH = 'naturalHeight' in sourceCanvas ? sourceCanvas.naturalHeight : sourceCanvas.height
  const sx = (minX / imageWidth) * srcW
  const sy = (minY / imageHeight) * srcH
  const sw = (w / imageWidth) * srcW
  const sh = (h / imageHeight) * srcH
  ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, w, h)

  // 3. masque alpha : on garde uniquement les pixels à l'intérieur de l'union
  //    des polygones. On dessine les polygones en blanc dans un canvas mask,
  //    puis on combine via globalCompositeOperation='destination-in'.
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = w
  maskCanvas.height = h
  const mctx = maskCanvas.getContext('2d')!
  mctx.fillStyle = '#ffffff'
  mctx.beginPath()
  for (const part of prop.contourParts) {
    if (part.length < 3) continue
    mctx.moveTo(part[0].x - minX, part[0].y - minY)
    for (let i = 1; i < part.length; i++) {
      mctx.lineTo(part[i].x - minX, part[i].y - minY)
    }
    mctx.closePath()
  }
  mctx.fill('evenodd')

  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(maskCanvas, 0, 0)
  ctx.globalCompositeOperation = 'source-over'

  return {
    texture: PIXI.Texture.from(off),
    bboxMin: { x: minX, y: minY },
    bboxMax: { x: maxX, y: maxY },
    width: w,
    height: h,
  }
}
