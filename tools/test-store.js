/* Exercises the store's date, streak, rate and arc math in a bare VM.
   Run: node tools/test-store.js                                          */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'store.js'), 'utf8');

/** fresh sandboxed copy of the store, with localStorage stubbed out */
function freshStore(seed) {
  const mem = { v: seed ? JSON.stringify(seed) : null };
  const ctx = {
    console,
    localStorage: { getItem: () => mem.v, setItem: (k, v) => { mem.v = v; } }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const { D } = freshStore();
const T = D.todayKey();
const ago = n => D.addKey(T, -n);

console.log('\ndates');
test('key/parse round-trip', () => {
  assert.strictEqual(D.key(D.parse('2026-02-29'.replace('29', '28'))), '2026-02-28');
});
test('diff counts whole days across a month boundary', () => {
  assert.strictEqual(D.diff('2026-01-28', '2026-02-03'), 6);
});
test('range is inclusive at both ends', () => {
  // values cross the VM boundary, so compare structurally rather than by prototype
  assert.strictEqual(D.range('2026-03-01', '2026-03-04').join(),
    '2026-03-01,2026-03-02,2026-03-03,2026-03-04');
});
test('daysInMonth handles a leap February', () => {
  assert.strictEqual(D.daysInMonth(2028, 1), 29);
});
test('startOfWeek respects the configured first day', () => {
  const wed = new Date(2026, 8, 16);                 // Wed 16 Sep 2026
  assert.strictEqual(D.key(D.startOfWeek(wed, 0)), '2026-09-13');  // Sunday
  assert.strictEqual(D.key(D.startOfWeek(wed, 1)), '2026-09-14');  // Monday
});

/* ---- a controlled state: one daily habit, created 30 days ago ---- */
function dailyFixture(logEntries) {
  const logs = {};
  logs.h1 = {};
  Object.assign(logs.h1, logEntries);
  return {
    version: 1,
    settings: { name: 'T', arcStart: ago(30), arcDays: 90, weekStart: 0, theme: 'dark' },
    freezeTokens: 3,
    habits: [{ id: 'h1', name: 'Gym', color: '#3987e5', cadence: 'daily',
               target: 1, archived: false, createdAt: ago(30) }],
    logs, tasks: {}, mindset: {}, goals: []
  };
}

console.log('\nstreaks');
test('counts back from today when today is done', () => {
  const { Store } = freshStore(dailyFixture({ [T]: true, [ago(1)]: true, [ago(2)]: true }));
  assert.strictEqual(Store.streak(Store.state.habits[0]), 3);
});
test('an unlogged today does not break yesterday\'s streak', () => {
  const { Store } = freshStore(dailyFixture({ [ago(1)]: true, [ago(2)]: true }));
  assert.strictEqual(Store.streak(Store.state.habits[0]), 2);
});
test('a gap ends the streak', () => {
  const { Store } = freshStore(dailyFixture({ [T]: true, [ago(2)]: true, [ago(3)]: true }));
  assert.strictEqual(Store.streak(Store.state.habits[0]), 1);
});
test('a freeze holds the streak without counting as a completion', () => {
  const { Store } = freshStore(dailyFixture({
    [T]: true, [ago(1)]: 'freeze', [ago(2)]: true, [ago(3)]: true }));
  assert.strictEqual(Store.streak(Store.state.habits[0]), 3);
});
test('bestStreak finds the longest past run', () => {
  const { Store } = freshStore(dailyFixture({
    [ago(10)]: true, [ago(9)]: true, [ago(8)]: true, [ago(7)]: true,   // run of 4
    [ago(2)]: true, [ago(1)]: true }));                                 // run of 2
  assert.strictEqual(Store.bestStreak(Store.state.habits[0]), 4);
});

console.log('\nrates');
test('rate is done/scheduled over the window', () => {
  const { Store } = freshStore(dailyFixture({ [ago(3)]: true, [ago(1)]: true }));
  // window ago(3)..today = 4 days, 2 done
  assert.strictEqual(Store.rate(Store.state.habits[0], ago(3), T), 50);
});
test('frozen days are excluded from the denominator', () => {
  const { Store } = freshStore(dailyFixture({
    [ago(3)]: true, [ago(2)]: 'freeze', [ago(1)]: true, [T]: true }));
  // 4-day window, 1 frozen -> 3 counted, 3 done
  assert.strictEqual(Store.rate(Store.state.habits[0], ago(3), T), 100);
});
test('days before the habit existed are not scheduled', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.strictEqual(Store.scheduledKeys(Store.state.habits[0], ago(60), T).length, 31);
});
test('future days are never scheduled', () => {
  const { Store } = freshStore(dailyFixture({}));
  const keys = Store.scheduledKeys(Store.state.habits[0], ago(2), D.addKey(T, 10));
  assert.strictEqual(keys[keys.length - 1], T);
});

console.log('\nweekly cadence');
function weeklyFixture(entries, target) {
  const f = dailyFixture(entries);
  f.habits[0].cadence = 'weekly';
  f.habits[0].target = target;
  return f;
}
test('isMet turns true once the weekly target is reached', () => {
  const weekStart = D.key(D.startOfWeek(D.parse(T), 0));
  const d = n => D.addKey(weekStart, n);
  const { Store } = freshStore(weeklyFixture({ [d(0)]: true, [d(1)]: true }, 3));
  const h = Store.state.habits[0];
  assert.strictEqual(Store.isMet(h, T), false);
  Store.toggle('h1', d(2));
  assert.strictEqual(Store.isMet(h, T), true);
  assert.strictEqual(Store.periodCount(h, T), 3);
});
test('periodKeys returns the full 7-day week', () => {
  const { Store } = freshStore(weeklyFixture({}, 3));
  assert.strictEqual(Store.periodKeys('weekly', T).length, 7);
});

console.log('\nday score');
test('dayScore is the share of habits satisfied', () => {
  const f = dailyFixture({ [T]: true });
  f.habits.push({ id: 'h2', name: 'Read', color: '#d95926', cadence: 'daily',
                  target: 1, archived: false, createdAt: ago(30) });
  f.habits.push({ id: 'h3', name: 'Walk', color: '#199e70', cadence: 'daily',
                  target: 1, archived: false, createdAt: ago(30) });
  const { Store } = freshStore(f);
  assert.strictEqual(Store.dayScore(T), 33);          // 1 of 3
  const tally = Store.dayTally(T);
  assert.strictEqual(tally.done, 1);
  assert.strictEqual(tally.total, 3);
});
test('a habit created later is not counted on earlier days', () => {
  const f = dailyFixture({});
  f.habits.push({ id: 'h2', name: 'New', color: '#d95926', cadence: 'daily',
                  target: 1, archived: false, createdAt: T });
  const { Store } = freshStore(f);
  Store.toggle('h1', ago(5));
  assert.strictEqual(Store.dayScore(ago(5)), 100);    // only h1 existed then
});

console.log('\nfreeze tokens');
test('freezing spends a token and unfreezing refunds it', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.strictEqual(Store.state.freezeTokens, 3);
  assert.strictEqual(Store.freeze('h1', T), true);
  assert.strictEqual(Store.state.freezeTokens, 2);
  assert.strictEqual(Store.status('h1', T), 'freeze');
  Store.freeze('h1', T);                              // toggle off
  assert.strictEqual(Store.state.freezeTokens, 3);
  assert.strictEqual(Store.status('h1', T), null);
});
test('freezing is refused at zero tokens', () => {
  const f = dailyFixture({}); f.freezeTokens = 0;
  const { Store } = freshStore(f);
  assert.strictEqual(Store.freeze('h1', T), false);
  assert.strictEqual(Store.status('h1', T), null);
});
test('toggling a frozen day clears it and refunds', () => {
  const f = dailyFixture({ [T]: 'freeze' }); f.freezeTokens = 0;
  const { Store } = freshStore(f);
  Store.toggle('h1', T);
  assert.strictEqual(Store.status('h1', T), null);
  assert.strictEqual(Store.state.freezeTokens, 1);
});

