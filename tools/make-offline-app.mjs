#!/usr/bin/env node
/**
 * make-offline-app.mjs
 * ---------------------------------------------------------------------------
 * Builds the single-file, fully offline version of SOHSense and drops it into
 * `public/` so the deployed website can serve it as a download.
 *
 * Output: public/SOHSense-Offline-App.html
 *   - one file, ~630 KB
 *   - zero external requests (fonts, icons and app code are all embedded)
 *   - runs from file:// in any browser, with no internet at all
 *
 * Usage:  npm run build:offline
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distOffline = path.join(root, 'dist-offline');
const target = path.join(root, 'public', 'SOHSense-Offline-App.html');

const run = (args) => {
  console.log(`\n$ ${args.join(' ')}`);
  execFileSync('npx', args, { cwd: root, stdio: 'inherit' });
};

/* 1 ─ build the app as ONE classic IIFE bundle (no ES modules, so it works
       from file:// where module scripts are blocked by CORS) */
run(['vite', 'build', '--config', 'vite.config.offline.js']);

/* 2 ─ inline fonts + css + js into the html */
const htmlPath = path.join(distOffline, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(path.join(distOffline, 'app.js'), 'utf8');
let css = fs.readFileSync(path.join(distOffline, 'app.css'), 'utf8');

// swap the Google Fonts @import for base64-embedded woff2 files
const fontsCache = path.join(root, 'tools', 'fonts-inline.css');
if (fs.existsSync(fontsCache)) {
  css = css.replace(
    /@import\s+(?:url\(\s*)?['"]https:\/\/fonts\.googleapis\.com[^;]*;?/,
    () => fs.readFileSync(fontsCache, 'utf8')
  );
}
if (/fonts\.googleapis\.com/.test(css)) {
  console.warn('\n  ! Google Fonts @import could not be inlined — run tools/inline_fonts.mjs while online.');
}

/* IMPORTANT: function replacers — a string replacer would expand $& $` $'
   sequences that exist inside the minified bundle and corrupt the output. */
css = css.replace(/@import\s+url\([^)]*\);/g, () => ''); // drop any leftovers
html = html.replace(/<link rel="stylesheet"[^>]*href="\/app\.css"[^>]*>/, () => `<style>\n${css}\n</style>`);
html = html.replace(/<script type="module"[^>]*src="\/app\.js"[^>]*><\/script>/, () => '');
// a classic <script> in <head> would run before #root exists — put it last
html = html.replace('</body>', () => `<script>\n${js}\n</script>\n  </body>`);
html = html.replace(/<link rel="icon"[^>]*>/g, () => '');
html = html.replace(/<link rel="apple-touch-icon"[^>]*>/g, () => '');

const favicon =
  "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23080A0F'/%3E%3Crect x='22' y='30' width='56' height='40' rx='8' fill='none' stroke='%2360F0A0' stroke-width='6'/%3E%3Cpath d='M52 38 L40 54 h9 l-3 12 L58 48 h-9z' fill='%2360F0A0'/%3E%3C/svg%3E\" />";
html = html.replace('<title>', () => favicon + '\n    <title>');

html = html.replace('<!doctype html>', () => `<!doctype html>
<!--
  ============================================================
   SOHSense - EV Battery Health Meter (SOH)   |  INDIA
   OFFLINE SINGLE-FILE BUILD  -  100% self-contained
  ------------------------------------------------------------
   No internet. No server. No install. No account.
   Open this file in any browser (Chrome / Safari / Edge),
   even in airplane mode. Fonts, icons and logic are inside.
   Every SOH estimate + Battery Passport entry stays on-device.
   Note: SOH only. This app does not calculate SOC.
  ============================================================
-->
`);

/* 3 ─ verify before shipping */
const problems = [];
if (!html.includes('<div id="root">')) problems.push('missing #root mount point');
if ((html.match(/<\/script>/g) || []).length !== 1) problems.push('unexpected </script> count');
if (html.indexOf('<script>') > html.indexOf('</body>')) problems.push('script must sit inside <body>');
const external = html.match(/(?:src|href)\s*=\s*"(?!data:|#)[^"`]*"/gi) || [];
if (external.length) problems.push('external references remain: ' + external.join(', '));

if (problems.length) {
  console.error('\n  OFFLINE BUILD FAILED:');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, html);
console.log(`\n  public/SOHSense-Offline-App.html  ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB  ✓`);
console.log('  self-contained: no network requests, works offline.\n');
