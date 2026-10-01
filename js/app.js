/* ============================================================
   app.js — routing, shell chrome, settings, backup
   ============================================================ */
(function () {
  'use strict';

  const PAGES = ['today', 'habits', 'tasks', 'goals', 'insights'];
  const view = document.getElementById('view');
  const nav = document.getElementById('nav');
  const clockEl = document.getElementById('clock');

  let page = 'today';
  let lastPage = null;
  let pendingFocus = null;
  let renderedDay = D.todayKey();   // the "today" the current view was drawn for

  /* ---------------- render ---------------- */
  function render() {
    const v = Views[page];
    renderedDay = D.todayKey();
    // keep the reader where they were across a state commit (the window scrolls now)
    // (scroll positions belong to a page: arriving from another one starts clean)
    const same = page === lastPage;
    const top = same ? window.scrollY : 0;
    const sx = view.querySelector('.scroll-x');
    const left = same && sx ? sx.scrollLeft : 0;

    document.title = v.title.charAt(0) + v.title.slice(1).toLowerCase() + ' · Winter Arc';
    view.innerHTML = '';
    v.render(view);

    // slide the new page in — only when the page changed, not on every state commit
    if (page !== lastPage) {
      view.classList.remove('enter');
      void view.offsetWidth;
      view.classList.add('enter');
      lastPage = page;
    }

    if (top) window.scrollTo(0, top);
    const sx2 = view.querySelector('.scroll-x');
    if (sx2 && left) sx2.scrollLeft = left;

    nav.querySelectorAll('.nav-btn').forEach(b =>
      b.classList.toggle('is-active', b.dataset.page === page));

    if (pendingFocus) {
      let t = null;
      try { t = view.querySelector(pendingFocus); } catch (e) { /* a stale selector must not break the render */ }
      pendingFocus = null;
      if (t) { t.focus(); if (t.setSelectionRange) t.setSelectionRange(99, 99); }
    }
  }

  function go(p) {
    if (!PAGES.includes(p) || p === page) return;
    page = p;
    location.hash = p;
    window.scrollTo(0, 0);
    render();
  }

  /* ---------------- chrome ---------------- */
  // an app resumed after midnight must not keep showing (and logging to) yesterday
  const tick = () => {
    clockEl.textContent = new Date().toTimeString().slice(0, 5);
    if (D.todayKey() !== renderedDay) render();
  };
  tick(); setInterval(tick, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  nav.addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (b) go(b.dataset.page);
  });
  window.addEventListener('hashchange', () => {
    const h = location.hash.replace('#', '');
    if (PAGES.includes(h) && h !== page) { page = h; render(); }
  });

  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!document.getElementById('modalRoot').hidden) return;   // shortcuts belong to the page, not an open dialog
    const i = parseInt(e.key, 10);
    if (i >= 1 && i <= PAGES.length) go(PAGES[i - 1]);
    if (e.key === 'n' || e.key === 'N') {
      if (page === 'habits') Views.habits.newHabit(null);
      if (page === 'goals') Views.goals.newGoal(null);
    }
  });

  /* ---------------- settings ---------------- */
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSettings() {
    const s = Store.state.settings;
    const a = Store.arc();
    UI.modal('Settings', `
      <label class="field"><span>Arc name</span>
        <input class="input" id="sName" maxlength="40" value="${esc(s.name)}"></label>
      <div class="field-row">
        <label class="field"><span>Arc starts</span>
          <input class="input" type="date" id="sStart" value="${esc(s.arcStart)}"></label>
        <label class="field"><span>Arc length (days)</span>
          <input class="input" type="number" id="sDays" min="1" max="3650" step="1" value="${s.arcDays}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Week starts on</span>
          <select class="select" id="sWeek">
            <option value="0"${s.weekStart === 0 ? ' selected' : ''}>Sunday</option>
            <option value="1"${s.weekStart === 1 ? ' selected' : ''}>Monday</option>
          </select></label>
        <label class="field"><span>Theme</span>
          <select class="select" id="sTheme">
            <option value="dark"${s.theme === 'dark' ? ' selected' : ''}>Dark</option>
            <option value="light"${s.theme === 'light' ? ' selected' : ''}>Light</option>
          </select></label>
      </div>
      <p class="muted" style="font-size:12px;margin:0 0 16px;line-height:1.55">
        Current arc: <b>${esc(a.start)}</b> → <b>${esc(a.end)}</b> · ${a.total} days ·
        ${a.left} left.${Store.memoryOnly
          ? '<br><b style="color:var(--warn)">This browser is blocking local storage — export a backup before you close the tab.</b>'
          : sync.isSignedIn()
            ? '<br>Saved on this device and synced to your cloud copy.'
            : '<br>Everything is saved in this browser only. Export a backup to move it to another device.'}
      </p>

      ${syncSectionHTML()}

      <div class="card-label" style="margin-bottom:8px">Your data</div>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" id="sExport">Export backup</button>
        <button class="btn btn-sm" id="sImport">Import backup</button>
        <input type="file" id="sFile" accept="application/json,.json" hidden>
        <button class="btn btn-sm btn-danger" id="sReset">Reset everything</button>
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" id="sSave">Save</button>
      </div>`, m => {
      m.querySelector('#sSave').onclick = () => {
        Store.commit(st => {
          st.settings.name = m.querySelector('#sName').value.trim() || 'Winter Arc';
          st.settings.arcStart = m.querySelector('#sStart').value || st.settings.arcStart;
          const days = parseInt(m.querySelector('#sDays').value, 10);
          st.settings.arcDays = Number.isInteger(days) && days >= 1 ? Math.min(3650, days) : 90;
          st.settings.weekStart = parseInt(m.querySelector('#sWeek').value, 10);
          st.settings.theme = m.querySelector('#sTheme').value;
        });
        applyTheme();
        UI.close();
      };
      m.querySelector('#sTheme').onchange = e => {
        document.documentElement.dataset.theme = e.target.value;
      };
      m.querySelector('#sExport').onclick = () => {
        download(`winter-arc-${D.todayKey()}.json`, Store.exportJSON());
        UI.toast('Backup downloaded.');
      };
      const file = m.querySelector('#sFile');
      m.querySelector('#sImport').onclick = () => file.click();
      file.onchange = () => {
        const f = file.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try { Store.importJSON(r.result); applyTheme(); UI.close(); UI.toast('Backup restored.'); }
          catch (err) { UI.toast(err.message || 'Could not read that file.'); }
        };
        r.readAsText(f);
      };
      m.querySelector('#sReset').onclick = () => {
        const signedIn = sync.isSignedIn();
        UI.confirm(signedIn
          ? 'Erase every habit, task, goal and logged day on this device AND in your cloud copy? Your other devices will be erased on their next sync.'
          : 'Erase every habit, task, goal and logged day on this device?', () => {
          Store.reset(); applyTheme(); UI.close(); UI.toast('Reset complete.');
          if (signedIn) sync.overwriteCloud();
        }, 'Erase everything');
      };

      // cloud sync controls
      const line = m.querySelector('#syLine');
      const inBtn = m.querySelector('#syIn');
      if (inBtn) {
        const email = m.querySelector('#syEmail'), pass = m.querySelector('#syPass');
        const submit = () => {
          if (inBtn.disabled) return;                       // Enter pressed again while signing in
          const e = email.value.trim(), p = pass.value;
          if (!e || !p) { showLine(line, 'Enter your email and password.', true); return; }
          inBtn.disabled = true; showLine(line, 'Signing in…');
          const asked = askCount;
          sync.signIn(e, p)
            // the first-connect dialog may have replaced Settings (and closed again): bring Settings back,
            // but never touch a modal the user opened meanwhile
            .then(() => { if (inBtn.isConnected || (askCount !== asked && modalIsClosed())) reopenSettings(); })
            .catch(err => { showLine(line, (err && err.message) || 'Sign-in failed', true); inBtn.disabled = false; });
        };
        inBtn.onclick = submit;
        [email, pass].forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } }));
      }
      const nowBtn = m.querySelector('#syNow');
      if (nowBtn) nowBtn.onclick = () => { if (!askOpen) sync.syncNow({ interactive: true }); };
      const outBtn = m.querySelector('#syOut');
      if (outBtn) outBtn.onclick = () => {
        outBtn.disabled = true;
        sync.signOut().then(() => { if (outBtn.isConnected) reopenSettings(); });
      };
    },
    // the theme select previews live — put it back if the dialog is dismissed
    () => applyTheme());
  }
  document.getElementById('settingsBtn').onclick = openSettings;

  function applyTheme() {
    document.documentElement.dataset.theme = Store.state.settings.theme || 'dark';
  }

  /* ---------------- boot ---------------- */
  window.App = {
    render,
    go,
    focusAfterRender(sel) { pendingFocus = sel; }
  };

  Store.subscribe(render);
  applyTheme();

  const hash = location.hash.replace('#', '');
  if (PAGES.includes(hash)) page = hash;
  render();

  if (Store.memoryOnly) {
    UI.toast('Local storage is blocked here — use Export backup to keep your data.');
  }

  /* ---------------- cloud sync ---------------- */
  let askOpen = false, askPending = null, askCount = 0;
  const modalIsClosed = () => document.getElementById('modalRoot').hidden;
  const reopenSettings = () => { if (!modalIsClosed()) UI.close(); openSettings(); };
  /** error text is announced at once (role=alert); the ordinary status line stays polite */
  function showLine(el, text, isError) {
    if (!el) return;
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.textContent = text;
  }

  /** the first-connect dialog: one at a time; backdrop / Esc / close resolves null (dismissed) */
  function askFirstConnect() {
    if (askOpen) {
      const showing = !document.getElementById('modalRoot').hidden &&
        document.getElementById('modalTitle').textContent === 'Connect this device';
      if (showing) return askPending;
      askOpen = false;                          // the dialog was replaced without closing: do not stay stuck
    }
    askOpen = true; askCount++;
    askPending = new Promise(resolve => {
      let done = false;
      const fin = v => { if (!done) { done = true; askOpen = false; askPending = null; resolve(v); } };
      UI.modal('Connect this device', `
        <p class="muted" style="margin:0 0 14px;line-height:1.6">Both this device and your cloud copy already have data. How should they be combined?</p>
        <div class="connect-choices">
          <button class="btn btn-primary" data-c="merge">Merge both (recommended)</button>
          <button class="btn" data-c="cloud">Use the cloud copy (replace this device)</button>
          <button class="btn btn-danger" data-c="device">Use this device (overwrite the cloud)</button>
        </div>`, m => {
        m.querySelectorAll('[data-c]').forEach(b => { b.onclick = () => { fin(b.dataset.c); UI.close(); }; });
      }, () => fin(null));
    });
    return askPending;
  }

  /** sync is optional: if it cannot start (blocked storage, a script that failed to load) the app
      carries on exactly as it does without sync, with an inert stand-in engine */
  function createSync() {
    try {
      return SyncEngine.create({
        fetch: (...a) => window.fetch(...a), storage: SyncEngine.safeStorage(window), store: Store, merge: Merge,
        config: window.SYNC_CONFIG || {}, askFirstConnect
      });
    } catch (err) {
      console.warn('Winter Arc: cloud sync is unavailable.', err);
      const st = { state: 'unconfigured', message: 'Not configured', lastSyncedAt: null, email: null };
      const none = () => Promise.resolve('skipped');
      return { status: () => st, onStatus() {}, isConfigured: () => false, isSignedIn: () => false,
               signIn: () => Promise.reject(new Error('Sync is not available')), signOut: none, syncNow: none,
               notifyLocalChange() {}, overwriteCloud: () => Promise.resolve(false) };
    }
  }
  const sync = createSync();
  window.Sync = sync;
  Store.onLocalChange(sync.notifyLocalChange);

  const dot = document.getElementById('syncDot');
  const DOT_LABEL = { idle: 'Synced', syncing: 'Syncing', pending: 'Waiting to sync', attention: 'Sync needs attention' };
  function paintDot(s) {
    const configured = sync.isConfigured();
    const signedIn = configured && sync.isSignedIn();
    // a session that was dropped ("Sign in again") must not fail silently: amber dot until the user signs in
    const needsSignIn = configured && !signedIn && s.state !== 'unconfigured' &&
      (s.state === 'attention' || (!!s.email && s.message === 'Sign in again'));
    const show = (signedIn && s.state !== 'signedOut' && s.state !== 'unconfigured') || needsSignIn;
    dot.hidden = !show;
    dot.className = 'sync-dot is-' + (needsSignIn ? 'attention' : s.state === 'syncing' ? 'idle' : s.state);
    const btn = document.getElementById('settingsBtn');
    const label = !show ? 'Settings' : 'Settings — ' + (needsSignIn ? 'Sign in again' : DOT_LABEL[s.state] || '');
    btn.setAttribute('aria-label', label); btn.title = label;
  }
  function timeAgo(t) {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 48 * 60 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  }
  function statusText(s) {
    if (s.state === 'syncing') return 'Syncing…';
    if (s.state === 'idle') return s.lastSyncedAt ? 'Synced ' + timeAgo(s.lastSyncedAt) : s.message;
    return s.message;
  }
  /** signed out: only a message that asks something of the user is worth showing */
  function signedOutText(s) {
    return s.state === 'attention' || s.state === 'pending' || s.message === 'Sign in again' ? s.message : '';
  }
  function syncSectionHTML() {
    const s = sync.status();
    if (!sync.isConfigured()) return `<div class="card-label" style="margin-bottom:8px">Cloud sync</div>
      <p class="muted" style="font-size:12px;margin:0 0 16px;line-height:1.55">Not set up. Add your Supabase project in <b>js/sync-config.js</b> (see README → Cloud sync) to use this app on several devices.</p>`;
    if (!sync.isSignedIn()) return `<div class="card-label" style="margin-bottom:8px">Cloud sync</div>
      <label class="field"><span>Email</span><input class="input" id="syEmail" type="email" autocomplete="username" value="${esc(s.email || '')}"></label>
      <label class="field"><span>Password</span><input class="input" id="syPass" type="password" autocomplete="current-password"></label>
      <div class="row" style="gap:8px;margin-bottom:6px"><button class="btn btn-sm btn-primary" id="syIn">Sign in</button></div>
      <p class="muted" id="syLine" role="status" style="font-size:12px;margin:0 0 16px;line-height:1.55">${esc(signedOutText(s))}</p>`;
    return `<div class="card-label" style="margin-bottom:8px">Cloud sync</div>
      <p class="muted" style="font-size:12px;margin:0 0 8px;overflow-wrap:anywhere">Signed in as <b>${esc(s.email || '')}</b></p>
      <p class="muted" id="syLine" role="status" style="font-size:12px;margin:0 0 10px;line-height:1.55">${esc(statusText(s))}</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;margin-bottom:16px"><button class="btn btn-sm" id="syNow">Sync now</button><button class="btn btn-sm" id="syOut">Sign out</button></div>`;
  }

  sync.onStatus(s => {
    paintDot(s);
    const el = document.getElementById('syLine');       // only while Settings is open
    if (el) showLine(el, sync.isSignedIn() ? statusText(s) : signedOutText(s));
  });
  paintDot(sync.status());

  // background triggers never open the first-connect dialog (plain syncNow, no options)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync.syncNow(); });
  window.addEventListener('online', () => sync.syncNow());
  setInterval(() => { if (!document.hidden) sync.syncNow(); }, 60000);

  // another tab saved: adopt its copy so this tab can't overwrite it with a stale one
  // (storage events only fire in OTHER tabs; reloading never marks a local change)
  window.addEventListener('storage', e => {
    if (e.key === 'winterArc.v1' && e.newValue != null && Store.reloadFromStorage()) applyTheme();
  });

  sync.syncNow();

  // installable app — only meaningful over http(s); harmless to skip on file://
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
