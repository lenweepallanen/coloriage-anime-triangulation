import type { FilmCameraClip, FilmCameraState, FilmTravelEasing } from '../types/project'
import { applyFilmEasing } from './filmPath'
import { FILM_FPS } from './filmTimeline'

/**
 * Évaluation PURE des effets de la piste CAMÉRA à un instant local du plan.
 * Produit un `FilmCameraState` (focale + zoom + secousse + rotation) en coords
 * DÉCOR, appliqué au rendu sur un conteneur enveloppant décor + perso + avant-plan.
 *
 * Déterministe : les secousses dérivent d'un bruit haché par index de frame
 * (aucun Math.random) → scrub, replay et enregistrement vidéo identiques.
 */

/** Géométrie du cadre plein du plan (coords décor). */
export interface FilmCameraFrame {
  /** Centre horizontal du cadre (cameraX). */
  cx: number
  /** Centre vertical du cadre. */
  cy: number
  /** Demi-largeur du cadre plein (planFrameHalfWidthBg). */
  halfW: number
}

/** Bruit pseudo-aléatoire déterministe ∈ [-1,1] à partir d'un entier. */
function hashNoise(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453
  return (s - Math.floor(s)) * 2 - 1
}

/** Facteur de zoom cible pour cadrer un rect (largeur) dans le cadre plein. */
function zoomForWidth(fullWidth: number, rectW: number, maxZoom: number): number {
  if (rectW <= 1) return maxZoom
  return Math.max(1, Math.min(maxZoom, fullWidth / rectW))
}

const IDENTITY = (frame: FilmCameraFrame): FilmCameraState => ({
  focusX: frame.cx, focusY: frame.cy, zoom: 1, shakeX: 0, shakeY: 0, rotation: 0,
})

/**
 * Combine tous les clips caméra actifs à `localMs`. Zoom/pan : le DERNIER actif
 * gagne (focale + zoom). Shake/rumble : ADDITIFS (offset + rotation cumulés).
 */
export function evaluateCamera(
  clips: FilmCameraClip[] | undefined,
  localMs: number,
  frame: FilmCameraFrame,
): FilmCameraState {
  const out = IDENTITY(frame)
  if (!clips || clips.length === 0) return out

  const fullWidth = frame.halfW * 2
  for (const clip of clips) {
    const t = localMs - clip.startMs
    if (t < 0 || t >= clip.durationMs) continue

    if (clip.kind === 'zoom' || clip.kind === 'pan') {
      const maxZoom = Math.max(1, clip.maxZoom ?? 3)
      const rect = clip.rect
      if (!rect) continue
      const easing = clip.easing ?? 'easeInOut'
      if (clip.kind === 'pan') {
        // Travelling : zoom fixe (celui du rect), focale rect → rectTo.
        const to = clip.rectTo ?? rect
        const z = zoomForWidth(fullWidth, rect.w, maxZoom)
        const p = ease(t / clip.durationMs, easing)
        out.zoom = z
        out.focusX = lerp(rect.x + rect.w / 2, to.x + to.w / 2, p)
        out.focusY = lerp(rect.y + rect.h / 2, to.y + to.h / 2, p)
      } else {
        // Zoom : in → hold → out. Durées par défaut si absentes.
        const zoomInMs = clamp(clip.zoomInMs ?? clip.durationMs * 0.35, 0, clip.durationMs)
        const zoomOutMs = clamp(clip.zoomOutMs ?? clip.durationMs * 0.35, 0, clip.durationMs - zoomInMs)
        const zTarget = zoomForWidth(fullWidth, rect.w, maxZoom)
        const fx = rect.x + rect.w / 2
        const fy = rect.y + rect.h / 2
        let prog: number // 0 = plein cadre, 1 = cadré sur rect
        if (t < zoomInMs) prog = ease(t / Math.max(1, zoomInMs), easing)
        else if (t < clip.durationMs - zoomOutMs) prog = 1
        else prog = ease((clip.durationMs - t) / Math.max(1, zoomOutMs), easing)
        out.zoom = lerp(1, zTarget, prog)
        out.focusX = lerp(frame.cx, fx, prog)
        out.focusY = lerp(frame.cy, fy, prog)
      }
      continue
    }

    // --- Secousses (additives) ---
    const axis = clip.axis ?? 'both'
    const freq = Math.max(0.1, clip.frequencyHz ?? (clip.kind === 'rumble' ? 8 : 14))
    const amp = clip.amplitude ?? (clip.kind === 'rumble' ? 4 : 16)
    const tSec = t / 1000
    if (clip.kind === 'rumble') {
      // Oscillation régulière et continue (marche).
      const ox = Math.sin(2 * Math.PI * freq * tSec)
      const oy = Math.sin(2 * Math.PI * freq * tSec + 1.7)
      if (axis !== 'y') out.shakeX += amp * ox
      if (axis !== 'x') out.shakeY += amp * oy
    } else {
      // Secousse d'impact qui décroît (rugissement).
      const p = t / clip.durationMs
      const env = clip.decay === 'linear' ? (1 - p) : Math.exp(-3 * p)
      const n = Math.round(tSec * freq * 2)
      const nx = hashNoise(n * 2 + 1)
      const ny = hashNoise(n * 2 + 7)
      if (axis !== 'y') out.shakeX += amp * env * nx
      if (axis !== 'x') out.shakeY += amp * env * ny
      if (clip.rotate) out.rotation += (amp / Math.max(1, frame.halfW)) * env * hashNoise(n * 2 + 13) * 0.5
    }
  }
  return out
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)) }
function ease(t: number, easing: FilmTravelEasing): number {
  return applyFilmEasing(easing, clamp(t, 0, 1))
}

/** Durée effective d'un clip caméra (utilitaire éditeur). */
export const CAMERA_FPS = FILM_FPS
