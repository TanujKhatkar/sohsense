import fs from 'node:fs';
import path from 'node:path';

const src = '/home/user/ev-battery-health/dist-offline';
let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
let css  = fs.readFileSync(path.join(src, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(src, 'app.js'), 'utf8');
const fonts = fs.readFileSync(new URL('./fonts-inline.css', import.meta.url), 'utf8');

// swap the Google Fonts @import for base64-embedded woff2 (works in airplane mode)
const before = css.length;
css = css.replace(/@import\s+(?:url\(\s*)?['"]https:\/\/fonts\.googleapis\.com[^;]*;/, () => fonts);
console.log('google-fonts @import replaced:', css.length !== before);
if (/fonts\.googleapis\.com/.test(css)) throw new Error('font @import still present!');

// function replacers: string replacers would expand $& $` $' inside the bundle
html = html.replace(/<link rel="stylesheet"[^>]*href="\/app\.css"[^>]*>/, () => `<style>\n${css}\n</style>`);
// remove the head <script> tag, then inject the bundle at the END OF BODY.
// (a classic inline script in <head> runs before #root exists -> React mounts nothing)
html = html.replace(/<script type="module"[^>]*src="\/app\.js"[^>]*><\/script>/, () => '');
html = html.replace('</body>', () => `<script>\n${js}\n</script>\n  </body>`);
html = html.replace(/<link rel="icon"[^>]*>/g, () => '');
html = html.replace(/<link rel="apple-touch-icon"[^>]*>/g, () => '');

const favicon = "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23080A0F'/%3E%3Crect x='22' y='30' width='56' height='40' rx='8' fill='none' stroke='%2360F0A0' stroke-width='6'/%3E%3Cpath d='M52 38 L40 54 h9 l-3 12 L58 48 h-9z' fill='%2360F0A0'/%3E%3C/svg%3E\" />";
html = html.replace('<title>', () => favicon + '\n    <title>');
html = html.replace('<!doctype html>', () => `<!doctype html>
<!--
  ============================================================
   SOHSense - EV Battery Health Meter (SOH)   |  INDIA
   OFFLINE SINGLE-FILE BUILD  -  100% self-contained
  ------------------------------------------------------------
   No internet. No server. No install. No account.
   Just open this file in any browser (Chrome / Safari / Edge),
   even in airplane mode. Fonts, icons and all logic are inside.
   Every SOH estimate + Battery Passport entry stays on-device.
   Note: SOH only. This app does not calculate SOC.
  ============================================================
-->
`);

fs.writeFileSync('/home/user/SOHSense-Offline-App.html', html);
console.log('written: SOHSense-Offline-App.html', (fs.statSync('/home/user/SOHSense-Offline-App.html').size / 1024).toFixed(1), 'KB');

// ---- verification ----
const ext = (html.match(/(?:src|href)\s*=\s*"(?!data:|#)[^"]*"/gi) || []).filter(u => !/`/.test(u));
console.log('external src/href refs :', ext.length ? ext : 'NONE ✓');
console.log('</script> count        :', (html.match(/<\/script>/g) || []).length, '(must be 1)');
console.log('embedded font files    :', (html.match(/data:font\/woff2;base64,/g) || []).length);
console.log('google fonts refs      :', (html.match(/fonts\.(googleapis|gstatic)\.com/g) || []).length);
console.log('script after </body>?  :', html.indexOf('<script>') > html.indexOf('</body>') ? 'NO (ok)' : 'CHECK');
console.log('script before </body>  :', html.lastIndexOf('<script>') < html.lastIndexOf('</body>') ? 'YES ✓ (matches at end of body)' : 'FAIL');
