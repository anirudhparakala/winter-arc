/* ============================================================
   store.js — state, persistence, date math, derived stats
   Exposes: window.D (dates), window.Store
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- date helpers (all local time) ---------------- */
  const MS_DAY = 86400000;
  const MONTHS = ['January','February','March','April','May','June','July',
                  'August','September','October','November','December'];
  const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  const D = {
    MONTHS, DAYS,
    /** 'YYYY-MM-DD' for a Date */
    key(d) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    /** Date at local midnight from 'YYYY-MM-DD' */
    parse(k) {
      const [y, m, d] = k.split('-').map(Number);
      return new Date(y, m - 1, d);
    },
    today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); },
    todayKey() { return D.key(D.today()); },
    add(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
    addKey(k, n) { return D.key(D.add(D.parse(k), n)); },
    /** whole days between two keys (b - a) */
    diff(a, b) { return Math.round((D.parse(b) - D.parse(a)) / MS_DAY); },
    startOfWeek(d, weekStart) {
      const x = new Date(d);
      const shift = (x.getDay() - (weekStart || 0) + 7) % 7;
      x.setDate(x.getDate() - shift);
      return x;
    },
    startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); },
    daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); },
    /** inclusive list of keys from a..b */
    range(a, b) {
      const out = []; let c = a;
      while (c <= b) { out.push(c); c = D.addKey(c, 1); }
      return out;
    },
    isFuture(k) { return k > D.todayKey(); },
    /** 'TUESDAY 15 SEPTEMBER' */
    longDate(d) { return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; },
    /** '06/09/2026' */
    shortDate(d) {
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    },
    monthLabel(d) { return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  };

  /* ---------------- constants ---------------- */
  const AREAS = [
    { id: 'health',    emoji: 'health',     name: 'Health & Fitness',   icon: '💪' },
    { id: 'career',    emoji: 'career',     name: 'Career Growth',      icon: '📈' },
    { id: 'finance',   emoji: 'finance',    name: 'Finances & Wealth',  icon: '💰' },
    { id: 'relations', emoji: 'relations',  name: 'Relationships',      icon: '🤝' },
    { id: 'romance',   emoji: 'romance',    name: 'Romance & Love',     icon: '❤️' },
    { id: 'spirit',    emoji: 'spirit',     name: 'Spirituality',       icon: '✨' },
    { id: 'home',      emoji: 'home',       name: 'Home',               icon: '🏠' },
    { id: 'travel',    emoji: 'travel',     name: 'Adventure & Travel', icon: '🧭' },
    { id: 'fun',       emoji: 'fun',        name: 'Fun & Hobbies',      icon: '🎮' },
    { id: 'community', emoji: 'community',  name: 'Community',          icon: '🌍' }
  ];

  // dark-stepped categorical slots — validated for the dark surface
  const COLORS = ['#3987e5','#d95926','#199e70','#c98500',
                  '#d55181','#008300','#9085e9','#e66767'];

  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const KEY = 'winterArc.v1';
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  /* ---------------- defaults ---------------- */
  function defaultState() {
    const start = D.todayKey();
    return {
      version: 1,
      settings: {
        name: 'Winter Arc',
        arcStart: start,
        arcDays: 90,            // arc length in days (integer >= 1)
        weekStart: 0,           // 0 = Sunday
        theme: 'dark'
      },
      freezeTokens: 9,
      habits: [
        h('Wake up at 5AM', 0, 'daily'),
        h('Gym',            1, 'weekly', 5),
        h('Read 10 pages',  2, 'daily'),
        h('Eat healthy',    5, 'daily'),
        h('Plan next day',  4, 'daily'),
        h('Cold shower',    7, 'daily'),
        h('No social media',6, 'daily')
      ],
      logs: {},                 // { habitId: { 'YYYY-MM-DD': true | 'freeze' } }
      tasks: {},                // { 'YYYY-MM-DD': [ {id,text,done} ] }
      mindset: {},              // { 'YYYY-MM-DD': {energy,focus,motivation} }
      goals: []
    };
    function h(name, ci, cadence, target) {
      return { id: uid(), name, color: COLORS[ci % COLORS.length],
               cadence: cadence || 'daily', target: target || 1,
               archived: false, createdAt: start };
    }
  }

  /* ---------------- persistence ---------------- */
  let state = null;
  let memoryOnly = false;        // true when localStorage is unavailable
  const listeners = [];

  /** keep the unreadable save under KEY.corrupt (blocked/full storage is fine to ignore) */
  function backupCorrupt(raw) {
    try {
      if (localStorage.getItem(KEY + '.corrupt') !== raw) localStorage.setItem(KEY + '.corrupt', raw);
    } catch (e) { /* storage unavailable: nothing more we can do */ }
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); }
    catch (e) { memoryOnly = true; }
    if (!raw) return defaultState();
    try {
      const parsed = JSON.parse(raw);
      return migrate(parsed);
    } catch (e) {
      console.warn('Winter Arc: corrupt save, starting fresh.', e);
      backupCorrupt(raw);      // the next commit overwrites KEY — keep the raw text recoverable
      return defaultState();
    }
  }

  const DEFAULT_ARC_DAYS = 90;
  const MAX_ARC_DAYS = 3650;
  /** an integer >= 1 is a usable length, clamped to MAX_ARC_DAYS (so 1e15 becomes 3650);
      anything else (NaN, 0, negative, fractional, non-number) is null and callers fall back to 90 */
  const validDays = n => (Number.isInteger(n) && n >= 1) ? Math.min(n, MAX_ARC_DAYS) : null;

  /** Old saves stored the arc as `arcMonths`. Convert to the exact number of days that
      month-based arc covered, drop the old field, and fall back to 90 for anything invalid.
      Any resulting length is clamped to 1..MAX_ARC_DAYS. */
  function migrateArcLength(out, raw) {
    const st = out.settings;
    let days = validDays(raw.arcDays);
    if (days === null) {
      days = DEFAULT_ARC_DAYS;
      const months = validDays(raw.arcMonths);   // every month is >= 28 days, so MAX months already exceeds MAX days
      if (months !== null) {
        const d = D.parse(st.arcStart);
        const end = new Date(d.getFullYear(), d.getMonth() + months, d.getDate());
        const n = validDays(D.diff(st.arcStart, D.key(D.add(end, -1))) + 1);
        if (n !== null) days = n;
      }
    }
    st.arcDays = days;
    delete st.arcMonths;
  }

  function migrate(s) {
    const base = defaultState();
    const out = Object.assign({}, base, s);
    out.settings = Object.assign({}, base.settings, s.settings || {});
    out.habits  = Array.isArray(s.habits) ? s.habits : base.habits;
    out.goals   = Array.isArray(s.goals)  ? s.goals  : [];
    out.logs    = s.logs    || {};
    out.tasks   = s.tasks   || {};
    out.mindset = s.mindset || {};
    migrateArcLength(out, s.settings || {});
    if (typeof out.freezeTokens !== 'number') out.freezeTokens = base.freezeTokens;
    out.habits.forEach((h, i) => {
      if (!h.cadence) h.cadence = 'daily';
      if (!h.target) h.target = 1;
      // colours end up in style="" attributes: only a plain #rrggbb is safe
      if (!HEX6.test(h.color)) h.color = COLORS[i % COLORS.length];
      if (!h.createdAt) h.createdAt = out.settings.arcStart;
    });
    return out;
  }

  function persist() {
    if (memoryOnly) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { memoryOnly = true; console.warn('Winter Arc: saving failed.', e); }
  }

  function emit() { listeners.forEach(fn => fn()); }

  /** mutate + save + re-render */
  function commit(fn) {
    fn(state);
    persist();
    emit();
  }

  /* ---------------- habit log ---------------- */
  function logOf(habitId) { return state.logs[habitId] || (state.logs[habitId] = {}); }
  function status(habitId, key) { return (state.logs[habitId] || {})[key] || null; }

  function toggle(habitId, key) {
    commit(s => {
      const log = s.logs[habitId] || (s.logs[habitId] = {});
      if (log[key] === 'freeze') { delete log[key]; s.freezeTokens++; }
      else if (log[key]) delete log[key];
      else log[key] = true;
    });
  }

  function freeze(habitId, key) {
    const cur = status(habitId, key);
    if (cur === 'freeze') { commit(s => { delete s.logs[habitId][key]; s.freezeTokens++; }); return true; }
    if (state.freezeTokens <= 0) return false;
    commit(s => {
      const log = s.logs[habitId] || (s.logs[habitId] = {});
      log[key] = 'freeze';
      s.freezeTokens--;
    });
    return true;
  }

  /* ---------------- derived: periods ---------------- */
  /** keys of the period (week/month) containing `key`, clipped to today */
  function periodKeys(cadence, key) {
    const d = D.parse(key);
    if (cadence === 'weekly') {
      const s = D.startOfWeek(d, state.settings.weekStart);
      return D.range(D.key(s), D.key(D.add(s, 6)));
    }
    if (cadence === 'monthly') {
      const s = D.startOfMonth(d);
      return D.range(D.key(s), D.key(new Date(d.getFullYear(), d.getMonth() + 1, 0)));
    }
    return [key];
  }

  /** how many times a non-daily habit was done in the period containing key */
  function periodCount(habit, key) {
    const log = state.logs[habit.id] || {};
    return periodKeys(habit.cadence, key).filter(k => log[k] === true).length;
  }

  /** is this habit "satisfied" for the day/period of `key`? */
  function isMet(habit, key) {
    if (habit.cadence === 'daily') return status(habit.id, key) === true;
    return periodCount(habit, key) >= habit.target;
  }

  /* ---------------- derived: streaks ---------------- */
  /** current streak, counting freezes as holds (not as completions) */
  function streak(habit) {
    const log = state.logs[habit.id] || {};
    const todayK = D.todayKey();

    if (habit.cadence === 'daily') {
      let n = 0, k = todayK;
      // today not yet done doesn't break the streak — start from yesterday
      if (!log[k]) k = D.addKey(k, -1);
      while (log[k]) {
        if (log[k] === true) n++;
        k = D.addKey(k, -1);
      }
      return n;
    }

    // weekly / monthly: consecutive periods hitting target
    let n = 0, cursor = todayK, first = true;
    while (true) {
      const keys = periodKeys(habit.cadence, cursor);
      const hits = keys.filter(k => log[k] === true).length;
      if (hits >= habit.target) n++;
      else if (!first) break;          // current period still in progress — don't break on it
      first = false;
      cursor = D.addKey(keys[0], -1);
      if (D.diff(habit.createdAt, cursor) < -7) break;
      if (n > 520) break;
    }
    return n;
  }

  /** longest run of completed days ever (daily cadence semantics) */
  function bestStreak(habit) {
    const log = state.logs[habit.id] || {};
    const keys = Object.keys(log).filter(k => log[k]).sort();
    let best = 0, run = 0, prev = null;
    for (const k of keys) {
      if (prev && D.diff(prev, k) === 1) run++; else run = 1;
      if (log[k] === true) best = Math.max(best, run);
      prev = k;
    }
    return best;
  }

  /* ---------------- derived: rates ---------------- */
  /** scheduled days for a habit inside [from..to] — never before it existed, never future */
  function scheduledKeys(habit, from, to) {
    const start = habit.createdAt > from ? habit.createdAt : from;
    const end   = to > D.todayKey() ? D.todayKey() : to;
    if (start > end) return [];
    return D.range(start, end);
  }

  /** completion rate 0..100 for a habit over a key range */
  function rate(habit, from, to) {
    const log = state.logs[habit.id] || {};
    const days = scheduledKeys(habit, from, to);
    if (!days.length) return 0;

    if (habit.cadence === 'daily') {
      const active = days.filter(k => log[k] !== 'freeze');
      if (!active.length) return 100;
      return Math.round(active.filter(k => log[k] === true).length / active.length * 100);
    }
    // non-daily: measured against the pro-rated target for the span
    const done = days.filter(k => log[k] === true).length;
    const per  = habit.cadence === 'weekly' ? habit.target / 7 : habit.target / 30;
    const need = Math.max(1, Math.round(per * days.length));
    return Math.min(100, Math.round(done / need * 100));
  }

  /** % of all active habits satisfied on a given day */
  function dayScore(key) {
    const hs = activeHabits().filter(h => h.createdAt <= key);
    if (!hs.length) return 0;
    const counted = hs.filter(h => status(h.id, key) !== 'freeze');
    if (!counted.length) return 100;
    const done = counted.filter(h => isMet(h, key)).length;
    return Math.round(done / counted.length * 100);
  }

  /** {done, total} habit tally for a day — daily habits plus unmet periodic ones */
  function dayTally(key) {
    const hs = activeHabits().filter(h => h.createdAt <= key);
    return { done: hs.filter(h => isMet(h, key)).length, total: hs.length };
  }

  /** average dayScore across a range */
  function rangeScore(from, to) {
    const keys = D.range(from, to).filter(k => !D.isFuture(k));
    if (!keys.length) return 0;
    return Math.round(keys.reduce((a, k) => a + dayScore(k), 0) / keys.length);
  }

  function activeHabits() { return state.habits.filter(h => !h.archived); }

  /* ---------------- tasks ---------------- */
  function tasksOf(key) { return state.tasks[key] || []; }
  function addTask(key, text) {
    const t = text.trim(); if (!t) return;
    commit(s => { (s.tasks[key] || (s.tasks[key] = [])).push({ id: uid(), text: t, done: false }); });
  }
  function toggleTask(key, id) {
    commit(s => { const t = (s.tasks[key] || []).find(x => x.id === id); if (t) t.done = !t.done; });
  }
  function delTask(key, id) {
    commit(s => { s.tasks[key] = (s.tasks[key] || []).filter(x => x.id !== id); });
  }
  function copyTasks(fromKey, toKey) {
    const src = tasksOf(fromKey);
    if (!src.length) return 0;
    commit(s => {
      const dst = s.tasks[toKey] || (s.tasks[toKey] = []);
      src.forEach(t => dst.push({ id: uid(), text: t.text, done: false }));
    });
    return src.length;
  }
  function taskScore(key) {
    const list = tasksOf(key);
    if (!list.length) return 0;
    return Math.round(list.filter(t => t.done).length / list.length * 100);
  }

  /* ---------------- mindset ---------------- */
  function mindsetOf(key) { return state.mindset[key] || { energy: 0, focus: 0, motivation: 0 }; }
  function setMindset(key, field, val) {
    commit(s => {
      const m = s.mindset[key] || (s.mindset[key] = { energy: 0, focus: 0, motivation: 0 });
      m[field] = val;
    });
  }

  /* ---------------- goals ---------------- */
  function goalProgress(g) {
    if (g.status === 'achieved') return 100;
    if (g.type === 'numeric' && g.target > 0) {
      return Math.min(100, Math.round((g.current || 0) / g.target * 100));
    }
    if (g.milestones && g.milestones.length) {
      return Math.round(g.milestones.filter(m => m.done).length / g.milestones.length * 100);
    }
    return 0;
  }
  function daysLeft(g) {
    if (!g.deadline) return null;
    return D.diff(D.todayKey(), g.deadline);
  }

  /* ---------------- arc (the window every goal and rate lives in) ---------------- */
  function arc() {
    const st = state.settings.arcStart;
    const days = validDays(state.settings.arcDays) || DEFAULT_ARC_DAYS;
    const endK = D.addKey(st, days - 1);
    const total = days;
    const elapsed = Math.min(total, Math.max(0, D.diff(st, D.todayKey()) + 1));
    return { start: st, end: endK, total, elapsed,
             left: Math.max(0, total - elapsed),
             pct: Math.round(elapsed / total * 100) };
  }

  /* ---------------- import / export ---------------- */
  function exportJSON() { return JSON.stringify(state, null, 2); }
  function importJSON(text) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('habits' in parsed))
      throw new Error('Not a Winter Arc backup file.');
    state = migrate(parsed);
    persist(); emit();
  }
  function reset() { state = defaultState(); persist(); emit(); }

  /* ---------------- boot ---------------- */
  state = load();

  window.D = D;
  window.Store = {
    AREAS, COLORS, uid,
    get state() { return state; },
    get memoryOnly() { return memoryOnly; },
    area: id => AREAS.find(a => a.id === id) || AREAS[0],
    subscribe(fn) { listeners.push(fn); },
    commit, persist,

    activeHabits, status, toggle, freeze, logOf,
    isMet, periodCount, periodKeys,
    streak, bestStreak, rate, scheduledKeys,
    dayScore, dayTally, rangeScore,

    tasksOf, addTask, toggleTask, delTask, copyTasks, taskScore,
    mindsetOf, setMindset,
    goalProgress, daysLeft,
    arc,
    exportJSON, importJSON, reset
  };
})();
