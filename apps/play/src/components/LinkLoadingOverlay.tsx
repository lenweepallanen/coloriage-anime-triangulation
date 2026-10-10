/**
 * Popup de chargement d'un coloriage visé par un QR (appareil photo ou scanner) : affichée UNIQUEMENT le temps de
 * pré-charger ce coloriage, puis bascule automatique vers son scan. Le reste du livre continue en arrière-plan.
 */
import Mascot from '@shared/components/mascot/Mascot'
import { useI18n } from '../i18n'
import { useLinkLoading } from '../utils/linkLoading'

export default function LinkLoadingOverlay() {
  const st = useLinkLoading()
  const { t } = useI18n()
  if (!st) return null
  const pct = st.total > 0 ? Math.round((st.done / st.total) * 100) : 0
  return (
    <div className="scanner-confirm-backdrop" role="status" aria-busy="true">
      <div className="scanner-confirm soft-card">
        <div className="share-loading-spinner" aria-hidden="true">
          <span className="share-loading-ring" />
          <Mascot size={76} gaze="ring" />
        </div>
        <p className="scanner-confirm-title">{t('link.preparing')}</p>
        <p className="scanner-confirm-q">{t('link.preparingSub')} · {pct} %</p>
      </div>
    </div>
  )
}
