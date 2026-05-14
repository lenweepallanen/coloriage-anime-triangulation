/**
 * CoTracker bones — Étape "LBS" : paramétrage du solver de skinning.
 *
 * Sélecteur de mode (lbs / lbs-arap / lbs-area) + sliders. "Calculer" lance le
 * compute avec les params courants. Preview wireframe + bones. "Valider" pour
 * passer à l'étape suivante.
 */

import { useState } from 'react'
import type { Project, Animation, CoTrackerLBSParams, CoTrackerLBSMode } from '../../types/project'
import { DEFAULT_COTRACKER_LBS_PARAMS } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationLoopPreview from './TriangulationLoopPreview'
import { runCoTrackerLBSCompute } from '../../utils/cotrackerLBSCompute'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

const MODE_LABELS: Record<CoTrackerLBSMode, string> = {
  'lbs-arap': 'LBS + ARAP intérieur',
  'lbs-contour-arap': 'LBS + ARAP contour + ARAP intérieur',
}

const MODE_HELP: Record<CoTrackerLBSMode, string> = {
  'lbs-arap':
    'Après LBS, on pinne le contour de chaque zone aux positions LBS et on laisse l\'intérieur ' +
    'se relaxer par ARAP (préservation de la rigidité locale). Élimine fortement le flattening ' +
    'intérieur. Coût : ~10-30 ms/frame.',
  'lbs-contour-arap':
    'Après LBS : (1) le contour est relaxé par ARAP 1D fermé avec les positions LBS comme ' +
    'cibles douces (λ) — préserve longueurs et angles d\'arêtes du contour, supprime le shear ' +
    'et le candy-wrapper sur la silhouette. (2) l\'intérieur est ensuite ré-solvé par ARAP body ' +
    'avec le nouveau contour pinné dur. Coût : ~15-40 ms/frame.',
}

export default function CoTrackerBonesLBSStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation

  const initial: CoTrackerLBSParams = mesh?.cotrackerLBSParams ?? DEFAULT_COTRACKER_LBS_PARAMS
  const [params, setParams] = useState<CoTrackerLBSParams>(initial)
  const [progress, setProgress] = useState<{ phase: string; frame: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ready =
    mesh?.cotrackerFrames != null &&
    mesh?.cotrackerSkeleton != null &&
    mesh?.cotrackerBonesValidated === true &&
    tri?.step3Validated === true &&
    mesh?.cotrackerVideoWidth != null &&
    mesh?.cotrackerVideoHeight != null

  const hasComputed = mesh?.walkBodyFrames != null && mesh?.walkZoneFrames != null
  const validated = mesh?.cotrackerLBSValidated ?? false

  async function handleCompute(validate: boolean, overrideParams?: CoTrackerLBSParams) {
    setError(null)
    setProgress({ phase: 'init', frame: 0, total: 1 })
    const usedParams = overrideParams ?? params
    try {
      const result = await runCoTrackerLBSCompute(project, animation, usedParams, setProgress)
      const updatedAnim: Animation = {
        ...animation,
        mesh: {
          ...mesh!,
          walkBodyFrames: result.walkBodyFrames,
          walkZoneFrames: result.walkZoneFrames,
          cotrackerBodyJointFrames: result.cotrackerBodyJointFrames,
          cotrackerLegBoneFrames: result.cotrackerLegBoneFrames,
          // Invalidate downstream
          walkBodyFramesSmoothed: null,
          walkZoneFramesSmoothed: null,
          walkBodyFramesSmoothingValidated: false,
          walkZoneFramesSmoothingValidated: false,
          cotrackerBodyJointFramesSmoothed: null,
          cotrackerLegBoneFramesSmoothed: null,
          cotrackerBoneSmoothingValidated: false,
          cotrackerLBSParams: usedParams,
          cotrackerLBSValidated: validate ? true : (mesh?.cotrackerLBSValidated ?? false),
        },
      }
      await onSave(
        { ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) },
        [
          { animationId: animation.id, field: 'walkBodyFrames' },
          { animationId: animation.id, field: 'walkZoneFrames' },
        ],
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }

  function updateParam<K extends keyof CoTrackerLBSParams>(key: K, val: CoTrackerLBSParams[K]) {
    setParams(p => ({ ...p, [key]: val }))
  }

  if (!ready) {
    return (
      <div className="step-content">
        <p>Pré-requis :</p>
        <ul>
          <li>{mesh?.cotrackerTrackingValidated ? '✓' : '○'} Tracking CoTracker3 validé</li>
          <li>{mesh?.cotrackerBonesValidated ? '✓' : '○'} Squelette validé</li>
          <li>{tri?.step3Validated ? '✓' : '○'} Triangulation projet validée jusqu'aux faces cachées</li>
        </ul>
      </div>
    )
  }

  return (
    <div className="step-content">
      <h2>LBS — paramétrage du skinning</h2>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Mode de calcul</label>
          <select
            value={params.mode}
            onChange={e => updateParam('mode', e.target.value as CoTrackerLBSMode)}
            style={{ width: '100%', padding: '4px 8px', background: '#222', color: '#fff', border: '1px solid #444' }}
          >
            {(Object.keys(MODE_LABELS) as CoTrackerLBSMode[]).map(m => (
              <option key={m} value={m}>{MODE_LABELS[m]}</option>
            ))}
          </select>
          <p style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>{MODE_HELP[params.mode]}</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ minWidth: 100 }}>Exposant weights</span>
          <input type="range" min={2} max={8} step={0.5} value={params.weightPower}
            onChange={e => updateParam('weightPower', Number(e.target.value))} style={{ flex: 1 }} />
          <span style={{ minWidth: 28, textAlign: 'right' }}>{params.weightPower.toFixed(1)}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <span style={{ minWidth: 100 }}>ε (saturation)</span>
          <input type="range" min={0.1} max={5} step={0.1} value={params.weightEpsilon}
            onChange={e => updateParam('weightEpsilon', Number(e.target.value))} style={{ flex: 1 }} />
          <span style={{ minWidth: 28, textAlign: 'right' }}>{params.weightEpsilon.toFixed(1)}</span>
        </label>
        {params.mode === 'lbs-arap' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 100 }}>Itérations ARAP</span>
            <input type="range" min={1} max={6} step={1} value={params.arapIterations ?? 3}
              onChange={e => updateParam('arapIterations', Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ minWidth: 28, textAlign: 'right' }}>{params.arapIterations ?? 3}</span>
          </label>
        )}
        {params.mode === 'lbs-contour-arap' && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ minWidth: 100 }}>Attache λ (contour)</span>
              <input type="range" min={0.05} max={10} step={0.05} value={params.contourArapLambda ?? 1.0}
                onChange={e => updateParam('contourArapLambda', Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ minWidth: 36, textAlign: 'right' }}>{(params.contourArapLambda ?? 1.0).toFixed(2)}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ minWidth: 100 }}>Itérations contour</span>
              <input type="range" min={1} max={6} step={1} value={params.contourArapIterations ?? 2}
                onChange={e => updateParam('contourArapIterations', Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ minWidth: 28, textAlign: 'right' }}>{params.contourArapIterations ?? 2}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ minWidth: 100 }}>Itérations ARAP intérieur</span>
              <input type="range" min={1} max={6} step={1} value={params.arapIterations ?? 3}
                onChange={e => updateParam('arapIterations', Number(e.target.value))} style={{ flex: 1 }} />
              <span style={{ minWidth: 28, textAlign: 'right' }}>{params.arapIterations ?? 3}</span>
            </label>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button
          className="btn-secondary"
          onClick={() => handleCompute(false, { ...params, weightSmoothIterations: 0 })}
          disabled={progress != null}
        >
          {progress ? `Calcul… (${progress.phase} ${progress.frame}/${progress.total})` : 'Calculer & Preview (brut)'}
        </button>
        <button className="btn-primary" onClick={() => handleCompute(true)} disabled={progress != null}>
          Valider
        </button>
        {validated && <span style={{ color: '#22c55e', fontSize: 12 }}>✓ Validé ({MODE_LABELS[mesh?.cotrackerLBSParams?.mode ?? 'lbs-arap']})</span>}
      </div>

      <div style={{
        marginBottom: 12, padding: 10, background: '#1a1a1a', border: '1px solid #333', borderRadius: 4,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Lissage Laplacien des weights</div>
        <p style={{ fontSize: 11, opacity: 0.75, margin: '0 0 8px 0' }}>
          Diffuse les transitions de poids entre bones le long des arêtes du mesh.
          Élimine le shear sur les triangles à cheval sur deux bones. À 0 itération,
          comportement strictement identique au calcul brut.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 100 }}>Itérations</span>
            <input
              type="range" min={0} max={8} step={1}
              value={params.weightSmoothIterations ?? 0}
              onChange={e => updateParam('weightSmoothIterations', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 28, textAlign: 'right' }}>{params.weightSmoothIterations ?? 0}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 100 }}>Force α</span>
            <input
              type="range" min={0.1} max={1} step={0.05}
              value={params.weightSmoothAlpha ?? 0.5}
              onChange={e => updateParam('weightSmoothAlpha', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 28, textAlign: 'right' }}>{(params.weightSmoothAlpha ?? 0.5).toFixed(2)}</span>
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn-secondary"
            onClick={() => handleCompute(false)}
            disabled={progress != null || (params.weightSmoothIterations ?? 0) === 0}
          >
            Appliquer lissage & Preview
          </button>
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            Re-calcule LBS avec les weights lissés (puis ARAP/area selon mode)
          </span>
        </div>
      </div>

      <div style={{
        marginBottom: 12, padding: 10, background: '#1a1a1a', border: '1px solid #333', borderRadius: 4,
      }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Post-pass préservation d'aire (toutes modes)</div>
        <p style={{ fontSize: 11, opacity: 0.75, margin: '0 0 8px 0' }}>
          Champ scalaire de scale par vertex (rapport aire repos / aire courante) lissé sur le mesh,
          puis chaque vertex s'écarte ou se rapproche de la moyenne de ses voisins. Préserve l'aire
          régionale (la tête retrouve sa taille) sans casser les aspects ratio. À 0 force, désactivé.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 100 }}>Force</span>
            <input
              type="range" min={0} max={1} step={0.05}
              value={params.areaPostStrength ?? 0}
              onChange={e => updateParam('areaPostStrength', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 36, textAlign: 'right' }}>{(params.areaPostStrength ?? 0).toFixed(2)}</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 100 }}>Itérations</span>
            <input
              type="range" min={1} max={8} step={1}
              value={params.areaPostIterations ?? 3}
              onChange={e => updateParam('areaPostIterations', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ minWidth: 28, textAlign: 'right' }}>{params.areaPostIterations ?? 3}</span>
          </label>
        </div>
      </div>

      {error && <p style={{ color: '#f87171' }}>{error}</p>}

      {hasComputed && (
        <TriangulationLoopPreview
          project={project} animation={animation}
          mode="wireframe" height={460} preferSmoothed={false} background="#fff"
          onSave={onSave}
        />
      )}
    </div>
  )
}
