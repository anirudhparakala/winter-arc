# Instrument Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Winter Arc into the approved "Instrument" look (desktop + iPhone portrait) with Fluent 3D emoji, without changing features, settings or data.

**Architecture:** Plain HTML/CSS/JS, no framework, no bundler (unchanged). `css/style.css` is rewritten around new tokens; views keep their render-into-`#view` pattern and their Store calls, only their markup changes. Small shared helpers (emoji, segments, long-press, haptic, celebrate) are added to `js/ui.js` / `js/charts.js`. Fonts and emoji are vendored under `assets/` so the PWA and the single-file build work offline.

**Tech Stack:** Vanilla JS (IIFE modules on `window`), CSS custom properties, SVG, Node scripts in `tools/` for tests/build, Playwright MCP for screenshots.

**Spec:** `docs/superpowers/specs/2026-10-01-ui-redesign-design.md` — visual source of truth: `docs/superpowers/specs/instrument-mockup.html` (port its CSS values; don't re-invent them).

## Global Constraints

- No new features, no removed settings/options; every existing button/action keeps working.
- `js/store.js` logic unchanged except the default habit list. Storage key `winterArc.v1` and backup format unchanged.
- One accent `#8ecbff` (dark) for lit states only; true black `#000`; panels `#0a0a0a`; rules `#1f1f1f`/`#2e2e2e`; text `#f2f2f2`; greys `#8a8a8a`/`#555` (body text greys must meet 4.5:1 on black — use `#8a8a8a` for text, `#555` only for non-essential labels ≥ 11px uppercase).
- No border-radius except circles (LED dots, emoji); no gradients; no soft drop shadows (LED glow allowed).
- Fonts: Doto (hero numbers, logo, clock only), Space Grotesk (UI), Space Mono (labels/data). Labels 11px uppercase .12em.
- Motion: `--snap: cubic-bezier(.4,0,1,1)` 0.1s; press = `translateY(1px)`; everything off under `prefers-reduced-motion`.
- Phone breakpoint ≤ 760px: bottom nav, single column, targets ≥ 44px, inputs ≥ 16px font, safe-area insets. Portrait only.
- Offline: every asset is local; no runtime CDN requests.
- Default habits: Wake up at 5AM, Gym (weekly ×5), Read 10 pages, Eat healthy, Plan next day, Cold shower, No social media.
- Commit after each task; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Existing saved data** (9 habits, old teal-era colours, goals, tasks) must render correctly — no layout assumptions about habit count or colour values. → Task 4 test: seed 9 habits + 12 habits screenshots.
2. **Long-press on iPhone** must spend a freeze *without* also firing the tap toggle, and must not trigger iOS text selection/callout. → Task 3 `UI.onHold` cancels the follow-up click; Task 5 manual check in Playwright with touch emulation.
3. **Re-render on every commit** (`App.render` rebuilds `innerHTML`): celebrations (🎉, 🏆, ❄️) must fire only on the *transition*, never replay on unrelated re-renders. → Task 3 `UI.celebrateOnce(key)` guard; Task 4/7 checks.
4. **Habits matrix scroll**: opens scrolled to today on first render / month change, but keeps the user's position across re-renders after toggling a cell. → Task 5.
5. **Offline / single file**: fonts + emoji load from the service-worker cache and from `dist/winter-arc.html` opened via `file://` with no network. → Task 9 `tools/test-build.js`.

---

### Task 1: Vendor fonts and Fluent emoji

**Files:**
- Create: `tools/fetch-assets.js`, `assets/fonts/*.woff2`, `assets/emoji/*.png`, `assets/LICENSES.md`
- Create: `tools/test-assets.js`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `assets/emoji/<slug>.png` for slugs `fire, snowflake, star, party, trophy, health, career, finance, relations, romance, spirit, home, travel, fun, community`; animated variants `assets/emoji/<slug>-anim.png` for `fire, snowflake, party, trophy` when obtainable. Fonts `assets/fonts/doto-900.woff2, doto-700.woff2, space-grotesk-400.woff2, space-grotesk-500.woff2, space-grotesk-600.woff2, space-mono-400.woff2, space-mono-700.woff2`.

- [ ] **Step 1: Write the failing test** `tools/test-assets.js`

```js
/* Every asset the UI references must exist locally (offline-first). */
const fs = require('fs'), path = require('path'), assert = require('assert');
const A = path.join(__dirname, '..', 'assets');
const EMOJI = ['fire','snowflake','star','party','trophy','health','career','finance',
  'relations','romance','spirit','home','travel','fun','community'];
const FONTS = ['doto-900','doto-700','space-grotesk-400','space-grotesk-500',
  'space-grotesk-600','space-mono-400','space-mono-700'];
EMOJI.forEach(e => assert.ok(fs.statSync(path.join(A,'emoji',e+'.png')).size > 1000, 'emoji '+e));
FONTS.forEach(f => assert.ok(fs.statSync(path.join(A,'fonts',f+'.woff2')).size > 1000, 'font '+f));
// animated emoji are optional, but if present must stay small enough to inline
fs.readdirSync(path.join(A,'emoji')).filter(f => f.endsWith('-anim.png')).forEach(f =>
  assert.ok(fs.statSync(path.join(A,'emoji',f)).size < 400*1024, f + ' too large'));
console.log('assets ok');
```

- [ ] **Step 2: Run it** — `node tools/test-assets.js` → FAIL (ENOENT).

- [ ] **Step 3: Write `tools/fetch-assets.js`** (Node ≥18 `fetch`; re-runnable):

```js
/* Downloads the vendored fonts + Fluent emoji. Run once: node tools/fetch-assets.js */
const fs = require('fs'), path = require('path');
const A = path.join(__dirname, '..', 'assets');
const FL = 'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/';
const FLA = 'https://media.githubusercontent.com/media/microsoft/fluentui-emoji-animated/main/assets/';
const FS = 'https://cdn.jsdelivr.net/npm/@fontsource/';
const EMOJI = {
  fire: 'Fire/3D/fire_3d.png', snowflake: 'Snowflake/3D/snowflake_3d.png',
  star: 'Star/3D/star_3d.png', party: 'Party popper/3D/party_popper_3d.png',
  trophy: 'Trophy/3D/trophy_3d.png',
  health: 'Flexed biceps/Default/3D/flexed_biceps_3d_default.png',
  career: 'Chart increasing/3D/chart_increasing_3d.png',
  finance: 'Money bag/3D/money_bag_3d.png',
  relations: 'Handshake/Default/3D/handshake_3d_default.png',
  romance: 'Red heart/3D/red_heart_3d.png', spirit: 'Sparkles/3D/sparkles_3d.png',
  home: 'House/3D/house_3d.png', travel: 'Compass/3D/compass_3d.png',
  fun: 'Video game/3D/video_game_3d.png',
  community: 'Globe showing europe-africa/3D/globe_showing_europe-africa_3d.png'
};
const ANIM = { fire: 'Fire/animated/fire_animated.png',
  snowflake: 'Snowflake/animated/snowflake_animated.png',
  party: 'Party popper/animated/party_popper_animated.png',
  trophy: 'Trophy/animated/trophy_animated.png' };
const FONTS = {
  'doto-900': 'doto/files/doto-latin-900-normal.woff2',
  'doto-700': 'doto/files/doto-latin-700-normal.woff2',
  'space-grotesk-400': 'space-grotesk/files/space-grotesk-latin-400-normal.woff2',
  'space-grotesk-500': 'space-grotesk/files/space-grotesk-latin-500-normal.woff2',
  'space-grotesk-600': 'space-grotesk/files/space-grotesk-latin-600-normal.woff2',
  'space-mono-400': 'space-mono/files/space-mono-latin-400-normal.woff2',
  'space-mono-700': 'space-mono/files/space-mono-latin-700-normal.woff2'
};
async function get(url, out, optional) {
  const r = await fetch(encodeURI(url));
  if (!r.ok) { if (optional) { console.warn('skip', url, r.status); return; } throw new Error(url + ' ' + r.status); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  console.log('ok', path.relative(A, out), fs.statSync(out).size);
}
(async () => {
  for (const [k, p] of Object.entries(EMOJI)) await get(FL + p, path.join(A, 'emoji', k + '.png'));
  for (const [k, p] of Object.entries(FONTS)) await get(FS + p, path.join(A, 'fonts', k + '.woff2'));
  for (const [k, p] of Object.entries(ANIM)) await get(FLA + p, path.join(A, 'emoji', k + '-anim-src.png'), true);
})();
```

If a path 404s, look up the exact folder name in the repo listing (`https://github.com/microsoft/fluentui-emoji/tree/main/assets`) and fix the map — don't substitute a different emoji silently.

- [ ] **Step 4: Run** `node tools/fetch-assets.js`, then shrink static emoji to 96px and animated sources to ≤ 400 KB:
  - Static: if ImageMagick/`sharp` is unavailable, leave 256px PNGs (≈ 30–80 KB each, acceptable).
  - Animated `*-anim-src.png` (APNG 256px): if `ffmpeg` is available run `ffmpeg -i fire-anim-src.png -vf scale=96:96 -plays 0 -f apng fire-anim.png`; otherwise rename to `-anim.png` only if already < 400 KB, else delete it (UI falls back to static + CSS motion — see Task 3). Delete all `*-anim-src.png` afterwards.
- [ ] **Step 5: Write `assets/LICENSES.md`** — Fluent Emoji © Microsoft, MIT (link both repos); Doto, Space Grotesk, Space Mono — SIL Open Font License 1.1 (Google Fonts / Fontsource).
- [ ] **Step 6: Update `package.json`** — `"test": "node tools/test-store.js && node tools/test-assets.js"`, add `"assets": "node tools/fetch-assets.js"`.
- [ ] **Step 7: Run** `npm test` → all pass, "assets ok".
- [ ] **Step 8: Commit** `git add assets tools/fetch-assets.js tools/test-assets.js package.json && git commit -m "Vendor Instrument fonts and Fluent 3D emoji"`

---

### Task 2: Tokens, fonts and the shell (status strip + nav)

**Files:**
- Modify: `index.html` (head meta, topbar markup, remove `.dots`, add clock)
- Modify: `js/app.js` (remove dots + `pageTitle` logic, add clock, keep `document.title`)
- Modify: `css/style.css` (rewrite top section: `@font-face`, tokens, base, shell)
- Modify: `manifest.webmanifest`

**Interfaces:**
- Produces CSS tokens used by all later tasks: `--bg --panel --rule --rule-2 --text --g1 --g2 --accent --accent-glow --led-off --snap --f-dot --f-ui --f-mono`, utility classes `.lb` (label), `.dotnum` (Doto number), `.mod` (module panel), `.mh` (module header), `.press` (1px push).
- Nav buttons keep `data-page` and `.nav-btn.is-active` (app.js relies on them).

- [ ] **Step 1: `index.html` head** — viewport `width=device-width, initial-scale=1, viewport-fit=cover`; `<meta name="theme-color" content="#000000">`; add `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`, `<meta name="apple-mobile-web-app-title" content="Winter Arc">`; favicon → `assets/emoji/snowflake.png`; preload `assets/fonts/space-grotesk-400.woff2` and `doto-900.woff2` (`<link rel="preload" as="font" type="font/woff2" crossorigin>`).
- [ ] **Step 2: `index.html` body** — replace `.frame/.topbar` with:

```html
<header class="strip">
  <span class="logo dotnum">WINTER ARC</span>
  <nav class="nav" id="nav" aria-label="Pages">
    <button class="nav-btn is-active" data-page="today"><i>1</i><span>Today</span></button>
    <button class="nav-btn" data-page="habits"><i>2</i><span>Habits</span></button>
    <button class="nav-btn" data-page="tasks"><i>3</i><span>Tasks</span></button>
    <button class="nav-btn" data-page="goals"><i>4</i><span>Goals</span></button>
    <button class="nav-btn" data-page="insights"><i>5</i><span>Insights</span></button>
  </nav>
  <div class="strip-r"><span class="clock dotnum" id="clock" aria-hidden="true"></span>
    <button class="icon-btn" id="settingsBtn" aria-label="Settings">…keep existing gear svg…</button></div>
</header>
<main id="view" class="view"></main>
```
Delete `<div class="dots" id="dots">`. Keep modal + toast markup.
- [ ] **Step 3: `js/app.js`** — remove `dots`, `titleEl` and their handlers; in `render()` keep `document.title = cap(v.title) + ' · Winter Arc'`; add view-enter class: after `v.render(view)` do `view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter')` only when the page changed (track `lastPage`). Add clock:

```js
const clockEl = document.getElementById('clock');
const tick = () => { clockEl.textContent = new Date().toTimeString().slice(0, 5); };
tick(); setInterval(tick, 15000);
```
- [ ] **Step 4: `css/style.css` top** — `@font-face` for the 7 fonts (`font-display: swap`), tokens from Global Constraints, light theme block `:root[data-theme="light"]` (bg `#fff`, panel `#f6f6f6`, rules `#e2e2e2/#cfcfcf`, text `#0a0a0a`, greys `#5c5c5c/#8a8a8a`, accent `#1f7fd1`, led-off `#e8e8e8`, dot-grid `#e6e6e6`), body = black + dot grid `radial-gradient(var(--grid) 1px, transparent 1.2px) 0 0/12px 12px`, page padding `20px 32px` + `env(safe-area-inset-*)`, max-width 1120px centred. Port `.bar/.logo/.clock/nav` styles from the mockup (`nav` square, 1px rules, active = inverted white/black, `<i>` key number grey). `.view.enter { animation: enter .18s var(--snap) }` (opacity 0 → 1, translateY 4px → 0).
- [ ] **Step 5: Phone (≤ 760px)** — `.nav` fixed bottom, full width, `padding-bottom: env(safe-area-inset-bottom)`, buttons flex:1 min-height 56px, key number above label; hide `.clock`; body bottom padding `calc(84px + env(safe-area-inset-bottom))`; `html { -webkit-text-size-adjust: 100% }`, `* { -webkit-tap-highlight-color: transparent }`.
- [ ] **Step 6: `manifest.webmanifest`** — `orientation: "portrait"`, `background_color` and `theme_color` `#000000`.
- [ ] **Step 7: Verify** — `npm start`, open via Playwright at 1440×900 and 390×844; nav switches pages with click and keys 1–5; no console errors. `npm test` passes.
- [ ] **Step 8: Commit** "Instrument shell: tokens, fonts, status strip, bottom nav".

---

### Task 3: Shared components and helpers

**Files:**
- Modify: `js/ui.js`, `js/charts.js`, `css/style.css` (component section)

**Interfaces (Produces — exact names used by Tasks 4–8):**
- `UI.emoji(slug, { lit = true, anim = false, size = 20, label = '' }) → string` — `<img class="emo[ is-off][ is-anim]" src="assets/emoji/<slug>[-anim].png" width height alt>`; if `anim` and no `-anim` file exists (`UI.ANIM` set below), returns the static image with class `is-anim` (CSS flicker fallback). `lit:false` adds `is-off` (grayscale + 40% brightness).
- `UI.ANIM = new Set([...])` — filled with the slugs that have `-anim.png` after Task 1 (hard-code the list that actually exists).
- `UI.streakChip(n) → string` — now `UI.emoji('fire', { lit: n >= 3, anim: n >= 3, size: 18 })` + mono number padded to 2 (`String(n).padStart(2,'0')`), wrapped in `<span class="streak[ is-hot]">`.
- `UI.onHold(container, selector, fn(target, event))` — long-press (500 ms, cancel on move > 8px or pointerup) for touch/pen pointers; also `contextmenu` for mouse. Calls `fn` once; sets `container._suppressClick = true` and swallows the next `click` in capture phase so the tap toggle doesn't fire. Adds CSS `-webkit-touch-callout:none; user-select:none` to matched elements.
- `UI.haptic()` — iOS 18+ trick: a hidden `<input type="checkbox" switch>` inside a `<label>`; `label.click()`; no-op where unsupported; also `navigator.vibrate?.(8)`.
- `UI.celebrate(slug)` — shows a centred overlay `<div class="celebrate">` with `UI.emoji(slug, { anim: true, size: 120 })` for 1.6 s (static + CSS pop under reduced motion is fine; skip entirely under `prefers-reduced-motion`).
- `UI.celebrateOnce(id, slug)` — calls `celebrate` only if `sessionStorage['cel:'+id]` is unset, then sets it (wrap storage in try/catch). Ids used: `day100:<dateKey>`, `goal:<goalId>`, `freeze:<habitId>:<dateKey>`.
- `Charts.segments(done, total, { max = 31 } = {}) → string` — `<div class="segbar">` with `min(total,max)` `<i>` blocks, the first `done` with `class="on"`; `total = 0` renders one empty block.
- `Charts.ring` — keep signature; restyle to square-capped thin stroke (`stroke-linecap: butt`), centre value in Doto.

- [ ] **Step 1: Write a smoke test** `tools/test-ui.js` that loads `js/charts.js` in a vm with a stub `document`/`getComputedStyle` and asserts:

```js
assert.strictEqual((Charts.segments(3, 7).match(/<i/g) || []).length, 7);
assert.strictEqual((Charts.segments(3, 7).match(/class="on"/g) || []).length, 3);
assert.strictEqual((Charts.segments(0, 0).match(/<i/g) || []).length, 1);
assert.strictEqual((Charts.segments(40, 40).match(/<i/g) || []).length, 31);
```
(Stub: `ctx.document = { documentElement: {} }; ctx.getComputedStyle = () => ({ getPropertyValue: () => '' }); ctx.ResizeObserver = class { observe(){} disconnect(){} }; ctx.requestAnimationFrame = f => f();`)
- [ ] **Step 2: Run** `node tools/test-ui.js` → FAIL (`Charts.segments` undefined).
- [ ] **Step 3: Implement** `Charts.segments` in `js/charts.js` and export it; run test → PASS. Add `node tools/test-ui.js` to the `test` script.
- [ ] **Step 4: Implement** `UI.emoji`, `UI.ANIM`, new `UI.streakChip`, `UI.onHold`, `UI.haptic`, `UI.celebrate`, `UI.celebrateOnce` in `js/ui.js` per the interface above. Replace `ICON.flame/star/snow` usages' *visuals* only where Tasks 4–8 say so (keep the `ICON` keys so nothing breaks meanwhile).
- [ ] **Step 5: Component CSS** (port from mockup; square, 1px rules): `.btn` (bordered, uppercase mono 11px, transparent; `.btn-primary` = accent bg, black text; `.btn-danger` = text `#ff6b6b`), `.input/.select/.textarea` (black bg, 1px `--rule-2`, square, 16px font on phone), `.field > span` = `.lb`, `.pill` → square tag (mono 11px uppercase, 1px rule; `.pill-accent` = accent border+text), `.seg` → hardware toggle (1px outer rule, buttons separated by rules, active inverted), `.check` → 18px square LED (`.is-done` accent fill + glow + inner 6px black square; `.is-freeze` hollow accent outline), `.segbar` (gap 4px, blocks 10px tall, `.on` accent + glow), `.emo` (`.is-off` filter grayscale(1) brightness(.45); `.is-anim` CSS `fl` keyframes when no anim file), `.celebrate` overlay, `.modal` (square, 1px rule, black panel; ≤ 760px: bottom sheet — `.modal-root` aligns end, `.modal` width 100%, slides up, `padding-bottom: env(safe-area-inset-bottom)`), `.toast` (square, mono, above bottom nav on phone), `.tip` (square, mono). Press feedback: `button:active { transform: translateY(1px) }`.
- [ ] **Step 6: Verify** — `npm test` passes; open each page: nothing broken (views still use old markup but new component styles).
- [ ] **Step 7: Commit** "Instrument components + emoji/long-press/haptic/celebrate helpers".

---

### Task 4: Today

**Files:** Modify `js/views/today.js`, `css/style.css` (TODAY section)

**Interfaces:** Consumes `Charts.segments`, `UI.emoji`, `UI.streakChip`, `UI.onHold`, `UI.haptic`, `UI.celebrateOnce`, existing Store API (`dayScore, dayTally, activeHabits, status, isMet, toggle, freeze, streak, periodCount, arc, state.freezeTokens, bestStreak`, tasks API).

- [ ] **Step 1: Markup** (keep every existing action: toggle, freeze, freeze-token modal, task add/toggle/delete):
  - Hero: `<div class="hero"><div class="pct dotnum">${pct}<sup>%</sup></div><div>` + `.lb` line `${D.longDate(d)} — day ${pad3(a.elapsed)} of ${a.total}` + `Charts.segments(tally.done, tally.total)` + spec row of 4: Done `${done}/${total}`, Best run `${max bestStreak}D`, Freezes `${pad2(tokens)}` (button `#tokBtn` → existing modal), Remaining `${a.left}`.
  - Module `01 / Habits` (header right `.lb`: "Tap to log · hold to freeze"): rows `<div class="hrow[ is-done][ is-freeze]" data-habit>` = `.check` button `data-act="toggle"`, index `01`, colour marker (4×14px bar in `h.color`), name, weekly/monthly tag via existing `periodLabel`, `UI.streakChip`. Remove the per-row snowflake button; freeze = `UI.onHold(list, '[data-habit]', …)` (calls existing `Store.freeze` + toast; on success `UI.celebrateOnce('freeze:'+id+':'+key, 'snowflake')`).
  - Module `02 / Today's tasks`: existing task list markup restyled (square checks, mono count `done/total`).
  - Desktop grid: hero full width; modules 2 columns (`1fr 1.35fr`, separated by 1px rule as in mockup). Phone: single column, rows min-height 56px.
- [ ] **Step 2: Behaviour** — on toggle: `UI.haptic()`; after commit, if `Store.dayScore(key) === 100 && tally.total > 0` → `UI.celebrateOnce('day100:'+key, 'party')`. Empty state (no habits): module body "No habits yet — add one on Habits (2)".
- [ ] **Step 3: Verify (Review Focus 1, 2, 3)** — Playwright at 1440 and 390: (a) default 7 habits; (b) seed localStorage with 12 habits incl. old colours via `localStorage.setItem('winterArc.v1', …)` and reload — no overflow; (c) tick all → 🎉 once, re-render (toggle a task) → no replay; (d) touch emulation long-press a row → freeze applied, row not toggled. `npm test` passes.
- [ ] **Step 4: Commit** "Instrument Today page".

---

### Task 5: Habits (LED matrix)

**Files:** Modify `js/views/habits.js`, `css/style.css` (HABITS section)

**Interfaces:** Consumes `UI.onHold`, `UI.streakChip`, `UI.emoji`, `UI.haptic`, `UI.celebrateOnce`; keeps `Views.habits.newHabit` and `habitModal` unchanged (modal restyled via Task 3 CSS).

- [ ] **Step 1: Header module** — `.lb` month label + `${tally.done}/${tally.total} today` + `Charts.segments(avg, 100, {max: 20})`-style avg bar (use `Math.round(avg/5)` of 20), prev/next square buttons, `.seg` Daily/Weekly/Monthly, `+ New habit` primary button. Keep ids `prevM nextM newH cadSeg`.
- [ ] **Step 2: Matrix** — keep the `<table class="hgrid">` (sticky name column already works) inside `.grid-wrap.scroll-x`. Cells become LED dots: `.cell` 14px circle `--led-off`; `.is-done` accent + glow; `.is-freeze` hollow accent ring; `.is-today` blinking outline (`@keyframes blink` steps(2)); `.is-future` `#0f0f0f` disabled; `.is-off` 15% opacity. Remove the check/snow icons inside cells. Day header numbers in mono 10px, today in accent. Trend row: `Charts.spark` restyled thin 1px accent line, dots removed. Stats column: mono `${rate}%`, `UI.streakChip(streak)`, `UI.emoji('star',{lit: best>0,size:14})` + best. Phone: cell 26px hit area (dot 12px centred), name column 104px.
- [ ] **Step 3: Interactions** — click toggles (+ `UI.haptic()`); replace the `contextmenu` listener with `UI.onHold(bodyEl, '.cell:not([disabled])', cell => …Store.freeze…)` (covers right-click and long-press). Hint line: "Tap a dot to log · hold (or right-click) to freeze · N freezes left · tap a name to edit".
- [ ] **Step 4: Scroll (Review Focus 4)** — module-level `let scrolledFor = null;` after render, if `scrolledFor !== monthKey` and the month contains today: `wrap.scrollLeft = todayCell.offsetLeft - nameColWidth - 3*cellWidth`, then `scrolledFor = monthKey`. Otherwise app.js's existing scroll preservation applies.
- [ ] **Step 5: Verify** — 1440 + 390: grid opens at today on phone; toggle a cell → position kept; long-press → freeze; prev/next month works; weekly/monthly filters; edit/delete habit modal. `npm test` passes.
- [ ] **Step 6: Commit** "Instrument Habits matrix".

---

### Task 6: Tasks

**Files:** Modify `js/views/tasks.js`, `css/style.css` (TASKS section)

- [ ] **Step 1: Top modules** — `01 / Week`: `.lb` "Week of" + range tag, prev / This week / next (ids unchanged), per-day vertical segment columns (replace `.wbars` fill with 10 stacked blocks lit by `Math.round(p/10)`), week % in Doto, `${doneAll}/${total} completed`. `02 / Mindset`: `Charts.lines` unchanged API; restyle via CSS (1.5px lines, square tooltip, mono axis). Series colours: Energy `#ff9a5c`, Focus `#8ecbff`, Motivation `#7fe0b0` (keep `MIND[].color`).
- [ ] **Step 2: Day modules** — `.day-card` square panel; head `.lb` day name + mono date; small Doto `pct%` + `Charts.segments(done, list.length)` instead of the 86px ring; tasks with square checks; `+ Add task` input (16px on phone); "Copy yesterday's list" kept; mindset: replace each `<input type=range>` with a 10-block segmented control `<div class="mseg" data-mind="energy">` of 10 `<button data-v="1..10">`; tapping block v sets value v (tapping the currently-set top block sets 0) via existing `Store.setMindset(key, field, v)`; mono value label. Keep `aria-label`s.
- [ ] **Step 3: Layout** — desktop: 7 columns as today (min 150px, scroll-x when narrow). Phone: `.week-board` horizontal scroll-snap carousel (`scroll-snap-type: x mandatory`, each card `flex: 0 0 86vw; scroll-snap-align: center`), on render scroll today's card into view once per week (same guard pattern as Task 5).
- [ ] **Step 4: Verify** — add/toggle/delete/copy tasks, mindset taps persist and chart updates, week navigation, phone carousel opens on today. `npm test` passes.
- [ ] **Step 5: Commit** "Instrument Tasks board".

---

### Task 7: Goals

**Files:** Modify `js/views/goals.js`, `js/store.js` (AREAS gain `emoji` slug field only — keep `icon` for the `<select>` options), `css/style.css` (GOALS section)

- [ ] **Step 1: Store** — add `emoji: 'health'|'career'|…` (slug = area id) to each `AREAS` entry. Run `npm test` → still passes.
- [ ] **Step 2: Hero** — Doto `achieved/total`, `.lb` "goals achieved · mastering N areas", arc tags (start → end, `${a.left} days left`), `Charts.segments(round(a.pct/5), 20)` arc bar, `+ New goal`.
- [ ] **Step 3: Areas** — 10 `.area-card` square cells in a 5×2 grid (phone 2 columns) with `UI.emoji(x.emoji, { lit: list.length > 0, size: 28 })`, name, mono `${n} goals · ${ach} done`; hover/tap: CSS lift + wiggle on the emoji. Filter behaviour unchanged.
- [ ] **Step 4: Goal cards** — square panel; title; tags (status, area emoji 14px + name, days left/over); pin + edit buttons unchanged; progress = `Charts.segments(round(pct/5), 20)` + mono `pct%`; numeric input and milestones unchanged (square checks). When a milestone/number change makes `status` become `achieved` → after commit `UI.celebrateOnce('goal:'+id, 'trophy')`.
- [ ] **Step 5: Verify** — create milestone + numeric goals, pin, filter by area, achieve one → 🏆 once. Phone layout. `npm test` passes.
- [ ] **Step 6: Commit** "Instrument Goals page".

---

### Task 8: Insights and charts

**Files:** Modify `js/views/insights.js`, `js/charts.js` (styling hooks only), `css/style.css` (INSIGHTS + charts)

- [ ] **Step 1** — Consistency module: Doto `${overall}%`, selects restyled, `Charts.lines` with `area: true` changed to a flat 10% accent fill (no gradient: set gradient stops to equal opacity .1). Grid lines dashed `--rule`; axis labels Space Mono 10px.
- [ ] **Step 2** — Tiles → spec row (label over Doto value): This week, vs last week (`+`/`−` in accent / `#ff6b6b`), Best streak with `UI.emoji('fire',{lit:best>=3})`, Needs attention.
- [ ] **Step 3** — Leaderboard + Top streaks: rows with mono rank `01`, name, `Charts.segments(round(v/5), 20)` (lit blocks tinted `h.color` via inline `--on` custom property), mono value. Month-by-month: vertical 10-block columns like Task 6.
- [ ] **Step 4: Verify** — scope/range selects, leaderboard 7/30/90 toggle, tooltip on hover and tap (phone). `npm test` passes.
- [ ] **Step 5: Commit** "Instrument Insights".

---

### Task 9: Defaults, offline, build, README

**Files:** Modify `js/store.js` (default habits), `tools/test-store.js`, `sw.js`, `tools/build.js`; Create `tools/test-build.js`; Modify `README.md`, `package.json`; regenerate `dist/winter-arc.html`, `icons/*` (via `tools/make-icons.js` with black bg + icy snowflake/dot-matrix mark — adjust its colours only).

- [ ] **Step 1: Failing test** in `tools/test-store.js`:

```js
test('fresh install seeds the 7 default habits', () => {
  const ctx = freshStore();
  assert.deepStrictEqual(ctx.Store.state.habits.map(h => h.name),
    ['Wake up at 5AM','Gym','Read 10 pages','Eat healthy','Plan next day','Cold shower','No social media']);
  const gym = ctx.Store.state.habits.find(h => h.name === 'Gym');
  assert.strictEqual(gym.cadence, 'weekly'); assert.strictEqual(gym.target, 5);
});
```
Run `npm test` → FAIL. Remove Meditation and Journaling from `defaultState` (keep colour indices of the rest). Run → PASS.
- [ ] **Step 2: Failing test** `tools/test-build.js` (Review Focus 5):

```js
const { execSync } = require('child_process'); const fs = require('fs'), path = require('path'), assert = require('assert');
const R = path.join(__dirname, '..');
execSync('node tools/build.js', { cwd: R, stdio: 'inherit' });
const html = fs.readFileSync(path.join(R, 'dist/winter-arc.html'), 'utf8');
assert.ok(!/(?:src|href|url\()\s*["']?assets\//.test(html), 'single file still references assets/');
assert.ok(html.includes('data:font/woff2;base64,'), 'fonts not inlined');
assert.ok(html.includes('data:image/png;base64,'), 'emoji not inlined');
const sw = fs.readFileSync(path.join(R, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(s => s.includes('/') || s.endsWith('.html'));
shell.filter(s => s !== './').forEach(s => assert.ok(fs.existsSync(path.join(R, s)), 'missing ' + s));
const files = d => fs.readdirSync(path.join(R, d)).map(f => d + '/' + f);
[...files('assets/fonts'), ...files('assets/emoji')].forEach(f => assert.ok(shell.includes(f), 'not cached: ' + f));
console.log('build ok');
```
Add to `test` script; run → FAIL.
- [ ] **Step 3: `sw.js`** — `CACHE = 'winter-arc-v2'`; add every `assets/fonts/*` and `assets/emoji/*` path to `SHELL`.
- [ ] **Step 4: `tools/build.js`** — after inlining CSS, replace `url("../assets/fonts/X.woff2")` / `url(../assets/...)` with `data:font/woff2;base64,…`; replace every `assets/emoji/<f>.png` string occurring in CSS/JS/HTML with `data:image/png;base64,…` (read file per unique match: `/assets\/emoji\/[\w-]+\.png/g`); favicon/apple-touch-icon likewise; drop `<link rel="preload">` lines. `UI.emoji` must build its `src` from a literal string map (`const EMO = { fire: 'assets/emoji/fire.png', … }`) — not string concatenation — so the build can find and inline each path. Run `npm test` → PASS.
- [ ] **Step 5: README** — live link `https://anirudhparakala.github.io/winter-arc/`; "Based on abhiman-06/winter-arc" credit line; update screenshots text/description of the look; replace "Updating the live site" with Anirudh's fork; mention `npm run assets`; add Attributions section pointing to `assets/LICENSES.md`; update test count wording ("tests" without a number).
- [ ] **Step 6: Icons** — edit colours in `tools/make-icons.js` to black background + `#8ecbff` mark; run `npm run icons`.
- [ ] **Step 7:** `npm test` → all pass; `npm run build` → no warnings. Open `dist/winter-arc.html` via `file://` with network blocked in Playwright (`browser_network_requests` shows no external requests) → fonts + emoji render.
- [ ] **Step 8: Commit** "Default habits, offline assets, build inlining, README for Anirudh's fork".

---

### Task 10: Full visual QA, push, GitHub Pages

- [ ] **Step 1: Screenshots** with Playwright (`npm start` → `http://localhost:4173`): every page × {1440×900, 375×667, 430×932} × {dark, light}; seed realistic data (2 weeks of logs, tasks, 3 goals, mindset values) via `localStorage` before capture. Save to the session scratchpad, not the repo.
- [ ] **Step 2: Checklist per screenshot** — no horizontal page scroll (only matrix/carousel scroll); nothing under the notch/home bar; text contrast OK in light theme; no leftover teal/old styles (`grep -n "2dd4bf\|04201c\|45, 212, 191" css js` → empty); settings modal shows every original field (Arc name, start, length, week start, theme, export, import, reset).
- [ ] **Step 3:** Fix issues found, re-run `npm test`, commit "Instrument QA fixes".
- [ ] **Step 4: Show Anirudh the screenshots; on his OK**, `git push origin main`.
- [ ] **Step 5:** Anirudh enables Pages: GitHub → `anirudhparakala/winter-arc` → Settings → Pages → Source "Deploy from a branch" → `main` / `(root)` → Save. Then verify `https://anirudhparakala.github.io/winter-arc/` loads (WebFetch) and he installs it on his iPhone via Safari → Share → Add to Home Screen.
