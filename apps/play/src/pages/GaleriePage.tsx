import { useI18n } from '../i18n'

/** Onglet Galerie — accueillera plus tard les vidéos sauvegardées après scan. */
export default function GaleriePage() {
  const { t } = useI18n()
  return (
    <div className="placeholder-page">
      <div className="placeholder-card soft-card">
        <span className="placeholder-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="56" height="56" fill="currentColor" stroke="none">
            <path d="M12 3.2 14.5 8.6 20.4 9.3 16 13.3 17.2 19.1 12 16.2 6.8 19.1 8 13.3 3.6 9.3 9.5 8.6Z" />
          </svg>
        </span>
        <h1>{t('gallery.soon.title')}</h1>
        <p>{t('gallery.soon.text')}</p>
      </div>
    </div>
  )
}
