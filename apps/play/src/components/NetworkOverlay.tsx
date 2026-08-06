import { useOnlineStatus } from '@shared/hooks/useOnlineStatus'
import { useDownloadProgress } from '@shared/hooks/useDownloadProgress'
import { useI18n } from '../i18n'

/**
 * Retour réseau GLOBAL de l'app PLAY, monté dans le shell (couvre tous les
 * écrans, scan compris) :
 *  - HORS LIGNE (feature 2) : bandeau rose doux « Pas de connexion » en haut.
 *  - TÉLÉCHARGEMENT (feature 1) : fine barre de progression violette en haut ;
 *    si la rafale traîne (connexion lente), une pilule rassurante 🐢 apparaît.
 *
 * Charte play : pastel, pilule/carte soft, ombres teintées, safe-area top.
 */
export default function NetworkOverlay() {
  const online = useOnlineStatus()
  const { active, ratio, slow } = useDownloadProgress()
  const { t } = useI18n()

  return (
    <>
      {!online && (
        <div className="net-banner net-banner--offline" role="status">
          <span className="net-banner-dot" aria-hidden="true" />
          <div className="net-banner-text">
            <strong>{t('net.offline')}</strong>
            <span>{t('net.offline.sub')}</span>
          </div>
        </div>
      )}

      {online && active && (
        <div className="net-progress" role="status" aria-label={t('net.downloading')}>
          <div
            className={`net-progress-bar ${ratio == null ? 'net-progress-bar--indeterminate' : ''}`}
            style={ratio != null ? { width: `${Math.round(ratio * 100)}%` } : undefined}
          />
        </div>
      )}

      {online && active && slow && (
        <div className="net-slow-pill soft-card" role="status">
          <span className="net-slow-emoji" aria-hidden="true">🐢</span>
          <div className="net-slow-text">
            <strong>{t('net.slow')}</strong>
            <span>{t('net.slow.sub')}</span>
          </div>
        </div>
      )}
    </>
  )
}
