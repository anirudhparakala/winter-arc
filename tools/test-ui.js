/* Smoke-tests the pure chart helpers in a bare VM.
   Run: node tools/test-ui.js                                            */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'charts.js'), 'utf8');
const ctx = { console };
ctx.window = ctx;
ctx.document = { documentElement: {} };
ctx.getComputedStyle = () => ({ getPropertyValue: () => '' });
ctx.ResizeObserver = class { observe() {} disconnect() {} };
ctx.requestAnimationFrame = f => f();
vm.createContext(ctx);
vm.runInContext(SRC, ctx);
const Charts = ctx.window.Charts;

assert.strictEqual(typeof ctx.window.esc, 'function', 'window.esc still exported');
assert.strictEqual((Charts.segments(3, 7).match(/<i/g) || []).length, 7);
assert.strictEqual((Charts.segments(3, 7).match(/class="on"/g) || []).length, 3);
assert.strictEqual((Charts.segments(0, 0).match(/<i/g) || []).length, 1);
assert.strictEqual((Charts.segments(40, 40).match(/<i/g) || []).length, 31);
assert.strictEqual((Charts.segments(5, 3).match(/class="on"/g) || []).length, 3, 'done is clamped to total');
console.log('ui ok');

/* ---------- segments edge cases ---------- */
assert.ok((Charts.segments(0, -3).match(/<i/g) || []).length >= 1, 'negative total -> >=1 block');
assert.ok((Charts.segments(0, NaN).match(/<i/g) || []).length >= 1, 'NaN total -> >=1 block');
assert.ok((Charts.segments(NaN, 5).match(/<i/g) || []).length === 5, 'NaN done is safe');
assert.strictEqual((Charts.segments(40, 40).match(/class="on"/g) || []).length, 31, '40/40 lights exactly 31');

/* ---------- lines(): area fill is flat, never a gradient ---------- */
function lineHtml(cfg) {
  const node = { clientWidth: 600, innerHTML: '', addEventListener() {}, setAttribute() {},
    classList: { add() {}, remove() {} }, style: {}, offsetWidth: 0 };
  const el = Object.assign({}, node, { querySelector: () => node, querySelectorAll: () => [] });
  Charts.lines(el, Object.assign({ labels: ['a', 'b', 'c'], height: 200 }, cfg));
  return el.innerHTML;
}
const areaHtml = lineHtml({ area: true, yMax: 100, series: [{ name: 's', color: 'var(--accent)', values: [10, 50, 90] }] });
assert.ok(areaHtml.includes('<svg'), 'area chart renders');
assert.ok(!/gradient/i.test(areaHtml) && !areaHtml.includes('url(#'), 'area fill is flat (no gradient)');
assert.ok(/fill-opacity="\.1"/.test(areaHtml), 'area fill is 10% opacity');
assert.ok(!/stroke-width="2"/.test(areaHtml), 'line is 1.5px, not 2px');
assert.ok(!areaHtml.includes('--surface-1'), 'no legacy token in the hover dot');

/* ---------- lines(): only the final label anchors to the end ---------- */
function anchorsFor(n) {
  const labels = Array.from({ length: n }, (_, i) => 'L' + i);
  const html = lineHtml({ labels, yMax: 100, series: [{ name: 's', color: 'red', values: labels.map(() => 5) }] });
  return [...html.matchAll(/text-anchor="(\w+)">(L\d+)</g)].map(m => [m[2], m[1]]);
}
const a14 = anchorsFor(14);   // labels at 0,3,..,12: 13 is the last point, so nothing may end-anchor
assert.deepStrictEqual(a14.filter(x => x[1] === 'end'), [], 'a non-final label never anchors end');
assert.deepStrictEqual(a14[0], ['L0', 'start']);
const a13 = anchorsFor(13);   // 12 is the last point
assert.deepStrictEqual(a13.filter(x => x[1] === 'end').map(x => x[0]), ['L12'], 'the final label anchors end');

