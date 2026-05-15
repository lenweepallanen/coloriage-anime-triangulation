import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { getAuth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: "AIzaSyBI-0Au1E8ABeVxFidRaA2yZYiWSAYHjuo",
  authDomain: "coloriage-anime-prod.firebaseapp.com",
  projectId: "coloriage-anime-prod",
  storageBucket: "coloriage-anime-prod.firebasestorage.app",
  messagingSenderId: "856883678527",
  appId: "1:856883678527:web:f3bcf9d71299811758978a"
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app, 'coloriages')
export const storage = getStorage(app)
export const auth = getAuth(app)
