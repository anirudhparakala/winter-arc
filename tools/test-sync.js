/* Sync engine against an in-memory fake Supabase. Run: node tools/test-sync.js */
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const SRC = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BASE = 'https://fake.supabase.test';
const J = x => JSON.parse(JSON.stringify(x));

function fakeSupabase() {
  const S = { users: { 'me@x.com': { id: 'u1', password: 'pw' } }, tokens: {}, refresh: {}, rows: {}, calls: [],
              offline: false, status: 0, n: 0, ttl: 3600, beforePatch: null, dropReplyOnce: false, applied: 0 };
  const respond = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => { if (json === undefined) throw new Error('empty'); return json; } });
  const mint = uid => { const a = 'at' + (++S.n), r = 'rt' + S.n; S.tokens[a] = uid; S.refresh[r] = uid;
    return { access_token: a, refresh_token: r, expires_in: S.ttl, user: { id: uid } }; };
  async function handle(url, init) {
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
      if (init.method === 'POST') { if (S.rows[uid]) return respond(409, { code: '23505' }); S.rows[uid] = { data: body.data, version: body.version }; S.applied++; return respond(201, [body]); }
      if (init.method === 'PATCH') {
        if (S.beforePatch) { const f = S.beforePatch; S.beforePatch = null; f(uid); }
        const r = S.rows[uid]; if (!r || String(r.version) !== want('version')) return respond(200, []);
        S.rows[uid] = { data: body.data, version: body.version }; S.applied++; return respond(200, [{ data: body.data, version: body.version }]);
      }
    }
    return respond(404, { message: 'nope' });
  }
  /** S.dropReplyOnce: the next write is APPLIED by the server but the reply never arrives (connection dies) */
  async function fetchImpl(url, init) {
    const before = S.applied, res = await handle(url, init);
    if (S.dropReplyOnce && S.applied > before) { S.dropReplyOnce = false; throw new TypeError('Failed to fetch'); }
    return res;
  }
  return { S, fetchImpl };
}

/** one device = its own vm realm with its own Store + localStorage + engine
    (`config` override is used by the "unconfigured" scenario; `mem` shares storage between engines) */