/* ---------- ui.js in a stub DOM ---------- */
function stubEl() {
  const el = { hidden: false, textContent: '', innerHTML: '', style: {}, children: [], attrs: {},
    listeners: [],
    addEventListener(t, f, c) { el.listeners.push([t, f, c]); },
    setAttribute(k, v) { el.attrs[k] = v; },
    appendChild(c) { el.children.push(c); return c; },
    querySelector: () => null, querySelectorAll: () => [],
    contains: () => true, remove() {}, click() {}, focus() {} };
  return el;
}
function loadUI(sessionStorage, media) {
  const c = { console };
  c.window = c;
  const els = {};
  const doc = c.document = {
    documentElement: {}, head: stubEl(), body: stubEl(), activeElement: null,
    getElementById: id => (els[id] = els[id] || stubEl()),
    // a <label> click focuses its <input> (what browsers do); focus()/blur() move activeElement
    createElement: tag => {
      const el = stubEl();
      el.tagName = tag.toUpperCase();
      el.focus = () => { doc.activeElement = el; };
      el.blur = () => { if (doc.activeElement === el) doc.activeElement = null; };
      if (tag === 'label') el.click = () => { if (el.children[0]) el.children[0].focus(); };
      return el;
    },
    querySelector: () => null, addEventListener() {}
  };
  c.sessionStorage = sessionStorage;
  c.__els = els;
  c.Store = { COLORS: [] };
  // media: { reduce, coarse } — evaluated at call time, like the real matchMedia
  c.matchMedia = q => ({ matches: !!media && ((/reduced-motion/.test(q) && !!media.reduce) || (/pointer: coarse/.test(q) && !!media.coarse)) });
  c.navigator = {};
  c.setTimeout = setTimeout; c.clearTimeout = clearTimeout;
  c.getComputedStyle = ctx.getComputedStyle;
  c.ResizeObserver = ctx.ResizeObserver;
  c.requestAnimationFrame = ctx.requestAnimationFrame;
  vm.createContext(c);
  vm.runInContext(SRC, c);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8'), c);
  return c;
}
const mem = {};
const w = loadUI({ getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; } });
const UI = w.window.UI;

assert.ok(/class="emo is-off"/.test(UI.emoji('fire', { lit: false })), 'unlit -> is-off');
assert.ok(UI.emoji('fire', { anim: true }).includes('assets/emoji/fire-anim.png'), 'anim path');
assert.ok(!/is-anim/.test(UI.emoji('fire', { anim: true })), 'real anim has no css fallback class');
const tr = UI.emoji('trophy', { anim: true });
assert.ok(tr.includes('assets/emoji/trophy.png') && !tr.includes('-anim.png') && /is-anim/.test(tr), 'trophy fallback');
assert.strictEqual(UI.emoji('nope'), '');
assert.strictEqual(UI.emoji('constructor'), '', 'inherited keys are not slugs');
assert.strictEqual(UI.emoji('toString', { anim: true }), '');
const lab = UI.emoji('fire', { label: '<b>' });
assert.ok(lab.includes('alt="&lt;b&gt;"') && !lab.includes('<b>'), 'label escaped');
assert.ok(UI.streakChip(5).includes('is-hot') && UI.streakChip(5).endsWith('05</span>'));
assert.ok(!UI.streakChip(2).includes('is-hot'));

/* ---------- emoji(): animated APNGs only when motion is allowed ---------- */
{
  const rm = loadUI({ getItem: () => null, setItem() {} }, { reduce: true }).window.UI;
  const f = rm.emoji('fire', { anim: true });
  assert.ok(f.includes('assets/emoji/fire.png') && !f.includes('-anim.png'), 'reduced motion -> static image');
  assert.ok(!/is-anim/.test(f), 'reduced motion -> no is-anim flicker class either');
  assert.ok(!rm.emoji('party', { anim: true }).includes('-anim.png'));
  assert.ok(!rm.streakChip(9).includes('-anim.png'), 'streak chip honours reduced motion');
  // evaluated per call, not cached at load
  const live = { reduce: false };
  const lv = loadUI({ getItem: () => null, setItem() {} }, live).window.UI;
  assert.ok(lv.emoji('snowflake', { anim: true }).includes('snowflake-anim.png'));
  live.reduce = true;
  assert.ok(!lv.emoji('snowflake', { anim: true }).includes('-anim.png'), 'reduce flipped at runtime is honoured');
}

