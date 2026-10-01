# Winter Arc — cloud sync (Supabase) — design spec

Date: 2026-10-01 · Owner: Anirudh Parakala · Builds on the shipped Instrument redesign (main @ 6b2f9af).

## Goal

The same habits, tasks, goals and settings on every device the owner signs in to (iPhone Home
Screen app + laptop), automatically, **without losing the offline-first behaviour**. Success:
tick a habit on the phone → it appears on the laptop within seconds; edit on both while one is
offline → nothing is lost; the app looks and works exactly as before when sync is off.

## Decisions (made with the owner)

- Backend: **Supabase** (owner already has an account). Free tier; one user.
- Sign-in: **email + password** (works in iPhone standalone PWAs; magic links open in Safari, which
  has separate storage, so they are not used). Sign-ups disabled in the dashboard; the owner's user
  is created manually.
- The app keeps **localStorage as the working copy** (instant, offline). Sync is a layer on top.
- No Supabase JS library: plain `fetch` to the Auth (GoTrue) and REST (PostgREST) endpoints, so
  nothing new to vendor/cache and the single-file build keeps working.
- Not in scope: realtime websockets, multiple users/sharing, end-to-end encryption (data is readable
  by the project owner = the user), conflict UI beyond the first-connect choice.

## Data model (Supabase)

`supabase/schema.sql` (committed, run once by the owner in the SQL editor):

```sql
create table public.user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb  not null,
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);
alter table public.user_state enable row level security;
create policy "own select" on public.user_state for select using (auth.uid() = user_id);
create policy "own insert" on public.user_state for insert with check (auth.uid() = user_id);
create policy "own update" on public.user_state for update using (auth.uid() = user_id)
                                                    with check (auth.uid() = user_id);
```

