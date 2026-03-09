import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import AdminPage from './pages/AdminPage'
import ScanPage from './pages/ScanPage'

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/admin/:projectId" element={<AdminPage />} />
        <Route path="/scan/:projectId" element={<ScanPage />} />
      </Route>
    </Routes>
  )
}

export default App
