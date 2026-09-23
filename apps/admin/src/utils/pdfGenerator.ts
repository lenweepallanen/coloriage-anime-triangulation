import { jsPDF } from 'jspdf'
import type { ProjectStepView } from '../types/project'
import { FINDER_MM, FINDER_QUIET_MM, FINDER_KNOCKOUT_MM, computeImagePlacementMm, finderOriginsMm } from './pdfLayout'

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * Viseur (motif QR) : carré noir 7×7 modules, anneau blanc 1 module, carré noir 3×3.
 * (x, y) = coin haut-gauche du carré extérieur, en mm.
 */
function drawPdfFinder(doc: jsPDF, x: number, y: number) {
  const m = FINDER_MM / 7
  doc.setFillColor(0, 0, 0)
  doc.rect(x, y, FINDER_MM, FINDER_MM, 'F')
  doc.setFillColor(255, 255, 255)
  doc.rect(x + m, y + m, 5 * m, 5 * m, 'F')
  doc.setFillColor(0, 0, 0)
  doc.rect(x + 2 * m, y + 2 * m, 3 * m, 3 * m, 'F')
}

export async function generateTemplatePDF(project: ProjectStepView): Promise<Blob> {
  if (!project.originalImageBlob) {
    throw new Error('No image in project')
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Load image
  const imgDataUrl = await blobToDataUrl(project.originalImageBlob)

  // Get image dimensions to compute aspect ratio
  const imgDims = await getImageDimensions(project.originalImageBlob)

  // Placement de l'image sur la page (contrat partagé avec le scan)
  const { x: imgX, y: imgY, w: imgW, h: imgH } = computeImagePlacementMm(imgDims.width, imgDims.height)

  const format = project.originalImageBlob.type.includes('png') ? 'PNG' : 'JPEG'
  doc.addImage(imgDataUrl, format, imgX, imgY, imgW, imgH)

  // Viseurs DANS les 4 coins de l'image : carré blanc (efface le dessin) + viseur.
  for (const o of finderOriginsMm(imgW, imgH)) {
    const kx = imgX + o.x - FINDER_QUIET_MM
    const ky = imgY + o.y - FINDER_QUIET_MM
    doc.setFillColor(255, 255, 255)
    doc.rect(kx, ky, FINDER_KNOCKOUT_MM, FINDER_KNOCKOUT_MM, 'F')
    drawPdfFinder(doc, imgX + o.x, imgY + o.y)
  }

  return doc.output('blob')
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
