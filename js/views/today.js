/* ============================================================
   views/today.js — the daily check-in
   ============================================================ */
(function () {
  'use strict';
  window.Views = window.Views || {};

  const pad2 = n => String(n).padStart(2, '0');
  const pad3 = n => String(n).padStart(3, '0');

  function periodLabel(h, key) {
    const done = Store.periodCount(h, key);
    const word = h.cadence === 'weekly' ? 'this week' : 'this month';
    return `${done}/${h.target} ${word}`;
  }

  function habitRow(h, i, key) {
    const st   = Store.status(h.id, key);
    const met  = Store.isMet(h, key);
    const done = st === true;
    const frozen = st === 'freeze';
    const cls = ['hrow', 'press'];
    if (met || frozen) cls.push('is-done');
    if (frozen) cls.push('is-freeze');

    const tag = h.cadence === 'daily' ? ''
      : `<span class="htag">${esc(periodLabel(h, key))}</span>`;

    return `
      <div class="${cls.join(' ')}" data-habit="${esc(h.id)}">
        <button class="check${done ? ' is-done' : ''}${frozen ? ' is-freeze' : ''}"
                data-act="toggle" aria-pressed="${done}" aria-keyshortcuts="F"
                aria-label="${esc(h.name)}${frozen ? ' (frozen)' : ''}">${UI.ICON.check}</button>
        <span class="hix">${pad2(i + 1)}</span>
        <span class="hmark" style="background:${esc(h.color)}"></span>
        <span class="hlabel grow"><span class="hn truncate">${esc(h.name)}</span>${tag}</span>
        ${frozen ? UI.emoji('snowflake', { size: 18, label: 'Frozen' }) : ''}
        ${UI.streakChip(Store.streak(h))}
      </div>`;
  }

  Views.today = {
    title: 'TODAY',
    render(el) {
      const key = D.todayKey();
      const d = D.parse(key);
      const hs = Store.activeHabits();
      const tally = Store.dayTally(key);
      const pct = Store.dayScore(key);
      const tokens = Store.state.freezeTokens;
      const a = Store.arc();
      const best = hs.reduce((m, h) => Math.max(m, Store.bestStreak(h)), 0);

      el.innerHTML = `
        <section class="hero">
          <div class="pct dotnum">${pct}<sup>%</sup></div>
          <div>
            <div class="lb">${esc(D.longDate(d))} — day ${pad3(a.elapsed)} of ${a.total}</div>
            ${Charts.segments(tally.done, tally.total)}
            <div class="spec">
              <div><span class="lb">Done</span><b>${tally.done}/${tally.total}</b></div>
              <div><span class="lb">Best run</span><b>${best}D</b></div>
              <button class="spec-btn" id="tokBtn"
                      aria-label="Freeze tokens: ${tokens}. Edit">
                <span class="lb">Freezes</span><b>${pad2(tokens)}</b></button>
              <div><span class="lb">Remaining</span><b>${a.left}</b></div>
            </div>
          </div>
        </section>

        <div class="tgrid">
          <div class="mod">
            <div class="mh"><span class="lb">01 / Habits</span>
              <span class="lb hint">Tap to log · hold to freeze</span></div>
            ${hs.length
              ? `<div id="habitList">${hs.map((h, i) => habitRow(h, i, key)).join('')}</div>`
              : `<div class="empty">No habits yet — add one on Habits (2)</div>`}
          </div>
          <div class="mod" id="todayTasks"></div>
        </div>
      `;

      /* habit interactions: tap a row (or its check) to log, hold / right-click to freeze */
      const list = el.querySelector('#habitList');
      if (list) {
        list.addEventListener('click', e => {
          const row = e.target.closest('[data-habit]');
          if (!row) return;
          const id = row.dataset.habit;
          const before = Store.dayScore(key);
          UI.haptic();
          Store.toggle(id, key);
          // celebrate only the user-driven transition to a full day, never a plain render
          if (before < 100 && Store.dayScore(key) === 100 && Store.dayTally(key).total > 0) {
            UI.celebrateOnce('day100:' + key, 'party');
          }
        });
        const freezeRow = row => {
          const id = row.dataset.habit;
          const was = Store.status(id, key);
          if (was === true) { UI.toast('Already done today.'); return; }
          if (!Store.freeze(id, key)) { UI.toast('No freeze tokens left.'); return; }
          if (was === 'freeze') { UI.toast('Freeze removed.'); return; }
          UI.toast('Streak protected for today.');
          UI.celebrateOnce('freeze:' + id + ':' + key, 'snowflake');
        };
        // bound to the persistent view, not the per-render list: a freeze re-renders mid-gesture,
        // and the click that follows the hold must still hit the suppressor
        UI.onHold(el, '.hrow[data-habit]', freezeRow);
        // keyboard parity for the hold gesture: F on a focused check
        list.addEventListener('keydown', e => {
          if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const row = e.target.closest && e.target.closest('[data-habit]');
            if (row) { e.preventDefault(); freezeRow(row); }
          }
        });
      }

      el.querySelector('#tokBtn').onclick = () => UI.modal('Freeze tokens', `
        <p class="muted" style="margin:0 0 14px;line-height:1.6">
          A freeze token holds a streak for a day you genuinely couldn't show up —
          the streak survives, but the day isn't counted as completed in your rates.
          Press and hold a habit (or right-click it, or press F on it) to spend one.
        </p>
        <label class="field"><span>Tokens available</span>
          <input class="input" type="number" min="0" max="99" id="tokVal"
                 value="${Store.state.freezeTokens}"></label>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-close>Cancel</button>
          <button class="btn btn-primary" id="tokSave">Save</button>
        </div>`, m => {
        m.querySelector('#tokSave').onclick = () => {
          const v = Math.max(0, parseInt(m.querySelector('#tokVal').value, 10) || 0);
          Store.commit(s => { s.freezeTokens = v; });
          UI.close();
        };
      });

      /* today's tasks — mirrors the Tasks board for the current day */
      renderTasks(el.querySelector('#todayTasks'), key);
    }
  };

  function renderTasks(box, key) {
    const list = Store.tasksOf(key);
    box.innerHTML = `
      <div class="mh"><span class="lb">02 / Today's tasks</span>
        <span class="lb">${list.filter(t => t.done).length}/${list.length}</span></div>
      <div id="taskList">
        ${list.map(t => `
          <div class="trow${t.done ? ' is-done' : ''}" data-task="${esc(t.id)}">
            <button class="check${t.done ? ' is-done' : ''}" data-act="t"
                    aria-pressed="${t.done}" aria-label="${esc(t.text)}">${UI.ICON.check}</button>
            <span class="ttext">${esc(t.text)}</span>
            <button class="tdel" data-act="d" aria-label="Delete task">${UI.ICON.x}</button>
          </div>`).join('')}
      </div>
      <input class="tadd" placeholder="+ Add task" id="addT" aria-label="Add task">`;

    box.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.closest('[data-task]').dataset.task;
      if (b.dataset.act === 't') Store.toggleTask(key, id);
      else Store.delTask(key, id);
    });
    const inp = box.querySelector('#addT');
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && inp.value.trim()) {
        App.focusAfterRender('#todayTasks #addT');   // queued before the commit: it re-renders synchronously
        Store.addTask(key, inp.value);
      }
    });
  }
})();
