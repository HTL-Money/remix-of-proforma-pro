-- Admin/LO role split, shipped the night before 42 loan-officer accounts get
-- announced. Until now every authenticated user could read the whole CRM
-- (targets, submissions, sent emails); with dozens of LO sign-ins that is no
-- longer acceptable. Admins keep everything; LOs keep exactly what their
-- workflow needs: calculator saves (insert), their own referral links, and
-- the lo_sourcing claim-check.

create table public.app_admins (
  email text primary key
);

alter table public.app_admins enable row level security;

-- A signed-in user may check only their own membership; the list itself is
-- not browsable. No client writes — the roster changes via migration only.
create policy "users check their own admin membership"
  on public.app_admins for select
  to authenticated
  using (email = (auth.jwt()->>'email'));

insert into public.app_admins (email) values
  ('jamesm@hometownlend.com'),
  ('aryanj@hometownlend.com'),
  ('carloss@hometownlend.com'),
  ('mojia@hometownlend.com'),
  ('accounting@hometownlend.com');

-- security definer so it can read app_admins regardless of the caller's RLS
-- view of it; stable so a statement evaluates it once, not per row. The email
-- claim comes from the signed Supabase JWT (accounts are created with
-- email_confirm), so it is not client-forgeable.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.app_admins where email = (auth.jwt()->>'email'));
$$;

-- ---- Admin-only tables: the recruiting playbook and everyone's activity ----

-- target_los: the full prospect list with production data.
drop policy "Authed read"   on public.target_los;
drop policy "Authed insert" on public.target_los;
drop policy "Authed update" on public.target_los;
drop policy "Authed delete" on public.target_los;
create policy "admins read targets"   on public.target_los for select to authenticated using (public.is_admin());
create policy "admins insert targets" on public.target_los for insert to authenticated with check (public.is_admin());
create policy "admins update targets" on public.target_los for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete targets" on public.target_los for delete to authenticated using (public.is_admin());

-- recap_emails: every send anyone has made (writes are service-role only).
drop policy "recap_emails_select_authenticated" on public.recap_emails;
create policy "admins read recap emails" on public.recap_emails for select to authenticated using (public.is_admin());

-- proformas: the CRM rows themselves. Inserts stay open (LO "Send It Now"
-- writes as authenticated; the public form writes as anon with source='public')
-- but reading/altering the pool is admin-only.
drop policy "Authed read"   on public.proformas;
drop policy "Authed update" on public.proformas;
drop policy "Authed delete" on public.proformas;
create policy "admins read proformas"   on public.proformas for select to authenticated using (public.is_admin());
create policy "admins update proformas" on public.proformas for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete proformas" on public.proformas for delete to authenticated using (public.is_admin());

-- proforma_snapshots: append-only history; inserts remain open, reads gated.
drop policy "snapshots_select_authenticated" on public.proforma_snapshots;
create policy "admins read snapshots" on public.proforma_snapshots for select to authenticated using (public.is_admin());

-- retr_reports / stage_events: only the admin pages (Targets, Dashboard)
-- touch these from the client; the calculator's RETR lookup goes through the
-- edge function with the service role.
drop policy "Authed read"   on public.retr_reports;
drop policy "Authed insert" on public.retr_reports;
drop policy "Authed update" on public.retr_reports;
drop policy "Authed delete" on public.retr_reports;
create policy "admins read retr"   on public.retr_reports for select to authenticated using (public.is_admin());
create policy "admins insert retr" on public.retr_reports for insert to authenticated with check (public.is_admin());
create policy "admins update retr" on public.retr_reports for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins delete retr" on public.retr_reports for delete to authenticated using (public.is_admin());

drop policy "Authed read"   on public.stage_events;
drop policy "Authed insert" on public.stage_events;
create policy "admins read stage events"   on public.stage_events for select to authenticated using (public.is_admin());
create policy "admins insert stage events" on public.stage_events for insert to authenticated with check (public.is_admin());

-- referral_links: an LO sees and manages their own links; admins see all.
drop policy "team members read all links" on public.referral_links;
create policy "own links or admin"
  on public.referral_links for select
  to authenticated
  using (created_by = auth.uid() or public.is_admin());
