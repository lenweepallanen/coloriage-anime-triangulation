import type { CapacitorConfig } from '@capacitor/cli'

// Config Capacitor de l'app native PLAY (iOS + Android).
// La version web (Vercel) n'est pas affectée : Capacitor ne fait qu'emballer
// le build Vite (`dist/`) dans une WebView native.
//
// ⚠️ appId : identifiant définitif une fois publié sur les stores.
// Modifiable librement tant qu'aucune version n'est soumise.
const config: CapacitorConfig = {
  appId: 'app.picopop.mobile',
  appName: 'Picopop',
  webDir: 'dist',
  server: {
    // Android : origine https://localhost (contexte sécurisé pour getUserMedia).
    // iOS : WKWebView interdit d'enregistrer https comme schéma custom → Capacitor
    // utilise capacitor://localhost quoi qu'il arrive (custom schemes = contexte
    // sécurisé dans WKWebView, la caméra fonctionne quand même).
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      // Masqué manuellement au premier rendu React (hideNativeSplash) pour
      // éviter le flash d'écran vide entre le splash natif et le boot screen.
      launchAutoHide: false,
      backgroundColor: '#fdfcfc',
    },
  },
}

export default config
