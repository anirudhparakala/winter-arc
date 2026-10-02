/* ============================================================
   sync.js — Supabase sync engine (plain fetch, no library).
   Every external thing (fetch, storage, store, merge, timers) is injected so
   tools/test-sync.js can drive it against a fake server. See the cloud-sync spec.

   Known limits (accepted):
   - Two tabs sharing one storage are only coordinated for the token refresh; reloading on a
     `storage` event is the UI task's job.
   - A write whose reply was lost is recognised on the next run through the in-flight record. Window left:
     the server applied our push, the reply was lost AND another device pushed before we retried; then a
     change that device made to the same item can be undone once and freeze tokens can drift by about one.
     Data always converges; nothing is duplicated or stuck.
   - jsonb does not keep key order; irrelevant because Merge.equal ignores order.

   syncNow({interactive:true}) may open the first-connect dialog (Sync now button, sign-in);
   plain syncNow() (debounce, visibility, polling) never asks.
   ============================================================ */
(function (root) {
  'use strict';

  const SESSION_KEY = 'winterArc.sync';
  const BASE_KEY = 'winterArc.sync.base';
  const INFLIGHT_KEY = 'winterArc.sync.inflight';   // {userId, version, data}: a write whose reply we may not have seen
  const REFRESH_MARGIN_MS = 60000;
  const DEBOUNCE_MS = 3000;
  const MAX_ATTEMPTS = 4;
  const FETCH_TIMEOUT_MS = 25000;
  const BUSY_MSG = 'Supabase is busy — will retry';
  const BAD_DATA_MSG = 'Cloud data could not be applied — nothing was changed';
  const CHOOSE_MSG = 'Choose how to connect this device — tap Sync now';

  class NetError extends Error {}
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  /** the user has to do something (sign in again, pick a connect option, fix setup) */
  class AttentionError extends Error {}
  /** the work belongs to a sign-in that has since ended (sign-out / another sign-in): drop it silently */
  class Stale extends Error {}

  function create(deps) {
    const fx = deps.fetch, storage = deps.storage, store = deps.store, merge = deps.merge;
    const config = deps.config || {};
    const now = deps.now || Date.now;
    const setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout;
    const fetchTimeoutMs = deps.fetchTimeoutMs || FETCH_TIMEOUT_MS;
    const listeners = [];
    let running = null, again = false, againInteractive = false, timer = null;
    let gen = 0;                       // bumped by signIn/signOut; work started under an older value is discarded
    const guard = () => { const g = gen; return () => { if (g !== gen) throw new Stale(); }; };

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
    /** one request, with a timeout so a request that never answers cannot wedge the engine */
    async function http(method, path, o) {
      const opt = o || {};
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      let tid = null;
      const work = (async () => {
        const res = await fx(config.url.replace(/\/+$/, '') + path, {
          method,
          // apikey always (works for the legacy anon JWT and the newer sb_publishable_ keys); Authorization only
          // with a real user token, because a publishable key is not a JWT and must not be sent as a Bearer
          headers: Object.assign({ apikey: config.anonKey, 'Content-Type': 'application/json' },
            opt.token ? { Authorization: 'Bearer ' + opt.token } : {}, opt.prefer ? { Prefer: opt.prefer } : {}),
          body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
          signal: ctl ? ctl.signal : undefined
        });
        let json = null;
        try { json = await res.json(); } catch (e) { /* empty or non-JSON body */ }
        return { status: res.status, ok: res.ok, json };
      })();
      const timeout = new Promise((resolve, reject) => {
        tid = setT(() => { try { if (ctl) ctl.abort(); } catch (e) { /* ignore */ } reject(new Error('timeout')); }, fetchTimeoutMs);
      });
      try { return await Promise.race([work, timeout]); }
      catch (e) { throw new NetError("Can't reach Supabase — changes are saved on this device"); }
      finally { if (tid !== null) clearT(tid); }
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
    function dropTokens() { const s = readJSON(SESSION_KEY) || {}; writeJSON(SESSION_KEY, { email: s.email || null, userId: s.userId || null }); }

    async function refresh(s) {
      const live = guard();
      const r = await http('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken } });
      live();
      if (r.status >= 500 || r.status === 429) throw httpErr(r);
      if (!r.ok) {
        const cur = readJSON(SESSION_KEY);                 // another tab may have rotated the token already
        if (cur && cur.accessToken && cur.refreshToken && cur.refreshToken !== s.refreshToken) return cur;
        dropTokens(); throw new AttentionError('Sign in again');
      }
      if (!r.json || !r.json.access_token) throw new HttpError(502, 'Unexpected reply');
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
      if (!Array.isArray(r.json)) throw new HttpError(502, 'Unexpected reply');   // never mistake junk for "no row"
      return r.json[0] || null;
    }
    /* In-flight record: before every write we note what we are about to send. If the reply is lost
       (network error, timeout, 5xx) the server may or may not have applied it; the next run compares the
       row with this record and, if it matches, adopts it as the base. Without it a later reversal of that
       very edit (un-tick, delete) would look like "unchanged locally, changed remotely" and be undone.
       Definitive answers (CAS miss, 409, 4xx) clear it. */
    const clearInflight = () => drop(INFLIGHT_KEY);
    const setInflight = (userId, version, data) => writeJSON(INFLIGHT_KEY, { userId, version, data });
    const refused = r => { if (r.status < 500) clearInflight(); return httpErr(r); };
    async function insertRow(s, data) {
      setInflight(s.userId, 1, data);
      const r = await api('POST', '/rest/v1/user_state', { body: { user_id: s.userId, data, version: 1 }, prefer: 'return=representation' });
      if (r.status === 409) { clearInflight(); return false; }
      if (!r.ok) throw refused(r);
      if (r.status === 201 || (Array.isArray(r.json) && r.json.length === 1)) return true;
      throw new HttpError(502, 'Unexpected reply');                 // ambiguous: keep the record
    }
    /** compare-and-set: true only if the row still had `fromVersion` */
    async function pushCAS(s, data, fromVersion) {
      setInflight(s.userId, fromVersion + 1, data);
      const r = await api('PATCH', '/rest/v1/user_state?user_id=eq.' + enc(s.userId) + '&version=eq.' + fromVersion,
        { body: { data, version: fromVersion + 1, updated_at: new Date(now()).toISOString() }, prefer: 'return=representation' });
      if (!r.ok) throw refused(r);
      const ok = Array.isArray(r.json) && r.json.length === 1;
      if (!ok) clearInflight();
      return ok;
    }

    /** a base belongs to one account; one without (or with another) userId counts as no base */
    function readBase(userId) {
      const b = readJSON(BASE_KEY);
      return b && userId && b.userId === userId && typeof b.version === 'number' && b.data ? b : null;
    }
    const saveBase = (userId, version, data) => { writeJSON(BASE_KEY, { userId, version, data }); clearInflight(); };   // a confirmed state supersedes any in-flight note

    /* ---------- one sync pass ---------- */
    async function run(live, interactive) {
      const s = await ensureSession(); live();
      // "base" = the last state both sides agreed on. Once we apply a merge locally, local already
      // contains the remote's changes, so the base advances to that remote (and is persisted at once):
      // a failed or lost push must never make the next run merge against the old base, because
      // Merge.three applies deltas to freezeTokens and would count the remote's spend twice.
      let base = readBase(s.userId);
      const setBase = (version, data) => { saveBase(s.userId, version, data); base = { version, data }; };
      let chosen = null;                                   // the first-connect answer survives a lost race
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const row = await getRow(s); live();
        const pending = readJSON(INFLIGHT_KEY);
        if (pending) {
          if (pending.userId === s.userId && row && row.version === pending.version && merge.equal(row.data, pending.data)) {
            setBase(row.version, row.data);              // our earlier push DID land (its reply was lost): that is the base now
          } else clearInflight();                        // it did not land, or somebody else wrote since: normal merge
        }
        const local = store.snapshot();
        if (!row) {
          const ok = await insertRow(s, local); live();
          if (ok) { setBase(1, local); return 'uploaded'; }
          continue;
        }
        if (!merge.isState(row.data)) throw new AttentionError('The cloud data looks unreadable — nothing was changed');
        if (base && row.version < base.version) base = null;   // the cloud row was deleted/recreated or restored: our base is meaningless
        if (!base) {
          if (merge.isPristine(local)) { store.applySynced(row.data); setBase(row.version, store.snapshot()); return 'downloaded'; }
          if (merge.isPristine(row.data)) {
            const ok = await pushCAS(s, local, row.version); live();
            if (ok) { setBase(row.version + 1, local); return 'uploaded'; }
            continue;
          }
          if (!chosen) {
            if (!interactive) throw new AttentionError(CHOOSE_MSG);   // background triggers never open the dialog
            chosen = deps.askFirstConnect ? await deps.askFirstConnect() : null; live();
            if (!chosen) throw new AttentionError(CHOOSE_MSG);
            attempt--; continue;                                      // the user may have edited meanwhile: re-read both sides
          }
          if (chosen === 'cloud') { store.applySynced(row.data); setBase(row.version, store.snapshot()); return 'downloaded'; }
          if (chosen === 'device') {
            const ok = await pushCAS(s, local, row.version); live();
            if (ok) { setBase(row.version + 1, local); return 'uploaded'; }
            continue;
          }
          store.applySynced(merge.firstConnect(local, row.data));     // 'merge'
          setBase(row.version, row.data);                             // local now includes the cloud copy
          const data = store.snapshot();
          const ok = await pushCAS(s, data, row.version); live();
          if (ok) { setBase(row.version + 1, data); return 'merged'; }
          continue;
        }
        if (row.version === base.version) {
          if (merge.equal(local, base.data)) return 'clean';
          const ok = await pushCAS(s, local, row.version); live();
          if (ok) { setBase(row.version + 1, local); return 'pushed'; }
          continue;
        }
        const merged = merge.three(base.data, local, row.data);
        let data = merged;
        if (!merge.equal(merged, local)) { store.applySynced(merged); data = store.snapshot(); }
        if (merge.equal(data, row.data)) { setBase(row.version, data); return 'pulled'; }
        setBase(row.version, row.data);                               // local now includes this remote
        const ok = await pushCAS(s, data, row.version); live();
        if (ok) { setBase(row.version + 1, data); return 'merged'; }
      }
      throw new HttpError(409, BUSY_MSG);
    }

    function report(e) {
      if (e instanceof NetError) return setStatus({ state: 'pending', message: e.message });
      if (e instanceof AttentionError) return setStatus({ state: 'attention', message: e.message });
      if (e instanceof HttpError && (e.status >= 500 || e.status === 429 || e.status === 409))
        return setStatus({ state: 'pending', message: 'Supabase is busy — will retry (' + e.status + ')' });
      if (e instanceof HttpError) return setStatus({ state: 'attention', message: 'Setup problem: ' + e.message });
      return setStatus({ state: 'attention', message: BAD_DATA_MSG });   // never show raw exception text
    }

    /** opts.interactive: this call may open the first-connect dialog (Sync now button, sign-in).
        Background triggers (debounce, visibility, polling) call syncNow() with no options and never ask. */
    function syncNow(opts) {
      if (!configured() || !hasSession()) return Promise.resolve('skipped');
      const wantAsk = !!(opts && opts.interactive);
      if (running) { again = true; if (wantAsk) againInteractive = true; return running; }
      let interactive = wantAsk;
      running = (async () => {
        let out = 'clean';
        try {
          do {
            again = false;
            if (!configured() || !hasSession()) { out = 'skipped'; break; }
            const g = gen, live = guard(), ask = interactive || againInteractive;
            interactive = false; againInteractive = false;
            setStatus({ state: 'syncing', message: 'Syncing…' });
            try { out = await run(live, ask); }
            catch (e) {
              if (g !== gen) { out = 'skipped'; continue; }          // signed out / re-signed in meanwhile
              if (againInteractive) continue;                        // an interactive request arrived mid-run: honour it with another pass
              throw e;
            }
            if (g !== gen) { out = 'skipped'; continue; }
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
      if (!r.ok || !r.json || !r.json.access_token) {
        const code = String((r.json && (r.json.error_code || r.json.error)) || '');
        if ((r.status === 400 || r.status === 401) && /invalid_grant|invalid_credentials/.test(code)) throw new Error('Wrong email or password');
        throw new Error(r.status === 429 ? 'Too many attempts — wait a minute and try again' : 'Sign-in failed (' + r.status + ')');
      }
      gen++;                                               // anything still running belongs to the previous sign-in
      const prev = readJSON(SESSION_KEY);
      if (prev && prev.userId && r.json.user && prev.userId !== r.json.user.id) { drop(BASE_KEY); clearInflight(); }   // another account: its base is not ours
      saveSession(r.json, email);
      setStatus({ state: 'idle', message: 'Signed in', email });
      return syncNow({ interactive: true });
    }

    async function signOut() {
      gen++;
      const s = readJSON(SESSION_KEY);
      drop(SESSION_KEY); drop(BASE_KEY); clearInflight();
      setStatus({ state: configured() ? 'signedOut' : 'unconfigured', message: 'Signed out', email: null, lastSyncedAt: null });
      if (s && s.accessToken && configured()) { try { await http('POST', '/auth/v1/logout?scope=local', { token: s.accessToken }); } catch (e) { /* offline: already signed out locally */ } }
    }

    /** used after Reset: make the cloud copy equal this device, whatever the cloud holds */
    async function overwriteCloud() {
      if (!configured() || !hasSession()) return false;
      const live = guard();                                // taken BEFORE waiting, so a sign-out during the wait is noticed
      try {
        if (running) await running;
        live();
        const s = await ensureSession(); live();
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          const row = await getRow(s); live();
          const local = store.snapshot();
          const done = () => { saveBase(s.userId, row ? row.version + 1 : 1, local); setStatus({ state: 'idle', message: 'Synced', lastSyncedAt: now() }); return true; };
          if (!row) { const ok = await insertRow(s, local); live(); if (ok) return done(); continue; }
          const ok = await pushCAS(s, local, row.version); live();
          if (ok) return done();
        }
        throw new HttpError(409, BUSY_MSG);
      } catch (e) { if (e instanceof Stale) return false; report(e); return false; }
    }

    return { status: () => st, onStatus: fn => listeners.push(fn), isConfigured: configured, isSignedIn: hasSession,
             signIn, signOut, syncNow, notifyLocalChange, overwriteCloud };
  }

  /** window.localStorage, or a tiny in-memory stand-in when the browser blocks storage
      (merely reading the property can throw a SecurityError) */
  function safeStorage(win) {
    try { const s = win && win.localStorage; if (s) return s; } catch (e) { /* blocked */ }
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
  }

  root.SyncEngine = { create, safeStorage };
})(typeof window !== 'undefined' ? window : globalThis);
