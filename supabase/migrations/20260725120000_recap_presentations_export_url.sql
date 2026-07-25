-- The recruit receives the Gamma presentation as an EMAIL ATTACHMENT rather than
-- as a link, so the send path needs the PDF's download URL, not just the hosted
-- gamma.app page. Gamma returns both on a completed generation:
--   gammaUrl  -> the hosted deck (already stored in presentation_url)
--   exportUrl -> a direct, unauthenticated PDF download on assets.api.gamma.app
-- Verified live 2026-07-25: that export fetches as application/pdf (%PDF-1.7)
-- with no credentials, which is what makes server-side attaching possible.
--
-- Nullable: rows created before this column existed, and rows still processing,
-- legitimately have no export URL yet. No RLS changes — recap_presentations
-- stays service-role-only (zero client policies), same posture as the rest of
-- the recap tables.
alter table public.recap_presentations
  add column if not exists export_url text;

comment on column public.recap_presentations.export_url is
  'Direct PDF download URL from Gamma (exportUrl). Fetched server-side by send-recap and attached to the recruit email as the Documented ProForma. Null while processing or if the export was unavailable.';
