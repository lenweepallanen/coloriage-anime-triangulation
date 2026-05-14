/**
 * CoTracker + Bones — Step 3 : skeleton definition.
 *
 * Workflow canvas-driven :
 *  1. "+ Joint" / "+ Patte X" → mode placement. Clic(s) libre(s) sur canvas pour
 *     poser le joint (ou hip puis foot).
 *  2. Clic sur un joint/endpoint existant (canvas ou panneau) → sélection.
 *  3. Bouton "Ajouter points barycentres" → mode assign. Chaque clic sur un point
 *     tracker du canvas l'ajoute/retire du barycentre du endpoint sélectionné.
 *  4. "Valider barycentre" → retour mode idle. Le joint affiche désormais sa
 *     position dérivée (barycentre uniforme).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Project, Animation, Point2D,
  CoTrackerSkeleton, CoTrackerBodyJoint, CoTrackerLegBone, CoTrackerEndpointRef,
} from '../../types/project'
import type { UploadHint } from '../../db/projectsStore'
import { resolveEndpointFrame } from '../../utils/cotrackerBoneSolver'
import { solveElbowIK, getElbowParams } from '../../utils/boneSolver'

interface Props {
  project: Project
  animation: Animation
  onSave: (project: Project, hints?: UploadHint[]) => Promise<void>
}

// Libellés legacy — fallback pour rétrocompat des anciens projets si la zone n'a pas de label dans projectTriangulation.zones.
const LEGACY_ZONE_LABELS: Record<string, string> = {
  'leg-fl': 'Patte AVG', 'leg-fr': 'Patte AVD', 'leg-bl': 'Patte ARG', 'leg-br': 'Patte ARD',
}

type PickTarget =
  | { kind: 'body-joint'; index: number }
  | { kind: 'leg-joint'; zoneId: string; jointIndex: number } // 0 = hip, last = foot

type Mode =
  | { kind: 'idle' }
  | { kind: 'place-chain' }
  | { kind: 'place-leg-chain'; zoneId: string }
  | { kind: 'assign-bary' }

const JOINT_HIT_R = 12       // video px
const TRACKER_HIT_R = 14

export default function CoTrackerBonesBoneStep({ project, animation, onSave }: Props) {
  const mesh = animation.mesh
  const cotrackerFrames = mesh?.cotrackerFrames ?? null
  const points = mesh?.cotrackerPoints ?? []

  const initial: CoTrackerSkeleton = mesh?.cotrackerSkeleton ?? { bodyChain: [], legs: [] }
  const [skeleton, setSkeleton] = useState<CoTrackerSkeleton>(initial)

  // Zones membres dérivées de la Triangulation projet (body + N membres). Fallback : les zones déjà référencées dans le squelette.
  const memberZones = useMemo(() => {
    const projZones = project.projectTriangulation?.zones ?? []
    const fromProj = projZones.filter(z => z.id !== 'body')
    if (fromProj.length > 0) return fromProj
    // Legacy fallback : on dérive les zones depuis le squelette existant
    const ids = Array.from(new Set(skeleton.legs.map(l => l.zoneId)))
    return ids.map(id => ({ id, label: LEGACY_ZONE_LABELS[id] ?? id, color: '#888' }))
  }, [project.projectTriangulation?.zones, skeleton.legs])
  const zoneLabelOf = (zoneId: string): string =>
    memberZones.find(z => z.id === zoneId)?.label ?? LEGACY_ZONE_LABELS[zoneId] ?? zoneId
  const [pick, setPick] = useState<PickTarget | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  // Draft positions for joints/endpoints not yet bound to a barycentre.
  // Local-only (lost on reload — validation requires pointIds.length > 0).
  const [drafts, setDrafts] = useState<Record<string, Point2D>>({})
  const [error, setError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragKneeRef = useRef<{ zoneId: string } | null>(null)
  const didDragRef = useRef(false)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoDims, setVideoDims] = useState<{ w: number; h: number; duration: number } | null>(null)
  const [frame, setFrame] = useState(0)
  const fps = 24

  useEffect(() => {
    if (!animation.videoBlob) return
    const url = URL.createObjectURL(animation.videoBlob)
    setVideoUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [animation.videoBlob])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onMeta = () => setVideoDims({ w: v.videoWidth, h: v.videoHeight, duration: v.duration })
    v.addEventListener('loadedmetadata', onMeta)
    return () => v.removeEventListener('loadedmetadata', onMeta)
  }, [videoUrl])

  const totalFrames = useMemo(() => videoDims ? Math.floor(videoDims.duration * fps) : 0, [videoDims])

  useEffect(() => {
    if (!videoRef.current || !videoDims) return
    videoRef.current.currentTime = Math.min(frame / fps, videoDims.duration - 0.001)
  }, [frame, videoDims])

  // ── Position resolution (uses barycentre if defined, else draft) ──
  function jointKey(j: CoTrackerBodyJoint) { return `body:${j.id}` }
  function legJointKey(l: CoTrackerLegBone, jointIndex: number) { return `leg:${l.id}:${jointIndex}` }
  function legChainRefs(leg: CoTrackerLegBone): CoTrackerEndpointRef[] {
    return [leg.hip, ...(leg.joints ?? []), leg.foot]
  }
  function legChainLen(leg: CoTrackerLegBone): number {
    return 2 + (leg.joints?.length ?? 0)
  }
  function setLegChainAt(leg: CoTrackerLegBone, jointIndex: number, ref: CoTrackerEndpointRef): CoTrackerLegBone {
    const refs = legChainRefs(leg)
    refs[jointIndex] = ref
    return { ...leg, hip: refs[0], foot: refs[refs.length - 1], joints: refs.slice(1, -1) }
  }

  function endpointPos(ref: CoTrackerEndpointRef, key: string): Point2D | null {
    if (ref.pointIds.length > 0 && cotrackerFrames) {
      return resolveEndpointFrame(ref, cotrackerFrames, frame)
    }
    return drafts[key] ?? null
  }

  // Position d'un endpoint au rest pose (frame 0). Utilisé par le solver IK.
  function endpointPos0(ref: CoTrackerEndpointRef, key: string): Point2D | null {
    if (ref.pointIds.length > 0 && cotrackerFrames) {
      return resolveEndpointFrame(ref, cotrackerFrames, 0)
    }
    return drafts[key] ?? null
  }

  // Position affichée d'un joint de patte, gère le mode 'solver' (knee = IK).
  function legJointDisplayPos(leg: CoTrackerLegBone, jointIndex: number): Point2D | null {
    const refs = legChainRefs(leg)
    const isKnee = leg.legSolverMode === 'solver' && jointIndex === 1 && refs.length === 3
    if (!isKnee) {
      return endpointPos(refs[jointIndex], legJointKey(leg, jointIndex))
    }
    const hip = endpointPos(leg.hip, legJointKey(leg, 0))
    const foot = endpointPos(leg.foot, legJointKey(leg, 2))
    const hip0 = endpointPos0(leg.hip, legJointKey(leg, 0))
    const foot0 = endpointPos0(leg.foot, legJointKey(leg, 2))
    if (!hip || !foot || !hip0 || !foot0 || !leg.kneeRestPos) {
      return leg.kneeRestPos ?? drafts[legJointKey(leg, 1)] ?? null
    }
    const { len1, len2, bendSide } = getElbowParams(hip0, foot0, leg.kneeRestPos)
    return solveElbowIK(hip, foot, len1, len2, bendSide)
  }

  // ── Drawing ──
  useEffect(() => {
    const c = canvasRef.current
    const v = videoRef.current
    if (!c || !v || !videoDims) return
    c.width = videoDims.w
    c.height = videoDims.h
    const ctx = c.getContext('2d')
    if (!ctx) return

    const render = () => {
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.drawImage(v, 0, 0, c.width, c.height)
      if (!cotrackerFrames) return

      // Tracker points
      for (const pt of points) {
        const traj = cotrackerFrames[pt.id]
        const p = traj?.[frame]
        if (!p) continue
        const inEndpoint = pick ? isPointInCurrentEndpoint(pt.id, pick, skeleton) : false
        ctx.fillStyle = pt.color
        ctx.beginPath()
        ctx.arc(p.x, p.y, inEndpoint ? 7 : 4, 0, Math.PI * 2)
        ctx.fill()
        if (inEndpoint) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }

      // Body chain segments
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 3
      ctx.beginPath()
      let started = false
      for (const j of skeleton.bodyChain) {
        const p = endpointPos(j.ref, jointKey(j))
        if (!p) { started = false; continue }
        if (!started) { ctx.moveTo(p.x, p.y); started = true }
        else ctx.lineTo(p.x, p.y)
      }
      ctx.stroke()
      skeleton.bodyChain.forEach((j, i) => {
        const p = endpointPos(j.ref, jointKey(j))
        if (!p) return
        const isPicked = pick?.kind === 'body-joint' && pick.index === i
        const isDraft = j.ref.pointIds.length === 0
        ctx.fillStyle = isDraft ? '#94a3b8' : '#3b82f6'
        ctx.beginPath(); ctx.arc(p.x, p.y, isPicked ? 8 : 6, 0, Math.PI * 2); ctx.fill()
        if (isPicked) { ctx.strokeStyle = '#fde047'; ctx.lineWidth = 2; ctx.stroke() }
      })

      // Legs
      for (const leg of skeleton.legs) {
        const refs = legChainRefs(leg)
        const positions = refs.map((_ref, ji) => legJointDisplayPos(leg, ji))
        // Chain segments
        ctx.strokeStyle = '#fb923c'; ctx.lineWidth = 2
        ctx.beginPath()
        let started = false
        for (const p of positions) {
          if (!p) { started = false; continue }
          if (!started) { ctx.moveTo(p.x, p.y); started = true }
          else ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
        // Joints
        positions.forEach((pos, ji) => {
          if (!pos) return
          const ref = refs[ji]
          const isPicked = pick?.kind === 'leg-joint' && pick.zoneId === leg.zoneId && pick.jointIndex === ji
          const isSolverKnee = leg.legSolverMode === 'solver' && ji === 1 && refs.length === 3
          const isDraft = !isSolverKnee && ref.pointIds.length === 0
          ctx.fillStyle = isSolverKnee ? '#22d3ee' : (isDraft ? '#94a3b8' : '#fb923c')
          ctx.beginPath(); ctx.arc(pos.x, pos.y, isPicked ? 7 : 5, 0, Math.PI * 2); ctx.fill()
          if (isPicked) { ctx.strokeStyle = '#fde047'; ctx.lineWidth = 2; ctx.stroke() }
        })
      }
    }
    let raf = 0
    const tick = () => { render(); raf = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [points, skeleton, cotrackerFrames, frame, videoDims, pick, drafts])

  // ── Canvas click handler ──
  function canvasToVideo(e: React.MouseEvent<HTMLCanvasElement>): Point2D {
    const c = canvasRef.current!
    const rect = c.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left) * (c.width / rect.width),
      y: (e.clientY - rect.top) * (c.height / rect.height),
    }
  }

  /** Returns the tracker(s) closest to a click. Single if clearly on one tracker,
   *  two if the click is roughly between two trackers (comparable distances). */
  function nearestTrackerIds(p: Point2D): string[] {
    if (!cotrackerFrames) return []
    const dists: { id: string; d: number }[] = []
    for (const pt of points) {
      const tp = cotrackerFrames[pt.id]?.[frame]
      if (!tp) continue
      dists.push({ id: pt.id, d: Math.hypot(tp.x - p.x, tp.y - p.y) })
    }
    if (dists.length === 0) return []
    dists.sort((a, b) => a.d - b.d)
    const [a, b] = dists
    // If second tracker is within 1.5× the distance of the first → click is "between" them.
    if (b && b.d < a.d * 1.5) return [a.id, b.id]
    return [a.id]
  }

  /** Distance d'un point au segment AB et paramètre t∈[0,1] de la projection. */
  function pointToSegment(p: Point2D, a: Point2D, b: Point2D): { dist: number; t: number } {
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 < 1e-6) return { dist: Math.hypot(p.x - a.x, p.y - a.y), t: 0 }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const cx = a.x + t * dx, cy = a.y + t * dy
    return { dist: Math.hypot(p.x - cx, p.y - cy), t }
  }

  /** Double-clic sur un segment de bone → insère un nouveau joint à la position. */
  function handleCanvasDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!cotrackerFrames) return
    if (mode.kind !== 'idle') return
    const p = canvasToVideo(e)

    // Hit-test joints en premier : si on tape un joint existant, on ne fait rien.
    for (const j of skeleton.bodyChain) {
      const pos = endpointPos(j.ref, jointKey(j))
      if (pos && Math.hypot(pos.x - p.x, pos.y - p.y) < JOINT_HIT_R) return
    }
    for (const leg of skeleton.legs) {
      const refs = legChainRefs(leg)
      for (let ji = 0; ji < refs.length; ji++) {
        const pos = legJointDisplayPos(leg, ji)
        if (pos && Math.hypot(pos.x - p.x, pos.y - p.y) < JOINT_HIT_R) return
      }
    }

    const SEG_HIT_R = 10
    let bestBody: { dist: number; insertAt: number } | null = null
    for (let i = 0; i < skeleton.bodyChain.length - 1; i++) {
      const a = endpointPos(skeleton.bodyChain[i].ref, jointKey(skeleton.bodyChain[i]))
      const b = endpointPos(skeleton.bodyChain[i + 1].ref, jointKey(skeleton.bodyChain[i + 1]))
      if (!a || !b) continue
      const { dist } = pointToSegment(p, a, b)
      if (dist < SEG_HIT_R && (!bestBody || dist < bestBody.dist)) bestBody = { dist, insertAt: i + 1 }
    }

    let bestLeg: { dist: number; zoneId: string; insertJointIdx: number } | null = null
    for (const leg of skeleton.legs) {
      // Skip IK solver legs : la chaîne 3-points est gérée par IK 2-bones, ajouter un joint la casse.
      if (leg.legSolverMode === 'solver' && legChainLen(leg) === 3) continue
      const refs = legChainRefs(leg)
      for (let i = 0; i < refs.length - 1; i++) {
        const a = legJointDisplayPos(leg, i)
        const b = legJointDisplayPos(leg, i + 1)
        if (!a || !b) continue
        const { dist } = pointToSegment(p, a, b)
        if (dist < SEG_HIT_R && (!bestLeg || dist < bestLeg.dist)) {
          // refs[i+1] = leg.joints[i] (joints[0] = refs[1]). Insertion à l'index i de joints.
          bestLeg = { dist, zoneId: leg.zoneId, insertJointIdx: i }
        }
      }
    }

    // Choix du meilleur entre body et leg
    if (!bestBody && !bestLeg) return
    const pickLeg = bestLeg && (!bestBody || bestLeg.dist < bestBody.dist)

    const nearestIds = nearestTrackerIds(p)
    const newRef: CoTrackerEndpointRef = nearestIds.length > 0
      ? makeEndpointRef(nearestIds)
      : { pointIds: [], weights: [] }

    if (pickLeg && bestLeg) {
      const { zoneId, insertJointIdx } = bestLeg
      const legIdx = skeleton.legs.findIndex(l => l.zoneId === zoneId)
      if (legIdx < 0) return
      const leg = skeleton.legs[legIdx]
      const oldJoints = leg.joints ?? []
      const newJoints = [...oldJoints.slice(0, insertJointIdx), newRef, ...oldJoints.slice(insertJointIdx)]
      // Renumérotation drafts pour les joints d'index >= insertJointIdx (shift +1)
      // Les drafts sont indexés sur la chaîne complète (hip=0, joints[k]=k+1, foot=last).
      // L'insertion dans joints à insertJointIdx déplace les joints d'index ≥ insertJointIdx+1 dans la chaîne.
      const newChainIdx = insertJointIdx + 1 // index dans la chaîne (hip + joints + foot)
      setDrafts(d => {
        const out: typeof d = {}
        const prefix = `leg:${leg.id}:`
        for (const [k, v] of Object.entries(d)) {
          if (k.startsWith(prefix)) {
            const idx = parseInt(k.slice(prefix.length), 10)
            if (idx >= newChainIdx) out[`${prefix}${idx + 1}`] = v
            else out[k] = v
          } else out[k] = v
        }
        if (nearestIds.length === 0) out[`${prefix}${newChainIdx}`] = p
        return out
      })
      setSkeleton(sk => {
        const idx = sk.legs.findIndex(l => l.zoneId === zoneId)
        if (idx < 0) return sk
        const newLegs = sk.legs.slice()
        newLegs[idx] = { ...newLegs[idx], joints: newJoints }
        return { ...sk, legs: newLegs }
      })
      setPick({ kind: 'leg-joint', zoneId, jointIndex: newChainIdx })
      return
    }

    if (bestBody) {
      const id = crypto.randomUUID()
      const joint: CoTrackerBodyJoint = {
        id, name: `joint${skeleton.bodyChain.length + 1}`, ref: newRef,
      }
      if (nearestIds.length === 0) setDrafts(d => ({ ...d, [`body:${id}`]: p }))
      setSkeleton(sk => ({
        ...sk,
        bodyChain: [...sk.bodyChain.slice(0, bestBody!.insertAt), joint, ...sk.bodyChain.slice(bestBody!.insertAt)],
      }))
      setPick({ kind: 'body-joint', index: bestBody.insertAt })
    }
  }

  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    if (mode.kind !== 'idle' || frame !== 0) return
    const p = canvasToVideo(e)
    for (const leg of skeleton.legs) {
      if (leg.legSolverMode !== 'solver') continue
      const knee = legJointDisplayPos(leg, 1)
      if (!knee) continue
      const d2 = (knee.x - p.x) ** 2 + (knee.y - p.y) ** 2
      if (d2 < JOINT_HIT_R * JOINT_HIT_R) {
        dragKneeRef.current = { zoneId: leg.zoneId }
        didDragRef.current = false
        e.preventDefault()
        return
      }
    }
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!dragKneeRef.current) return
    didDragRef.current = true
    const p = canvasToVideo(e)
    const zoneId = dragKneeRef.current.zoneId
    setSkeleton(sk => {
      const idx = sk.legs.findIndex(l => l.zoneId === zoneId)
      if (idx < 0) return sk
      const newLegs = sk.legs.slice()
      newLegs[idx] = { ...newLegs[idx], kneeRestPos: p }
      return { ...sk, legs: newLegs }
    })
  }

  function handleMouseUp() {
    if (dragKneeRef.current) dragKneeRef.current = null
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (didDragRef.current) { didDragRef.current = false; return }
    if (!cotrackerFrames) return
    const p = canvasToVideo(e)

    if (mode.kind === 'place-chain') {
      const nearestIds = nearestTrackerIds(p)
      const id = crypto.randomUUID()
      const joint: CoTrackerBodyJoint = {
        id, name: `joint${skeleton.bodyChain.length + 1}`,
        ref: nearestIds.length > 0 ? makeEndpointRef(nearestIds) : { pointIds: [], weights: [] },
      }
      const newIdx = skeleton.bodyChain.length
      setSkeleton(sk => ({ ...sk, bodyChain: [...sk.bodyChain, joint] }))
      if (nearestIds.length === 0) setDrafts(d => ({ ...d, [`body:${id}`]: p }))
      setPick({ kind: 'body-joint', index: newIdx })
      // Stay in place-chain mode for successive clicks.
      return
    }

    if (mode.kind === 'place-leg-chain') {
      const { zoneId } = mode
      const nearestIds = nearestTrackerIds(p)
      const newRef: CoTrackerEndpointRef = nearestIds.length > 0
        ? makeEndpointRef(nearestIds)
        : { pointIds: [], weights: [] }
      let leg = skeleton.legs.find(l => l.zoneId === zoneId)
      let newJointIndex = 0
      if (!leg) {
        // First click → create leg with hip only (foot still draft = same position)
        leg = {
          id: crypto.randomUUID(),
          zoneId, name: zoneLabelOf(zoneId),
          hip: newRef,
          joints: [],
          foot: { pointIds: [], weights: [] },
        }
        const newLeg = leg
        setSkeleton(sk => ({ ...sk, legs: [...sk.legs, newLeg] }))
        newJointIndex = 0
      } else {
        // Append : if foot is still empty (no point + no draft) → fill foot.
        // Otherwise insert a new joint between hip/joints and foot.
        const footIsDraftEmpty = leg.foot.pointIds.length === 0
          && !drafts[`leg:${leg.id}:${legChainLen(leg) - 1}`]
        if (footIsDraftEmpty) {
          newJointIndex = legChainLen(leg) - 1
          setSkeleton(sk => {
            const idx = sk.legs.findIndex(l => l.zoneId === zoneId)
            if (idx < 0) return sk
            const newLegs = sk.legs.slice()
            newLegs[idx] = { ...newLegs[idx], foot: newRef }
            return { ...sk, legs: newLegs }
          })
        } else {
          newJointIndex = (leg.joints?.length ?? 0) + 1
          setSkeleton(sk => {
            const idx = sk.legs.findIndex(l => l.zoneId === zoneId)
            if (idx < 0) return sk
            const newLegs = sk.legs.slice()
            const cur = newLegs[idx]
            newLegs[idx] = { ...cur, joints: [...(cur.joints ?? []), newRef] } as CoTrackerLegBone
            return { ...sk, legs: newLegs }
          })
        }
      }
      if (nearestIds.length === 0) {
        setDrafts(d => ({ ...d, [`leg:${leg!.id}:${newJointIndex}`]: p }))
      }
      setPick({ kind: 'leg-joint', zoneId, jointIndex: newJointIndex })
      return
    }

    if (mode.kind === 'assign-bary' && pick) {
      // Hit-test trackers
      let bestId: string | null = null
      let bestD2 = TRACKER_HIT_R * TRACKER_HIT_R
      for (const pt of points) {
        const tp = cotrackerFrames[pt.id]?.[frame]
        if (!tp) continue
        const d2 = (tp.x - p.x) ** 2 + (tp.y - p.y) ** 2
        if (d2 < bestD2) { bestD2 = d2; bestId = pt.id }
      }
      if (bestId) togglePickPoint(bestId)
      return
    }

    // idle : hit-test joints to select
    let best: { d2: number; target: PickTarget } | null = null
    skeleton.bodyChain.forEach((j, i) => {
      const pos = endpointPos(j.ref, jointKey(j))
      if (!pos) return
      const d2 = (pos.x - p.x) ** 2 + (pos.y - p.y) ** 2
      if (d2 < JOINT_HIT_R * JOINT_HIT_R && (!best || d2 < best.d2)) {
        best = { d2, target: { kind: 'body-joint', index: i } }
      }
    })
    for (const leg of skeleton.legs) {
      const refs = legChainRefs(leg)
      refs.forEach((_ref, ji) => {
        const pos = legJointDisplayPos(leg, ji)
        if (!pos) return
        const d2 = (pos.x - p.x) ** 2 + (pos.y - p.y) ** 2
        if (d2 < JOINT_HIT_R * JOINT_HIT_R && (!best || d2 < best.d2)) {
          best = { d2, target: { kind: 'leg-joint', zoneId: leg.zoneId, jointIndex: ji } }
        }
      })
    }
    if (best) setPick(best.target)
    else setPick(null)
  }

  function makeEndpointRef(pointIds: string[]): CoTrackerEndpointRef {
    const n = Math.max(1, pointIds.length)
    return { pointIds, weights: new Array(pointIds.length).fill(1 / n) }
  }

  function togglePickPoint(pointId: string) {
    if (!pick) return
    setSkeleton(sk => {
      if (pick.kind === 'body-joint') {
        const j = sk.bodyChain[pick.index]
        if (!j) return sk
        const newIds = toggleId(j.ref.pointIds, pointId)
        const newChain = sk.bodyChain.slice()
        newChain[pick.index] = { ...j, ref: makeEndpointRef(newIds) }
        return { ...sk, bodyChain: newChain }
      }
      const legIdx = sk.legs.findIndex(l => l.zoneId === pick.zoneId)
      if (legIdx < 0) return sk
      const leg = sk.legs[legIdx]
      const refs = legChainRefs(leg)
      const cur = refs[pick.jointIndex]
      if (!cur) return sk
      const newIds = toggleId(cur.pointIds, pointId)
      const newLegs = sk.legs.slice()
      newLegs[legIdx] = setLegChainAt(leg, pick.jointIndex, makeEndpointRef(newIds))
      return { ...sk, legs: newLegs }
    })
  }

  function startPlaceChain() {
    setMode({ kind: 'place-chain' })
    setPick(null)
  }
  function startPlaceLeg(zoneId: string) {
    setMode({ kind: 'place-leg-chain', zoneId })
    setPick(null)
  }
  function removeLegJoint(zoneId: string, jointIndex: number) {
    setSkeleton(sk => {
      const idx = sk.legs.findIndex(l => l.zoneId === zoneId)
      if (idx < 0) return sk
      const leg = sk.legs[idx]
      const joints = leg.joints ?? []
      // Only intermediate joints can be removed (not hip / foot).
      if (jointIndex <= 0 || jointIndex >= 1 + joints.length) return sk
      const newJoints = joints.slice()
      newJoints.splice(jointIndex - 1, 1)
      const newLegs = sk.legs.slice()
      newLegs[idx] = { ...leg, joints: newJoints }
      return { ...sk, legs: newLegs }
    })
    setDrafts(d => { const c = { ...d }; delete c[`leg:${skeleton.legs.find(l => l.zoneId === zoneId)?.id}:${jointIndex}`]; return c })
    if (pick?.kind === 'leg-joint' && pick.zoneId === zoneId && pick.jointIndex === jointIndex) setPick(null)
  }
  function startAssignBary() {
    if (!pick) return
    setMode({ kind: 'assign-bary' })
  }
  function validateBary() {
    setMode({ kind: 'idle' })
  }
  function cancelMode() {
    setMode({ kind: 'idle' })
  }

  function deleteJoint(i: number) {
    const j = skeleton.bodyChain[i]
    setSkeleton(sk => ({ ...sk, bodyChain: sk.bodyChain.filter((_, k) => k !== i) }))
    setDrafts(d => { const c = { ...d }; delete c[`body:${j.id}`]; return c })
    if (pick?.kind === 'body-joint' && pick.index === i) setPick(null)
  }
  function setLegSolverMode(zoneId: string, newMode: 'barycentre' | 'solver') {
    setSkeleton(sk => {
      const idx = sk.legs.findIndex(l => l.zoneId === zoneId)
      if (idx < 0) return sk
      const leg = sk.legs[idx]
      const newLegs = sk.legs.slice()
      if (newMode === 'solver') {
        // Solver mode = exactement 1 joint intermédiaire (knee).
        let joints = leg.joints ?? []
        if (joints.length > 1) joints = joints.slice(0, 1)
        if (joints.length === 0) joints = [{ pointIds: [], weights: [] }]
        let kneeRestPos = leg.kneeRestPos ?? null
        if (!kneeRestPos) {
          // Init depuis la position courante du knee à frame 0.
          const ref = joints[0]
          if (ref.pointIds.length > 0 && cotrackerFrames) {
            kneeRestPos = resolveEndpointFrame(ref, cotrackerFrames, 0)
          } else {
            kneeRestPos = drafts[`leg:${leg.id}:1`] ?? null
          }
          if (!kneeRestPos) {
            const hip0 = leg.hip.pointIds.length > 0 && cotrackerFrames
              ? resolveEndpointFrame(leg.hip, cotrackerFrames, 0)
              : drafts[`leg:${leg.id}:0`]
            const foot0 = leg.foot.pointIds.length > 0 && cotrackerFrames
              ? resolveEndpointFrame(leg.foot, cotrackerFrames, 0)
              : drafts[`leg:${leg.id}:${1 + joints.length}`]
            if (hip0 && foot0) kneeRestPos = { x: (hip0.x + foot0.x) / 2, y: (hip0.y + foot0.y) / 2 }
          }
        }
        newLegs[idx] = { ...leg, legSolverMode: 'solver', joints, kneeRestPos, kneeMode: leg.kneeMode ?? 'rest' }
      } else {
        newLegs[idx] = { ...leg, legSolverMode: 'barycentre' }
      }
      return { ...sk, legs: newLegs }
    })
    if (pick?.kind === 'leg-joint' && pick.zoneId === zoneId) setPick(null)
  }

  function deleteLeg(zoneId: string) {
    const leg = skeleton.legs.find(l => l.zoneId === zoneId)
    setSkeleton(sk => ({ ...sk, legs: sk.legs.filter(l => l.zoneId !== zoneId) }))
    if (leg) setDrafts(d => {
      const c = { ...d }
      for (let i = 0; i < legChainLen(leg); i++) delete c[`leg:${leg.id}:${i}`]
      return c
    })
    if (pick?.kind === 'leg-joint' && pick.zoneId === zoneId) setPick(null)
  }

  async function handleValidate() {
    setError(null)
    if (skeleton.bodyChain.length < 2) { setError('Body chain : au moins 2 joints'); return }
    for (const j of skeleton.bodyChain) {
      if (j.ref.pointIds.length === 0) { setError(`Joint "${j.name}" sans barycentre`); return }
    }
    for (const leg of skeleton.legs) {
      if (leg.hip.pointIds.length === 0 || leg.foot.pointIds.length === 0) {
        setError(`Patte ${leg.name} : hip et foot doivent référencer ≥ 1 point`); return
      }
      if (leg.legSolverMode === 'solver') {
        if (!leg.kneeRestPos) {
          setError(`Patte ${leg.name} : position du genou non définie (drag-le sur le canvas en frame 0)`); return
        }
      } else {
        for (let i = 0; i < (leg.joints?.length ?? 0); i++) {
          if (leg.joints[i].pointIds.length === 0) {
            setError(`Patte ${leg.name} : joint intermédiaire #${i + 1} sans barycentre`); return
          }
        }
      }
    }
    const updatedAnim: Animation = {
      ...animation,
      mesh: {
        ...(mesh ?? {} as any),
        cotrackerSkeleton: skeleton,
        cotrackerBonesValidated: true,
        cotrackerBoneSmoothingValidated: false,
        walkBodyFrames: null,
        walkBodyFramesSmoothed: null,
        walkZoneFrames: null,
        walkZoneFramesSmoothed: null,
      },
    }
    await onSave({ ...project, animations: project.animations.map(a => a.id === animation.id ? updatedAnim : a) })
  }

  if (!cotrackerFrames) {
    return <div className="step-content"><p>Lancez d'abord CoTracker3 à l'étape 2.</p></div>
  }

  function legJointLabel(leg: CoTrackerLegBone, ji: number): string {
    const len = legChainLen(leg)
    if (ji === 0) return 'hip'
    if (ji === len - 1) return 'foot'
    return `joint ${ji}`
  }

  const pickLabel = pick
    ? pick.kind === 'body-joint'
      ? `Joint "${skeleton.bodyChain[pick.index]?.name ?? '?'}"`
      : (() => {
          const leg = skeleton.legs.find(l => l.zoneId === pick.zoneId)
          return leg ? `${zoneLabelOf(pick.zoneId)} — ${legJointLabel(leg, pick.jointIndex)}` : pick.zoneId
        })()
    : null

  const modeBanner = (() => {
    if (mode.kind === 'place-chain') return 'Cliquez successivement sur le canvas pour poser les joints de la body chain (barycentre = tracker le plus proche). Terminez quand vous avez fini.'
    if (mode.kind === 'place-leg-chain') return `Cliquez successivement pour poser hip, joints intermédiaires (genou, …) et foot de ${zoneLabelOf(mode.zoneId)}. Le 1er clic = hip, le dernier avant terminer = foot. Terminez quand vous avez fini.`
    if (mode.kind === 'assign-bary') return `Cliquez les points trackers pour les ajouter/retirer du barycentre — ${pickLabel}`
    return null
  })()

  return (
    <div className="step-content">
      <h2>Définition du squelette</h2>
      <p className="text-muted">
        "+ Body chain" : cliquez successivement sur le canvas pour poser chaque joint
        (barycentre auto = tracker le plus proche). Sélectionnez un joint et "Ajouter
        points barycentres" pour enrichir le barycentre. <strong>Double-clic sur un
        segment</strong> pour insérer un joint intermédiaire (body chain ou patte).
      </p>
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <video ref={videoRef} src={videoUrl ?? undefined} style={{ display: 'none' }} muted />
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            onDoubleClick={handleCanvasDoubleClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            style={{
              width: '100%', height: 'auto', background: '#000',
              cursor: mode.kind === 'idle' ? 'default' : 'crosshair',
            }}
          />
          {modeBanner && (
            <div style={{
              marginTop: 6, padding: '6px 10px', background: '#1e3a5f',
              border: '1px solid #3b82f6', color: '#fff', fontSize: 12,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>{modeBanner}</span>
              {mode.kind === 'assign-bary'
                ? <button className="btn-primary btn-sm" onClick={validateBary}>Valider barycentre</button>
                : (mode.kind === 'place-chain' || mode.kind === 'place-leg-chain')
                ? <button className="btn-primary btn-sm" onClick={cancelMode}>Terminer chaîne</button>
                : <button className="btn-ghost btn-sm" onClick={cancelMode}>Annuler</button>}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <input type="range" min={0} max={Math.max(0, totalFrames - 1)} value={frame}
              onChange={e => setFrame(Number(e.target.value))} style={{ flex: 1 }} />
            <span>{frame} / {Math.max(0, totalFrames - 1)}</span>
          </div>
        </div>
        <aside style={{ width: 300 }}>
          <section>
            <h3>Body chain</h3>
            <ol style={{ paddingLeft: 16 }}>
              {skeleton.bodyChain.map((j, i) => {
                const isPicked = pick?.kind === 'body-joint' && pick.index === i
                const isDraft = j.ref.pointIds.length === 0
                return (
                  <li key={j.id}>
                    <button
                      onClick={() => setPick({ kind: 'body-joint', index: i })}
                      style={{
                        background: isPicked ? '#1e3a5f' : 'transparent',
                        border: '1px solid #444',
                        color: isDraft ? '#94a3b8' : '#fff',
                        padding: '2px 6px', fontSize: 12,
                      }}
                    >
                      {j.name} ({j.ref.pointIds.length} pts){isDraft ? ' ⚠' : ''}
                    </button>
                    <button className="btn-icon btn-sm" onClick={() => deleteJoint(i)}>×</button>
                  </li>
                )
              })}
            </ol>
            <button className="btn-secondary btn-sm" onClick={startPlaceChain} disabled={mode.kind !== 'idle'}>
              + Body chain
            </button>
          </section>
          <section style={{ marginTop: 12 }}>
            <h3>Membres</h3>
            {memberZones.length === 0 && (
              <div style={{ fontSize: 11, opacity: 0.7, padding: '4px 0' }}>
                Aucune zone membre définie. Allez d'abord dans Triangulation projet → Zones SAM 2.
              </div>
            )}
            {memberZones.map(zone => {
              const z = zone.id
              const leg = skeleton.legs.find(l => l.zoneId === z)
              if (!leg) {
                return (
                  <div key={z}>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => startPlaceLeg(z)}
                      disabled={mode.kind !== 'idle'}
                    >+ {zone.label}</button>
                  </div>
                )
              }
              const refs = legChainRefs(leg)
              const legMode = leg.legSolverMode ?? 'barycentre'
              return (
                <div key={z} style={{ border: '1px solid #444', padding: 6, marginBottom: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: zone.color }}>{zone.label} ({refs.length} joints)</span>
                    <button className="btn-icon btn-sm" onClick={() => deleteLeg(z)}>×</button>
                  </div>
                  <div style={{ fontSize: 11, marginTop: 2, display: 'flex', gap: 8 }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <input type="radio" name={`mode-${z}`} checked={legMode === 'barycentre'}
                        onChange={() => setLegSolverMode(z, 'barycentre')} />
                      barycentre
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <input type="radio" name={`mode-${z}`} checked={legMode === 'solver'}
                        onChange={() => setLegSolverMode(z, 'solver')} />
                      solver IK
                    </label>
                  </div>
                  {legMode === 'solver' && (
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>
                      Drag du genou sur le canvas (frame 0) pour ajuster le rest pose.
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                    {refs.map((ref, ji) => {
                      const isPicked = pick?.kind === 'leg-joint' && pick.zoneId === z && pick.jointIndex === ji
                      const isSolverKnee = legMode === 'solver' && ji === 1 && refs.length === 3
                      const isDraft = !isSolverKnee && ref.pointIds.length === 0
                      const label = isSolverKnee ? 'knee (IK)' : legJointLabel(leg, ji)
                      const isMid = ji > 0 && ji < refs.length - 1 && !isSolverKnee
                      return (
                        <span key={ji} style={{ display: 'inline-flex', alignItems: 'center' }}>
                          <button
                            onClick={() => setPick({ kind: 'leg-joint', zoneId: z, jointIndex: ji })}
                            style={{
                              background: isPicked ? '#1e3a5f' : 'transparent',
                              border: '1px solid #444',
                              color: isDraft ? '#94a3b8' : '#fff',
                              padding: '2px 6px', fontSize: 11, marginRight: 1,
                            }}
                          >{label} ({ref.pointIds.length}){isDraft ? ' ⚠' : ''}</button>
                          {isMid && (
                            <button
                              className="btn-icon btn-sm"
                              title="Supprimer ce joint"
                              onClick={() => removeLegJoint(z, ji)}
                            >×</button>
                          )}
                        </span>
                      )
                    })}
                  </div>
                  <button
                    className="btn-ghost btn-sm"
                    style={{ marginTop: 4, fontSize: 11 }}
                    onClick={() => startPlaceLeg(z)}
                    disabled={mode.kind !== 'idle'}
                  >+ Joint (clic canvas)</button>
                </div>
              )
            })}
          </section>
          <section style={{ marginTop: 12 }}>
            <h3>Barycentre</h3>
            {pick ? (
              <>
                <p style={{ fontSize: 11, opacity: 0.8 }}>Sélection : {pickLabel}</p>
                {(() => {
                  const pickedLeg = pick.kind === 'leg-joint' ? skeleton.legs.find(l => l.zoneId === pick.zoneId) : null
                  const isSolverKnee = pickedLeg?.legSolverMode === 'solver'
                    && pick.kind === 'leg-joint' && pick.jointIndex === 1
                    && legChainLen(pickedLeg) === 3
                  if (isSolverKnee) {
                    return <p style={{ fontSize: 11, opacity: 0.7 }}>Knee résolu par IK — drag sur le canvas (frame 0) pour ajuster.</p>
                  }
                  return (
                    <button
                      className="btn-primary btn-sm"
                      onClick={startAssignBary}
                      disabled={mode.kind === 'assign-bary'}
                    >
                      Ajouter points barycentres
                    </button>
                  )
                })()}
                {(() => {
                  let ref: CoTrackerEndpointRef | undefined
                  if (pick.kind === 'body-joint') {
                    ref = skeleton.bodyChain[pick.index]?.ref
                  } else {
                    const leg = skeleton.legs.find(l => l.zoneId === pick.zoneId)
                    if (leg) ref = legChainRefs(leg)[pick.jointIndex]
                  }
                  if (!ref || ref.pointIds.length === 0) {
                    return <p style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>Aucun point.</p>
                  }
                  return (
                    <ul style={{ listStyle: 'none', padding: 0, marginTop: 6, maxHeight: 160, overflowY: 'auto' }}>
                      {ref.pointIds.map(pid => {
                        const pt = points.find(p => p.id === pid)
                        return (
                          <li key={pid} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                            <span style={{
                              width: 10, height: 10, borderRadius: '50%',
                              background: pt?.color ?? '#888', display: 'inline-block',
                            }} />
                            <span style={{ flex: 1, fontSize: 11 }}>{pt?.name ?? pid.slice(0, 6)}</span>
                            <button className="btn-icon btn-sm" onClick={() => togglePickPoint(pid)}>×</button>
                          </li>
                        )
                      })}
                    </ul>
                  )
                })()}
              </>
            ) : (
              <p style={{ fontSize: 11, opacity: 0.7 }}>Cliquez un joint ou un endpoint pour le sélectionner.</p>
            )}
          </section>
          <div style={{ marginTop: 12 }}>
            <button className="btn-primary" onClick={handleValidate}>Valider le squelette</button>
            {mesh?.cotrackerBonesValidated && <p style={{ color: '#22c55e', fontSize: 12 }}>✓ Squelette validé</p>}
            {error && <p style={{ color: '#f87171', fontSize: 12 }}>{error}</p>}
          </div>
        </aside>
      </div>
    </div>
  )
}

function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
}

function isPointInCurrentEndpoint(pointId: string, pick: PickTarget | null, sk: CoTrackerSkeleton): boolean {
  if (!pick) return false
  if (pick.kind === 'body-joint') return sk.bodyChain[pick.index]?.ref.pointIds.includes(pointId) ?? false
  const leg = sk.legs.find(l => l.zoneId === pick.zoneId)
  if (!leg) return false
  const refs = [leg.hip, ...(leg.joints ?? []), leg.foot]
  return refs[pick.jointIndex]?.pointIds.includes(pointId) ?? false
}
