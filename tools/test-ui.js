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
function loadUI(sessionStorage) {
  const c = { console };
  c.window = c;
  const els = {};
  c.document = {
    documentElement: {}, head: stubEl(), body: stubEl(), activeElement: null,
    getElementById: id => (els[id] = els[id] || stubEl()),
    createElement: () => stubEl(),
    querySelector: () => null, addEventListener() {}
  };
  c.sessionStorage = sessionStorage;
  c.Store = { COLORS: [] };
  c.matchMedia = () => ({ matches: false });
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

/* ---------- design tokens: every var(--x) used anywhere must be defined ---------- */
(function () {
  const root = path.join(__dirname, '..');
  const files = ['index.html', 'css/style.css', 'js/app.js', 'js/charts.js', 'js/ui.js',
    ...fs.readdirSync(path.join(root, 'js', 'views')).map(f => 'js/views/' + f)];
  const src = files.map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const defined = new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  const used = new Set([...src.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]));
  const missing = [...used].filter(t => !defined.has(t));
  assert.deepStrictEqual(missing, [], 'undefined CSS tokens: ' + missing.join(', '));
  assert.ok(!/Charts\.ring|hero-ring/.test(src), 'progress ring was retired');
  console.log('tokens ok');
})();
