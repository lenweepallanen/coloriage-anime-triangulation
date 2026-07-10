import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { hideNativeSplash } from './native'
import { I18nProvider } from './i18n'
import PlayShell from './components/PlayShell'
import PlayHomePage from './pages/PlayHomePage'
import PlayPage from './pages/PlayPage'
import BookPage from './pages/BookPage'
import ScannerPage from './pages/ScannerPage'
import GaleriePage from './pages/GaleriePage'
import TutoPage from './pages/TutoPage'
import AProposPage from './pages/AProposPage'

export default function App() {
  // Le splash natif reste affiché jusqu'au premier rendu React (pas d'écran
  // vide entre le splash et le boot screen).
  useEffect(() => { hideNativeSplash() }, [])

  return (
    <I18nProvider>
      <Routes>
        {/* Écrans avec shell : fond illustré + menu ☰ + barre d'onglets */}
        <Route element={<PlayShell />}>
          <Route path="/" element={<PlayHomePage />} />
          <Route path="/scanner" element={<ScannerPage />} />
          <Route path="/galerie" element={<GaleriePage />} />
          <Route path="/tuto" element={<TutoPage />} />
          <Route path="/a-propos" element={<AProposPage />} />
          <Route path="/livre/:bookId" element={<BookPage />} />
        </Route>
        {/* Scan + animation : plein écran, sans shell */}
        <Route path="/p/:projectId" element={<PlayPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </I18nProvider>
  )
}
