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
  const b = S({ habits: [H('h1', 'Gym')], logs: { h1: { '2026-10-01': false } } });
  const l = J(b); l.logs.h1['2026-10-01'] = 'freeze';
  const r = J(b); r.logs.h1['2026-10-01'] = true;
  assert.strictEqual(J(M.three(b, l, r)).logs.h1['2026-10-01'], 'freeze');
  assert.strictEqual(J(M.three(b, l, r, { prefer: 'remote' })).logs.h1['2026-10-01'], true);
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
  assert.strictEqual(M.three(base, l, r).freezeTokens, 8);            // converged inputs (local equals remote) return that state as-is
  assert.strictEqual(M.three(base, l2, r2).freezeTokens, 7);          // …but with other concurrent edits the delta rule applies
  const z = J(base); z.freezeTokens = 0; const zr = J(base); zr.freezeTokens = 0; zr.logs.h1.x = true;
  assert.strictEqual(M.three(S({ freezeTokens: 1 }), z, zr).freezeTokens, 0);       // never negative
});
test('converged inputs return the same state; inputs are not mutated', () => {
  const l = J(base); l.logs.h1['2026-10-02'] = true; const r = J(base); r.logs.h1['2026-10-03'] = true;
  const lc = J(l), rc = J(r), bc = J(base);
  const m1 = M.three(base, l, r);
  assert.deepStrictEqual(J(M.three(base, m1, m1)), J(m1));
  assert.deepStrictEqual(J(l), lc); assert.deepStrictEqual(J(r), rc); assert.deepStrictEqual(J(base), bc);
});
test('idempotent: re-merging the result against the same remote changes nothing', () => {
  const l = J(base); l.logs.h1['2026-10-02'] = true; l.habits[0].name = 'Gym 2';
  const r = J(base); r.logs.h1['2026-10-03'] = true; r.habits.push(H('h4', 'Journal'));
  const m = M.three(base, l, r);
  // (freezeTokens are a delta counter, so they are excluded here; see the re-merge contract test below)
  assert.deepStrictEqual(J(M.three(base, m, r)), J(m));
});
test('freeze-token re-merge contract: the engine advances its base to the remote it merged against', () => {
  const b = S({ habits: [H('h1', 'Gym')], freezeTokens: 9 });
  const l = J(b); l.logs.h1 = { d1: 'freeze' }; l.freezeTokens = 8;      // this device froze d1
  const r = J(b); r.logs.h1 = { d2: 'freeze' }; r.freezeTokens = 8;      // another device froze d2
  const m = J(M.three(b, l, r));
  assert.strictEqual(m.freezeTokens, 7);
  const r2 = J(r); r2.logs.h1.d3 = true;                                  // another device then ticks d3 (tokens stay 8)
  // New base = r (the remote just absorbed). Re-merging against the ORIGINAL base would count r's spend twice (9 -> 6).
  const m2 = J(M.three(r, m, r2));
  assert.strictEqual(m2.freezeTokens, 7);
  assert.deepStrictEqual(m2.logs.h1, { d1: 'freeze', d2: 'freeze', d3: true });
});
test('settings merge per field (name local, arcDays remote)', () => {
  const l = J(base); l.settings.name = 'Mine'; const r = J(base); r.settings.arcDays = 120;
  const m = J(M.three(base, l, r));
  assert.strictEqual(m.settings.name, 'Mine'); assert.strictEqual(m.settings.arcDays, 120);
});

