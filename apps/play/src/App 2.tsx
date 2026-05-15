import { Routes, Route, Navigate } from 'react-router-dom'
import PlayHomePage from './pages/PlayHomePage'
import PlayPage from './pages/PlayPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PlayHomePage />} />
      <Route path="/p/:projectId" element={<PlayPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
