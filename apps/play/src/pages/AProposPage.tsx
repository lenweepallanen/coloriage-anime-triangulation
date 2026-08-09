import { useI18n } from '../i18n'
import Mascot from '@shared/components/mascot/Mascot'
import { APP_VERSION, CONTACT_EMAIL, WEBSITE_URL, PRIVACY_URL } from '../config'

/** Page « À propos » — présentation, éditeur, contact, confidentialité, version. */
export default function AProposPage() {
  const { t } = useI18n()
  const website = WEBSITE_URL.replace(/^https?:\/\//, '')
  return (
    <div className="placeholder-page">
      <div className="soft-card info-card info-card--about">
        <Mascot size={88} gaze="pointer" />
        <h1 className="info-title">{t('about.title')}</h1>
        <p className="info-intro">{t('about.intro')}</p>

        <ul className="about-list">
          <li className="about-row">{t('about.publisher')}</li>
          <li className="about-row">{t('about.version')} {APP_VERSION}</li>
          <li className="about-row">
            <a className="about-link" href={`mailto:${CONTACT_EMAIL}`}>{t('about.contact')}</a>
          </li>
          <li className="about-row">
            <a className="about-link" href={WEBSITE_URL} target="_blank" rel="noopener noreferrer">{website}</a>
          </li>
          <li className="about-row">
            <a className="about-link" href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">{t('about.privacy')}</a>
          </li>
        </ul>

        <p className="about-privacy-note">🔒 {t('about.privacyNote')}</p>
        <p className="about-made">{t('about.madeWith')}</p>
      </div>
    </div>
  )
}
