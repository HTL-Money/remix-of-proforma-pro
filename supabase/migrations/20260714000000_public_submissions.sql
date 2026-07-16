-- Anonymous submission: a visitor with no account can trigger a save + recap
-- email from the public calculator. This adds an anon-insert-only path —
-- no select/update/delete is granted to anon anywhere, matching the
-- "insert-only" shape already used elsewhere (proforma_snapshots,
-- recap_emails). Every other table/policy from prior migrations is
-- untouched: team data still requires `authenticated`.

alter table public.proformas add column if not exists source text not null default 'team';

-- `source = 'public'` is enforced in the check, not left to the client to
-- claim honestly — an anon insert can only ever tag itself as a public
-- submission, never as a team-created row.
create policy "anon_insert_public_submissions" on public.proformas
  for insert to anon with check (source = 'public');