/* ---------- haptic(): must not leave focus on its hidden input ---------- */
{
  const h = loadUI({ getItem: () => null, setItem() {} });
  const btn = h.document.createElement('button');
  btn.focus(); h.document.activeElement = btn;
  h.window.UI.haptic();
  assert.strictEqual(h.document.activeElement, btn, 'focus is restored to the previously focused element');
  const hidden = h.document.body.children[0].children[0];
  assert.strictEqual(hidden.attrs['aria-hidden'], 'true', 'hidden input is aria-hidden');
  assert.strictEqual(hidden.tabIndex, -1);
  // nothing was focused before: the hidden input must be blurred, not left active
  h.document.activeElement = null;
  h.window.UI.haptic();
  assert.notStrictEqual(h.document.activeElement, hidden, 'hidden input never keeps focus');
  // previously focused element has left the DOM: no stale focus either
  const gone = h.document.createElement('button');
  h.document.activeElement = gone;
  h.document.body.contains = el => el !== gone;
  h.window.UI.haptic();
  assert.notStrictEqual(h.document.activeElement, hidden, 'detached previous element: hidden input is blurred');
}

/* ---------- modal(): no auto-focus of the first input on coarse pointers ---------- */
{
  function modalRun(media) {
    const m = loadUI({ getItem: () => null, setItem() {} }, media);
    const dlg = m.document.createElement('div');
    m.__els.modalRoot.querySelector = s => (s === '.modal' ? dlg : null);
    const input = m.document.createElement('input');
    m.__els.modalBody.querySelector = () => input;
    m.document.activeElement = null;
    m.window.UI.modal('T', '<input>');
    return { active: m.document.activeElement, dlg, input };
  }
  const touch = modalRun({ coarse: true });
  assert.notStrictEqual(touch.active, touch.input, 'coarse pointer: keyboard must not pop over the sheet');
  assert.strictEqual(touch.active, touch.dlg, 'coarse pointer: focus still moves into the dialog');
  const mouse = modalRun({ coarse: false });
  assert.strictEqual(mouse.active, mouse.input, 'fine pointer: first field is focused');
}