function device(server, { ask, config, mem: sharedMem } = {}) {
  const mem = sharedMem || {};            // pass another device's `mem` to simulate a reload / a second tab
  const flags = {};
  const ctx = { console, localStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
  ctx.window = ctx; vm.createContext(ctx);
  ['js/store.js', 'js/merge.js', 'js/sync.js'].forEach(f => vm.runInContext(SRC(f), ctx));
  const timers = []; const clock = { t: 1_000_000 };
  const sync = ctx.SyncEngine.create({
    fetch: server.fetchImpl, storage: ctx.localStorage, store: ctx.Store, merge: ctx.Merge,
    config: config || { url: BASE, anonKey: 'anon' }, now: () => clock.t,
    setTimeout: (f, ms) => { if (flags.throwTimers) throw new Error('no timers'); timers.push({ f, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].f = null; },
    askFirstConnect: async () => (ask ? ask() : null)
  });
  ctx.Store.onLocalChange(sync.notifyLocalChange);
  const tick = async () => { const t = timers.filter(x => x.f); timers.length = 0; for (const x of t) await x.f(); };
  return { ctx, store: ctx.Store, sync, mem, clock, timers, tick, flags };
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
  assert.strictEqual(await B.sync.syncNow({ interactive: true }), 'error');
  assert.strictEqual(asked(), 2);
  ans.v = 'cloud';
  assert.strictEqual(await B.sync.syncNow({ interactive: true }), 'downloaded');
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
    tick(A, h, D2, true);
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

/** the fake speaks the old GoTrue shape ({error:'invalid_grant'}); current Supabase answers 400s with {code, error_code, msg} */
function currentGoTrue(srv) {
  const fetchImpl = async (url, init) => {
    const r = await srv.fetchImpl(url, init);
    if (r.status === 400) { const refresh = /refresh_token/.test(url);
      const j = refresh ? { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }
                        : { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' };
      return { status: 400, ok: false, json: async () => j }; }
    if (r.status === 401) return { status: 401, ok: false, json: async () => ({ code: 'PGRST301', message: 'JWT expired' }) };
    return r;
  };
  return { S: srv.S, fetchImpl };
}
test('11b current GoTrue error shapes: wrong password and rejected refresh behave like the old ones', async () => {
  const srv = currentGoTrue(fakeSupabase()); const d = device(srv);
  await assert.rejects(() => d.sync.signIn('me@x.com', 'nope'), e => e && e.message === 'Wrong email or password');
  assert.ok(!('winterArc.sync' in d.mem));
  const A = await signedIn(srv); const h = habitId(A);
  srv.S.refresh = {}; srv.S.tokens = {};
  tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().state, 'attention');
  assert.strictEqual(A.sync.status().message, 'Sign in again');
  assert.strictEqual(logsOf(A)[h][D1], true);
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
  A.ctx.localStorage.getItem = k => (k in A.mem ? A.mem[k] : null);
  A.flags.throwTimers = true;                              // an injected setTimeout that throws
  assert.doesNotThrow(() => A.sync.notifyLocalChange());
  A.store.commit(s => { s.settings.name = 'x'; });         // and the Store's commit path stays intact
  assert.strictEqual(A.store.state.settings.name, 'x');
});

/* ================= fix round 1: data integrity + robustness ================= */

/** wraps a fake server so a test can break/hold individual requests (all flags off by default) */
function tamper(srv) {
  const T = { patchFail: null, patchEmpty: false, junk: false, hang: false, holdGet: null, holdRefresh: null, signIn: null, junkGet: false, junkPost: false, seen: [] };
  const resp = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });
  const fetchImpl = async (url, init) => {
    const u = new URL(url), rest = u.pathname === '/rest/v1/user_state', m = init.method;
    T.seen.push({ p: u.pathname, g: u.searchParams.get('grant_type'), m, auth: (init.headers || {}).Authorization, key: (init.headers || {}).apikey });
    if (rest && m === 'PATCH' && T.patchFail) {
      srv.S.calls.push('PATCH ' + u.pathname);
      if (T.patchFail === 'net') throw new TypeError('Failed to fetch');
      return resp(T.patchFail, { message: 'boom' });
    }
    if (rest && m === 'PATCH' && T.patchEmpty) { srv.S.calls.push('PATCH ' + u.pathname); return resp(200, []); }
    if (rest && ((T.junk && (m === 'GET' || m === 'POST')) || (T.junkGet && m === 'GET') || (T.junkPost && m === 'POST'))) { srv.S.calls.push(m + ' ' + u.pathname); return { status: 200, ok: true, json: async () => { throw new Error('not json'); } }; }
    if (rest && m === 'GET' && T.hang) return new Promise(() => {});
    if (rest && m === 'GET' && T.holdGet) await T.holdGet;
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token' && T.holdRefresh) await T.holdRefresh;
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password' && T.signIn) return resp(T.signIn.status, T.signIn.json);
    return srv.fetchImpl(url, init);
  };
  return { S: srv.S, fetchImpl, T };
}
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

/* ---- 18: a base belongs to one account ---- */
async function accountSwitch(u2Version) {
  const srv = fakeSupabase(); srv.S.users['you@x.com'] = { id: 'u2', password: 'pw' };
  const C = device(srv); tick(C, habitId(C), D3); await C.sync.signIn('you@x.com', 'pw');   // u2's cloud: D3, version 1
  if (u2Version > 1) srv.S.rows.u2.version = u2Version;
  let asked = 0; const A = device(srv, { ask: () => { asked++; return null; } });
  tick(A, habitId(A), D1); await A.sync.signIn('me@x.com', 'pw');                          // u1: base {u1, v1}
  srv.S.refresh = {}; srv.S.tokens = {};                                                   // session lost WITHOUT sign-out
  tick(A, habitId(A), D2);                                                                 // unsynced edit
  const localBefore = JSON.stringify(A.store.snapshot()), cloudBefore = JSON.stringify(srv.S.rows.u2);
  await A.sync.signIn('you@x.com', 'pw');
  assert.strictEqual(asked, 1, 'both sides have data: the first-connect question is required');
  assert.strictEqual(JSON.stringify(srv.S.rows.u2), cloudBefore, "u2's cloud row must not change");
  assert.strictEqual(JSON.stringify(A.store.snapshot()), localBefore, "u1's unsynced edit must not be replaced");
  assert.strictEqual(A.sync.status().state, 'attention');
}
test('18a other account at the SAME version: u1 data is not pushed over u2', () => accountSwitch(1));
test('18b other account at a HIGHER version: unsynced edit is not silently merged away', () => accountSwitch(3));
test('18c base without userId or with another userId is ignored (first-connect runs)', async () => {
  for (const mutate of [b => { delete b.userId; }, b => { b.userId = 'someone-else'; }]) {
    const srv = fakeSupabase(); let asked = 0;
    const A = device(srv, { ask: () => { asked++; return 'merge'; } });
    tick(A, habitId(A), D1); await A.sync.signIn('me@x.com', 'pw');
    const b = base(A); assert.strictEqual(b.userId, 'u1'); mutate(b); A.mem['winterArc.sync.base'] = JSON.stringify(b);
    tick(A, habitId(A), D2);
    await A.sync.syncNow({ interactive: true });
    assert.strictEqual(asked, 1);
  }
});
test('18d signing in again as the SAME user keeps the base (no question, unsynced edit pushes)', async () => {
  const srv = fakeSupabase(); let asked = 0;
  const A = device(srv, { ask: () => { asked++; return null; } }); const h = habitId(A);
  await A.sync.signIn('me@x.com', 'pw'); srv.S.refresh = {}; srv.S.tokens = {};
  tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().message, 'Sign in again');
  assert.strictEqual(await A.sync.signIn('me@x.com', 'pw'), 'pushed');
  assert.strictEqual(asked, 0);
  assert.strictEqual(J(srv.S.rows.u1.data).logs[h][D1], true);
});

