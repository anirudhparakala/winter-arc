const { execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const R = path.join(__dirname, '..');

execSync('node tools/build.js', { cwd: R, stdio: 'inherit' });
const html = fs.readFileSync(path.join(R, 'dist/winter-arc.html'), 'utf8');

// the single file must not point at local assets, and must carry fonts + emoji inline
assert.ok(!/(?:src=|href=|url\()\s*["']?assets\//.test(html), 'single file still references assets/');
assert.ok(html.includes('data:font/woff2;base64,'), 'fonts not inlined');
assert.ok(html.includes('data:image/png;base64,'), 'emoji not inlined');

// every inlined script block must be closed exactly once
const count = (s, re) => (s.match(re) || []).length;
assert.strictEqual(count(html, /<\/script>/gi), count(html, /<script[\s>]/gi), 'script open/close tags unbalanced');

// the escape for "</script>" inside a JS string must really work: build a throwaway
// copy of the repo whose ui.js contains that text, and check the output stays intact
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winter-arc-build-'));
try {
  fs.cpSync(R, tmp, { recursive: true, filter: s => !/[\/](\.git|node_modules|dist|\.superpowers|\.playwright-mcp)([\/]|$)/.test(s) });
  fs.appendFileSync(path.join(tmp, 'js/ui.js'), "\nvar __probe = '</script><b>probe</b>';\n");
  execSync('node tools/build.js', { cwd: tmp, stdio: 'pipe' });
  const out = fs.readFileSync(path.join(tmp, 'dist/winter-arc.html'), 'utf8');
  assert.strictEqual(count(out, /<\/script>/gi), count(out, /<script[\s>]/gi), 'a "</script>" inside a JS string broke the inline script block');
  assert.ok(out.includes("'<\\/script><b>probe</b>'"), 'probe string was not escaped');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// the service worker must precache every file it lists, plus all fonts and emoji
const sw = fs.readFileSync(path.join(R, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(s => s.includes('/') || s.endsWith('.html'));
shell.filter(s => s !== './').forEach(s => assert.ok(fs.existsSync(path.join(R, s)), 'missing ' + s));
const files = d => fs.readdirSync(path.join(R, d)).map(f => d + '/' + f);
[...files('assets/fonts'), ...files('assets/emoji')].forEach(f => assert.ok(shell.includes(f), 'not cached: ' + f));


// GitHub Pages sends max-age=600: install and revalidation must bypass the HTTP cache,
// or a new worker can precache a stale index.html/app.js next to fresh files (mixed shell)
assert.ok(/c\.add\(\s*new Request\([^)]*cache:\s*'reload'/.test(sw), 'install must precache with cache: reload');
assert.ok(/fetch\(e\.request,\s*\{\s*cache:\s*'no-cache'\s*\}\)/.test(sw), 'stale-while-revalidate must use cache: no-cache');
console.log('sw cache modes ok');
console.log('build ok');
