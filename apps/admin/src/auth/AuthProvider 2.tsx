import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import {
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
import { doc, getDoc, addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../db/firebase'

interface AuthContextValue {
  user: User | null
  isAdmin: boolean
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  error: string | null
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setError(null)
      if (!u) {
        setUser(null)
        setIsAdmin(false)
        setLoading(false)
        return
      }
      try {
        const adminDoc = await getDoc(doc(db, 'admins', u.uid))
        if (adminDoc.exists()) {
          setUser(u)
          setIsAdmin(true)
        } else {
          await fbSignOut(auth)
          setUser(null)
          setIsAdmin(false)
          setError(`Accès refusé : ${u.email} n'est pas dans la liste des admins.`)
        }
      } catch (e) {
        console.error('[Auth] admin check failed:', e)
        setError("Impossible de vérifier les droits d'accès.")
      } finally {
        setLoading(false)
      }
    })
    return unsub
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null)
    setLoading(true)
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password)
      // Login history — best-effort, on rule denial cela échouera silencieusement.
      try {
        await addDoc(collection(db, 'loginHistory'), {
          uid: cred.user.uid,
          email: cred.user.email ?? null,
          timestamp: serverTimestamp(),
        })
      } catch (e) {
        console.warn('[Auth] loginHistory write failed:', e)
      }
    } catch (e) {
      // Firebase Auth renvoie des codes comme auth/invalid-credential, auth/user-not-found.
      const code = (e as { code?: string })?.code ?? ''
      const friendly =
        code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found'
          ? 'Email ou mot de passe incorrect.'
          : code === 'auth/too-many-requests'
            ? 'Trop de tentatives, réessaye dans quelques minutes.'
            : code === 'auth/invalid-email'
              ? 'Email invalide.'
              : `Échec de la connexion : ${e instanceof Error ? e.message : String(e)}`
      setError(friendly)
      setLoading(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    await fbSignOut(auth)
  }, [])

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, signIn, signOut, error }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
