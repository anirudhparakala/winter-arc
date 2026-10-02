/* Dev-only mock of the Supabase endpoints the sync engine uses (no dependencies).
   Run: node tools/mock-supabase.js [port]   (default 54321; listens on 127.0.0.1 ONLY)
        node tools/mock-supabase.js --selftest
   Users: me@example.com / hunter2 (user-1), other@example.com / hunter3 (user-2).
   MOCK_TTL (env, seconds, default 3600) only changes the reported expires_in; access tokens are
   invalidated only through /__expire.
   Control endpoints (dev only) are POST (GET for /__row) and need the header `X-Mock-Control: 1`.
   That header is deliberately NOT allowed in CORS preflights, so no web page can call them; the
   test driver sends it from Node / curl / Playwright's request API:
     POST /__offline?on=1|0  answer every other request with 503 while on
     POST /__expire          invalidate all access tokens (refresh tokens stay valid)
     POST /__expire-refresh  invalidate refresh tokens too
     GET  /__row?user=user-1 the current row;  POST /__reset wipes rows and tokens
     POST /__bump?user=user-1 simulate another device pushing (version+1, one extra logged day)
   Fidelity to real Supabase: apikey required, return=representation honoured (204 / empty 201
   without it), row-level security (own rows only), GoTrue-style error bodies. */
const http = require('http');

const USERS = { 'me@example.com': { id: 'user-1', password: 'hunter2' }, 'other@example.com': { id: 'user-2', password: 'hunter3' } };
const TTL = Number(process.env.MOCK_TTL) || 3600;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-client-info',
               'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' };
const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);

function createServer() {
  const S = { rows: {}, tokens: {}, refresh: {}, offline: false, n: 0, bumps: 0 };
  const mint = uid => { const a = 'at' + (++S.n), r = 'rt' + S.n; S.tokens[a] = uid; S.refresh[r] = uid;
    return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: TTL, user: { id: uid } }; };

  function handle(req, res, raw) {
    const send = (status, json) => {
      if (json === undefined) { res.writeHead(status, CORS); return res.end(); }   // 204 etc: no body
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(JSON.stringify(json));
    };
    const u = new URL(req.url, 'http://x'), p = u.pathname, q = k => u.searchParams.get(k), m = req.method;
    if (m === 'OPTIONS') return send(204);
    if (p.startsWith('/__')) {
      if (req.headers['x-mock-control'] !== '1') return send(403, { message: 'missing X-Mock-Control header' });
      if (m !== (p === '/__row' ? 'GET' : 'POST')) return send(405, { message: 'method not allowed' });
      if (p === '/__offline') { S.offline = q('on') === '1'; return send(200, { offline: S.offline }); }
      if (p === '/__expire') { S.tokens = {}; return send(200, { ok: true }); }
      if (p === '/__expire-refresh') { S.tokens = {}; S.refresh = {}; return send(200, { ok: true }); }
      if (p === '/__reset') { S.rows = {}; S.tokens = {}; S.refresh = {}; S.bumps = 0; return send(200, { ok: true }); }
      if (p === '/__row') return send(200, S.rows[q('user') || 'user-1'] || null);
      if (p === '/__bump') {
        const uid = q('user') || 'user-1', r = S.rows[uid]; if (!r) return send(404, { message: 'no row' });
        const hs = r.data.habits || [], id = hs[0] && hs[0].id; if (!id) return send(409, { message: 'no habit' });
        r.data.logs = r.data.logs || {}; (r.data.logs[id] = r.data.logs[id] || {})['2020-01-' + String(++S.bumps).padStart(2, '0')] = true;
        r.version++; return send(200, r);
      }
      return send(404, { message: 'not found' });
    }
    if (S.offline) return send(503, { message: 'offline (mock)' });
    const isAuth = p.startsWith('/auth/v1/');
    if ((isAuth || p.startsWith('/rest/v1/')) && !req.headers.apikey)
      return send(401, isAuth ? { msg: 'No API key found in request' } : { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
    let body; try { body = raw ? JSON.parse(raw) : undefined; } catch (e) { return send(400, { message: 'invalid body' }); }
    if (p === '/auth/v1/token') {
      if (!isObj(body)) return send(400, { code: 400, error_code: 'validation_failed', msg: 'invalid body' });
      if (q('grant_type') === 'password') {
        const us = USERS[body.email]; if (!us || us.password !== body.password) return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return send(200, mint(us.id));
      }
      const uid = S.refresh[body.refresh_token];
      if (!uid) return send(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      delete S.refresh[body.refresh_token]; return send(200, mint(uid));            // rotation
    }
    if (p === '/auth/v1/logout') return send(204);
    if (p === '/rest/v1/user_state') {
      const uid = S.tokens[(req.headers.authorization || '').replace('Bearer ', '')];
      if (!uid) return send(401, { code: 'PGRST301', message: 'JWT expired' });
      const want = (q('user_id') || 'eq.' + uid).replace(/^eq\./, ''), mine = want === uid;   // row-level security: own row only
      const rep = /return=representation/.test(req.headers.prefer || ''), r = mine ? S.rows[uid] : undefined;
      if (m === 'GET') return send(200, r ? [{ data: r.data, version: r.version }] : []);
      if (m === 'POST' || m === 'PATCH') {
        if (!isObj(body) || !isObj(body.data) || typeof body.version !== 'number') return send(400, { message: 'invalid body' });
        if (m === 'POST') {
          if (body.user_id !== undefined && body.user_id !== uid) return send(403, { code: '42501', message: 'new row violates row-level security policy for table "user_state"' });
          if (S.rows[uid]) return send(409, { code: '23505', message: 'duplicate key value violates unique constraint "user_state_pkey"' });
          S.rows[uid] = { data: body.data, version: body.version }; return rep ? send(201, [Object.assign({ user_id: uid }, S.rows[uid])]) : send(201);
        }
        const hit = !!r && String(r.version) === (q('version') || '').replace(/^eq\./, '');
        if (hit) S.rows[uid] = { data: body.data, version: body.version };
        return rep ? send(200, hit ? [S.rows[uid]] : []) : send(204);
      }
    }
    send(404, { message: 'not found' });
  }
  return http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      try { handle(req, res, raw); }
      catch (e) { if (!res.headersSent) { res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(JSON.stringify({ message: String(e && e.message) })); } else res.end(); }
    });
  });
}

