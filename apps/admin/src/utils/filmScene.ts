import type { Film, FilmPlan, Scene, SceneFilm, SceneFilmPlan } from '../types/project'

/**
 * Adapter moteur : convertit le FILM (modèle projet, indépendant) vers la forme
 * consommée par le moteur de lecture existant (ScenePlayer / ScenePlayback /
 * FilmDirector), qui lit une `Scene` avec `scene.film`. UNIQUE point de contact
 * entre le nouveau modèle et le moteur — le moteur n'est pas modifié.
 */

function planToScenePlan(plan: FilmPlan): SceneFilmPlan {
  return {
    id: plan.id,
    ...(plan.name != null && { name: plan.name }),
    background: plan.backdrop,
    foreground: plan.overlay,
    cameraX: plan.cameraX,
    entrySide: plan.entrySide,
    points: plan.points,
    ending: plan.ending,
    ...(plan.transitionToNext != null && { transitionToNext: plan.transitionToNext }),
    ...(plan.moveAnimationId != null && { moveAnimationId: plan.moveAnimationId }),
    ...(plan.moveSpeedPxPerSec != null && { moveSpeedPxPerSec: plan.moveSpeedPxPerSec }),
    ...(plan.idleSpeedMul != null && { idleSpeedMul: plan.idleSpeedMul }),
  }
}

export function filmToSceneFilm(film: Film): SceneFilm {
  return {
    enabled: true,
    plans: film.plans.map(planToScenePlan),
    ...(film.moveAnimationId != null && { moveAnimationId: film.moveAnimationId }),
    moveSpeedPxPerSec: film.moveSpeedPxPerSec,
    ...(film.idleSpeedMul != null && { idleSpeedMul: film.idleSpeedMul }),
    endBehavior: 'menu',
  }
}

/**
 * Construit la pseudo-scène de LECTURE d'un film : décor du 1er plan comme
 * background (dimensionne le cadre), personnage/musique du film, rest point
 * factice (jamais atteint en mode film).
 */
export function buildFilmScene(film: Film): Scene {
  const firstWithBackdrop = film.plans.find(pl => pl.backdrop != null)
  return {
    id: 'film',
    name: 'Film',
    background: firstWithBackdrop?.backdrop ?? null,
    foreground: firstWithBackdrop?.overlay ?? null,
    characterScale: film.character.scale,
    characterY: 0,
    restPoint: { id: 'film-rest', backgroundX: 0 },
    film: filmToSceneFilm(film),
    characterFacing: film.character.facing,
    characterOriginU: film.character.originU,
    characterOriginV: film.character.originV,
    ...(film.music != null && {
      ambientSound: { id: film.music.id, name: film.music.name, blob: film.music.blob, volume: film.music.volume },
    }),
    entry: 'fixed',
    speakSounds: [],
    speakSoundBlobs: [],
  }
}
