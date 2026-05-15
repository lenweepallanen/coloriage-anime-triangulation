import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import {
  GoogleAuthProvider,
  signInWithPopup,
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
  signIn: () => Promise<void>
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

  const signIn = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const provider = new GoogleAuthProvider()
      const cred = await signInWithPopup(auth, provider)
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
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Échec de la connexion : ${msg}`)
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
