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
  const T = { patchFail: null, patchEmpty: false, junk: false, hang: false, holdGet: null, holdRefresh: null, signIn: null };
  const resp = (status, json) => ({ status, ok: status >= 200 && status < 300, json: async () => json });
  const fetchImpl = async (url, init) => {
    const u = new URL(url), rest = u.pathname === '/rest/v1/user_state', m = init.method;
    if (rest && m === 'PATCH' && T.patchFail) {
      srv.S.calls.push('PATCH ' + u.pathname);
      if (T.patchFail === 'net') throw new TypeError('Failed to fetch');
      return resp(T.patchFail, { message: 'boom' });
    }
    if (rest && m === 'PATCH' && T.patchEmpty) { srv.S.calls.push('PATCH ' + u.pathname); return resp(200, []); }
    if (rest && T.junk && (m === 'GET' || m === 'POST')) { srv.S.calls.push(m + ' ' + u.pathname); return { status: 200, ok: true, json: async () => { throw new Error('not json'); } }; }
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

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log('sync ok');
})();
