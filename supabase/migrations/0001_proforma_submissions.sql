create table proforma_submissions (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  lo_name      text,
  lo_email     text,
  state_json   jsonb not null,
  results_json jsonb not null
);

-- No policies: only the edge function's service-role key can read/write.
-- Without this, the anon key could read every submission through PostgREST.
alter table proforma_submissions enable row level security;