if (process.argv.includes('--selftest')) {
  const assert = require('assert'), srv = createServer();
  srv.listen(0, '127.0.0.1', async () => {
    assert.strictEqual(srv.address().address, '127.0.0.1');                         // never all interfaces
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (method, path, o = {}) => {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, o.noKey ? {} : { apikey: 'anon' },
        o.token ? { Authorization: 'Bearer ' + o.token } : {}, o.prefer ? { Prefer: o.prefer } : {},
        path.startsWith('/__') && !o.noCtl ? { 'X-Mock-Control': '1' } : {}, o.headers || {});
      const r = await fetch(base + path, { method, headers, body: o.raw !== undefined ? o.raw : o.body === undefined ? undefined : JSON.stringify(o.body) });
      const t = await r.text(); return { status: r.status, text: t, json: t ? JSON.parse(t) : undefined, headers: r.headers };
    };
    const R = 'return=representation', U1 = '/rest/v1/user_state?user_id=eq.user-1';
    const login = async (email, password) => (await call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } })).json;
    try {
      // ---- auth
      const bad = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: 'me@example.com', password: 'bad' } });
      assert.strictEqual(bad.status, 400);
      assert.deepStrictEqual(bad.json, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      const si = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: 'me@example.com', password: 'hunter2' } });
      assert.strictEqual(si.status, 200); const tok = si.json.access_token; assert.strictEqual(si.json.user.id, 'user-1');
      assert.strictEqual(si.headers.get('access-control-allow-origin'), '*');
      const nokey = await call('POST', '/auth/v1/token?grant_type=password', { noKey: true, body: { email: 'me@example.com', password: 'hunter2' } });
      assert.strictEqual(nokey.status, 401); assert.strictEqual(nokey.json.msg, 'No API key found in request');
      assert.strictEqual((await call('POST', '/auth/v1/logout?scope=local', { noKey: true })).status, 401);
      // ---- REST: apikey, JWT, RLS
      const noRest = await call('GET', U1, { noKey: true, token: tok });
      assert.strictEqual(noRest.status, 401); assert.strictEqual(noRest.json.message, 'No API key found in request');
      const noJwt = await call('GET', U1);
      assert.strictEqual(noJwt.status, 401); assert.deepStrictEqual(noJwt.json, { code: 'PGRST301', message: 'JWT expired' });
      assert.deepStrictEqual((await call('GET', U1, { token: tok })).json, []);
      const row = { user_id: 'user-1', data: { habits: [{ id: 'h1' }], logs: {} }, version: 1 };
      const foreign = await call('POST', '/rest/v1/user_state', { token: tok, body: Object.assign({}, row, { user_id: 'user-2' }), prefer: R });
      assert.strictEqual(foreign.status, 403); assert.strictEqual(foreign.json.code, '42501');
      assert.strictEqual((await call('POST', '/rest/v1/user_state', { token: tok, body: row })).status, 201);   // no Prefer: created, empty body
      const dup = await call('POST', '/rest/v1/user_state', { token: tok, body: row, prefer: R });
      assert.strictEqual(dup.status, 409); assert.strictEqual(dup.json.code, '23505');
      assert.strictEqual((await call('GET', U1, { token: tok })).json[0].version, 1);
      const patch = (v, pr, uid = 'user-1') => call('PATCH', '/rest/v1/user_state?user_id=eq.' + uid + '&version=eq.' + v,
        { token: tok, prefer: pr, body: { data: { habits: [{ id: 'h1' }], logs: { h1: { d: true } } }, version: v + 1 } });
      assert.deepStrictEqual((await patch(1, R, 'user-2')).json, []);                // RLS hides the other user's row
      assert.deepStrictEqual((await call('GET', '/rest/v1/user_state?user_id=eq.user-2', { token: tok })).json, []);
      const p1 = await patch(1, R); assert.strictEqual(p1.status, 200); assert.strictEqual(p1.json.length, 1); assert.strictEqual(p1.json[0].version, 2);
      assert.deepStrictEqual((await patch(1, R)).json, []);                          // stale version loses
      const p2 = await patch(2); assert.strictEqual(p2.status, 204); assert.strictEqual(p2.text, '');   // no Prefer: no content
      const got = (await call('GET', U1, { token: tok })).json;
      assert.strictEqual(got[0].version, 3); assert.strictEqual(got[0].data.logs.h1.d, true);
      // ---- bad bodies never crash the server
      const bodies = [undefined, 'null', '[]', '"x"', '{bad json', '{"data":1,"version":1}', '{"data":{},"version":"1"}', '{"user_id":"user-1","version":1}'];
      for (const raw of bodies) {
        for (const m of ['POST', 'PATCH']) {
          const r = await call(m, '/rest/v1/user_state' + (m === 'PATCH' ? '?user_id=eq.user-1&version=eq.3' : ''), { token: tok, raw, prefer: R });
          assert.strictEqual(r.status, 400, m + ' ' + raw + ' -> ' + r.status); assert.strictEqual(r.json.message, 'invalid body');
        }
      }
      for (const raw of ['null', '[]', '{bad json']) assert.strictEqual((await call('POST', '/auth/v1/token?grant_type=password', { raw })).status, 400);
      assert.strictEqual((await call('POST', '/auth/v1/token?grant_type=refresh_token', { raw: 'null' })).status, 400);
      assert.strictEqual((await call('GET', U1, { token: tok })).status, 200);       // still alive
      // ---- refresh rotation + shapes
      const rf = await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: si.json.refresh_token } });
      assert.strictEqual(rf.status, 200);
      const again = await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: si.json.refresh_token } });
      assert.strictEqual(again.status, 400);
      assert.deepStrictEqual(again.json, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      // ---- second user cannot see user-1's row
      const t2 = (await login('other@example.com', 'hunter3')).access_token;
      assert.deepStrictEqual((await call('GET', U1, { token: t2 })).json, []);
      // ---- control endpoints: POST + X-Mock-Control only, never from a cross-site simple request
      for (const p of ['/__offline?on=0', '/__expire', '/__expire-refresh', '/__reset', '/__bump?user=user-1']) {
        const g = await call('GET', p); assert.strictEqual(g.status, 405, 'GET ' + p);
        const nh = await call('POST', p, { noCtl: true }); assert.strictEqual(nh.status, 403, 'no header ' + p);
      }
      assert.strictEqual((await call('POST', '/__row?user=user-1')).status, 405);
      assert.strictEqual((await call('GET', '/__row?user=user-1', { noCtl: true })).status, 403);
      assert.strictEqual((await call('GET', '/__row?user=user-1')).json.version, 3);
      const pre = await call('OPTIONS', '/__reset', { headers: { 'Access-Control-Request-Headers': 'x-mock-control' } });
      assert.strictEqual(pre.status, 204); assert.ok(!/x-mock-control/i.test(pre.headers.get('access-control-allow-headers')));
      assert.ok(/apikey/.test(pre.headers.get('access-control-allow-headers')));
      assert.strictEqual((await call('POST', '/__bump?user=user-1')).json.version, 4);
      await call('POST', '/__expire');
      assert.strictEqual((await call('GET', U1, { token: tok })).status, 401);
      await call('POST', '/__offline?on=1'); assert.strictEqual((await call('POST', '/auth/v1/logout?scope=local')).status, 503); await call('POST', '/__offline?on=0');
      const lo = await call('POST', '/auth/v1/logout?scope=local'); assert.strictEqual(lo.status, 204); assert.strictEqual(lo.text, '');
      assert.strictEqual((await call('OPTIONS', '/rest/v1/user_state')).status, 204);
      console.log('mock-supabase selftest ok'); srv.close(); process.exit(0);
    } catch (e) { console.error('selftest FAILED', e); process.exit(1); }
  });
} else if (require.main === module) {
  const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a))) || 54321;
  createServer().listen(port, '127.0.0.1', () => console.log('mock supabase on http://localhost:' + port));
}
module.exports = { createServer };
