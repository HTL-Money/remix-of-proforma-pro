# Owner steps left open by the 2026-10-16 audit

Everything below needs a human in the Supabase dashboard, GitHub or Vercel.
The automated session could not do it: the Supabase MCP holds any statement
containing `drop`/`delete` for an interactive confirmation that never arrives
in an unattended run, and `storage.objects` policies can only be changed by
the storage admin role, which the SQL editor's `postgres` role is not.

Each block is safe to run more than once. Tick them off in the PR.

## 1. SQL editor (Dashboard → SQL) — paste as one script

```sql
-- (a) Two redundant permissive SELECT policies the advisor flags. The
--     combined "own proformas or admin" / "own sends or admin" policies are
--     already live and carry the same access, so nobody loses anything.
drop policy if exists "admins read proformas"    on public.proformas;
drop policy if exists "own proformas"            on public.proformas;
drop policy if exists "admins read recap emails" on public.recap_emails;

-- (b) pg_net out of public (advisor warning). It is not relocatable, so it
--     is dropped and recreated; its functions stay in schema `net`, so the
--     two cron jobs keep working. Run between the 13:00 UTC job firings and
--     only when the queue is empty (the first line must return 0).
select count(*) as must_be_zero from net.http_request_queue;
drop extension if exists pg_net;
create extension if not exists pg_net with schema extensions;

-- (c) 121 historical cron.job_run_details rows still carry the old
--     ADMIN_TASK_KEY literal (pg_cron copies the command into each run row).
--     The live jobs read the key from Vault now; these are just logs.
delete from cron.job_run_details where command like '%"key": "%';
```

## 2. Storage policies (Dashboard → Storage → Policies → retr-reports)

The table side of `retr_reports` has been admin-only on writes since the role
split; the bucket was not, so any signed-in LO could upload or overwrite
`<nmls>.pdf` and the shared store would serve it to the team as verified
production. Change the two write policies so they also require admin:

| Policy | Operation | New definition |
|---|---|---|
| `Authed insert retr-reports` | INSERT · authenticated | `bucket_id = 'retr-reports' and public.is_admin()` |
| `Authed update retr-reports` | UPDATE · authenticated | USING and WITH CHECK: `bucket_id = 'retr-reports' and public.is_admin()` |

Leave `Authed read retr-reports` (SELECT) as it is. If the UI lets you
rename, call them `admins insert retr-reports` / `admins update retr-reports`
to match `supabase/migrations/20261016030000_security_hardening.sql`.

Check: signed in as `lotest@`, an upload to `retr-reports/` must fail with
403; as an admin it must succeed.

## 3. Auth → Password security

Turn on **Leaked password protection** (HaveIBeenPwned check). One switch.

## 4. Rotate `ADMIN_TASK_KEY`

The value moved out of `cron.job` into Vault (`admin_task_key`) unchanged.
Rotating it is a two-place change that must happen together:

1. Edge Functions → Secrets → `ADMIN_TASK_KEY` → new value.
2. SQL editor: `select vault.update_secret((select id from vault.secrets where name = 'admin_task_key'), '<the same new value>');`
3. Prove it: `select net.http_post(...)` with `{"action":"remind","dryRun":true,"key":...}` from Vault returns 200 in `net._http_response`; the old value returns 403.

## 5. Cloud environment: refresh `SUPABASE_ACCESS_TOKEN`

The Management API token in the Claude cloud environment returns 401. The
Monday "ProFarmA Weekly Review" routine uses it for its secrets check and,
from this change on, to read `ADMIN_TASK_KEY` so its `send` call is accepted.
Generate a new token at supabase.com/dashboard/account/tokens and update the
environment variable.

## 6. Routines

* **ProFarmA Daily Check-In** (`trig_01RHELr1QWM4BRFd28VWEjms`) still fires
  every day and exits on its own "after 2026-08-24, do nothing" rule. Disable
  it.
* **ProFarmA Weekly Review** (`trig_01MJfVerj5WaALvQ92vsWvAj`): prompt updated
  in this change to pass the key; needs step 5.

## 7. GitHub

* Enable Dependabot alerts + security updates (Settings → Code security).
* If the plan allows, enable Advanced Security (secret scanning, push
  protection). Until then `src/test/security.test.ts` in CI is the only
  secret-leak guard.
* Make the `ci` workflow a required check on `main`.

## 8. Vercel

Settings → Integrations → the Claude/MCP integration → Project Access → add
`htlproforma`, so runtime errors become visible from a session.

## 9. Un-suppress your own address (your call)

`jamesm@hometownlend.com` was unsubscribed by a link scanner on Sept 21 and
can no longer receive a recap or an invite. To restore it:

```sql
delete from public.email_suppressions where email = 'jamesm@hometownlend.com';
```
