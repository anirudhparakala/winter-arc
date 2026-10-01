/* ============================================================
   merge.js — pure three-way merge for Winter Arc state.
   No DOM, no network. Works on plain JSON; returns fresh copies.

   Known limits (accepted):
   - Freeze tokens are merged as a delta counter, so two devices freezing the SAME day
     (a same-day conflict) is counted as two spends.
   - Records merge by id: a rename on one device vs a delete on the other keeps the record
     (the edit wins), and habit names are not used to match records after first connect.
   - A goal's status/progress is stored, not derived: milestone changes from two devices can
     leave a goal's status out of step with its milestones until the next edit.
   - freezeTokens re-merges are only correct if the caller advances its base to the remote
     it just merged against.
   ============================================================ */
(function (root) {
  'use strict';

  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isRecs = a => Array.isArray(a) && a.every(x => isObj(x) && typeof x.id === 'string');
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function equal(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
    if (isObj(a)) {
      if (!isObj(b)) return false;
      const ka = Object.keys(a);
      return ka.length === Object.keys(b).length && ka.every(k => has(b, k) && equal(a[k], b[k]));
    }
    return false;
  }

  /** b = base value, l = local, r = remote; undefined means "absent" (deleted). */
  function mergeValue(b, l, r, prefer) {
    if (equal(l, b)) return r;                       // local untouched → remote (incl. its deletion)
    if (equal(r, b)) return l;                       // remote untouched → local
    if (equal(l, r)) return l;                       // both made the same change
    if (l === undefined) return r;                   // local deleted, remote edited → the edit wins
    if (r === undefined) return l;                   // remote deleted, local edited → the edit wins
    if (isObj(l) && isObj(r)) return mergeObjects(isObj(b) ? b : {}, l, r, prefer);
    if (isRecs(l) && isRecs(r)) return mergeRecords(isRecs(b) ? b : [], l, r, prefer);
    return prefer === 'remote' ? r : l;              // same leaf changed differently
  }

  function mergeObjects(b, l, r, prefer) {
    const out = {};
    new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b)]).forEach(k => {
      const v = mergeValue(b[k], l[k], r[k], prefer);
      if (v !== undefined) out[k] = v;
    });
    return out;
  }

  /** arrays of {id, …}: merged per id; order = remote's order, then ids only local has */
  function mergeRecords(b, l, r, prefer) {
    const by = arr => new Map(arr.map(x => [x.id, x]));
    const bm = by(b), lm = by(l), rm = by(r);
    const ids = [...new Set([...r.map(x => x.id), ...l.map(x => x.id), ...b.map(x => x.id)])];
    const out = [];
    ids.forEach(id => {
      const v = mergeValue(bm.get(id), lm.get(id), rm.get(id), prefer);
      if (v !== undefined) out.push(v);
    });
    return out;
  }

  function three(base, local, remote, opts) {
    const o = opts || {};
    const b = isObj(base) ? base : {};
    if (!isObj(local) || !isObj(remote)) return isObj(local) ? clone(local) : isObj(remote) ? clone(remote) : {};
    if (equal(local, remote)) return clone(local);   // already converged: nothing to merge (and no double-counted deltas)
    const out = clone(mergeValue(b, local, remote, o.prefer === 'remote' ? 'remote' : 'local'));
    // freeze tokens are a counter: apply both sides' deltas
    if ([b.freezeTokens, local.freezeTokens, remote.freezeTokens].every(Number.isFinite)) {
      out.freezeTokens = Math.max(0, b.freezeTokens + (local.freezeTokens - b.freezeTokens) + (remote.freezeTokens - b.freezeTokens));
    }
    // logs of a habit that no longer exists are junk (e.g. delete on one device vs tick on the other)
    if (Array.isArray(out.habits) && isObj(out.logs)) {
      const ids = new Set(out.habits.map(h => h && h.id));
      Object.keys(out.logs).forEach(k => { if (!ids.has(k)) delete out.logs[k]; });
    }
    return out;
  }

  const norm = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();

  /** No shared history (first sign-in on a device that already has data and the cloud has data):
      habits created independently on two devices have different random ids, so habits with the
      same name are treated as one (local logs are remapped); other conflicts → remote wins. */
  function firstConnect(local, remote) {
    if (!isObj(local) || !isObj(remote)) return three({}, local, remote, { prefer: 'remote' });
    const l = clone(local);
    const remoteHabits = Array.isArray(remote.habits) ? remote.habits : [];
    const remoteIds = new Set(remoteHabits.map(h => h.id));
    const localIds = new Set((l.habits || []).map(h => h.id));
    const byName = new Map();
    remoteHabits.forEach(h => { const n = norm(h.name); if (!byName.has(n)) byName.set(n, h.id); });
    const idMap = {};
    const remapped = new Set();                      // local habits that were remapped onto a remote id
    (l.habits || []).forEach(h => {
      if (remoteIds.has(h.id)) return;               // already the same record on both devices
      const rid = byName.get(norm(h.name));
      if (!rid || localIds.has(rid)) return;         // no match, or that id belongs to another local habit
      idMap[h.id] = rid; h.id = rid; remapped.add(h);
    });
    const seen = new Set();                          // only collapse habits remapped onto the same remote id
    l.habits = (l.habits || []).filter(h => {
      if (!remapped.has(h)) return true;
      if (seen.has(h.id)) return false;
      seen.add(h.id); return true;
    });
    if (isObj(l.logs)) {
      Object.keys(idMap).forEach(oldId => {
        const rid = idMap[oldId];
        if (!isObj(l.logs[oldId])) return;
        l.logs[rid] = Object.assign({}, l.logs[oldId], l.logs[rid] || {});
        delete l.logs[oldId];
      });
    }
    return three({}, l, remote, { prefer: 'remote' });
  }

  const empty = o => !o || Object.keys(o).length === 0;
  /** a fresh install: nothing logged, no tasks, goals or mindset entries */
  function isPristine(d) {
    return empty(d && d.mindset) &&
      (!d || !d.goals || d.goals.length === 0) &&
      (!d || !d.logs || Object.values(d.logs).every(empty)) &&
      (!d || !d.tasks || Object.values(d.tasks).every(a => !a || a.length === 0));
  }

  const isState = d => isObj(d) && Array.isArray(d.habits);

  root.Merge = { three, firstConnect, equal, isPristine, isState };
})(typeof window !== 'undefined' ? window : globalThis);
