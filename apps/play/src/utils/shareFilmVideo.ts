import { Capacitor, registerPlugin } from '@capacitor/core'
import type { FilmVideoRecord } from '@shared/db/filmVideosStore'
import { playUi } from '@shared/utils/uiSound'

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
  const fileName = `picopop-tmp.${ext}`          // fichier temporaire (entrée concat)
  const prettyName = `PicoPop.${ext}`            // nom VISIBLE simple dans le partage

  if (Capacitor.isNativePlatform()) {
    try {
      const [{ Filesystem, Directory }, { Share }] = await Promise.all([
        import('@capacitor/filesystem'),
        import('@capacitor/share'),
      ])

      // Partagé sous un nom SIMPLE (« PicoPop.mp4 »). Pas de cache : on régénère à
      // chaque partage (concat AVFoundation ~rapide) — plus simple, et zéro risque
      // de partager une vidéo périmée / d'un autre coloriage.
      let shareUri: string | null = null

      if (ext === 'mp4') {
        try {
          const base64 = await blobToBase64(record.blob)
          const written = await Filesystem.writeFile({
            path: fileName,
            data: base64,
            directory: Directory.Cache,
          })
          const outputUri = (await Filesystem.getUri({ path: prettyName, directory: Directory.Cache })).uri
          const result = await VideoConcat.appendOutro({
            inputPath: written.uri,
            outputPath: outputUri,
            // Vignette (frame préfixée) : instant choisi dans l'éditeur FILM.
            ...(record.posterMs != null && { posterMs: record.posterMs }),
          })
          shareUri = result.uri
          void Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => {})
        } catch (err) {
          console.warn('[share] concat outro impossible, partage sans outro :', err)
          shareUri = null
        }
      }

      // Fallback (webm, ou concat échouée) : vidéo brute, nom propre aussi.
      if (!shareUri) {
        const base64 = await blobToBase64(record.blob)
        const written = await Filesystem.writeFile({
          path: prettyName,
          data: base64,
          directory: Directory.Cache,
        })
        shareUri = written.uri
      }

      try {
        playUi('shareReady') // le fichier est prêt, la feuille va s'ouvrir
        await Share.share({
          text: SHARE_TEXT,
          url: shareUri,
          dialogTitle: 'Partager ma vidéo PicoPop',
        })
      } catch {
        // Feuille annulée par l'utilisateur : pas une erreur.
      }
      void Filesystem.deleteFile({ path: prettyName, directory: Directory.Cache }).catch(() => {})
      return true
    } catch (err) {
      console.warn('[share] partage natif impossible :', err)
      return false
    }
  }

  // Web : Web Share API niveau 2 (fichiers) si dispo, sinon téléchargement.
  // Pas d'outro côté web (AVFoundation indisponible) — la cible est l'app native.
  try {
    const file = new File([record.blob], prettyName, { type: record.mimeType })
    if (navigator.canShare?.({ files: [file] })) {
      playUi('shareReady')
      await navigator.share({ files: [file], text: SHARE_TEXT }).catch(() => {})
      return true
    }
  } catch { /* continue vers le fallback */ }
  try {
    const url = URL.createObjectURL(record.blob)
    const a = document.createElement('a')
    a.href = url
    a.download = prettyName
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    return true
  } catch {
    return false
  }
}
