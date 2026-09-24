# SOHSense — EV Battery Health Meter (SOH) 🇮🇳

**Every EV shows how full the battery is. None shows how healthy it is.**

SOHSense is a personal **State of Health (SOH)** meter for every EV car and scooter in India.
It shows how much capacity the battery has **permanently lost** — so a second-hand EV buyer
never has to guess again.

> **SOH only.** SOHSense estimates permanent capacity loss. It does **not** calculate SOC
> (current charge %). An accurate in-vehicle SOC/SOH reader is the future hardware phase.

---

## Live

| | |
|---|---|
| **App** | https://batteryhealth.netlify.app |
| **Install** | "Get the app" button in the app header — or download the offline file |
| **Works offline** | Yes. Service-worker cached, plus a 630 KB single-file build that needs zero internet |

---

## The problem

- Battery is **~40% of an EV's price** (₹80k for a scooter pack, ₹3L+ for a car).
- The dashboard shows **SOC** — how full the battery is right now. No EV in India shows **SOH**.
- Without SOH, a second-hand buyer is blind: *"Will this battery die in 6 months? Is the 120 km
  range actually 75 km now?"*
- Because sellers can't prove health and buyers can't check it, trust breaks and resale value
  drops hard. **Even a good battery gets sold as a bad one.**
- Existing OBD tools need an expensive dongle plus technical knowledge. Nothing simple exists.

**It's like buying an iPhone that hides Battery Health.**

---

## What it does

- **2-minute SOH estimate** — enter what the seller already knows: model, odometer, purchase
  date, charging habit, fast-charging frequency, climate, parking, driving style.
- **18 Indian EV models** in the lookup (Tata Nexon/ Tiago/ Punch EV, MG ZS EV/ Comet,
  Mahindra XUV400, Hyundai Ioniq 5, BYD Atto 3, Kia EV6, Ola S1 Pro/ S1 Air, Ather 450X,
  TVS iQube, Bajaj Chetak, Hero Vida V1 Pro, Bounce Infinity E1, Simple One) — model
  auto-fills pack capacity, chemistry and claimed range.
- **Honest output** — a *range* (e.g. `78–83%`), never a fake precise number, plus the top
  factors and tailored advice.
- **Battery Passport** — save every check. Per-vehicle history, trend chart, and a 6-month
  SOH projection built from a least-squares regression blended with the physics decay rate.
  Export it as a JSON document to show at resale.
- **Installable app** — PWA with home-screen icon, fullscreen mode and offline support.
- **Downloadable single-file build** — one 630 KB `.html` that runs in any browser with
  no internet, no server, no install.

---

## How the SOH model works

A pure, transparent, India-tuned heuristic — no black box:

```
SOH = 100 − age_loss − cycle_loss − DoD_penalty − fast_charge_penalty − heat_penalty − style_penalty
```

Then clamped to 50–100% and displayed as a range with an uncertainty band (±2.5–5%).

| Factor | Why it matters |
|---|---|
| **Age** | LFP ≈ 1.2%/yr, NMC/NCA ≈ 2.0%/yr calendar fade |
| **Cycles** | equivalent cycles = `total km ÷ claimed range` |
| **Depth of discharge** | daily 0–100% is far harsher than 20–80% |
| **Fast charging** | DC fast charging is penalised, and more so on air-cooled packs |
| **Heat** | hot plains, direct-sun parking and commercial use — **2× penalty for air-cooled scooters** |
| **Driving style** | aggressive throttle use, plus cooling type |

The Battery Passport's prediction layer fits a linear regression on the vehicle's own history
and blends it with the physics decay rate (`total loss ÷ age`), weighting the regression by
its R². With fewer than 3 saved checks it falls back to pure physics and says so.

**Uncertainty is reported, not hidden.** Every entry is stored with `method: "heuristic-v1"`
and `certified: false`.

---

## Tech stack

- **React 19** + **Vite 8**
- **Tailwind CSS v4**
- **Framer Motion** — transitions and micro-interactions
- **Hand-built SVG** — the gauge, needle and range band
- **vite-plugin-pwa / Workbox** — service worker, manifest, offline cache
- **Zero backend.** No API, no database, no login. Every calculation runs on the device and
  Battery Passport data lives in `localStorage`.

---

## Project structure

```
├── index.html                     app shell + PWA meta tags
├── vite.config.js                 main build + PWA config (manifest, workbox)
├── vite.config.offline.js         single-file offline build config
├── vercel.json                    cache headers for Vercel
├── public/
│   ├── _headers                   Netlify MIME + cache headers
│   ├── icon-*.png                 home-screen icons (192 / 512 / maskable / apple-touch)
│   └── SOHSense-Offline-App.html  generated: the downloadable single-file app
├── src/
│   ├── App.jsx                    landing, form, gauge, results, install flow
│   ├── BatteryPassport.jsx        per-vehicle history, trend chart, prediction
│   ├── sohStore.js                storage layer + regression/physics prediction
│   ├── main.jsx                   entry + guarded service-worker registration
│   └── index.css                  Tailwind + theme tokens
└── tools/
    ├── make-offline-app.mjs       builds the single-file offline app
    ├── inline_fonts.mjs           caches Google Fonts as base64 woff2
    └── build_offline_html.mjs     (legacy) plain HTML inliner
```

---

## Run locally

```bash
npm install
npm run dev          # http://localhost:5173
```

## Build

```bash
npm run build        # production site  -> dist/
npm run build:offline  # single-file offline app -> public/SOHSense-Offline-App.html
npm run build:all      # both, in the right order
npm run preview        # serve the production build locally
```

> `build:all` first regenerates the offline file, then builds the site, so the deployed
> site can always serve the latest download.

---

## Deploy

**Netlify** (current host)
- Build command: `npm run build:all`
- Publish directory: `dist`

**Vercel**
- Framework preset: **Vite**
- Build command: `npm run build:all` · Output directory: `dist`

**GitHub Pages**
- ⚠️ The app uses absolute asset paths (`/assets/...`) which break at a repo subpath.
  Set `base: '/<repo-name>/'` in `vite.config.js` first, otherwise the page loads blank.

---

## Roadmap

- **Stage 1 — software estimator (live).** The SOH model, Battery Passport and prediction
  engine described above.
- **Stage 2 — hardware SOH meter (next).** A plug-in unit reading real pack data — motor
  RPM, current, voltage sag and cell temperature fused together — to compute true SOH by
  coulomb counting and internal resistance:
  - `SOH = (current full capacity ÷ rated capacity) × 100`
  - `SOH = (internal resistance new ÷ internal resistance now) × 100`

  For cars the device reads the BMS over CAN; for scooters it taps the pack directly.
  The same sensor fusion is what unlocks an accurate in-vehicle **SOC** calculator.

---

## Honest disclaimers

- SOHSense is an **estimate**, not a certified lab or BMS measurement. Never a warranty claim.
- It is **SOH only**. It does not read or calculate SOC.
- No data leaves the device. No account, no tracking, no server.

---

## License

Built by **Tanuj** — Bhiwani, Haryana · BS in AI & Data Science, IIT Jodhpur.