/* ---- 19: a failed push after a local merge must not double-count the remote's freeze spend ---- */
for (const mode of ['net', 503, 429]) {
  test('19 failed push (' + mode + ') after merge: freeze tokens counted once after recovery', async () => {
    const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv); const h = habitId(A);
    assert.ok(B.store.freeze(h, D2)); assert.strictEqual(await B.sync.syncNow(), 'pushed');   // cloud tokens 8
    assert.ok(A.store.freeze(h, D1));                                                          // local tokens 8
    const T = tamper(srv); const A2 = device(T, { mem: A.mem });                               // same device, PATCH will fail
    T.T.patchFail = mode;
    assert.strictEqual(await A2.sync.syncNow(), 'error');
    assert.strictEqual(A2.sync.status().state, 'pending');
    assert.strictEqual(J(A2.store.snapshot()).freezeTokens, 7);
    T.T.patchFail = null;
    const out = await A2.sync.syncNow();
    assert.ok(out === 'pushed' || out === 'merged', out);
    assert.strictEqual(J(A2.store.snapshot()).freezeTokens, 7, 'double-counted after recovery');
    assert.strictEqual(J(srv.S.rows.u1.data).freezeTokens, 7);
    assert.strictEqual(logsOf(A2)[h][D1], 'freeze'); assert.strictEqual(logsOf(A2)[h][D2], 'freeze');
  });
}
test('19b failed push after a first-connect merge: no second question, retry just pushes', async () => {
  const { srv, B } = await bothHaveData('merge');
  let asked = 0; const T = tamper(srv);
  const B2 = device(T, { mem: B.mem, ask: () => { asked++; return 'merge'; } });
  T.T.patchFail = 'net';
  assert.strictEqual(await B2.sync.signIn('me@x.com', 'pw'), 'error');
  assert.strictEqual(asked, 1);
  T.T.patchFail = null;
  assert.strictEqual(await B2.sync.syncNow(), 'pushed');
  assert.strictEqual(asked, 1, 'must not ask twice');
  assert.deepStrictEqual(loggedDays(B2), [D1, D2]);
  assert.ok(B2.ctx.Merge.equal(J(srv.S.rows.u1.data), J(B2.store.snapshot())));
});

/* ---- 20: a 2xx that is not a row list is an error, never "no row" ---- */
test('20 junk 2xx on GET/POST: error, no base, local intact; recovery merges properly', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); tick(A, habitId(A), D1); await A.sync.syncNow();
  const T = tamper(srv); const B = device(T, { ask: () => 'merge' }); tick(B, habitId(B), D2);
  const localBefore = JSON.stringify(B.store.snapshot()), cloudBefore = JSON.stringify(srv.S.rows.u1);
  T.T.junk = true;
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'error');
  assert.ok(!base(B), 'no base must be recorded');
  assert.strictEqual(JSON.stringify(B.store.snapshot()), localBefore);
  assert.strictEqual(JSON.stringify(srv.S.rows.u1), cloudBefore);
  assert.ok(['pending', 'attention'].includes(B.sync.status().state));
  T.T.junk = false;
  assert.strictEqual(await B.sync.syncNow({ interactive: true }), 'merged');
  assert.deepStrictEqual(loggedDays(B), [D1, D2]);
  assert.deepStrictEqual(Object.values(J(srv.S.rows.u1.data).logs).flatMap(l => Object.keys(l)).sort(), [D1, D2]);
});

/* ---- 21: an edit made while the first-connect dialog is open is kept ---- */
test('21 edit during the first-connect dialog is not lost on merge', async () => {
  const srv = fakeSupabase(); const A = device(srv); tick(A, habitId(A), D1); await A.sync.signIn('me@x.com', 'pw');
  let B; B = device(srv, { ask: () => { tick(B, habitId(B), D3); return 'merge'; } });
  tick(B, habitId(B), D2);
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'merged');
  assert.deepStrictEqual(loggedDays(B), [D1, D2, D3]);
  assert.deepStrictEqual(Object.values(J(srv.S.rows.u1.data).logs).flatMap(l => Object.keys(l)).sort(), [D1, D2, D3]);
});

/* ---- 22: sign-out while a sync is running ---- */
test('22 signOut during a running sync: stays signedOut, no base, nothing pushed', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const A = device(T); await A.sync.signIn('me@x.com', 'pw');
  tick(A, habitId(A), D1);
  const g = gate(); T.T.holdGet = g.p;
  const p = A.sync.syncNow(); await settle();
  await A.sync.signOut();
  srv.S.calls.length = 0; g.open(); const out = await p; await settle();
  assert.strictEqual(out, 'skipped');
  assert.strictEqual(A.sync.status().state, 'signedOut');
  assert.ok(!('winterArc.sync.base' in A.mem));
  assert.ok(!(session(A) || {}).accessToken);
  assert.strictEqual(calls(srv.S, /^(PATCH|POST \/rest)/).length, 0);
  assert.strictEqual(srv.S.rows.u1.version, 1);
});

/* ---- 23: a request that never answers must not wedge the engine ---- */
test('23 fetch timeout: never-settling request -> pending, next syncNow runs', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const A = device(T); await A.sync.signIn('me@x.com', 'pw');
  tick(A, habitId(A), D1);
  T.T.hang = true;
  const p = A.sync.syncNow(); await settle();
  const t = A.timers.find(x => x.f && x.ms === 25000);
  assert.ok(t, 'a 25 s request timeout timer must be armed');
  t.f();
  assert.strictEqual(await p, 'error');
  assert.strictEqual(A.sync.status().state, 'pending');
  assert.ok(/Can't reach Supabase/.test(A.sync.status().message));
  T.T.hang = false;
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
});

