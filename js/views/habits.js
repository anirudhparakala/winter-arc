/* ============================================================
   views/habits.js — the month grid (click a cell to log a day)
   ============================================================ */
(function () {
  'use strict';
  window.Views = window.Views || {};

  let cursor = D.startOfMonth(D.today());   // month on screen
  let filter = 'daily';                     // daily | weekly | monthly

  /** % of `habits` satisfied on a day (empty/future days return null) */
  function scoreFor(habits, key) {
    if (D.isFuture(key)) return null;
    const hs = habits.filter(h => h.createdAt <= key);
    if (!hs.length) return 0;
    const counted = hs.filter(h => Store.status(h.id, key) !== 'freeze');
    if (!counted.length) return 100;
    return Math.round(counted.filter(h => Store.isMet(h, key)).length / counted.length * 100);
  }

  function habitModal(existing) {
    const h = existing || { name: '', color: Store.COLORS[0], cadence: 'daily', target: 3 };
    UI.modal(existing ? 'Edit habit' : 'New habit', `
      <label class="field"><span>Habit name</span>
        <input class="input" id="hName" maxlength="60" value="${esc(h.name)}"
               placeholder="e.g. Gym"></label>
      <label class="field"><span>Colour</span></label>
      ${UI.colorSwatches(h.color)}
      <div class="field-row" style="margin-top:16px">
        <label class="field"><span>Cadence</span>
          <select class="select" id="hCad">
            <option value="daily">Every day</option>
            <option value="weekly">Times per week</option>
            <option value="monthly">Times per month</option>
          </select></label>
        <label class="field" id="tgtWrap"><span>Target</span>
          <input class="input" type="number" min="1" max="31" id="hTgt" value="${h.target}"></label>
      </div>
      <div class="modal-actions">
        ${existing ? `<button class="btn btn-danger" id="hDel">Delete</button>` : ''}
        <span class="grow"></span>
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" id="hSave">${existing ? 'Save' : 'Add habit'}</button>
      </div>`, m => {
      const getColor = UI.bindSwatches(m, h.color);
      const cad = m.querySelector('#hCad');
      const tgt = m.querySelector('#tgtWrap');
      cad.value = h.cadence;
      const sync = () => { tgt.style.visibility = cad.value === 'daily' ? 'hidden' : 'visible'; };
      cad.onchange = sync; sync();

      m.querySelector('#hSave').onclick = () => {
        const name = m.querySelector('#hName').value.trim();
        if (!name) { UI.toast('Give the habit a name.'); return; }
        const cadence = cad.value;
        const target = cadence === 'daily' ? 1
          : Math.max(1, parseInt(m.querySelector('#hTgt').value, 10) || 1);
        Store.commit(s => {
          if (existing) {
            const t = s.habits.find(x => x.id === existing.id);
            Object.assign(t, { name, color: getColor(), cadence, target });
          } else {
            s.habits.push({ id: Store.uid(), name, color: getColor(), cadence, target,
                            archived: false, createdAt: D.todayKey() });
          }
        });
        UI.close();
      };

      if (existing) m.querySelector('#hDel').onclick = () => {
        UI.confirm(`Delete "${existing.name}" and all of its logged days?`, () => {
          Store.commit(s => {
            s.habits = s.habits.filter(x => x.id !== existing.id);
            delete s.logs[existing.id];
          });
          UI.toast('Habit deleted.');
        }, 'Delete');
      };
    });
  }

  /* The month the matrix was last auto-scrolled for. The page re-renders on every
     toggle, so we only jump to "today" the first time a month is shown; after that
     app.js's own scrollLeft restore keeps the reader's position. */
  let scrolledFor = null;
  // leaving the page forgets it, so coming back opens at today again
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#habits') scrolledFor = null;
  });

  function cellState(h, k, st) {
    if (st === true) return 'done';
    if (st === 'freeze') return 'frozen';
    if (D.isFuture(k)) return 'future';
    if (k < h.createdAt) return 'before this habit';
    return 'not done';
  }

  Views.habits = {
    title: 'HABITS',
    newHabit: habitModal,
    render(el) {
      const y = cursor.getFullYear(), m = cursor.getMonth();
      const monthKey = y + '-' + m;
      const nDays = D.daysInMonth(y, m);
      const todayK = D.todayKey();
      const monthKeys = [];
      for (let i = 1; i <= nDays; i++) monthKeys.push(D.key(new Date(y, m, i)));

      const all = Store.activeHabits();
      const habits = all.filter(h => h.cadence === filter);
      const tally = Store.dayTally(todayK);

      const trend = monthKeys.map(k => scoreFor(habits, k));
      const past  = trend.filter(v => v != null);
      const avg   = past.length ? Math.round(past.reduce((a, b) => a + b, 0) / past.length) : 0;
      const tokens = Store.state.freezeTokens;

      const dayHead = monthKeys.map((k, i) => {
        const dow = new Date(y, m, i + 1).getDay();
        const cls = ['d-head'];
        if (k === todayK) cls.push('is-today');
        else if (dow === 0 || dow === 6) cls.push('is-weekend');
        return `<th class="${cls.join(' ')}">${i + 1}</th>`;
      }).join('');

      const rows = habits.map(h => {
        const cells = monthKeys.map(k => {
          const st = Store.status(h.id, k);
          const cls = ['cell'];
          if (st === true) cls.push('is-done');
          if (st === 'freeze') cls.push('is-freeze');
          if (k === todayK) cls.push('is-today');
          if (D.isFuture(k)) cls.push('is-future');
          if (k < h.createdAt) cls.push('is-off');
          const label = `${h.name} · ${k} · ${cellState(h, k, st)}`;
          return `<td class="d-cell"><button class="${cls.join(' ')}" data-k="${k}"
                    title="${esc(label)}" aria-label="${esc(label)}"
                    ${D.isFuture(k) ? 'disabled' : ''}></button></td>`;
        }).join('');

        const monthRate = Store.rate(h, monthKeys[0], monthKeys[nDays - 1]);
        const best = Store.bestStreak(h);
        return `<tr data-habit="${esc(h.id)}">
          <td class="col-habit">
            <button class="hname" data-act="edit" title="Edit habit"
                    aria-label="Edit ${esc(h.name)}">
              <span class="hmark" style="background:${esc(h.color)}"></span>
              <b class="truncate">${esc(h.name)}</b>
            </button>
          </td>
          ${cells}
          <td class="col-stats"><div class="hs">
            <span class="hrate" title="This month">${monthRate}%</span>
            ${UI.streakChip(Store.streak(h))}
            <span class="hbest${best > 0 ? ' is-lit' : ''}" title="Best streak">
              ${UI.emoji('star', { lit: best > 0, size: 14 })}${best}</span>
          </div></td>
        </tr>`;
      }).join('');

      // sparkline spans only the days that have happened, centred over their columns
      const sparkPct = (past.length / nDays * 100).toFixed(3);
      const sparkPad = past.length ? (50 / past.length).toFixed(3) : 0;

      el.innerHTML = `
        <div class="hstack">
          <section class="mod hhead">
            <div class="hh-top">
              <div class="grow">
                <div class="hmonth">${esc(D.monthLabel(cursor))}</div>
                <div class="hmeta">
                  <span><b>${tally.done}/${tally.total}</b>today</span>
                  <span>Avg <b>${avg}%</b></span>
                </div>
              </div>
              <div class="row hnav">
                <button class="icon-btn" id="prevM" aria-label="Previous month">${UI.ICON.left}</button>
                <button class="icon-btn" id="nextM" aria-label="Next month">${UI.ICON.right}</button>
              </div>
            </div>
            ${Charts.segments(Math.round(avg / 5), 20, { max: 20 })}
            <div class="hctl">
              <div class="seg" id="cadSeg">
                <button data-f="daily"   class="${filter === 'daily'   ? 'is-active' : ''}">Daily</button>
                <button data-f="weekly"  class="${filter === 'weekly'  ? 'is-active' : ''}">Weekly</button>
                <button data-f="monthly" class="${filter === 'monthly' ? 'is-active' : ''}">Monthly</button>
              </div>
              <button class="btn btn-primary" id="newH">${UI.ICON.plus} New habit</button>
            </div>
          </section>

          ${habits.length ? `
          <section class="mod hmatrix">
            <div class="mh"><span class="lb">01 / Habit matrix</span>
              <span class="lb hint">${habits.length} ${esc(filter)}</span></div>
            <div class="grid-wrap scroll-x">
              <table class="hgrid">
                <thead>
                  <tr class="trend-row">
                    <th class="col-habit"><span class="hlab">Trend</span></th>
                    <th colspan="${nDays}" class="trend-cell">
                      <div class="hspark" style="width:${sparkPct}%;padding:0 ${sparkPad}%"
                           id="sparkBox"></div>
                    </th>
                    <th class="col-stats"><div class="hs">
                      <span class="hlab">Avg</span><span class="hrate">${avg}%</span></div></th>
                  </tr>
                  <tr><th class="col-habit"><span class="hlab">Habit</span></th>
                      ${dayHead}
                      <th class="col-stats"><span class="hlab">Rate · Run · Best</span></th></tr>
                </thead>
                <tbody id="gridBody">${rows}</tbody>
              </table>
            </div>
            <div class="hleg">
              <span><i class="on"></i>Done</span>
              <span><i class="frz"></i>Frozen</span>
              <span><i class="off"></i>Missed</span>
              <span><i class="now"></i>Today</span>
            </div>
            <p class="hnote">Tap a dot to log · hold (or right-click) to freeze ·
              <b>${tokens}</b> freeze${tokens === 1 ? '' : 's'} left · tap a name to edit</p>
          </section>` : `
          <section class="mod"><div class="empty">
            No ${esc(filter)} habits yet. Add one with + New habit.
          </div></section>`}
        </div>
      `;

      const sparkBox = el.querySelector('#sparkBox');
      if (sparkBox && past.length) sparkBox.innerHTML = Charts.spark(past, { h: 36 });

      el.querySelector('#prevM').onclick = () => { cursor = new Date(y, m - 1, 1); App.render(); };
      el.querySelector('#nextM').onclick = () => { cursor = new Date(y, m + 1, 1); App.render(); };
      el.querySelector('#newH').onclick = () => habitModal(null);
      el.querySelector('#cadSeg').addEventListener('click', e => {
        const b = e.target.closest('[data-f]');
        if (b) { filter = b.dataset.f; App.render(); }
      });

      const bodyEl = el.querySelector('#gridBody');
      if (bodyEl) {
        bodyEl.addEventListener('click', e => {
          const row = e.target.closest('[data-habit]');
          if (!row) return;
          const id = row.dataset.habit;
          if (e.target.closest('[data-act="edit"]')) {
            habitModal(Store.state.habits.find(h => h.id === id));
            return;
          }
          const cell = e.target.closest('.cell');
          if (!cell || cell.disabled) return;
          const k = cell.dataset.k;
          const before = Store.dayScore(todayK);
          UI.haptic();
          Store.toggle(id, k);
          // celebrate only a user-driven transition to a full day (same id as Today's)
          if (k === todayK && before < 100 && Store.dayScore(todayK) === 100
              && Store.dayTally(todayK).total > 0) {
            UI.celebrateOnce('day100:' + todayK, 'party');
          }
        });
        // bound to the persistent view (a freeze re-renders the grid mid-gesture);
        // covers right-click on a mouse and a 500 ms hold on touch / pen
        UI.onHold(el, '.cell:not([disabled])', cell => {
          const row = cell.closest('[data-habit]');
          if (!row) return;
          if (!Store.freeze(row.dataset.habit, cell.dataset.k)) UI.toast('No freeze tokens left.');
        });
      }

      /* open scrolled to today the first time a month is shown. app.js restores the old
         scrollLeft synchronously after this render, so settle ours in a microtask (still
         before paint): it wins on a month change, and is skipped on re-renders so the
         restored position stands. */
      const wrap = el.querySelector('.grid-wrap');
      if (!wrap) scrolledFor = null;       // empty filter: nothing to scroll, so re-arm for the next grid
      else if (scrolledFor !== monthKey) {
        scrolledFor = monthKey;
        Promise.resolve().then(() => {
          if (!wrap.isConnected) return;
          const th = wrap.querySelector('.d-head.is-today');
          const nameCol = wrap.querySelector('.col-habit');
          wrap.scrollLeft = th
            ? Math.max(0, th.offsetLeft - (nameCol ? nameCol.offsetWidth : 0) - 3 * th.offsetWidth)
            : 0;
        });
      }
    }
  };
})();
