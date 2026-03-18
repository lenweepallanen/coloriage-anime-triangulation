import { useRef, useEffect, useState, useCallback } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Point2D, CurvilinearParam } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'
import { computeScanInsets } from '../../utils/pdfLayout'
import { LoopPlayback } from '../../utils/loopPlayback'
import { MeshPhysicsEffect, DEFAULT_PHYSICS_CONFIG } from '../../utils/meshPhysicsEffects'
import type { TouchState, PhysicsConfig } from '../../utils/meshPhysicsEffects'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  onClose: () => void
}

/**
 * Build the ordered indices into allPoints that trace the contour once,
 * interleaving anchors and subdivision points in curvilinear order.
 * Returns indices into allPoints (where anchors are 0..A-1, subdivisions are A..A+S-1).
 */
function buildOrderedContourIndices(
  numAnchors: number,
  subParams: CurvilinearParam[]
): number[] {
  const result: number[] = []
  for (let i = 0; i < numAnchors; i++) {
    // Add anchor i (index i in allPoints)
    result.push(i)
    // Collect subdivision points for segment i, sorted by t
    const segPts: { globalIndex: number; t: number }[] = []
    for (let j = 0; j < subParams.length; j++) {
      if (subParams[j].segmentIndex === i) {
        // Subdivision point j is at index (numAnchors + j) in allPoints
        segPts.push({ globalIndex: numAnchors + j, t: subParams[j].t })
      }
    }
    segPts.sort((a, b) => a.t - b.t)
    for (const sp of segPts) {
      result.push(sp.globalIndex)
    }
  }
  return result
}

/**
 * Draw a smooth closed Bézier path through ordered points using
 * Catmull-Rom → cubic Bézier conversion.
 */
function drawSmoothContour(
  graphics: PIXI.Graphics,
  framePoints: Point2D[],
  orderedIndices: number[],
  scale: number,
  offsetX: number,
  offsetY: number,
  lineWidth: number
) {
  if (orderedIndices.length < 3) return

  graphics.clear()
  graphics.lineStyle(lineWidth, 0x000000, 1)

  const n = orderedIndices.length
  const px = (idx: number) => framePoints[idx].x * scale + offsetX
  const py = (idx: number) => framePoints[idx].y * scale + offsetY

  const tension = 0.5 / 3

  graphics.moveTo(px(orderedIndices[0]), py(orderedIndices[0]))

  for (let i = 0; i < n; i++) {
    const i0 = orderedIndices[(i - 1 + n) % n]
    const i1 = orderedIndices[i]
    const i2 = orderedIndices[(i + 1) % n]
    const i3 = orderedIndices[(i + 2) % n]

    const cp1x = px(i1) + (px(i2) - px(i0)) * tension
    const cp1y = py(i1) + (py(i2) - py(i0)) * tension
    const cp2x = px(i2) - (px(i3) - px(i1)) * tension
    const cp2y = py(i2) - (py(i3) - py(i1)) * tension

    graphics.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, px(i2), py(i2))
  }
}

