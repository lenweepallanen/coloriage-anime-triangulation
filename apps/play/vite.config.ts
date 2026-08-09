import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// apps/play/ — application USER (déployée sur https://coloriage-anime-play.vercel.app
// ou un domaine custom branché plus tard).
// Importe son code partagé depuis apps/admin/src via l'alias `@shared/*`.
// Le `publicDir` pointe vers apps/admin/public pour réutiliser opencv.js + worker
// sans duplication.
export default defineConfig({
  plugins: [react(), basicSsl()],
  // Build prod : on retire les logs de debug (console.log/debug/info) — beaucoup
  // viennent du code partagé @shared. On GARDE console.warn/error (diagnostic de
  // crash). Marqués `pure` → éliminés par le tree-shaking de la build minifiée.
  esbuild: {
    pure: ['console.log', 'console.debug', 'console.info'],
  },
  publicDir: path.resolve(__dirname, '../admin/public'),
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../admin/src'),
    },
  },
  server: {
    host: true,
  },
})
