/* ============================================================
   charts.js — SVG chart renderers
   Mark spec: 1.5px lines, flat area fill, square >=8px hover markers,
   dashed recessive grid, crosshair + tooltip on every line/area chart,
   selective labels.
   ============================================================ */
(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  window.esc = esc;

  const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  /* ---------- segmented bar (one block per step; lit = done) ---------- */
  function segments(done, total, opt) {
    const max = Math.max(1, (opt && opt.max) || 31);
    const n = Math.max(1, Math.min(Math.floor(total) || 0, max));
    const on = clamp(Math.floor(done) || 0, 0, n);
    let out = '';
    for (let i = 0; i < n; i++) out += i < on ? '<i class="on"></i>' : '<i></i>';
    return `<div class="segbar" aria-hidden="true">${out}</div>`;
  }

  /* ---------- sparkline (single series, no axis) ---------- */
  function spark(values, opt) {
    const o = Object.assign({ w: 600, h: 44, color: null }, opt);
    const n = values.length;
    if (!n) return '';
    const col = o.color || 'var(--accent)';
    const max = Math.max(100, ...values);
    const x = i => n === 1 ? o.w / 2 : (i / (n - 1)) * o.w;
    const y = v => o.h - 4 - (v / max) * (o.h - 8);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const dots = values.map((v, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.8" fill="${col}"/>`).join('');
    return `<svg viewBox="0 0 ${o.w} ${o.h}" preserveAspectRatio="none" style="width:100%;height:${o.h}px">
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.5"
                stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${dots}</svg>`;
  }

  /* ---------- responsive mount helper ---------- */
  function mount(el, draw) {
    if (!el) return;
    let lastW = -1;
    // redraw only on a real width change — drawing rewrites innerHTML, which
    // would otherwise re-trigger the observer and spin
    const run = () => {
      const w = el.clientWidth;
      if (w > 0 && w !== lastW) { lastW = w; draw(w); }
    };
    run();
    if (el._ro) el._ro.disconnect();
    el._ro = new ResizeObserver(run);
    el._ro.observe(el);
    // the first paint can land before layout settles
    requestAnimationFrame(run);
  }

  /**
   * Line / area chart with crosshair + tooltip.
   * cfg: { labels:[], series:[{name,color,values:[]}], height, area:bool,
   *        yMax, fmt(v), tipTitle(i) }
   */
  function lines(el, cfg) {
    const c = Object.assign({ height: 220, area: false, yMax: null,
                              fmt: v => v, tipTitle: null }, cfg);
    const series = c.series.filter(s => s.values && s.values.length);
    if (!series.length) { el.innerHTML = '<div class="empty">No data yet.</div>'; return; }
    const n = series[0].values.length;

    mount(el, (W) => {
      const H = c.height, padL = 8, padR = 8, padT = 14, padB = 24;
      const iw = Math.max(10, W - padL - padR), ih = H - padT - padB;
      const allV = series.flatMap(s => s.values).filter(v => v != null);
      const yMax = c.yMax != null ? c.yMax : Math.max(1, Math.ceil(Math.max(...allV) / 10) * 10);
      const X = i => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      const Y = v => padT + ih - (clamp(v, 0, yMax) / yMax) * ih;

      // recessive gridlines
      let grid = '';
      for (let g = 0; g <= 4; g++) {
        const gy = padT + (ih / 4) * g;
        grid += `<line class="grid-line" x1="${padL}" y1="${gy.toFixed(1)}"
                  x2="${padL + iw}" y2="${gy.toFixed(1)}"/>`;
      }

      // ~6 evenly spaced x labels (4 on a phone), never every point
      const step = Math.max(1, Math.ceil(n / (W < 500 ? 4 : 6)));
      let xlab = '';
      for (let i = 0; i < n; i += step) {
        const anchor = i === 0 ? 'start' : (i > n - step ? 'end' : 'middle');
        xlab += `<text class="axis-lbl" x="${X(i).toFixed(1)}" y="${H - 6}"
                  text-anchor="${anchor}">${esc(c.labels[i] || '')}</text>`;
      }

      // a null value is "no data" (e.g. a day that hasn't happened) — break the
      // line there rather than drawing it down to zero
      const runs = vals => {
        const out = []; let cur = [];
        vals.forEach((v, i) => {
          if (v == null) { if (cur.length) out.push(cur); cur = []; }
          else cur.push(i);
        });
        if (cur.length) out.push(cur);
        return out;
      };

      const paths = series.map(s => {
        const segs = runs(s.values);
        if (!segs.length) return '';
        const d = segs.map(seg =>
          'M' + seg.map(i => `${X(i).toFixed(1)},${Y(s.values[i]).toFixed(1)}`).join('L')).join(' ');
        const col = esc(s.color);
        const line = `<path d="${d}" fill="none" stroke="${col}"
                        stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        // a run of one point would be invisible as a stroke — mark it
        const lone = segs.filter(g => g.length === 1).map(g =>
          `<rect x="${(X(g[0]) - 2.5).toFixed(1)}" y="${(Y(s.values[g[0]]) - 2.5).toFixed(1)}"
                   width="5" height="5" fill="${col}"/>`).join('');
        if (!c.area) return line + lone;
        const base = padT + ih;
        const fills = segs.filter(g => g.length > 1).map(g =>
          `<path d="M${g.map(i => `${X(i).toFixed(1)},${Y(s.values[i]).toFixed(1)}`).join('L')}` +
          `L${X(g[g.length-1]).toFixed(1)},${base}L${X(g[0]).toFixed(1)},${base}Z"
                 fill="${col}" fill-opacity=".1" stroke="none"/>`).join('');
        return fills + line + lone;
      }).join('');

      const markers = series.map(s =>
        `<rect class="hov-dot" width="8" height="8" fill="${esc(s.color)}" opacity="0"/>`).join('');

      el.innerHTML = `
        <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
          ${grid}${xlab}${paths}
          <line class="hov-line" x1="0" y1="${padT}" x2="0" y2="${padT + ih}"
                stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
          ${markers}
          <rect class="hit" x="${padL}" y="0" width="${iw}" height="${H}" fill="transparent"/>
        </svg>
        <div class="tip"></div>`;

      const svg  = el.querySelector('svg');
      const tip  = el.querySelector('.tip');
      const vline= el.querySelector('.hov-line');
      const dots = [...el.querySelectorAll('.hov-dot')];

      function show(ev) {
        const box = svg.getBoundingClientRect();
        const px = ev.clientX - box.left;
        const i = clamp(Math.round(((px - padL) / iw) * (n - 1)), 0, n - 1);
        const cx = X(i);
        vline.setAttribute('x1', cx); vline.setAttribute('x2', cx);
        vline.setAttribute('opacity', '1');
        dots.forEach((d, si) => {
          const v = series[si].values[i];
          if (v == null) { d.setAttribute('opacity', '0'); return; }
          d.setAttribute('x', cx - 4); d.setAttribute('y', Y(v) - 4); d.setAttribute('opacity', '1');
        });
        const rows = series.map(s => `
          <div class="tip-row">
            <span class="legend-swatch" style="background:${esc(s.color)}"></span>
            <span>${esc(s.name)}</span>
            <b>${s.values[i] == null ? '—' : esc(c.fmt(s.values[i]))}</b>
          </div>`).join('');
        tip.innerHTML = `<div class="tip-date">${esc(c.tipTitle ? c.tipTitle(i) : c.labels[i])}</div>${rows}`;
        tip.classList.add('is-on');
        // keep the tooltip inside the container; anchor to any series that has a value here
        const anchor = series.map(s => s.values[i]).find(v => v != null);
        const tw = tip.offsetWidth;
        tip.style.left = clamp(cx, tw / 2 + 4, W - tw / 2 - 4) + 'px';
        tip.style.top  = ((anchor == null ? padT + ih / 2 : Y(anchor)) - 12) + 'px';
      }
      function hide() {
        clearTimeout(touchT);
        tip.classList.remove('is-on');
        vline.setAttribute('opacity', '0');
        dots.forEach(d => d.setAttribute('opacity', '0'));
      }
      const hit = el.querySelector('.hit');
      let touchT;
      const onShow = ev => { clearTimeout(touchT); show(ev); };
      hit.addEventListener('pointermove', onShow);
      hit.addEventListener('pointerdown', onShow);
      // a finger lifting also "leaves" the chart: keep the readout up for a moment instead
      hit.addEventListener('pointerup', ev => {
        if (ev.pointerType === 'touch') touchT = setTimeout(hide, 2500);
      });
      hit.addEventListener('pointerleave', ev => { if (ev.pointerType !== 'touch') hide(); });
      hit.addEventListener('pointercancel', hide);
    });
  }

  function legend(series) {
    return `<div class="legend">${series.map(s => `
      <span class="legend-item">
        <span class="legend-swatch" style="background:${esc(s.color)}"></span>${esc(s.name)}
      </span>`).join('')}</div>`;
  }

  window.Charts = { segments, spark, lines, legend, mount, esc };
})();