/* ---- 24: two tabs refreshing at once ---- */
test('24 refresh rejected because another tab already rotated it: use the stored session', async () => {
  const srv = fakeSupabase(); const E1 = await signedIn(srv); tick(E1, habitId(E1), D1); await E1.sync.syncNow();
  const T = tamper(srv); const E2 = device(T, { mem: E1.mem });
  srv.S.tokens = {};                                       // both engines' access token is now rejected
  const g = gate(); T.T.holdRefresh = g.p;
  const p2 = E2.sync.syncNow(); await settle();           // E2 GET -> 401 -> its refresh is held
  assert.strictEqual(await E1.sync.syncNow(), 'clean');    // E1 refreshes and rotates the token
  const rotated = session(E1).refreshToken;
  g.open();
  assert.strictEqual(await p2, 'clean');
  assert.notStrictEqual(E2.sync.status().state, 'attention');
  assert.strictEqual(session(E2).refreshToken, rotated);
  assert.ok(session(E2).accessToken);
});

/* ---- 25: background triggers never open the first-connect dialog ---- */
test('25 dismissed first-connect: background syncNow() does not ask; interactive does', async () => {
  const { B, asked } = await bothHaveData(null);
  await B.sync.signIn('me@x.com', 'pw'); assert.strictEqual(asked(), 1);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(await B.sync.syncNow(), 'error');
    assert.strictEqual(B.sync.status().state, 'attention');
    assert.ok(/tap Sync now/.test(B.sync.status().message));
  }
  assert.strictEqual(asked(), 1);
  tick(B, habitId(B), D3); await B.tick(); await settle();   // the debounced push is a background call too
  assert.strictEqual(asked(), 1);
  await B.sync.syncNow({ interactive: true });
  assert.strictEqual(asked(), 2);
});

/* ---- 26: raw exceptions never reach the user ---- */
test('26 unusable remote row (habits:[null]): plain message, local untouched, no base', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); srv.S.rows.u1.data.habits = [null];
  const B = device(srv); const before = JSON.stringify(B.store.snapshot());
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'error');
  assert.strictEqual(B.sync.status().state, 'attention');
  assert.strictEqual(B.sync.status().message, 'Cloud data could not be applied — nothing was changed');
  assert.strictEqual(JSON.stringify(B.store.snapshot()), before);
  assert.ok(!base(B));
  // and with a base present (merge path)
  const C = await signedIn(srv); srv.S.rows.u1.data = J(A.store.snapshot()); srv.S.rows.u1.version = 1;
  await C.sync.syncNow(); tick(C, habitId(C), D1);
  srv.S.rows.u1 = { data: Object.assign(J(A.store.snapshot()), { habits: [null] }), version: 2 };
  const cb = JSON.stringify(C.store.snapshot());
  assert.strictEqual(await C.sync.syncNow(), 'error');
  assert.strictEqual(C.sync.status().message, 'Cloud data could not be applied — nothing was changed');
  assert.strictEqual(JSON.stringify(C.store.snapshot()), cb);
});

/* ---- 27: sign-in error texts ---- */
test('27 sign-in errors: wrong credentials only when the body says so', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const d = device(T);
  const msg = async () => { try { await d.sync.signIn('me@x.com', 'pw'); return 'no error'; } catch (e) { return e.message; } };
  T.T.signIn = { status: 401, json: { message: 'Invalid API key' } };
  assert.strictEqual(await msg(), 'Sign-in failed (401)');
  T.T.signIn = { status: 400, json: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' } };
  assert.strictEqual(await msg(), 'Sign-in failed (400)');
  T.T.signIn = { status: 400, json: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
  assert.strictEqual(await msg(), 'Wrong email or password');
  T.T.signIn = { status: 400, json: { error: 'invalid_grant' } };
  assert.strictEqual(await msg(), 'Wrong email or password');
  T.T.signIn = { status: 503, json: { message: 'upstream' } };
  assert.strictEqual(await msg(), 'Sign-in failed (503)');
  T.T.signIn = { status: 200, json: { weird: true } };
  assert.strictEqual(await msg(), 'Sign-in failed (200)');
  assert.ok(!('winterArc.sync' in d.mem));
});

/* ---- 28-32: gaps ---- */
test('28 expiry margin: refresh happens before the request once within 60 s of expiry', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  const first = session(A);
  A.clock.t += 3600 * 1000 - 30 * 1000; tick(A, h, D1); srv.S.calls.length = 0;
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.ok(srv.S.calls[0].startsWith('POST /auth/v1/token?grant_type=refresh_token'), srv.S.calls.join(' | '));
  assert.notStrictEqual(session(A).accessToken, first.accessToken);
  A.clock.t += 3600 * 1000 - 120 * 1000; tick(A, h, D2); srv.S.calls.length = 0;   // 2 min left: no refresh yet
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.strictEqual(calls(srv.S, /auth\/v1\/token/).length, 0);
});
test('29 refresh network failure keeps the session (pending, tokens intact)', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  A.clock.t += 3600 * 1000 - 30 * 1000; tick(A, h, D1);
  const before = A.mem['winterArc.sync']; srv.S.offline = true;
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().state, 'pending');
  assert.strictEqual(A.mem['winterArc.sync'], before);
  srv.S.offline = false;
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
});
test('30 REST 403 and 404 -> attention "Setup problem"; recovers afterwards', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A); tick(A, h, D1);
  for (const code of [403, 404]) {
    srv.S.status = code;
    assert.strictEqual(await A.sync.syncNow(), 'error');
    assert.strictEqual(A.sync.status().state, 'attention', 'status ' + code);
    assert.ok(/^Setup problem/.test(A.sync.status().message), A.sync.status().message);
  }
  srv.S.status = 0;
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
});
test('31 busy cap: PATCH that never wins ends after 4 attempts as pending', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const A = device(T); await A.sync.signIn('me@x.com', 'pw');
  tick(A, habitId(A), D1); T.T.patchEmpty = true; srv.S.calls.length = 0;
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(A.sync.status().state, 'pending');
  assert.strictEqual(calls(srv.S, /^PATCH/).length, 4);
  assert.strictEqual(calls(srv.S, /^GET \/rest/).length, 4);
  T.T.patchEmpty = false;
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
});
test('32 dirty state survives a reload: a new engine on the same storage pushes the unsynced edit', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  srv.S.offline = true; tick(A, h, D1);
  assert.strictEqual(await A.sync.syncNow(), 'error');
  srv.S.offline = false;
  const A2 = device(srv, { mem: A.mem });
  assert.strictEqual(A2.sync.status().state, 'idle');
  assert.strictEqual(await A2.sync.syncNow(), 'pushed');
  assert.strictEqual(J(srv.S.rows.u1.data).logs[h][D1], true);
});

