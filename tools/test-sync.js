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

/** one device = its own vm realm with its own Store + localStorage + engine
    (`config` is an optional override, used only by the "unconfigured" scenario) */
function device(server, { ask, config } = {}) {
  const mem = {};
  const ctx = { console, localStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
  ctx.window = ctx; vm.createContext(ctx);
  ['js/store.js', 'js/merge.js', 'js/sync.js'].forEach(f => vm.runInContext(SRC(f), ctx));
  const timers = []; const clock = { t: 1_000_000 };
  const sync = ctx.SyncEngine.create({
    fetch: server.fetchImpl, storage: ctx.localStorage, store: ctx.Store, merge: ctx.Merge,
    config: config || { url: BASE, anonKey: 'anon' }, now: () => clock.t,
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

/* ---- helpers ---- */
const D1 = '2026-01-01', D2 = '2026-01-02', D3 = '2026-01-03';
const calls = (S, re) => S.calls.filter(c => re.test(c));
// states from different vm realms: compare with Merge.equal on JSON copies, never assert.deepStrictEqual
const snapEq = (a, b) => a.ctx.Merge.equal(J(a.store.snapshot()), J(b.store.snapshot()));
const logsOf = d => J(d.store.snapshot().logs);
const loggedDays = d => Object.values(logsOf(d)).flatMap(l => Object.keys(l)).sort();
const session = d => JSON.parse(d.mem['winterArc.sync'] || 'null');
const base = d => JSON.parse(d.mem['winterArc.sync.base'] || 'null');
const settle = () => new Promise(r => setImmediate(r));    // drains the fake server's microtask chains
async function signedIn(srv, opts) { const d = device(srv, opts); await d.sync.signIn('me@x.com', 'pw'); return d; }

/* ---- scenarios ---- */
test('1 unconfigured: no network, skipped', async () => {
  const { S, fetchImpl } = fakeSupabase();
  const d = device({ S, fetchImpl }, { config: { url: '', anonKey: '' } });
  assert.strictEqual(d.sync.status().state, 'unconfigured');
  assert.strictEqual(d.sync.isConfigured(), false);
  assert.strictEqual(await d.sync.syncNow(), 'skipped');
  d.sync.notifyLocalChange(); assert.strictEqual(d.timers.length, 0);
  assert.strictEqual(S.calls.length, 0);
});

test('2 wrong password: friendly error, nothing stored, signedOut', async () => {
  const srv = fakeSupabase(); const d = device(srv);
  await assert.rejects(() => d.sync.signIn('me@x.com', 'nope'), e => e && e.name === 'Error' && e.message === 'Wrong email or password');
  assert.ok(!('winterArc.sync' in d.mem));
  assert.strictEqual(d.sync.status().state, 'signedOut');
  assert.strictEqual(d.sync.isSignedIn(), false);
});

test('3 sign in with empty cloud uploads local (version 1), base saved, idle', async () => {
  const srv = fakeSupabase(); const d = device(srv);
  tick(d, habitId(d), D1);
  assert.strictEqual(await d.sync.signIn('me@x.com', 'pw'), 'uploaded');
  const row = srv.S.rows.u1;
  assert.strictEqual(row.version, 1);
  assert.ok(d.ctx.Merge.equal(J(row.data), J(d.store.snapshot())));
  assert.strictEqual(base(d).version, 1);
  assert.ok(d.ctx.Merge.equal(J(base(d).data), J(d.store.snapshot())));
  assert.strictEqual(d.sync.status().state, 'idle');
  assert.strictEqual(d.sync.status().email, 'me@x.com');
  assert.ok(d.sync.isSignedIn());
});

test('4 fresh device + existing cloud downloads without asking', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv);
  tick(A, habitId(A), D1); assert.strictEqual(await A.sync.syncNow(), 'pushed');
  let asked = 0; const B = device(srv, { ask: () => { asked++; return 'merge'; } });
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'downloaded');
  assert.ok(snapEq(A, B));
  assert.strictEqual(asked, 0);
  assert.strictEqual(logsOf(B)[habitId(A)][D1], true);
});

/** A is in the cloud with day D1; B (not yet signed in) has its own different data (D2) */
async function bothHaveData(answer) {
  const srv = fakeSupabase(); const A = device(srv);
  tick(A, habitId(A), D1); await A.sync.signIn('me@x.com', 'pw');
  const ans = { v: answer }; let asked = 0;
  const B = device(srv, { ask: () => { asked++; return ans.v; } });
  tick(B, habitId(B), D2);
  return { srv, A, B, ans, asked: () => asked };
}
test('5a both have data, ask -> merge: union, habits not duplicated, version bumped', async () => {
  const { srv, B, asked } = await bothHaveData('merge');
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'merged');
  assert.strictEqual(asked(), 1);
  const snap = J(B.store.snapshot());
  const names = snap.habits.map(h => h.name.toLowerCase());
  assert.strictEqual(new Set(names).size, names.length, 'default habits duplicated: ' + names.join(','));
  assert.strictEqual(snap.habits.length, 7);
  assert.deepStrictEqual(loggedDays(B), [D1, D2]);
  assert.strictEqual(srv.S.rows.u1.version, 2);
  assert.ok(B.ctx.Merge.equal(J(srv.S.rows.u1.data), snap));
});
test('5b both have data, ask -> cloud: B equals cloud', async () => {
  const { srv, B } = await bothHaveData('cloud');
  await B.sync.signIn('me@x.com', 'pw');
  assert.ok(B.ctx.Merge.equal(J(srv.S.rows.u1.data), J(B.store.snapshot())));
  assert.strictEqual(srv.S.rows.u1.version, 1);
  assert.deepStrictEqual(loggedDays(B), [D1]);
});
test('5c both have data, ask -> device: cloud equals B', async () => {
  const { srv, B } = await bothHaveData('device');
  await B.sync.signIn('me@x.com', 'pw');
  assert.ok(B.ctx.Merge.equal(J(srv.S.rows.u1.data), J(B.store.snapshot())));
  assert.strictEqual(srv.S.rows.u1.version, 2);
  assert.deepStrictEqual(loggedDays(B), [D2]);
});
test('5d both have data, ask -> null: attention, nothing touched, asks again next time', async () => {
  const { srv, B, ans, asked } = await bothHaveData(null);
  const localBefore = JSON.stringify(B.store.snapshot()), cloudBefore = JSON.stringify(srv.S.rows.u1);
  await B.sync.signIn('me@x.com', 'pw');
  assert.strictEqual(B.sync.status().state, 'attention');
  assert.strictEqual(asked(), 1);
  assert.strictEqual(JSON.stringify(B.store.snapshot()), localBefore);
  assert.strictEqual(JSON.stringify(srv.S.rows.u1), cloudBefore);
  assert.ok(!base(B), 'no base must be saved');
  assert.strictEqual(await B.sync.syncNow(), 'error');
  assert.strictEqual(asked(), 2);
  ans.v = 'cloud';
  assert.strictEqual(await B.sync.syncNow(), 'downloaded');
  assert.strictEqual(asked(), 3);
});

