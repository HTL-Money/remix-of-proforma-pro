-- Recruit PURLs: an LO mints a personalized link for a specific recruit
-- (email required, name optional). Creating the link records the recruit —
-- the week-after-week CRM intake — and when the recruit opens the link and
-- emails themselves a recap, send-recap resolves the token to created_by and
-- fires the SAME 90-day lo_sourcing claim a signed-in send would (owner
-- decision: link use = claim, first-sender-wins rules unchanged).
--
-- The token is a bearer credential by design: sharing the link IS the
-- attribution. 8 random bytes hex-encoded (16 chars) — unguessable, short
-- enough to read over the phone.

create table if not exists public.referral_links (
  token         text primary key default encode(gen_random_bytes(8), 'hex'),
  created_by    uuid not null default auth.uid() references auth.users(id),
  recruit_email text not null,
  recruit_name  text,
  created_at    timestamptz not null default now(),
  -- Bumped (best-effort) by send-recap on each token-attributed send.
  use_count     integer not null default 0,
  last_used_at  timestamptz
);

alter table public.referral_links enable row level security;

-- The row IS an attribution claim, so the insert check is row-scoped
-- (stricter than the house to-authenticated/true pattern on purpose):
-- an LO can only mint links credited to themselves.
create policy "team members create their own links"
  on public.referral_links for insert
  to authenticated
  with check (created_by = auth.uid());

-- Team transparency, same ethos as /submissions: any signed-in team member
-- can see every link (and therefore who is working which recruit).
create policy "team members read all links"
  on public.referral_links for select
  to authenticated
  using (true);

-- No UPDATE/DELETE policies: use_count/last_used_at are service-role writes
-- from send-recap; anon has no access of any kind.

-- Which link brought a self-serve submission in (nullable, same convention
-- as the other promoted columns — a missing token never fails the save).
alter table public.proformas
  add column if not exists referral_token text;

comment on column public.proformas.referral_token is
  'referral_links.token this self-serve submission arrived through. Null for team saves and un-referred visits.';
