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
import ScanPage from './pages/ScanPage'

function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/admin/:projectId" element={<AdminLayout />}>
          <Route index element={<AdminSectionMenu />} />
          <Route path="general" element={<GeneralSection />} />
          <Route path="animations" element={<AnimationsSection />} />
          <Route path="zones" element={<BodyZonesSection />} />
          <Route path="scene" element={<SceneSection />} />
          <Route path="triangulation" element={<TriangulationSection />} />
        </Route>
        <Route path="/scan/:projectId" element={<ScanPage />} />
      </Route>
    </Routes>
  )
}

export default App
