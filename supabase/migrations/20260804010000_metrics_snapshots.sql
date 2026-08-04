-- Weekly review history: one row per Monday run, the entire computed metrics
-- bundle as jsonb so trend lines ("claims up 3 weeks straight") never need a
-- schema change. Written only by the weekly-review edge function (service
-- role); readable by signed-in team members.

create table public.metrics_snapshots (
  id         uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  metrics    jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.metrics_snapshots enable row level security;

create policy "team members read snapshots"
  on public.metrics_snapshots for select
  to authenticated
  using (true);
-- No client write policies — service-role only.
