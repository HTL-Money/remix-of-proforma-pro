-- Proformas: named snapshots of the LO Pro Forma calculator state.
create table if not exists public.proformas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- No auth model yet: the app is a shared internal tool, so anon gets full access.
-- Tighten these policies when Supabase Auth is added.
alter table public.proformas enable row level security;

create policy "Public read" on public.proformas
  for select to anon, authenticated using (true);

create policy "Public insert" on public.proformas
  for insert to anon, authenticated with check (true);

create policy "Public update" on public.proformas
  for update to anon, authenticated using (true) with check (true);

create policy "Public delete" on public.proformas
  for delete to anon, authenticated using (true);