/* ================= fix round 2 ================= */

test('33 interactive request arriving during a background run is not lost', async () => {
  const { srv, B } = await bothHaveData(null);
  await B.sync.signIn('me@x.com', 'pw');                       // dialog dismissed: attention
  assert.strictEqual(B.sync.status().state, 'attention');
  const T = tamper(srv); let asked = 0;
  const B2 = device(T, { mem: B.mem, ask: () => { asked++; return 'cloud'; } });
  const g = gate(); T.T.holdGet = g.p;
  const p1 = B2.sync.syncNow(); await settle();                // background pass in flight (GET held)
  const p2 = B2.sync.syncNow({ interactive: true });           // user taps Sync now meanwhile
  g.open();
  assert.strictEqual(await p2, 'downloaded');
  assert.strictEqual(await p1, 'downloaded');
  assert.strictEqual(asked, 1, 'the dialog must open for the interactive request');
  assert.strictEqual(B2.sync.status().state, 'idle');
});

test('34 overwriteCloud waiting on a running sync, then signOut: status stays signedOut', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const A = device(T); await A.sync.signIn('me@x.com', 'pw');
  tick(A, habitId(A), D1);
  const g = gate(); T.T.holdGet = g.p;
  const p = A.sync.syncNow(); await settle();
  const po = A.sync.overwriteCloud();                          // waits for the running pass
  await settle();
  await A.sync.signOut();
  srv.S.calls.length = 0; g.open();
  await p; assert.strictEqual(await po, false); await settle();
  assert.strictEqual(A.sync.status().state, 'signedOut');
  assert.strictEqual(A.sync.status().message, 'Signed out');
  assert.ok(!('winterArc.sync.base' in A.mem));
  assert.strictEqual(calls(srv.S, /^(PATCH|POST \/rest)/).length, 0);
});

test('35 applySynced throwing inside a render listener: run completes, base advanced, tokens stay 7', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv); const h = habitId(A);
  assert.ok(B.store.freeze(h, D2)); assert.strictEqual(await B.sync.syncNow(), 'pushed');   // cloud tokens 8
  assert.ok(A.store.freeze(h, D1));                                                          // local tokens 8
  let boom = true; A.store.subscribe(() => { if (boom) { boom = false; throw new Error('render exploded'); } });
  const quiet = A.ctx.console; A.ctx.console = { log() {}, warn() {}, error() {} };
  const out = await A.sync.syncNow();
  A.ctx.console = quiet;
  assert.strictEqual(out, 'merged');
  assert.strictEqual(A.sync.status().state, 'idle');
  assert.strictEqual(J(A.store.snapshot()).freezeTokens, 7);
  assert.strictEqual(J(srv.S.rows.u1.data).freezeTokens, 7);
  assert.strictEqual(base(A).version, srv.S.rows.u1.version);
  tick(A, h, D3); assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.strictEqual(J(A.store.snapshot()).freezeTokens, 7);
});

test('36 sign-out uses local scope (does not revoke the other devices)', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); srv.S.calls.length = 0;
  await A.sync.signOut();
  const c = calls(srv.S, /logout/);
  assert.strictEqual(c.length, 1);
  assert.ok(/^POST \/auth\/v1\/logout\?scope=local$/.test(c[0]), c[0]);
});

test('22b stale run after sign-out + sign-in as ANOTHER account is stopped by the generation guard', async () => {
  const srv = fakeSupabase(); srv.S.users['you@x.com'] = { id: 'u2', password: 'pw' };
  const C = device(srv); tick(C, habitId(C), D3); await C.sync.signIn('you@x.com', 'pw');   // u2's cloud row: D3, v1
  const T = tamper(srv); let asked = 0;
  const A = device(T, { ask: () => { asked++; return null; } });
  await A.sync.signIn('me@x.com', 'pw'); tick(A, habitId(A), D1);                          // u1 row v1, unsynced edit
  const u2Before = JSON.stringify(srv.S.rows.u2), u1Before = JSON.stringify(srv.S.rows.u1);
  const g = gate(); T.T.holdGet = g.p;
  const p = A.sync.syncNow(); await settle();                                              // old run: GET (u1) held
  await A.sync.signOut();
  const pi = A.sync.signIn('you@x.com', 'pw'); await settle();                             // a session exists again (u2); its sync waits for the old run
  g.open(); await p; await pi; await settle();
  assert.strictEqual(JSON.stringify(srv.S.rows.u2), u2Before, "the stale u1 run must not touch u2's row");
  assert.strictEqual(JSON.stringify(srv.S.rows.u1), u1Before);
  assert.ok(!base(A), 'no base may be written (the new pass is waiting for the first-connect choice)');
  assert.strictEqual(asked, 1);
  assert.strictEqual(A.sync.status().state, 'attention');
});

