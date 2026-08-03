/**
 * Moteur de regard PARTAGÉ de la mascotte : un seul jeu de listeners globaux
 * (pointeur + scroll) et une seule boucle rAF qui écrit les variables CSS
 * `--pp-gaze-x/--pp-gaze-y` (unités SVG, clampées) sur chaque mascotte abonnée.
 * La boucle ne tourne que s'il y a au moins un abonné et que l'onglet est visible.
 */

const MAX_OFFSET = 2.6 // amplitude max du regard (unités du viewBox 120)
const LERP = 0.12

interface GazeState {
  x: number
  y: number
}

const targets = new Map<HTMLElement, GazeState>()

let rafId = 0
let listenersOn = false
let pointerX = -1
let pointerY = -1
let scrollImpulse = 0
let lastScrollY = 0

function onPointer(e: PointerEvent) {
  pointerX = e.clientX
  pointerY = e.clientY
}

function onScroll() {
  const y = window.scrollY
  scrollImpulse += (y - lastScrollY) * 0.02
  scrollImpulse = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, scrollImpulse))
  lastScrollY = y
}

function tick() {
  rafId = 0
  if (targets.size === 0) return

  scrollImpulse *= 0.9

  for (const [el, state] of targets) {
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    let tx = 0
    let ty = 0
    if (pointerX >= 0) {
      // Direction vers le pointeur, saturée à ~180 px de distance
      tx = Math.max(-1, Math.min(1, (pointerX - cx) / 180)) * MAX_OFFSET
      ty = Math.max(-1, Math.min(1, (pointerY - cy) / 180)) * MAX_OFFSET
    }
    ty = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, ty + scrollImpulse))

    state.x += (tx - state.x) * LERP
    state.y += (ty - state.y) * LERP
    el.style.setProperty('--pp-gaze-x', `${state.x.toFixed(2)}px`)
    el.style.setProperty('--pp-gaze-y', `${state.y.toFixed(2)}px`)
  }

  schedule()
}

function schedule() {
  if (!rafId && targets.size > 0 && !document.hidden) {
    rafId = requestAnimationFrame(tick)
  }
}

function onVisibility() {
  if (!document.hidden) schedule()
}

/** Abonne une mascotte au regard partagé. Retourne la fonction de désabonnement. */
export function subscribeGaze(el: HTMLElement): () => void {
  targets.set(el, { x: 0, y: 0 })
  if (!listenersOn) {
    listenersOn = true
    lastScrollY = window.scrollY
    window.addEventListener('pointermove', onPointer, { passive: true })
    window.addEventListener('pointerdown', onPointer, { passive: true })
    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
  }
  schedule()
  return () => {
    targets.delete(el)
    if (targets.size === 0 && listenersOn) {
      listenersOn = false
      window.removeEventListener('pointermove', onPointer)
      window.removeEventListener('pointerdown', onPointer)
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibility)
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0 }
    }
  }
}