interface SliderDef {
  key: keyof PhysicsConfig
  label: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderDef[] = [
  { key: 'force', label: 'Force', min: 5, max: 150, step: 5 },
  { key: 'radius', label: 'Rayon', min: 30, max: 500, step: 10 },
  { key: 'concentration', label: 'Concentration', min: 0.5, max: 5, step: 0.25 },
  { key: 'returnSpeed', label: 'Retour', min: 0.5, max: 0.98, step: 0.01 },
]

export default function AnimationPlayer({ project, scanCanvas, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [physicsConfig, setPhysicsConfig] = useState<PhysicsConfig>({ ...DEFAULT_PHYSICS_CONFIG })
  const physicsRef = useRef<MeshPhysicsEffect | null>(null)
  const touchRef = useRef<{ active: boolean; screenX: number; screenY: number }>({
    active: false, screenX: 0, screenY: 0
  })

  const updateConfig = useCallback((key: keyof PhysicsConfig, value: number) => {
    setPhysicsConfig(prev => {
      const next = { ...prev, [key]: value }
      if (physicsRef.current) physicsRef.current.config = next
      return next
    })
  }, [])

  useEffect(() => {
    if (!containerRef.current || !project.mesh) return

    const mesh = project.mesh
    const allPoints = [...mesh.contourAnchors, ...mesh.contourSubdivisionPoints, ...mesh.anchorPoints, ...mesh.internalPoints]
    const hasFlow = mesh.videoFramesMesh && mesh.videoFramesMesh.length > 0

    // Build ordered contour indices (curvilinear order, single loop)
    const contourIndices = buildOrderedContourIndices(
      mesh.contourAnchors.length,
      mesh.contourSubdivisionParams || []
    )

    // Create PIXI application
    const app = new PIXI.Application({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: 0xFFFFFF,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    appRef.current = app
    containerRef.current.appendChild(app.view as HTMLCanvasElement)

    // Pointer events for physics interaction
    const canvas = app.view as HTMLCanvasElement
    canvas.style.touchAction = 'none'

    const onPointerDown = (e: PointerEvent) => {
      touchRef.current = { active: true, screenX: e.offsetX, screenY: e.offsetY }
    }
    const onPointerMove = (e: PointerEvent) => {
      if (touchRef.current.active) {
        touchRef.current.screenX = e.offsetX
        touchRef.current.screenY = e.offsetY
      }
    }
    const onPointerUp = () => {
      touchRef.current.active = false
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    // Create texture from the scan canvas
    const texture = PIXI.Texture.from(scanCanvas)

    // Compute UVs with inset correction (scan is slightly zoomed in due to L-marker centroid offset)
    const insets = computeScanInsets(scanCanvas.width, scanCanvas.height)
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height, insets)

    // Build indices from triangles
    const indices = new Uint16Array(mesh.triangles.length * 3)
    mesh.triangles.forEach((tri, i) => {
      indices[i * 3] = tri[0]
      indices[i * 3 + 1] = tri[1]
      indices[i * 3 + 2] = tri[2]
    })

    // Compute initial scale to fit the mesh in the viewport
    const viewW = app.screen.width
    const viewH = app.screen.height
    const scaleX = viewW / scanCanvas.width
    const scaleY = viewH / scanCanvas.height
    const scale = Math.min(scaleX, scaleY) * 0.9 // 90% to leave some padding
    const offsetX = (viewW - scanCanvas.width * scale) / 2
    const offsetY = (viewH - scanCanvas.height * scale) / 2

    // Build initial vertices (scaled to screen)
    const vertices = new Float32Array(allPoints.length * 2)
    allPoints.forEach((p, i) => {
      vertices[i * 2] = p.x * scale + offsetX
      vertices[i * 2 + 1] = p.y * scale + offsetY
    })

    // Create the mesh
    const geometry = new PIXI.MeshGeometry(vertices, uvs, indices)
    const material = new PIXI.MeshMaterial(texture)
    const pixiMesh = new PIXI.Mesh(geometry, material)
    app.stage.addChild(pixiMesh)

    // Physics effect (magnetization)
    const physics = new MeshPhysicsEffect(allPoints.length, physicsConfig)
    physicsRef.current = physics
    const modifiedPositions: Point2D[] = new Array(allPoints.length)
    for (let i = 0; i < allPoints.length; i++) modifiedPositions[i] = { x: 0, y: 0 }

    const screenToImage = (sx: number, sy: number): { x: number; y: number } => ({
      x: (sx - offsetX) / scale,
      y: (sy - offsetY) / scale,
    })

    // Animation loop with seamless crossfade + physics
    if (hasFlow) {
      const playback = new LoopPlayback(mesh.videoFramesMesh!, { crossfadeFrames: mesh.crossfadeFrames ?? 7 })

      app.ticker.add((delta) => {
        if (playing) playback.advance(delta)

        const positions = playback.getPositions()

        // Physics: always update (even when paused) so spring-back works
        const t = touchRef.current
        const img = screenToImage(t.screenX, t.screenY)
        const touchState: TouchState = { active: t.active, imageX: img.x, imageY: img.y }
        physics.update(positions, touchState, delta)

        if (physics.isIdle() && !playing) return

        physics.apply(positions, modifiedPositions)

        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()
      })
    } else {
      // Static mesh: only physics, no animation
      app.ticker.add((delta) => {
        const t = touchRef.current
        const img = screenToImage(t.screenX, t.screenY)
        const touchState: TouchState = { active: t.active, imageX: img.x, imageY: img.y }
        physics.update(allPoints, touchState, delta)

        if (physics.isIdle()) return

        physics.apply(allPoints, modifiedPositions)

        const verts = geometry.getBuffer('aVertexPosition')
        for (let i = 0; i < modifiedPositions.length; i++) {
          (verts.data as Float32Array)[i * 2] = modifiedPositions[i].x * scale + offsetX;
          (verts.data as Float32Array)[i * 2 + 1] = modifiedPositions[i].y * scale + offsetY
        }
        verts.update()
      })
    }

    // Handle resize
    function handleResize() {
      if (!containerRef.current) return
      app.renderer.resize(
        containerRef.current.clientWidth,
        containerRef.current.clientHeight
      )
    }
    window.addEventListener('resize', handleResize)

    return () => {
      physicsRef.current = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('resize', handleResize)
      app.destroy(true, { children: true, texture: true })
      appRef.current = null
    }
  }, [project, scanCanvas]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleFullscreen() {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      el.requestFullscreen()
    }
  }

  return (
    <div className="animation-player">
      <div className="animation-controls">
        <button onClick={() => setPlaying(p => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => setShowSettings(s => !s)}>
          {showSettings ? 'Masquer' : 'Effets'}
        </button>
        <button onClick={toggleFullscreen}>
          Plein écran
        </button>
        <button onClick={onClose}>
          Fermer
        </button>
      </div>
      {showSettings && (
        <div className="physics-settings">
          {SLIDERS.map(({ key, label, min, max, step }) => (
            <label key={key} className="physics-slider">
              <span>{label}: {physicsConfig[key]}</span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={physicsConfig[key]}
                onChange={e => updateConfig(key, parseFloat(e.target.value))}
              />
            </label>
          ))}
        </div>
      )}
      <div ref={containerRef} className="animation-canvas" />
    </div>
  )
}