test('20b junk reply on GET only: error, POST never reached, no base', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const B = device(T); tick(B, habitId(B), D2);
  T.T.junkGet = true;
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'error');
  assert.strictEqual(calls(srv.S, /^POST \/rest/).length, 0);
  assert.ok(!base(B)); assert.ok(!srv.S.rows.u1);
  T.T.junkGet = false;
  assert.strictEqual(await B.sync.syncNow(), 'uploaded');
});
test('20c junk reply on POST only (GET returns []): error, no base, retry uploads', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const B = device(T); tick(B, habitId(B), D2);
  T.T.junkPost = true;
  assert.strictEqual(await B.sync.signIn('me@x.com', 'pw'), 'error');
  assert.ok(!base(B)); assert.ok(!srv.S.rows.u1);
  T.T.junkPost = false;
  assert.strictEqual(await B.sync.syncNow(), 'uploaded');
  assert.strictEqual(srv.S.rows.u1.version, 1);
});

/* ================= final wave: lost replies, key formats, stale base ================= */
const INFL = 'winterArc.sync.inflight';
const inflight = d => JSON.parse(d.mem[INFL] || 'null');
const hasDay = (cloudData, day) => Object.values(cloudData.logs).some(l => day in l);

test('37a lost PATCH reply, then the edit is reversed: the reversal wins everywhere', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1);
  srv.S.dropReplyOnce = true;
  assert.strictEqual(await A.sync.syncNow(), 'error');               // applied by the server, reply lost
  assert.strictEqual(srv.S.rows.u1.version, 2); assert.ok(hasDay(J(srv.S.rows.u1.data), D1));
  assert.ok(inflight(A), 'the in-flight record must survive an ambiguous failure');
  A.store.commit(s => { delete s.logs[h][D1]; });                    // un-tick
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.ok(!hasDay(J(srv.S.rows.u1.data), D1), 'cloud must not resurrect D1');
  assert.ok(!hasDay(J(A.store.snapshot()), D1), 'local must not resurrect D1');
  assert.ok(!inflight(A));
  assert.ok(A.ctx.Merge.equal(J(srv.S.rows.u1.data), J(A.store.snapshot())));
});

test('37b lost POST (insert) reply, then the edit is reversed', async () => {
  const srv = fakeSupabase(); const A = device(srv); const h = habitId(A);
  tick(A, h, D1);
  srv.S.dropReplyOnce = true;
  assert.strictEqual(await A.sync.signIn('me@x.com', 'pw'), 'error');
  assert.strictEqual(srv.S.rows.u1.version, 1); assert.ok(inflight(A));
  A.store.commit(s => { delete s.logs[h][D1]; });
  const out = await A.sync.syncNow();
  assert.ok(out === 'pushed' || out === 'downloaded', out);
  assert.ok(!hasDay(J(srv.S.rows.u1.data), D1));
  assert.ok(!hasDay(J(A.store.snapshot()), D1));
  assert.ok(!inflight(A));
});

test('37c lost reply, then another device pushes before the retry: merge, no crash, no loss', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const B = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1); srv.S.dropReplyOnce = true;
  assert.strictEqual(await A.sync.syncNow(), 'error');               // cloud v2 has D1
  tick(B, h, D2); assert.strictEqual(await B.sync.syncNow(), 'merged');   // B pulls D1, pushes D2 -> v3
  tick(A, h, D3);
  const out = await A.sync.syncNow();
  assert.ok(out === 'merged' || out === 'pushed', out);
  assert.deepStrictEqual(Object.values(J(srv.S.rows.u1.data).logs).flatMap(l => Object.keys(l)).sort(), [D1, D2, D3]);
  await B.sync.syncNow();
  assert.deepStrictEqual(loggedDays(A), [D1, D2, D3]); assert.deepStrictEqual(loggedDays(B), [D1, D2, D3]);
  assert.ok(!inflight(A));
});

test('37d the in-flight record survives a reload', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1); srv.S.dropReplyOnce = true;
  assert.strictEqual(await A.sync.syncNow(), 'error');
  const A2 = device(srv, { mem: A.mem });                            // app reloaded
  A2.store.commit(s => { delete s.logs[h][D1]; });
  assert.strictEqual(await A2.sync.syncNow(), 'pushed');
  assert.ok(!hasDay(J(srv.S.rows.u1.data), D1));
  assert.ok(!inflight(A2));
});

