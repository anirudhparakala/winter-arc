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
      // Working base: the stored base, advanced to the remote we merged against whenever we applied a
      // merge locally and then lost the compare-and-set race. Local now contains that remote's
      // changes, so re-merging against the ORIGINAL base would count its freeze-token spend twice
      // (Merge.three applies deltas to freezeTokens). The PERSISTED base changes only on success.
      let workBase = readJSON(BASE_KEY);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const row = await getRow(s);
        const local = store.snapshot();
        if (!row) {
          if (await insertRow(s, local)) { saveBase(1, local); return 'uploaded'; }
          continue;
        }
        if (!merge.isState(row.data)) throw new AttentionError('The cloud data looks unreadable — nothing was changed');
        const base = workBase;
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
        workBase = { version: row.version, data: row.data };             // lost the race: local now includes this remote
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

    /** called from Store.commit's change listener — must never throw */
    function notifyLocalChange() {
      try {
        if (!configured() || !hasSession()) return;
        if (timer) clearT(timer);
        timer = setT(() => { timer = null; syncNow(); }, DEBOUNCE_MS);
      } catch (e) { /* a sync hiccup must never break saving */ }
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
