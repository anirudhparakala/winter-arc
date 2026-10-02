/* Dev-only mock of the Supabase endpoints the sync engine uses (no dependencies).
   Run: node tools/mock-supabase.js [port]   (default 54321; env MOCK_TTL = access-token seconds, default 3600)
        node tools/mock-supabase.js --selftest
   Users: me@example.com / hunter2 (user-1), other@example.com / hunter3 (user-2).
   Control endpoints (no auth, dev only):
     POST /__offline?on=1|0  answer every other request with 503 while on
     POST /__expire          invalidate all access tokens (refresh tokens stay valid)
     POST /__expire-refresh  invalidate refresh tokens too
     GET  /__row?user=user-1 the current row;  POST /__reset wipes rows and tokens
     POST /__bump?user=user-1 simulate another device pushing (version+1, one extra logged day) */
const http = require('http');

const USERS = { 'me@example.com': { id: 'user-1', password: 'hunter2' }, 'other@example.com': { id: 'user-2', password: 'hunter3' } };
const TTL = Number(process.env.MOCK_TTL) || 3600;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, prefer, x-client-info',
               'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS' };

function createServer() {
  const S = { rows: {}, tokens: {}, refresh: {}, offline: false, n: 0, bumps: 0 };
  const mint = uid => { const a = 'at' + (++S.n), r = 'rt' + S.n; S.tokens[a] = uid; S.refresh[r] = uid;
    return { access_token: a, refresh_token: r, token_type: 'bearer', expires_in: TTL, user: { id: uid } }; };

  function handle(req, res, raw) {
    const send = (status, json) => {
      if (json === undefined) { res.writeHead(status, CORS); return res.end(); }   // 204 etc: no body
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, CORS)); res.end(JSON.stringify(json));
    };
    const u = new URL(req.url, 'http://x'), p = u.pathname, q = k => u.searchParams.get(k);
    if (req.method === 'OPTIONS') return send(204);
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
    if (S.offline) return send(503, { message: 'offline (mock)' });
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (e) { return send(400, { message: 'bad json' }); }
    if (p === '/auth/v1/token') {
      if (q('grant_type') === 'password') {
        const us = body && USERS[body.email]; if (!us || us.password !== body.password) return send(400, { error: 'invalid_grant' });
        return send(200, mint(us.id));
      }
      const uid = body && S.refresh[body.refresh_token]; if (!uid) return send(400, { error: 'invalid_grant' });
      delete S.refresh[body.refresh_token]; return send(200, mint(uid));            // rotation
    }
    if (p === '/auth/v1/logout') return send(204);
    if (p === '/rest/v1/user_state') {
      const uid = S.tokens[(req.headers.authorization || '').replace('Bearer ', '')];
      if (!uid) return send(401, { message: 'JWT expired' });
      const want = k => (q(k) || '').replace(/^eq\./, ''), r = S.rows[uid];
      if (req.method === 'GET') return send(200, r ? [{ data: r.data, version: r.version }] : []);
      if (req.method === 'POST') {
        if (r) return send(409, { code: '23505', message: 'duplicate key' });
        S.rows[uid] = { data: body.data, version: body.version }; return send(201, [body]);
      }
      if (req.method === 'PATCH') {
        if (!r || String(r.version) !== want('version')) return send(200, []);
        S.rows[uid] = { data: body.data, version: body.version }; return send(200, [S.rows[uid]]);
      }
    }
    send(404, { message: 'not found' });
  }
  return http.createServer((req, res) => { let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => handle(req, res, raw)); });
}

if (process.argv.includes('--selftest')) {
  const assert = require('assert'), srv = createServer();
  srv.listen(0, async () => {
    const base = 'http://localhost:' + srv.address().port;
    const call = async (method, path, o = {}) => {
      const r = await fetch(base + path, { method, headers: Object.assign({ 'Content-Type': 'application/json', apikey: 'anon' }, o.token ? { Authorization: 'Bearer ' + o.token } : {}),
        body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : undefined, headers: r.headers };
    };
    try {
      assert.strictEqual((await call('POST', '/auth/v1/token?grant_type=password', { body: { email: 'me@example.com', password: 'bad' } })).status, 400);
      const si = await call('POST', '/auth/v1/token?grant_type=password', { body: { email: 'me@example.com', password: 'hunter2' } });
      assert.strictEqual(si.status, 200); const tok = si.json.access_token; assert.strictEqual(si.json.user.id, 'user-1');
      assert.strictEqual(si.headers.get('access-control-allow-origin'), '*');
      assert.strictEqual((await call('GET', '/rest/v1/user_state?user_id=eq.user-1')).status, 401);
      assert.deepStrictEqual((await call('GET', '/rest/v1/user_state?user_id=eq.user-1', { token: tok })).json, []);
      const row = { user_id: 'user-1', data: { habits: [{ id: 'h1' }], logs: {} }, version: 1 };
      assert.strictEqual((await call('POST', '/rest/v1/user_state', { token: tok, body: row })).status, 201);
      assert.strictEqual((await call('POST', '/rest/v1/user_state', { token: tok, body: row })).status, 409);
      const patch = v => call('PATCH', '/rest/v1/user_state?user_id=eq.user-1&version=eq.' + v, { token: tok, body: { data: { habits: [{ id: 'h1' }], logs: { h1: { d: true } } }, version: v + 1 } });
      assert.strictEqual((await patch(1)).json.length, 1);
      assert.deepStrictEqual((await patch(1)).json, []);                           // stale version loses
      const got = (await call('GET', '/rest/v1/user_state?user_id=eq.user-1', { token: tok })).json;
      assert.strictEqual(got[0].version, 2); assert.strictEqual(got[0].data.logs.h1.d, true);
      const rf = await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: si.json.refresh_token } });
      assert.strictEqual(rf.status, 200);
      assert.strictEqual((await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: si.json.refresh_token } })).status, 400);   // rotated
      await call('POST', '/__expire');
      assert.strictEqual((await call('GET', '/rest/v1/user_state?user_id=eq.user-1', { token: tok })).status, 401);
      await call('POST', '/__offline?on=1'); assert.strictEqual((await call('POST', '/auth/v1/logout?scope=local')).status, 503); await call('POST', '/__offline?on=0');
      const lo = await call('POST', '/auth/v1/logout?scope=local'); assert.strictEqual(lo.status, 204); assert.strictEqual(lo.json, undefined);
      assert.strictEqual((await call('POST', '/__bump?user=user-1')).json.version, 3);
      assert.strictEqual((await call('OPTIONS', '/rest/v1/user_state')).status, 204);
      console.log('mock-supabase selftest ok'); srv.close(); process.exit(0);
    } catch (e) { console.error('selftest FAILED', e); process.exit(1); }
  });
} else if (require.main === module) {
  const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a))) || 54321;
  createServer().listen(port, () => console.log('mock supabase on http://localhost:' + port));
}
module.exports = { createServer };
