-- Promote the economics HTL needs to monitor out of the `data` jsonb blob and
-- into real columns.
--
-- Why: the team-support holdback is no longer something a recruit picks or even
-- sees — it is derived from their actual payroll overhead so HTL can size an
-- offer. That only helps if it is queryable. Everything here is already inside
-- `data`; these columns just make it filterable/sortable without unpacking JSON
-- on every read.
--
-- All columns are NULLABLE on purpose: existing rows predate them, and a writer
-- that misses one must never fail the save. `data` remains the source of truth.

alter table public.proformas
  add column if not exists nmls                 text,
  add column if not exists annual_volume        numeric,
  add column if not exists lo_split             numeric,
  add column if not exists employee_count       integer,
  add column if not exists payroll_overhead     numeric,
  add column if not exists derived_holdback_pct numeric,
  add column if not exists final_lo_net         numeric;

comment on column public.proformas.payroll_overhead is
  'Broker-paid salaries + bonuses for this LO''s team (the overhead the holdback funds).';
comment on column public.proformas.derived_holdback_pct is
  'Share of LO net required to cover payroll_overhead. Derived, never user-entered. Internal only.';
comment on column public.proformas.final_lo_net is
  'Final LO net comp for the production period — the headline figure the recruit sees.';

-- The internal submissions view is "newest first".
create index if not exists proformas_updated_at_idx
  on public.proformas (updated_at desc);

-- RLS is deliberately UNCHANGED. anon already has insert-with-check(true) and
-- no select, which is exactly what this needs: a public submission can write
-- these columns, and only signed-in team members can ever read them back.
