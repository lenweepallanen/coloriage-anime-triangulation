/**
 * MembersBonesV3LoopPreviewStep — V3 étape "Preview Boucle" (preview-only).
 *
 * Affiche l'animation V3 en boucle infinie avec crossfade configurable. Aucun impact
 * sur la sauvegarde / les scènes / le scan — purement visuel pour valider le rendu
 * loopable depuis l'admin.
 *
 * Utilise zoneMeshRenderer + LoopPlayback (une instance par région : body + 4 pattes,
 * cursors synchronisés car même totalFrames et même advanceMs).
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Animation, Point2D, ProjectTriangulation, WalkLimbSeparation } from '../../types/project'
import { LoopPlayback } from '../../utils/loopPlayback'
import { buildZoneMeshes, updateZoneMeshVertices } from '../../utils/zoneMeshRenderer'
import type { ZoneMeshSetup } from '../../utils/zoneMeshRenderer'

interface Props {
  project: Project
  animation: Animation
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

export default function MembersBonesV3LoopPreviewStep({ project, animation }: Props) {
  const mesh = animation.mesh
  const tri = project.projectTriangulation

  const bodyFrames = useMemo(
    () => mesh?.walkBodyFramesSmoothed ?? mesh?.walkBodyFrames ?? null,
    [mesh?.walkBodyFramesSmoothed, mesh?.walkBodyFrames],
  )
  const zoneFrames = useMemo(
    () => mesh?.walkZoneFramesSmoothed ?? mesh?.walkZoneFrames ?? null,
    [mesh?.walkZoneFramesSmoothed, mesh?.walkZoneFrames],
  )

  const [crossfade, setCrossfade] = useState(7)
  const [speed, setSpeed] = useState(1.0)
  const [playing, setPlaying] = useState(true)

  // Refs for runtime mutation without rebuild
  const crossfadeRef = useRef(crossfade)
  crossfadeRef.current = crossfade
  const speedRef = useRef(speed)
  speedRef.current = speed
  const playingRef = useRef(playing)
  playingRef.current = playing

  const containerRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const setupRef = useRef<ZoneMeshSetup | null>(null)
  const playbacksRef = useRef<{ region: 'body' | string; pb: LoopPlayback; meshIdx: number }[]>([])

  // Rebuild PIXI when crossfade changes (LoopPlayback bakes crossfadeN at construction)
  useEffect(() => {
    if (!tri || !bodyFrames || !zoneFrames || !project.originalImageBlob) return
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let imageUrl: string | null = null

    const init = async () => {
      // Load image
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

      // Texture
      const texCanvas = document.createElement('canvas')
      texCanvas.width = imgW
      texCanvas.height = imgH
      texCanvas.getContext('2d')!.drawImage(img, 0, 0)
      const texture = PIXI.Texture.from(texCanvas)

      // Container size
      const rect = container.getBoundingClientRect()
      const viewW = Math.max(rect.width, 100)
      const viewH = Math.max(rect.height, 100)

      const app = new PIXI.Application({
        width: viewW,
        height: viewH,
        backgroundColor: 0x111111,
        antialias: true,
      })
      container.appendChild(app.view as HTMLCanvasElement)
      appRef.current = app
      app.ticker.maxFPS = 30

      const scale = Math.min(viewW / imgW, viewH / imgH)
      const offsetX = (viewW - imgW * scale) / 2
      const offsetY = (viewH - imgH * scale) / 2

      const separation = buildPseudoSeparation(tri)
      const setup = buildZoneMeshes(
        separation,
        [], // unused for zone-split
        [],
        texture,
        imgW, imgH,
        scale, offsetX, offsetY,
      )
      app.stage.addChild(setup.container)
      setupRef.current = setup

      // Build LoopPlaybacks (one per region)
      const playbacks: typeof playbacksRef.current = []
      playbacks.push({ region: 'body', pb: new LoopPlayback(bodyFrames, { crossfadeFrames: crossfadeRef.current, speed: speedRef.current }), meshIdx: -1 })
      for (const zoneId of Object.keys(zoneFrames)) {
        playbacks.push({
          region: zoneId,
          pb: new LoopPlayback(zoneFrames[zoneId], { crossfadeFrames: crossfadeRef.current, speed: speedRef.current }),
          meshIdx: -1,
        })
      }
      playbacksRef.current = playbacks

      // Ticker
      const tickerFn = (delta: number) => {
        if (!playingRef.current) return
        for (const { pb } of playbacks) {
          pb.speed = speedRef.current
          pb.advance(delta)
        }
        const bodyPb = playbacks.find(p => p.region === 'body')
        if (bodyPb) {
          updateZoneMeshVertices(setup.bodyMesh, bodyPb.pb.getPositions(), scale, offsetX, offsetY)
        }
        for (const zm of setup.zoneMeshes) {
          const p = playbacks.find(pb => pb.region === zm.zoneId)
          if (p) updateZoneMeshVertices(zm, p.pb.getPositions(), scale, offsetX, offsetY)
        }
        // Hidden face meshes: body subset → driven by body positions
        for (const hf of setup.hiddenFaceMeshes) {
          if (bodyPb) updateZoneMeshVertices(hf, bodyPb.pb.getPositions(), scale, offsetX, offsetY)
        }
        for (const hfl of setup.hiddenFaceLimbMeshes) {
          const p = playbacks.find(pb => pb.region === hfl.zoneId)
          if (p) updateZoneMeshVertices(hfl, p.pb.getPositions(), scale, offsetX, offsetY)
        }
      }
      app.ticker.add(tickerFn)
    }

    init().catch(err => {
      console.error('[V3-loop-preview] init failed:', err)
    })

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
  }, [project, animation, tri, bodyFrames, zoneFrames, crossfade]) // crossfade triggers rebuild

  // ----- Prerequisites -----
  if (!tri?.step3Validated) {
    return <div className="placeholder">La Triangulation projet doit être validée jusqu&apos;aux faces cachées.</div>
  }
  if (!bodyFrames || !zoneFrames) {
    return <div className="placeholder">Calculez d&apos;abord le corps (Calc Body ARAP) et les pattes (Calc Pattes).</div>
  }

  return (
    <div className="triangulation-step">
      <div className="triangulation-toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontWeight: 'bold' }}>Preview Boucle</span>

        <button className="btn-primary" onClick={() => setPlaying(p => !p)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.85rem' }}>Crossfade :</span>
          <input
            type="range" min={0} max={20} step={1}
            value={crossfade}
            onChange={(e) => setCrossfade(parseInt(e.target.value))}
            style={{ width: 120 }}
          />
          <span style={{ fontSize: '0.85rem', minWidth: 48, textAlign: 'right' }}>{crossfade} frames</span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.85rem' }}>Vitesse :</span>
          <input
            type="range" min={0.25} max={2} step={0.05}
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            style={{ width: 100 }}
          />
          <span style={{ fontSize: '0.85rem', minWidth: 36, textAlign: 'right' }}>{speed.toFixed(2)}×</span>
        </label>

        <span className="toolbar-info">Preview admin uniquement — aucune sauvegarde</span>
      </div>

      <div className="triangulation-help">
        <span>
          Joue l&apos;animation V3 en boucle infinie. Le crossfade blend les N dernières frames
          avec les N premières pour un loop seamless. Augmente si tu vois un saut visible
          au point de rebouclage. Cette étape n&apos;a aucun impact sur le rendu en scène.
        </span>
      </div>

      <div ref={containerRef} className="keyframe-editor-canvas-container" style={{ flex: 1, background: '#111' }} />
    </div>
  )
}
