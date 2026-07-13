-- Recruiting pipeline: every target LO moves through GHL-style stages on the
-- dashboard. Stage lives on target_los; stage_events is the append-only
-- history that feeds the dashboard activity feed.

alter table public.target_los
  add column if not exists stage text not null default 'target',
  add column if not exists stage_updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'target_los_stage_check' and conrelid = 'public.target_los'::regclass
  ) then
    alter table public.target_los
      add constraint target_los_stage_check
      check (stage in ('target','contacted','proforma_sent','meeting','offer','signed','lost'));
  end if;
end $$;

create table if not exists public.stage_events (
  id uuid primary key default gen_random_uuid(),
  nmls text not null,
  from_stage text,
  to_stage text not null,
  changed_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.stage_events enable row level security;

create policy "Authed read" on public.stage_events
  for select to authenticated using (true);

create policy "Authed insert" on public.stage_events
  for insert to authenticated with check (true);

-- No update/delete policies: stage history is append-only, like snapshots.
