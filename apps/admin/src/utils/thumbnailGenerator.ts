/**
 * Génère une vignette légère (image réduite) à partir d'un blob image.
 *
 * Objectif perf : le menu livre côté play affiche une grille de coloriages. Sans
 * vignette dédiée, chaque case télécharge l'image originale pleine taille
 * (200–500 Ko). Une vignette ≤ 320 px pèse quelques Ko → menu beaucoup plus léger.
 *
 * Sortie WebP (qualité 0.82) avec repli JPEG si le navigateur ne sait pas encoder
 * le WebP via canvas.toBlob.
 */
export async function generateThumbnailBlob(source: Blob, maxSize = 320): Promise<Blob> {
  const bitmap = await createImageBitmap(source)
  try {
    const longest = Math.max(bitmap.width, bitmap.height) || 1
    const scale = Math.min(1, maxSize / longest)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context indisponible')
    ctx.drawImage(bitmap, 0, 0, w, h)

    const webp = await canvasToBlob(canvas, 'image/webp', 0.82)
    if (webp) return webp
    const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.82)
    if (jpeg) return jpeg
    throw new Error('canvas.toBlob a échoué (webp + jpeg)')
  } finally {
    bitmap.close?.()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality))
}
