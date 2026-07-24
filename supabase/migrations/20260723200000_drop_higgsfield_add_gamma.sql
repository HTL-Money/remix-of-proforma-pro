-- Higgsfield (per-recruit cinematic video) is being retired in favor of a
-- Gamma-generated presentation — the video-in-email problem (no autoplay in
-- any inbox, regardless of vendor) plus Higgsfield's own thin public API docs
-- made it the wrong tool for this. Drop its storage/table; the Edge Function
-- itself (supabase/functions/higgsfield-proxy) is deleted from the repo and
-- undeployed separately.
drop table if exists public.recap_videos;
delete from storage.objects where bucket_id = 'recap-videos';
delete from storage.buckets where id = 'recap-videos';

-- Gamma-generated presentation tracking, mirroring recap_videos' posture:
-- service-role-only RLS, zero client policies. Keyed by the same recap-hash
-- dedupe scheme (src/lib/recapLink.ts hashRecap) so re-sending an identical
-- scenario reuses the existing deck instead of regenerating it.
create table if not exists public.recap_presentations (
  recap_hash text primary key,
  status text not null check (status in ('processing', 'completed', 'failed')),
  gamma_generation_id text,
  presentation_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.recap_presentations enable row level security;
-- No client policies — only the gamma-proxy Edge Function (service role)
-- touches this table; the client reaches it through that function, never
-- directly.

-- HTL5 referral-sourcing attribution: backend-only bookkeeping, NEVER
-- surfaced to the recap recipient (the LO) — RecapPayload/template.ts/
-- RecapView.tsx must never read from this table. Keyed by NMLS (the LO's
-- canonical identifier). "First sender wins" for `expires_at` months, after
-- which a new send CAN re-attribute — and every reassignment is logged in
-- lo_sourcing_events for the alert path, so a real person reviews it rather
-- than it silently overwriting.
create table if not exists public.lo_sourcing (
  nmls text primary key,
  sourced_by uuid not null references auth.users(id),
  sourced_at timestamptz not null default now(),
  expires_at timestamptz not null,
  htl5_bps numeric not null default 5,
  htl5_threshold_bps numeric not null default 150
);
alter table public.lo_sourcing enable row level security;
-- No client policies — service-role (the send-recap Edge Function) only.

create table if not exists public.lo_sourcing_events (
  id uuid primary key default gen_random_uuid(),
  nmls text not null,
  previous_sourced_by uuid references auth.users(id),
  new_sourced_by uuid not null references auth.users(id),
  reason text not null, -- e.g. 'expired_reassignment'
  created_at timestamptz not null default now()
);
alter table public.lo_sourcing_events enable row level security;
-- No client policies — an internal audit/alert trail, service-role only.
