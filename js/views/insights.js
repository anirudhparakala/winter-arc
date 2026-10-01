/* ============================================================
   views/insights.js — consistency over time, leaderboard, months
   ============================================================ */
(function () {
  'use strict';
  window.Views = window.Views || {};

  let scope = 'overall';   // 'overall' | habit id
  let range = '30';        // '30' | '90' | 'month' | 'arc'
  let lbPeriod = '7';      // leaderboard window in days

  function rangeKeys() {
    const today = D.todayKey();
    if (range === 'month') {
      const d = D.today();
      return D.range(D.key(D.startOfMonth(d)), today);
    }
    if (range === 'arc') {
      const a = Store.arc();
      return D.range(a.start > today ? today : a.start, today);
    }
    return D.range(D.addKey(today, -(parseInt(range, 10) - 1)), today);
  }

  /** score for the current scope on a given day */
  function scoreOn(key) {
    if (scope === 'overall') return Store.dayScore(key);
    const h = Store.state.habits.find(x => x.id === scope);
    if (!h || h.createdAt > key) return 0;
    const st = Store.status(h.id, key);
    if (st === 'freeze') return null;
    return Store.isMet(h, key) ? 100 : 0;
  }

  /** smooth a noisy 0/100 habit series so the shape is readable */
  function smooth(vals, win) {
    return vals.map((_, i) => {
      const from = Math.max(0, i - win + 1);
      const slice = vals.slice(from, i + 1).filter(v => v != null);
      if (!slice.length) return 0;
      return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
    });
  }

  function monthsOfArc() {
    const a = Store.arc();
    const s = D.parse(a.start), e = D.parse(a.end), today = D.today();
    const out = [];
    let c = new Date(s.getFullYear(), s.getMonth(), 1);
    while (c <= e && out.length < 24) {
      const first = D.key(new Date(Math.max(c, s)));
      const lastD = new Date(c.getFullYear(), c.getMonth() + 1, 0);
      const last = D.key(lastD > today ? today : lastD);
      out.push({
        label: D.MONTHS[c.getMonth()].slice(0, 3),
        year: c.getFullYear(),
        cur: c.getFullYear() === today.getFullYear() && c.getMonth() === today.getMonth(),
        score: first <= last ? Store.rangeScore(first, last) : null
      });
      c = new Date(c.getFullYear(), c.getMonth() + 1, 1);
    }
    return out;
  }

  Views.insights = {
    title: 'INSIGHTS',
    render(el) {
      // a deleted habit can't stay selected
      const scopeHabit = Store.state.habits.find(h => h.id === scope);
      if (!scopeHabit) scope = 'overall';
      const habits = Store.activeHabits();
      const keys = rangeKeys();
      const raw = keys.map(scoreOn);
      const vals = scope === 'overall' ? raw.map(v => v == null ? 0 : v) : smooth(raw, 7);
      const valid = raw.filter(v => v != null);
      const overall = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : 0;

      // week comparison
      const ws = Store.state.settings.weekStart;
      const thisWeekStart = D.key(D.startOfWeek(D.today(), ws));
      const lastWeekStart = D.addKey(thisWeekStart, -7);
      const thisWeek = Store.rangeScore(thisWeekStart, D.todayKey());
      const lastWeek = Store.rangeScore(lastWeekStart, D.addKey(thisWeekStart, -1));
      const delta = thisWeek - lastWeek;

      const best = habits.reduce((m, h) => Math.max(m, Store.bestStreak(h)), 0);

      const lbFrom = D.addKey(D.todayKey(), -(parseInt(lbPeriod, 10) - 1));
      const board = habits
        .map(h => ({ h, v: Store.rate(h, lbFrom, D.todayKey()) }))
        .sort((a, b) => b.v - a.v);
      const weak = board.length ? board[board.length - 1].h : null;

      const streaks = habits.map(h => ({ h, s: Store.streak(h) }))
        .sort((a, b) => b.s - a.s).slice(0, 6);

      const months = monthsOfArc();

      const habitOpts = habits.map(h =>
        `<option value="${esc(h.id)}"${scope === h.id ? ' selected' : ''}>${esc(h.name)}</option>`).join('');

      const pad2 = n => String(n).padStart(2, '0');

      /* one leaderboard row: rank, name over a 20-block bar (lit blocks take the habit's colour), value */
      const lrow = (i, h, lit, value, title) => `
        <div class="lrow" title="${esc(title)}" style="--on:${esc(h.color)}">
          <span class="lrank">${pad2(i + 1)}</span>
          <div class="lmid">
            <span class="lname truncate">${esc(h.name)}</span>
            ${Charts.segments(lit, 20, { max: 20 })}
          </div>
          <b class="lval">${value}</b>
        </div>`;

      const deltaCls = delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : '';
      const deltaTxt = (delta > 0 ? '+' : delta < 0 ? '−' : '') + Math.abs(delta) + '%';

      // 10 blocks per month, lit bottom-up by rounded tenths, same build as Tasks' week columns
      const monthCols = months.map(mo => {
        const lit = mo.score == null ? 0 : Math.round(mo.score / 10);
        let blocks = '';
        for (let b = 0; b < 10; b++) blocks += b < lit ? '<i class="on"></i>' : '<i></i>';
        const text = `${mo.label} ${mo.year}: ${mo.score == null ? 'not started' : mo.score + '%'}`;
        return `<div class="wcol${mo.cur ? ' is-today' : ''}" title="${esc(text)}"
                     role="img" aria-label="${esc(text)}">
          <div class="wstack">${blocks}</div>
          <span>${esc(mo.label)}</span>
          <span>${mo.score == null ? '–' : mo.score + '%'}</span>
        </div>`;
      }).join('');

      el.innerHTML = `
        <div class="istack">
          <section class="mod">
            <div class="mh">
              <span class="lb">01 / Consistency</span>
              <div class="ictl">
                <select class="select" id="scopeSel" aria-label="Scope">
                  <option value="overall"${scope === 'overall' ? ' selected' : ''}>Overall</option>
                  ${habitOpts}
                </select>
                <select class="select" id="rangeSel" aria-label="Range">
                  <option value="30"${range === '30' ? ' selected' : ''}>Last 30 days</option>
                  <option value="90"${range === '90' ? ' selected' : ''}>Last 90 days</option>
                  <option value="month"${range === 'month' ? ' selected' : ''}>This month</option>
                  <option value="arc"${range === 'arc' ? ' selected' : ''}>Whole arc</option>
                </select>
              </div>
            </div>
            <div class="ihead">
              <b class="dotnum ipct">${overall}%</b>
              <span class="lb truncate">${scopeHabit ? esc(scopeHabit.name) : 'Overall'} consistency</span>
            </div>
            <div class="chart" id="consChart"></div>
            ${scopeHabit ? '<p class="inote">7-day rolling average for this habit.</p>' : ''}
            <div class="spec">
              <div><span class="lb">This week</span><b>${thisWeek}%</b></div>
              <div><span class="lb">vs last week</span><b class="${deltaCls}">${deltaTxt}</b></div>
              <div><span class="lb">Best streak</span>
                <b class="ibest">${UI.emoji('fire', { lit: best >= 3, size: 20 })}${best}<small>days</small></b></div>
              <div><span class="lb">Needs attention</span>
                <b class="isml truncate">${weak ? esc(weak.name) : '—'}</b></div>
            </div>
          </section>

          <div class="itwo">
            <section class="mod">
              <div class="mh">
                <span class="lb">02 / Leaderboard</span>
                <div class="seg seg-sm" id="lbSeg">
                  <button data-p="7"  class="${lbPeriod === '7'  ? 'is-active' : ''}">7d</button>
                  <button data-p="30" class="${lbPeriod === '30' ? 'is-active' : ''}">30d</button>
                  <button data-p="90" class="${lbPeriod === '90' ? 'is-active' : ''}">90d</button>
                </div>
              </div>
              ${board.length
                ? board.map((b, i) => lrow(i, b.h, Math.round(b.v / 5), b.v + '%', `${b.h.name}: ${b.v}%`)).join('')
                : '<div class="empty">No habits yet.</div>'}
            </section>

            <section class="mod">
              <div class="mh"><span class="lb">03 / Top streaks</span></div>
              ${streaks.length
                ? streaks.map((x, i) => lrow(i, x.h, Math.round(Math.min(1, x.s / Math.max(1, best)) * 20),
                    x.s + 'd', `${x.h.name}: ${x.s} day streak`)).join('')
                : '<div class="empty">No habits yet.</div>'}
            </section>
          </div>

          <section class="mod">
            <div class="mh"><span class="lb">04 / Month by month</span>
              <span class="lb">Consistency across the arc</span></div>
            <div class="mcols scroll-x"><div class="wcols">${monthCols}</div></div>
          </section>
        </div>`;

      Charts.lines(el.querySelector('#consChart'), {
        height: 220, area: true, yMax: 100,
        labels: keys.map(k => {
          const d = D.parse(k);
          return `${d.getDate()} ${D.MONTHS[d.getMonth()].slice(0, 3)}`;
        }),
        tipTitle: i => D.longDate(D.parse(keys[i])),
        fmt: v => v + '%',
        series: [{
          name: scopeHabit ? scopeHabit.name : 'Consistency',
          color: 'var(--accent)', values: vals
        }]
      });

      // a long arc scrolls sideways on a phone: open on the current month
      const mc = el.querySelector('.mcols'), cur = mc.querySelector('.is-today');
      if (cur) mc.scrollLeft = Math.max(0, cur.getBoundingClientRect().left - mc.getBoundingClientRect().left
        + mc.scrollLeft - (mc.clientWidth - cur.offsetWidth) / 2);

      el.querySelector('#scopeSel').onchange = e => { scope = e.target.value; App.render(); };
      el.querySelector('#rangeSel').onchange = e => { range = e.target.value; App.render(); };
      el.querySelector('#lbSeg').addEventListener('click', e => {
        const b = e.target.closest('[data-p]');
        if (b) { lbPeriod = b.dataset.p; App.render(); }
      });
    }
  };
})();
