import { useEffect } from 'react'
import Mascot from '@shared/components/mascot/Mascot'
import { playUi } from '@shared/utils/uiSound'
import { useI18n } from '../i18n'

/**
 * Popup de chargement pendant la préparation d'un partage (concat outro +
 * écriture fichier). Étoile PicoPop entourée d'un anneau qui tourne, sur une
 * carte soft — affichée par la galerie, l'écran replay et l'écran Fin du film.
 */
export default function SharePreparingOverlay() {
  const { t } = useI18n()
  useEffect(() => { playUi('whoosh') }, [])
  return (
    <div className="scanner-confirm-backdrop share-loading-backdrop" role="alert" aria-busy="true">
      <div className="scanner-confirm soft-card share-loading-card">
        <div className="share-loading-spinner" aria-hidden="true">
          <span className="share-loading-ring" />
          <Mascot size={76} gaze="ring" />
        </div>
        <div className="share-loading-title">{t('share.preparing.title')}</div>
        <p className="scanner-confirm-q text-preline">{t('share.preparing.text')}</p>
      </div>
    </div>
  )
}
