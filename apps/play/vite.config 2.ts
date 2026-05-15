import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// apps/play/ — application USER (play.NDD).
// Importe son code partagé depuis apps/admin/src via l'alias `@shared/*`.
// Le `publicDir` pointe vers apps/admin/public pour réutiliser opencv.js + worker
// sans duplication.
export default defineConfig({
  plugins: [react(), basicSsl()],
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
