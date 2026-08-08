import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useI18n, type Lang } from '../i18n'
import NetworkOverlay from './NetworkOverlay'
import { playUi, unlockUiSound, setHapticHook, isUiSoundEnabled, setUiSoundEnabled, type UiSoundName } from '@shared/utils/uiSound'

/**
 * Layout commun des écrans PLAY (hors scan /p/:id) :
 * fond illustré prairie + menu ☰ en haut à droite + barre d'onglets en bas.
 */
export default function PlayShell() {
  // Sound design d'UI (global) : déverrouillage audio au 1er geste + tap léger
  // délégué sur tous les boutons/liens + retour haptique (import dynamique, la
  // dépendance @capacitor/haptics reste côté play).
  useEffect(() => {
    const onFirstGesture = () => unlockUiSound()
    window.addEventListener('pointerdown', onFirstGesture, { once: true, capture: true })

    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('button, a, [role="button"], .shell-tab')
      if (el && el.getAttribute('data-ui-sound') !== 'off') playUi('tap')
    }
    document.addEventListener('click', onClick, true)

    let hapticsMod: Promise<typeof import('@capacitor/haptics')> | null = null
    setHapticHook((_name: UiSoundName) => {
      hapticsMod ??= import('@capacitor/haptics')
      void hapticsMod.then(({ Haptics, ImpactStyle }) => Haptics.impact({ style: ImpactStyle.Light })).catch(() => {})
    })

    return () => {
      window.removeEventListener('pointerdown', onFirstGesture, { capture: true } as EventListenerOptions)
      document.removeEventListener('click', onClick, true)
      setHapticHook(null)
    }
  }, [])

  return (
    <div className="play-shell">
      <div className="shell-bg" aria-hidden="true" />
      <NetworkOverlay />
      <TopMenu />
      <main className="shell-content">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

function TopMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { lang, setLang, t } = useI18n()
  const [soundOn, setSoundOn] = useState<boolean>(() => isUiSoundEnabled())
  const pickSound = (on: boolean) => {
    setUiSoundEnabled(on)
    setSoundOn(on)
    if (on) { unlockUiSound(); playUi('tap') } // petit retour immédiat à l'activation
  }

  const go = (path: string) => {
    setOpen(false)
    navigate(path)
  }
  const pickLang = (l: Lang) => {
    setLang(l)
    setOpen(false)
  }

  return (
    <>
      <button
        className="shell-menu-btn"
        aria-label="Menu"
        onClick={() => setOpen(o => !o)}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open && (
        <>
          <div className="shell-menu-overlay" onClick={() => setOpen(false)} />
          <div className="shell-menu-dropdown soft-card" role="menu">
            <button className="shell-menu-item" role="menuitem" onClick={() => go('/tuto')}>
              {t('menu.tuto')}
            </button>
            <button className="shell-menu-item" role="menuitem" onClick={() => go('/a-propos')}>
              {t('menu.about')}
            </button>
            <div className="shell-menu-sep" />
            <div className="shell-menu-lang">
              <span>{t('menu.language')}</span>
              <div className="shell-menu-lang-btns">
                <button
                  className={`shell-lang-btn ${lang === 'fr' ? 'shell-lang-btn--active' : ''}`}
                  onClick={() => pickLang('fr')}
                >
                  🇫🇷 FR
                </button>
                <button
                  className={`shell-lang-btn ${lang === 'en' ? 'shell-lang-btn--active' : ''}`}
                  onClick={() => pickLang('en')}
                >
                  🇬🇧 EN
                </button>
              </div>
            </div>
            <div className="shell-menu-lang" data-ui-sound="off">
              <span>{t('menu.sound')}</span>
              <div className="shell-menu-lang-btns">
                <button
                  className={`shell-lang-btn ${soundOn ? 'shell-lang-btn--active' : ''}`}
                  data-ui-sound="off"
                  onClick={() => pickSound(true)}
                >
                  🔊 {t('menu.sound.on')}
                </button>
                <button
                  className={`shell-lang-btn ${!soundOn ? 'shell-lang-btn--active' : ''}`}
                  data-ui-sound="off"
                  onClick={() => pickSound(false)}
                >
                  🔇 {t('menu.sound.off')}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

function TabBar() {
  const { t } = useI18n()
  const bubbleClass = (extra: string) => ({ isActive }: { isActive: boolean }) =>
    ['shell-tab', extra, isActive ? 'shell-tab--active' : ''].filter(Boolean).join(' ')

  return (
    <nav className="shell-tabbar">
      <svg className="shell-tabbar-wave" viewBox="0 0 375 26" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 26 L0 16 C 55 4 120 22 188 12 C 255 4 320 20 375 9 L375 26 Z" fill="#cfc0f1" />
      </svg>
      <div className="shell-tabbar-inner">
        <NavLink to="/" end className={bubbleClass('')} aria-label={t('tabs.home')}>
          <span className="tab-bubble tab-bubble--home">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 11.5 12 4l9 7.5" />
              <path d="M5.5 10.5V20h13v-9.5" />
              <path d="M10 20v-5h4v5" />
            </svg>
          </span>
        </NavLink>
        <NavLink to="/scanner" className={bubbleClass('shell-tab--scan')} aria-label={t('tabs.scanner')}>
          <span className="tab-scan-circle">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
              <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
              <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
              <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
            </svg>
            <span className="tab-scan-label">{t('tabs.scanner').toUpperCase()}</span>
          </span>
        </NavLink>
        <NavLink to="/galerie" className={bubbleClass('')} aria-label={t('tabs.gallery')}>
          <span className="tab-bubble tab-bubble--gallery">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" stroke="none">
              <path d="M12 3.2 14.5 8.6 20.4 9.3 16 13.3 17.2 19.1 12 16.2 6.8 19.1 8 13.3 3.6 9.3 9.5 8.6Z" />
            </svg>
          </span>
        </NavLink>
      </div>
    </nav>
  )
}
