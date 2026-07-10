import { useI18n } from '../i18n'

/** Page Tuto — contenu à remplir plus tard. */
export default function TutoPage() {
  const { t } = useI18n()
  return (
    <div className="placeholder-page">
      <div className="placeholder-card soft-card">
        <span className="placeholder-icon" aria-hidden="true">📖</span>
        <h1>{t('tuto.title')}</h1>
        <p>{t('tuto.text')}</p>
      </div>
    </div>
  )
}
