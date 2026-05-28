/**
 * InpaintedPreview — wrapper autour de TriangulationLoopPreview avec un bouton
 * "Inpainting" qui génère les textures face-cachée (body + extensions pattes)
 * en mémoire et les passe à la preview. Utilisé dans les étapes finales du
 * pipeline CoTracker pour visualiser le rendu final avant le scan.
 */

import { useState } from 'react'
import type { Project, Animation, UploadHint } from '../../types/project'
import TriangulationLoopPreview from './TriangulationLoopPreview'
import { inpaintHiddenFaceOnScan, flowExtrudeLimbOnScan } from '../../utils/hiddenFaceTexture'

interface Props {
  project: Project
  animation: Animation
  height?: number
  background?: string
  onSave?: (project: Project, hints?: UploadHint[]) => Promise<void>
}

export default function InpaintedPreview({ project, animation, height = 520, background = '#fff', onSave }: Props) {
  const tri = project.projectTriangulation

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [textures, setTextures] = useState<
    { bodyCanvas: HTMLCanvasElement | null; limbCanvases: Record<string, HTMLCanvasElement> } | null
  >(null)

  async function generate() {
    if (!tri || !project.originalImageBlob) return
    setBusy(true)
    setError(null)
    try {
      const url = URL.createObjectURL(project.originalImageBlob)
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.onload = () => resolve(im)
          im.onerror = () => reject(new Error('image load failed'))
          im.src = url
        })
        const imgW = img.naturalWidth
        const imgH = img.naturalHeight

        // Masque "exclusion" : pixels appartenant à une zone non-body (tête, pattes…),
        // rastérisés depuis les contours lissés des zones (Canny ou SAM2, selon segmentationMode).
        // Empêche le K-means de bord d'apprendre les couleurs des membres recouvrant
        // la face cachée body (sinon les cornes/crête contaminent la propagation).
        let excludeMask: Uint8Array | null = null
        if (tri.contours) {
          const maskCanvas = document.createElement('canvas')
          maskCanvas.width = imgW
          maskCanvas.height = imgH
          const mctx = maskCanvas.getContext('2d')!
          mctx.fillStyle = '#000'
          mctx.fillRect(0, 0, imgW, imgH)
          mctx.fillStyle = '#fff'
          for (const [zoneId, contour] of Object.entries(tri.contours)) {
            if (zoneId === 'body' || !contour || contour.length < 3) continue
            mctx.beginPath()
            mctx.moveTo(contour[0].x, contour[0].y)
            for (let i = 1; i < contour.length; i++) mctx.lineTo(contour[i].x, contour[i].y)
            mctx.closePath()
            mctx.fill()
          }
          const data = mctx.getImageData(0, 0, imgW, imgH).data
          excludeMask = new Uint8Array(imgW * imgH)
          for (let i = 0; i < imgW * imgH; i++) {
            excludeMask[i] = data[i * 4] > 128 ? 1 : 0
          }
        }

        let bodyCanvas: HTMLCanvasElement | null = null
        if (tri.hiddenFaceZones.length > 0 && tri.bodyPoints.length > 0 && tri.bodyTriangles.length > 0) {
          bodyCanvas = document.createElement('canvas')
          bodyCanvas.width = imgW
          bodyCanvas.height = imgH
          bodyCanvas.getContext('2d')!.drawImage(img, 0, 0)
          for (const hfz of tri.hiddenFaceZones) {
            inpaintHiddenFaceOnScan(
              bodyCanvas, hfz, tri.bodyPoints, tri.bodyTriangles, imgW, imgH,
              undefined, excludeMask,
            )
          }
        }

        const limbCanvases: Record<string, HTMLCanvasElement> = {}
        const allExtByLimb = new Map<string, Set<number>>()
        for (const hfl of tri.hiddenFaceLimbZones) {
          const set = allExtByLimb.get(hfl.limbZoneId) ?? new Set<number>()
          for (const ti of hfl.zoneTriangleIndices) set.add(ti)
          allExtByLimb.set(hfl.limbZoneId, set)
        }
        for (const hfl of tri.hiddenFaceLimbZones) {
          const zonePts = tri.zonePoints[hfl.limbZoneId]
          const zoneTris = tri.zoneTriangles[hfl.limbZoneId]
          if (!zonePts || !zoneTris) continue
          const c = document.createElement('canvas')
          c.width = imgW
          c.height = imgH
          c.getContext('2d')!.drawImage(img, 0, 0)
          flowExtrudeLimbOnScan(c, hfl, zonePts, zoneTris, imgW, imgH, undefined, allExtByLimb.get(hfl.limbZoneId))
          limbCanvases[hfl.id ?? hfl.limbZoneId] = c
        }

        setTextures({ bodyCanvas, limbCanvases })
      } finally {
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      console.error('[Inpainting] failed:', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button
          className="btn-secondary btn-sm"
          onClick={generate}
          disabled={busy || !project.originalImageBlob || !tri}
          title="Génère localement les textures face-cachée body (K-means + BFS) + extensions pattes."
        >
          {busy ? 'Inpainting…' : textures ? 'Inpainting ✓ — régénérer' : 'Inpainting'}
        </button>
        {textures && (
          <button className="btn-ghost btn-sm" onClick={() => setTextures(null)} title="Revenir au rendu brut">
            Désactiver
          </button>
        )}
        {error && <span style={{ color: '#f87171', fontSize: 11 }}>Erreur : {error}</span>}
        {!textures && !busy && !error && (
          <span style={{ fontSize: 11, opacity: 0.65 }}>
            Génère les textures face-cachée pour visualiser le rendu final (comme au scan).
          </span>
        )}
      </div>

      <TriangulationLoopPreview
        project={project}
        animation={animation}
        mode="textured"
        height={height}
        background={background}
        onSave={onSave}
        inpaintedTextures={textures}
      />
    </>
  )
}
