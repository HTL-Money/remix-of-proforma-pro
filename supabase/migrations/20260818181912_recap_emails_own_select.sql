-- Let an LO read their OWN sends, so /submissions can show a "Sent" column.
--
-- recap_emails was admin-only on select, which meant an LO could not tell
-- whether a pro forma they themselves sent had actually gone out. The payload
-- column carries recruit comp figures, so this stays scoped to sent_by rather
-- than opening the table: an LO sees their own sends and nothing else, and
-- admins keep the full view.
--
-- Mirrors the "own links or admin" policy already on referral_links and the
-- "own proformas" policy on proformas.
drop policy if exists "own sends or admin" on public.recap_emails;

-- `to authenticated`, not the default `public`: without it the policy is also
-- evaluated for the anon role, and the repo's RLS invariant test (security.test.ts)
-- rightly fails the build. anon must never reach this table at all.
create policy "own sends or admin"
  on public.recap_emails
  for select to authenticated
  using (sent_by = auth.uid() or is_admin());
