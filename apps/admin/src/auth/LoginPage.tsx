import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export default function LoginPage() {
  const { user, isAdmin, loading, signIn, error } = useAuth()

  if (user && isAdmin) return <Navigate to="/" replace />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
      <h1>Admin Coloriage Animé</h1>
      <p style={{ maxWidth: 480, color: '#555' }}>
        Connectez-vous avec votre compte Google autorisé.
      </p>
      <button
        onClick={signIn}
        disabled={loading}
        className="btn-primary"
        style={{ marginTop: 16, padding: '10px 24px' }}
      >
        {loading ? 'Connexion…' : 'Se connecter avec Google'}
      </button>
      {error && (
        <p style={{ marginTop: 16, color: '#b00020', maxWidth: 480 }}>
          {error}
        </p>
      )}
    </div>
  )
}