console.log('\narc length');
/** the pre-days formula: N calendar months from the start, minus a day, inclusive */
function oldArcDays(startKey, months) {
  const d = D.parse(startKey);
  const end = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
  return D.diff(startKey, D.key(D.add(end, -1))) + 1;
}
test('a fresh state is a 90-day arc', () => {
  const { Store } = freshStore();
  assert.strictEqual(Store.state.settings.arcDays, 90);
  assert.strictEqual('arcMonths' in Store.state.settings, false);
  assert.strictEqual(Store.arc().total, 90);
});
test('the arc ends on start + (arcDays - 1)', () => {
  const f = dailyFixture({});
  f.settings.arcStart = '2026-01-01';
  f.settings.arcDays = 90;
  const { Store } = freshStore(f);
  const a = Store.arc();
  assert.strictEqual(a.end, '2026-03-31');
  assert.strictEqual(a.end, D.addKey('2026-01-01', 89));
  assert.strictEqual(a.total, 90);
});
test('arcDays of 365 spans the full year, 366 spans a leap year', () => {
  const f = dailyFixture({});
  f.settings.arcStart = '2026-01-01';
  f.settings.arcDays = 365;
  assert.strictEqual(freshStore(f).Store.arc().end, '2026-12-31');
  f.settings.arcStart = '2028-01-01';
  f.settings.arcDays = 366;
  const a = freshStore(f).Store.arc();
  assert.strictEqual(a.end, '2028-12-31');
  assert.strictEqual(a.total, 366);
});
test('an invalid arcDays at runtime falls back to 90 days, never NaN', () => {
  const f = dailyFixture({});
  f.settings.arcDays = 90;
  const { Store } = freshStore(f);
  Store.state.settings.arcDays = 0;
  assert.strictEqual(Store.arc().total, 90);
  Store.state.settings.arcDays = 'x';
  assert.strictEqual(Store.arc().total, 90);
});
test('elapsed and remaining add up to the total, 10 days into a 90-day arc', () => {
  const f = dailyFixture({});
  f.settings.arcStart = ago(10);
  f.settings.arcDays = 90;
  const { Store } = freshStore(f);
  const a = Store.arc();
  assert.strictEqual(a.total, 90);
  assert.strictEqual(a.elapsed, 11);                  // inclusive of today
  assert.strictEqual(a.left, 79);
  assert.strictEqual(a.elapsed + a.left, a.total);
  assert.strictEqual(a.pct, Math.round(11 / 90 * 100));
});
test('an arc that has not started yet has nothing elapsed', () => {
  const f = dailyFixture({});
  f.settings.arcStart = D.addKey(T, 5);
  f.settings.arcDays = 90;
  const a = freshStore(f).Store.arc();
  assert.strictEqual(a.elapsed, 0);
  assert.strictEqual(a.left, 90);
});
test('a finished arc caps at the total', () => {
  const f = dailyFixture({});
  f.settings.arcStart = ago(200);
  f.settings.arcDays = 90;
  const a = freshStore(f).Store.arc();
  assert.strictEqual(a.elapsed, 90);
  assert.strictEqual(a.left, 0);
  assert.strictEqual(a.pct, 100);
});

