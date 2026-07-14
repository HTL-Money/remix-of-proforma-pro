-- Lock the shared data down to signed-in users and add the target-LO list.
-- Supersedes the permissive anon policies from the earlier migrations now that
-- the app has Supabase Auth.

-- proformas: authenticated-only
drop policy if exists "Public read" on public.proformas;
drop policy if exists "Public insert" on public.proformas;
drop policy if exists "Public update" on public.proformas;
drop policy if exists "Public delete" on public.proformas;

create policy "Authed read" on public.proformas for select to authenticated using (true);
create policy "Authed insert" on public.proformas for insert to authenticated with check (true);
create policy "Authed update" on public.proformas for update to authenticated using (true) with check (true);
create policy "Authed delete" on public.proformas for delete to authenticated using (true);

-- retr_reports: authenticated-only
drop policy if exists "Public read" on public.retr_reports;
drop policy if exists "Public insert" on public.retr_reports;
drop policy if exists "Public update" on public.retr_reports;
drop policy if exists "Public delete" on public.retr_reports;

create policy "Authed read" on public.retr_reports for select to authenticated using (true);
create policy "Authed insert" on public.retr_reports for insert to authenticated with check (true);
create policy "Authed update" on public.retr_reports for update to authenticated using (true) with check (true);
create policy "Authed delete" on public.retr_reports for delete to authenticated using (true);

-- retr-reports storage bucket: authenticated-only, and make the bucket private.
update storage.buckets set public = false where id = 'retr-reports';

drop policy if exists "Public read retr-reports" on storage.objects;
drop policy if exists "Public insert retr-reports" on storage.objects;
drop policy if exists "Public update retr-reports" on storage.objects;

create policy "Authed read retr-reports" on storage.objects
  for select to authenticated using (bucket_id = 'retr-reports');
create policy "Authed insert retr-reports" on storage.objects
  for insert to authenticated with check (bucket_id = 'retr-reports');
create policy "Authed update retr-reports" on storage.objects
  for update to authenticated
  using (bucket_id = 'retr-reports') with check (bucket_id = 'retr-reports');

-- Target loan officers to recruit (e.g. imported from a licensed RETR list).
create table if not exists public.target_los (
  nmls text primary key,
  name text,
  city text,
  state text,
  annual_volume numeric,
  annual_files int,
  source text not null default 'csv',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.target_los enable row level security;

create policy "Authed read" on public.target_los for select to authenticated using (true);
create policy "Authed insert" on public.target_los for insert to authenticated with check (true);
create policy "Authed update" on public.target_los for update to authenticated using (true) with check (true);
create policy "Authed delete" on public.target_los for delete to authenticated using (true);
