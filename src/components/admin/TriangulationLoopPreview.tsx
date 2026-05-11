/**
 * TriangulationLoopPreview — preview PIXI loopable du maillage animé (body + pattes).
 *
 * Réutilisé dans les étapes CoTracker (Calcul, Lissage Bones) et V2 (Lissage Maillage
 * Corps/Pattes) + V3 LoopPreview. Lit walkBodyFramesSmoothed ?? walkBodyFrames et
 * walkZoneFramesSmoothed ?? walkZoneFrames. Aucun impact sauvegarde.
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, ProjectTriangulation, WalkLimbSeparation } from '../../types/project'
import { LoopPlayback } from '../../utils/loopPlayback'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'

interface Props {
  project: Project
  animation: Animation
  /** Hauteur du canvas preview (défaut 360px). */
  height?: number
  /** Toggle smoothed/raw frames (défaut true = smoothed prioritaire). */
  preferSmoothed?: boolean
  /** 'textured' (défaut) = meshes texturés ; 'wireframe' = pas de texture, juste l'overlay. */
  mode?: 'textured' | 'wireframe'
  /** Background color (hex string for CSS + number 0xRRGGBB for PIXI). Défaut sombre. */
  background?: string
}

function buildPseudoSeparation(tri: ProjectTriangulation): WalkLimbSeparation {
  return {
    zones: tri.zones.filter(z => z.id !== 'body').map((z, i) => ({
      id: z.id,
      label: z.label,
      color: z.color,
      bezierNodes: [],
      zOrder: z.zOrder ?? (i + 1),
      legIndex: i,
    })),
    overlapMargin: 0,
    zonePoints: tri.zonePoints,
    zoneTriangles: tri.zoneTriangles,
    bodyTriangleIndices: [],
    bodyPoints: tri.bodyPoints,
    bodyTriangles: tri.bodyTriangles,
    hiddenFaceZones: tri.hiddenFaceZones,
    hiddenFaceLimbZones: tri.hiddenFaceLimbZones,
  }
}