console.log('\narc migration (months -> days)');
function oldSave(startKey, months) {
  const f = dailyFixture({});
  f.settings.arcStart = startKey;
  delete f.settings.arcDays;
  if (months !== undefined) f.settings.arcMonths = months;
  return f;
}
test('12 months from 2026-01-01 becomes 365 days, arcMonths removed', () => {
  const { Store } = freshStore(oldSave('2026-01-01', 12));
  assert.strictEqual(Store.state.settings.arcDays, 365);
  assert.strictEqual('arcMonths' in Store.state.settings, false);
  assert.strictEqual(Store.arc().end, '2026-12-31');
});
test('a month-end start keeps the old formula\'s day count', () => {
  const want = oldArcDays('2026-01-31', 1);
  assert.ok(want === 28 || want === 29 || want === 31, 'sanity: ' + want);
  const { Store } = freshStore(oldSave('2026-01-31', 1));
  assert.strictEqual(Store.state.settings.arcDays, want);
  assert.strictEqual(Store.arc().total, want);
});
test('several month counts and start dates all match the old formula', () => {
  [['2028-02-29', 12], ['2026-08-31', 6], ['2026-11-30', 3], ['2027-03-15', 24]].forEach(([st, m]) => {
    const { Store } = freshStore(oldSave(st, m));
    assert.strictEqual(Store.state.settings.arcDays, oldArcDays(st, m), st + ' x' + m);
    assert.strictEqual('arcMonths' in Store.state.settings, false);
  });
});
test('a save that already has arcDays is left alone', () => {
  const f = oldSave('2026-01-01', 12);
  f.settings.arcDays = 45;
  const { Store } = freshStore(f);
  assert.strictEqual(Store.state.settings.arcDays, 45);
});
test('a save with neither field, or a bad value, gets 90', () => {
  assert.strictEqual(freshStore(oldSave('2026-01-01')).Store.state.settings.arcDays, 90);
  assert.strictEqual(freshStore(oldSave('2026-01-01', 'abc')).Store.state.settings.arcDays, 90);
  assert.strictEqual(freshStore(oldSave('2026-01-01', 0)).Store.state.settings.arcDays, 90);
  const bad = oldSave('2026-01-01'); bad.settings.arcDays = -3;
  assert.strictEqual(freshStore(bad).Store.state.settings.arcDays, 90);
});
test('importJSON migrates an old backup', () => {
  const { Store } = freshStore();
  Store.importJSON(JSON.stringify(oldSave('2026-01-01', 12)));
  assert.strictEqual(Store.state.settings.arcDays, 365);
  assert.strictEqual('arcMonths' in Store.state.settings, false);
  assert.strictEqual(Store.arc().total, 365);
  assert.strictEqual(JSON.parse(Store.exportJSON()).settings.arcDays, 365);
});

