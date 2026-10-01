/* ============================================================
   views/goals.js — the 1-year arc and the goals inside it
   ============================================================ */
(function () {
  'use strict';
  window.Views = window.Views || {};

  let areaFilter = null;   // area id, or null for all

  function goalModal(existing) {
    const a = Store.arc();
    const g = existing || {
      title: '', area: 'health', type: 'milestone', target: 10, current: 0,
      unit: '', deadline: a.end, status: 'in-progress', pinned: false, milestones: []
    };
    const wasDone = !!existing && existing.status === 'achieved';
    const areaOpts = Store.AREAS.map(x =>
      `<option value="${x.id}"${x.id === g.area ? ' selected' : ''}>${x.icon} ${esc(x.name)}</option>`).join('');

    UI.modal(existing ? 'Edit goal' : 'New 1-year goal', `
      <label class="field"><span>Goal</span>
        <input class="input" id="gTitle" maxlength="90" value="${esc(g.title)}"
               placeholder="e.g. Get consistently fit"></label>
      <div class="field-row">
        <label class="field"><span>Area of life</span>
          <select class="select" id="gArea">${areaOpts}</select></label>
        <label class="field"><span>Target date</span>
          <input class="input" type="date" id="gDate" value="${esc(g.deadline || a.end)}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Measured by</span>
          <select class="select" id="gType">
            <option value="milestone">Milestones</option>
            <option value="numeric">A number</option>
          </select></label>
        <label class="field"><span>Status</span>
          <select class="select" id="gStatus">
            <option value="planned">Planned</option>
            <option value="in-progress">In progress</option>
            <option value="achieved">Achieved</option>
          </select></label>
      </div>
      <div id="numWrap" class="field-row" hidden>
        <label class="field"><span>Target amount</span>
          <input class="input" type="number" id="gTarget" min="1" value="${g.target || 10}"></label>
        <label class="field"><span>Unit</span>
          <input class="input" id="gUnit" maxlength="16" value="${esc(g.unit || '')}"
                 placeholder="books, kg, ₹"></label>
      </div>
      <label class="field" id="msWrap"><span>Milestones — one per line</span>
        <textarea class="textarea" id="gMs" rows="4"
          placeholder="Run 1K without stopping&#10;Run 3K&#10;Run 5K">${esc((g.milestones || []).map(m => m.text).join('\n'))}</textarea></label>
      <label class="row" style="gap:8px;cursor:pointer">
        <input type="checkbox" id="gPin" ${g.pinned ? 'checked' : ''}>
        <span class="muted">Pin to top priorities</span></label>
      <div class="modal-actions">
        ${existing ? `<button class="btn btn-danger" id="gDel">Delete</button>` : ''}
        <span class="grow"></span>
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" id="gSave">${existing ? 'Save' : 'Add goal'}</button>
      </div>`, m => {
      const type = m.querySelector('#gType');
      const num = m.querySelector('#numWrap');
      const ms = m.querySelector('#msWrap');
      type.value = g.type;
      m.querySelector('#gStatus').value = g.status;
      const sync = () => {
        const isNum = type.value === 'numeric';
        num.hidden = !isNum;
        ms.hidden = isNum;
      };
      type.onchange = sync; sync();

      m.querySelector('#gSave').onclick = () => {
        const title = m.querySelector('#gTitle').value.trim();
        if (!title) { UI.toast('Give the goal a name.'); return; }
        const gType = type.value;
        const prev = g.milestones || [];
        const milestones = gType === 'numeric' ? [] :
          m.querySelector('#gMs').value.split('\n').map(s => s.trim()).filter(Boolean)
            .map(text => {
              const old = prev.find(p => p.text === text);
              return { id: old ? old.id : Store.uid(), text, done: old ? old.done : false };
            });
        const patch = {
          title,
          area: m.querySelector('#gArea').value,
          deadline: m.querySelector('#gDate').value || null,
          type: gType,
          target: Math.max(1, parseInt(m.querySelector('#gTarget').value, 10) || 1),
          unit: m.querySelector('#gUnit').value.trim(),
          status: m.querySelector('#gStatus').value,
          pinned: m.querySelector('#gPin').checked,
          milestones
        };
        const id = existing ? existing.id : Store.uid();
        Store.commit(s => {
          if (existing) Object.assign(s.goals.find(x => x.id === id), patch);
          else s.goals.push(Object.assign({ id, current: 0, createdAt: D.todayKey() }, patch));
        });
        UI.close();
        if (!wasDone && patch.status === 'achieved') UI.celebrateOnce('goal:' + id, 'trophy');
      };

      if (existing) m.querySelector('#gDel').onclick = () => {
        UI.confirm(`Delete "${existing.title}"?`, () => {
          Store.commit(s => { s.goals = s.goals.filter(x => x.id !== existing.id); });
          UI.toast('Goal deleted.');
        }, 'Delete');
      };
    });
  }

  /** the trophy plays once per goal, and only when a user action made it achieved */
  function celebrateIfNew(id, before) {
    const g = Store.state.goals.find(x => x.id === id);
    if (g && before !== 'achieved' && g.status === 'achieved') UI.celebrateOnce('goal:' + id, 'trophy');
  }

  function goalCard(g) {
    const pct = Store.goalProgress(g);
    const left = Store.daysLeft(g);
    const area = Store.area(g.area);
    const done = g.status === 'achieved';
    const statusTag = done ? '<span class="pill pill-accent">Achieved</span>'
      : g.status === 'planned' ? '<span class="pill">Planned</span>'
      : '<span class="pill is-prog">In progress</span>';
    const overdue = left != null && left < 0 && !done;
    const ms = g.milestones || [];

    return `
      <article class="goal-card${done ? ' is-done' : ''}" data-goal="${esc(g.id)}">
        <div class="gtop">
          <div class="grow">
            <div class="goal-title">${esc(g.title)}</div>
            <div class="gtags">
              ${statusTag}
              <span class="pill">${UI.emoji(area.emoji, { size: 14 })} ${esc(area.name)}</span>
              ${left != null ? `<span class="pill${overdue ? ' is-over' : ''}">
                ${overdue ? `${Math.abs(left)} days over` : `${left} days left`}</span>` : ''}
            </div>
          </div>
          <div class="gact">
            <button class="icon-btn sm pin${g.pinned ? ' is-on' : ''}" data-act="pin"
                    aria-pressed="${!!g.pinned}" aria-label="Pin goal: ${esc(g.title)}"
                    title="Pin to top priorities">${UI.ICON.pin}</button>
            <button class="icon-btn sm" data-act="edit"
                    aria-label="Edit goal: ${esc(g.title)}">${UI.ICON.edit}</button>
          </div>
        </div>

        ${g.type === 'numeric' ? `
          <div class="gmeta">
            <input class="input gnum" type="number" data-act="num"
                   value="${g.current || 0}" min="0" aria-label="Current progress: ${esc(g.title)}">
            <span>of ${g.target} ${esc(g.unit || '')}</span>
          </div>` : `
          <div class="gmeta">
            <span>${ms.filter(m => m.done).length} of ${ms.length} milestones</span>
          </div>`}

        <div class="gprog">${Charts.segments(Math.round(pct / 5), 20)}<b>${pct}%</b></div>

        ${ms.length ? `
          <div class="ms-list">
            ${ms.map(mm => `
              <div class="ms-item${mm.done ? ' is-done' : ''}">
                <button class="check${mm.done ? ' is-done' : ''}" data-act="ms" data-ms="${esc(mm.id)}"
                        aria-pressed="${mm.done}" aria-label="${esc(mm.text)}">${UI.ICON.check}</button>
                <span>${esc(mm.text)}</span>
              </div>`).join('')}
          </div>` : ''}
      </article>`;
  }

  Views.goals = {
    title: 'GOALS',
    newGoal: goalModal,
    render(el) {
      const a = Store.arc();
      const goals = Store.state.goals;
      const achieved = goals.filter(g => g.status === 'achieved').length;
      const areasUsed = new Set(goals.map(g => g.area)).size;
      const pinned = goals.filter(g => g.pinned && g.status !== 'achieved');
      const shown = areaFilter ? goals.filter(g => g.area === areaFilter) : goals;

      const areaCards = Store.AREAS.map(x => {
        const list = goals.filter(g => g.area === x.id);
        const ach = list.filter(g => g.status === 'achieved').length;
        const on = areaFilter === x.id;
        return `<button class="area-card${on ? ' is-active' : ''}" data-area="${esc(x.id)}"
                        aria-pressed="${on}">
          ${UI.emoji(x.emoji, { lit: list.length > 0, size: 28 })}
          <b>${esc(x.name)}</b>
          <span>${list.length} goal${list.length === 1 ? '' : 's'} · ${ach} achieved</span>
        </button>`;
      }).join('');

      el.innerHTML = `
        <section class="mod goal-hero">
          <b class="dotnum gh-num">${achieved}/${goals.length}</b>
          <div class="gh-main">
            <div class="lb">goals achieved · mastering ${areasUsed} area${areasUsed === 1 ? '' : 's'}</div>
            <div class="gtags">
              <span class="pill">${esc(D.parse(a.start).toDateString().slice(4))} → ${esc(D.parse(a.end).toDateString().slice(4))}</span>
              <span class="pill pill-accent">${a.left} days left in the arc</span>
            </div>
            ${Charts.segments(Math.round(a.pct / 5), 20)}
          </div>
          <button class="btn btn-primary" id="newG">${UI.ICON.plus} New goal</button>
        </section>

        <div class="section-label">Areas of life</div>
        <div class="areas" id="areas">${areaCards}</div>

        ${pinned.length ? `
          <div class="section-label">Top priorities</div>
          <div class="glist" id="pinnedList">${pinned.map(goalCard).join('')}</div>` : ''}

        <div class="section-label">
          ${areaFilter ? `${esc(Store.area(areaFilter).name)} goals` : 'All goals'}
          ${areaFilter ? ` · <button class="btn btn-ghost btn-sm gclear" id="clearF">clear filter</button>` : ''}
        </div>
        <div class="glist" id="goalList">
          ${shown.length ? shown.map(goalCard).join('')
            : `<div class="card empty">No goals here yet. Set one with <b>+ New goal</b> —
               the arc runs to ${esc(a.end)}.</div>`}
        </div>`;

      el.querySelector('#newG').onclick = () => goalModal(null);
      const cf = el.querySelector('#clearF');
      if (cf) cf.onclick = () => { areaFilter = null; App.render(); };

      el.querySelector('#areas').addEventListener('click', e => {
        const b = e.target.closest('[data-area]');
        if (!b) return;
        areaFilter = areaFilter === b.dataset.area ? null : b.dataset.area;
        App.render();
      });

      function wire(scope) {
        if (!scope) return;
        scope.addEventListener('click', e => {
          const b = e.target.closest('[data-act]');
          if (!b) return;
          const id = b.closest('[data-goal]').dataset.goal;
          const g = Store.state.goals.find(x => x.id === id);
          if (!g) return;
          if (b.dataset.act === 'edit') goalModal(g);
          else if (b.dataset.act === 'pin') {
            App.focusAfterRender(`#${scope.id} [data-goal="${CSS.escape(id)}"] [data-act="pin"]`);
            Store.commit(() => { g.pinned = !g.pinned; });
          } else if (b.dataset.act === 'ms') {
            const before = g.status;
            UI.haptic();
            App.focusAfterRender(`#${scope.id} [data-goal="${CSS.escape(id)}"] [data-ms="${CSS.escape(b.dataset.ms)}"]`);
            Store.commit(() => {
              const mm = g.milestones.find(x => x.id === b.dataset.ms);
              if (!mm) return;
              mm.done = !mm.done;
              if (g.milestones.every(x => x.done)) g.status = 'achieved';
              else if (g.status === 'achieved') g.status = 'in-progress';
            });
            celebrateIfNew(id, before);
          }
        });
        scope.addEventListener('change', e => {
          const inp = e.target.closest('[data-act="num"]');
          if (!inp) return;
          const id = inp.closest('[data-goal]').dataset.goal;
          let before = null;
          Store.commit(s => {
            const g = s.goals.find(x => x.id === id);
            before = g.status;
            g.current = Math.max(0, parseFloat(inp.value) || 0);
            if (g.current >= g.target) g.status = 'achieved';
            else if (g.status === 'achieved') g.status = 'in-progress';
          });
          celebrateIfNew(id, before);
        });
      }
      wire(el.querySelector('#goalList'));
      wire(el.querySelector('#pinnedList'));
    }
  };
})();
