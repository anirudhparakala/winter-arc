-- Winter Arc — cloud sync schema (Supabase).
--
-- Owner setup (one time):
--   1. Supabase dashboard -> New project.
--   2. SQL editor -> paste and run this whole file.
--   3. Authentication -> Users -> Add user (your email + a password, auto-confirm).
--   4. Authentication -> Sign In / Providers -> turn OFF "Allow new users to sign up".
--   5. Project Settings -> API Keys -> copy the Project URL and the public key (the publishable
--      key sb_publishable_... or the legacy anon key; both are public by design) into
--      js/sync-config.js. NEVER the secret / service_role key.
--   6. Bump CACHE in sw.js, push the site, then sign in on each device (Settings -> Cloud sync).

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
