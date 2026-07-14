-- RETR reports keyed by NMLS: parsed production data plus the original PDF
-- (stored in the retr-reports bucket) so entering an NMLS can auto-fill the
-- pro forma and offer the source report as a download.
create table if not exists public.retr_reports (
  nmls text primary key,
  lo_name text,
  parsed jsonb not null,
  pdf_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Same trust model as proformas: shared internal tool, no auth yet.
alter table public.retr_reports enable row level security;

create policy "Public read" on public.retr_reports
  for select to anon, authenticated using (true);

create policy "Public insert" on public.retr_reports
  for insert to anon, authenticated with check (true);

create policy "Public update" on public.retr_reports
  for update to anon, authenticated using (true) with check (true);

create policy "Public delete" on public.retr_reports
  for delete to anon, authenticated using (true);

-- Public bucket for the original RETR PDFs.
insert into storage.buckets (id, name, public)
values ('retr-reports', 'retr-reports', true)
on conflict (id) do nothing;

create policy "Public read retr-reports" on storage.objects
  for select to anon, authenticated using (bucket_id = 'retr-reports');

create policy "Public insert retr-reports" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'retr-reports');

create policy "Public update retr-reports" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'retr-reports') with check (bucket_id = 'retr-reports');
