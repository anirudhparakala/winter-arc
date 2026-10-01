# Winter Arc — UI/UX redesign ("Instrument") — design spec

Date: 2026-10-01 · Owner: Anirudh Parakala (fork of abhiman-06/winter-arc)
Reference mockup: `instrument-mockup.html` (next to this file) (Instrument v2), approved 2026-10-01.

## Goal

Make the app look and feel distinctive, modern and premium — on desktop **and on
iPhone (portrait)** — and make it Anirudh's own (his fork, his GitHub Pages link).
**No new features.** Avoid the generic "AI-made" look (Inter, gradients,
identical rounded cards, KPI tile rows, generic copy).

Success looks like:
- Every page follows the Instrument direction and scales correctly on iPhone
  portrait widths 375–430px as well as desktop.
- Every existing feature, option and setting still works the same way; saved data
  and backup files stay compatible.
- `npm test` passes; `npm run build` produces a working single file.
- Live at `https://anirudhparakala.github.io/winter-arc/`.

## Non-goals

No new features or data fields (no routines, command bar, smart insights, task
rollover, onboarding, undo toasts). No settings or options removed. No framework
migration — plain HTML/CSS/JS, same file layout. `js/store.js` logic unchanged
except the default habit list (below).

## Approach

Restyle in place: rewrite `css/style.css` around new tokens; adjust view markup
(`index.html`, `js/ui.js`, `js/charts.js`, `js/views/*.js`) where layout, icons or
interaction need it.

## 1. Direction: "Instrument" (Nothing OS / Teenage Engineering inspired)

- **Colour:** true black `#000` with a faint dot-grid background; panels
  `#0a0a0a`; 1px grey rules (`#1f1f1f`/`#2e2e2e`); white text; greys
  `#8a8a8a`/`#555`. **One accent: icy blue `#8ecbff`**, used only for "lit"
  states (done, active, today). No gradients, no soft shadows — the only glow is
  the LED glow on lit elements.
- **Habit colours:** each habit keeps its identity colour, shown only as a small
  marker; the accent stays the single "done" colour.
- **Type (bundled locally for offline):** Doto (dot-matrix) for hero numbers,
  logo and clock only; Space Grotesk for UI text; Space Mono for labels and data.
  Labels: 11px uppercase, 0.12em tracking, grey, value underneath.
- **Shape:** square corners everywhere; modules separated by 1px rules;
  numbered module headers ("01 / Habits", "02 / October matrix").
- **Progress:** segmented bars (one block per item) instead of smooth bars;
  big dot-matrix percentages instead of large rings where a ring is the hero.
- **Motion:** mechanical — 0.1s snap easing; press = 1px push down; today's cell
  blinks like a cursor.
- **Light theme:** kept (setting stays); restyled as the inverse (white, black
  rules, same accent logic).

## 2. Emoji and motion

- **Fluent 3D emoji** (Microsoft, MIT) replace system emoji and the hand-drawn
  flame/star/snowflake SVGs: the 10 goal-area icons, 🔥 ❄️ ⭐, 🎉 🏆. Bundled
  locally (static PNG/WebP; animated WebP ≤ ~150 KB each, converted from
  microsoft/fluentui-emoji-animated). Attribution in README.
- **Lit/unlit rule:** emoji show greyed-out and dim when inactive and light up in
  colour when active (e.g. 🔥 is grey until a streak ≥ 3, then colour + flicker).
- **Animated, and only these:** 🔥 flicker on streaks ≥ 3; 🎉 once when today hits
  100%; 🏆 once when a goal becomes achieved; ❄️ once when a freeze is spent;
  area emoji move on hover/tap (CSS motion; animated files only for 🔥 ❄️ 🎉 🏆 to keep size down).
- **Reduced motion:** with `prefers-reduced-motion`, all animation stops and
  animated emoji show a static frame.

## 3. Pages (same content, options and actions — new presentation)

- **Shell:** status strip — dot-matrix "WINTER ARC" logo, hardware-style nav with
  key numbers 1–5, dot-matrix live clock, settings button. Remove the boxed frame,
  duplicate page title and page dots.
- **Today:** hero = dot-matrix % + date/day line + segmented bar (one block per
  habit) + spec row (done, best run, freezes, days remaining); "01 / Habits"
  module with numbered rows, square LED checks, lit/unlit 🔥 streak; today's
  tasks module; month LED matrix preview.
- **Habits:** full LED matrix (habit names pinned, dots per day, today blinking,
  frozen = hollow ring, future = dark), daily/weekly/monthly switch as a
  segmented hardware toggle, stats column in mono figures, trend as a thin line.
- **Tasks:** week module with segmented per-day progress; 7 day modules with
  square checks; mindset sliders restyled as segmented 0–10 controls (same
  values); mindset chart as thin lines on a dot grid.
- **Goals:** summary hero in dot-matrix; 10 area modules with Fluent emoji (lit
  when the area has goals); goal rows with segmented milestone/number progress.
- **Insights:** same charts restyled (thin lines, dot grid, mono axis labels).
- **Settings / modals / toasts:** every existing setting and option kept;
  restyled as bordered square controls; modals become bottom sheets on phone.

## 4. iPhone, portrait (first-class)

- Portrait is the target; manifest `orientation: portrait`; landscape must not
  break but gets no special layout.
- `viewport-fit=cover`, safe-area insets, standalone launch from Add to Home
  Screen with black status bar (`apple-mobile-web-app-*` meta).
- Bottom hardware-button nav on phones (≤ 760px); clock hidden on phones.
- No horizontal overflow at 375px except the deliberately scrollable LED matrix,
  which opens scrolled to today with names pinned.
- **Touch:** targets ≥ 44px; **long-press** spends a freeze wherever right-click
  does today (right-click still works on desktop); hover-only behaviour also works
  on tap; inputs ≥ 16px (no iOS zoom); light haptic on check-off where Safari
  supports it (iOS 18+), otherwise visual only.
- Tasks day modules become a horizontal snap carousel opening on today.

## 5. Accessibility

Visible focus rings; keyboard shortcuts unchanged (1–5, N); contrast checked in
both themes (greys on black must meet 4.5:1 for text); reduced motion respected;
icons and LED cells have labels.

## 6. Making it Anirudh's

- Default habit list (`defaultState` in `js/store.js`): Wake up at 5AM, Gym (5×
  weekly), Read 10 pages, Eat healthy, Plan next day, Cold shower, No social
  media. (Meditation and Journaling removed.) Only affects fresh installs.
- README: live link `anirudhparakala.github.io/winter-arc`, credit to
  abhiman-06/winter-arc as the original, Fluent Emoji + font attributions.
- Manifest / `theme-color` / app icons updated to the Instrument look.
- `CACHE` in `sw.js` bumped; new assets added to the offline list.
- `tools/build.js` inlines the new fonts and emoji into the single file.
- Anirudh enables GitHub Pages on the fork (Settings → Pages → main / root).

## 7. Verification

- `npm test` passes; `npm run build` succeeds and the built file runs.
- Screenshots of every page — dark and light, desktop (1440px) and iPhone
  portrait (375px, 430px) — reviewed before pushing.
- Manual check on Anirudh's iPhone once live.
