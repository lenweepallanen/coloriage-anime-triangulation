import logoUrl from '../assets/picopop-logo.png'
import { useI18n } from '../i18n'

/**
 * Écran de chargement générique de l'app : étoile PicoPop entourée d'un anneau
 * violet qui tourne + « Cela peut prendre quelques instants ». Remplace tous
 * les petits « Chargement… » discrets (livre, galerie, coloriage, replay…).
 */
export default function LoadingScreen() {
  const { t } = useI18n()
  return (
    <div className="loading-screen" role="status" aria-busy="true">
      <div className="share-loading-spinner" aria-hidden="true">
        <span className="share-loading-ring" />
        <img className="share-loading-star" src={logoUrl} alt="" />
      </div>
      <p className="loading-screen-text">{t('loading.hint')}</p>
    </div>
  )
}
