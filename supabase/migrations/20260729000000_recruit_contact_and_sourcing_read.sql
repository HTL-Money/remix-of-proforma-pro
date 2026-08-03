-- Recruit contact record + team-readable sourcing attribution.
--
-- Why: the owner wants /submissions to work as the recruiting CRM — who the
-- recruit is (name, NMLS, email, production) AND which LO sourced them for
-- the HTL5 90-day rev-share window. The attribution rows already exist
-- (lo_sourcing, written service-role-only by send-recap); what's missing is
-- (a) the recruit's email/file count as queryable columns and (b) any way for
-- a signed-in team member to READ the attribution.

-- ── 1. Recruit contact columns on proformas ────────────────────────────────
-- Nullable on purpose, same convention as 20260728000000_proforma_economics:
-- existing rows predate them, and a writer that misses one must never fail
-- the save. `data` remains the source of truth.

alter table public.proformas
  add column if not exists recruit_email text,
  add column if not exists annual_files  integer;

comment on column public.proformas.recruit_email is
  'Where the recap was sent — the recruit''s own address on public submissions. Null on team-side saves that never emailed anyone.';
comment on column public.proformas.annual_files is
  'Funded file count for the production period (queryable projection of data.annualFiles).';

-- ── 2. Let signed-in team members read sourcing attribution ────────────────
-- lo_sourcing has RLS enabled with ZERO policies (service-role writes only,
-- from send-recap). That stays true for writes. Reads: /submissions is a
-- team-only page behind login, and the whole point of attribution is that
-- the team can see who holds which recruit — so grant SELECT to
-- authenticated. anon still has no access of any kind.

create policy "team members can read sourcing"
  on public.lo_sourcing for select
  to authenticated
  using (true);

-- ── 3. Resolve sourced_by uuids to a human-readable email ──────────────────
-- auth.users is not client-readable (correctly). This view DELIBERATELY
-- exposes exactly two things — user id and email — to signed-in team members
-- so the CRM can say "sourced by aryanj@hometownlend.com" instead of a uuid.
-- No password hashes, no metadata, no phone. security_invoker=false is the
-- point: the view owner (postgres) can read auth.users; the grant below
-- limits who can use it. Revoke anon explicitly.

create or replace view public.lo_sourcing_directory
  with (security_invoker = false)
  as select id, email from auth.users;

revoke all on public.lo_sourcing_directory from anon, public;
grant select on public.lo_sourcing_directory to authenticated;

comment on view public.lo_sourcing_directory is
  'Team-member id→email lookup for attributing lo_sourcing.sourced_by on /submissions. Deliberately narrow: id + email only, authenticated only.';
