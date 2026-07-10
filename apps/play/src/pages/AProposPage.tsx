import { useI18n } from '../i18n'
import logoUrl from '../assets/picopop-logo.png'

/** Page À propos — contenu à remplir plus tard. */
export default function AProposPage() {
  const { t } = useI18n()
  return (
    <div className="placeholder-page">
      <div className="placeholder-card soft-card">
        <img className="placeholder-logo" src={logoUrl} alt="" aria-hidden="true" />
        <h1>{t('about.title')}</h1>
        <p style={{ whiteSpace: 'pre-line' }}>{t('about.text')}</p>
      </div>
    </div>
  )
}
