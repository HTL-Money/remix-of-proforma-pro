-- Audit trail for the admin split override.
--
-- The LO split stopped being purely volume-derived: an admin can now grant a
-- published band (80/85/90) the volume doesn't earn on its own. Once a split
-- can be granted rather than earned, "was this 90 earned or given, and by
-- whom?" has to be answerable without opening each record — /submissions
-- badges overrides from these columns.
--
--   split_source        'derived' (default) or 'override'. Written by the
--                       client on save for display, and confirmed/corrected by
--                       send-recap (service role) at send time — the send is
--                       where enforcement actually happens.
--   split_overridden_by The VERIFIED admin who sent an overridden pro forma.
--                       Only ever written server-side with the service role,
--                       from a JWT verified against /auth/v1/user — never
--                       client-supplied, same rule as HTL5 attribution.
--
-- Existing rows default to 'derived', which is accurate: every pro forma to
-- date used the volume-derived band.
alter table public.proformas
  add column if not exists split_source text not null default 'derived',
  add column if not exists split_overridden_by uuid;

alter table public.proformas
  drop constraint if exists proformas_split_source_check;
alter table public.proformas
  add constraint proformas_split_source_check
  check (split_source in ('derived', 'override'));
