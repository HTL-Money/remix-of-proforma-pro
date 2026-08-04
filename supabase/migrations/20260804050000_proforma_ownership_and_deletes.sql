-- Pro forma ownership + admin deletes.
--
-- Two gaps this closes, both found in the owner's launch rehearsal:
--
-- 1. LOs could see NOTHING of their own work: the role split made proformas
--    SELECT admin-only, and the table had no owner column to scope anything
--    narrower. An LO's "Send It Now" recorded no identity at all.
-- 2. Nothing test-shaped could ever be removed from the admin UI — recap_emails
--    and referral_links had no DELETE policy for anyone.
--
-- Ownership model: `created_by` fills three ways, in priority order —
--   a) authenticated inserts (LO direct send, team save) via the column default
--   b) anonymous PURL self-serves via the trigger, resolved from the referral
--      link's creator — the sourcing LO owns what their link produced
--   c) anonymous submissions with no token stay NULL → visible to admins only,
--      which is correct: nobody sourced them.

alter table public.proformas
  add column if not exists created_by uuid references auth.users(id) on delete set null default auth.uid();

-- (b): resolve the PURL creator at insert time. SECURITY DEFINER because the
-- anon role can't read referral_links; the function reads exactly one column
-- by primary key and writes only the row being inserted.
create or replace function public.attribute_proforma_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null and new.referral_token is not null then
    select created_by into new.created_by
    from public.referral_links
    where token = new.referral_token;
  end if;
  return new;
end;
$$;

drop trigger if exists attribute_proforma_owner on public.proformas;
create trigger attribute_proforma_owner
  before insert on public.proformas
  for each row execute function public.attribute_proforma_owner();

-- LOs read their own rows. ORs with the existing "admins read proformas"
-- policy, so admins keep seeing everything. NULL created_by matches nobody.
drop policy if exists "own proformas" on public.proformas;
create policy "own proformas" on public.proformas
  for select to authenticated
  using (created_by = auth.uid());

-- Admin deletes for the two tables that had no DELETE policy at all. Writes to
-- recap_emails stay service-role-only; there is deliberately no LO delete
-- anywhere — an audit row or a link with claim history is not an LO's to erase.
drop policy if exists "admins delete recap emails" on public.recap_emails;
create policy "admins delete recap emails" on public.recap_emails
  for delete to authenticated
  using (public.is_admin());

drop policy if exists "admins delete links" on public.referral_links;
create policy "admins delete links" on public.referral_links
  for delete to authenticated
  using (public.is_admin());

-- No backfill: every pre-existing row is rehearsal/test data being cleared as
-- part of this same launch step, so attributing history would attribute noise.
