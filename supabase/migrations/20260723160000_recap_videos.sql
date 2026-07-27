-- Part K: per-recruit cinematic video via Higgsfield, generated asynchronously
-- after a recap is sent. Keyed by a deterministic, non-cryptographic hash of
-- the recap's numbers (src/lib/recapLink.ts hashRecap) so identical scenarios
-- reuse the same clip instead of regenerating (dedupe + cost control).
create table if not exists public.recap_videos (
  recap_hash text primary key,
  status text not null check (status in ('processing', 'completed', 'failed')),
  higgsfield_request_id text,
  video_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recap_videos enable row level security;
-- No client policies at all — same posture as retr_stats_cache. Only the
-- higgsfield-proxy Edge Function (service role) ever reads/writes this table;
-- the hosted recap page reaches it THROUGH that function, never directly, so
-- the anon-visible surface here is zero.

-- Public bucket for the source comparison image + the finished clip. "Public"
-- means "servable via an unguessable hash-named path" — matching the existing
-- posture on the vault GIF/docx artifacts: never a secret, and deliberately
-- NOT signed-URL-gated (a signed URL expires and would break a forwarded
-- email or a bookmarked recap link).
insert into storage.buckets (id, name, public)
values ('recap-videos', 'recap-videos', true)
on conflict (id) do nothing;
