-- Consent-funnel fixes from the 2026-10-16 audit.
--
-- current_bps: the inviting LO already types the recruit's current comp into
-- the Send It Now form, but the invite never carried it, so the consent
-- landing had no "current platform" column and no gain figure — the pitch
-- was missing from the one page the recruit actually asked to see. Stored
-- at invite time and passed to the calculator as ?bps= on the redirect.
--
-- referral_token: consent used to mint a fresh referral_links row on EVERY
-- click of the link, link scanners included (52 links for 10 invites). The
-- token minted on the first confirmed consent is stored here and reused.
alter table public.recruit_optins
  add column if not exists current_bps integer check (current_bps between 0 and 1000),
  add column if not exists referral_token text;

comment on column public.recruit_optins.current_bps is
  'What the recruit is paid today (basis points), typed by the inviting LO; carried into the consent redirect so the comparison has a current column.';
comment on column public.recruit_optins.referral_token is
  'The referral_links token minted on consent; reused on a repeat confirm so one invite never mints two links.';
