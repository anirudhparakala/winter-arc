/* Bundles the whole app into one portable file: dist/winter-arc.html
   No dependencies. The output opens by double-click (file://) with no server,
   so you can email it to a friend. Fonts and emoji are inlined as data: URIs.
   Run: node tools/build.js                                                  */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const b64  = p => fs.readFileSync(path.join(ROOT, p)).toString('base64');

let html = read('index.html');

/* --- inline the stylesheet --- */
html = html.replace(
  /<link rel="stylesheet" href="css\/style\.css">/,
  () => '<style>\n' + read('css/style.css') + '\n</style>'
);

/* --- inline every script, in load order --- */
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
scripts.forEach(src => {
  const code = read(src);
  html = html.replace(
    `<script src="${src}"></script>`,
    // the source can contain </script> inside a string literal — neutralise it
    () => '<script>\n' + code.replace(/<\/script>/gi, '<\\/script>') + '\n</script>'
  );
});

/* --- fonts: url(../assets/fonts/X.woff2) in the inlined CSS becomes a data: URI --- */
html = html.replace(/url\(\s*["']?\.\.\/assets\/fonts\/([\w-]+\.woff2)["']?\s*\)/g,
  (_, f) => `url("data:font/woff2;base64,${b64('assets/fonts/' + f)}")`);

/* --- drop the server-only bits: manifest, and font preloads (the fonts are inlined) --- */
html = html.replace(/<link rel="manifest"[^>]*>\s*/, '');
html = html.replace(/<link rel="preload"[^>]*>\s*/g, '');

/* --- inline the icons --- */
html = html.replace(
  /<link rel="apple-touch-icon" href="icons\/icon-192\.png">/,
  () => `<link rel="apple-touch-icon" href="data:image/png;base64,${b64('icons/icon-192.png')}">`
);
html = html.replace(
  /<link rel="icon"[^>]*>/,
  () => `<link rel="icon" href="data:image/png;base64,${b64('icons/icon-192.png')}">`
);

/* --- emoji: every assets/emoji/<f>.png string (HTML, CSS or the UI.emoji maps)
       becomes a data: URI. Each unique file is read once.                    --- */
const emojiCache = {};
html = html.replace(/assets\/emoji\/[\w-]+\.png/g,
  p => emojiCache[p] || (emojiCache[p] = 'data:image/png;base64,' + b64(p)));

/* --- a note for whoever opens the single file --- */
html = html.replace('</head>', `<!--
  Winter Arc — single-file build.
  Double-click to open. Everything you log is saved in this browser only.
  Settings (gear, top right) has Export backup / Import backup to move your data.
-->
</head>`);

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'winter-arc.html');
fs.writeFileSync(outFile, html, 'utf8');

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`built dist/winter-arc.html  (${kb} KB, ${scripts.length} scripts inlined, ` +
  `${Object.keys(emojiCache).length} emoji inlined)`);

/* sanity: nothing may still point at a local file. data: URIs are fine.
   Only real markup is checked — <script>/<style> bodies hold template strings
   such as src="${src}" that are not references. */
const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const leftover = [
  ...[...markup.matchAll(/(?:src|href)="(?!data:|https?:|#)([^"]+)"/g)].map(m => m[1]),
  ...[...html.matchAll(/url\(\s*["']?(?!data:|https?:|#)([^"')]+)/g)].map(m => m[1]),
  ...(html.match(/assets\/(?:emoji|fonts)\/[\w.-]+/g) || [])
];
if (leftover.length) {
  console.warn('WARNING — unresolved external references:', [...new Set(leftover)].join(', '));
  process.exitCode = 1;
}
