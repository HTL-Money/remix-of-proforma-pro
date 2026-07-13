-- Every save keeps a permanent copy, and every emailed recap is logged.

-- Immutable history: one row per Save / Update. The visible saved list stays
-- clean (proformas table), but nothing is ever lost.
create table if not exists public.proforma_snapshots (
  id uuid primary key default gen_random_uuid(),
  proforma_id uuid references public.proformas(id) on delete set null,
  name text not null,
  data jsonb not null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

alter table public.proforma_snapshots enable row level security;

create policy "snapshots_select_authenticated"
  on public.proforma_snapshots for select
  to authenticated
  using (true);

create policy "snapshots_insert_authenticated"
  on public.proforma_snapshots for insert
  to authenticated
  with check (true);

-- No update/delete policies: snapshots are append-only history.

-- Log of recap emails. Rows are inserted by the send-recap Edge Function
-- using the service role, so no insert policy is needed for clients.
create table if not exists public.recap_emails (
  id uuid primary key default gen_random_uuid(),
  proforma_id uuid,
  sent_to text not null,
  sent_by uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table public.recap_emails enable row level security;

create policy "recap_emails_select_authenticated"
  on public.recap_emails for select
  to authenticated
  using (true);
