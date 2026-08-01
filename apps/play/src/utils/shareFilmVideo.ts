import { Capacitor } from '@capacitor/core'
import type { FilmVideoRecord } from '@shared/db/filmVideosStore'

/** Texte promo joint à la vidéo partagée (feuille de partage native). */
const SHARE_TEXT = 'Regarde mon coloriage prendre vie avec PicoPop ! ✨ https://picopop.app'

function fileExtension(mimeType: string): string {
  return mimeType.includes('mp4') ? 'mp4' : 'webm'
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/**
 * Partage la vidéo d'un coloriage via la feuille de partage native (iOS/Android)
 * ou navigator.share (web). Le fichier temporaire est écrit dans le cache de
 * l'app (pas dans les Photos) et nettoyé après le partage.
 * Retourne false si le partage n'est pas disponible ou a échoué (l'annulation
 * par l'utilisateur compte comme un succès silencieux).
 */
export async function shareFilmVideo(record: FilmVideoRecord): Promise<boolean> {
  const fileName = `picopop-${record.projectId}.${fileExtension(record.mimeType)}`

  if (Capacitor.isNativePlatform()) {
    try {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ])
      const base64 = await blobToBase64(record.blob)
      const written = await Filesystem.writeFile({
        path: fileName,
        data: base64,
        directory: Directory.Cache,
      })
      try {
        await Share.share({
          text: SHARE_TEXT,
          url: written.uri,
          dialogTitle: 'Partager ma vidéo PicoPop',
        })
      } catch {
        // Feuille annulée par l'utilisateur : pas une erreur.
      }
      void Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {})
      return true
    } catch (err) {
      console.warn('[share] partage natif impossible :', err)
      return false
    }
  }

  // Web : Web Share API niveau 2 (fichiers) si dispo, sinon téléchargement.
  try {
    const file = new File([record.blob], fileName, { type: record.mimeType })
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: SHARE_TEXT }).catch(() => {})
      return true
    }
  } catch { /* continue vers le fallback */ }
  try {
    const url = URL.createObjectURL(record.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    return true
  } catch {
    return false
  }
}
