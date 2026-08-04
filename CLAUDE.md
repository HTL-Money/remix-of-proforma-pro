# ProFarmA — working notes for Claude

Recruiting pro forma tool for Hometown Lending. Vite + React + TypeScript on
Vercel, Supabase (Postgres + RLS + Deno edge functions), M365 Graph for email.

## Verify before you claim

`npx vitest run` · `npx tsc -p tsconfig.app.json --noEmit` · `npx vite build`

`src/pages/Dashboard.tsx` has one pre-existing `ActivityItem` type error. It is
not yours; leave it and say so rather than reporting a clean typecheck.

## This container's two traps

**The Supabase CLI does not work here** (the egress proxy breaks its transport).
Use the Management API with `$SUPABASE_ACCESS_TOKEN`: `POST
/v1/projects/{ref}/database/query` for SQL, `POST
/v1/projects/{ref}/functions/deploy?slug=X` (multipart) to deploy a function.
Project ref: `bmdikaxkzlgqxcibmqon`.

**Chromium cannot reach supabase.co through the proxy** — calls die with
`ERR_CONNECTION_RESET`, and a browser test will look like it "just didn't send".
Run a localhost relay that forwards to Supabase using Node's fetch (which does
honour the proxy), rebuild with `VITE_SUPABASE_URL=http://127.0.0.1:<port>`, and
launch Chromium with `--proxy-server=$HTTPS_PROXY
--proxy-bypass-list=127.0.0.1;localhost`. Playwright lives at
`/opt/node22/lib/node_modules/playwright`, Chromium at
`/opt/pw-browsers/chromium`; never run `playwright install`.

## Multi-agent workflows: compact between stages, always

Fan-out workflows do not overspend on the work — they overspend on carrying it
around. Three rules, and they belong in the script as code, not in a prompt as a
request, because a prompt is a suggestion an agent can ignore:

1. **Every agent returns a schema-bounded digest, never prose.** Put `maxItems`
   on the array and `maxLength` on each string. That is a hard ceiling on cost
   per item, chosen by you. An agent asked for "findings" with no schema returns
   paragraphs, and every later stage pays for them again.
2. **Dedupe in plain JS against everything ever seen** — a `Set` of keys, not the
   confirmed list. Dedupe against the confirmed list and anything a judge
   rejected comes back next round, so the loop never converges.
3. **Guard the budget and reserve headroom for the final stage.** Check
   `budget.remaining()` before spawning a round, and keep enough back to
   synthesize. Discovery that consumes the whole budget produces no answer.

Prefer `pipeline()` to `parallel()` so each item flows through all its stages
without a barrier. Reach for a barrier only when a stage genuinely needs every
prior result at once (deduping across the full set, or an early exit on zero).

`.claude/workflows/compacting-fanout.js` is the working template — copy it
rather than rebuilding the pattern. Run it with
`Workflow({ name: 'compacting-fanout', args: { goal, targets } })`.

Note that `/compact` is the user's to invoke, not yours; what you control is
whether a workflow needed compacting in the first place.

## Outward-facing actions need a person's word

This project emails real loan officers and real recruits. Sending to anyone
other than a fixed admin address, provisioning accounts, and scheduling a send
are the owner's calls — confirm first, every time, even when a previous
approval feels like it should carry over.

Scheduled work lives in **Postgres `pg_cron` + `pg_net`**, not in session-bound
timers: the container is disposable and has already been rolled back
mid-session once. One-shots should unschedule themselves.

## Where the sharp edges are

- **`is_admin()` gates the CRM.** `app_admins` holds the roster; RLS on
  `target_los`, `proformas` (select/update/delete), `recap_emails`,
  `proforma_snapshots`, `stage_events` and `retr_reports` (writes) is
  admin-only. LOs keep the calculator, their own `referral_links`, `retr_reports`
  reads, and the `lo_sourcing` claim-check. `useAuth().isAdmin` is tri-state
  (`null` = still resolving) and is chrome only — never the boundary.
- **`verify_jwt` is not authorization.** It only proves the caller has the anon
  key, which ships in the browser bundle. Anything that sends mail with
  caller-influenced content, or to a non-admin, additionally checks
  `ADMIN_TASK_KEY`.
- **The recap email's ceiling graphic** overlays numbers onto the owner's
  artwork (`public/email/ceiling-template.jpg`). The artwork is never edited at
  runtime; `SLOTS` in `src/lib/ceilingVisual.ts` is the only thing to
  recalibrate when a new template arrives, and
  `tools/build-ceiling-template.py` is how placeholders get erased offline.
- **First sender wins the 90-day HTL5 claim** (`lo_sourcing`), so attribution is
  taken from a verified JWT, never a client-supplied id.
