import { useEffect, useRef, useState } from 'react'
import * as PIXI from 'pixi.js'
import type { Project, Prop } from '../../types/project'
import { buildPropLayer, updatePropLayer, getAnchorsByZone } from '../../utils/propRenderer'

interface Props {
  project: Project
  prop: Prop
  onSave: (next: Prop) => Promise<void>
}

export default function PropSettingsStep({ project, prop, onSave }: Props) {
  const tri = project.projectTriangulation
  const refBlob = tri?.referenceImageBlob ?? null
  const containerRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)

  useEffect(() => {
    if (!refBlob) { setImage(null); return }
    const url = URL.createObjectURL(refBlob)
    const im = new Image()
    im.onload = () => setImage(im)
    im.src = url
    return () => URL.revokeObjectURL(url)
  }, [refBlob])

  // PIXI live preview
  useEffect(() => {
    if (!containerRef.current || !image) return
    const c = containerRef.current
    const app = new PIXI.Application({
      width: c.clientWidth, height: c.clientHeight,
      backgroundColor: 0xffffff, resolution: window.devicePixelRatio || 1, autoDensity: true,
    })
    app.ticker.maxFPS = 30
    appRef.current = app
    c.appendChild(app.view as HTMLCanvasElement)

    const scale = Math.min(c.clientWidth / image.width, c.clientHeight / image.height)
    const offX = (c.clientWidth - image.width * scale) / 2
    const offY = (c.clientHeight - image.height * scale) / 2

    // Image de fond
    const tex = PIXI.Texture.from(image)
    const bg = new PIXI.Sprite(tex)
    bg.position.set(offX, offY)
    bg.scale.set(scale, scale)
    app.stage.addChild(bg)

    // Calque accessoires (sortable)
    const stage = new PIXI.Container()
    stage.sortableChildren = true
    app.stage.addChild(stage)

    const layer = buildPropLayer([prop], image, image.width, image.height, tri, scale, offX, offY)
    stage.addChild(layer.container)

    // Pas d'animation : on update une fois.
    updatePropLayer(layer, getAnchorsByZone(tri), scale, offX, offY)

    return () => {
      app.destroy(true, { children: true, texture: true, baseTexture: true })
      appRef.current = null
    }
  }, [image, prop, tri])

  function set<K extends keyof Prop>(field: K, value: Prop[K]) {
    void onSave({ ...prop, [field]: value })
  }

  if (!refBlob) {
    return <div className="prop-step">Importez une image de référence dans la Triangulation projet.</div>
  }

  return (
    <div className="prop-step prop-step--settings">
      <div className="prop-step-controls">
        <label>
          Décalage X ({prop.offset.x.toFixed(0)} px) :
          <input
            type="range" min={-200} max={200} step={1} value={prop.offset.x}
            onChange={e => set('offset', { ...prop.offset, x: Number(e.target.value) })}
          />
        </label>
        <label>
          Décalage Y ({prop.offset.y.toFixed(0)} px) :
          <input
            type="range" min={-200} max={200} step={1} value={prop.offset.y}
            onChange={e => set('offset', { ...prop.offset, y: Number(e.target.value) })}
          />
        </label>
        <label>
          Échelle ({prop.scale.toFixed(2)}) :
          <input
            type="range" min={0.2} max={3} step={0.05} value={prop.scale}
            onChange={e => set('scale', Number(e.target.value))}
          />
        </label>
        <label>
          Z-order ({prop.zOrder}) :
          <input
            type="range" min={-5} max={5} step={1} value={prop.zOrder}
            onChange={e => set('zOrder', Number(e.target.value))}
          />
          <span className="muted">
            {' '}{prop.zOrder < 0 ? '(derrière le perso)' : prop.zOrder > 0 ? '(devant le perso)' : '(au niveau du perso)'}
          </span>
        </label>
      </div>
      <div
        ref={containerRef}
        style={{ width: '100%', height: '55vh', minHeight: 400, background: '#fafafa', border: '1px solid var(--color-border)' }}
      />
    </div>
  )
}
