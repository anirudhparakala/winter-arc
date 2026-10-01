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

  /* ---------------- render ---------------- */
  function render() {
    const v = Views[page];
    // keep the reader where they were across a state commit (the window scrolls now)
    const top = window.scrollY;
    const sx = view.querySelector('.scroll-x');
    const left = sx ? sx.scrollLeft : 0;

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
      const t = view.querySelector(pendingFocus);
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
  const tick = () => { clockEl.textContent = new Date().toTimeString().slice(0, 5); };
  tick(); setInterval(tick, 15000);

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

  document.getElementById('settingsBtn').onclick = () => {
    const s = Store.state.settings;
    const a = Store.arc();
    UI.modal('Settings', `
      <label class="field"><span>Arc name</span>
        <input class="input" id="sName" maxlength="40" value="${esc(s.name)}"></label>
      <div class="field-row">
        <label class="field"><span>Arc starts</span>
          <input class="input" type="date" id="sStart" value="${esc(s.arcStart)}"></label>
        <label class="field"><span>Arc length (months)</span>
          <input class="input" type="number" id="sMonths" min="1" max="60" value="${s.arcMonths}"></label>
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
      <p class="dim" style="font-size:12px;margin:0 0 16px;line-height:1.55">
        Current arc: <b>${esc(a.start)}</b> → <b>${esc(a.end)}</b> · ${a.total} days ·
        ${a.left} left.${Store.memoryOnly
          ? '<br><b style="color:var(--warning)">This browser is blocking local storage — export a backup before you close the tab.</b>'
          : '<br>Everything is saved in this browser only. Export a backup to move it to another device.'}
      </p>

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
          st.settings.arcMonths = Math.max(1, parseInt(m.querySelector('#sMonths').value, 10) || 12);
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
        UI.confirm('Erase every habit, task, goal and logged day on this device?', () => {
          Store.reset(); applyTheme(); UI.close(); UI.toast('Reset complete.');
        }, 'Erase everything');
      };
    },
    // the theme select previews live — put it back if the dialog is dismissed
    () => applyTheme());
  };

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

  // installable app — only meaningful over http(s); harmless to skip on file://
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
