// Offline single-file build: one classic <script>, zero network requests.
// Same app code as the deployed PWA — only the output format differs.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { 'virtual:pwa-register': '/src/pwa-register-stub.js' },
  },
  build: {
    outDir: 'dist-offline',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    rollupOptions: {
      output: {
        format: 'iife',
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
})