console.log('\ngoals');
test('numeric progress is current over target, capped at 100', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.strictEqual(Store.goalProgress({ type: 'numeric', target: 50, current: 20 }), 40);
  assert.strictEqual(Store.goalProgress({ type: 'numeric', target: 50, current: 80 }), 100);
});
test('milestone progress is done over total', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.strictEqual(Store.goalProgress({ type: 'milestone', milestones:
    [{ done: true }, { done: true }, { done: false }, { done: false }] }), 50);
});
test('an achieved goal always reads 100', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.strictEqual(Store.goalProgress({ status: 'achieved', type: 'numeric',
                                          target: 10, current: 1 }), 100);
});
test('daysLeft goes negative once the deadline passes', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.strictEqual(Store.daysLeft({ deadline: ago(5) }), -5);
  assert.strictEqual(Store.daysLeft({ deadline: D.addKey(T, 90) }), 90);
});

console.log('\ntasks & backup');
test('tasks add, toggle, delete and score', () => {
  const { Store } = freshStore(dailyFixture({}));
  Store.addTask(T, 'Write report');
  Store.addTask(T, 'Call bank');
  assert.strictEqual(Store.taskScore(T), 0);
  Store.toggleTask(T, Store.tasksOf(T)[0].id);
  assert.strictEqual(Store.taskScore(T), 50);
  Store.delTask(T, Store.tasksOf(T)[1].id);
  assert.strictEqual(Store.taskScore(T), 100);
});
test('blank tasks are ignored', () => {
  const { Store } = freshStore(dailyFixture({}));
  Store.addTask(T, '   ');
  assert.strictEqual(Store.tasksOf(T).length, 0);
});
test('copyTasks brings yesterday over unchecked', () => {
  const { Store } = freshStore(dailyFixture({}));
  Store.addTask(ago(1), 'Carry me');
  Store.toggleTask(ago(1), Store.tasksOf(ago(1))[0].id);
  assert.strictEqual(Store.copyTasks(ago(1), T), 1);
  assert.strictEqual(Store.tasksOf(T)[0].done, false);
});
test('export then import round-trips the whole state', () => {
  const { Store } = freshStore(dailyFixture({ [T]: true }));
  Store.addTask(T, 'Keep me');
  const dump = Store.exportJSON();
  const other = freshStore();
  other.Store.importJSON(dump);
  assert.strictEqual(other.Store.tasksOf(T)[0].text, 'Keep me');
  assert.strictEqual(other.Store.status('h1', T), true);
});
test('importing junk is rejected', () => {
  const { Store } = freshStore(dailyFixture({}));
  assert.throws(() => Store.importJSON('{"nope":1}'), /Winter Arc backup/);
});
test('a corrupt save falls back to defaults instead of throwing', () => {
  const ctx = { console, localStorage: { getItem: () => '{not json', setItem: () => {} } };
  ctx.window = ctx; vm.createContext(ctx); vm.runInContext(SRC, ctx);
  assert.ok(ctx.Store.state.habits.length > 0);
});

test('fresh install seeds the 7 default habits', () => {
  const ctx = freshStore();
  assert.deepStrictEqual(Array.from(ctx.Store.state.habits, h => h.name),
    ['Wake up at 5AM','Gym','Read 10 pages','Eat healthy','Plan next day','Cold shower','No social media']);
  const gym = ctx.Store.state.habits.find(h => h.name === 'Gym');
  assert.strictEqual(gym.cadence, 'weekly'); assert.strictEqual(gym.target, 5);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
