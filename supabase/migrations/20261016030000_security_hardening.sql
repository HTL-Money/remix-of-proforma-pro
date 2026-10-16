-- Security hardening from the 2026-10-16 audit. Every statement here is
-- idempotent so the file can be replayed on a fresh project.
--
-- 1. SECURITY DEFINER functions were executable by anon and authenticated via
--    /rest/v1/rpc/ (Supabase's default EXECUTE grant). The three trigger /
--    event-trigger functions need no client role at all; is_admin() keeps
--    authenticated because RLS policies evaluate it as the querying role and
--    src/lib/auth.tsx calls it directly once a session exists.
-- 2. The retr-reports storage bucket was still writable by every signed-in
--    user, while the retr_reports TABLE went admin-only in the role split. An
--    LO could upload <nmls>.pdf and the shared store would serve it to the
--    team as "verified" production.
-- 3. Two INSERT policies were `with check (true)`: an LO could insert a
--    proformas row with created_by set to someone else (planting it in that
--    LO's /submissions) or a proforma_snapshots row against any pro forma.
-- 4. Advisor findings: six policies re-evaluated auth.uid()/auth.jwt() per
--    row (initplan), two tables had redundant permissive SELECT policies,
--    seven foreign keys had no covering index, and pg_net lived in public.

-- ---- 1. Function grants ---------------------------------------------------

revoke execute on function public.attribute_proforma_owner() from public, anon, authenticated;
revoke execute on function public.sync_team_directory()      from public, anon, authenticated;
-- rls_auto_enable() is created by the Supabase platform (event trigger
-- "ensure_rls"); it is not defined in this repo, only de-exposed here.
revoke execute on function public.rls_auto_enable()          from public, anon, authenticated;
revoke execute on function public.is_admin()                 from public, anon;

-- ---- 2. Storage: retr-reports writes are admin-only -----------------------

drop policy if exists "Authed insert retr-reports" on storage.objects;
drop policy if exists "Authed update retr-reports" on storage.objects;
drop policy if exists "admins insert retr-reports" on storage.objects;
drop policy if exists "admins update retr-reports" on storage.objects;
create policy "admins insert retr-reports" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'retr-reports' and (select public.is_admin()));
create policy "admins update retr-reports" on storage.objects
  for update to authenticated
  using (bucket_id = 'retr-reports' and (select public.is_admin()))
  with check (bucket_id = 'retr-reports' and (select public.is_admin()));
-- "Authed read retr-reports" (select, bucket only) stays: LOs may read.

-- ---- 3. INSERT ownership --------------------------------------------------

-- proformas.created_by defaults to auth.uid(); the BEFORE INSERT trigger only
-- fills it when it is null AND a referral token is present (anonymous PURL
-- self-serves). WITH CHECK runs after the trigger, so a signed-in client that
-- names another user is refused, while the default path is unchanged.
drop policy if exists "Authed insert" on public.proformas;
create policy "Authed insert" on public.proformas
  for insert to authenticated
  with check (created_by = (select auth.uid()) or (select public.is_admin()));

-- A snapshot may only be attached to a pro forma the inserter owns (or by an
-- admin). The existence check names the ownership rule explicitly rather than
-- leaning on proformas' own SELECT policy.
drop policy if exists "snapshots_insert_authenticated" on public.proforma_snapshots;
create policy "snapshots_insert_authenticated" on public.proforma_snapshots
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.proformas p
      where p.id = proforma_id
        and (p.created_by = (select auth.uid()) or (select public.is_admin()))
    )
  );

-- ---- 4a. initplan: evaluate auth.*() once per statement -------------------

drop policy if exists "users check their own admin membership" on public.app_admins;
create policy "users check their own admin membership" on public.app_admins
  for select to authenticated
  using (email = ((select auth.jwt())->>'email'));

drop policy if exists "team members create their own links" on public.referral_links;
create policy "team members create their own links" on public.referral_links
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists "own links or admin" on public.referral_links;
create policy "own links or admin" on public.referral_links
  for select to authenticated
  using (created_by = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "own invites or admin" on public.recruit_optins;
create policy "own invites or admin" on public.recruit_optins
  for select to authenticated
  using (invited_by = (select auth.uid()) or (select public.is_admin()));

-- ---- 4b. one permissive SELECT policy per table ---------------------------

-- proformas: "own proformas" + "admins read proformas" collapse into one.
drop policy if exists "admins read proformas" on public.proformas;
drop policy if exists "own proformas" on public.proformas;
drop policy if exists "own proformas or admin" on public.proformas;
create policy "own proformas or admin" on public.proformas
  for select to authenticated
  using (created_by = (select auth.uid()) or (select public.is_admin()));

-- recap_emails: "own sends or admin" already ORs is_admin(); the admin-only
-- twin was redundant.
drop policy if exists "admins read recap emails" on public.recap_emails;
drop policy if exists "own sends or admin" on public.recap_emails;
create policy "own sends or admin" on public.recap_emails
  for select to authenticated
  using (sent_by = (select auth.uid()) or (select public.is_admin()));

-- ---- 4c. covering indexes for the seven unindexed foreign keys -----------

create index if not exists lo_sourcing_sourced_by_idx              on public.lo_sourcing (sourced_by);
create index if not exists lo_sourcing_events_new_sourced_by_idx   on public.lo_sourcing_events (new_sourced_by);
create index if not exists lo_sourcing_events_prev_sourced_by_idx  on public.lo_sourcing_events (previous_sourced_by);
create index if not exists proforma_snapshots_proforma_id_idx      on public.proforma_snapshots (proforma_id);
create index if not exists proformas_created_by_idx                on public.proformas (created_by);
create index if not exists recruit_optins_invited_by_idx           on public.recruit_optins (invited_by);
create index if not exists referral_links_created_by_idx           on public.referral_links (created_by);

-- ---- 4d. pg_net out of public ---------------------------------------------
-- pg_net is not relocatable (extrelocatable = false), so it has to be dropped
-- and recreated. Its functions live in schema `net` either way, so the
-- pg_cron commands that call net.http_post() keep working. Run only when
-- net.http_request_queue is empty (between the 13:00 UTC job firings).
drop extension if exists pg_net;
create extension if not exists pg_net with schema extensions;
