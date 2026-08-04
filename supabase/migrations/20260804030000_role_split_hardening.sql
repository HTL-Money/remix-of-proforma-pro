-- Follow-ups from the adversarial review of 20260804020000_app_admins.sql,
-- all confirmed against the live database before this was written.

-- 1. metrics_snapshots was the side window into everything the role split just
--    closed: its `metrics` jsonb embeds the LO leaderboard (emails) and the
--    stale-link list (recruit emails + NMLS), and its only policy was
--    SELECT USING (true) for authenticated. The weekly-review function writes
--    with the service role, which bypasses RLS, so nothing breaks.
drop policy "team members read snapshots" on public.metrics_snapshots;
create policy "admins read snapshots"
  on public.metrics_snapshots for select
  to authenticated
  using (public.is_admin());

-- 2. Making retr_reports SELECT admin-only broke a real LO path: the shared
--    report store is lookupRetrReport()'s fallback when the live RETR API has
--    no data for an NMLS (src/lib/retrReportStore.ts), so "Send It Now" and
--    the signed-in calculator silently lost their safety net. Reads go back to
--    every team member; writes (upload/overwrite a report) stay admin-only.
drop policy "admins read retr" on public.retr_reports;
create policy "team members read retr"
  on public.retr_reports for select
  to authenticated
  using (true);

-- 3. app_admins inherited the schema's blanket write grants for anon and
--    authenticated. RLS denies those writes today (there is no INSERT/UPDATE/
--    DELETE policy), so this is not currently exploitable — but it leaves the
--    admin roster one accidental permissive policy away from self-service
--    privilege escalation. Remove the grants so the table is read-only at the
--    privilege layer too, not just the policy layer.
revoke insert, update, delete, truncate, references
  on public.app_admins from anon, authenticated;
