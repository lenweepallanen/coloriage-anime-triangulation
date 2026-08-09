import { useI18n } from '../i18n'

/** Page « Comment ça marche » — 4 étapes + astuces (accessible depuis le menu ☰). */
export default function TutoPage() {
  const { t } = useI18n()
  const steps = [1, 2, 3, 4] as const
  return (
    <div className="placeholder-page">
      <div className="soft-card info-card">
        <h1 className="info-title">{t('tuto.title')}</h1>
        <p className="info-intro">{t('tuto.intro')}</p>
        <ol className="tuto-steps">
          {steps.map(n => (
            <li className="tuto-step" key={n}>
              <span className="tuto-step-num" aria-hidden="true">{n}</span>
              <span className="tuto-step-txt">
                <strong>{t(`tuto.step${n}.t`)}</strong>
                {t(`tuto.step${n}.d`)}
              </span>
            </li>
          ))}
        </ol>
        <p className="tuto-tips">{t('tuto.tips')}</p>
      </div>
    </div>
  )
}
