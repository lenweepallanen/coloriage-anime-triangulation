import { initializeApp } from 'firebase/app'
import { initializeFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getAuth, initializeAuth, indexedDBLocalPersistence } from 'firebase/auth'

const firebaseConfig = {
  apiKey: "AIzaSyBI-0Au1E8ABeVxFidRaA2yZYiWSAYHjuo",
  authDomain: "coloriage-anime-prod.firebaseapp.com",
  projectId: "coloriage-anime-prod",
  storageBucket: "coloriage-anime-prod.firebasestorage.app",
  messagingSenderId: "856883678527",
  appId: "1:856883678527:web:f3bcf9d71299811758978a"
}

// App native Capacitor (iOS/Android) : le bridge natif injecte window.Capacitor
// avant tout script applicatif. Dans les WebView natives, le transport streaming
// de Firestore (WebChannel/fetch streams) se bloque — les requêtes restent
// suspendues sans jamais échouer. Le long-polling forcé est le contournement
// officiel. Sur le web (admin + play Vercel), comportement streaming inchangé.
type CapacitorGlobal = { isNativePlatform?: () => boolean }
const isCapacitorNative =
  ((globalThis as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.()) === true

const app = initializeApp(firebaseConfig)
// useFetchStreams n'est pas dans les typings publics mais est lu par le SDK :
// les fetch ReadableStreams sont bugués dans WKWebView → il faut les désactiver
// en plus du long-polling forcé, sinon getDocs reste suspendu indéfiniment.
const nativeFirestoreSettings = {
  experimentalForceLongPolling: true,
  useFetchStreams: false,
} as Parameters<typeof initializeFirestore>[1]
export const db = initializeFirestore(
  app,
  isCapacitorNative ? nativeFirestoreSettings : {},
  'coloriages'
)
export const storage = getStorage(app)
// getAuth() standard suspend son init dans une WebView Capacitor (résolveur
// popup/redirect navigateur) → Firestore attend le jeton auth pour toujours.
// Pattern documenté pour Capacitor : initializeAuth + persistance IndexedDB
// explicite, sans résolveur popup/redirect.
export const auth = isCapacitorNative
  ? initializeAuth(app, { persistence: indexedDBLocalPersistence })
  : getAuth(app)
