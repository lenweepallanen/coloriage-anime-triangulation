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
  'lbs': 'LBS pur',
  'lbs-arap': 'LBS + ARAP intérieur',
  'lbs-area': 'LBS + préservation aire',
}

const MODE_HELP: Record<CoTrackerLBSMode, string> = {
  'lbs':
    'Skinning standard : chaque vertex bouge avec une moyenne pondérée des sub-bones. ' +
    'Le contour subit l\'effet candy-wrapper (averaging linéaire de rotations). Augmenter ' +
    'l\'exposant des weights rend chaque vertex plus mono-bone et atténue l\'aplatissement.',
  'lbs-arap':
    'Après LBS, on pinne le contour de chaque zone aux positions LBS et on laisse l\'intérieur ' +
    'se relaxer par ARAP (préservation de la rigidité locale). Élimine fortement le flattening ' +
    'intérieur. Coût : ~10-30 ms/frame.',
  'lbs-area':
    'Post-pass triangle par triangle : on scale les vertices autour du centroïde pour ramener ' +
    'l\'aire courante vers l\'aire de repos. Atténue le rétrécissement sans changer la nature ' +
    'du LBS. Plus rapide qu\'ARAP, qualité inférieure.',
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

  async function handleCompute(validate: boolean) {
    setError(null)
    setProgress({ phase: 'init', frame: 0, total: 1 })
    try {
      const result = await runCoTrackerLBSCompute(project, animation, params, setProgress)
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
          cotrackerLBSParams: params,
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
        {params.mode === 'lbs-area' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <span style={{ minWidth: 100 }}>Force area</span>
            <input type="range" min={0} max={1} step={0.05} value={params.areaStrength ?? 0.5}
              onChange={e => updateParam('areaStrength', Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ minWidth: 28, textAlign: 'right' }}>{(params.areaStrength ?? 0.5).toFixed(2)}</span>
          </label>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <button className="btn-secondary" onClick={() => handleCompute(false)} disabled={progress != null}>
          {progress ? `Calcul… (${progress.phase} ${progress.frame}/${progress.total})` : 'Calculer & Preview'}
        </button>
        <button className="btn-primary" onClick={() => handleCompute(true)} disabled={progress != null}>
          Valider
        </button>
        {validated && <span style={{ color: '#22c55e', fontSize: 12 }}>✓ Validé ({MODE_LABELS[mesh?.cotrackerLBSParams?.mode ?? 'lbs']})</span>}
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
