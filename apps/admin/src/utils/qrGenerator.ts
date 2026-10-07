import QRCode from 'qrcode'
import JSZip from 'jszip'
import starUrl from '../assets/picopop-star-nb.png'
import { buildBookPlayUrl, buildPlayUrl } from '../db/publishProject'

/**
 * Génère un QR code PNG (1024px) NOIR ET BLANC avec l'étoile Picopop en contour au centre
 * (pastille ronde blanche Ø 25 %, étoile Ø 21 %) — le style des PDF et du manuscrit (07/10/2026),
 * remplace l'étoile jaune couleur.
 *
 * Correction d'erreur 'H' (~30 % de redondance) : la pastille (~25 % de la largeur)
 * ne compromet pas le décodage — vérifié par round-trip jsQR sur les QR du livre.
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
  const star = await loadImage(starUrl)

  // Pastille blanche ronde au centre, puis étoile contour par-dessus
  const size = canvas.width
  const badge = Math.round(size * 0.254)
  const starSize = Math.round(size * 0.219)
  const cx = size / 2
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cx, badge / 2, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()
  ctx.drawImage(star, cx - starSize / 2, cx - starSize / 2, starSize, starSize)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob a échoué'))), 'image/png')
  })
}

/** Télécharge le QR d'une URL sous forme de fichier PNG. */
export async function downloadQrPng(url: string, filename: string): Promise<void> {
  const blob = await generateQrPngBlob(url)
  downloadBlob(blob, filename)
}

/** Nom de fichier sûr (accents conservés, caractères spéciaux remplacés). */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
}

/**
 * Télécharge en UN zip tous les QR d'un livre : le QR du livre (ajout dans l'app) + le QR de chaque
 * coloriage du livre, numérotés dans l'ordre du livre. Noms : « QR livre - <livre>.png »,
 * « QR coloriage 01 - <nom>.png »…
 */
export async function downloadBookQrZip(
  book: { id: string; name: string },
  projects: { id: string; name: string }[],
): Promise<void> {
  const zip = new JSZip()
  const folder = zip.folder(safeFileName(`QR codes - ${book.name}`))!
  folder.file(`QR livre - ${safeFileName(book.name)}.png`, await generateQrPngBlob(buildBookPlayUrl(book.id)))
  for (const [i, p] of projects.entries()) {
    const num = String(i + 1).padStart(2, '0')
    folder.file(`QR coloriage ${num} - ${safeFileName(p.name)}.png`, await generateQrPngBlob(buildPlayUrl(p.id)))
  }
  const lines = [
    `QR codes du livre « ${book.name} » — générés par l'admin PicoPop le ${new Date().toLocaleDateString('fr-FR')}`,
    '',
    `Livre : ${buildBookPlayUrl(book.id)}`,
    ...projects.map((p, i) => `${String(i + 1).padStart(2, '0')} - ${p.name} : ${buildPlayUrl(p.id)}`),
    '',
    'Style noir et blanc (étoile en contour), 1024 px, correction d’erreur H. À imprimer sans déformation.',
  ]
  folder.file('Liste des adresses.txt', lines.join('\n'))
  const blob = await zip.generateAsync({ type: 'blob' })
  downloadBlob(blob, safeFileName(`QR codes - ${book.name}.zip`))
}

function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}
