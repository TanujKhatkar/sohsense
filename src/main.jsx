import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.jsx'

// PWA: registers the service worker so SOHSense installs like a native app
// and keeps working offline (all SOH calculation is on-device anyway).
// Guarded so the app also works when opened directly as a local file (file://)
// where service workers do not exist.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  try {
    registerSW({ immediate: true })
  } catch {
    /* offline local-file mode — app still runs 100% on-device */
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
