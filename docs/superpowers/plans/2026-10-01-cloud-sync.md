# Cloud Sync (Supabase) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the app state across devices through the owner's own Supabase project (email + password), keeping the app local-first and offline-capable.

**Architecture:** `localStorage` stays the working copy. A pure three-way merge (`js/merge.js`) reconciles edits made on two devices; a dependency-injected engine (`js/sync.js`) talks to Supabase Auth + PostgREST with plain `fetch` and uses an optimistic-concurrency `version` column; `app.js` adds a Settings section and a status dot. Everything network-related is injectable so it is tested against an in-memory fake server and, in a browser, against a local mock server.

**Tech Stack:** Vanilla JS (IIFE modules on `window`), Node `assert`/`vm` tests in `tools/`, Supabase Auth (GoTrue) + REST (PostgREST), Playwright MCP for browser end-to-end checks.

**Spec:** `docs/superpowers/specs/2026-10-01-cloud-sync-design.md` (read it first; it is the authority). Deliberate simplification vs the spec: the "pristine" test lives in `Merge.isPristine(data)` (pure, used by the engine) — no `Store.isPristine()` is added.

## Global Constraints

- No Supabase JS library; plain `fetch` only. No new runtime dependency, no CDN, no new asset files besides JS.
- `localStorage['winterArc.v1']` format and backup/export format unchanged. Sync keys: `winterArc.sync` (session) and `winterArc.sync.base` (`{version, data}`). **Tokens/passwords never enter exports or backups; the password is never stored.**
- `settings.theme` is per-device: excluded from the snapshot that is synced, kept locally when remote data is applied.
- The anon key + project URL live in `js/sync-config.js` as `window.SYNC_CONFIG = window.SYNC_CONFIG || { url: '', anonKey: '' }` (the `||` lets tests inject a config before the script runs). Empty config ⇒ the app behaves exactly as today and the Sync section says it is not configured.
- The service worker must never intercept cross-origin requests (Supabase). New JS files go into `sw.js` SHELL; bump `CACHE` (currently `winter-arc-v8` → `winter-arc-v9`). `tools/test-build.js` already fails if SHELL and the files disagree.
- Offline-first: with no network or sync problems the app must keep working and never lose a local edit; failures set a status, never throw to the UI.
- All server-provided strings shown in the UI (email, error text) go through `esc()`.
- Instrument look: new UI uses existing tokens/classes only (`.field .input .btn .btn-sm .btn-primary .card-label .pill`), square corners, `--g1` for informational text ≥ 11px, phone targets ≥ 44px, inputs 16px on phone, visible focus rings, no new colours (status dot: lit accent / hollow ring / `var(--warn)`).
- `npm test` must stay green at every commit (`tools/test-store.js && test-assets.js && test-ui.js && test-build.js` + the new ones added here). Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never push; never touch `main`. Work on branch `cloud-sync`.

## Review Focus

1. **Two devices that each created the default habits independently** (different random ids) connecting for the first time must not end up with duplicate habits or lose logs. → Task 1 `firstConnect` tests (name-dedupe + log remap).
2. **Transient network/server failures** (offline, 5xx, paused project, 429) must never mark data as synced, never drop the dirty state, and never lose local edits; on recovery the pending changes are pushed. → Task 3 offline/recovery tests.
3. **Token expiry and rotation** (access token expired mid-session; refresh token rotated; device offline for days; refresh rejected) must recover silently or ask to sign in again, never corrupt data. → Task 3 tests.
4. **A garbage/hostile/legacy remote row** (`{}`, wrong types, missing `habits`) must not crash or overwrite local data. → Task 3 invalid-remote test.
5. **Reset / Import while signed in**: Reset must really erase the cloud copy (not resurrect from the remote), Import is just a local change. → Task 3 `overwriteCloud` test + Task 4 Reset wiring.

---

### Task 1: Pure merge module

**Files:**
- Create: `js/merge.js`, `tools/test-merge.js`
- Modify: `package.json` (add `node tools/test-merge.js` to `test`)

**Interfaces:**
- Produces: `window.Merge = { three(base, local, remote, opts?) → state, firstConnect(local, remote) → state, equal(a, b) → boolean, isPristine(data) → boolean, isState(data) → boolean }`. All inputs are plain JSON state objects (the app state without `settings.theme`); outputs are fresh deep copies. `opts.prefer` is `'local'` (default) or `'remote'` for same-leaf conflicts.

- [ ] **Step 1: Write the failing test** `tools/test-merge.js`:

