import { useI18n } from '../i18n'
import Mascot from '@shared/components/mascot/Mascot'

/** Page À propos — contenu à remplir plus tard. */
export default function AProposPage() {
  const { t } = useI18n()
  return (
    <div className="placeholder-page">
      <div className="placeholder-card soft-card">
        <Mascot size={96} gaze="pointer" />
        <h1>{t('about.title')}</h1>
        <p className="text-preline">{t('about.text')}</p>
      </div>
    </div>
  )
}
