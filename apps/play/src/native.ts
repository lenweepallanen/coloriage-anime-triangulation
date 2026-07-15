import { Capacitor } from '@capacitor/core'

// Bootstrap natif (Capacitor). No-op complet sur le web : la version Vercel
// garde strictement le comportement actuel. Aucun code partagé (@shared) ne
// doit importer ce module — le pont se fait par polyfill des APIs web que le
// code partagé utilise déjà (screen.orientation.lock/unlock).
export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  const [{ ScreenOrientation }, { StatusBar }, { KeepAwake }] = await Promise.all([
    import('@capacitor/screen-orientation'),
    import('@capacitor/status-bar'),
    import('@capacitor-community/keep-awake'),
  ])

  // screen.orientation.lock() n'est pas supporté dans WKWebView : on le
  // redirige vers le plugin natif. ScanPage (code partagé) appelle déjà
  // screen.orientation.lock('landscape') — il fonctionne donc nativement
  // sans modification.
  try {
    const orientation = window.screen?.orientation
    if (orientation) {
      Object.defineProperty(orientation, 'lock', {
        configurable: true,
        value: (type: string) =>
          ScreenOrientation.lock({
            orientation: type as Parameters<typeof ScreenOrientation.lock>[0]['orientation'],
          }),
      })
      Object.defineProperty(orientation, 'unlock', {
        configurable: true,
        value: () => {
          void ScreenOrientation.unlock()
        },
      })
    }
  } catch (err) {
    console.warn('[native] polyfill screen.orientation impossible :', err)
  }

  // Plein écran immersif + écran jamais en veille pendant le jeu.
  // App verrouillée PORTRAIT par défaut (menus stables) ; l'écran scan/animation
  // bascule lui-même en paysage via screen.orientation.lock (polyfillé ci-dessus).
  await Promise.allSettled([
    StatusBar.hide(),
    KeepAwake.keepAwake(),
    ScreenOrientation.lock({ orientation: 'portrait' }),
  ])
}

/**
 * Masque le splash natif. Appelé par l'app React après son premier rendu
 * (le splash reste affiché pendant le parse JS → pas d'écran vide).
 */
export function hideNativeSplash(): void {
  if (!Capacitor.isNativePlatform()) return
  void import('@capacitor/splash-screen').then(({ SplashScreen }) => SplashScreen.hide())
}
