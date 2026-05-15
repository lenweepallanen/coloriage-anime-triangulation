import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export default function ProtectedRoute() {
  const { user, isAdmin, loading } = useAuth()

  if (loading) {
    return <div className="loading" style={{ padding: 24 }}>Chargement…</div>
  }
  if (!user || !isAdmin) {
    return <Navigate to="/login" replace />
  }
  return <Outlet />
}
