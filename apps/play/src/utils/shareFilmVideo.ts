import { Capacitor, registerPlugin } from '@capacitor/core'
import type { FilmVideoRecord } from '@shared/db/filmVideosStore'

/** Texte promo joint à la vidéo partagée (feuille de partage native). */
const SHARE_TEXT = 'Regarde mon coloriage prendre vie avec PicoPop ! ✨ https://picopop.app'

/**
 * Plugin local iOS (VideoConcatPlugin.swift) : colle l'outro promo PicoPop
 * (bundlée dans public/outro-picopop.mp4) à la fin de la vidéo via AVFoundation.
 * La copie partagée porte le branding ; la vidéo stockée dans l'app reste intacte.
 */
interface VideoConcatPlugin {
  appendOutro(options: { inputPath: string; outputPath: string; posterMs?: number }): Promise<{ uri: string }>
}
const VideoConcat = registerPlugin<VideoConcatPlugin>('VideoConcat')

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
 * ou navigator.share (web). Sur iOS, l'outro promo est collée à la fin de la
 * copie partagée (résultat mis en cache : le 1er partage prend quelques secondes,
 * les suivants sont instantanés). Les fichiers restent dans le cache de l'app —
 * rien ne passe par les Photos. Retourne false si le partage a échoué
 * (l'annulation de la feuille par l'utilisateur compte comme un succès).
 */
export async function shareFilmVideo(record: FilmVideoRecord): Promise<boolean> {
  const ext = fileExtension(record.mimeType)
  const fileName = `picopop-${record.projectId}.${ext}`

  if (Capacitor.isNativePlatform()) {
    try {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ])

      // Version partagée (film + outro), cachée par timestamp d'enregistrement :
      // un rescan remplacé change createdAt → re-concat automatique.
      const shareName = `picopop-share-${record.projectId}-${record.createdAt}.mp4`
      let shareUri: string | null = null

      if (ext === 'mp4') {
        try {
          const cached = await Filesystem.stat({ path: shareName, directory: Directory.Cache })
            .catch(() => null)
          if (cached) {
            shareUri = (await Filesystem.getUri({ path: shareName, directory: Directory.Cache })).uri
          } else {
            const base64 = await blobToBase64(record.blob)
            const written = await Filesystem.writeFile({
              path: fileName,
              data: base64,
              directory: Directory.Cache,
            })
            const outputUri = (await Filesystem.getUri({ path: shareName, directory: Directory.Cache })).uri
            const result = await VideoConcat.appendOutro({
              inputPath: written.uri,
              outputPath: outputUri,
              // Vignette (frame préfixée) : instant choisi dans l'éditeur FILM.
              ...(record.posterMs != null && { posterMs: record.posterMs }),
            })
            shareUri = result.uri
            void Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {})
          }
        } catch (err) {
          console.warn('[share] concat outro impossible, partage sans outro :', err)
          shareUri = null
        }
      }

      // Fallback (webm, ou concat échouée) : partage de la vidéo brute.
      let cleanupRaw = false
      if (!shareUri) {
        const base64 = await blobToBase64(record.blob)
        const written = await Filesystem.writeFile({
          path: fileName,
          data: base64,
          directory: Directory.Cache,
        })
        shareUri = written.uri
        cleanupRaw = true
      }

      try {
        await Share.share({
          text: SHARE_TEXT,
          url: shareUri,
          dialogTitle: 'Partager ma vidéo PicoPop',
        })
      } catch {
        // Feuille annulée par l'utilisateur : pas une erreur.
      }
      if (cleanupRaw) {
        void Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {})
      }
      return true
    } catch (err) {
      console.warn('[share] partage natif impossible :', err)
      return false
    }
  }

  // Web : Web Share API niveau 2 (fichiers) si dispo, sinon téléchargement.
  // Pas d'outro côté web (AVFoundation indisponible) — la cible est l'app native.
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
