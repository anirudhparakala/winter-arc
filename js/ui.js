/* ============================================================
   ui.js — icons, modal, toast, small shared widgets
   ============================================================ */
(function () {
  'use strict';
  const esc = window.esc;

  const ICON = {
    check:  '<svg viewBox="0 0 24 24" class="ico"><path d="m5 13 4.5 4.5L19 7"/></svg>',
    plus:   '<svg viewBox="0 0 24 24" class="ico"><path d="M12 5v14M5 12h14"/></svg>',
    x:      '<svg viewBox="0 0 24 24" class="ico"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    left:   '<svg viewBox="0 0 24 24" class="ico"><path d="m15 5-7 7 7 7"/></svg>',
    right:  '<svg viewBox="0 0 24 24" class="ico"><path d="m9 5 7 7-7 7"/></svg>',
    trash:  '<svg viewBox="0 0 24 24" class="ico"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>',
    edit:   '<svg viewBox="0 0 24 24" class="ico"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/></svg>',
    pin:    '<svg viewBox="0 0 24 24" class="ico"><path d="M9 3h6l-1 6 4 4H6l4-4z" fill="currentColor" stroke="none" opacity=".9"/><path d="M12 13v8"/></svg>',
    flame:  '<svg viewBox="0 0 24 24" class="ico" style="fill:currentColor;stroke:none"><path d="M12 2s4.5 4.2 4.5 8.2a4.5 4.5 0 0 1-1.6 3.4c.1-1.9-.9-3.4-2.1-4.3.2 2.2-1.4 3.3-2.3 4.4-.7.9-1 1.7-1 2.6 0 2.4 2 4.3 4.5 4.3s4.5-2 4.5-4.5c0-1-.2-1.8-.5-2.6C19.4 14.6 20 16.2 20 18c0 3.3-3.6 5-8 5s-8-2.3-8-6c0-5 8-7.3 8-15z"/></svg>',
    star:   '<svg viewBox="0 0 24 24" class="ico" style="fill:currentColor;stroke:none"><path d="m12 2 3 6.6 7 .8-5.2 4.8 1.4 7L12 17.7 5.8 21.2l1.4-7L2 9.4l7-.8z"/></svg>',
    snow:   '<svg viewBox="0 0 24 24" class="ico"><path d="M12 2v20M4 6l16 12M20 6 4 18M12 6l-2.5-2M12 6l2.5-2M12 18l-2.5 2M12 18l2.5 2"/></svg>',
    gear:   '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>',
    target: '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/></svg>'
  };

  /* ---------------- media queries (read at call time, never cached) ---------------- */
  const mq = q => !!(window.matchMedia && window.matchMedia(q).matches);
  const reduceMotion = () => mq('(prefers-reduced-motion: reduce)');

  /* ---------------- modal ---------------- */
  const root  = document.getElementById('modalRoot');
  const title = document.getElementById('modalTitle');
  const body  = document.getElementById('modalBody');
  let lastFocus = null;
  let onCloseHook = null;

  /** onClose runs on cancel/Esc/backdrop as well as on close() after saving */
  function modal(heading, html, onMount, onClose) {
    // a dialog opened over another (confirm) must hand focus back to the original opener
    if (root.hidden) lastFocus = document.activeElement;
    onCloseHook = onClose || null;
    title.textContent = heading;
    body.innerHTML = html;
    root.hidden = false;
    if (onMount) onMount(body);
    // a touch device would pop the keyboard over the bottom sheet: focus the dialog itself there
    const first = mq('(pointer: coarse)') ? null : body.querySelector('input, textarea, select, button');
    const dlg = root.querySelector('.modal');
    if (first) first.focus();
    else if (dlg && dlg.focus) dlg.focus({ preventScroll: true });
  }

  function close() {
    const hook = onCloseHook;
    onCloseHook = null;
    root.hidden = true;
    body.innerHTML = '';
    if (hook) hook();
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  root.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !root.hidden) close();
  });

  /** simple yes/no. It replaces the open dialog, so it inherits that dialog's onClose
      hook (e.g. Settings reverting a previewed theme when the confirm is cancelled). */
  function confirm(message, onYes, yesLabel) {
    const parentHook = onCloseHook;
    modal('Confirm', `
      <p class="muted" style="margin:0 0 4px;line-height:1.55">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-close>Cancel</button>
        <button class="btn btn-primary" id="cfYes">${esc(yesLabel || 'Yes')}</button>
      </div>`, el => {
      el.querySelector('#cfYes').onclick = () => { close(); onYes(); };
    }, parentHook);
  }

  /* ---------------- toast ---------------- */
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2200);
  }

  /* ---------------- shared bits ---------------- */
  function colorSwatches(selected) {
    return `<div class="swatches">${Store.COLORS.map(c => `
      <button type="button" class="swatch${c === selected ? ' is-on' : ''}"
              data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</div>`;
  }

  /** wire a .swatches group; returns a getter for the picked color */
  function bindSwatches(scope, initial) {
    let picked = initial;
    scope.querySelectorAll('.swatch').forEach(b => {
      b.onclick = () => {
        picked = b.dataset.color;
        scope.querySelectorAll('.swatch').forEach(x => x.classList.toggle('is-on', x === b));
      };
    });
    return () => picked;
  }

  /* ---------------- emoji ----------------
     Literal path maps (not string concatenation) so tools/build.js can find
     and inline every referenced file. */
  const EMO = {
    fire: 'assets/emoji/fire.png', snowflake: 'assets/emoji/snowflake.png',
    star: 'assets/emoji/star.png', party: 'assets/emoji/party.png',
    trophy: 'assets/emoji/trophy.png', health: 'assets/emoji/health.png',
    career: 'assets/emoji/career.png', finance: 'assets/emoji/finance.png',
    relations: 'assets/emoji/relations.png', romance: 'assets/emoji/romance.png',
    spirit: 'assets/emoji/spirit.png', home: 'assets/emoji/home.png',
    travel: 'assets/emoji/travel.png', fun: 'assets/emoji/fun.png',
    community: 'assets/emoji/community.png'
  };
  const EMO_ANIM = {
    fire: 'assets/emoji/fire-anim.png',
    snowflake: 'assets/emoji/snowflake-anim.png',
    party: 'assets/emoji/party-anim.png'
  };
  /** slugs that have an animated (APNG) file; everything else falls back to CSS */
  const ANIM = new Set(['fire', 'snowflake', 'party']);

  /** <img> for a 3D emoji. anim without an -anim file -> static + `is-anim` CSS fallback */
  function emoji(slug, opt) {
    const o = Object.assign({ lit: true, anim: false, size: 20, label: '' }, opt);
    const has = (m, k) => Object.prototype.hasOwnProperty.call(m, k);
    if (!has(EMO, slug)) return '';
    const staticSrc = EMO[slug];
    // an APNG can't be paused by CSS, so under reduced motion serve the still image
    const real = o.anim && !reduceMotion() && ANIM.has(slug) && has(EMO_ANIM, slug) && EMO_ANIM[slug];
    const src = real || staticSrc;
    const cls = 'emo' + (o.lit ? '' : ' is-off') + (o.anim && !real && !reduceMotion() ? ' is-anim' : '');
    const alt = o.label ? ` alt="${esc(o.label)}"` : ' alt="" aria-hidden="true"';
    return `<img class="${cls}" src="${src}" width="${o.size}" height="${o.size}"${alt}>`;
  }

  function streakChip(n) {
    const hot = n >= 3;
    return `<span class="streak${hot ? ' is-hot' : ''}">` +
      emoji('fire', { lit: hot, anim: hot, size: 18 }) +
      `${String(n).padStart(2, '0')}</span>`;
  }

  /* ---------------- long-press ---------------- */
  let holdStyleDone = false;
  function ensureHoldStyle() {
    if (holdStyleDone) return;
    holdStyleDone = true;
    const style = document.createElement('style');
    style.id = 'holdStyle';
    style.textContent = '[data-hold-t]{-webkit-touch-callout:none;user-select:none;-webkit-user-select:none}';
    document.head.appendChild(style);
  }

  /** fn(target, event) fires once after a 500 ms touch/pen hold (or on mouse
   *  right-click). A hold swallows the click that follows it.
   *  Safe to call on every render: listeners are bound once per container, and
   *  a repeat call for the same selector just replaces its callback. */
  function onHold(container, selector, fn) {
    ensureHoldStyle();
    const mark = el => el.setAttribute('data-hold-t', '');
    if (container.querySelectorAll) container.querySelectorAll(selector).forEach(mark);

    if (container._holds) { container._holds.set(selector, fn); return; }
    const holds = container._holds = new Map();
    holds.set(selector, fn);

    const match = e => {
      const from = e.target && e.target.closest ? e.target : null;
      if (!from) return null;
      for (const [sel, cb] of holds) {
        const t = from.closest(sel);
        if (t && container.contains(t)) return { target: t, cb };
      }
      return null;
    };

    let timer = null, sx = 0, sy = 0, fired = false, ptype = '', clearT = null;
    const cancel = () => { clearTimeout(timer); timer = null; };
    // a stale flag must never eat some later, unrelated tap
    const armClear = () => {
      clearTimeout(clearT);
      clearT = setTimeout(() => { container._suppressClick = false; }, 350);
    };

    container.addEventListener('pointerdown', e => {
      ptype = e.pointerType;
      fired = false;
      container._suppressClick = false;
      cancel();
      if (e.pointerType === 'mouse') return;
      const m = match(e);
      if (!m) return;
      mark(m.target);
      sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => {
        timer = null;
        fired = true;
        container._suppressClick = true;
        armClear();
        m.cb(m.target, e);
      }, 500);
    });
    container.addEventListener('pointermove', e => {
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel();
    });
    ['pointerup', 'pointercancel'].forEach(t => container.addEventListener(t, () => {
      cancel();
      if (fired) armClear();
    }));
    container.addEventListener('contextmenu', e => {
      const m = match(e);
      if (!m) return;
      e.preventDefault();                  // no native menu on matched elements
      if (ptype === 'mouse' || ptype === '') m.cb(m.target, e);
    });
    container.addEventListener('click', e => {
      if (!container._suppressClick) return;
      container._suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  /* ---------------- haptics ---------------- */
  let hapticLabel = null, hapticInput = null;
  /** iOS 18+ fires a tick when a `switch` checkbox is toggled by a label click */
  function haptic() {
    try {
      if (!hapticLabel) {
        hapticLabel = document.createElement('label');
        hapticLabel.setAttribute('aria-hidden', 'true');
        hapticLabel.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
        const input = hapticInput = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('switch', '');
        input.setAttribute('aria-hidden', 'true');
        input.tabIndex = -1;
        hapticLabel.appendChild(input);
        document.body.appendChild(hapticLabel);
      }
      // the label click focuses its hidden input — hand focus back so keyboard users keep their place
      const prev = document.activeElement;
      hapticLabel.click();
      if (document.activeElement === hapticInput) {
        if (prev && prev !== hapticInput && prev !== document.body && prev.focus && document.body.contains(prev)) {
          prev.focus({ preventScroll: true });
        }
        if (document.activeElement === hapticInput) hapticInput.blur();
      }
    } catch (e) { /* unsupported — no-op */ }
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* ignore */ }
  }

  /* ---------------- celebrate ---------------- */
  let celebrateTimer = null;
  function celebrate(slug) {
    if (reduceMotion()) return;
    const old = document.querySelector('.celebrate');
    if (old) old.remove();
    clearTimeout(celebrateTimer);
    const el = document.createElement('div');
    el.className = 'celebrate';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = emoji(slug, { anim: true, size: 120 });
    document.body.appendChild(el);
    celebrateTimer = setTimeout(() => el.remove(), 1600);
  }

  /** ids: day100:<dateKey>, goal:<goalId>, freeze:<habitId>:<dateKey> */
  function celebrateOnce(id, slug) {
    const key = 'cel:' + id;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch (e) { /* storage blocked: still celebrate */ }
    celebrate(slug);
  }

  window.UI = { ICON, ANIM, modal, close, confirm, toast, colorSwatches, bindSwatches,
                emoji, streakChip, onHold, haptic, celebrate, celebrateOnce };
})();