test('6 push then clean: no write when nothing changed', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv);
  tick(A, habitId(A), D1);
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.strictEqual(srv.S.rows.u1.version, 2);
  srv.S.calls.length = 0;
  assert.strictEqual(await A.sync.syncNow(), 'clean');
  assert.deepStrictEqual(srv.S.calls.map(c => c.split('?')[0]), ['GET /rest/v1/user_state']);
});

test('7 two devices converge', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv);
  assert.ok(snapEq(A, B));
  const h = habitId(A); assert.strictEqual(h, habitId(B));
  tick(A, h, D1); tick(B, h, D2);
  await A.sync.syncNow(); await B.sync.syncNow(); await A.sync.syncNow();
  assert.ok(snapEq(A, B));
  assert.strictEqual(logsOf(A)[h][D1], true); assert.strictEqual(logsOf(A)[h][D2], true);
  assert.ok(A.ctx.Merge.equal(J(srv.S.rows.u1.data), J(A.store.snapshot())));
});

test('8 CAS conflict retry: another device pushes between GET and PATCH', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1);
  srv.S.beforePatch = uid => {
    const r = srv.S.rows[uid]; const d = J(r.data); (d.logs[h] = d.logs[h] || {})[D2] = true;
    srv.S.rows[uid] = { data: d, version: r.version + 1 };
  };
  const out = await A.sync.syncNow();
  assert.ok(out === 'merged' || out === 'pushed', out);
  const cloud = J(srv.S.rows.u1.data);
  assert.strictEqual(cloud.logs[h][D1], true); assert.strictEqual(cloud.logs[h][D2], true);
  assert.strictEqual(logsOf(A)[h][D1], true); assert.strictEqual(logsOf(A)[h][D2], true);
  assert.ok(A.ctx.Merge.equal(cloud, J(A.store.snapshot())));
  assert.strictEqual(base(A).version, srv.S.rows.u1.version);
});

