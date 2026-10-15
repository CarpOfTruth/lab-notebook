import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    open: !process.env.LABLOG_API_TARGET,
    proxy: {
      // LABLOG_API_TARGET points an isolated preview frontend at an isolated backend
      '/api': { target: process.env.LABLOG_API_TARGET || 'http://localhost:8000', changeOrigin: true },
    },
  },
  resolve: {
    alias: {
      'plotly.js/dist/plotly': path.resolve(__dirname, 'node_modules/plotly.js-dist-min/plotly.min.js'),
    },
  },
  optimizeDeps: {
    include: ['react-plotly.js', 'plotly.js-dist-min'],
  },
})
