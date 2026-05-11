/**
 * CoTracker Bones — Étape "Calcul Animation" : lissages post-LBS.
 *
 * Pré-requis : étape LBS validée (walkBodyFrames + cotrackerBodyJointFrames
 * disponibles). Deux cartes : Lissage bones (Butterworth sur joints) et
 * Lissage triangulation (Butterworth sur walkBodyFrames + walkZoneFrames,
 * cutoff partagé). Preview wireframe + bones.
 */

import { useState } from 'react'
import type { Project, Animation, Point2D } from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import TriangulationLoopPreview from './TriangulationLoopPreview'
import { applyTemporalSmoothing } from '../../utils/trackingConstraints'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function CoTrackerBonesAnimationStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation

  const ready =
    mesh?.cotrackerFrames != null &&
    mesh?.cotrackerSkeleton != null &&
    mesh?.cotrackerBonesValidated === true &&
    tri?.step3Validated === true

  const hasComputed = mesh?.walkBodyFrames != null && mesh?.walkZoneFrames != null
  const lbsValidated = mesh?.cotrackerLBSValidated ?? false

  const [boneCutoff, setBoneCutoff] = useState(mesh?.cotrackerBoneSmoothingCutoffHz ?? 4)
  const [meshCutoff, setMeshCutoff] = useState(mesh?.walkBodyFramesSmoothingCutoffHz ?? 4)
  const [boneBusy, setBoneBusy] = useState(false)
  const [meshBusy, setMeshBusy] = useState(false)

  async function applyBoneSmoothing(validate: boolean) {
    if (!mesh?.cotrackerBodyJointFrames || !mesh?.cotrackerLegBoneFrames) return
    setBoneBusy(true)
    try {
      const bodyJointFrames = mesh.cotrackerBodyJointFrames
      const nFrames = bodyJointFrames[0]?.length ?? 0
      const perFrame: Point2D[][] = new Array(nFrames)
      for (let f = 0; f < nFrames; f++) perFrame[f] = bodyJointFrames.map(traj => traj[f])
      const smoothedPerFrame = applyTemporalSmoothing(perFrame, undefined, boneCutoff, 24)
      const smoothedBody: Point2D[][] = bodyJointFrames.map((_t, j) => smoothedPerFrame.map(fr => fr[j]))

      const smoothedLegs: typeof mesh.cotrackerLegBoneFrames = {}
      for (const [zoneId, parts] of Object.entries(mesh.cotrackerLegBoneFrames)) {
        const smoothPart = (arr: Point2D[]): Point2D[] => {
          if (arr.length === 0) return arr
          const wrapped: Point2D[][] = arr.map(p => [p])
          const sm = applyTemporalSmoothing(wrapped, undefined, boneCutoff, 24)
          return sm.map(f => f[0])
        }
        smoothedLegs[zoneId] = {
          hip: smoothPart(parts.hip),
          knee: smoothPart(parts.knee),
          foot: smoothPart(parts.foot),
        }
      }

      const updatedAnim: Animation = {
        ...animation,
        mesh: {
          ...mesh,
          cotrackerBodyJointFramesSmoothed: smoothedBody,
          cotrackerLegBoneFramesSmoothed: smoothedLegs,
          cotrackerBoneSmoothingCutoffHz: boneCutoff,
          cotrackerBoneSmoothingValidated: validate ? true : (mesh.cotrackerBoneSmoothingValidated ?? false),
        },
      }
      await onSave({ ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) })
    } finally {
      setBoneBusy(false)
    }
  }

  async function applyMeshSmoothing(validate: boolean) {
    if (!mesh?.walkBodyFrames || !mesh?.walkZoneFrames) return
    setMeshBusy(true)
    try {
      const bodySmoothed = applyTemporalSmoothing(mesh.walkBodyFrames, undefined, meshCutoff, 24)
      const zoneSmoothed: Record<string, Point2D[][]> = {}
      for (const [zoneId, frames] of Object.entries(mesh.walkZoneFrames)) {
        zoneSmoothed[zoneId] = applyTemporalSmoothing(frames, undefined, meshCutoff, 24)
      }

      const updatedAnim: Animation = {
        ...animation,
        mesh: {
          ...mesh,
          walkBodyFramesSmoothed: bodySmoothed,
          walkZoneFramesSmoothed: zoneSmoothed,
          walkBodyFramesSmoothingCutoffHz: meshCutoff,
          walkZoneFramesSmoothingCutoffHz: meshCutoff,
          walkBodyFramesSmoothingValidated: validate ? true : (mesh.walkBodyFramesSmoothingValidated ?? false),
          walkZoneFramesSmoothingValidated: validate ? true : (mesh.walkZoneFramesSmoothingValidated ?? false),
        },
      }
      await onSave(
        { ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) },
        [
          { animationId: animation.id, field: 'walkBodyFramesSmoothed' },
          { animationId: animation.id, field: 'walkZoneFramesSmoothed' },
        ],
      )
    } finally {
      setMeshBusy(false)
    }
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

  if (!lbsValidated || !hasComputed) {
    return (
      <div className="step-content">
        <p>Validez d'abord l'étape <strong>LBS</strong> (paramétrage du skinning) pour générer les frames du maillage.</p>
      </div>
    )
  }

  const boneValidated = mesh?.cotrackerBoneSmoothingValidated ?? false
  const meshValidated = (mesh?.walkBodyFramesSmoothingValidated && mesh?.walkZoneFramesSmoothingValidated) ?? false

  return (
    <div className="step-content">
      <h2>Calcul Animation</h2>

      <TriangulationLoopPreview project={project} animation={animation} mode="wireframe" height={420} background="#fff" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div style={{ border: '1px solid #333', borderRadius: 4, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Lissage bones</h3>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Butterworth zero-phase sur les positions des joints corps + pattes.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            Cutoff
            <input type="range" min={0.5} max={12} step={0.5} value={boneCutoff}
              onChange={e => setBoneCutoff(Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ minWidth: 36, textAlign: 'right' }}>{boneCutoff.toFixed(1)} Hz</span>
          </label>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn-secondary btn-sm" onClick={() => applyBoneSmoothing(false)} disabled={boneBusy}>
              {boneBusy ? '…' : 'Appliquer'}
            </button>
            <button className="btn-primary btn-sm" onClick={() => applyBoneSmoothing(true)} disabled={boneBusy}>
              Valider
            </button>
          </div>
          {boneValidated && <p style={{ color: '#22c55e', fontSize: 12, marginTop: 6 }}>
            ✓ Validé (cutoff {mesh?.cotrackerBoneSmoothingCutoffHz} Hz)
          </p>}
        </div>

        <div style={{ border: '1px solid #333', borderRadius: 4, padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Lissage triangulation</h3>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            Butterworth zero-phase sur chaque vertex du maillage (body + pattes).
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            Cutoff
            <input type="range" min={0.5} max={12} step={0.5} value={meshCutoff}
              onChange={e => setMeshCutoff(Number(e.target.value))} style={{ flex: 1 }} />
            <span style={{ minWidth: 36, textAlign: 'right' }}>{meshCutoff.toFixed(1)} Hz</span>
          </label>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn-secondary btn-sm" onClick={() => applyMeshSmoothing(false)} disabled={meshBusy}>
              {meshBusy ? '…' : 'Appliquer'}
            </button>
            <button className="btn-primary btn-sm" onClick={() => applyMeshSmoothing(true)} disabled={meshBusy}>
              Valider
            </button>
          </div>
          {meshValidated && <p style={{ color: '#22c55e', fontSize: 12, marginTop: 6 }}>
            ✓ Validé (cutoff {mesh?.walkBodyFramesSmoothingCutoffHz} Hz)
          </p>}
        </div>
      </div>
    </div>
  )
}
