/**
 * CoTracker + Bones — Step 5 : Butterworth smoothing on resolved joint frames.
 *
 * Smooths `cotrackerBodyJointFrames` (body chain joints) and `cotrackerLegBoneFrames`
 * (hip/knee/foot per zone) in video coords. Stored in `*Smoothed` fields without
 * touching the raw frames. Downstream recompute uses the smoothed bones if available.
 */

import { useState } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { applyTemporalSmoothing } from '../../utils/trackingConstraints'
import TriangulationLoopPreview from './TriangulationLoopPreview'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function CoTrackerBonesBoneSmoothingStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const [cutoff, setCutoff] = useState(mesh?.cotrackerBoneSmoothingCutoffHz ?? 4)
  const [busy, setBusy] = useState(false)

  if (!mesh?.cotrackerBodyJointFrames || !mesh?.cotrackerLegBoneFrames) {
    return <div className="step-content"><p>Lancez d'abord le calcul (étape 4).</p></div>
  }

  async function handleApply() {
    setBusy(true)
    try {
      const bodyFrames = mesh!.cotrackerBodyJointFrames!
      // Reformat [jointIdx][frame] → [frame][jointIdx] for applyTemporalSmoothing
      const nFrames = bodyFrames[0]?.length ?? 0
      const perFrame: Point2D[][] = new Array(nFrames)
      for (let f = 0; f < nFrames; f++) {
        perFrame[f] = bodyFrames.map(traj => traj[f])
      }
      const smoothedPerFrame = applyTemporalSmoothing(perFrame, undefined, cutoff, 24)
      const smoothedBody: Point2D[][] = bodyFrames.map((_traj, j) =>
        smoothedPerFrame.map(fr => fr[j])
      )

      // Legs : smooth each joint of the chain independently
      const legFrames = mesh!.cotrackerLegBoneFrames!
      const smoothedLegs: typeof legFrames = {}
      const smoothPart = (arr: Point2D[]): Point2D[] => {
        if (arr.length === 0) return arr
        const wrapped: Point2D[][] = arr.map(p => [p])
        const sm = applyTemporalSmoothing(wrapped, undefined, cutoff, 24)
        return sm.map(f => f[0])
      }
      for (const [zoneId, parts] of Object.entries(legFrames)) {
        smoothedLegs[zoneId] = { chain: parts.chain.map(smoothPart) }
      }

      const updatedAnim: Animation = {
        ...animation,
        mesh: {
          ...mesh!,
          cotrackerBodyJointFramesSmoothed: smoothedBody,
          cotrackerLegBoneFramesSmoothed: smoothedLegs,
          cotrackerBoneSmoothingCutoffHz: cutoff,
          cotrackerBoneSmoothingValidated: true,
        },
      }
      await onSave({ ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="step-content">
      <h2>Lissage des bones (Butterworth)</h2>
      <p>Filtre passe-bas zero-phase sur les positions des joints (corps + pattes). Plus la coupure est basse, plus le mouvement est lissé.</p>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        Cutoff (Hz)
        <input type="range" min={0.5} max={12} step={0.5} value={cutoff}
          onChange={e => setCutoff(Number(e.target.value))} />
        <span>{cutoff.toFixed(1)}</span>
      </label>
      <button className="btn-primary" onClick={handleApply} disabled={busy} style={{ marginTop: 12 }}>
        {busy ? 'Lissage…' : 'Appliquer le lissage'}
      </button>
      {mesh.cotrackerBoneSmoothingValidated && (
        <p style={{ color: '#22c55e' }}>✓ Lissage appliqué (cutoff {mesh.cotrackerBoneSmoothingCutoffHz} Hz)</p>
      )}
      <TriangulationLoopPreview project={project} animation={animation} background="#fff" onSave={onSave} />
    </div>
  )
}
