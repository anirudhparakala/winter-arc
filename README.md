# Winter Arc

**🔗 Live app: [anirudhparakala.github.io/winter-arc](https://anirudhparakala.github.io/winter-arc/)**

A black, offline-first tracker for a **90-day arc**: daily habits on a month grid,
a weekly task board with a mindset tracker, goals across ten areas of life,
and an insights page that shows whether you're actually holding the line.

No accounts, no sign-up, no server to run. Everything lives in your own browser —
and, if you want the same data on your phone and laptop, you can optionally
[sync it to your own free Supabase project](#cloud-sync).

**The look ("Instrument"):** pure black with a single icy-blue accent, dot-matrix
numerals for the big figures, a LED-style habit matrix, and Microsoft's Fluent 3D
emoji (animated for the fire, snowflake and party). Fonts and emoji ship inside the
repo, so it looks the same offline.

---

## If someone sent you this link

Just open **[anirudhparakala.github.io/winter-arc](https://anirudhparakala.github.io/winter-arc/)**
— that's it, the app is right there. A few things worth knowing:

- **Your data is separate from theirs.** Nothing is shared between people who open
  this link — what you tick is stored only in your own browser, on your own device
  (unless you set up [Cloud sync](#cloud-sync) with your own project).
- **Install it as a real app** (recommended): open the link in Chrome or Edge, then
  click the **install icon** in the address bar (or ⋯ menu → *Apps* → *Install this
  site as an app*). You get your own window, your own icon, and it works offline.
- Works on your phone too — open the link there and use *Add to Home Screen*.
- **Back up your progress** from time to time: gear icon (top right) → **Export
  backup**. See [Your data](#your-data) below for why that matters.

Everything past this point is for whoever is running or changing the project.

---

## Four ways to run it

### 1. Just open the live link
**[anirudhparakala.github.io/winter-arc](https://anirudhparakala.github.io/winter-arc/)** —
nothing to install, works on any device with a browser. This is what to send people.

### 2. As a website on your own PC
Double-click **`start.cmd`** — it starts a local server and opens
<http://localhost:4173>. (Or `npm start` if you prefer a terminal.)

### 3. As an installed app
From the live link or from `localhost:4173`, click the **install icon** in Chrome
or Edge's address bar (or ⋯ → *Apps* → *Install this site as an app*). It gets its
own window, its own icon, and works offline.

### 4. As one file you can send directly — no link, no internet needed
```
npm run build
```
This writes **`dist/winter-arc.html`** — a single ~2 MB file with all the CSS,
JavaScript, fonts, emoji and icons inlined. Send it over WhatsApp, email, a USB stick, anything.
Whoever gets it double-clicks the file and the app runs — no install, no internet,
no Node, no GitHub. Useful if your friend has spotty internet or you'd rather not
rely on a link staying up.

> ⚠️ **Each of these four is separate storage.** The live link, `localhost:4173`,
> and a `dist/winter-arc.html` file each keep their own data — ticking a habit in
> one won't show up in another. Pick one and stick with it; use **Export/Import
> backup** (below) to move progress between them.

> Whoever opens any of these starts with an empty tracker — a copy never carries
> *your* data with it.

---

## The five pages

| Page | What it's for |
|---|---|
| **Today** | The daily check-in: today's completion as a big dot-matrix percentage, every habit, today's tasks, freeze tokens. |
| **Habits** | The month matrix — one row per habit, one cell per day. The heart of the app. |
| **Tasks** | A week at a time: tasks per day, plus Energy / Focus / Motivation tracking. |
| **Goals** | Your arc goals, grouped by area of life, with milestones and days left. |
| **Insights** | Consistency over time, habit leaderboard, streaks, and a month-by-month bar. |

Press **1–5** to jump between pages. Press **N** on Habits or Goals to add one.

---

## How tracking works

**Habits** come in three cadences:
- *Daily* — do it every day.
- *Weekly* — a target like "Gym 5× per week". It counts as met once you hit 5.
- *Monthly* — same idea over a calendar month.

On the Habits matrix, **click (or tap) a cell** to mark the day, **right-click** it
(or **press and hold** it on a phone) to spend a freeze token, and **click a habit's
name** to edit or delete it. The same hold or right-click works on Today's habit rows.

**Freeze tokens** protect a streak on a day you genuinely couldn't show up. The
streak survives, but the day isn't counted as completed in your percentages — so
your consistency number stays honest. You start with 9; change the count with the
**Freezes** button on Today.

**Streaks** count consecutive days (or weeks/months for periodic habits). Not having
ticked *today* yet never breaks a streak — only a missed past day does.

**Goals** are measured either by **milestones** (a checklist) or by **a number**
("read 24 books"). Checking off the last milestone, or reaching the number, marks
the goal achieved on its own. Pin a goal to put it in **Top priorities**.

**The arc** is your window of days: 90 by default. Set its start date and length (in days) in Settings; every
"days left" figure and the month-by-month chart follow from it.

---

## Your data

The app is **local first**: everything is stored in your own browser (`localStorage`)
under the key `winterArc.v1`, and it works fully offline. By default nothing is ever
sent anywhere. Only if you set up [Cloud sync](#cloud-sync) and sign in does the app
also copy your data to **your own Supabase project** (nobody else's server).

Without sync, your data is tied to **that browser on that machine**. To move it, or to
keep a safety copy:

- **Settings (⚙, top right) → Export backup** — downloads a `.json` file.
- **Settings → Import backup** — loads one back, on any device.

Worth exporting now and then — even with sync on. Clearing your browser's site data will
wipe the local copy, and a backup file is the one thing that no sync mistake can touch.

If a saved copy ever can't be read, the app starts fresh but first keeps the unreadable
text under the key `winterArc.v1.corrupt` in the browser's storage, so it can be recovered.

---

## Cloud sync

Optional. It keeps the same habits, tasks, goals and settings on every device you sign in
to (say an iPhone Home Screen app and a laptop). Tick a habit on one and it shows up on
the other within seconds; edit on both while one is offline and nothing is lost — the two
sets of changes are merged. The app still works offline and still keeps its working copy
in `localStorage`; sync is a layer on top. There is **no Supabase library** — the app talks
to Supabase with plain `fetch`. The theme (dark/light) is per device and never synced.

### One-time setup (about 5 minutes, free)

1. Supabase dashboard → **New project**.
2. **SQL editor** → paste and run [`supabase/schema.sql`](supabase/schema.sql). It creates
   one table (`user_state`, one row per user) with row-level security, so each signed-in
   user can read and write only their own row.
3. **Authentication → Users → Add user** — your email and a password, auto-confirm.
4. **Authentication → Sign In / Providers** — turn **off** "Allow new users to sign up",
   so nobody else can create an account in your project.
5. **Project Settings → API** — copy the **Project URL** and the **anon public** key into
   [`js/sync-config.js`](js/sync-config.js). Both are public by design (row-level security
   is what protects the data). **Never use the `service_role` key** — it bypasses all
   security and must never go into a web page.
6. Push the site (see *Updating the live site*), then on **each device**: open the app →
   **Settings → Cloud sync** → sign in with that email and password. Sign-in is per device;
   the password is never stored, only a session token that refreshes itself.

### Using it

- The little dot on the **gear** shows the state once you are signed in: lit = synced,
  hollow = waiting to sync (offline or retrying), amber = needs attention.
- **Settings → Cloud sync → Sync now** syncs immediately; **Sign out** signs this device
  out (its local data stays). Sync also runs on app start, when you come back to the tab or
  go back online, every minute while the app is visible, and a few seconds after you edit.
- The first time a device connects, if **both** it and the cloud already hold data, you are
  asked once: **Merge both** (recommended), **Use the cloud copy**, or **Use this device**.
- **Reset everything** while signed in also erases your cloud copy, and your other devices
  will be erased on their next sync. Signed out, it only affects this device.
- Importing a backup is just another edit — it syncs like any other change.

### Good to know

- Free Supabase projects **pause after about 7 days of no use**. Open the Supabase
  dashboard and press resume — your data is kept. Until then the app shows it can't reach
  Supabase and keeps working locally; changes sync once the project is back.
- Two devices changing the exact same thing at the same second resolve to "the device that
  is syncing wins". A record deleted on one device but edited on another is kept.
- The data in your Supabase project is readable by you (the project owner) — there is no
  end-to-end encryption.
- A single-file build (`dist/winter-arc.html`) contains whatever is in `js/sync-config.js`
  at build time. The committed one is built with sync switched off.

---

## Project layout

```
index.html              app shell and page chrome
css/style.css           design tokens + every component
js/store.js             state, persistence, date maths, streaks and rates
js/merge.js             pure three-way merge used by sync
js/sync.js              Supabase sync engine (plain fetch, no library)
js/sync-config.js       your Supabase URL + anon key (empty = sync off)
supabase/schema.sql     the one table + row-level security, run once in Supabase
js/charts.js            SVG charts (segmented bars, sparkline, area, multi-line)
js/ui.js                icons, emoji, modal, toast
js/views/*.js           one file per page
assets/fonts/           vendored fonts (Doto, Space Grotesk, Space Mono)
assets/emoji/           vendored Fluent emoji (static + animated)
assets/LICENSES.md      licences for the vendored fonts and emoji
sw.js                   service worker — offline + installable
manifest.webmanifest    PWA metadata
icons/                  PNG app icons
tools/build.js          bundles everything into dist/winter-arc.html
tools/make-icons.js     regenerates the PNG app icons
tools/fetch-assets.js   downloads the fonts + emoji into assets/ (npm run assets)
tools/test-*.js         tests: tracking maths, assets, UI helpers, build output,
                        merge (test-merge.js) and the sync engine (test-sync.js)
docs/superpowers/       design spec and implementation plans for the redesign
```

Run the tests with `npm test`. To re-download the fonts and emoji into `assets/`
(only needed if they go missing), run `npm run assets`.

### Changing things

The whole look is driven by CSS custom properties at the top of `css/style.css` —
change `--accent` (the icy `#8ecbff`) and the entire app re-themes. There's a light
theme in Settings too.

The mindset tracker's three series use `--m-energy`, `--m-focus` and `--m-motivation`
(re-tuned for the light theme), and each habit's colour comes from the `COLORS` palette
in `js/store.js`. They were chosen to stay distinguishable on the black surface and under
colour-blindness; if you swap them, keep that in mind.

After editing any file, re-run `npm run build` to refresh the single-file copy, and
bump `CACHE` in `sw.js` so installed copies pick up the change. If you add a new
font or emoji file, add it to `SHELL` in `sw.js` too — `npm test` checks this.

### Updating the live site

The live link is served straight from this repo's `main` branch
([anirudhparakala/winter-arc](https://github.com/anirudhparakala/winter-arc)) via
GitHub Pages. One-time setup: repo **Settings → Pages → Source: "Deploy from a
branch"**, then pick **main** / **(root)**. To push a change live:

```
git add -A
git commit -m "describe the change"
git push origin main
```

GitHub rebuilds the page automatically — usually live within a minute. People who
already installed it as an app get the update next time they open it (the service
worker refreshes its cache in the background).

---

## Credits

Based on abhiman-06/winter-arc.

## Attributions

Microsoft's [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) (MIT, © Microsoft
Corporation) and the Doto, Space Grotesk and Space Mono fonts (SIL Open Font License 1.1)
are bundled in `assets/`. Full details are in [`assets/LICENSES.md`](assets/LICENSES.md).
