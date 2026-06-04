import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth/AuthProvider'
import './styles/global.css'

// Outil maintenance : backfill des vignettes du menu livre. Exposé sur window pour
// être lancé à la main depuis la console (auth admin requise pour écrire). DEV only.
if (import.meta.env.DEV) {
  void import('./db/backfillThumbnails').then(({ backfillAllThumbnails }) => {
    ;(window as unknown as Record<string, unknown>).backfillThumbnails = async (
      opts?: { force?: boolean; concurrency?: number },
    ) => {
      console.log('[vignettes] démarrage…', opts ?? {})
      const summary = await backfillAllThumbnails({
        ...opts,
        onProgress: p =>
          console.log(`[vignettes] ${p.index}/${p.total} — ${p.name}: ${p.result}`),
      })
      console.log('[vignettes] terminé ✅', summary)
      return summary
    }
    console.info(
      "💡 Vignettes : connecte-toi puis exécute `await backfillThumbnails()` dans cette console " +
        '(ou `await backfillThumbnails({ force: true })` pour tout régénérer).',
    )
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
