import * as PIXI from 'pixi.js'
import type { FilmPlanTransition } from '../types/project'
import { transitionDurationMs } from './filmDirector'

/**
 * Transitions visuelles entre deux plans du film, rendues dans un overlay PIXI
 * au-dessus du décor+perso (mais SOUS le filigrane d'enregistrement).
 *
 * Principe : pour crossfade/wipe/iris, on capture un SNAPSHOT du dernier frame
 * sortant (stage complet), on swap le décor immédiatement dessous, puis on
 * anime la disparition du snapshot (alpha / masque). Le fondu noir anime un
 * Graphics noir (swap à mi-course). Tout passe par le canvas → compatible
 * enregistrement vidéo.
 */
export interface PlanTransitionRunner {
  /** Avance la transition. Retourne true quand elle est terminée (cleanup fait). */
  update(deltaMs: number): boolean
}

/** Parse '#rrggbb' → entier PIXI (fallback si invalide/absent). */
function hexToInt(hex: string | undefined, fallback: number): number {
  if (!hex) return fallback
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  return m ? parseInt(m[1], 16) : fallback
}

export function startPlanTransition(
  app: PIXI.Application,
  overlay: PIXI.Container,
  transition: FilmPlanTransition,
  swapFn: () => void,
): PlanTransitionRunner {
  const durationMs = transitionDurationMs(transition)

  if (transition.kind === 'cut' || durationMs <= 0) {
    swapFn()
    return { update: () => true }
  }

  const viewW = app.screen.width
  const viewH = app.screen.height
  let elapsed = 0

  if (transition.kind === 'fadeBlack') {
    // « Fondu couleur » : noir par défaut, couleur configurable.
    const black = new PIXI.Graphics()
    black.beginFill(hexToInt(transition.color, 0x000000))
    black.drawRect(0, 0, viewW, viewH)
    black.endFill()
    black.alpha = 0
    overlay.addChild(black)
    let swapped = false
    return {
      update(deltaMs: number): boolean {
        elapsed += deltaMs
        const t = Math.min(1, elapsed / durationMs)
        if (t < 0.5) {
          black.alpha = t * 2
        } else {
          if (!swapped) {
            swapped = true
            swapFn()
          }
          black.alpha = 1 - (t - 0.5) * 2
        }
        if (t >= 1) {
          overlay.removeChild(black)
          black.destroy()
          return true
        }
        return false
      },
    }
  }

  if (transition.kind === 'wipe' && transition.color != null) {
    // Volet COLORÉ : un rectangle pleine couleur balaie l'écran dans la direction
    // du volet — il couvre tout à mi-course (swap du plan dessous), puis continue
    // et découvre le nouveau plan. Pas de snapshot nécessaire.
    const bar = new PIXI.Graphics()
    bar.beginFill(hexToInt(transition.color, 0x000000))
    bar.drawRect(0, 0, viewW, viewH)
    bar.endFill()
    overlay.addChild(bar)
    const dir = transition.direction
    const setPos = (t: number) => {
      // t ∈ [0,1] : trajet de 2× l'écran (entre à t=0, couvre à t=0.5, sort à t=1).
      const travel = 1 - 2 * t
      bar.x = dir === 'left' ? viewW * travel : dir === 'right' ? -viewW * travel : 0
      bar.y = dir === 'up' ? viewH * travel : dir === 'down' ? -viewH * travel : 0
    }
    setPos(0)
    let swapped = false
    return {
      update(deltaMs: number): boolean {
        elapsed += deltaMs
        const t = Math.min(1, elapsed / durationMs)
        if (t >= 0.5 && !swapped) {
          swapped = true
          swapFn()
        }
        setPos(t)
        if (t >= 1) {
          overlay.removeChild(bar)
          bar.destroy()
          return true
        }
        return false
      },
    }
  }

  // crossfade / wipe / iris : snapshot du frame sortant posé sur l'overlay,
  // le nouveau plan est monté immédiatement dessous.
  let snapshot: PIXI.Sprite | null = null
  let mask: PIXI.Graphics | null = null
  try {
    const snapCanvas = app.renderer.extract.canvas(app.stage) as HTMLCanvasElement
    snapshot = new PIXI.Sprite(PIXI.Texture.from(snapCanvas))
    snapshot.width = viewW
    snapshot.height = viewH
    overlay.addChild(snapshot)
  } catch {
    // Extract indisponible (contexte perdu…) : dégénère en cut.
    swapFn()
    return { update: () => true }
  }
  swapFn()

  const cleanup = () => {
    if (mask) {
      if (snapshot) snapshot.mask = null
      overlay.removeChild(mask)
      mask.destroy()
      mask = null
    }
    if (snapshot) {
      overlay.removeChild(snapshot)
      snapshot.destroy({ texture: true, baseTexture: true })
      snapshot = null
    }
  }

  if (transition.kind === 'crossfade') {
    return {
      update(deltaMs: number): boolean {
        elapsed += deltaMs
        const t = Math.min(1, elapsed / durationMs)
        if (snapshot) snapshot.alpha = 1 - t
        if (t >= 1) {
          cleanup()
          return true
        }
        return false
      },
    }
  }

  if (transition.kind === 'wipe') {
    // Le snapshot est masqué par un rectangle qui glisse hors écran dans la
    // direction du volet → le nouveau plan est "révélé" derrière.
    mask = new PIXI.Graphics()
    mask.beginFill(0xffffff)
    mask.drawRect(0, 0, viewW, viewH)
    mask.endFill()
    overlay.addChild(mask)
    snapshot.mask = mask
    const dir = transition.direction
    return {
      update(deltaMs: number): boolean {
        elapsed += deltaMs
        const t = Math.min(1, elapsed / durationMs)
        if (mask) {
          mask.x = dir === 'left' ? -viewW * t : dir === 'right' ? viewW * t : 0
          mask.y = dir === 'up' ? -viewH * t : dir === 'down' ? viewH * t : 0
        }
        if (t >= 1) {
          cleanup()
          return true
        }
        return false
      },
    }
  }

  // iris : trou circulaire grandissant au centre du snapshot → ouverture sur le
  // nouveau plan. Masque redessiné chaque frame (rect plein écran + beginHole).
  mask = new PIXI.Graphics()
  overlay.addChild(mask)
  snapshot.mask = mask
  const maxRadius = Math.hypot(viewW, viewH) / 2
  return {
    update(deltaMs: number): boolean {
      elapsed += deltaMs
      const t = Math.min(1, elapsed / durationMs)
      if (mask) {
        mask.clear()
        mask.beginFill(0xffffff)
        mask.drawRect(0, 0, viewW, viewH)
        if (t > 0) {
          mask.beginHole()
          mask.drawCircle(viewW / 2, viewH / 2, maxRadius * t)
          mask.endHole()
        }
        mask.endFill()
      }
      if (t >= 1) {
        cleanup()
        return true
      }
      return false
    },
  }
}
