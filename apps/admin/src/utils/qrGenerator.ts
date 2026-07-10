import QRCode from 'qrcode'
import logoUrl from '../assets/picopop-logo.png'

/**
 * Génère un QR code PNG (1024px) avec l'étoile Picopop incrustée au centre,
 * destiné à l'impression dans les livres papier.
 *
 * Correction d'erreur 'H' (~30 % de redondance) : le logo (~20 % de la
 * largeur) ne compromet pas le décodage — vérifié par round-trip jsQR.
 */
export async function generateQrPngBlob(url: string): Promise<Blob> {
  const canvas = document.createElement('canvas')
  await QRCode.toCanvas(canvas, url, {
    errorCorrectionLevel: 'H',
    width: 1024,
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' },
  })

  const ctx = canvas.getContext('2d')!
  const logo = await loadImage(logoUrl)

  // Pastille blanche arrondie au centre, puis logo par-dessus
  const size = canvas.width
  const badge = Math.round(size * 0.24)
  const logoSize = Math.round(size * 0.2)
  const cx = size / 2
  ctx.save()
  ctx.beginPath()
  roundedRect(ctx, cx - badge / 2, cx - badge / 2, badge, badge, badge * 0.22)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()
  ctx.drawImage(logo, cx - logoSize / 2, cx - logoSize / 2, logoSize, logoSize)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob a échoué'))), 'image/png')
  })
}

/** Télécharge le QR d'une URL sous forme de fichier PNG. */
export async function downloadQrPng(url: string, filename: string): Promise<void> {
  const blob = await generateQrPngBlob(url)
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.click()
  URL.revokeObjectURL(objectUrl)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