test('freeze (local) vs tick (remote) on the same day → local wins by default', () => {
  const b = S({ habits: [H('h1', 'Gym')], logs: { h1: { d1: false } } });
  const l = J(b); l.logs.h1.d1 = 'freeze'; const r = J(b); r.logs.h1.d1 = true;
  assert.strictEqual(J(M.three(b, l, r)).logs.h1.d1, 'freeze');
});
test('a remote reorder of habits is respected', () => {
  const b = S({ habits: [H('h1', 'A'), H('h2', 'B'), H('h3', 'C')] });
  const l = J(b); l.logs.h1 = { d: true };
  const r = J(b); r.habits = [r.habits[2], r.habits[0], r.habits[1]];
  assert.deepStrictEqual(J(M.three(b, l, r)).habits.map(h => h.id), ['h3', 'h1', 'h2']);
});
test('task deleted on one device, toggled on the other → toggled task kept', () => {
  const b = S({ tasks: { d1: [{ id: 'a', text: 'A', done: false }, { id: 'b', text: 'B', done: false }] } });
  const l = J(b); l.tasks.d1 = l.tasks.d1.filter(t => t.id !== 'a');
  const r = J(b); r.tasks.d1[0].done = true;
  const t = J(M.three(b, l, r)).tasks.d1;
  assert.deepStrictEqual(t.map(x => [x.id, x.done]), [['a', true], ['b', false]]);
});
test('null/undefined local or remote does not throw; the other side is returned (cloned)', () => {
  const s = S({ habits: [H('h1', 'Gym')] }); const sc = J(s);
  assert.deepStrictEqual(J(M.three(base, null, s)), sc);
  assert.deepStrictEqual(J(M.three(base, s, undefined)), sc);
  assert.deepStrictEqual(J(M.three(base, null, undefined)), {});
  assert.deepStrictEqual(J(M.three(undefined, s, null)), sc);
  const out = M.three(base, null, s); out.habits[0].name = 'changed';
  assert.deepStrictEqual(J(s), sc);                                      // input untouched
});
test('orphan logs (habit deleted on one side, ticked on the other) are dropped', () => {
  const b = S({ habits: [H('h1', 'Gym'), H('h2', 'Read')], logs: { h1: { d: true }, h2: { d: true } } });
  const l = J(b); l.habits = l.habits.filter(h => h.id !== 'h2'); delete l.logs.h2;
  const r = J(b); r.logs.h2.e = true;
  const m = J(M.three(b, l, r));
  assert.deepStrictEqual(m.habits.map(h => h.id), ['h1']);
  assert.ok(!('h2' in m.logs)); assert.deepStrictEqual(m.logs.h1, { d: true });
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

test('first connect: habit names match across runs of whitespace', () => {
  const l = S({ habits: [H('L1', 'Read  10 pages')], logs: { L1: { d: true } } });
  const r = S({ habits: [H('R1', 'Read 10 pages')] });
  const m = J(M.firstConnect(l, r));
  assert.strictEqual(m.habits.length, 1); assert.deepStrictEqual(m.logs.R1, { d: true });
});
test('first connect: a shared id is never remapped onto / dropped by another habit', () => {
  const l = S({ habits: [H('R1', 'Zed'), H('L1', 'Gym')], logs: { R1: { a: true }, L1: { b: true } } });
  const r = S({ habits: [H('R1', 'Gym')] });
  const m = J(M.firstConnect(l, r));
  const ids = m.habits.map(h => h.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(m.habits.length, 2);
  assert.ok(m.habits.some(h => h.id === 'L1' && h.name === 'Gym'));
  assert.deepStrictEqual(m.logs.L1, { b: true }); assert.deepStrictEqual(m.logs.R1, { a: true });
});
test('first connect: contested day → remote value wins', () => {
  const l = S({ habits: [H('h1', 'Gym')], logs: { h1: { d: true, e: true } } });
  const r = S({ habits: [H('h1', 'Gym')], logs: { h1: { d: 'freeze' } } });
  const m = J(M.firstConnect(l, r));
  assert.deepStrictEqual(m.logs.h1, { d: 'freeze', e: true });
});
test('first connect: inputs not mutated and result is detached', () => {
  const l = S({ habits: [H('L1', 'Gym')], logs: { L1: { a: true } } });
  const r = S({ habits: [H('R1', 'gym')], logs: { R1: { b: true } } });
  const lc = J(l), rc = J(r);
  const m = M.firstConnect(l, r);
  assert.deepStrictEqual(J(l), lc); assert.deepStrictEqual(J(r), rc);
  m.habits[0].name = 'x'; m.logs.R1.zzz = true;
  assert.deepStrictEqual(J(r), rc);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('merge ok');