```js
/* Pure tests for js/merge.js. Run: node tools/test-merge.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ctx = { console }; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'merge.js'), 'utf8'), ctx);
const M = ctx.Merge;
const J = x => JSON.parse(JSON.stringify(x));          // detach from the vm realm for assert
let pass = 0, fail = 0;
const test = (n, f) => { try { f(); pass++; console.log('  ok   ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } };

const H = (id, name) => ({ id, name, color: '#3987e5', cadence: 'daily', target: 1, archived: false, createdAt: '2026-10-01' });
const S = o => Object.assign({ settings: { name: 'Winter Arc', arcStart: '2026-10-01', arcDays: 90, weekStart: 0 },
  freezeTokens: 9, habits: [], logs: {}, tasks: {}, mindset: {}, goals: [] }, o);

console.log('\nequal / pristine / isState');
test('equal ignores key order, distinguishes values', () => {
  assert.ok(M.equal({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }));
  assert.ok(!M.equal({ a: 1 }, { a: 2 })); assert.ok(!M.equal([1], [1, 2])); assert.ok(!M.equal({ a: 1 }, { a: 1, b: 2 }));
});
test('isPristine: no logs/tasks/goals/mindset', () => {
  assert.ok(M.isPristine(S({ habits: [H('h1', 'Gym')] })));
  assert.ok(!M.isPristine(S({ logs: { h1: { '2026-10-01': true } } })));
  assert.ok(!M.isPristine(S({ tasks: { '2026-10-01': [{ id: 't', text: 'x', done: false }] } })));
  assert.ok(!M.isPristine(S({ goals: [{ id: 'g', title: 'x' }] })));
  assert.ok(!M.isPristine(S({ mindset: { '2026-10-01': { energy: 5 } } })));
  assert.ok(M.isPristine(S({ logs: { h1: {} }, tasks: { d: [] } })));
});
test('isState: object with a habits array', () => {
  assert.ok(M.isState(S())); assert.ok(!M.isState({})); assert.ok(!M.isState(null)); assert.ok(!M.isState({ habits: 'x' }));
});

console.log('\nthree-way merge');
const base = S({ habits: [H('h1', 'Gym'), H('h2', 'Read')], logs: { h1: { '2026-10-01': true } } });
test('no change anywhere → same', () => assert.deepStrictEqual(J(M.three(base, base, base)), J(base)));
test('only local changed → local; only remote changed → remote', () => {
  const l = J(base); l.logs.h1['2026-10-02'] = true;
  assert.deepStrictEqual(J(M.three(base, l, base)), J(l));
  assert.deepStrictEqual(J(M.three(base, base, l)), J(l));
});
test('both add different logs (offline phone + laptop) → union', () => {
  const l = J(base); l.logs.h1['2026-10-02'] = true;
  const r = J(base); r.logs.h1['2026-10-03'] = true; r.logs.h2 = { '2026-10-03': 'freeze' };
  const m = J(M.three(base, l, r));
  assert.deepStrictEqual(m.logs.h1, { '2026-10-01': true, '2026-10-02': true, '2026-10-03': true });
  assert.deepStrictEqual(m.logs.h2, { '2026-10-03': 'freeze' });
});
test('same cell changed differently → local wins (default) / remote wins with prefer', () => {
  const l = J(base); l.logs.h1['2026-10-01'] = 'freeze';
  const r = J(base); r.logs.h1['2026-10-01'] = true; r.logs.h1['2026-10-04'] = true;   // r changes the day too so both differ from base
  r.logs.h1['2026-10-01'] = 'x';
  assert.strictEqual(J(M.three(base, l, r)).logs.h1['2026-10-01'], 'freeze');
  assert.strictEqual(J(M.three(base, l, r, { prefer: 'remote' })).logs.h1['2026-10-01'], 'x');
});
test('local un-ticks a day the remote did not touch → deleted', () => {
  const l = J(base); delete l.logs.h1['2026-10-01'];
  const r = J(base); r.logs.h1['2026-10-05'] = true;
  const m = J(M.three(base, l, r));
  assert.deepStrictEqual(m.logs.h1, { '2026-10-05': true });
});
test('delete vs edit: the edit wins (record-level)', () => {
  const l = J(base); l.habits = l.habits.filter(h => h.id !== 'h2');            // local deletes Read
  const r = J(base); r.habits[1].name = 'Read 10 pages';                          // remote edits Read
  const m = J(M.three(base, l, r));
  assert.deepStrictEqual(m.habits.map(h => h.name), ['Gym', 'Read 10 pages']);
});
test('delete a record the other side did not touch → deleted', () => {
  const l = J(base); l.habits = l.habits.filter(h => h.id !== 'h2');
  const r = J(base); r.logs.h1['2026-10-09'] = true;
  const m = J(M.three(base, l, r));
  assert.deepStrictEqual(m.habits.map(h => h.id), ['h1']);
});
test('habit added on both sides → both kept, remote order first', () => {
  const l = J(base); l.habits.push(H('h3', 'Cold shower'));
  const r = J(base); r.habits.push(H('h4', 'Journal'));
  assert.deepStrictEqual(J(M.three(base, l, r)).habits.map(h => h.id), ['h1', 'h2', 'h4', 'h3']);
});
test('tasks merge by id inside a day', () => {
  const b = S({ tasks: { d1: [{ id: 'a', text: 'A', done: false }] } });
  const l = J(b); l.tasks.d1[0].done = true; l.tasks.d1.push({ id: 'b', text: 'B', done: false });
  const r = J(b); r.tasks.d1.push({ id: 'c', text: 'C', done: false });
  const t = J(M.three(b, l, r)).tasks.d1;
  assert.deepStrictEqual(t.map(x => x.id).sort(), ['a', 'b', 'c']);
  assert.strictEqual(t.find(x => x.id === 'a').done, true);
});
test('mindset per day/field and goals + milestones merge', () => {
  const b = S({ mindset: { d1: { energy: 3 } }, goals: [{ id: 'g1', title: 'Run', milestones: [{ id: 'm1', text: '1k', done: false }] }] });
  const l = J(b); l.mindset.d1.focus = 7; l.goals[0].milestones[0].done = true;
  const r = J(b); r.mindset.d1.energy = 9; r.goals[0].title = 'Run 5k'; r.goals[0].milestones.push({ id: 'm2', text: '3k', done: false });
  const m = J(M.three(b, l, r));
  assert.deepStrictEqual(m.mindset.d1, { energy: 9, focus: 7 });
  assert.strictEqual(m.goals[0].title, 'Run 5k');
  assert.deepStrictEqual(m.goals[0].milestones.map(x => [x.id, x.done]), [['m1', true], ['m2', false]]);
});
test('freezeTokens merge as a delta (each device spent one → 7)', () => {
  const l = J(base); l.freezeTokens = 8; const r = J(base); r.freezeTokens = 8;
  const l2 = J(base); l2.freezeTokens = 8; const r2 = J(base); r2.freezeTokens = 8; r2.logs.h1['2026-10-02'] = true;
  assert.strictEqual(M.three(base, l, r).freezeTokens, 8);            // identical change on both sides is one change… (converged)
  assert.strictEqual(M.three(base, l2, r2).freezeTokens, 7);          // …but with other concurrent edits the delta rule applies
  const z = J(base); z.freezeTokens = 0; const zr = J(base); zr.freezeTokens = 0; zr.logs.h1.x = true;
  assert.strictEqual(M.three(S({ freezeTokens: 1 }), z, zr).freezeTokens, 0);       // never negative
});
test('idempotent and does not mutate inputs', () => {
  const l = J(base); l.logs.h1['2026-10-02'] = true; const r = J(base); r.logs.h1['2026-10-03'] = true;
  const lc = J(l), rc = J(r), bc = J(base);
  const m1 = M.three(base, l, r);
  assert.deepStrictEqual(J(M.three(base, m1, m1)), J(m1));
  assert.deepStrictEqual(J(l), lc); assert.deepStrictEqual(J(r), rc); assert.deepStrictEqual(J(base), bc);
});
test('settings merge per field (name local, arcDays remote)', () => {
  const l = J(base); l.settings.name = 'Mine'; const r = J(base); r.settings.arcDays = 120;
  const m = J(M.three(base, l, r));
  assert.strictEqual(m.settings.name, 'Mine'); assert.strictEqual(m.settings.arcDays, 120);
});

console.log('\nfirst connect (no base)');
test('same-named default habits with different ids collapse; logs are remapped', () => {
  const l = S({ habits: [H('L1', 'Gym'), H('L2', 'Read 10 pages'), H('L3', 'Sauna')],
                logs: { L1: { '2026-10-01': true }, L3: { '2026-10-02': true } } });
  const r = S({ habits: [H('R1', 'gym '), H('R2', 'Read 10 pages')], logs: { R1: { '2026-10-03': true } } });
  const m = J(M.firstConnect(l, r));
  assert.deepStrictEqual(m.habits.map(h => h.name).sort(), ['Read 10 pages', 'Sauna', 'gym '].sort());
  assert.deepStrictEqual(m.logs.R1, { '2026-10-01': true, '2026-10-03': true });
  assert.deepStrictEqual(m.logs.L3, { '2026-10-02': true });
  assert.ok(!('L1' in m.logs));
});
test('first connect: remote wins scalar conflicts, tasks union by id', () => {
  const l = S({ freezeTokens: 3, settings: { name: 'L', arcStart: '2026-10-01', arcDays: 90, weekStart: 0 }, tasks: { d: [{ id: 'x', text: 'X', done: false }] } });
  const r = S({ freezeTokens: 9, settings: { name: 'R', arcStart: '2026-10-01', arcDays: 90, weekStart: 0 }, tasks: { d: [{ id: 'y', text: 'Y', done: false }] } });
  const m = J(M.firstConnect(l, r));
  assert.strictEqual(m.freezeTokens, 9); assert.strictEqual(m.settings.name, 'R');
  assert.deepStrictEqual(m.tasks.d.map(t => t.id).sort(), ['x', 'y']);
});
test('two local habits with one remote name do not create duplicate ids', () => {
  const l = S({ habits: [H('L1', 'Gym'), H('L2', 'GYM')] }); const r = S({ habits: [H('R1', 'Gym')] });
  const ids = J(M.firstConnect(l, r)).habits.map(h => h.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('merge ok');
```

(The two-line "same cell changed differently" test above intentionally leaves `r` with value `'x'` at the contested cell; keep it exactly — it asserts `local` wins by default and `remote` with `prefer`.)

