import { useRef, useEffect, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Project } from '../../types/project'
import { computeUVs } from '../../utils/textureExtractor'

interface Props {
  project: Project
  scanCanvas: HTMLCanvasElement
  onClose: () => void
}

export default function AnimationPlayer({ project, scanCanvas, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!containerRef.current || !project.mesh) return

    const mesh = project.mesh
    const allPoints = [...mesh.contourVertices, ...mesh.anchorPoints, ...mesh.internalPoints]
    const hasFlow = mesh.videoFramesMesh && mesh.videoFramesMesh.length > 0

    // Create PIXI application
    const app = new PIXI.Application({
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: 0x111111,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })
    appRef.current = app
    containerRef.current.appendChild(app.view as HTMLCanvasElement)

    // Create texture from the scan canvas
    const texture = PIXI.Texture.from(scanCanvas)

    // Compute UVs (normalized coordinates in the texture)
    const uvs = computeUVs(allPoints, scanCanvas.width, scanCanvas.height)

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

    // Animation loop
    let frameIndex = 0
    const fps = 24
    let elapsed = 0

    if (hasFlow) {
      const totalFrames = mesh.videoFramesMesh!.length

      app.ticker.add((delta) => {
        if (!playing) return

        elapsed += delta
        const frameDuration = 60 / fps // delta is in frames at 60fps

        if (elapsed >= frameDuration) {
          elapsed -= frameDuration
          frameIndex = (frameIndex + 1) % totalFrames

          const framePoints = mesh.videoFramesMesh![frameIndex]
          const verts = geometry.getBuffer('aVertexPosition')

          for (let i = 0; i < framePoints.length; i++) {
            (verts.data as Float32Array)[i * 2] = framePoints[i].x * scale + offsetX;
            (verts.data as Float32Array)[i * 2 + 1] = framePoints[i].y * scale + offsetY
          }
          verts.update()
        }
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
        <button onClick={toggleFullscreen}>
          Plein écran
        </button>
        <button onClick={onClose}>
          Fermer
        </button>
      </div>
      <div ref={containerRef} className="animation-canvas" />
    </div>
  )
}