test('37e in-flight is kept for 5xx/offline, cleared for a definitive refusal, CAS loss, sign-out', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const A = device(T); await A.sync.signIn('me@x.com', 'pw'); const h = habitId(A);
  tick(A, h, D1);
  T.T.patchFail = 503; await A.sync.syncNow(); assert.ok(inflight(A), '5xx is ambiguous');
  T.T.patchFail = 'net'; await A.sync.syncNow(); assert.ok(inflight(A), 'network failure is ambiguous');
  T.T.patchFail = 400; await A.sync.syncNow(); assert.ok(!inflight(A), '4xx is a definitive refusal');
  T.T.patchFail = null;
  tick(A, h, D2);
  srv.S.beforePatch = uid => { const r = srv.S.rows[uid]; srv.S.rows[uid] = { data: J(r.data), version: r.version + 1 }; };
  assert.strictEqual(await A.sync.syncNow(), 'merged'); assert.ok(!inflight(A), 'CAS loss then success leaves nothing');
  tick(A, h, D3); T.T.patchFail = 503; await A.sync.syncNow(); assert.ok(inflight(A));
  await A.sync.signOut(); assert.ok(!inflight(A), 'sign-out clears it');
});

test('37h in-flight write never reached the server and another device took that version: its row is NOT adopted as base', async () => {
  const srv = fakeSupabase(); const T = tamper(srv); const A = device(T); await A.sync.signIn('me@x.com', 'pw'); const h = habitId(A);
  const B = await signedIn(srv);
  tick(A, h, D1); T.T.patchFail = 'net';
  assert.strictEqual(await A.sync.syncNow(), 'error');
  assert.strictEqual(inflight(A).version, 2); assert.strictEqual(srv.S.rows.u1.version, 1);   // never applied
  tick(B, h, D2); assert.strictEqual(await B.sync.syncNow(), 'pushed');                          // B takes version 2 with different data
  T.T.patchFail = null;
  assert.strictEqual(await A.sync.syncNow(), 'merged');
  const days = o => Object.values(o.logs).flatMap(l => Object.keys(l)).sort();
  assert.deepStrictEqual(days(J(srv.S.rows.u1.data)), [D1, D2]);
  await B.sync.syncNow();
  assert.deepStrictEqual(loggedDays(A), [D1, D2]); assert.deepStrictEqual(loggedDays(B), [D1, D2]);
  assert.ok(!inflight(A));
});

test('37f an in-flight record of another account is ignored and cleared', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1);
  A.mem[INFL] = JSON.stringify({ userId: 'u-other', version: 1, data: J(A.store.snapshot()) });
  assert.strictEqual(await A.sync.syncNow(), 'pushed');
  assert.ok(!inflight(A));
});

/* deterministic PRNG for the fuzz */
function prng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
test('37g fuzz: 40 seeded interleavings with dropped replies converge and every reversal survives', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = prng(seed), pick = a => a[Math.floor(rnd() * a.length)];
    const srv = fakeSupabase(); const A = await signedIn(srv), B = await signedIn(srv);
    const devs = [A, B], hs = A.store.state.habits.slice(0, 3).map(x => x.id);
    // each device owns its own days, so concurrent edits never conflict on one key and the model is exact
    const days = [['2026-02-01', '2026-02-02', '2026-02-03'], ['2026-03-01', '2026-03-02', '2026-03-03']];
    const model = [{ logs: {}, tasks: {}, frozen: 0 }, { logs: {}, tasks: {}, frozen: 0 }];
    let lossBy = -1;      // a device with an unconfirmed push: no OTHER device syncs until it has retried (the accepted limit)
    for (let step = 0; step < 24; step++) {
      const i = Math.floor(rnd() * 2), d = devs[i], m = model[i];
      const r = rnd();
      if (r < 0.55) {
        const h = pick(hs), day = pick(days[i]), k = h + '|' + day, cur = m.logs[k];
        if (!cur) { tick(d, h, day); m.logs[k] = true; }
        else if (cur === true && m.frozen < 4 && rnd() < 0.4) { assert.ok(d.store.freeze(h, day)); m.logs[k] = 'freeze'; m.frozen++; }
        else if (cur === 'freeze') { assert.ok(d.store.freeze(h, day)); delete m.logs[k]; m.frozen--; }   // un-freeze
        else { d.store.commit(s => { delete s.logs[h][day]; }); delete m.logs[k]; }                       // un-tick
      } else if (r < 0.7) {
        const day = pick(days[i]); d.store.addTask(day, 't' + step); (m.tasks[day] = m.tasks[day] || []).push('t' + step);
      } else if (r < 0.8) {
        const day = pick(days[i]), list = d.store.tasksOf(day);
        if (list.length) { const t = pick(list); d.store.delTask(day, t.id); m.tasks[day] = m.tasks[day].filter(x => x !== t.text); }
      } else if (lossBy < 0 || lossBy === i) {
        srv.S.dropReplyOnce = rnd() < 0.5;
        const out = await d.sync.syncNow();
        srv.S.dropReplyOnce = false;
        lossBy = out === 'error' ? i : -1;
        if (lossBy === i && rnd() < 0.5) { if (await d.sync.syncNow() !== 'error') lossBy = -1; }
      }
    }
    if (lossBy >= 0) await devs[lossBy].sync.syncNow();      // the device with the unconfirmed push retries first (see above)
    for (let round = 0; round < 3; round++) { await A.sync.syncNow(); await B.sync.syncNow(); }
    const cloud = J(srv.S.rows.u1.data);
    assert.ok(A.ctx.Merge.equal(cloud, J(A.store.snapshot())), 'seed ' + seed + ': A != cloud');
    assert.ok(B.ctx.Merge.equal(cloud, J(B.store.snapshot())), 'seed ' + seed + ': B != cloud');
    const want = Object.assign({}, model[0].logs, model[1].logs), got = {};
    Object.keys(cloud.logs).forEach(h => Object.keys(cloud.logs[h]).forEach(day => { got[h + '|' + day] = cloud.logs[h][day]; }));
    assert.deepStrictEqual(got, want, 'seed ' + seed + ': logs differ');
    const frozen = Object.values(want).filter(v => v === 'freeze').length;
    assert.strictEqual(cloud.freezeTokens, 9 - frozen, 'seed ' + seed + ': freeze tokens');
    [0, 1].forEach(i => days[i].forEach(day => {
      const names = (cloud.tasks[day] || []).map(t => t.text).sort();
      assert.deepStrictEqual(names, (model[i].tasks[day] || []).slice().sort(), 'seed ' + seed + ': tasks of ' + day);
    }));
  }
});