test('8b lost race after applying a merge: working base advances (freeze tokens counted once)', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv);
  const h = habitId(A);
  assert.strictEqual(A.store.snapshot().freezeTokens, 9);
  assert.ok(B.store.freeze(h, D2));                       // B: freeze d2 -> tokens 8, pushed
  assert.strictEqual(await B.sync.syncNow(), 'pushed');
  assert.ok(A.store.freeze(h, D1));                       // A: freeze d1 -> tokens 8, unsynced
  srv.S.beforePatch = uid => {                            // B' = B + tick d3 lands between A's GET and A's PATCH
    const r = srv.S.rows[uid]; const d = J(r.data); d.logs[h][D3] = true;
    srv.S.rows[uid] = { data: d, version: r.version + 1 };
  };
  assert.strictEqual(await A.sync.syncNow(), 'merged');
  const a = J(A.store.snapshot());
  assert.strictEqual(a.freezeTokens, 7, 'tokens double-counted: ' + a.freezeTokens);
  assert.strictEqual(a.logs[h][D1], 'freeze'); assert.strictEqual(a.logs[h][D2], 'freeze'); assert.strictEqual(a.logs[h][D3], true);
  const cloud = J(srv.S.rows.u1.data);
  assert.strictEqual(cloud.freezeTokens, 7);
  assert.ok(A.ctx.Merge.equal(cloud, a));
  assert.strictEqual(base(A).version, srv.S.rows.u1.version);
  assert.strictEqual(srv.S.rows.u1.version, 4);
});

test('9 offline and recovery; 503 and 429 are pending', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  const baseBefore = A.mem['winterArc.sync.base'];
  srv.S.offline = true; tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().state, 'pending');
  assert.ok(!/Error:|\n\s+at /.test(A.sync.status().message));
  assert.strictEqual(A.mem['winterArc.sync.base'], baseBefore);
  assert.strictEqual(logsOf(A)[h][D1], true);
  srv.S.offline = false;
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.strictEqual(A.sync.status().state, 'idle');
  assert.strictEqual(J(srv.S.rows.u1.data).logs[h][D1], true);
  for (const code of [503, 429]) {
    tick(A, h, D2, code === 503);
    srv.S.status = code;
    assert.strictEqual(await A.sync.syncNow(), 'error');
    assert.strictEqual(A.sync.status().state, 'pending', 'status ' + code);
    srv.S.status = 0;
  }
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
});

test('10 expired access token: silent refresh with rotation', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  const old = session(A);
  Object.keys(srv.S.tokens).forEach(t => delete srv.S.tokens[t]);   // server no longer honours the access token
  tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  const now = session(A);
  assert.notStrictEqual(now.refreshToken, old.refreshToken);
  assert.notStrictEqual(now.accessToken, old.accessToken);
  assert.ok(!srv.S.refresh[old.refreshToken], 'old refresh token must be spent');
  assert.ok(srv.S.refresh[now.refreshToken]);
  assert.strictEqual(now.email, 'me@x.com'); assert.strictEqual(now.userId, 'u1');
  assert.strictEqual(J(srv.S.rows.u1.data).logs[h][D1], true);
});

test('11 refresh rejected -> attention "Sign in again", tokens dropped, email kept', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  srv.S.refresh = {}; srv.S.tokens = {};
  tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().state, 'attention');
  assert.strictEqual(A.sync.status().message, 'Sign in again');
  assert.strictEqual(logsOf(A)[h][D1], true);
  const s = session(A);
  assert.ok(!s.accessToken && !s.refreshToken);
  assert.strictEqual(s.email, 'me@x.com');
  assert.strictEqual(A.sync.isSignedIn(), false);
});

