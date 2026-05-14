import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'
import earcut from 'earcut'
import type { MouthDefinition, Point2D } from '../../types/project'
import { flattenClosedBezier } from '../../utils/bezierUtils'
import { interpolateInternalPoint } from '../../utils/barycentricUtils'

interface Props {
  imageBlob: Blob
  /** Triangulation projet body mesh (coords image). */
  bodyMesh: { bodyPoints: Point2D[]; bodyTriangles: [number, number, number][] }
  /** Définition bouche (Bézier + ancrages barycentriques + paramètres bone). */
  mouth: MouthDefinition
  /** Ouverture courante [0,1]. */
  openness: number
}

const SAMPLES_PER_SEGMENT = 24

function rotatePoint(p: Point2D, pivot: Point2D, angleRad: number): Point2D {
  const c = Math.cos(angleRad), s = Math.sin(angleRad)
  const dx = p.x - pivot.x, dy = p.y - pivot.y
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c }
}

export default function MouthPixiPreview({ imageBlob, bodyMesh, mouth, openness }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const mouthMeshRef = useRef<PIXI.Mesh | null>(null)
  const restMouthPointsRef = useRef<Point2D[]>([])
  const hingeRef = useRef<Point2D>({ x: 0, y: 0 })
  const transformRef = useRef<{ scale: number; offsetX: number; offsetY: number }>({ scale: 1, offsetX: 0, offsetY: 0 })
  const opennessRef = useRef(openness)
  const angleConfigRef = useRef({ maxAngleDeg: mouth.maxOpenAngleDeg, sign: mouth.rotationSign })

  // Update refs each render (no re-init)
  opennessRef.current = openness
  angleConfigRef.current = { maxAngleDeg: mouth.maxOpenAngleDeg, sign: mouth.rotationSign }

  useEffect(() => {
    if (!containerRef.current) return
    let destroyed = false
    let app: PIXI.Application | null = null
    let imageUrl: string | null = null

    const img = new Image()
    imageUrl = URL.createObjectURL(imageBlob)
    img.src = imageUrl

    img.onload = () => {
      if (destroyed || !containerRef.current) return
      const container = containerRef.current

      app = new PIXI.Application({
        width: container.clientWidth,
        height: container.clientHeight,
        backgroundColor: 0xFFFFFF,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      })
      appRef.current = app
      app.ticker.maxFPS = 30
      container.appendChild(app.view as HTMLCanvasElement)

      const imgW = img.naturalWidth
      const imgH = img.naturalHeight

      // Texture partagée
      const texCanvas = document.createElement('canvas')
      texCanvas.width = imgW
      texCanvas.height = imgH
      texCanvas.getContext('2d')!.drawImage(img, 0, 0)
      const texture = PIXI.Texture.from(texCanvas)

      // Fit-contain
      const viewW = app.screen.width
      const viewH = app.screen.height
      const scale = Math.min(viewW / imgW, viewH / imgH)
      const offsetX = (viewW - imgW * scale) / 2
      const offsetY = (viewH - imgH * scale) / 2
      transformRef.current = { scale, offsetX, offsetY }

      // ─── Body mesh (statique) ───────────────────────────────────────
      const bodyVerts = new Float32Array(bodyMesh.bodyPoints.length * 2)
      const bodyUVs = new Float32Array(bodyMesh.bodyPoints.length * 2)
      bodyMesh.bodyPoints.forEach((p, i) => {
        bodyVerts[i * 2] = p.x * scale + offsetX
        bodyVerts[i * 2 + 1] = p.y * scale + offsetY
        bodyUVs[i * 2] = p.x / imgW
        bodyUVs[i * 2 + 1] = p.y / imgH
      })
      const bodyIndices = new Uint32Array(bodyMesh.bodyTriangles.length * 3)
      bodyMesh.bodyTriangles.forEach((t, i) => {
        bodyIndices[i * 3] = t[0]
        bodyIndices[i * 3 + 1] = t[1]
        bodyIndices[i * 3 + 2] = t[2]
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bodyGeom = new PIXI.MeshGeometry(bodyVerts as any, bodyUVs as any, bodyIndices as any)
      const bodyMaterial = new PIXI.MeshMaterial(texture)
      const bodyPixiMesh = new PIXI.Mesh(bodyGeom, bodyMaterial)
      app.stage.addChild(bodyPixiMesh)

      // ─── Mouth mesh (animé) ─────────────────────────────────────────
      // 1. Résoudre les nœuds Bézier en coords image (barycentriques → positions absolues)
      const refs = mouth.contourBodyAnchors ?? mouth.contourAnchors
      const resolvedAnchors: Point2D[] = refs.map(r =>
        interpolateInternalPoint(r, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)
      )
      // 2. Reconstruire des BezierNodes avec ancres résolues + handles relatifs aux anchors
      //    On préserve les offsets handleIn/handleOut tels qu'éditeur.
      const nodesResolved = mouth.bezierNodes.map((n, i) => {
        const a = resolvedAnchors[i]
        const dx = a.x - n.anchor.x
        const dy = a.y - n.anchor.y
        return {
          anchor: a,
          handleIn: { x: n.handleIn.x + dx, y: n.handleIn.y + dy },
          handleOut: { x: n.handleOut.x + dx, y: n.handleOut.y + dy },
          smooth: n.smooth,
        }
      })
      const flattened = flattenClosedBezier(nodesResolved, SAMPLES_PER_SEGMENT)
      restMouthPointsRef.current = flattened.map(p => ({ ...p }))

      // 3. Charnière (résolue barycentriquement)
      const hingeRef2 = mouth.hingeBodyAnchor ?? mouth.hingeAnchor
      hingeRef.current = interpolateInternalPoint(hingeRef2, bodyMesh.bodyPoints, bodyMesh.bodyTriangles)

      // 4. Triangulation interne par earcut (gère polygones non convexes)
      const flat: number[] = []
      flattened.forEach(p => { flat.push(p.x, p.y) })
      const earTris = earcut(flat) // indices dans `flattened`
      const mouthIndices = new Uint32Array(earTris)

      const mouthVerts = new Float32Array(flattened.length * 2)
      const mouthUVs = new Float32Array(flattened.length * 2)
      flattened.forEach((p, i) => {
        mouthVerts[i * 2] = p.x * scale + offsetX
        mouthVerts[i * 2 + 1] = p.y * scale + offsetY
        mouthUVs[i * 2] = p.x / imgW
        mouthUVs[i * 2 + 1] = p.y / imgH
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mouthGeom = new PIXI.MeshGeometry(mouthVerts as any, mouthUVs as any, mouthIndices as any)
      const mouthMaterial = new PIXI.MeshMaterial(texture)
      const mouthPixiMesh = new PIXI.Mesh(mouthGeom, mouthMaterial)
      app.stage.addChild(mouthPixiMesh)
      mouthMeshRef.current = mouthPixiMesh

      // ─── Boucle d'animation : rotation de la bouche ────────────────
      app.ticker.add(() => {
        const mesh = mouthMeshRef.current
        if (!mesh) return
        const o = opennessRef.current
        const { maxAngleDeg, sign } = angleConfigRef.current
        const angle = (o * maxAngleDeg * sign * Math.PI) / 180
        const hinge = hingeRef.current
        const rest = restMouthPointsRef.current
        const verts = mesh.geometry.getBuffer('aVertexPosition')
        const arr = verts.data as unknown as Float32Array
        const { scale: s, offsetX: ox, offsetY: oy } = transformRef.current
        if (Math.abs(angle) < 1e-4) {
          for (let i = 0; i < rest.length; i++) {
            arr[i * 2] = rest[i].x * s + ox
            arr[i * 2 + 1] = rest[i].y * s + oy
          }
        } else {
          for (let i = 0; i < rest.length; i++) {
            const rp = rotatePoint(rest[i], hinge, angle)
            arr[i * 2] = rp.x * s + ox
            arr[i * 2 + 1] = rp.y * s + oy
          }
        }
        verts.update()
      })

      // Resize
      const ro = new ResizeObserver(() => {
        if (!app || !containerRef.current) return
        app.renderer.resize(containerRef.current.clientWidth, containerRef.current.clientHeight)
        const vw = app.screen.width
        const vh = app.screen.height
        const sc = Math.min(vw / imgW, vh / imgH)
        const ox = (vw - imgW * sc) / 2
        const oy = (vh - imgH * sc) / 2
        transformRef.current = { scale: sc, offsetX: ox, offsetY: oy }
        // Update body verts
        const bv = bodyGeom.getBuffer('aVertexPosition')
        const ba = bv.data as unknown as Float32Array
        bodyMesh.bodyPoints.forEach((p, i) => {
          ba[i * 2] = p.x * sc + ox
          ba[i * 2 + 1] = p.y * sc + oy
        })
        bv.update()
      })
      ro.observe(container)
    }

    return () => {
      destroyed = true
      if (appRef.current) {
        appRef.current.destroy(true, { children: true, texture: true })
        appRef.current = null
      }
      mouthMeshRef.current = null
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
    // Re-init si mouth definition change (nodes ou hinge — invalide les positions de repos)
  }, [imageBlob, bodyMesh, mouth])

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: 360,
        background: '#fff',
        border: '1px solid var(--color-border,#ccc)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    />
  )
}