- [ ] **Step 2: Run it** — `node tools/test-merge.js` → FAIL (`js/merge.js` missing).
- [ ] **Step 3: Implement** `js/merge.js` exactly:

```js
/* ============================================================
   merge.js — pure three-way merge for Winter Arc state.
   No DOM, no network. Works on plain JSON; returns fresh copies.
   ============================================================ */
(function (root) {
  'use strict';

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isRecs = a => Array.isArray(a) && a.every(x => isObj(x) && typeof x.id === 'string');
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
    if (isObj(a)) {
      if (!isObj(b)) return false;
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every(k => has(b, k) && equal(a[k], b[k]));
    }
    return false;
  }

  /** b = base value, l = local, r = remote; undefined means "absent" (deleted). */
  function mergeValue(b, l, r, prefer) {
    if (equal(l, b)) return r;                       // local untouched → remote (incl. its deletion)
    if (equal(r, b)) return l;                       // remote untouched → local
    if (equal(l, r)) return l;                       // both made the same change
    if (l === undefined) return r;                   // local deleted, remote edited → the edit wins
    if (r === undefined) return l;                   // remote deleted, local edited → the edit wins
    if (isObj(l) && isObj(r)) return mergeObjects(isObj(b) ? b : {}, l, r, prefer);
    if (isRecs(l) && isRecs(r)) return mergeRecords(isRecs(b) ? b : [], l, r, prefer);
    return prefer === 'remote' ? r : l;              // same leaf changed differently
  }

  function mergeObjects(b, l, r, prefer) {
    const out = {};
    new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b)]).forEach(k => {
      const v = mergeValue(b[k], l[k], r[k], prefer);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  /** arrays of {id, …}: merged per id; order = remote's order, then ids only local has */
  function mergeRecords(b, l, r, prefer) {
    const by = arr => new Map(arr.map(x => [x.id, x]));
    const bm = by(b), lm = by(l), rm = by(r);
    const ids = [...new Set([...r.map(x => x.id), ...l.map(x => x.id), ...b.map(x => x.id)])];
    const out = [];
    ids.forEach(id => {
      const v = mergeValue(bm.get(id), lm.get(id), rm.get(id), prefer);
      if (v !== undefined) out.push(v);
    });
    return out;
  }

  function three(base, local, remote, opts) {
    const o = opts || {};
    const b = base || {};
    if (equal(local, remote)) return clone(local);   // already converged: nothing to merge (and no double-counted deltas)
    const out = clone(mergeValue(b, local, remote, o.prefer === 'remote' ? 'remote' : 'local'));
    // freeze tokens are a counter: apply both sides' deltas
    if ([b.freezeTokens, local.freezeTokens, remote.freezeTokens].every(Number.isFinite)) {
      out.freezeTokens = Math.max(0, b.freezeTokens + (local.freezeTokens - b.freezeTokens) + (remote.freezeTokens - b.freezeTokens));
    }
    return out;
  }

  const norm = s => String(s == null ? '' : s).trim().toLowerCase();

  /** No shared history (first sign-in on a device that already has data and the cloud has data):
      habits created independently on two devices have different random ids, so habits with the
      same name are treated as one (local logs are remapped); other conflicts → remote wins. */
  function firstConnect(local, remote) {
    const l = clone(local);
    const byName = new Map((remote.habits || []).map(h => [norm(h.name), h.id]));
    const idMap = {};
    (l.habits || []).forEach(h => {
      const rid = byName.get(norm(h.name));
      if (rid && rid !== h.id) { idMap[h.id] = rid; h.id = rid; }
    });
    const seen = new Set();
    l.habits = (l.habits || []).filter(h => (seen.has(h.id) ? false : (seen.add(h.id), true)));
    if (l.logs) {
      Object.keys(idMap).forEach(oldId => {
        const rid = idMap[oldId];
        l.logs[rid] = Object.assign({}, l.logs[oldId], l.logs[rid] || {});
        delete l.logs[oldId];
      });
    }
    return three({}, l, remote, { prefer: 'remote' });
  }

  const empty = o => !o || Object.keys(o).length === 0;
  /** a fresh install: nothing logged, no tasks, goals or mindset entries */
  function isPristine(d) {
    return empty(d && d.mindset) &&
      (!d || !d.goals || d.goals.length === 0) &&
      (!d || !d.logs || Object.values(d.logs).every(empty)) &&
      (!d || !d.tasks || Object.values(d.tasks).every(a => !a || a.length === 0));
  }

  const isState = d => isObj(d) && Array.isArray(d.habits);

  root.Merge = { three, firstConnect, equal, isPristine, isState };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run** `node tools/test-merge.js` → all pass, prints `merge ok`. If the first-connect `firstConnect` tests expose an ordering/dup problem, fix `merge.js` (not the tests) unless a test contradicts the spec.
- [ ] **Step 5:** add `&& node tools/test-merge.js` to the `test` script in `package.json`; run `npm test` → green.
- [ ] **Step 6: Commit** `git add js/merge.js tools/test-merge.js package.json && git commit -m "Add pure three-way merge module with tests"`.

---

### Task 2: Store hooks for sync

**Files:**
- Modify: `js/store.js` (persistence block + exported object)
- Test: `tools/test-store.js`

**Interfaces:**
- Produces on `window.Store`: `snapshot()` → deep copy of state **without `settings.theme`**; `applySynced(snap)` → replaces state with `migrate(copy of snap)`, keeps the local `settings.theme`, persists, calls subscribers (re-render) but **not** change listeners; `onLocalChange(fn)` → `fn()` runs after every `commit()`, `importJSON()` and `reset()` (not after `applySynced`).

- [ ] **Step 1: Write failing tests** (append to `tools/test-store.js` before the summary line; reuse its `freshStore`/`test` helpers; remember `assert.deepStrictEqual` fails across the vm realm — compare via `JSON.stringify`/`Array.from`):

```js
console.log('\nsync hooks');
test('snapshot drops settings.theme and is a deep copy', () => {
  const c = freshStore(); const s = c.Store.snapshot();
  assert.ok(!('theme' in s.settings));
  s.habits[0].name = 'changed';
  assert.notStrictEqual(c.Store.state.habits[0].name, 'changed');
});
test('applySynced keeps the local theme, migrates, persists and re-renders without marking a local change', () => {
  const c = freshStore();
  c.Store.commit(s => { s.settings.theme = 'light'; });
  let changes = 0, renders = 0;
  c.Store.onLocalChange(() => changes++); c.Store.subscribe(() => renders++);
  const snap = c.Store.snapshot(); snap.habits[0].color = 'url(x)'; snap.habits[0].name = 'Synced';
  c.Store.applySynced(snap);
  assert.strictEqual(c.Store.state.settings.theme, 'light');
  assert.strictEqual(c.Store.state.habits[0].name, 'Synced');
  assert.notStrictEqual(c.Store.state.habits[0].color, 'url(x)');       // migrate ran
  assert.strictEqual(changes, 0); assert.strictEqual(renders, 1);
});
test('onLocalChange fires for commit, importJSON and reset', () => {
  const c = freshStore(); let n = 0; c.Store.onLocalChange(() => n++);
  c.Store.commit(s => { s.freezeTokens = 5; });
  c.Store.importJSON(c.Store.exportJSON());
  c.Store.reset();
  assert.strictEqual(n, 3);
});
```
- [ ] **Step 2: Run** `node tools/test-store.js` → the 3 new tests FAIL.
- [ ] **Step 3: Implement** in `js/store.js`: after `function emit()` add

```js
  const changeListeners = [];
  /** local edits only (commit/import/reset) — not remote data applied by sync */
  function markChanged() { changeListeners.forEach(fn => fn()); }
