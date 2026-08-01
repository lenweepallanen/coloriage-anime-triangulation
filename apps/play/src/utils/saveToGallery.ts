import { Capacitor } from '@capacitor/core'
import type { FilmRecordingResult } from '@shared/utils/filmRecorder'

/**
 * Enregistre la vidéo du film dans la galerie Photos du téléphone (natif
 * uniquement — no-op sur le web). Non bloquant : un échec (permission refusée,
 * format non supporté) laisse la vidéo disponible dans l'app.
 *
 * Pipeline : blob → base64 → Filesystem (cache) → Media.saveVideo → cleanup.
 */
export async function saveVideoToGallery(r: FilmRecordingResult, projectId: string): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false

  const [{ Filesystem, Directory }, { Media }] = await Promise.all([
    import('@capacitor/filesystem'),
    import('@capacitor-community/media'),
  ])

  const ext = r.mimeType.includes('mp4') ? 'mp4' : 'webm'
  const fileName = `picopop-${projectId}-${Date.now()}.${ext}`

  const base64 = await blobToBase64(r.blob)
  await Filesystem.writeFile({
    path: fileName,
    data: base64,
    directory: Directory.Cache,
  })

  try {
    const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Cache })
    await Media.saveVideo({ path: uri })
    console.log('[gallery] vidéo enregistrée dans la galerie')
    return true
  } finally {
    void Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {})
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.readAsDataURL(blob)
  })
}