test('12 invalid remote row -> attention; local and cloud untouched', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  srv.S.rows.u1.data = {};
  tick(A, h, D1);
  const localBefore = JSON.stringify(A.store.snapshot());
  srv.S.calls.length = 0;
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().state, 'attention');
  assert.ok(/cloud data/i.test(A.sync.status().message), A.sync.status().message);
  assert.strictEqual(JSON.stringify(A.store.snapshot()), localBefore);
  assert.deepStrictEqual(J(srv.S.rows.u1.data), {});
  assert.strictEqual(srv.S.rows.u1.version, 1);
  assert.strictEqual(calls(srv.S, /^(PATCH|POST \/rest)/).length, 0);
});

test('13 overwriteCloud after reset: cloud = fresh, other device follows (nothing resurrects)', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1); await A.sync.syncNow(); await B.sync.syncNow();
  assert.strictEqual(logsOf(B)[h][D1], true);
  A.store.reset();
  assert.strictEqual(await A.sync.overwriteCloud(), true);
  const cloud = J(srv.S.rows.u1.data);
  assert.ok(A.ctx.Merge.equal(cloud, J(A.store.snapshot())));
  assert.deepStrictEqual(cloud.logs, {});
  assert.strictEqual(base(A).version, srv.S.rows.u1.version);
  await B.sync.syncNow();
  assert.deepStrictEqual(logsOf(B), {});
  await A.sync.syncNow();                                 // and it stays gone
  assert.deepStrictEqual(J(srv.S.rows.u1.data).logs, {});
  assert.ok(snapEq(A, B));
});

test('14 debounce + single-flight', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  A.timers.length = 0; srv.S.calls.length = 0;
  tick(A, h, D1); tick(A, h, D2); tick(A, h, D3);
  assert.strictEqual(A.timers.filter(t => t.f).length, 1);
  assert.strictEqual(A.timers.find(t => t.f).ms, 3000);
  await A.tick(); await settle();                          // the timer callback starts the run; let it finish
  assert.strictEqual(calls(srv.S, /^GET \/rest\/v1\/user_state/).length, 1);
  assert.strictEqual(calls(srv.S, /^PATCH/).length, 1);
  assert.strictEqual(J(srv.S.rows.u1.data).logs[h][D3], true);
  // two concurrent calls: one run + exactly one follow-up
  tick(A, h, '2026-01-04'); srv.S.calls.length = 0;
  const p1 = A.sync.syncNow(), p2 = A.sync.syncNow();
  await Promise.all([p1, p2]);
  assert.strictEqual(calls(srv.S, /^GET \/rest\/v1\/user_state/).length, 2);
  assert.strictEqual(calls(srv.S, /^PATCH/).length, 1);
});

test('15 theme is not synced', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv); const h = habitId(A);
  A.store.commit(s => { s.settings.theme = 'light'; }); tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.ok(!('theme' in J(A.store.snapshot()).settings));
  assert.ok(!('theme' in srv.S.rows.u1.data.settings));
  assert.strictEqual(await B.sync.syncNow(), 'pulled');
  assert.strictEqual(B.store.state.settings.theme, 'dark');
  assert.strictEqual(A.store.state.settings.theme, 'light');
  assert.strictEqual(logsOf(B)[h][D1], true);
});

test('16 sign out clears session + base, keeps data; signing in again runs first-connect', async () => {
  const srv = fakeSupabase(); let asked = 0;
  const A = device(srv, { ask: () => { asked++; return 'merge'; } }); const h = habitId(A);
  tick(A, h, D1); await A.sync.signIn('me@x.com', 'pw');
  assert.strictEqual(asked, 0);
  await A.sync.signOut();
  assert.ok(!('winterArc.sync.base' in A.mem));
  assert.ok(!(session(A) || {}).accessToken);
  assert.strictEqual(A.sync.status().state, 'signedOut');
  assert.strictEqual(A.sync.isSignedIn(), false);
  assert.strictEqual(logsOf(A)[h][D1], true);
  assert.strictEqual(await A.sync.syncNow(), 'skipped');
  await A.sync.signIn('me@x.com', 'pw');
  assert.strictEqual(asked, 1, 'first-connect question expected');
  assert.strictEqual(A.sync.status().state, 'idle');
});

test('17 notifyLocalChange never throws (broken storage)', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv);
  A.ctx.localStorage.getItem = () => { throw new Error('denied'); };
  assert.doesNotThrow(() => A.sync.notifyLocalChange());
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('sync ok');
})();
