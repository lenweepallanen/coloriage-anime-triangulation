/**
 * CONTRAT PDF ↔ SCAN — source unique de vérité, partagée par le générateur PDF
 * (`pdfGenerator.ts`), le traitement du scan (`ScanProcessor.tsx`) et le worker
 * OpenCV (qui reçoit les positions cibles déjà calculées, il ne connaît pas ce fichier).
 *
 * Repères = 4 « viseurs » (motif de QR code : carré noir 7×7 modules, anneau blanc,
 * carré noir central 3×3), posés DANS l'image, dans ses 4 coins, sur un petit carré
 * blanc qui efface le dessin dessous. Le viseur est détecté par sa structure
 * emboîtée + le rapport 1:1:3:1:1, jamais par des seuils de forme : une lettre, un
 * QR code ou un trait de dessin ne peuvent pas être confondus avec lui.
 *
 *   ┌──────────────── image ────────────────┐
 *   │ ┌────────┐                 ┌────────┐ │   carré blanc = FINDER_MM + 2·FINDER_QUIET_MM,
 *   │ │ ▣      │                 │      ▣ │ │   collé au coin de l'image ; le coin extérieur
 *   │ └────────┘                 └────────┘ │   du viseur est à FINDER_QUIET_MM du coin.
 *   │                dessin                 │
 *
 * Géométrie de référence : les 4 coins du carré extérieur de chaque viseur, en mm,
 * dans le repère de l'IMAGE (origine = coin haut-gauche de l'image sur la page).
 * Le scan redressé (2048×2048) place l'image entière sur SCAN_IMAGE_FRAME px à
 * partir de SCAN_IMAGE_OFFSET : l'alignement image ↔ scan est donc exact par
 * construction, quel que soit le format de l'image.
 */

import type { Point2D } from '../types/project'

// A4 en mm
export const A4_W = 210
export const A4_H = 297
export const MARGIN = 15       // marge mini autour de l'image sur la page

// Viseur (mm)
export const FINDER_MM = 12          // côté du carré extérieur (7 modules de 12/7 mm)
export const FINDER_QUIET_MM = 2     // blanc autour du viseur, à l'intérieur de l'image
export const FINDER_KNOCKOUT_MM = FINDER_MM + 2 * FINDER_QUIET_MM  // carré blanc (16 mm)

// Scan redressé (px)
export const SCAN_TOTAL = 2048
export const SCAN_IMAGE_FRAME = 1920                                 // l'image → (64,64)↔(1984,1984)
export const SCAN_IMAGE_OFFSET = (SCAN_TOTAL - SCAN_IMAGE_FRAME) / 2  // = 64

/** Taille et position (mm) de l'image sur la page A4 : ajustée dans la zone utile,
 *  centrée, ratio conservé. */
export function computeImagePlacementMm(imageWidth: number, imageHeight: number): { x: number; y: number; w: number; h: number } {
  const aspect = imageWidth / imageHeight
  const contentW = A4_W - MARGIN * 2
  const contentH = A4_H - MARGIN * 2
  let w: number, h: number
  if (aspect > contentW / contentH) { w = contentW; h = contentW / aspect }
  else { h = contentH; w = contentH * aspect }
  return { x: (A4_W - w) / 2, y: (A4_H - h) / 2, w, h }
}

/** Coin extérieur (haut-gauche) de chaque viseur, en mm dans le repère de l'image,
 *  ordre TL, TR, BR, BL. */
export function finderOriginsMm(imgW_mm: number, imgH_mm: number): Point2D[] {
  const q = FINDER_QUIET_MM, s = FINDER_MM
  return [
    { x: q, y: q },
    { x: imgW_mm - q - s, y: q },
    { x: imgW_mm - q - s, y: imgH_mm - q - s },
    { x: q, y: imgH_mm - q - s },
  ]
}

/** Les 4 coins (TL, TR, BR, BL) du carré extérieur de chaque viseur (TL, TR, BR, BL),
 *  en mm dans le repère de l'image → 16 points. */
export function finderCornersMm(imgW_mm: number, imgH_mm: number): Point2D[][] {
  return finderOriginsMm(imgW_mm, imgH_mm).map(({ x, y }) => [
    { x, y }, { x: x + FINDER_MM, y }, { x: x + FINDER_MM, y: y + FINDER_MM }, { x, y: y + FINDER_MM },
  ])
}

/** Centre de chaque viseur (TL, TR, BR, BL), en mm dans le repère de l'image. */
export function finderCentersMm(imgW_mm: number, imgH_mm: number): Point2D[] {
  return finderOriginsMm(imgW_mm, imgH_mm).map(({ x, y }) => ({ x: x + FINDER_MM / 2, y: y + FINDER_MM / 2 }))
}

/** mm (repère image) → px du scan redressé 2048×2048. */
export function imageMmToScanPx(p: Point2D, imgW_mm: number, imgH_mm: number): Point2D {
  return {
    x: SCAN_IMAGE_OFFSET + (p.x / imgW_mm) * SCAN_IMAGE_FRAME,
    y: SCAN_IMAGE_OFFSET + (p.y / imgH_mm) * SCAN_IMAGE_FRAME,
  }
}

/** Points cibles (px scan) des 16 coins de viseurs et des 4 centres, pour une image
 *  de dimensions données (pixels natifs → mm via le placement A4). */
export function scanTargetsForImage(imageWidth: number, imageHeight: number): { tagCorners: Point2D[][]; centers: Point2D[] } {
  const { w, h } = computeImagePlacementMm(imageWidth, imageHeight)
  return {
    tagCorners: finderCornersMm(w, h).map(tag => tag.map(p => imageMmToScanPx(p, w, h))),
    centers: finderCentersMm(w, h).map(p => imageMmToScanPx(p, w, h)),
  }
}