export default function TriangulationLoopPreview({
  project, animation, height = 360, preferSmoothed = true, mode = 'textured', background = '#111',
}: Props) {
  const bgNum = parseInt(background.replace('#', ''), 16)
  const mesh = animation.mesh
  const tri = project.projectTriangulation

  const bodyFrames = useMemo(
    () => preferSmoothed
      ? (mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null)
      : (mesh?.walkBodyFrames ?? null),
    [mesh?.walkBodyFramesSmoothed, mesh?.walkBodyFrames, preferSmoothed],
  )
  const zoneFrames = useMemo(
    () => preferSmoothed
      ? (mesh?.walkZoneFramesSmoothed ?? mesh?.walkZoneFrames ?? null)
      : (mesh?.walkZoneFrames ?? null),
    [mesh?.walkZoneFramesSmoothed, mesh?.walkZoneFrames, preferSmoothed],
  )

  const [crossfade, setCrossfade] = useState(7)
  const [speed, setSpeed] = useState(1.0)
  const [playing, setPlaying] = useState(true)
  const [showMesh, setShowMesh] = useState(mode === 'wireframe')
  const [showBones, setShowBones] = useState(mode === 'wireframe')

  const crossfadeRef = useRef(crossfade); crossfadeRef.current = crossfade
  const speedRef = useRef(speed); speedRef.current = speed
  const playingRef = useRef(playing); playingRef.current = playing
  const showMeshRef = useRef(showMesh); showMeshRef.current = showMesh
  const showBonesRef = useRef(showBones); showBonesRef.current = showBones

  const containerRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const setupRef = useRef<ZoneMeshSetup | null>(null)
  const playbacksRef = useRef<{ region: 'body' | string; pb: LoopPlayback }[]>([])

  useEffect(() => {
    if (!tri || !bodyFrames || !zoneFrames || !project.originalImageBlob) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let imageUrl: string | null = null

    const init = async () => {
      imageUrl = URL.createObjectURL(project.originalImageBlob!)
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('image load failed'))
        img.src = imageUrl!
      })
      if (cancelled) return

      const imgW = img.naturalWidth
      const imgH = img.naturalHeight
      const texCanvas = document.createElement('canvas')
      texCanvas.width = imgW; texCanvas.height = imgH
      texCanvas.getContext('2d')!.drawImage(img, 0, 0)
      const texture = PIXI.Texture.from(texCanvas)

      const rect = container.getBoundingClientRect()
      const viewW = Math.max(rect.width, 100)
      const viewH = Math.max(rect.height, 100)

      const app = new PIXI.Application({
        width: viewW, height: viewH, backgroundColor: bgNum, antialias: true,
      })
      container.appendChild(app.view as HTMLCanvasElement)
      appRef.current = app
      app.ticker.maxFPS = 30

      const scale = Math.min(viewW / imgW, viewH / imgH)
      const offsetX = (viewW - imgW * scale) / 2
      const offsetY = (viewH - imgH * scale) / 2

      const separation = buildPseudoSeparation(tri)
      const setup = buildZoneMeshes(separation, [], [], texture, imgW, imgH, scale, offsetX, offsetY)
      if (mode === 'textured') app.stage.addChild(setup.container)
      setupRef.current = setup

      const overlay = new PIXI.Graphics()
      app.stage.addChild(overlay)

      // Bone frames (cotracker), in VIDEO coords — converted to image coords for drawing.
      const skeleton = mesh?.cotrackerSkeleton ?? null
      const bodyJointFrames = preferSmoothed
        ? (mesh?.cotrackerBodyJointFramesSmoothed ?? mesh?.cotrackerBodyJointFrames ?? null)
        : (mesh?.cotrackerBodyJointFrames ?? null)
      const legBoneFrames = preferSmoothed
        ? (mesh?.cotrackerLegBoneFramesSmoothed ?? mesh?.cotrackerLegBoneFrames ?? null)
        : (mesh?.cotrackerLegBoneFrames ?? null)
      const vidW = mesh?.cotrackerVideoWidth ?? imgW
      const vidH = mesh?.cotrackerVideoHeight ?? imgH
      const vid2imgX = imgW / vidW, vid2imgY = imgH / vidH
      const toScreen = (vx: number, vy: number) => ({
        x: vx * vid2imgX * scale + offsetX,
        y: vy * vid2imgY * scale + offsetY,
      })

      const playbacks: typeof playbacksRef.current = []
      playbacks.push({ region: 'body', pb: new LoopPlayback(bodyFrames, { crossfadeFrames: crossfadeRef.current, speed: speedRef.current }) })
      for (const zoneId of Object.keys(zoneFrames)) {
        playbacks.push({ region: zoneId, pb: new LoopPlayback(zoneFrames[zoneId], { crossfadeFrames: crossfadeRef.current, speed: speedRef.current }) })
      }
      playbacksRef.current = playbacks

      const tickerFn = (delta: number) => {
        if (!playingRef.current) return
        for (const { pb } of playbacks) { pb.speed = speedRef.current; pb.advance(delta) }
        const bodyPb = playbacks.find(p => p.region === 'body')
        if (bodyPb) updateZoneMeshVertices(setup.bodyMesh, bodyPb.pb.getPositions(), scale, offsetX, offsetY)
        for (const zm of setup.zoneMeshes) {
          const p = playbacks.find(pb => pb.region === zm.zoneId)
          if (p) updateZoneMeshVertices(zm, p.pb.getPositions(), scale, offsetX, offsetY)
        }
        for (const hf of setup.hiddenFaceMeshes) {
          if (bodyPb) updateZoneMeshVertices(hf, bodyPb.pb.getPositions(), scale, offsetX, offsetY)
        }
        for (const hfl of setup.hiddenFaceLimbMeshes) {
          const baseZoneId = hfl.zoneId.replace(/^__hfl_/, '')
          const p = playbacks.find(pb => pb.region === baseZoneId)
          if (p) updateZoneMeshVertices(hfl, p.pb.getPositions(), scale, offsetX, offsetY)
        }

        // Overlay : triangulation + bones
        overlay.clear()
        const drawMesh = showMeshRef.current
        const drawBones = showBonesRef.current
        if (drawMesh) {
          overlay.lineStyle(1, 0x00ff88, 0.6)
          // Body
          if (bodyPb) {
            const positions = bodyPb.pb.getPositions()
            for (const [a, b, c] of tri.bodyTriangles) {
              const pa = positions[a], pb_ = positions[b], pc = positions[c]
              if (!pa || !pb_ || !pc) continue
              const A = { x: pa.x * scale + offsetX, y: pa.y * scale + offsetY }
              const B = { x: pb_.x * scale + offsetX, y: pb_.y * scale + offsetY }
              const C = { x: pc.x * scale + offsetX, y: pc.y * scale + offsetY }
              overlay.moveTo(A.x, A.y).lineTo(B.x, B.y).lineTo(C.x, C.y).lineTo(A.x, A.y)
            }
          }
          // Zones
          for (const zoneId of Object.keys(tri.zoneTriangles)) {
            const p = playbacks.find(pb => pb.region === zoneId)
            if (!p) continue
            const positions = p.pb.getPositions()
            for (const [a, b, c] of tri.zoneTriangles[zoneId]) {
              const pa = positions[a], pb_ = positions[b], pc = positions[c]
              if (!pa || !pb_ || !pc) continue
              const A = { x: pa.x * scale + offsetX, y: pa.y * scale + offsetY }
              const B = { x: pb_.x * scale + offsetX, y: pb_.y * scale + offsetY }
              const C = { x: pc.x * scale + offsetX, y: pc.y * scale + offsetY }
              overlay.moveTo(A.x, A.y).lineTo(B.x, B.y).lineTo(C.x, C.y).lineTo(A.x, A.y)
            }
          }
        }
        if (drawBones && skeleton && bodyPb) {
          const f = bodyPb.pb.currentFrame
          // Body chain
          if (bodyJointFrames && bodyJointFrames.length > 0) {
            overlay.lineStyle(3, 0x3b82f6, 0.95)
            let prev: { x: number; y: number } | null = null
            for (let j = 0; j < skeleton.bodyChain.length; j++) {
              const traj = bodyJointFrames[j]
              const v = traj?.[f] ?? traj?.[traj.length - 1]
              if (!v) { prev = null; continue }
              const s = toScreen(v.x, v.y)
              if (prev) overlay.moveTo(prev.x, prev.y).lineTo(s.x, s.y)
              prev = s
            }
            overlay.lineStyle(0)
            overlay.beginFill(0x3b82f6)
            for (let j = 0; j < skeleton.bodyChain.length; j++) {
              const traj = bodyJointFrames[j]
              const v = traj?.[f] ?? traj?.[traj.length - 1]
              if (!v) continue
              const s = toScreen(v.x, v.y)
              overlay.drawCircle(s.x, s.y, 4)
            }
            overlay.endFill()
          }
          // Legs
          if (legBoneFrames) {
            overlay.lineStyle(3, 0xfb923c, 0.95)
            for (const leg of skeleton.legs) {
              const lf = legBoneFrames[leg.zoneId]
              if (!lf || !lf.chain || lf.chain.length < 2) continue
              const pts = lf.chain.map(traj => traj?.[f] ?? traj?.[traj.length - 1]).filter(Boolean) as { x: number; y: number }[]
              if (pts.length < 2) continue
              const first = toScreen(pts[0].x, pts[0].y)
              overlay.moveTo(first.x, first.y)
              for (let i = 1; i < pts.length; i++) {
                const s = toScreen(pts[i].x, pts[i].y)
                overlay.lineTo(s.x, s.y)
              }
            }
            overlay.lineStyle(0)
            overlay.beginFill(0xfb923c)
            for (const leg of skeleton.legs) {
              const lf = legBoneFrames[leg.zoneId]
              if (!lf || !lf.chain) continue
              for (const traj of lf.chain) {
                const v = traj?.[f] ?? traj?.[traj.length - 1]
                if (!v) continue
                const s = toScreen(v.x, v.y)
                overlay.drawCircle(s.x, s.y, 4)
              }
            }
            overlay.endFill()
          }
        }
      }
      app.ticker.add(tickerFn)
    }

    init().catch(err => console.error('[TriLoopPreview] init failed:', err))

    return () => {
      cancelled = true
      if (appRef.current) {
        appRef.current.destroy(true, { children: true, texture: false, baseTexture: false })
        appRef.current = null
      }
      setupRef.current = null
      playbacksRef.current = []
      if (imageUrl) URL.revokeObjectURL(imageUrl)
      while (container.firstChild) container.removeChild(container.firstChild)
    }
  }, [project, animation, tri, bodyFrames, zoneFrames, crossfade, mode, bgNum])

  if (!tri?.step3Validated) {
    return <div style={{ padding: 8, opacity: 0.7, fontSize: 12 }}>Preview indisponible : Triangulation projet incomplète.</div>
  }
  if (!bodyFrames || !zoneFrames) {
    return <div style={{ padding: 8, opacity: 0.7, fontSize: 12 }}>Preview indisponible : lancez d&apos;abord le calcul (body + pattes).</div>
  }

  return (
    <div style={{ marginTop: 12, border: '1px solid #333', borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', background: '#1a1a1a', flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 12 }}>Preview animation</strong>
        <button className="btn-secondary btn-sm" onClick={() => setPlaying(p => !p)}>
          {playing ? '⏸' : '▶'}
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
          Crossfade
          <input type="range" min={0} max={20} step={1} value={crossfade}
            onChange={e => setCrossfade(parseInt(e.target.value))} style={{ width: 80 }} />
          <span style={{ minWidth: 28, textAlign: 'right' }}>{crossfade}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
          Vitesse
          <input type="range" min={0.25} max={2} step={0.05} value={speed}
            onChange={e => setSpeed(parseFloat(e.target.value))} style={{ width: 80 }} />
          <span style={{ minWidth: 32, textAlign: 'right' }}>{speed.toFixed(2)}×</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={showMesh} onChange={e => setShowMesh(e.target.checked)} />
          Triangulation
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={showBones} onChange={e => setShowBones(e.target.checked)} />
          Bones
        </label>
      </div>
      <div ref={containerRef} style={{ height, background }} />
    </div>
  )
}
