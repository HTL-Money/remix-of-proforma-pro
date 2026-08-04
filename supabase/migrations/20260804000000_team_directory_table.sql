-- Replaces lo_sourcing_directory — a security-definer view over auth.users
-- that Supabase's advisor flags as "Exposed Auth Users" — with the pattern
-- the linter recommends: a minimal public TABLE synced from auth.users by a
-- security-definer trigger, protected by real RLS. Same id+email shape the
-- view exposed; same audience (signed-in team members only); auth.users is
-- no longer referenced by anything client-reachable.

create table public.team_directory (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text not null
);

alter table public.team_directory enable row level security;

create policy "team members read the directory"
  on public.team_directory for select
  to authenticated
  using (true);
-- No insert/update/delete policies: writes happen only via the definer
-- trigger below (and deletes via the FK cascade).

create or replace function public.sync_team_directory()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.team_directory (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create trigger sync_team_directory_on_user_change
  after insert or update of email on auth.users
  for each row execute function public.sync_team_directory();

-- Backfill the accounts that already exist, then drop the flagged view.
insert into public.team_directory (id, email)
  select id, email from auth.users where email is not null
  on conflict (id) do nothing;

drop view if exists public.lo_sourcing_directory;
