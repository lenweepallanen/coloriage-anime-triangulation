import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'

export default function LoginPage() {
  const { user, isAdmin, loading, signIn, error } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  if (user && isAdmin) return <Navigate to="/" replace />

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) return
    void signIn(email, password)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 360 }}
      >
        <h1 style={{ marginBottom: 8 }}>Admin Coloriage Animé</h1>
        <p style={{ color: '#555', marginTop: 0 }}>
          Connectez-vous avec votre compte administrateur.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, color: '#555' }}>Email</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            required
            style={{ padding: '8px 10px', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13, color: '#555' }}>Mot de passe</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            required
            style={{ padding: '8px 10px', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 }}
          />
        </label>
        <button
          type="submit"
          disabled={loading || !email || !password}
          className="btn-primary"
          style={{ marginTop: 8, padding: '10px 16px' }}
        >
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>
        {error && (
          <p style={{ color: '#b00020', fontSize: 14, marginTop: 4 }}>
            {error}
          </p>
        )}
      </form>
    </div>
  )
}
