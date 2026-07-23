# Row-Level Security Audit

Table-by-table statement of who can do what, derived from replaying
`supabase/migrations/*.sql` in order (later migrations drop/supersede earlier
policies — read the *net* state below, which `src/test/security.test.ts`
recomputes on every test run and enforces).

## Net policy state (after all migrations)

| Table | anon | authenticated | service role (Edge Functions) |
|---|---|---|---|
| `proformas` | **INSERT only**, and only with `source = 'public'` (checked in the policy, not trusted from the client) | SELECT / INSERT / UPDATE / DELETE | full (bypasses RLS) |
| `proforma_snapshots` | — | SELECT / INSERT (append-only: no update/delete for anyone) | full |
| `retr_reports` | — | SELECT / INSERT / UPDATE / DELETE | full |
| `target_los` | — | SELECT / INSERT / UPDATE / DELETE | full |
| `stage_events` | — | SELECT / INSERT (append-only) | full |
| `recap_emails` | — | SELECT only (rows are written by `send-recap` with the service role) | full |
| `storage.objects` (bucket `retr-reports`) | — | SELECT / INSERT / UPDATE scoped to the bucket | full |
| `storage.buckets` (`retr-reports`) | private (`public = false` since migration `20260713020000`) | — | — |

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

## Invariants the test suite enforces

1. Exactly **one** live policy grants `anon` anything, it is `FOR INSERT`, on
   `public.proformas`, and its check contains `source = 'public'`.
2. No live policy grants `public` (the role) anything.
3. The `retr-reports` bucket's final state is `public = false`.
4. Every other live policy targets `authenticated` only.

Adding any new `to anon` policy (or a `grant ... to anon`) fails
`src/test/security.test.ts` until this audit is updated *and* the invariant
list above is consciously revised — which is exactly the friction we want.