test('38 auth requests carry only apikey (no Authorization); REST/logout carry the user token', async () => {
  const srv = fakeSupabase(); const T = tamper(srv);
  const A = device(T, { config: { url: BASE, anonKey: 'sb_publishable_test' } });
  await A.sync.signIn('me@x.com', 'pw'); tick(A, habitId(A), D1);
  A.clock.t += 3600 * 1000 - 30 * 1000; await A.sync.syncNow();      // forces a refresh_token grant
  const tok = session(A).accessToken; await A.sync.signOut();
  const seen = T.T.seen;
  assert.ok(seen.some(x => x.g === 'password') && seen.some(x => x.g === 'refresh_token'));
  seen.forEach(x => assert.strictEqual(x.key, 'sb_publishable_test', 'apikey header always present'));
  seen.filter(x => x.p === '/auth/v1/token').forEach(x => assert.strictEqual(x.auth, undefined, 'no Authorization on ' + x.g));
  seen.filter(x => x.p === '/rest/v1/user_state').forEach(x => assert.ok(/^Bearer at\d+$/.test(x.auth), String(x.auth)));
  const lo = seen.find(x => x.p === '/auth/v1/logout'); assert.strictEqual(lo.auth, 'Bearer ' + tok);
});

test('39 a cloud row older than the base (deleted and recreated) is not merged against the stale base', async () => {
  const srv = fakeSupabase(); const A = await signedIn(srv); const h = habitId(A);
  tick(A, h, D1); await A.sync.syncNow(); assert.strictEqual(srv.S.rows.u1.version, 2);
  const other = fakeSupabase(); const C = await signedIn(other); tick(C, habitId(C), D3); await C.sync.syncNow();
  srv.S.rows.u1 = { data: J(other.S.rows.u1.data), version: 1 };     // restored / recreated: version went DOWN
  const cloudBefore = JSON.stringify(srv.S.rows.u1);
  assert.strictEqual(await A.sync.syncNow(), 'error');               // background: must not merge silently
  assert.strictEqual(A.sync.status().state, 'attention'); assert.ok(/tap Sync now/.test(A.sync.status().message));
  assert.strictEqual(JSON.stringify(srv.S.rows.u1), cloudBefore);
  assert.strictEqual(logsOf(A)[h][D1], true);
});

/* a never-settling promise would otherwise end the process silently with exit code 0 */
let finished = false;
process.on('exit', code => { if (!finished && !code) { console.log('  FAIL tests did not finish (a promise never settled): ' + (pass + fail) + ' of ' + tests.length + ' ran'); process.exitCode = 1; } });
setTimeout(() => { console.log('  FAIL watchdog: tests did not finish within 60 s'); process.exit(1); }, 60000).unref();

/* ---- storage that the browser blocks: merely reading window.localStorage throws ---- */
test('safeStorage returns window.localStorage when it works', async () => {
  const d = device(fakeSupabase());
  assert.strictEqual(d.ctx.SyncEngine.safeStorage({ localStorage: d.ctx.localStorage }), d.ctx.localStorage);
});
test('safeStorage falls back to an in-memory shim when reading window.localStorage throws', async () => {
  const d = device(fakeSupabase());
  const win = {}; Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const st = d.ctx.SyncEngine.safeStorage(win);
  assert.strictEqual(st.getItem('a'), null);
  st.setItem('a', 1); assert.strictEqual(st.getItem('a'), '1');
  st.removeItem('a'); assert.strictEqual(st.getItem('a'), null);
  // a null/undefined localStorage (some embedded browsers) is treated the same way
  assert.strictEqual(d.ctx.SyncEngine.safeStorage({ localStorage: null }).getItem('x'), null);
});
test('an engine over the shim signs in and syncs for the session (blocked storage must not break it)', async () => {
  const srv = fakeSupabase(); const d = device(srv);
  const win = {}; Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const sync = d.ctx.SyncEngine.create({ fetch: srv.fetchImpl, storage: d.ctx.SyncEngine.safeStorage(win), store: d.store, merge: d.ctx.Merge,
    config: { url: BASE, anonKey: 'anon' }, askFirstConnect: async () => null,
    setTimeout, clearTimeout });
  await sync.signIn('me@x.com', 'pw');
  assert.strictEqual(sync.isSignedIn(), true);
  assert.strictEqual(sync.status().state, 'idle');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  finished = true;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== tests.length) { console.log('  FAIL ran ' + (pass + fail) + ' of ' + tests.length + ' tests'); process.exit(1); }
  if (fail) process.exit(1);
  console.log('sync ok');
})();
