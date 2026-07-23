-- Server-side cache for live RETR API lookups (retr-proxy Edge Function).
-- One row per (NMLS, date-range window); refreshed when older than the
-- function's TTL. Doubles as the upstream-call budget ledger: the function
-- counts rows fetched in the last 24h to stay under RETR's rate limit.
create table if not exists public.retr_stats_cache (
  nmls_id integer not null,
  date_range integer not null,
  -- Nullable on purpose: a NULL row is a NEGATIVE cache entry — RETR returned
  -- "no LO matches this NMLS." Storing it (rather than skipping the write)
  -- dedupes repeat unknown-NMLS lookups AND makes them count toward the
  -- function's 24h upstream-call budget, so a stream of bogus NMLS ids can't
  -- bypass the rate-limit guard.
  data jsonb,
  fetched_at timestamptz not null default now(),
  primary key (nmls_id, date_range)
);

-- Existing deployments created this column NOT NULL; relax it so negative
-- caching can write NULL rows.
alter table public.retr_stats_cache alter column data drop not null;

alter table public.retr_stats_cache enable row level security;

-- Deliberately NO policies: no client role (anon or authenticated) can touch
-- this table. Only the retr-proxy Edge Function reads/writes it, using the
-- service role, which bypasses RLS. Client access goes through the function.
