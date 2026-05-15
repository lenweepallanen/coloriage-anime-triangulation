import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import AdminLayout from './pages/admin/AdminLayout'
import AdminSectionMenu from './pages/admin/AdminSectionMenu'
import GeneralSection from './pages/admin/GeneralSection'
import AnimationsSection from './pages/admin/AnimationsSection'
import SceneSection from './pages/admin/SceneSection'
import BodyZonesSection from './pages/admin/BodyZonesSection'
import TriangulationSection from './pages/admin/TriangulationSection'
import EyesSection from './pages/admin/EyesSection'
import MouthSection from './pages/admin/MouthSection'
import ScanPage from './pages/ScanPage'
import LoginPage from './auth/LoginPage'
import ProtectedRoute from './auth/ProtectedRoute'

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/admin/:projectId" element={<AdminLayout />}>
            <Route index element={<AdminSectionMenu />} />
            <Route path="general" element={<GeneralSection />} />
            <Route path="animations" element={<AnimationsSection />} />
            <Route path="zones" element={<BodyZonesSection />} />
            <Route path="scene" element={<SceneSection />} />
            <Route path="triangulation" element={<TriangulationSection />} />
            <Route path="eyes" element={<EyesSection />} />
            <Route path="mouth" element={<MouthSection />} />
          </Route>
          <Route path="/scan/:projectId" element={<ScanPage />} />
        </Route>
      </Route>
    </Routes>
  )
}

export default App
