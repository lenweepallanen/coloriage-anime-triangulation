import { useState, useCallback } from 'react'
import { animationHasFrames, isLoopAnimation, type Project, type MeshData } from '../../types/project'
import type { Point2D } from '../../types/project'
import { processCapturedImage } from '../../utils/perspectiveCorrection'
import { createScan } from '../../db/scansStore'
import type { ContentAlignment } from '../../utils/textureExtractor'
import { A4_W, A4_H, MARGIN, MARKER_SIZE, MARKER_THICK, MARKER_MARGIN } from '../../utils/pdfLayout'

// Constantes du contrat scan/PDF (voir pdfGenerator + opencv-worker)
const SCAN_TOTAL = 2048
const SCAN_MARKER_FRAME = 1920        // L-centroïdes mappés à (64,64)↔(1984,1984)
const SCAN_MARKER_OFFSET = (SCAN_TOTAL - SCAN_MARKER_FRAME) / 2  // = 64

// Centroïde géométrique d'un L composé de 2 rectangles SIZE×THICK (overlap THICK×THICK)
// → offset depuis l'angle externe du L, sur un axe. L est symétrique selon y=x
// donc Cx = Cy. Décomposition : (bras horizontal moins overlap) + (bras vertical
// complet). Pour Cx :
//   armOnly = rect [(THICK..SIZE) × (0..THICK)], area = (SIZE-THICK)*THICK, x-centroid = (THICK+SIZE)/2
//   fullArm = rect [(0..THICK) × (0..SIZE)],     area = THICK*SIZE,         x-centroid = THICK/2
// Avec SIZE=15, THICK=4 : Cx = (44 × 9.5 + 60 × 2) / 104 ≈ 5.173 mm.
function computeLCentroidOffsetMm(): number {
  const armOnly = (MARKER_SIZE - MARKER_THICK) * MARKER_THICK
  const fullArm = MARKER_THICK * MARKER_SIZE
  const total = armOnly + fullArm
  return (
    armOnly * (MARKER_THICK + MARKER_SIZE) / 2 +
    fullArm * MARKER_THICK / 2
  ) / total
}

/**
 * Calcule analytiquement la zone du dessin dans le scan 2048×2048, à partir
 * du layout PDF connu :
 *   - L-markers détectés par leur centroïde, mappés à (64,64)↔(1984,1984)
 *   - Centroïde du L = ~5.17 mm de l'angle externe (cf. pdfGenerator)
 *   - L-marker outer corner = (imgX - MARKER_MARGIN, imgY - MARKER_MARGIN)
 *   → Le centroïde tombe à `L_INSET = (5.17 - MARKER_MARGIN) mm` à l'intérieur
 *     du coin de l'image. Donc l'image s'étend au-delà du marker frame de
 *     `L_INSET` mm sur chaque côté.
 *
 * Renvoie un `ContentAlignment` qui mappe l'image entière (en coords pixels
 * naturels) à la zone du dessin sur le scan. Déterministe, pas de détection.
 */
function computePdfContentAlignment(imageWidth: number, imageHeight: number): ContentAlignment {
  const aspect = imageWidth / imageHeight
  const contentW = A4_W - MARGIN * 2
  const contentH = A4_H - MARGIN * 2
  let imgW_mm: number, imgH_mm: number
  if (aspect > contentW / contentH) {
    imgW_mm = contentW
    imgH_mm = contentW / aspect
  } else {
    imgH_mm = contentH
    imgW_mm = contentH * aspect
  }

  const L_INSET_MM = computeLCentroidOffsetMm() - MARKER_MARGIN  // ≈ 3.17 mm
  // Le L-centroïde frame (1920 px) couvre `(imgW_mm - 2·L_INSET)` mm de l'image.
  // L'image entière en pixels scan : 1920 × imgW_mm / (imgW_mm - 2·L_INSET)
  const drawW = SCAN_MARKER_FRAME * imgW_mm / (imgW_mm - 2 * L_INSET_MM)
  const drawH = SCAN_MARKER_FRAME * imgH_mm / (imgH_mm - 2 * L_INSET_MM)
  const cx = SCAN_MARKER_OFFSET + SCAN_MARKER_FRAME / 2
  const cy = SCAN_MARKER_OFFSET + SCAN_MARKER_FRAME / 2
  return {
    drawBBox: {
      minX: cx - drawW / 2,
      minY: cy - drawH / 2,
      maxX: cx + drawW / 2,
      maxY: cy + drawH / 2,
    },
    meshBBox: { minX: 0, minY: 0, maxX: imageWidth, maxY: imageHeight },
  }
}

function getImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }
    img.src = url
  })
}

/**
 * Mesh utilisé pour aligner le scan : on prend la 1ère animation 'loop' avec
 * frames calculées, fallback la 1ère animation prête, fallback n'importe quel mesh.
 */
function getRestMesh(project: Project): MeshData | null {
  const ready = project.animations.filter(animationHasFrames)
  const primary = ready.find(isLoopAnimation) ?? ready[0]
  if (primary?.mesh) return primary.mesh
  // Fallback ultime : un mesh quelconque (l'animation peut ne pas avoir de frames mais avoir un mesh).
  return project.animations.find(a => a.mesh != null)?.mesh ?? null
}

// Hook version for cleaner integration
export interface DebugImages {
  capturedUrl: string       // Photo brute prise par la caméra
  raw2048Url: string        // Image 2048x2048 après correction perspective (avec marges)
  rectifiedUrl: string      // Image croppée aux dimensions originales
  meshOverlayUrl: string    // Image croppée + overlay triangulation frame 0
}

export function useScanProcessor(project: Project, opts?: { mode?: 'admin' | 'play' }) {
  const isPlay = opts?.mode === 'play'
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rectifiedCanvas, setRectifiedCanvas] = useState<HTMLCanvasElement | null>(null)
  const [debugImages, setDebugImages] = useState<DebugImages | null>(null)
  const [contentAlignment, setContentAlignment] = useState<ContentAlignment | null>(null)

  const handleCapture = useCallback(
    async (blob: Blob, corners: Point2D[] | null) => {
      // VIE PRIVÉE (play) : on n'accepte QUE des scans avec les 4 repères
      // détectés. Sans repères, le pipeline basculait en recadrage centré →
      // n'importe quelle photo (mur, visage) devenait un scan. En play on refuse
      // (message d'aide) ; l'admin garde le fallback recadrage. L'import d'image
      // en play passe désormais par une détection de repères (CameraView) et
      // fournit donc de vrais coins → il satisfait ce contrôle.
      if (isPlay && (!corners || corners.length !== 4)) {
        setError("On ne reconnaît pas de coloriage. Vise bien les 4 repères aux coins de la page.")
        return
      }

      setProcessing(true)
      setError(null)

      try {
        // 1. Photo brute capturée
        const capturedUrl = URL.createObjectURL(blob)

        // Process via worker: detection + perspective correction -> 2048x2048
        const result = await processCapturedImage(blob, corners)

        // 2. Image 2048x2048 brute (avec marges)
        const raw2048Canvas = document.createElement('canvas')
        raw2048Canvas.width = result.imageData.width
        raw2048Canvas.height = result.imageData.height
        raw2048Canvas.getContext('2d')!.putImageData(result.imageData, 0, 0)
        // MÉMOIRE : les data-URLs de debug (2048², ~plusieurs Mo chacune en base64)
        // ne servent QU'au stage debug ADMIN — jamais affichées en play. Les
        // générer en play retenait ~3 gros blobs + un canvas d'overlay pile au
        // moment le plus lourd (scan→animation) → risque de kill de la WebView
        // par iOS. En play on ne garde que capturedUrl (affichée pendant le calcul).
        const raw2048Url = isPlay ? '' : raw2048Canvas.toDataURL()

        // Garde le scan en 2048×2048 fixe (contrat invariant : pas de rescale vers
        // les dimensions de l'image originale). L'alignement mesh↔scan est résolu
        // exclusivement par `contentAlignment` (bbox dessin détectée sur le scan
        // mappée vers bbox mesh), donc le facteur d'échelle parasite disparaît.
        // Les marges 64px restent dans l'image — `contentAlignment` les ignore
        // naturellement puisque la bbox du dessin tombe dans la zone 1920×1920.
        const canvas = document.createElement('canvas')
        canvas.width = result.imageData.width   // 2048
        canvas.height = result.imageData.height // 2048
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(raw2048Canvas, 0, 0)

        // Enhance contrast: push dark lines to true black, light areas to white
        enhanceContrast(ctx, canvas.width, canvas.height)

        // Alignement déterministe basé sur le layout PDF connu (pas de détection).
        // Mappe l'image entière (coords pixels naturels) à la zone du dessin
        // calculée géométriquement à partir des centroïdes L et MARKER_MARGIN.
        let alignment: ContentAlignment | null = null
        if (project.originalImageBlob) {
          const imgDims = await getImageDimensions(project.originalImageBlob)
          alignment = computePdfContentAlignment(imgDims.width, imgDims.height)
        }
        setContentAlignment(alignment)

        // 3. Image redressée croppée + 4. overlay maillage — debug ADMIN uniquement.
        const rectifiedUrl = isPlay ? '' : canvas.toDataURL()
        const meshOverlayUrl = isPlay ? '' : buildMeshOverlay(canvas, project, alignment)

        setDebugImages({ capturedUrl, raw2048Url, rectifiedUrl, meshOverlayUrl })

        // VIE PRIVÉE (play) : le scan NE quitte JAMAIS l'appareil. On ne
        // sérialise ni n'uploade le blob en play — la texture d'animation est le
        // canvas local. `createScan` (upload Storage + doc Firestore) reste
        // réservé à l'admin (debug/qualité). Bonus : évite un gros PNG en
        // mémoire au moment le plus lourd (scan→animation) sur iOS.
        if (!isPlay) {
          const scanBlob = await new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              b => b ? resolve(b) : reject(new Error('Failed to convert canvas to blob')),
              'image/png'
            )
          })
          await createScan(project.id, scanBlob)
        }

        setRectifiedCanvas(canvas)
      } catch (err) {
        console.error('Scan processing failed:', err)
        setError(err instanceof Error ? err.message : 'Erreur de traitement')
      }

      setProcessing(false)
    },
    [project]
  )

  const reset = useCallback(() => {
    setRectifiedCanvas(null)
    setDebugImages(null)
    setContentAlignment(null)
    setError(null)
  }, [])

  return { handleCapture, processing, error, rectifiedCanvas, debugImages, contentAlignment, reset }
}

