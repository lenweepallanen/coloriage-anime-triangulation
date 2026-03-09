import { jsPDF } from 'jspdf'
import type { Project } from '../types/project'

// A4 dimensions in mm
const A4_W = 210
const A4_H = 297
const MARGIN = 15      // mm margin for content
const MARKER_SIZE = 15  // mm - size of L markers when printed
const MARKER_THICK = 4  // mm - thickness of L arms

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

function drawPdfLMarker(
  doc: jsPDF,
  x: number,
  y: number,
  corner: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'
) {
  doc.setFillColor(0, 0, 0)

  switch (corner) {
    case 'topLeft':
      doc.rect(x, y, MARKER_SIZE, MARKER_THICK, 'F')
      doc.rect(x, y, MARKER_THICK, MARKER_SIZE, 'F')
      break
    case 'topRight':
      doc.rect(x - MARKER_SIZE, y, MARKER_SIZE, MARKER_THICK, 'F')
      doc.rect(x - MARKER_THICK, y, MARKER_THICK, MARKER_SIZE, 'F')
      break
    case 'bottomLeft':
      doc.rect(x, y - MARKER_THICK, MARKER_SIZE, MARKER_THICK, 'F')
      doc.rect(x, y - MARKER_SIZE, MARKER_THICK, MARKER_SIZE, 'F')
      break
    case 'bottomRight':
      doc.rect(x - MARKER_SIZE, y - MARKER_THICK, MARKER_SIZE, MARKER_THICK, 'F')
      doc.rect(x - MARKER_THICK, y - MARKER_SIZE, MARKER_THICK, MARKER_SIZE, 'F')
      break
  }
}

export async function generateTemplatePDF(project: Project): Promise<Blob> {
  if (!project.originalImageBlob) {
    throw new Error('No image in project')
  }

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Load image
  const imgDataUrl = await blobToDataUrl(project.originalImageBlob)

  // Get image dimensions to compute aspect ratio
  const imgDims = await getImageDimensions(project.originalImageBlob)
  const imgAspect = imgDims.width / imgDims.height

  // Compute image placement within margins (leaving room for markers)
  const contentW = A4_W - MARGIN * 2
  const contentH = A4_H - MARGIN * 2

  let imgW: number, imgH: number
  if (imgAspect > contentW / contentH) {
    imgW = contentW
    imgH = contentW / imgAspect
  } else {
    imgH = contentH
    imgW = contentH * imgAspect
  }

  const imgX = (A4_W - imgW) / 2
  const imgY = (A4_H - imgH) / 2

  // Add image
  const format = project.originalImageBlob.type.includes('png') ? 'PNG' : 'JPEG'
  doc.addImage(imgDataUrl, format, imgX, imgY, imgW, imgH)

  // Draw L markers at the corners of the image area
  const markerMargin = 2 // mm offset from image edge
  drawPdfLMarker(doc, imgX - markerMargin, imgY - markerMargin, 'topLeft')
  drawPdfLMarker(doc, imgX + imgW + markerMargin, imgY - markerMargin, 'topRight')
  drawPdfLMarker(doc, imgX - markerMargin, imgY + imgH + markerMargin, 'bottomLeft')
  drawPdfLMarker(doc, imgX + imgW + markerMargin, imgY + imgH + markerMargin, 'bottomRight')

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