// storage that throws must not break celebrateOnce
const bad = loadUI({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
assert.doesNotThrow(() => bad.window.UI.celebrateOnce('x', 'party'));

// celebrateOnce only celebrates once per id
const before = w.document.body.children.length;
UI.celebrateOnce('goal:1', 'trophy');
UI.celebrateOnce('goal:1', 'trophy');
assert.strictEqual(w.document.body.children.length - before, 1, 'celebrateOnce is once per id');

// onHold: calling it on every render must not stack listeners
const box = stubEl();
let calls = 0;
UI.onHold(box, '.row', () => calls++);
const n1 = box.listeners.length;
assert.ok(n1 > 0);
UI.onHold(box, '.row', () => calls++);
UI.onHold(box, '.row', () => calls++);
assert.strictEqual(box.listeners.length, n1, 'same selector: no extra listeners');
UI.onHold(box, '.other', () => {});
assert.strictEqual(box.listeners.length, n1, 'new selector reuses the container listeners');
assert.strictEqual(w.document.head.children.length, 1, 'one shared <style>');
// the latest fn wins, and fires exactly once per hold
let latest = 0;
UI.onHold(box, '.row', () => latest++);
const tgt = { closest: s => (s === '.row' ? tgt : null), setAttribute() {} };
const down = box.listeners.find(l => l[0] === 'pointerdown')[1];
down({ pointerType: 'touch', target: tgt, clientX: 0, clientY: 0 });
setTimeout(() => {
  assert.strictEqual(latest, 1, 'latest callback fires once');
  assert.strictEqual(calls, 0, 'replaced callbacks never fire');
  assert.strictEqual(box._suppressClick, true);
  box.listeners.filter(l => l[0] === 'pointerup').forEach(l => l[1]());
  setTimeout(() => {
    assert.strictEqual(box._suppressClick, false, 'flag clears shortly after release');
    console.log('ui helpers ok');
  }, 420);
}, 560);

/* ---------- litBlocks: any score above 0 lights a block ---------- */
assert.strictEqual(Charts.litBlocks(0, 10), 0);
assert.strictEqual(Charts.litBlocks(null, 10), 0, 'null = not started');
assert.strictEqual(Charts.litBlocks(1, 10), 1, '1% still lights one block');
assert.strictEqual(Charts.litBlocks(4, 10), 1);
assert.strictEqual(Charts.litBlocks(14, 10), 1);
assert.strictEqual(Charts.litBlocks(15, 10), 2);
assert.strictEqual(Charts.litBlocks(100, 10), 10);
assert.strictEqual(Charts.litBlocks(250, 10), 10, 'clamped');
assert.strictEqual(Charts.litBlocks(-5, 10), 0);

/* ---------- design tokens ---------- */
const LEGACY = /--(?:surface-\d|border(?:-soft)?|text-(?:primary|secondary|muted)|accent-(?:ghost|dim)|flame|freeze|series-\d|good|warning|serious|critical|r-(?:sm|md|lg|xl)|sans|mono)(?![\w-])/g;
/** sources: { name: text }. Used tokens must be defined somewhere, and no legacy name may appear. */
function tokenProblems(sources) {
  const src = Object.values(sources).join('\n');
  const defined = new Set([
    ...src.matchAll(/(--[\w-]+)\s*:/g),                              // css rules and inline style="--x:..."
    ...src.matchAll(/setProperty\(\s*['"`](--[\w-]+)/g)              // el.style.setProperty('--x', ...)
  ].map(m => m[1]));
  const used = new Set([
    ...src.matchAll(/var\(\s*(--[\w-]+)/g),
    ...src.matchAll(/(?:css|getPropertyValue)\(\s*['"`](--[\w-]+)/g)  // css('--x'), getPropertyValue('--x')
  ].map(m => m[1]));
  return {
    missing: [...used].filter(t => !defined.has(t)),
    legacy: [...new Set(src.match(LEGACY) || [])]
  };
}
{
  // proof the check bites: seeded violations are flagged, clean sources are not
  assert.deepStrictEqual(tokenProblems({ a: "const c = css('--surface-1');" }).legacy, ['--surface-1']);
  assert.deepStrictEqual(tokenProblems({ a: 'x { color: var(--text-muted) }' }).legacy, ['--text-muted']);
  assert.deepStrictEqual(tokenProblems({ a: "el.getPropertyValue('--nope')" }).missing, ['--nope']);
  assert.deepStrictEqual(tokenProblems({ a: 'x { color: var(--nope2) }' }).missing, ['--nope2']);
  const ok = tokenProblems({ a: ":root { --accent: red } x { c: var(--accent) } el.style.setProperty('--on', 1); css('--on'); style=\"--k:1\" var(--k)" });
  assert.deepStrictEqual(ok, { missing: [], legacy: [] });
  assert.deepStrictEqual(tokenProblems({ a: 'var(--border-soft) var(--r-md) var(--sans)' }).legacy.sort(), ['--border-soft', '--r-md', '--sans']);
  assert.deepStrictEqual(tokenProblems({ a: 'var(--rule) var(--g1) var(--f-mono) var(--border-x)' }).legacy, [], 'new tokens are not legacy');
}
(function () {
  const root = path.join(__dirname, '..');
  const rd = d => fs.readdirSync(path.join(root, d)).filter(f => /\.(js|css)$/.test(f)).map(f => d + '/' + f);
  const files = ['index.html', 'sw.js', ...rd('css'), ...rd('js'), ...rd('js/views')];
  const sources = {};
  files.forEach(f => { sources[f] = fs.readFileSync(path.join(root, f), 'utf8'); });
  const p = tokenProblems(sources);
  assert.deepStrictEqual(p.missing, [], 'undefined CSS tokens: ' + p.missing.join(', '));
  assert.deepStrictEqual(p.legacy, [], 'legacy tokens still present: ' + p.legacy.join(', '));
  assert.ok(!/Charts\.ring|hero-ring/.test(Object.values(sources).join('\n')), 'progress ring was retired');
  console.log('tokens ok');
})();

/* ---------- label contrast: informational labels use --g1, never the dim --g2 ---------- */
(function () {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'style.css'), 'utf8');
  // the declaration block of the rule whose selector is exactly `sel`
  const block = sel => {
    const from = css.indexOf('\n' + sel + ' {');
    assert.ok(from >= 0, 'rule found for ' + sel);
    return css.slice(css.indexOf('{', from) + 1, css.indexOf('}', from));
  };
  ['.lb', '.field > span', '.section-label', '.card-label'].forEach(sel => {
    const decl = block(sel).split(';').map(d => d.trim()).find(d => d.startsWith('color:'));
    assert.strictEqual(decl, 'color: var(--g1)', sel + ' must use --g1 (--g2 is ~2.8:1 on black)');
  });
  console.log('label contrast ok');
})();