/**
 * Levels adjustment: remap pixel values so that dark contour lines become
 * true black and the paper background becomes true white.
 * blackPoint / whitePoint are auto-detected from the image histogram.
 */
function enhanceContrast(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const imageData = ctx.getImageData(0, 0, w, h)
  const data = imageData.data

  // Build luminance histogram
  const hist = new Uint32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    hist[lum]++
  }

  // Auto-detect black/white points at 0.5% and 99.5% percentiles
  const totalPixels = w * h
  const lowThreshold = totalPixels * 0.005
  const highThreshold = totalPixels * 0.995

  let blackPoint = 0
  let whitePoint = 255
  let cumulative = 0
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i]
    if (cumulative >= lowThreshold) { blackPoint = i; break }
  }
  cumulative = 0
  for (let i = 0; i < 256; i++) {
    cumulative += hist[i]
    if (cumulative >= highThreshold) { whitePoint = i; break }
  }

  // Ensure a minimum range
  if (whitePoint - blackPoint < 30) {
    blackPoint = Math.max(0, blackPoint - 15)
    whitePoint = Math.min(255, whitePoint + 15)
  }

  // Build lookup table
  const lut = new Uint8Array(256)
  const range = whitePoint - blackPoint
  for (let i = 0; i < 256; i++) {
    lut[i] = Math.max(0, Math.min(255, Math.round(((i - blackPoint) / range) * 255)))
  }

  // Apply LUT to each channel
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]]
    data[i + 1] = lut[data[i + 1]]
    data[i + 2] = lut[data[i + 2]]
  }

  ctx.putImageData(imageData, 0, 0)
}

