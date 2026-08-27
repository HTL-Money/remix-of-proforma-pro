-- Recruit opt-in consent records — the documented "yes, send me my numbers".
--
-- The recap makes income representations, and the owner's rule (after the
-- first week produced a ~27% unsubscribe rate) is that an LO-initiated recap
-- only goes to a recruit who affirmatively asked for it. The invite email
-- carries NO figures; clicking its link records consent here and lands the
-- recruit on the calculator with their own RETR data prefilled — from that
-- point they email it to themselves, so the footer's "you requested this" is
-- literally true.
--
-- The row is the proof: who invited, when, which mailbox consented, and when
-- that consent lapses (12 months, the owner's choice). send-recap refuses an
-- LO-initiated send to any external address without a live consent row.
--
-- Written ONLY by the recruit-optin edge function (service role): the token is
-- minted server-side and consent is recorded by the recruit's own click, never
-- by a client claiming "they said yes on the phone" — the owner explicitly
-- rejected a verbal-consent override.
create table if not exists public.recruit_optins (
  token              text primary key default encode(gen_random_bytes(16), 'hex'),
  nmls               text not null,
  recruit_email      text not null,             -- stored lowercase
  invited_by         uuid not null references auth.users(id),
  invited_at         timestamptz not null default now(),
  consented_at       timestamptz,
  consent_expires_at timestamptz,               -- consented_at + 12 months
  consented_via      text                       -- 'link_click'
);

create index if not exists recruit_optins_email_idx on public.recruit_optins (recruit_email);

alter table public.recruit_optins enable row level security;

-- LOs see the status of their OWN invites (did my recruit opt in yet?); admins
-- see all. No client writes at all — inserts and consent updates are service
-- role only, same posture as email_suppressions.
create policy "own invites or admin"
  on public.recruit_optins
  for select to authenticated
  using (invited_by = auth.uid() or is_admin());