```
call `markChanged()` at the end of `commit` (after `emit()`), `importJSON` (after `persist(); emit();`) and `reset` (after `persist(); emit();`). Add:

```js
  /** the state as it is synced: a deep copy, without the per-device theme */
  function snapshot() {
    const c = JSON.parse(JSON.stringify(state));
    delete c.settings.theme;
    return c;
  }
  /** replace the state with data that came from the cloud (theme stays this device's own) */
  function applySynced(snap) {
    const theme = state.settings.theme;
    const next = migrate(JSON.parse(JSON.stringify(snap)));
    next.settings.theme = theme;
    state = next;
    persist(); emit();
  }
```
and export `snapshot, applySynced, onLocalChange(fn) { changeListeners.push(fn); }` on `window.Store`.
- [ ] **Step 4: Run** `npm test` → green (store tests count increases by 3). No other store behaviour changes.
- [ ] **Step 5: Commit** `git add js/store.js tools/test-store.js && git commit -m "Store: snapshot/applySynced/onLocalChange hooks for sync"`.

---

### Task 3: Sync engine

**Files:**
- Create: `js/sync.js`, `tools/test-sync.js`
- Modify: `package.json` (add `node tools/test-sync.js` to `test`)

**Interfaces:**
- Consumes: `Merge` (Task 1), `Store.snapshot/applySynced/onLocalChange` (Task 2).
- Produces `window.SyncEngine = { create(deps) }` where `deps = { fetch, storage, store, merge, config:{url,anonKey}, now?, setTimeout?, clearTimeout?, askFirstConnect?: () => Promise<'merge'|'cloud'|'device'|null> }` and `create` returns:
  `status() → {state:'unconfigured'|'signedOut'|'idle'|'syncing'|'pending'|'attention', message:string, lastSyncedAt:number|null, email:string|null}`,
  `onStatus(fn)` (called with the status object on every change), `isConfigured()`, `isSignedIn()`,
  `signIn(email, password) → Promise` (rejects with an `Error` whose `.message` is user-friendly: "Wrong email or password" / "Can't reach Supabase" / …; on success it also runs a sync), `signOut() → Promise`,
  `syncNow() → Promise<'skipped'|'clean'|'uploaded'|'downloaded'|'pushed'|'pulled'|'merged'|'error'>` (single-flight; calls arriving mid-run cause exactly one more run),
  `notifyLocalChange()` (debounced 3000 ms `syncNow`), `overwriteCloud() → Promise<boolean>` (used after Reset: pushes local over whatever is in the cloud and sets the base).
  Storage keys: `winterArc.sync` = `{email,userId,accessToken,refreshToken,expiresAt}`; `winterArc.sync.base` = `{version,data}`.

- [ ] **Step 1: Write the failing test** `tools/test-sync.js`. First the harness (use it as-is), then the scenarios below it:

```js
/* Sync engine against an in-memory fake Supabase. Run: node tools/test-sync.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const SRC = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BASE = 'https://fake.supabase.test';
const J = x => JSON.parse(JSON.stringify(x));

function fakeSupabase() {
  const S = { users: { 'me@x.com': { id: 'u1', password: 'pw' } }, tokens: {}, refresh: {}, rows: {}, calls: [],
              offline: false, status: 0, n: 0, ttl: 3600, beforePatch: null };
  const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => { if (json === undefined) throw new Error('empty'); return json; } });
  const mint = uid => { const a = 'at' + (++S.n), r = 'rt' + S.n; S.tokens[a] = uid; S.refresh[r] = uid;
    return { access_token: a, refresh_token: r, expires_in: S.ttl, user: { id: uid } }; };
  async function fetchImpl(url, init) {
    const u = new URL(url); S.calls.push(init.method + ' ' + u.pathname + (u.search || ''));
    if (S.offline) throw new TypeError('Failed to fetch');
    if (S.status) return respond(S.status, { message: 'boom' });
    const body = init.body ? JSON.parse(init.body) : null;
    const tok = ((init.headers || {}).Authorization || '').replace('Bearer ', '');
    if (u.pathname === '/auth/v1/token') {
      if (u.searchParams.get('grant_type') === 'password') {
        const us = S.users[body.email]; if (!us || us.password !== body.password) return respond(400, { error: 'invalid_grant' });
        return respond(200, mint(us.id));
      }
      const uid = S.refresh[body.refresh_token]; if (!uid) return respond(400, { error: 'invalid_grant' });
      delete S.refresh[body.refresh_token]; return respond(200, mint(uid));          // rotation
    }
    if (u.pathname === '/auth/v1/logout') return respond(204);
    if (u.pathname === '/rest/v1/user_state') {
      const uid = S.tokens[tok]; if (!uid) return respond(401, { message: 'JWT expired' });
      const want = k => (u.searchParams.get(k) || '').replace(/^eq\./, '');
      if (init.method === 'GET') { const r = S.rows[uid]; return respond(200, r ? [{ data: r.data, version: r.version }] : []); }
      if (init.method === 'POST') { if (S.rows[uid]) return respond(409, { code: '23505' }); S.rows[uid] = { data: body.data, version: body.version }; return respond(201, [body]); }
      if (init.method === 'PATCH') {
        if (S.beforePatch) { const f = S.beforePatch; S.beforePatch = null; f(uid); }
        const r = S.rows[uid]; if (!r || String(r.version) !== want('version')) return respond(200, []);
        S.rows[uid] = { data: body.data, version: body.version }; return respond(200, [{ data: body.data, version: body.version }]);
      }
    }
    return respond(404, { message: 'nope' });
  }
  return { S, fetchImpl };
}

/** one device = its own vm realm with its own Store + localStorage + engine */
function device(server, { ask } = {}) {
  const mem = {};
  const ctx = { console, localStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
  ctx.window = ctx; vm.createContext(ctx);
  ['js/store.js', 'js/merge.js', 'js/sync.js'].forEach(f => vm.runInContext(SRC(f), ctx));
  const timers = []; const clock = { t: 1_000_000 };
  const sync = ctx.SyncEngine.create({
    fetch: server.fetchImpl, storage: ctx.localStorage, store: ctx.Store, merge: ctx.Merge,
    config: { url: BASE, anonKey: 'anon' }, now: () => clock.t,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].f = null; },
    askFirstConnect: async () => (ask ? ask() : null)
  });
  ctx.Store.onLocalChange(sync.notifyLocalChange);
  const tick = async () => { const t = timers.filter(x => x.f); timers.length = 0; for (const x of t) await x.f(); };
  return { ctx, store: ctx.Store, sync, mem, clock, timers, tick };
}
const tick = (dev, habit, day, v = true) => dev.store.commit(s => { (s.logs[habit] = s.logs[habit] || {})[day] = v; });
const habitId = dev => dev.store.state.habits[0].id;

