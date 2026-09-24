import fs from 'node:fs';

const CSS_URL = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Space+Grotesk:wght@400;500;700&display=swap";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();

// keep only latin (unicode-range U+0000-00FF ...) blocks to save size
const blocks = css.split('@font-face').slice(1).map(b => '@font-face' + b.split('}')[0] + '}');
const latin = blocks.filter(b => /unicode-range:\s*U\+0000-00FF/.test(b));
const keep = latin.length ? latin : blocks;
console.log('font-face blocks total:', blocks.length, '| latin kept:', keep.length);

let out = [];
let bytes = 0;
for (const b of keep) {
  const m = b.match(/url\((https:[^)]+\.woff2)\)/);
  if (!m) continue;
  const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  bytes += buf.length;
  out.push(b.replace(m[1], `data:font/woff2;base64,${buf.toString('base64')}`));
}
fs.writeFileSync('/home/user/fonts-inline.css', out.join('\n'));
console.log('inlined', out.length, 'font files |', (bytes / 1024).toFixed(1), 'KB of woff2');
