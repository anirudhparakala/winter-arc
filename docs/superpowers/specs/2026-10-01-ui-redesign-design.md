# Winter Arc — UI/UX redesign ("Icy") — design spec

Date: 2026-10-01 · Owner: Anirudh Parakala (fork of abhiman-06/winter-arc)

## Goal

Make the app look and feel modern, calm and premium — on desktop **and on iPhone** —
and make it Anirudh's own (his fork, his GitHub Pages link). **No new features.**

Success looks like:
- Every page looks clearly better than today's version and scales correctly on
  iPhone widths 375–430px (SE → Pro Max) as well as desktop.
- Everything the app does today still works the same way; saved data and backup
  files stay compatible.
- `npm test` (34 tests) passes; `npm run build` produces a working single file.
- Live at `https://anirudhparakala.github.io/winter-arc/`.

## Non-goals

No new features or data fields: no routines, command bar, smart insights, task
rollover, onboarding or undo toasts. No framework migration — the app stays plain
HTML/CSS/JS with the existing file layout. `js/store.js` logic is not changed.

## Approach

Restyle in place: rewrite `css/style.css` around a new token set, and adjust view
markup (`js/views/*.js`, `index.html`, `js/ui.js`) only where layout or icons need it.

## 1. Visual system

- **Palette (dark, default):** background `#06080d` (navy-black); cards are
  translucent navy with a 1px frosted border and a faint top inner highlight;
  accent icy blue `#7cc4ff` → `#e6f4ff`; text white / cool grey. Habit series
  colours retuned to a cooler set that stays distinguishable and readable on navy.
- **Glow:** "done" states glow (checks, rings, active tab, chart lines). Empty
  states are faint rings. Glow is a token so it can be tuned in one place.
- **Light theme:** the existing light option is restyled to a matching "frost"
  look using the same tokens.
- **Type:** Inter, bundled locally (offline). Sentence case; uppercase only for
  tiny labels. Tabular numerals for all figures.
- **Tokens:** one spacing, radius, type, shadow and motion scale used everywhere.

## 2. Emoji and motion

- **Fluent 3D emoji** (Microsoft, MIT) replace the system emoji font and the
  hand-drawn flame/star/snowflake SVGs: the 10 life-area icons, 🔥 ❄️ ⭐, plus
  🎉 🏆. Bundled locally as small files (static PNG/WebP; animated WebP ≤ ~150 KB
  each, converted from microsoft/fluentui-emoji-animated). Attribution in README.
- **Animated, and only these:** 🔥 flickers on streaks ≥ 3; 🎉 plays once when
  today hits 100%; 🏆 plays once when a goal becomes achieved; ❄️ shimmers once
  when a freeze is spent; area emojis animate on hover/tap.
- **Micro-interactions:** check pop + glow; rings/bars animate their fill; gentle
  page fade/slide; modals scale in (sheets slide up on phone); press "squish".
- **Reduced motion:** with `prefers-reduced-motion`, all animation stops and
  animated emoji show their static frame.

## 3. Pages (same content and actions, better layout)

- **Shell:** remove the boxed frame and the duplicate page title; floating glass
  nav at top on desktop. Remove the page dots.
- **Today:** compact header (date, progress, freeze tokens, day X/365) instead of
  the oversized ring; taller habit rows; per-row icon clutter reduced (freeze
  stays available, visually quieter).
- **Habits:** glowing filled check cells; today's column highlighted; future days
  dimmed; sticky habit-name column; softened trend line when empty.
- **Tasks:** same 7 day cards, lighter (smaller rings, calmer mindset sliders);
  today clearly highlighted; cleaner mindset chart.
- **Goals:** same 10 areas as cards with 3D emoji; empty areas visually quieter;
  better empty state.
- **Insights:** same charts restyled.
- **Settings / modals / toasts:** restyled controls.

## 4. iPhone and small screens (first-class)

- Proper viewport incl. `viewport-fit=cover`; safe-area insets for notch/Dynamic
  Island/home indicator; standalone launch from Add to Home Screen with a navy
  status bar (`apple-mobile-web-app-*` meta, manifest `display: standalone`).
- **Portrait only** is the phone target: layouts are designed and tested for
  portrait; the manifest sets `orientation: portrait` for the installed app.
  Landscape is not designed for (it must not break, but gets no special layout).
- Bottom tab bar on phones (≤ 640px).
- Nothing overflows horizontally at 375px except deliberately scrollable areas.
- **Touch:** all targets ≥ 44px; **long-press** spends a freeze wherever
  right-click does today (right-click still works on desktop); hover-only
  behaviour (chart tooltips, emoji hover) also works on tap; inputs ≥ 16px so iOS
  doesn't zoom; light haptic on check-off where Safari supports it (iOS 18+),
  otherwise visual feedback only.
- **Layouts:** Today single column; Habits grid swipes horizontally with names
  pinned and opens scrolled to today; Tasks day cards become a snap carousel
  opening on today; Goals/Insights single column; modals become bottom sheets.

## 5. Accessibility

Visible focus rings; keyboard shortcuts unchanged (1–5, N); contrast checked in
both themes; reduced motion respected; icons have labels.

## 6. Making it Anirudh's

- README: live link `anirudhparakala.github.io/winter-arc`, credit to
  abhiman-06/winter-arc as the original, Fluent Emoji attribution.
- Manifest / `theme-color` / app icons updated to the icy palette.
- `CACHE` in `sw.js` bumped and new assets added to the offline list.
- `tools/build.js` inlines the new font and emoji assets into the single file.
- Anirudh enables GitHub Pages on the fork (Settings → Pages → main / root).

## 7. Verification

- `npm test` passes; `npm run build` succeeds and the built file runs.
- Screenshots of every page — dark and light, desktop (1440px) and iPhone
  (375px and 430px) — reviewed before pushing.
- Manual check on Anirudh's iPhone once live.
