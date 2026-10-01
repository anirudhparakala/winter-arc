/* ============================================================
   views/tasks.js — weekly task board + mindset tracker
   ============================================================ */
(function () {
  'use strict';
  window.Views = window.Views || {};

  const SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  // categorical chart marks (not accent usage): one hue per series, darker in the light theme (--m-* tokens)
  const MIND = [
    { key: 'energy',     label: 'Energy',     short: 'E', color: 'var(--m-energy)' },
    { key: 'focus',      label: 'Focus',      short: 'F', color: 'var(--m-focus)' },
    { key: 'motivation', label: 'Motivation', short: 'M', color: 'var(--m-motivation)' }
  ];

  let weekCursor = null;   // Date — start of the displayed week

  function weekStartOf(d) { return D.startOfWeek(d, Store.state.settings.weekStart); }

  /* The week the carousel was last auto-scrolled for. The page re-renders on every
     toggle, so we only jump to today's card the first time a week is shown; after that
     app.js's own scrollLeft restore keeps the reader's position. */
  let scrolledFor = null;
  // leaving the page forgets it, so coming back opens at today again
  window.addEventListener('hashchange', () => {
    if (location.hash !== '#tasks') scrolledFor = null;
  });

  /** 10-block control: tap block v to set v, tap the set block again to clear to 0 */
  function mindControl(mm, key, value) {
    let blocks = '';
    for (let v = 1; v <= 10; v++) {
      blocks += `<button type="button" data-v="${v}"${v <= value ? ' class="on"' : ''}
                  aria-pressed="${v === value}" aria-label="${esc(mm.label)} ${v} of 10"></button>`;
    }
    return `<div class="mseg" role="group" data-mind="${mm.key}"
                 aria-label="${esc(mm.label)} on ${esc(key)}">${blocks}</div>`;
  }

  function dayCard(key) {
    const d = D.parse(key);
    const list = Store.tasksOf(key);
    const done = list.filter(t => t.done).length;
    const pct = Store.taskScore(key);
    const mind = Store.mindsetOf(key);
    const prev = D.addKey(key, -1);
    // at most 10 blocks so a long list stays legible in a narrow card
    const n = Math.min(list.length, 10);
    const lit = list.length > 10 ? Math.round(done / list.length * 10) : done;

    return `
      <section class="day-card${key === D.todayKey() ? ' is-today' : ''}" data-day="${esc(key)}">
        <div class="day-head">
          <div><span class="lb dname">${SHORT[d.getDay()]}</span>
               <span class="ddate">${esc(D.shortDate(d))}</span></div>
          <b class="dotnum dpct">${pct}%</b>
        </div>
        ${Charts.segments(lit, n, { max: 10 })}

        <div class="dsec"><span class="lb">Tasks</span>
          <span class="lb">${done}/${list.length}</span></div>
        <div class="dlist">
          ${list.map(t => `
            <div class="drow${t.done ? ' is-done' : ''}" data-task="${esc(t.id)}">
              <button class="check${t.done ? ' is-done' : ''}" data-act="t"
                      aria-pressed="${t.done}" aria-label="${esc(t.text)}">${UI.ICON.check}</button>
              <span class="dtext">${esc(t.text)}</span>
              <button class="ddel" data-act="d" aria-label="Delete task">${UI.ICON.x}</button>
            </div>`).join('')}
        </div>
        <input class="dadd" placeholder="+ Add task" data-add="${esc(key)}"
               aria-label="Add task on ${esc(key)}">
        ${(!list.length && Store.tasksOf(prev).length) ? `
          <button class="btn btn-ghost btn-sm dcopy" data-act="copy">Copy yesterday's list</button>` : ''}

        <div class="dmind">
          <div class="dsec"><span class="lb">Mindset</span></div>
          ${MIND.map(mm => `
            <div class="mrow">
              <div class="mtop">
                <span class="mlab"><i style="background:${esc(mm.color)}"></i>${esc(mm.label)}</span>
                <b class="mval">${mind[mm.key] || 0}</b>
              </div>
              ${mindControl(mm, key, mind[mm.key] || 0)}
            </div>`).join('')}
        </div>
      </section>`;
  }

  Views.tasks = {
    title: 'TASK TRACKER',
    render(el) {
      if (!weekCursor) weekCursor = weekStartOf(D.today());
      const start = weekCursor;
      const weekKey = D.key(start);
      const keys = [];
      for (let i = 0; i < 7; i++) keys.push(D.key(D.add(start, i)));
      const endD = D.add(start, 6);
      const todayK = D.todayKey();

      const allTasks = keys.flatMap(k => Store.tasksOf(k));
      const doneAll = allTasks.filter(t => t.done).length;
      const weekPct = allTasks.length ? Math.round(doneAll / allTasks.length * 100) : 0;
      const isThisWeek = D.key(weekStartOf(D.today())) === weekKey;

      const label = `${start.getDate()} ${D.MONTHS[start.getMonth()].slice(0,3)}` +
                    ` – ${endD.getDate()} ${D.MONTHS[endD.getMonth()].slice(0,3)} ${endD.getFullYear()}`;

      // one column of 10 blocks per day, lit bottom-up by rounded tenths
      const cols = keys.map(k => {
        const p = Store.taskScore(k);
        const n = Store.tasksOf(k).length;
        const dn = SHORT[D.parse(k).getDay()];
        const lit = Math.round(p / 10);
        let blocks = '';
        for (let b = 0; b < 10; b++) blocks += b < lit ? '<i class="on"></i>' : '<i></i>';
        const text = `${dn}: ${n ? p + '% of ' + n + ' task' + (n === 1 ? '' : 's') : 'no tasks'}`;
        return `<div class="wcol${k === todayK ? ' is-today' : ''}" title="${esc(text)}"
                     role="img" aria-label="${esc(text)}">
          <div class="wstack">${blocks}</div><span>${dn}</span></div>`;
      }).join('');

      el.innerHTML = `
        <div class="ttop">
          <section class="mod wkmod">
            <div class="mh"><span class="lb">01 / Week of</span>
              <span class="pill pill-accent">${esc(label)}</span></div>
            <div class="row wnav">
              <button class="icon-btn" id="prevW" aria-label="Previous week">${UI.ICON.left}</button>
              <button class="btn btn-sm" id="thisW">This week</button>
              <button class="icon-btn" id="nextW" aria-label="Next week">${UI.ICON.right}</button>
            </div>
            <div class="wbody">
              <div class="wcols">${cols}</div>
              <div class="wtotal">
                <b class="dotnum">${weekPct}%</b>
                <span class="lb">${doneAll}/${allTasks.length} completed</span>
              </div>
            </div>
          </section>

          <section class="mod mindmod">
            <div class="mh"><span class="lb">02 / Mindset</span>
              ${Charts.legend(MIND.map(m => ({ name: m.label, color: m.color })))}</div>
            <div class="chart" id="mindChart"></div>
          </section>
        </div>

        <div class="week-board scroll-x" id="board">
          ${keys.map(k => dayCard(k)).join('')}
        </div>`;

      /* mindset chart — legend + tooltip; the chart look is the shared one in style.css */
      Charts.lines(el.querySelector('#mindChart'), {
        height: 208, yMax: 10,
        labels: keys.map(k => SHORT[D.parse(k).getDay()]),
        tipTitle: i => D.longDate(D.parse(keys[i])),
        series: MIND.map(m => ({
          name: m.label, color: m.color,
          // days that haven't happened are a gap, not a zero
          values: keys.map(k => D.isFuture(k) ? null : (Store.mindsetOf(k)[m.key] || 0))
        }))
      });

      el.querySelector('#prevW').onclick = () => { weekCursor = D.add(start, -7); App.render(); };
      el.querySelector('#nextW').onclick = () => { weekCursor = D.add(start, 7);  App.render(); };
      el.querySelector('#thisW').onclick = () => { weekCursor = weekStartOf(D.today()); App.render(); };
      if (isThisWeek) el.querySelector('#thisW').classList.add('btn-primary');

      const board = el.querySelector('#board');

      board.addEventListener('click', e => {
        const mb = e.target.closest('.mseg button');
        if (mb) {
          const seg = mb.parentElement;
          const key = seg.closest('[data-day]').dataset.day;
          const field = seg.dataset.mind;
          const v = parseInt(mb.dataset.v, 10);
          UI.haptic();
          // a commit re-renders synchronously, so queue the refocus first: it hands
          // keyboard focus to the same block of the replaced control
          App.focusAfterRender(`[data-day="${key}"] [data-mind="${field}"] [data-v="${v}"]`);
          Store.setMindset(key, field, v === (Store.mindsetOf(key)[field] || 0) ? 0 : v);
          return;
        }
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const key = b.closest('[data-day]').dataset.day;
        if (b.dataset.act === 'copy') {
          const n = Store.copyTasks(D.addKey(key, -1), key);
          UI.toast(`Copied ${n} task${n === 1 ? '' : 's'}.`);
          return;
        }
        const id = b.closest('[data-task]').dataset.task;
        if (b.dataset.act === 't') Store.toggleTask(key, id);
        else Store.delTask(key, id);
      });

      board.addEventListener('keydown', e => {
        const inp = e.target.closest('[data-add]');
        if (!inp || e.key !== 'Enter' || !inp.value.trim()) return;
        App.focusAfterRender(`[data-add="${inp.dataset.add}"]`);   // queued before the sync re-render
        Store.addTask(inp.dataset.add, inp.value);
      });

      /* open on today's card the first time a week is shown (phone carousel, or a narrow
         desktop board). app.js restores the old scrollLeft synchronously after this render,
         so settle ours in a microtask (still before paint): it wins on a week change, and
         is skipped on re-renders so the restored position stands. */
      if (scrolledFor !== weekKey) {
        scrolledFor = weekKey;
        Promise.resolve().then(() => {
          if (!board.isConnected) return;
          const card = board.querySelector('.day-card.is-today');
          board.scrollLeft = card
            ? Math.max(0, card.offsetLeft - (board.clientWidth - card.offsetWidth) / 2)
            : 0;
        });
      }
    }
  };
})();
