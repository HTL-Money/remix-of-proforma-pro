# Row-Level Security Audit

Table-by-table statement of who can do what, derived from replaying
`supabase/migrations/*.sql` in order (later migrations drop/supersede earlier
policies — read the *net* state below, which `src/test/security.test.ts`
recomputes on every test run and enforces). Rebuilt 2026-10-16 against the
live project; the previous version of this file stopped at migration
`20260714000000` and described access the role split had long since removed.

## Roles

- **anon** — anyone with the public anon key (it ships in the browser bundle).
- **authenticated** — a signed-in account. Two kinds, decided by
  `public.is_admin()` (SECURITY DEFINER, reads `app_admins` by the JWT's
  email): **admins** see the whole CRM; **loan officers** see only rows they
  created. "own" below means `created_by` / `sent_by` / `invited_by` equals
  `auth.uid()`.
- **service role** — the edge functions. Bypasses RLS; every write to the
  audit, sourcing, consent and suppression tables happens here.

## Net policy state (after all migrations, 2026-10-16)

| Table | anon | authenticated | notes |
|---|---|---|---|
| `proformas` | **INSERT only**, and only with `source = 'public'` | INSERT (`created_by` = self, or admin); SELECT own-or-admin; UPDATE / DELETE admin | `created_by` defaults to `auth.uid()`; the `attribute_proforma_owner` trigger fills it from the referral link for anonymous PURL sends |
| `proforma_snapshots` | — | INSERT only against a pro forma the inserter owns (or admin); SELECT admin | append-only: no update/delete for anyone |
| `retr_reports` | — | SELECT all; INSERT / UPDATE / DELETE admin | |
| `target_los` | — | SELECT / INSERT / UPDATE / DELETE admin | the recruiting playbook |
| `stage_events` | — | SELECT / INSERT admin | append-only |
| `recap_emails` | — | SELECT own-or-admin; DELETE admin | rows written by `send-recap` |
| `referral_links` | — | INSERT own; SELECT own-or-admin; DELETE admin | `use_count` / `last_used_at` are service-role writes |
| `recruit_optins` | — | SELECT own-or-admin | written only by `recruit-optin` |
| `lo_sourcing` | — | SELECT all | the claim check an LO sees before sending |
| `team_directory` | — | SELECT all | |
| `app_admins` | — | SELECT own membership only | the roster changes by migration |
| `metrics_snapshots` | — | SELECT admin | |
| `email_suppressions`, `lo_sourcing_events`, `recap_presentations`, `retr_stats_cache` | — | — | RLS enabled, **zero client policies**: service role only |
| `storage.objects` (bucket `retr-reports`) | — | SELECT all; INSERT / UPDATE admin | the bucket matches the table (see owner step 2 in `owner-steps-2026-10-16.md` until the dashboard change lands) |
| `storage.buckets` (`retr-reports`) | private (`public = false` since `20260713020000`) | — | |

All `auth.uid()` / `auth.jwt()` calls in policy bodies are wrapped as
`(select auth.uid())` so Postgres evaluates them once per statement
(migration `20261016030000`).

## Function grants

Supabase grants `EXECUTE` to `anon` and `authenticated` on every function in
`public` by default, which exposes SECURITY DEFINER functions under
`/rest/v1/rpc/`. Since `20261016030000`:

| Function | anon | authenticated | why |
|---|---|---|---|
| `is_admin()` | revoked | kept | RLS evaluates it as the querying role; `src/lib/auth.tsx` calls it once a session exists |
| `attribute_proforma_owner()`, `sync_team_directory()`, `rls_auto_enable()` | revoked | revoked | trigger / event-trigger functions run as their owner; no client calls them |

## Why anon INSERT on `proformas` is safe

- The policy's `with check (source = 'public')` means an anonymous writer can
  only ever create a row *tagged as a public submission* — it cannot
  impersonate a team save.
- There is **no anon SELECT** anywhere: `submitPublicProforma` deliberately
  inserts without `.select()` (PostgREST would need a select grant to return
  the row, and granting one — even filtered — would let any anon-key holder
  enumerate every public submission via REST).
- The row grants nothing back: no id is returned, no read path exists.

## History (how we got here)

1. `20260713000000` / `20260713010000` — pre-auth era: permissive
   `anon, authenticated` policies on `proformas` and `retr_reports`, public
   storage bucket. **All superseded below.**
2. `20260713020000` — auth arrives: every one of those policies is dropped and
   recreated as `authenticated`-only; the storage bucket flips private;
   `target_los` created authenticated-only.
3. `20260713030000` — `proforma_snapshots` (append-only) and `recap_emails`
   (client-readable, service-role-writable).
4. `20260713040000` — `stage_events` (append-only).
5. `20260714000000` — the single deliberate anon grant: insert-only, tagged,
   on `proformas`.
6. `20260720000000` — `retr_stats_cache`, RLS on, no client policies.
7. `20260727000000` — `email_suppressions`, service-role only.
8. `20260729000000` / `20260729010000` — `lo_sourcing` (team-readable),
   `lo_sourcing_events` (service-role), `referral_links` (own links).
9. `20260804000000` – `20260804050000` — the **role split**: `app_admins` +
   `is_admin()`; `target_los`, `stage_events`, `retr_reports` writes,
   `proformas` update/delete and snapshot reads become admin-only;
   `proformas.created_by` + ownership trigger; LOs read their own rows.
10. `20260818181912` — `recap_emails` SELECT becomes own-or-admin.
11. `20260827050801` — `recruit_optins` (own invites or admin).
12. `20261016030000` — audit hardening: SECURITY DEFINER grants revoked,
    bucket writes admin-only, `proformas` / `proforma_snapshots` INSERT
    ownership checks, initplan rewrites, redundant SELECT policies collapsed,
    FK indexes, `pg_net` out of `public`.
13. `20261016040000` / `20261016050000` — `recruit_optins.current_bps` +
    `referral_token`; the pg_cron jobs declared in a migration, reading their
    secrets from Vault.

## Invariants the test suite enforces

1. Exactly **one** live policy grants `anon` anything, it is `FOR INSERT`, on
   `public.proformas`, and its check contains `source = 'public'`.
2. No live policy grants `public` (the role) anything.
3. The `retr-reports` bucket's final state is `public = false`.
4. Every other live policy targets `authenticated` only.
5. Every write policy on `storage.objects` names `is_admin()`.
6. The admin-only tables (`target_los`, `stage_events`, `proformas`
   update/delete, `recap_emails` delete, `retr_reports` writes, both snapshot
   tables' reads) name `is_admin()` in the policy body; the own-or-admin
   selects (`proformas`, `recap_emails`, `referral_links`, `recruit_optins`)
   name `auth.uid()`.
7. Every `SECURITY DEFINER` function defined in a migration is followed by a
   `revoke execute … from anon`.
8. Migration filenames are `YYYYMMDDHHMMSS_name.sql` and unique by version —
   the shape the live ledger (`supabase_migrations.schema_migrations`) keys on.

Adding any new `to anon` policy (or a `grant ... to anon`) fails
`src/test/security.test.ts` until this audit is updated *and* the invariant
list above is consciously revised — which is exactly the friction we want.