One row per user; `data` = the app state object (same shape as the existing backup JSON) **minus
`settings.theme`** (theme is per-device and never synced). `version` is an optimistic-concurrency
counter. The anon (public) key and project URL live in `js/sync-config.js`
(`window.SYNC_CONFIG = { url: '', anonKey: '' }`, committed; empty ⇒ Sync section shows "not
configured"). The anon key is public by design; row-level security protects the data.

## Files

- `js/merge.js` — pure `Merge.three(base, local, remote)` and `Merge.firstConnect(local, remote)`;
  no DOM, no network, fully unit-tested in node.
- `js/sync.js` — engine: session handling, pull/push loop, scheduling, status, `window.Sync`.
  All network I/O goes through one injectable `fetchImpl` so it is testable with a fake server.
- `js/sync-config.js` — URL + anon key (see above).
- `js/store.js` — small additions only: `Store.snapshot()` (state without theme), `Store.applySynced(s)`
  (validate via `migrate`, keep local theme, persist, emit **without** marking the app dirty),
  `Store.isPristine()` (no logs/tasks/goals/mindset ⇒ fresh install). Existing behaviour unchanged.
- `js/app.js` — Settings "Sync" section, status dot, wiring; Reset warning when signed in.
- `css/style.css` — Sync section + status-dot styles (Instrument look, tokens only).
- `sw.js` — new files in SHELL; **ignore cross-origin requests** (never intercept Supabase calls;
  today the offline fallback would answer a failed API call with index.html).
- `tools/test-merge.js`, `tools/test-sync.js`, `tools/mock-supabase.js` (dev-only local mock of the
  Auth + REST endpoints used for browser end-to-end tests), `supabase/schema.sql`, README section.

## Auth

- Sign in: `POST {url}/auth/v1/token?grant_type=password` with `apikey` header → `access_token`,
  `refresh_token`, `expires_in`, `user.id`. Refresh: `grant_type=refresh_token` (refresh tokens
  rotate — always store the new one). Sign out: `POST /auth/v1/logout`.
- Stored in `localStorage['winterArc.sync']` = `{ email, userId, accessToken, refreshToken,
  expiresAt }`. **The password is never stored.** Refresh when < 60 s from expiry; if refresh fails
  (401/400) ⇒ status "Sign in again", sync stops, local data untouched.
- Friendly errors: wrong credentials, offline, project paused/unreachable, rate-limited.

## Sync algorithm (single-flight; re-run once if more changes arrive mid-run)

Local keys: `winterArc.sync.base` = `{ version, data }` — the last state both sides agreed on.

1. Ensure a valid session. `GET /rest/v1/user_state?select=data,version` (RLS returns only my row).
2. **No row**: `POST` local snapshot (version 1) → base = local.
3. **Row, no base (first connect on this device)**: if `Store.isPristine()` (local has no logs, tasks,
   goals or mindset) ⇒ download (apply remote, base = remote). Else if the cloud copy is pristine by the
   same test ⇒ upload local (base = local). If **both** have data ⇒ ask the owner: **Merge both** (default) / **Use cloud copy** / **Use this device (overwrite
   cloud)**.
4. **Row, base present**: `remote.version == base.version` and local == base.data ⇒ nothing to do;
   same version and local changed ⇒ push; `remote.version > base.version` ⇒ `merged =
   Merge.three(base.data, local, remote.data)`; apply merged locally if it differs; if it differs
   from remote push it.
5. **Push** = `PATCH /rest/v1/user_state?user_id=eq.<me>&version=eq.<n>` body `{data, version:n+1,
   updated_at}` with `Prefer: return=representation`. An empty result array = someone else pushed
   first ⇒ re-pull, re-merge, retry (max 3, then status "will retry"). On success base = what was
   pushed.
6. Triggers: app start, `visibilitychange`→visible, `online`, every 60 s while visible (pull),
   and **3 s after the last local change** (push, debounced). No request if nothing changed.
7. Offline / network failure ⇒ status "pending", local keeps working, retry on the next trigger.
   Never lose the dirty flag across reloads: derive dirtiness by comparing local to `base.data`.

## Merge rules (`Merge.three`, pure, deterministic)

Operates on the state shape (objects; arrays of records with an `id`: `habits`, `goals`,
`goals[].milestones`, `tasks[date]`). For each key/record, with b = base, l = local, r = remote:

- l deep-equals b ⇒ take r (including r's deletion). r deep-equals b ⇒ take l.
- both changed, both plain objects ⇒ recurse per key (e.g. `logs[habitId][date]`, `mindset[date]`).
- both changed, arrays of records ⇒ merge **by `id`**: order = remote's order, then records only the
  local side added; a record deleted by one side and unchanged by the other is deleted; **deleted by
  one side but edited by the other ⇒ the edit wins** (never lose data by accident).
- both changed the same scalar differently ⇒ **local wins** (the device that is syncing).
- `freezeTokens` merges as a delta: `max(0, base + (l − b) + (r − b))`.
- Result is passed through `migrate()` so a bad remote can never corrupt local state.

`Merge.firstConnect(local, remote)` (the "Merge both" choice, no base): union of everything; records
matched by `id`; **default habits created independently on two devices have different ids, so habits
with the same name (case-insensitive) are treated as one** — local logs are remapped onto the
remote habit id; scalar conflicts ⇒ remote wins on first connect (the cloud copy is the older,
established one).

## UI (Instrument look; tokens only; no new colours)

- **Settings → Sync** section above "Your data":
  - not configured: one line explaining + link text to the README setup;
  - signed out: email + password fields, **Sign in** (≥44px, 16px inputs on phone);
  - signed in: email, status line ("Synced 2 min ago" / "Syncing…" / "Waiting — offline" /
    "Sign in again" / error text), **Sync now**, **Sign out**.
- **Status dot** on the settings (gear) button: lit accent = synced, hollow = pending/offline, amber
  = needs attention. Hidden when sync is not configured/signed in. Has an accessible label.
- First-connect dialog (3 buttons) uses the existing modal/bottom-sheet.
- **Reset everything** while signed in warns that it also erases the cloud copy (it syncs).
- **Export/Import backup** unchanged (backup never contains tokens); an Import is just a local
  change that syncs.

## Security & privacy

Row-level security (own row only); sign-ups disabled; anon key public by design; session tokens in
localStorage (same trust level as the data itself); password never stored; the app talks only to the
configured Supabase origin; `esc()` on all displayed server strings (email, error text).

## Testing

- `tools/test-merge.js`: no-op; local-only/remote-only changes; both add different logs; same cell
  both changed; delete vs edit; habit added on both; tasks by id; mindset; goals + milestones;
  freezeTokens delta; theme excluded; idempotence (`three(b, l, l) == l`); associativity-ish
  scenarios; firstConnect dedupe by habit name incl. log remap.
- `tools/test-sync.js`: engine against an in-memory fake Supabase (auth + REST with version CAS):
  no row → upload; first connect download / upload / ask; push; pull+merge+push; CAS conflict retry;
  offline then recovery; dirty flag survives reload; token refresh incl. rotation; refresh failure ⇒
  "sign in again" without touching data; debounce/single-flight; no push when unchanged; 3 retries cap.
- `tools/test-build.js` extended (new files in SHELL and inlined; offline single file still clean).
- Browser end-to-end with Playwright against `tools/mock-supabase.js`: two browser contexts
  (phone-sized + desktop) syncing a tick, an offline edit, a conflict, sign-out, wrong password,
  Reset warning; screenshots of the Sync UI at 390/375/320/1440, dark + light.
- Final Opus whole-branch review. The owner finishes with a real-device checklist (can't be tested
  here): sign in on iPhone Home Screen app + laptop, tick on one → appears on the other, airplane-mode
  edit then reconnect.

## Owner setup (one time, documented in README and `supabase/schema.sql` header)

1. Supabase → New project. 2. SQL editor → run `supabase/schema.sql`. 3. Authentication → Users →
Add user (email + password, auto-confirm). 4. Authentication → Sign In / Providers → disable "Allow
new users to sign up". 5. Project Settings → API → copy **Project URL** and the **anon public** key
into `js/sync-config.js` (never the service-role key). 6. Push; sign in on each device (Settings → Sync).

## Non-goals / known limits

Free-tier projects pause after ~7 days of no use (resume with one click; data kept). Whole-document
sync (no per-record rows) is fine for a single user's data size (< 1 MB). Two devices editing the
exact same cell at the same second resolves "syncing device wins".
