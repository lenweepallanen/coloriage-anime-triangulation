import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    // Proxy `/api/sam2/*` to local Python server (sam2-local/ on Mac M2 MPS).
    // The browser talks HTTPS to the Vite dev server, the dev server talks HTTP to
    // the local Flask server — no mixed-content blocking. Activated when .env.local
    // sets VITE_SAM2_FUNCTION_URL=/api/sam2/.
    proxy: {
      '/api/sam2': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        secure: false,
        // Pour la fonction Python, le path attendu est `/`. On enlève donc `/api/sam2`.
        rewrite: (path) => path.replace(/^\/api\/sam2\/?/, '/'),
        // 10 minutes — laisse le temps à SAM 2 de tourner sur de longues vidéos
        timeout: 10 * 60 * 1000,
        proxyTimeout: 10 * 60 * 1000,
      },
      // Proxy `/api/cotracker/*` to local Python server (cotracker-local/ on Mac MPS).
      // Activated when .env.local sets VITE_COTRACKER_FUNCTION_URL=/api/cotracker/.
      '/api/cotracker': {
        target: 'http://127.0.0.1:8766',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api\/cotracker\/?/, '/'),
        timeout: 10 * 60 * 1000,
        proxyTimeout: 10 * 60 * 1000,
      },
    },
  },
})
