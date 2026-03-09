import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: "AIzaSyAPqMcEUVMRWgwxUFxlu_D2pm3nu0R8clo",
  authDomain: "coloriage-anime-triangulation.firebaseapp.com",
  projectId: "coloriage-anime-triangulation",
  storageBucket: "coloriage-anime-triangulation.firebasestorage.app",
  messagingSenderId: "460278856781",
  appId: "1:460278856781:web:e50f3a4c5a2b7950db3004"
}

const app = initializeApp(firebaseConfig)
export const db = getFirestore(app, 'coloriages')
export const storage = getStorage(app)
