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

/**
 * Ouverture ('reveal') / fermeture ('conceal') du FILM : même vocabulaire visuel
 * que les transitions de plans, mais sur un seul bord — un aplat couleur
 * (défaut noir) découvre le 1er plan, ou recouvre le dernier. Pas de snapshot :
 * il n'y a rien avant le film / après le film.
 * - fadeBlack / crossfade : fondu couleur (alpha 1→0 ou 0→1)
 * - wipe : volet coloré qui sort de l'écran (reveal) / entre jusqu'à couvrir (conceal)
 * - iris : trou circulaire qui s'ouvre (reveal) / se referme (conceal)
 * En 'conceal', l'aplat RESTE affiché à la fin (le film se termine couvert).
 */
export function startFilmEdgeTransition(
  app: PIXI.Application,
  overlay: PIXI.Container,
  transition: FilmPlanTransition,
  mode: 'reveal' | 'conceal',
): PlanTransitionRunner {
  const durationMs = transitionDurationMs(transition)
  if (transition.kind === 'cut' || durationMs <= 0) {
    return { update: () => true }
  }
  const viewW = app.screen.width
  const viewH = app.screen.height
  const color = hexToInt('color' in transition ? transition.color : undefined, 0x000000)
  let elapsed = 0
  /** Progression du DÉCOUVREMENT : 0 = écran couvert, 1 = écran dégagé. */
  const openAt = (t: number): number => (mode === 'reveal' ? t : 1 - t)

  const g = new PIXI.Graphics()
  overlay.addChild(g)
  const done = (): boolean => {
    if (mode === 'reveal') {
      overlay.removeChild(g)
      g.destroy()
    }
    return true
  }

  if (transition.kind === 'wipe') {
    const dir = transition.direction
    g.beginFill(color)
    g.drawRect(0, 0, viewW, viewH)
    g.endFill()
    return {
      update(deltaMs: number): boolean {
        elapsed += deltaMs
        const t = Math.min(1, elapsed / durationMs)
        const open = openAt(t)
        // open 0 → couvre l'écran ; open 1 → entièrement sorti dans `dir`.
        g.x = dir === 'left' ? -viewW * open : dir === 'right' ? viewW * open : 0
        g.y = dir === 'up' ? -viewH * open : dir === 'down' ? viewH * open : 0
        return t >= 1 ? done() : false
      },
    }
  }

  if (transition.kind === 'iris') {
    // Rayon SURDIMENSIONNÉ (×1.3) : le cercle dépasse les coins bien avant la
    // fin — sans ça les coins restent noirs jusqu'à la dernière frame puis
    // « poppent » au retrait de l'overlay. Progression smoothstep (douce).
    const maxRadius = (Math.hypot(viewW, viewH) / 2) * 1.3
    return {
      update(deltaMs: number): boolean {
        elapsed += deltaMs
        const t = Math.min(1, elapsed / durationMs)
        const lin = openAt(t)
        const open = lin * lin * (3 - 2 * lin)
        g.clear()
        g.beginFill(color)
        g.drawRect(0, 0, viewW, viewH)
        if (open > 0) {
          g.beginHole()
          g.drawCircle(viewW / 2, viewH / 2, maxRadius * open)
          g.endHole()
        }
        g.endFill()
        return t >= 1 ? done() : false
      },
    }
  }

  // fadeBlack / crossfade : fondu couleur.
  g.beginFill(color)
  g.drawRect(0, 0, viewW, viewH)
  g.endFill()
  g.alpha = mode === 'reveal' ? 1 : 0
  return {
    update(deltaMs: number): boolean {
      elapsed += deltaMs
      const t = Math.min(1, elapsed / durationMs)
      g.alpha = 1 - openAt(t)
      return t >= 1 ? done() : false
    },
  }
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
  // Rayon ×1.3 : le cercle dépasse les coins avant la fin (sinon ils restent
  // couverts jusqu'à la dernière frame et « poppent » au cleanup).
  mask = new PIXI.Graphics()
  overlay.addChild(mask)
  snapshot.mask = mask
  const maxRadius = (Math.hypot(viewW, viewH) / 2) * 1.3
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
