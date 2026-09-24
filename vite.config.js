import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // public/_headers ships the correct Content-Type for the manifest and
  // long-cache headers for hashed assets when deployed on Netlify.
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // .webmanifest gets served as application/octet-stream by many static
      // hosts (incl. Netlify), which Chrome can reject -> no install prompt.
      // .json is served as application/json everywhere, so the PWA install
      // works on Netlify, Vercel, GitHub Pages and any plain static host.
      manifestFilename: 'manifest.json',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icons.svg'],
      manifest: {
        name: 'SOHSense — EV Battery Health Meter',
        short_name: 'SOHSense',
        description: 'Personal SOH (State of Health) calculator for every EV car and scooter in India. No hardware needed for estimates.',
        theme_color: '#080A0F',
        background_color: '#080A0F',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        categories: ['utilities', 'productivity', 'automotive'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,json,svg,png,ico,woff2}'],
        // the downloadable offline app is large and only fetched on demand
        globIgnores: ['**/SOHSense-Offline-App.html'],
        // stop the SPA navigation fallback from swallowing the download link
        navigateFallbackDenylist: [/^\/SOHSense-Offline-App\.html$/],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'gstatic-fonts-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    headers: { 'X-Frame-Options': 'ALLOWALL' },
  },
})
