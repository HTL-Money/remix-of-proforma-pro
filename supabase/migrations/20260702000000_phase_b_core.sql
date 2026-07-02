-- Phase B core schema: candidate scenarios, bookings, events, referral attribution,
-- and the recruiter-dashboard allow-list.
--
-- Candidates authenticate via Supabase anonymous sign-in (enable it under
-- Authentication -> Sign In / Providers -> Anonymous). RLS is the security
-- boundary: candidates only ever see their own rows; emails on the
-- dashboard_users allow-list can read everything.
--
-- Safe to re-run: tables use IF NOT EXISTS, policies are dropped before create.

-- ── referrers: LOs who share attribution links (?ref=<code>) ──────────────
create table if not exists public.referrers (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  email      text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint referrers_code_format check (code ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  constraint referrers_email_lowercase check (email = lower(email))
);

-- ── scenarios: one row per candidate device (anon auth uid owns it) ───────
create table if not exists public.scenarios (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,
  recruit_name  text,
  state         jsonb not null,
  snapshot      jsonb not null,
  retr_imported boolean not null default false,
  referrer_code text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists scenarios_user_id_idx       on public.scenarios (user_id);
create index if not exists scenarios_referrer_code_idx on public.scenarios (referrer_code);
create index if not exists scenarios_updated_at_idx    on public.scenarios (updated_at desc);

-- ── bookings: request-a-call submissions ──────────────────────────────────
create table if not exists public.bookings (
  id              uuid primary key default gen_random_uuid(),
  scenario_id     uuid not null references public.scenarios(id) on delete cascade,
  user_id         uuid not null,
  name            text not null,
  email           text not null,
  phone           text,
  preferred_times text,
  notes           text,
  status          text not null default 'requested'
                  check (status in ('requested','confirmed','completed','canceled')),
  created_at      timestamptz not null default now()
);
create index if not exists bookings_scenario_id_idx on public.bookings (scenario_id);
create index if not exists bookings_status_idx      on public.bookings (status);

-- ── events: lightweight engagement log ────────────────────────────────────
-- scenario_id is intentionally NOT a foreign key: events (e.g. 'opened') can
-- fire before the scenario row is first synced.
create table if not exists public.events (
  id          bigint generated always as identity primary key,
  scenario_id uuid,
  user_id     uuid not null,
  type        text not null,
  payload     jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_scenario_id_idx on public.events (scenario_id);
create index if not exists events_type_idx        on public.events (type);

-- ── dashboard_users: allow-list for recruiter access ──────────────────────
create table if not exists public.dashboard_users (
  email      text primary key,
  invited_by text,
  created_at timestamptz not null default now(),
  constraint dashboard_users_email_lowercase check (email = lower(email))
);

-- ── helper: does the current JWT belong to an allow-listed dashboard user? ─
-- SECURITY DEFINER so the lookup is not itself blocked by RLS on
-- dashboard_users. Anonymous sessions have no email claim -> false.
create or replace function public.is_dashboard_user()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.dashboard_users
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ── updated_at maintenance ────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists scenarios_set_updated_at on public.scenarios;
create trigger scenarios_set_updated_at
  before update on public.scenarios
  for each row execute function public.set_updated_at();

-- ── row-level security ────────────────────────────────────────────────────
alter table public.referrers       enable row level security;
alter table public.scenarios       enable row level security;
alter table public.bookings        enable row level security;
alter table public.events          enable row level security;
alter table public.dashboard_users enable row level security;

-- referrers: any signed-in user (incl. anonymous) may read ACTIVE referrers,
-- which is how the app validates ?ref= codes. Only dashboard users manage them.
drop policy if exists referrers_read_active       on public.referrers;
drop policy if exists referrers_dashboard_insert  on public.referrers;
drop policy if exists referrers_dashboard_update  on public.referrers;
create policy referrers_read_active on public.referrers
  for select to authenticated using (active);
create policy referrers_dashboard_insert on public.referrers
  for insert to authenticated with check (public.is_dashboard_user());
create policy referrers_dashboard_update on public.referrers
  for update to authenticated
  using (public.is_dashboard_user()) with check (public.is_dashboard_user());

-- scenarios: candidates own their rows; dashboard users read all.
drop policy if exists scenarios_own_all        on public.scenarios;
drop policy if exists scenarios_dashboard_read on public.scenarios;
create policy scenarios_own_all on public.scenarios
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy scenarios_dashboard_read on public.scenarios
  for select to authenticated using (public.is_dashboard_user());

-- bookings: candidates insert/read their own; dashboard users read + update all.
drop policy if exists bookings_own_insert       on public.bookings;
drop policy if exists bookings_own_read         on public.bookings;
drop policy if exists bookings_dashboard_read   on public.bookings;
drop policy if exists bookings_dashboard_update on public.bookings;
create policy bookings_own_insert on public.bookings
  for insert to authenticated with check (user_id = auth.uid());
create policy bookings_own_read on public.bookings
  for select to authenticated using (user_id = auth.uid());
create policy bookings_dashboard_read on public.bookings
  for select to authenticated using (public.is_dashboard_user());
create policy bookings_dashboard_update on public.bookings
  for update to authenticated
  using (public.is_dashboard_user()) with check (public.is_dashboard_user());

-- events: candidates insert their own; dashboard users read all.
drop policy if exists events_own_insert     on public.events;
drop policy if exists events_dashboard_read on public.events;
create policy events_own_insert on public.events
  for insert to authenticated with check (user_id = auth.uid());
create policy events_dashboard_read on public.events
  for select to authenticated using (public.is_dashboard_user());

-- dashboard_users: only dashboard users may see or extend the allow-list
-- (the seed below runs as postgres and bypasses RLS).
drop policy if exists dashboard_users_read   on public.dashboard_users;
drop policy if exists dashboard_users_insert on public.dashboard_users;
create policy dashboard_users_read on public.dashboard_users
  for select to authenticated using (public.is_dashboard_user());
create policy dashboard_users_insert on public.dashboard_users
  for insert to authenticated with check (public.is_dashboard_user());

-- ── seeds ─────────────────────────────────────────────────────────────────
insert into public.dashboard_users (email) values ('jamesm@hometownlend.com')
  on conflict (email) do nothing;
insert into public.referrers (code, name, email)
  values ('test', 'Test Referrer', 'jamesm@hometownlend.com')
  on conflict (code) do nothing;