function buildMeshOverlay(rectifiedCanvas: HTMLCanvasElement, project: Project, alignment: ContentAlignment | null): string {
  const mesh = getRestMesh(project)
  const tri = project.projectTriangulation
  const legacyPoints = mesh
    ? [...mesh.contourAnchors, ...mesh.contourSubdivisionPoints, ...mesh.anchorPoints, ...mesh.internalPoints]
    : []
  // Pipeline autonome : on dessine body + zones depuis projectTriangulation (overlay debug uniquement).
  const useTriOverlay = legacyPoints.length === 0 && tri != null
  if (legacyPoints.length === 0 && !useTriOverlay) return rectifiedCanvas.toDataURL()

  const overlay = document.createElement('canvas')
  overlay.width = rectifiedCanvas.width
  overlay.height = rectifiedCanvas.height
  const ctx = overlay.getContext('2d')!

  // Draw the rectified image as background
  ctx.drawImage(rectifiedCanvas, 0, 0)

  // Get frame 0 points (or static points if no animation)
  const framePoints = mesh?.videoFramesMesh && mesh.videoFramesMesh.length > 0
    ? mesh.videoFramesMesh[0]
    : legacyPoints

  // Transform mesh coordinates to scan coordinates using alignment
  const toScanX = (x: number) => {
    if (!alignment) return x
    const { drawBBox, meshBBox } = alignment
    const meshW = meshBBox.maxX - meshBBox.minX
    const drawW = drawBBox.maxX - drawBBox.minX
    return meshW > 0 ? (x - meshBBox.minX) / meshW * drawW + drawBBox.minX : x
  }
  const toScanY = (y: number) => {
    if (!alignment) return y
    const { drawBBox, meshBBox } = alignment
    const meshH = meshBBox.maxY - meshBBox.minY
    const drawH = drawBBox.maxY - drawBBox.minY
    return meshH > 0 ? (y - meshBBox.minY) / meshH * drawH + drawBBox.minY : y
  }

  ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)'
  ctx.lineWidth = 1
  if (useTriOverlay) {
    // Body
    const bodyPts = tri!.bodyPoints ?? []
    for (const t of (tri!.bodyTriangles ?? [])) {
      const a = bodyPts[t[0]], b = bodyPts[t[1]], c = bodyPts[t[2]]
      if (!a || !b || !c) continue
      ctx.beginPath()
      ctx.moveTo(toScanX(a.x), toScanY(a.y))
      ctx.lineTo(toScanX(b.x), toScanY(b.y))
      ctx.lineTo(toScanX(c.x), toScanY(c.y))
      ctx.closePath()
      ctx.stroke()
    }
    // Zones
    for (const zoneId of Object.keys(tri!.zonePoints ?? {})) {
      const zp = tri!.zonePoints[zoneId]
      const zt = tri!.zoneTriangles?.[zoneId] ?? []
      for (const t of zt) {
        const a = zp[t[0]], b = zp[t[1]], c = zp[t[2]]
        if (!a || !b || !c) continue
        ctx.beginPath()
        ctx.moveTo(toScanX(a.x), toScanY(a.y))
        ctx.lineTo(toScanX(b.x), toScanY(b.y))
        ctx.lineTo(toScanX(c.x), toScanY(c.y))
        ctx.closePath()
        ctx.stroke()
      }
    }
  } else if (mesh) {
    // Pipeline legacy : mesh.triangles + ses points trackés/internes
    for (const t of mesh.triangles) {
      const a = framePoints[t[0]]
      const b = framePoints[t[1]]
      const c = framePoints[t[2]]
      ctx.beginPath()
      ctx.moveTo(toScanX(a.x), toScanY(a.y))
      ctx.lineTo(toScanX(b.x), toScanY(b.y))
      ctx.lineTo(toScanX(c.x), toScanY(c.y))
      ctx.closePath()
      ctx.stroke()
    }
    for (let i = 0; i < framePoints.length; i++) {
      const p = framePoints[i]
      const isAnchor = i < mesh.anchorPoints.length
      ctx.fillStyle = isAnchor ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 100, 255, 0.8)'
      ctx.beginPath()
      ctx.arc(toScanX(p.x), toScanY(p.y), isAnchor ? 4 : 2.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Draw alignment bboxes for debug
  if (alignment) {
    const { drawBBox, meshBBox } = alignment
    // Drawing bbox (cyan)
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.strokeRect(drawBBox.minX, drawBBox.minY, drawBBox.maxX - drawBBox.minX, drawBBox.maxY - drawBBox.minY)
    // Mesh bbox mapped to scan (yellow)
    ctx.strokeStyle = 'rgba(255, 255, 0, 0.8)'
    ctx.strokeRect(
      toScanX(meshBBox.minX), toScanY(meshBBox.minY),
      toScanX(meshBBox.maxX) - toScanX(meshBBox.minX),
      toScanY(meshBBox.maxY) - toScanY(meshBBox.minY)
    )
    ctx.setLineDash([])
  }

  return overlay.toDataURL()
}

