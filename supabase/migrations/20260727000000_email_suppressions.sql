-- Email suppression list (opt-outs).
--
-- CAN-SPAM requires honoring an opt-out within 10 business days. Before this
-- table, opt-outs landed in a human-monitored inbox (marketing@) and were
-- honored manually — unauditable, and one missed email away from a provable
-- violation. send-recap now checks this table immediately before every send
-- and refuses (cleanly, logged) when the recipient is listed.
--
-- Service-role only: RLS enabled with ZERO client policies, the same posture
-- as retr_stats_cache — enforced by src/test/security.test.ts, which replays
-- every migration and fails if any client policy ever appears here.
--
-- Rows are inserted manually (dashboard/SQL) when an unsubscribe arrives:
--   insert into public.email_suppressions (email, source)
--   values (lower('person@example.com'), 'unsubscribe-email');
-- Addresses are stored lowercase; send-recap lowercases before lookup.

create table if not exists public.email_suppressions (
  email text primary key,
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

alter table public.email_suppressions enable row level security;

comment on table public.email_suppressions is
  'Opt-out list checked by send-recap before every send. Insert lowercased addresses. Service-role only by design — no client policies.';

-- Audit-trail marker: recap_emails rows now record whether the send actually
-- happened or was refused by the suppression check, so the team can see WHY
-- nothing arrived for a given recipient.
alter table public.recap_emails
  add column if not exists status text not null default 'sent';