let pass = 0, fail = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);
```

Scenarios to implement as `test(...)` bodies (async, each with a fresh `fakeSupabase()`), then run them sequentially and print like the other tools (`  ok   name` / `  FAIL name` + message; `N passed, M failed`; `sync ok`; exit 1 on failure):

1. **unconfigured**: engine with `config:{url:'',anonKey:''}` → `status().state === 'unconfigured'`, `syncNow()` resolves `'skipped'`, no fetch calls.
2. **wrong password** → `signIn('me@x.com','nope')` rejects with message `Wrong email or password`; `mem['winterArc.sync']` absent; status `signedOut`.
3. **sign in, empty cloud → uploads**: ticks a day first (`tick`), then `signIn` → row exists with `version === 1` and `data` equal (via `Merge.equal`) to `store.snapshot()`; base saved; status `idle`.
4. **fresh device, existing cloud → downloads**: device A signs in and ticks+syncs; device B (pristine) signs in → B's `store.snapshot()` equals A's; B never called `ask`.
5. **both have data → asks**: A and B both have logs; B's `ask` returns `'merge'` → B has the union, the 7 default habits are NOT duplicated (names unique), cloud version incremented; with `'cloud'` → B equals cloud; with `'device'` → cloud equals B; with `null` → `status().state === 'attention'`, B's local untouched, cloud untouched, `syncNow()` afterwards asks again.
6. **push then clean**: after sign-in, tick a day, `syncNow()` → cloud version +1 and `'pushed'`; `S.calls` cleared, `syncNow()` again → `'clean'` and **no PATCH/POST call** (only the GET).
7. **two devices converge**: A and B signed in & synced; A ticks day1, B ticks day2 (no sync in between), A `syncNow()`, B `syncNow()`, A `syncNow()` → both snapshots equal and contain both days.
8. **CAS conflict retry**: set `S.beforePatch = uid => { /* bump the server row as if another device pushed */ S.rows[uid] = { data: <row.data plus a log on another day>, version: S.rows[uid].version + 1 }; }` then A `syncNow()` after a local tick → resolves `'merged'` or `'pushed'`, final cloud contains both edits, and A's local contains both.
9. **offline and recovery**: sign in; set `S.offline = true`; tick; `syncNow()` → `'error'`, `status().state === 'pending'`, base unchanged, local keeps the tick; `S.offline = false; syncNow()` → cloud now has the tick. Also `S.status = 503` → state `pending`; `S.status = 429` → `pending`.
10. **expired access token → silent refresh with rotation**: sign in & sync; `delete S.tokens[<current access token>]` (use `Object.keys(S.tokens)`); tick; `syncNow()` → succeeds, the stored refresh token changed, old refresh token no longer valid.
11. **refresh rejected → attention**: sign in; `S.refresh = {}`; `S.tokens = {}`; tick; `syncNow()` → `status().state === 'attention'` with message `Sign in again`; local tick still there; session `accessToken` gone from `mem['winterArc.sync']` (email kept).
12. **invalid remote row**: sign in on A (cloud row created), then `S.rows.u1.data = {}`; A ticks, `syncNow()` → `attention`, message mentions the cloud data; local state untouched; **cloud row still `{}`** (not overwritten).
13. **overwriteCloud after reset**: A and B synced with a log; A `store.reset()` then `await sync.overwriteCloud()` → cloud data equals A's fresh snapshot (no logs); B `syncNow()` → B's logs gone as well (delete propagates, nothing resurrects).
14. **debounce + single-flight**: three `tick` commits → `timers` holds one live timer after clearing, `await dev.tick()` → exactly one run (count GET `/rest/v1/user_state` calls); two concurrent `syncNow()` calls produce one run plus at most one follow-up.
15. **theme not synced**: A `commit(s => s.settings.theme='light')` and syncs; B's theme stays `'dark'` after pulling; snapshot never contains `theme`.
16. **sign out**: `signOut()` → `mem['winterArc.sync.base']` absent, `accessToken` absent, status `signedOut`, local data intact; signing in again goes through first-connect (calls `ask` when both sides have data).

- [ ] **Step 2: Run** `node tools/test-sync.js` → FAIL (`js/sync.js` missing).
- [ ] **Step 3: Implement** `js/sync.js`:

```js
/* ============================================================
   sync.js — Supabase sync engine (plain fetch, no library).
   Every external thing (fetch, storage, store, merge, timers) is injected so
   tools/test-sync.js can drive it against a fake server. See the cloud-sync spec.
   ============================================================ */
(function (root) {
  'use strict';

  const SESSION_KEY = 'winterArc.sync';
  const BASE_KEY = 'winterArc.sync.base';
  const REFRESH_MARGIN_MS = 60000;
  const DEBOUNCE_MS = 3000;
  const MAX_ATTEMPTS = 4;

  class NetError extends Error {}
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  /** the user has to do something (sign in again, pick a connect option, fix setup) */
  class AttentionError extends Error {}

  function create(deps) {
    const fx = deps.fetch, storage = deps.storage, store = deps.store, merge = deps.merge;
    const config = deps.config || {};
    const now = deps.now || Date.now;
    const setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout;
    const listeners = [];
    let running = null, again = false, timer = null;

    const configured = () => !!(config.url && config.anonKey);
    const readJSON = k => { try { const v = storage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
    const writeJSON = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch (e) { /* blocked/full: this run still works */ } };
    const drop = k => { try { storage.removeItem(k); } catch (e) { /* ignore */ } };
    const hasSession = () => { const s = readJSON(SESSION_KEY); return !!(s && s.accessToken); };

    let st = { state: 'unconfigured', message: 'Not configured', lastSyncedAt: null, email: null };
    function initialStatus() {
      if (!configured()) return { state: 'unconfigured', message: 'Not configured', lastSyncedAt: null, email: null };
      const s = readJSON(SESSION_KEY);
      if (s && s.accessToken) return { state: 'idle', message: 'Not synced yet', lastSyncedAt: null, email: s.email || null };
      return { state: 'signedOut', message: s && s.email ? 'Sign in again' : 'Signed out', lastSyncedAt: null, email: (s && s.email) || null };
    }
    st = initialStatus();
    function setStatus(patch) {
      st = Object.assign({}, st, patch);
      listeners.slice().forEach(fn => { try { fn(st); } catch (e) { /* a bad listener must not break sync */ } });
    }

    /* ---------- http ---------- */
    async function http(method, path, o) {
      const opt = o || {};
      let res;
      try {
        res = await fx(config.url.replace(/\/+$/, '') + path, {
          method,
          headers: Object.assign({ apikey: config.anonKey, 'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (opt.token || config.anonKey) }, opt.prefer ? { Prefer: opt.prefer } : {}),
          body: opt.body === undefined ? undefined : JSON.stringify(opt.body)
        });
      } catch (e) { throw new NetError("Can't reach Supabase — changes are saved on this device"); }
      let json = null;
      try { json = await res.json(); } catch (e) { /* empty body */ }
      return { status: res.status, ok: res.ok, json };
    }
    const httpErr = r => new HttpError(r.status, (r.json && (r.json.message || r.json.msg || r.json.error_description)) || ('Request failed (' + r.status + ')'));

    /* ---------- session ---------- */
    function saveSession(j, email) {
      const prev = readJSON(SESSION_KEY) || {};
      const s = { email: email || prev.email || null, userId: (j.user && j.user.id) || prev.userId,
                  accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: now() + (j.expires_in || 3600) * 1000 };
      writeJSON(SESSION_KEY, s);
      return s;
    }
    function dropTokens() { const s = readJSON(SESSION_KEY) || {}; writeJSON(SESSION_KEY, { email: s.email || null }); }

    async function refresh(s) {
      const r = await http('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } });
      if (r.status >= 500 || r.status === 429) throw httpErr(r);
      if (!r.ok) { dropTokens(); throw new AttentionError('Sign in again'); }
      return saveSession(r.json, s.email);
    }
    async function ensureSession() {
      let s = readJSON(SESSION_KEY);
      if (!s || !s.accessToken) throw new AttentionError(s && s.email ? 'Sign in again' : 'Signed out');
      if (s.expiresAt - now() < REFRESH_MARGIN_MS) s = await refresh(s);
      return s;
    }
    /** an authenticated request; one transparent refresh on 401 */
    async function api(method, path, o) {
      let s = await ensureSession();
      let r = await http(method, path, Object.assign({ token: s.accessToken }, o));
      if (r.status === 401) { s = await refresh(s); r = await http(method, path, Object.assign({ token: s.accessToken }, o)); }
      return r;
    }

    /* ---------- the one row ---------- */
    const enc = encodeURIComponent;
    async function getRow(s) {
      const r = await api('GET', '/rest/v1/user_state?select=data,version&user_id=eq.' + enc(s.userId));
      if (!r.ok) throw httpErr(r);
      return Array.isArray(r.json) && r.json[0] ? r.json[0] : null;
    }
    async function insertRow(s, data) {
      const r = await api('POST', '/rest/v1/user_state', { body: { user_id: s.userId, data, version: 1 }, prefer: 'return=representation' });
      if (r.status === 409) return false;
      if (!r.ok) throw httpErr(r);
      return true;
    }
    /** compare-and-set: true only if the row still had `fromVersion` */
    async function pushCAS(s, data, fromVersion) {
      const r = await api('PATCH', '/rest/v1/user_state?user_id=eq.' + enc(s.userId) + '&version=eq.' + fromVersion,
        { body: { data, version: fromVersion + 1, updated_at: new Date(now()).toISOString() }, prefer: 'return=representation' });
      if (!r.ok) throw httpErr(r);
      return Array.isArray(r.json) && r.json.length === 1;
    }
    const saveBase = (version, data) => writeJSON(BASE_KEY, { version, data });

    /* ---------- one sync pass ---------- */
    async function run() {
      const s = await ensureSession();
      let chosen = null;                                   // the first-connect answer survives a lost race
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const row = await getRow(s);
        const local = store.snapshot();
        if (!row) {
          if (await insertRow(s, local)) { saveBase(1, local); return 'uploaded'; }
          continue;
        }
        if (!merge.isState(row.data)) throw new AttentionError('The cloud data looks unreadable — nothing was changed');
        const base = readJSON(BASE_KEY);
        if (!base) {
          if (merge.isPristine(local)) { store.applySynced(row.data); saveBase(row.version, store.snapshot()); return 'downloaded'; }
          if (merge.isPristine(row.data)) {
            if (await pushCAS(s, local, row.version)) { saveBase(row.version + 1, local); return 'uploaded'; }
            continue;
          }
          if (!chosen) chosen = deps.askFirstConnect ? await deps.askFirstConnect() : null;
          if (!chosen) throw new AttentionError('Choose how to connect this device — tap Sync now');
          if (chosen === 'cloud') { store.applySynced(row.data); saveBase(row.version, store.snapshot()); return 'downloaded'; }
          if (chosen === 'device') {
            if (await pushCAS(s, local, row.version)) { saveBase(row.version + 1, local); return 'uploaded'; }
            continue;
          }
          store.applySynced(merge.firstConnect(local, row.data));        // 'merge'
          const data = store.snapshot();
          if (await pushCAS(s, data, row.version)) { saveBase(row.version + 1, data); return 'merged'; }
          continue;
        }
        if (row.version === base.version) {
          if (merge.equal(local, base.data)) return 'clean';
          if (await pushCAS(s, local, row.version)) { saveBase(row.version + 1, local); return 'pushed'; }
          continue;
        }
        const merged = merge.three(base.data, local, row.data);
        let data = merged;
        if (!merge.equal(merged, local)) { store.applySynced(merged); data = store.snapshot(); }
        if (merge.equal(data, row.data)) { saveBase(row.version, data); return 'pulled'; }
        if (await pushCAS(s, data, row.version)) { saveBase(row.version + 1, data); return 'merged'; }
      }
      throw new HttpError(409, 'Busy — will retry');
    }

    function report(e) {
      if (e instanceof NetError) return setStatus({ state: 'pending', message: e.message });
      if (e instanceof AttentionError) return setStatus({ state: 'attention', message: e.message });
      if (e instanceof HttpError && (e.status >= 500 || e.status === 429 || e.status === 409))
        return setStatus({ state: 'pending', message: 'Supabase is busy — will retry (' + e.status + ')' });
      if (e instanceof HttpError) return setStatus({ state: 'attention', message: 'Setup problem: ' + e.message });
      return setStatus({ state: 'attention', message: (e && e.message) || 'Sync failed' });
    }

    function syncNow() {
      if (!configured() || !hasSession()) return Promise.resolve('skipped');
      if (running) { again = true; return running; }
      running = (async () => {
        let out = 'clean';
        try {
          do {
            again = false;
            setStatus({ state: 'syncing', message: 'Syncing…' });
            out = await run();
            setStatus({ state: 'idle', message: 'Synced', lastSyncedAt: now(), email: (readJSON(SESSION_KEY) || {}).email || st.email });
          } while (again);
          return out;
        } catch (e) { report(e); return 'error'; }
        finally { running = null; }
      })();
      return running;
    }

    function notifyLocalChange() {
      if (!configured() || !hasSession()) return;
      if (timer) clearT(timer);
      timer = setT(() => { timer = null; syncNow(); }, DEBOUNCE_MS);
    }

    async function signIn(email, password) {
      if (!configured()) throw new Error('Sync is not configured yet');
      const r = await http('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
      if (r.status === 400 || r.status === 401) throw new Error('Wrong email or password');
      if (!r.ok) throw httpErr(r);
      saveSession(r.json, email);
      setStatus({ state: 'idle', message: 'Signed in', email });
      return syncNow();
    }

    async function signOut() {
      const s = readJSON(SESSION_KEY);
      if (s && s.accessToken && configured()) { try { await http('POST', '/auth/v1/logout', { token: s.accessToken }); } catch (e) { /* offline: still sign out locally */ } }
      drop(SESSION_KEY); drop(BASE_KEY);
      setStatus({ state: configured() ? 'signedOut' : 'unconfigured', message: 'Signed out', email: null, lastSyncedAt: null });
    }

    /** used after Reset: make the cloud copy equal this device, whatever the cloud holds */
    async function overwriteCloud() {
      if (!configured() || !hasSession()) return false;
      if (running) await running;
      try {
        const s = await ensureSession();
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          const row = await getRow(s);
          const local = store.snapshot();
          if (!row) { if (await insertRow(s, local)) { saveBase(1, local); setStatus({ state: 'idle', message: 'Synced', lastSyncedAt: now() }); return true; } continue; }
          if (await pushCAS(s, local, row.version)) { saveBase(row.version + 1, local); setStatus({ state: 'idle', message: 'Synced', lastSyncedAt: now() }); return true; }
        }
        throw new HttpError(409, 'Busy — will retry');
      } catch (e) { report(e); return false; }
    }

    return { status: () => st, onStatus: fn => listeners.push(fn), isConfigured: configured, isSignedIn: hasSession,
             signIn, signOut, syncNow, notifyLocalChange, overwriteCloud };
  }

  root.SyncEngine = { create };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run** `node tools/test-sync.js`; fix `js/sync.js` (not the tests) until all 16 scenarios pass. Where the test and the spec disagree, the spec wins — raise it in the report instead of bending the code.
- [ ] **Step 5:** add `&& node tools/test-sync.js` to the `test` script; run `npm test` → green.
- [ ] **Step 6: Commit** `git add js/sync.js tools/test-sync.js package.json && git commit -m "Add Supabase sync engine with fake-server tests"`.

---

### Task 4: Wiring, UI, config, offline shell, docs

**Files:**
- Create: `js/sync-config.js`, `supabase/schema.sql`
- Modify: `index.html`, `js/app.js`, `css/style.css`, `sw.js`, `tools/test-build.js`, `README.md`

**Interfaces:**
- Consumes: `SyncEngine.create`, `Store.onLocalChange`, `Merge`, `UI.modal/close/confirm/toast`, `esc`.
- Produces: `window.Sync` (the engine instance) used by `app.js`; `#syncDot` element inside `#settingsBtn`.

- [ ] **Step 1: `js/sync-config.js`**:

```js
/* Your Supabase project (see README → Cloud sync). Both values are PUBLIC by design — the anon
   key is safe in a web page because row-level security limits every request to the signed-in
   user's own row. NEVER put the service_role key here. Leave empty to run without sync. */
window.SYNC_CONFIG = window.SYNC_CONFIG || { url: '', anonKey: '' };
```
- [ ] **Step 2: `supabase/schema.sql`** = the SQL block from the spec's Data model section verbatim, preceded by a comment header with the 6 owner setup steps from the spec ("Owner setup").
- [ ] **Step 3: `index.html`**: script order → `js/store.js`, `js/merge.js`, `js/sync-config.js`, `js/sync.js`, `js/charts.js`, `js/ui.js`, views…, `js/app.js`. Add `<span class="sync-dot" id="syncDot" hidden aria-hidden="true"></span>` as the first child inside the `#settingsBtn` button (before the `<svg>`).
- [ ] **Step 4: `sw.js`**: add `'js/merge.js'`, `'js/sync-config.js'`, `'js/sync.js'` to SHELL; bump `CACHE` to `winter-arc-v9`; at the very top of the `fetch` listener add `if (new URL(e.request.url).origin !== self.location.origin) return;  // never touch Supabase calls`. `tools/test-build.js`: add `assert.ok(/new URL\(e\.request\.url\)\.origin\s*!==\s*self\.location\.origin/.test(sw), 'sw must not intercept cross-origin requests');` and assert the three new files are in SHELL (the existing SHELL-vs-disk check already covers disk).
- [ ] **Step 5: `js/app.js` — refactor and wire.**
  (a) Turn `document.getElementById('settingsBtn').onclick = () => {` into `function openSettings() {` … `}` plus `document.getElementById('settingsBtn').onclick = openSettings;` (no other behaviour change).
  (b) Create the engine after `Store.subscribe(render)`:

```js
  /* ---------------- cloud sync ---------------- */
  const sync = SyncEngine.create({
    fetch: (...a) => window.fetch(...a), storage: localStorage, store: Store, merge: Merge,
    config: window.SYNC_CONFIG || {}, askFirstConnect
  });
  window.Sync = sync;
  Store.onLocalChange(sync.notifyLocalChange);
  const dot = document.getElementById('syncDot');
  const DOT_LABEL = { idle: 'Synced', syncing: 'Syncing', pending: 'Waiting to sync', attention: 'Sync needs attention' };
  function paintDot(s) {
    const show = sync.isConfigured() && sync.isSignedIn() && s.state !== 'signedOut' && s.state !== 'unconfigured';
    dot.hidden = !show;
    dot.className = 'sync-dot is-' + (s.state === 'syncing' ? 'idle' : s.state);
    const btn = document.getElementById('settingsBtn');
    btn.setAttribute('aria-label', show ? 'Settings — ' + (DOT_LABEL[s.state] || '') : 'Settings');
  }
  sync.onStatus(paintDot); paintDot(sync.status());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.syncNow(); });
  window.addEventListener('online', () => sync.syncNow());
  setInterval(() => { if (!document.hidden) sync.syncNow(); }, 60000);
  sync.syncNow();

  function askFirstConnect() {
    return new Promise(resolve => {
      let done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
      UI.modal('Connect this device', `
        <p class="muted" style="margin:0 0 14px;line-height:1.6">Both this device and your cloud copy already have data. How should they be combined?</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button class="btn btn-primary" data-c="merge">Merge both (recommended)</button>
          <button class="btn" data-c="cloud">Use the cloud copy (replace this device)</button>
          <button class="btn btn-danger" data-c="device">Use this device (overwrite the cloud)</button>
        </div>`, m => {
        m.querySelectorAll('[data-c]').forEach(b => { b.onclick = () => { fin(b.dataset.c); UI.close(); }; });
      }, () => fin(null));
    });
  }
```
  (c) In `openSettings` add a **Sync** block between the "Current arc" paragraph and "Your data". Render by status (all dynamic strings via `esc()`):

```js
  function syncSectionHTML() {
    const s = sync.status();
    if (!sync.isConfigured()) return `<div class="card-label" style="margin-bottom:8px">Cloud sync</div>
      <p class="muted" style="font-size:12px;margin:0 0 16px;line-height:1.55">Not set up. Add your Supabase project in <b>js/sync-config.js</b> (see README → Cloud sync) to use this app on several devices.</p>`;
    if (!sync.isSignedIn()) return `<div class="card-label" style="margin-bottom:8px">Cloud sync</div>
      <label class="field"><span>Email</span><input class="input" id="syEmail" type="email" autocomplete="username" value="${esc(s.email || '')}"></label>
      <label class="field"><span>Password</span><input class="input" id="syPass" type="password" autocomplete="current-password"></label>
      <div class="row" style="gap:8px;margin-bottom:6px"><button class="btn btn-sm btn-primary" id="syIn">Sign in</button></div>
      <p class="muted" id="syLine" role="status" style="font-size:12px;margin:0 0 16px">${esc(s.state === 'attention' || s.message === 'Sign in again' ? s.message : '')}</p>`;
    return `<div class="card-label" style="margin-bottom:8px">Cloud sync</div>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Signed in as <b>${esc(s.email || '')}</b></p>
      <p class="muted" id="syLine" role="status" style="font-size:12px;margin:0 0 10px">${esc(statusText(s))}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:16px"><button class="btn btn-sm" id="syNow">Sync now</button><button class="btn btn-sm" id="syOut">Sign out</button></div>`;
  }
  function statusText(s) {
    if (s.state === 'syncing') return 'Syncing…';
    if (s.state === 'idle') return s.lastSyncedAt ? 'Synced ' + timeAgo(s.lastSyncedAt) : s.message;
    return s.message;
  }
  function timeAgo(t) { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; }
```
  Wiring inside `openSettings`'s onMount: `#syIn` → read email/password, disable the button, `sync.signIn(email, pass).then(() => { UI.close(); openSettings(); }).catch(e => { line.textContent = e.message; button re-enabled })` (the engine's own first-connect prompt may replace the modal; that is fine); `#syNow` → `sync.syncNow()`; `#syOut` → `sync.signOut().then(() => { UI.close(); openSettings(); })`; a status listener that updates `#syLine` while the modal is open: `sync.onStatus(s => { const el = document.getElementById('syLine'); if (el) el.textContent = statusText(s); })` registered once at boot (not per open) — it only touches the DOM when `#syLine` exists.
  (d) **Reset while signed in**: change the confirm text to `sync.isSignedIn() ? 'Erase every habit, task, goal and logged day on this device AND in your cloud copy? Your other devices will be erased on their next sync.' : 'Erase every habit, task, goal and logged day on this device?'`; in the confirm callback after `Store.reset()` do `if (sync.isSignedIn()) sync.overwriteCloud();`.
  (e) The existing "Everything is saved in this browser only…" sentence becomes: when signed in → "Saved on this device and synced to your cloud copy."; else unchanged.
- [ ] **Step 6: `css/style.css`** (tokens/classes only; add to the shell/button area): `#settingsBtn{position:relative}` and
```css
.sync-dot{position:absolute;top:5px;right:5px;width:8px;height:8px;border-radius:50%;pointer-events:none}
.sync-dot.is-idle{background:var(--accent);box-shadow:0 0 6px var(--accent-glow)}
.sync-dot.is-pending{background:transparent;box-shadow:inset 0 0 0 1.5px var(--accent)}
.sync-dot.is-attention{background:var(--warn)}
```
  (`--warn` exists; confirm the token names against `:root` before use). Make sure the Sync inputs inherit the shared `.input` 16px-on-phone rule and the buttons the 44px phone minimum (they are `.btn`/`.btn-sm`).
- [ ] **Step 7: README**: add a **Cloud sync** section (what it is, the 6 owner setup steps, "never use the service-role key", the free-tier pause note, sign-in per device, Export backup still recommended, how Reset behaves) and update the "Your data" section (local first; optionally synced to your own Supabase project). Keep every other statement true; add `tools/test-merge.js`, `test-sync.js`, `supabase/schema.sql` to the layout list.
- [ ] **Step 8: Verify**: `npm test` green; `npm run build` (commit regenerated `dist/winter-arc.html`; the build test must stay green and deterministic); with Playwright MCP on `npm start` (`http://localhost:4173`, kill the server afterwards, unregister service workers): with an EMPTY config the app looks/behaves exactly as before and Settings shows "Not set up…"; with `window.SYNC_CONFIG` injected via `browser_evaluate` before reload (use `addInitScript` if available) the Sync form renders at 1440 and 390 wide, inputs are 16px on phone, no console errors, status dot hidden when signed out. Screenshots to `C:\Users\aniru\AppData\Local\Temp\claude\c--Users-aniru-winter-arc\23fb34b4-ec95-4720-8e21-faf0c76fda6a\scratchpad\sync\`.
- [ ] **Step 9: Commit** `git add -A js css index.html sw.js tools supabase README.md dist && git commit -m "Wire cloud sync into Settings, status dot, offline shell and docs"`.

---

### Task 5: Mock server, browser end-to-end, fixes

**Files:**
- Create: `tools/mock-supabase.js`
- Modify: whatever the E2E exposes (small fixes only), `README.md` (one line about the mock if useful)

**Interfaces:**
- Produces: `node tools/mock-supabase.js [port]` (default 54321) — a dev-only local server implementing the same endpoints the engine uses (`POST /auth/v1/token?grant_type=password|refresh_token`, `POST /auth/v1/logout`, `GET|POST|PATCH /rest/v1/user_state` with `user_id=eq.`/`version=eq.` filters and `Prefer: return=representation`), CORS for any origin (`apikey, authorization, content-type, prefer` headers, `OPTIONS` handled), one user `me@example.com` / `hunter2`, access-token TTL from env `MOCK_TTL` seconds (default 3600), plus control endpoints `POST /__offline?on=1|0` (answer 503 while on), `POST /__expire` (invalidate all access tokens), `GET /__row` (current row), `POST /__reset`.

- [ ] **Step 1: Implement** `tools/mock-supabase.js` (plain Node `http`; ≤ 150 lines; mirror the semantics of the fake in `tools/test-sync.js`; print `mock supabase on http://localhost:<port>`). Add a tiny self-test at the bottom guarded by `if (process.argv.includes('--selftest'))` that starts the server on an ephemeral port, signs in, inserts and CAS-patches a row with Node's `fetch`, asserts the results and exits 0 (run it in this step; do **not** add it to `npm test`).
- [ ] **Step 2: Browser end-to-end** with the Playwright MCP tools: start `node tools/mock-supabase.js` and `npm start`; open **two browser contexts** (a phone-sized 390×844 touch context = "phone", and a 1280×800 = "laptop"), each with `window.SYNC_CONFIG = {url:'http://localhost:54321', anonKey:'anon'}` injected before the app scripts (`browser_run_code_unsafe`/init script or `browser_evaluate` + reload, whichever the tools support; contexts can also be emulated by two tabs with separate `localStorage` via different origins `localhost:4173` vs `127.0.0.1:4173`). Scenarios (record result per scenario in the report with what you saw):
  1. Settings → Sync form visible; wrong password → "Wrong email or password"; correct → signed in, dot lit, "Synced just now".
  2. Phone: tick a habit; within ~5 s laptop (after its own sign-in on first connect → downloads) shows the tick; laptop ticks another day; phone sees it after returning to the tab/`visibilitychange` (or Sync now).
  3. First connect with both sides having data → the 3-option modal; pick **Merge both**; no duplicated default habits; both ticks present.
  4. Offline: `POST /__offline?on=1`; tick on phone → dot hollow, "Can't reach Supabase…"; turn it off → catches up on the next trigger (Sync now).
  5. Conflict: both devices edit while the other is offline-from-sync → after both sync, both show the union.
  6. Token expiry: `POST /__expire` then tick → silent refresh, still synced.
  7. Reset on the phone → confirm text mentions the cloud copy; after Erase, the laptop's data disappears on its next sync; `GET /__row` shows the fresh default.
  8. Sign out → data stays local, dot hidden; sign in again → first-connect prompt (both have data) behaves.
  9. Light theme on one device only stays per-device.
  10. No console errors anywhere; network panel shows only `localhost:54321` calls for sync.
  Screenshots (Sync section signed-out / signed-in / error / the first-connect modal; dark+light; 390, 375, 320, 1440) to the scratchpad `sync\` folder; LOOK at them and fix ugliness (overflow, contrast ≥ 11px `--g1`, 44px targets).
- [ ] **Step 3: Fix** every defect the end-to-end finds in the right file with a failing test first where it is unit-testable (merge/engine → `tools/test-merge.js` / `tools/test-sync.js`). Re-run `npm test`, `npm run build` (commit regenerated dist), bump `sw.js` `CACHE` once more if any cached file changed.
- [ ] **Step 4: Commit** `git add -A tools js css index.html sw.js README.md dist && git commit -m "Mock Supabase server and sync end-to-end fixes"`.

---

## Spec coverage (self-review)

- Data model / schema + anon key + config → Task 4 (`supabase/schema.sql`, `sync-config.js`).
- Auth (password grant, refresh rotation, logout, no password stored, friendly errors) → Task 3 (+ tests 2, 10, 11, 16).
- Sync algorithm incl. first-connect options, CAS, triggers, offline, dirty derivation → Task 3 + Task 4 wiring (visibility/online/60 s/3 s debounce).
- Merge rules incl. delta freeze tokens, delete-vs-edit, name-dedupe → Task 1.
- Theme not synced → Task 2 + test 15. UI: Settings section, status dot, first-connect modal, Reset warning → Task 4. SW cross-origin bypass + SHELL → Task 4. Docs/README/setup → Task 4. Mock server + two-device browser E2E → Task 5. Final Opus whole-branch review → controller, after Task 5.
- Spec's `Store.isPristine()` is replaced by `Merge.isPristine(data)` (stated in the header) — same behaviour, pure and testable.
